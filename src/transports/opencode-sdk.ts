import type {
  AsyncEventSink,
  ProviderCapabilityReport,
  ProviderEvent,
  ProviderEventBase,
  ProviderTerminalProof,
  ProviderTransport,
  TransportFailureCause,
  TransportOutcome,
  TransportRequest,
} from "../execution/contracts";
import type {
  NormalizedTokens,
  NormalizedUsage,
  UsageModeState,
} from "../execution/usage-normalized";
import {
  applyUsageUpdate,
  normalizeUnavailableUsage,
  UsageModeMismatchError,
} from "../execution/usage-normalized";

// WHY there is no @opencode-ai dependency here: production enablement over the
// real SDK is deliberately deferred to D1-11 (§12 D1-06 vs D1-11). This slice
// ships the full §3.2/§4/§5.2 transport mechanics against a narrow injectable
// client (OpenCodeClientLike) so every deadline, bound, and arbitration rule is
// offline-conformance-testable; the D1-11 adapter wraps the actual SDK in
// exactly this interface.

// §4.2 line 191 hard content bounds: one delta ≤ 64 KiB, aggregate finalText
// ≤ 1 MiB, stderr tail ≤ 64 KiB. Exceeding a bound TERMINATES the attempt —
// content is never silently truncated and parsed.
const MAX_DELTA_BYTES = 64 * 1024;
const MAX_FINAL_TEXT_BYTES = 1024 * 1024;
const MAX_STDERR_TAIL_BYTES = 64 * 1024;

// §4.2 line 189: backpressure beyond "the transport's declared stall deadline"
// aborts the attempt as protocol_overflow. The spec fixes no number; 10 s is
// the declared production default (injectable for offline tests).
const DEFAULT_STALL_DEADLINE_MS = 10_000;

// §5.2 line 272 (SDK row): session.abort() → provider-specific terminal
// confirmation up to 5,000 ms → local cleanup up to 1,000 ms; the harness
// deadline is 6,500 ms including margin and is declared via capabilities().
const SDK_ABORT_CONFIRM_MS = 5000;
const SDK_CLEANUP_MS = 1000;
// The margin the §5.2 row folds in on top of confirm+cleanup. Declared as a
// term rather than a literal total because harness.ts:425 TRUSTS the number
// capabilities() reports as the real bound: a constant would let an instance
// configured with larger budgets promise less time than it needs, and the
// harness would call a still-in-budget cancellation unconfirmed.
const SDK_DEADLINE_MARGIN_MS = 500;

// §197 names stream/poll arbitration without fixing numbers: the poll cadence
// and the per-round timeout are transport-declared defaults. A poll round that
// times out is an observation failure and can never win the terminal slot.
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_POLL_ROUND_MS = 2000;

export interface OpenCodeClientSession {
  readonly id: string;
}

export interface OpenCodeCreateSessionInput {
  readonly cwd: string;
  readonly userPrompt: string;
  readonly systemPromptPath: string;
  readonly tools: readonly string[];
  readonly mcpConfigPath?: string;
}

export type OpenCodeClientEvent =
  | { readonly kind: "delta"; readonly text: string }
  | {
      readonly kind: "usage";
      readonly mode: "snapshot" | "delta";
      readonly final?: boolean;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly costUsd?: number;
    }
  | {
      readonly kind: "diagnostic";
      readonly level: "info" | "warn" | "error";
      readonly message: string;
    }
  | { readonly kind: "heartbeat" }
  | { readonly kind: "terminal"; readonly proof: ProviderTerminalProof };

export type OpenCodePollResult =
  | { readonly kind: "pending" }
  | { readonly kind: "terminal"; readonly proof: ProviderTerminalProof };

// Narrow injectable client shaped ONLY from what §197 (stream + poll
// arbitration) and §290 (abort without provider confirmation) require. No
// assumption about the real SDK's API is encoded here.
export interface OpenCodeClientLike {
  createSession(
    input: OpenCodeCreateSessionInput,
  ): Promise<OpenCodeClientSession>;
  streamEvents(
    session: OpenCodeClientSession,
  ): AsyncIterable<OpenCodeClientEvent>;
  pollStatus(session: OpenCodeClientSession): Promise<OpenCodePollResult>;
  abort(session: OpenCodeClientSession): Promise<void>;
}

// Injectable clock so conformance tests fire every deadline by hand and never
// sleep a real one (§13 line 746).
export interface OpenCodeTransportClock {
  schedule(ms: number, fn: () => void): () => void;
}

const systemClock: OpenCodeTransportClock = {
  schedule(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export interface OpenCodeSdkTransportOptions {
  readonly client: OpenCodeClientLike;
  readonly stallDeadlineMs?: number;
  readonly abortConfirmMs?: number;
  readonly cleanupMs?: number;
  readonly maxDeltaBytes?: number;
  readonly maxFinalTextBytes?: number;
  readonly pollIntervalMs?: number;
  readonly pollRoundMs?: number;
  readonly clock?: OpenCodeTransportClock;
  readonly nowIso?: () => string;
}

const MARKER_ABORT_UNCONFIRMED =
  "[pr-hero] opencode sdk: abort requested but the provider supplied no terminal proof within the confirmation window; remote state unknown_may_continue";
const MARKER_STALL =
  "[pr-hero] opencode sdk: event sink push stalled past the declared stall deadline";
const MARKER_BOUND_DELTA =
  "[pr-hero] opencode sdk: delta exceeded the hard per-delta content bound";
const MARKER_BOUND_AGGREGATE =
  "[pr-hero] opencode sdk: aggregate finalText exceeded the hard aggregate content bound";
const MARKER_USAGE_FLIP =
  "[pr-hero] opencode sdk: usage aggregation mode changed after the first usage event fixed it";
const MARKER_TIMEOUT = "[pr-hero] opencode sdk: attempt watchdog expired";

const MARKER_CONFLICT =
  "[pr-hero] opencode sdk: conflicting provider terminal observed after the compare-and-set slot was won";

type SettleReason =
  | { readonly kind: "provider_terminal" }
  | { readonly kind: "conflict"; readonly detail: string }
  | { readonly kind: "usage_flip"; readonly detail: string }
  | { readonly kind: "bound"; readonly target: "delta" | "aggregate" }
  | { readonly kind: "stall" }
  | { readonly kind: "stream_error"; readonly detail: string }
  | { readonly kind: "timeout"; readonly timeoutMs: number }
  | { readonly kind: "abort_confirmed" }
  | { readonly kind: "abort_unconfirmed" };

type PushResult = "accepted" | "closed" | "stalled";

// Sentinel for the stream watcher's race against settlement.
const STREAM_SETTLED = "stream_settled" as const;

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// The tail bound is declared in BYTES, so it is enforced in bytes. String
// .slice counts UTF-16 code units, which lets multi-byte provider text run
// past the bound the transport claims.
//
// Keeping the last maxBytes bytes can tear a multi-byte sequence at the head,
// and decoding that orphan does not merely lose a character — it GROWS the
// result: every stray continuation byte becomes a U+FFFD, which is three
// bytes in UTF-8, so a byte-exact cut can come back over the bound. The head
// is therefore advanced past any continuation bytes (0b10xxxxxx) to land on a
// real character boundary, which can only shorten the tail.
function boundTailBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return new TextDecoder().decode(bytes.slice(start));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Session creation failing means no attempt ever reached the provider —
// genuine zero cost, not "unavailable" (which would misfile a $0 refusal as
// an unresolved spend once PR5's spend ledger reads completeness).
function noSessionUsage(wallMs: number): NormalizedUsage {
  return {
    wallMs,
    tokens: {},
    completeness: "complete",
    billingMode: "subscription",
    costSource: "provider",
    cashCostUsd: 0,
  };
}

// Matching means the poll observes the SAME terminal identity the slot already
// holds: identical eventId AND providerStatus. Anything else is a conflicting
// terminal, which §197 says makes the outcome malformed rather than being
// selected by arrival order.
function sameTerminal(
  a: ProviderTerminalProof,
  b: ProviderTerminalProof,
): boolean {
  return a.eventId === b.eventId && a.providerStatus === b.providerStatus;
}

// §197: only a VALID provider terminal proof may win the slot.
function isValidProof(proof: ProviderTerminalProof): boolean {
  return (
    proof.eventId.length > 0 &&
    proof.providerStatus.length > 0 &&
    proof.providerObservedAt.length > 0
  );
}

export class OpenCodeSdkTransport implements ProviderTransport {
  readonly backend = "opencode" as const;
  private readonly client: OpenCodeClientLike;
  private readonly stallDeadlineMs: number;
  private readonly abortConfirmMs: number;
  private readonly cleanupMs: number;
  private readonly maxDeltaBytes: number;
  private readonly maxFinalTextBytes: number;
  private readonly pollIntervalMs: number;
  private readonly pollRoundMs: number;
  private readonly clock: OpenCodeTransportClock;
  private readonly nowIso: () => string;

  constructor(options: OpenCodeSdkTransportOptions) {
    this.client = options.client;
    this.stallDeadlineMs = options.stallDeadlineMs ?? DEFAULT_STALL_DEADLINE_MS;
    this.abortConfirmMs = options.abortConfirmMs ?? SDK_ABORT_CONFIRM_MS;
    this.cleanupMs = options.cleanupMs ?? SDK_CLEANUP_MS;
    this.maxDeltaBytes = options.maxDeltaBytes ?? MAX_DELTA_BYTES;
    this.maxFinalTextBytes = options.maxFinalTextBytes ?? MAX_FINAL_TEXT_BYTES;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollRoundMs = options.pollRoundMs ?? DEFAULT_POLL_ROUND_MS;
    this.clock = options.clock ?? systemClock;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  // §11/D1-09 honesty: every unimplemented feature is claimed false with a
  // non-blocking issue, never assumed green — hence status "degraded", not
  // "ready". The real adapter, credential route, and pricing table are D1-11.
  async capabilities(): Promise<ProviderCapabilityReport> {
    return {
      backend: "opencode",
      status: "degraded",
      auth: {
        kind: "opencode_chatgpt_oauth",
        projectionReady: false,
        probe: "not_run",
      },
      isolation: {
        syntheticHome: false,
        workspaceReadBroker: false,
        codegraphPolicy: false,
      },
      protocol: {
        terminalProof: true,
        boundedEvents: true,
        usageMode: "none",
      },
      cancellation: {
        deadlineMs:
          this.abortConfirmMs + this.cleanupMs + SDK_DEADLINE_MARGIN_MS,
        conformance: "passed",
      },
      billing: {
        mode: "subscription",
        pricingReady: false,
      },
      issues: [
        {
          code: "real_sdk_adapter_deferred_to_d1_11",
          message:
            "this transport drives the injectable OpenCodeClientLike contract only; the adapter over the real @opencode-ai SDK lands in D1-11, so no production route may select this backend yet",
          blocking: false,
        },
        {
          code: "credential_projection_route_missing",
          message:
            "the OpenCode/ChatGPT OAuth credential-broker route (§6.1) is not implemented; auth projectionReady is false until it exists",
          blocking: false,
        },
        {
          code: "synthetic_home_isolation_missing",
          message:
            "no synthetic-home isolation is claimed because no credential route exists to project into one",
          blocking: false,
        },
        {
          code: "workspace_read_broker_unwired",
          message:
            "the §6.2 workspace/codegraph read broker is not wired for this backend yet",
          blocking: false,
        },
        {
          code: "codegraph_policy_unenforced",
          message:
            "no dedicated codegraph sensitive-file policy is enforced for this backend yet",
          blocking: false,
        },
        {
          code: "usage_mode_client_reported",
          message:
            "usage aggregation mode (§4.2 line 195) is fixed at runtime by the first client usage event, so no static snapshot/delta claim can be defended; usageMode is 'none'",
          blocking: false,
        },
        {
          code: "pricing_table_missing",
          message:
            "no per-model pricing table is bundled, so notional cost cannot be derived; subscription cash cost stays 0",
          blocking: false,
        },
      ],
    };
  }

  async execute(
    request: TransportRequest,
    context: { readonly signal: AbortSignal; readonly events: AsyncEventSink },
  ): Promise<TransportOutcome> {
    const notes: string[] = [];
    const startedWall = Date.now();
    let seq = 0;
    const nextSeq = () => {
      const value = seq;
      seq += 1;
      return value;
    };
    const base = (): ProviderEventBase => ({
      sessionId: request.sessionId,
      attempt: request.attempt,
      seq: nextSeq(),
      observedAt: this.nowIso(),
    });

    let settled = false;
    let resolveDone!: (reason: SettleReason) => void;
    const done = new Promise<SettleReason>((resolve) => {
      resolveDone = resolve;
    });
    const settle = (reason: SettleReason): void => {
      if (settled) return;
      settled = true;
      resolveDone(reason);
    };

    const cancellers = new Set<() => void>();
    const scheduleTracked = (ms: number, fn: () => void): void => {
      const cancel = this.clock.schedule(ms, () => {
        cancellers.delete(cancel);
        fn();
      });
      cancellers.add(cancel);
    };
    const delay = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        scheduleTracked(ms, resolve);
      });

    // §4.2 line 188: producers await every push — no fire-and-forget. Each
    // push races the declared stall deadline; losing the race is the
    // §4.2 line 189 protocol_overflow abort.
    const pushGuarded = async (event: ProviderEvent): Promise<PushResult> => {
      let cancelStall: (() => void) | undefined;
      try {
        const stalled = new Promise<"stalled">((resolve) => {
          cancelStall = this.clock.schedule(this.stallDeadlineMs, () =>
            resolve("stalled"),
          );
        });
        // A sink that throws (or rejects after the race decided) is treated as
        // closed: stop feeding it rather than crash a paid attempt.
        const pushed = context.events
          .push(event)
          .catch(() => "closed" as const);
        return await Promise.race([pushed, stalled]);
      } finally {
        cancelStall?.();
      }
    };

    // ---- §197 terminal compare-and-set slot -------------------------------
    let slotProof: ProviderTerminalProof | undefined;
    let pollConfirmations = 0;
    let invalidProofs = 0;
    const onProviderTerminalCandidate = (
      proof: ProviderTerminalProof,
      source: "stream" | "poll",
    ): void => {
      if (settled) return;
      if (!isValidProof(proof)) {
        invalidProofs += 1;
        notes.push(
          `[pr-hero] opencode sdk: ignored invalid ${source} terminal proof (missing identity fields); it could not win the slot`,
        );
        return;
      }
      if (slotProof === undefined) {
        slotProof = proof;
        if (abortSequenceStarted) {
          // §5.2 line 272: the provider confirmed the abort inside the
          // confirmation window. Settle at once — adding the normal drain
          // window here would overrun the 6,500 ms harness deadline.
          settle({ kind: "abort_confirmed" });
          return;
        }
        // Post-win observation window: a later conflicting terminal must be
        // able to flip the outcome malformed (§197), so hold settlement open
        // for one cleanup-budget window before recording the win.
        scheduleTracked(this.cleanupMs, () =>
          settle({ kind: "provider_terminal" }),
        );
        return;
      }
      if (sameTerminal(slotProof, proof)) {
        // §197: polling may confirm a matching terminal but never creates a
        // second one.
        pollConfirmations += 1;
        return;
      }
      settle({
        kind: "conflict",
        detail: `${source} terminal ${proof.eventId}/${proof.providerStatus} conflicts with ${slotProof.eventId}/${slotProof.providerStatus}`,
      });
    };

    // ---- session -----------------------------------------------------------
    let session: OpenCodeClientSession;
    try {
      session = await this.client.createSession({
        cwd: request.cwd,
        userPrompt: request.userPrompt,
        systemPromptPath: request.systemPromptPath,
        tools: request.tools,
        ...(request.mcpConfigPath !== undefined
          ? { mcpConfigPath: request.mcpConfigPath }
          : {}),
      });
    } catch (error) {
      // Redaction of any provider text happens harness-side before persistence;
      // here the message is only classification witness (§6.3).
      return {
        completion: "failed",
        protocolIntegrity: "unverified",
        finalText: "",
        usage: noSessionUsage(Date.now() - startedWall),
        stderrTail: `[pr-hero] opencode sdk: session creation failed: ${errorMessage(error)}`,
      };
    }

    // ---- mutable attempt state --------------------------------------------
    const finalParts: string[] = [];
    let aggregateBytes = 0;
    // §4.1/§8: the first usage event fixes the attempt's aggregation mode;
    // `applyUsageUpdate` is the pure snapshot-replaces/delta-accumulates state
    // machine, shared with every other transport that folds a usage stream.
    let usageState: UsageModeState | undefined;
    let cashCostUsd: number | undefined;
    let sinkClosed = false;
    let closedDataPlaneEvents = 0;
    let pollTimeouts = 0;
    let abortSequenceStarted = false;

    // Single-delivery guarantee for abort(): gated by abortSequenceStarted,
    // which both the signal path and the local-termination path consult.
    const callAbortOnce = async (): Promise<void> => {
      try {
        await this.client.abort(session);
      } catch (error) {
        notes.push(
          `[pr-hero] opencode sdk: abort call failed: ${errorMessage(error)}`,
        );
      }
    };

    // §5.2 line 272 abort sequence: abort() once, then wait up to
    // abortConfirmMs for a PROVIDER terminal proof. The abort request itself
    // can never win the §197 slot; only the provider's own proof can.
    const runAbortSequence = (): void => {
      if (abortSequenceStarted || settled) return;
      abortSequenceStarted = true;
      notes.push("[pr-hero] opencode sdk: abort requested");
      void callAbortOnce();
      scheduleTracked(this.abortConfirmMs, () =>
        settle({ kind: "abort_unconfirmed" }),
      );
    };
    const onAbortSignal = (): void => {
      runAbortSequence();
    };
    if (context.signal.aborted) {
      runAbortSequence();
    } else {
      context.signal.addEventListener("abort", onAbortSignal, { once: true });
    }

    // §7 / the sibling CLI transport (claude-code-cli.ts:392): the request's
    // own per-attempt deadline is the transport's to enforce. The harness has
    // no equivalent — its deadlineMs is the CANCELLATION budget, which only
    // starts once a cancel is requested — so without this a provider that
    // streams heartbeats forever while every poll stays pending hangs the
    // attempt and the pipeline step awaiting it, with no backstop at all.
    //
    // It settles on its OWN reason and never through runAbortSequence(). That
    // path stamps MARKER_ABORT_UNCONFIRMED, which classifyFailure maps to
    // remote_abort_unconfirmed — a TERMINAL cause. A watchdog timeout is
    // transient and must stay retryable; laundering it through abort would
    // make every hung attempt un-retryable, the opposite of what it means.
    if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
      const timeoutMs = request.timeoutMs;
      scheduleTracked(timeoutMs, () => settle({ kind: "timeout", timeoutMs }));
    }

    // ---- stream watcher ----------------------------------------------------
    const runStream = async (): Promise<void> => {
      // NOT `for await`. execute() awaits `done`, never the watchers, so when
      // settlement is decided by the poll watcher or the attempt watchdog this
      // loop is parked inside next() — and its `if (settled)` guard only runs
      // once an event arrives. A provider that then goes quiet leaves the
      // subscription open forever. The poll watcher escapes because it wakes
      // on its own delay(); the stream watcher has no timer of its own, so it
      // is given one thing to race: settlement itself.
      //
      // Calling .return() from the outside would not have fixed it either —
      // on an async generator it queues BEHIND the pending next(), so a parked
      // watcher stays parked. Racing next() is what actually releases it.
      const iterator = this.client
        .streamEvents(session)
        [Symbol.asyncIterator]();
      // Attached ONCE: a per-iteration `done.then(...)` would pile a handler
      // onto `done` for every event a long stream delivers.
      const settledSignal = done.then(() => STREAM_SETTLED);
      try {
        for (;;) {
          const step = await Promise.race([iterator.next(), settledSignal]);
          if (step === STREAM_SETTLED) return;
          if (step.done === true) break;
          const event = step.value;
          if (settled) return;
          switch (event.kind) {
            case "delta": {
              const bytes = utf8Bytes(event.text);
              if (bytes > this.maxDeltaBytes) {
                // §4.2 line 191: the offending delta is dropped WHOLE — it is
                // never truncated into something parseable.
                settle({ kind: "bound", target: "delta" });
                return;
              }
              if (aggregateBytes + bytes > this.maxFinalTextBytes) {
                settle({ kind: "bound", target: "aggregate" });
                return;
              }
              const pushed = await pushGuarded({
                ...base(),
                type: "delta",
                text: event.text,
              });
              if (pushed === "stalled") {
                settle({ kind: "stall" });
                return;
              }
              if (pushed === "closed") {
                sinkClosed = true;
                closedDataPlaneEvents += 1;
              }
              finalParts.push(event.text);
              aggregateBytes += bytes;
              break;
            }
            case "usage": {
              // §4.2 line 195: the first usage event fixes the attempt's
              // aggregation mode; a later flip throws rather than silently
              // mixing snapshot and delta semantics.
              try {
                usageState = applyUsageUpdate(usageState, event.mode, {
                  ...(event.inputTokens !== undefined
                    ? { inputUncached: event.inputTokens }
                    : {}),
                  ...(event.outputTokens !== undefined
                    ? { outputVisible: event.outputTokens }
                    : {}),
                });
              } catch (error) {
                if (error instanceof UsageModeMismatchError) {
                  settle({ kind: "usage_flip", detail: error.message });
                  return;
                }
                throw error;
              }
              if (event.costUsd !== undefined) {
                cashCostUsd =
                  event.mode === "snapshot"
                    ? event.costUsd
                    : (cashCostUsd ?? 0) + event.costUsd;
              }
              const usage: Partial<NormalizedTokens> & {
                cashCostUsd?: number;
              } = {
                ...(event.inputTokens !== undefined
                  ? { inputUncached: event.inputTokens }
                  : {}),
                ...(event.outputTokens !== undefined
                  ? { outputVisible: event.outputTokens }
                  : {}),
                ...(event.costUsd !== undefined
                  ? { cashCostUsd: event.costUsd }
                  : {}),
              };
              const pushed = await pushGuarded({
                ...base(),
                type: "usage",
                mode: event.mode,
                final: event.final ?? false,
                usage,
              });
              if (pushed === "stalled") {
                settle({ kind: "stall" });
                return;
              }
              if (pushed === "closed") {
                sinkClosed = true;
                closedDataPlaneEvents += 1;
              }
              break;
            }
            case "diagnostic": {
              const pushed = await pushGuarded({
                ...base(),
                type: "diagnostic",
                level: event.level,
                message: event.message,
              });
              if (pushed === "stalled") {
                settle({ kind: "stall" });
                return;
              }
              if (pushed === "closed") {
                sinkClosed = true;
                closedDataPlaneEvents += 1;
              }
              break;
            }
            case "heartbeat": {
              const pushed = await pushGuarded({
                ...base(),
                type: "heartbeat",
              });
              if (pushed === "stalled") {
                settle({ kind: "stall" });
                return;
              }
              if (pushed === "closed") {
                sinkClosed = true;
                closedDataPlaneEvents += 1;
              }
              break;
            }
            case "terminal": {
              onProviderTerminalCandidate(event.proof, "stream");
              if (settled) return;
              break;
            }
          }
          if (settled) return;
        }
        // §197: a stream EOF is not a terminal proof and cannot win the slot.
        // Polling keeps running so the provider can still terminate the
        // attempt through the slot.
        notes.push(
          "[pr-hero] opencode sdk: stream EOF observed; EOF is not a terminal proof and cannot win the slot",
        );
      } catch (error) {
        settle({ kind: "stream_error", detail: errorMessage(error) });
      } finally {
        // Best-effort teardown on EVERY exit — settled, EOF, bound, or error.
        // A provider that never implements return() simply has nothing to
        // close, and a rejecting one must not take the attempt down with it.
        void iterator.return?.().catch(() => {});
      }
    };

    // ---- poll watcher ------------------------------------------------------
    const pollScriptRound = async (): Promise<
      OpenCodePollResult | "round_timeout"
    > => {
      let cancelRound: (() => void) | undefined;
      try {
        const timedOut = new Promise<"round_timeout">((resolve) => {
          cancelRound = this.clock.schedule(this.pollRoundMs, () =>
            resolve("round_timeout"),
          );
        });
        // A poll that throws is a failed observation, not a terminal.
        const round = this.client
          .pollStatus(session)
          .catch(() => "round_timeout" as const);
        return await Promise.race([round, timedOut]);
      } finally {
        cancelRound?.();
      }
    };
    const runPoll = async (): Promise<void> => {
      for (;;) {
        if (settled) return;
        await delay(this.pollIntervalMs);
        if (settled) return;
        const result = await pollScriptRound();
        if (settled) return;
        if (result === "round_timeout") {
          // §197: a poll timeout cannot win the slot; it is only counted.
          pollTimeouts += 1;
          continue;
        }
        if (result.kind === "pending") continue;
        onProviderTerminalCandidate(result.proof, "poll");
        if (settled) return;
      }
    };

    const streamWatcher = runStream();
    const pollWatcher = runPoll();

    const reason = await done;
    for (const cancel of [...cancellers]) cancel();
    cancellers.clear();
    context.signal.removeEventListener("abort", onAbortSignal);

    // Local terminations where the remote may still be producing: best-effort
    // abort so paid remote work is not abandoned silently. Confirmation is NOT
    // claimed unless a provider proof actually arrived.
    if (
      (reason.kind === "bound" ||
        reason.kind === "stall" ||
        reason.kind === "stream_error" ||
        reason.kind === "timeout" ||
        reason.kind === "usage_flip") &&
      !abortSequenceStarted
    ) {
      abortSequenceStarted = true;
      await callAbortOnce();
    }

    if (reason.kind === "conflict")
      notes.push(`${MARKER_CONFLICT}: ${reason.detail}`);
    if (reason.kind === "usage_flip")
      notes.push(`${MARKER_USAGE_FLIP}: ${reason.detail}`);
    if (reason.kind === "bound") {
      notes.push(
        reason.target === "delta"
          ? `${MARKER_BOUND_DELTA}; attempt terminated, offending delta dropped whole`
          : `${MARKER_BOUND_AGGREGATE}; attempt terminated, offending delta dropped whole`,
      );
    }
    if (reason.kind === "stall") notes.push(MARKER_STALL);
    if (reason.kind === "timeout") {
      notes.push(`${MARKER_TIMEOUT} after ${reason.timeoutMs}ms`);
    }
    if (reason.kind === "stream_error") {
      notes.push(`[pr-hero] opencode sdk: stream errored: ${reason.detail}`);
    }
    if (reason.kind === "abort_unconfirmed")
      notes.push(MARKER_ABORT_UNCONFIRMED);
    if (reason.kind === "abort_confirmed") {
      notes.push(
        "[pr-hero] opencode sdk: provider terminal proof confirmed the abort inside the confirmation window",
      );
    }
    if (sinkClosed) {
      notes.push(
        `[pr-hero] opencode sdk: sink closed early; ${closedDataPlaneEvents} data-plane event(s) not delivered`,
      );
    }
    if (pollTimeouts > 0) {
      notes.push(
        `[pr-hero] opencode sdk: ${pollTimeouts} poll round(s) timed out; timeouts cannot win the terminal slot`,
      );
    }
    if (pollConfirmations > 0) {
      notes.push(
        `[pr-hero] opencode sdk: poll confirmed the winning terminal ${pollConfirmations} time(s) without creating a second terminal`,
      );
    }
    if (invalidProofs > 0) {
      notes.push(
        `[pr-hero] opencode sdk: ${invalidProofs} invalid terminal proof(s) ignored`,
      );
    }

    let completion: TransportOutcome["completion"];
    let protocolIntegrity: TransportOutcome["protocolIntegrity"];
    switch (reason.kind) {
      case "provider_terminal":
      case "abort_confirmed": {
        protocolIntegrity = "verified";
        const status = (slotProof?.providerStatus ?? "").toLowerCase();
        if (status === "completed") {
          // §3.2 requires a VERIFIED proof and a BOUNDED finalText for
          // success — bounded, not non-empty: whether empty text is usable
          // output is the harness's format decision (§7), never ours.
          completion = "success";
        } else if (status === "cancelled") {
          completion = "cancelled";
        } else {
          completion = "failed";
        }
        break;
      }
      case "conflict":
      case "usage_flip":
        // §197 / §4.2 line 195: a contradiction makes the outcome malformed;
        // the first valid proof stays attached as evidence, never as success.
        completion = "failed";
        protocolIntegrity = "malformed";
        break;
      case "bound":
      case "stall":
        completion = "failed";
        protocolIntegrity = "overflow";
        break;
      case "stream_error":
      case "timeout":
        completion = "failed";
        protocolIntegrity = "unverified";
        break;
      case "abort_unconfirmed":
        // §5.3 line 290: the transport surfaces an unconfirmed abort honestly
        // — cancelled locally, integrity unverified, NO terminalProof, and
        // never a claim that remote execution or cost ended.
        completion = "cancelled";
        protocolIntegrity = "unverified";
        break;
    }

    const outcome: TransportOutcome = {
      completion,
      protocolIntegrity,
      ...(slotProof !== undefined &&
      reason.kind !== "abort_unconfirmed" &&
      (reason.kind === "provider_terminal" ||
        reason.kind === "abort_confirmed" ||
        reason.kind === "conflict" ||
        reason.kind === "usage_flip")
        ? { terminalProof: slotProof }
        : {}),
      finalText: finalParts.join(""),
      // §8: no usage event ever arriving is a declared capability gap here
      // (capabilities().protocol.usageMode is "none" until D1-11's real SDK
      // adapter), not a proven zero — "unavailable" says honestly that the
      // cost is unknown rather than fabricating a $0 for a session that DID
      // run. `usageState` defined means at least one usage event landed and
      // fixed a mode, so the leaves it accumulated are trustworthy.
      usage:
        usageState === undefined
          ? normalizeUnavailableUsage({ wallMs: Date.now() - startedWall })
          : {
              wallMs: Date.now() - startedWall,
              tokens: {
                ...usageState.tokens,
                inputKnown: usageState.tokens.inputUncached,
                outputKnown: usageState.tokens.outputVisible,
                totalKnown:
                  usageState.tokens.inputUncached !== undefined ||
                  usageState.tokens.outputVisible !== undefined
                    ? (usageState.tokens.inputUncached ?? 0) +
                      (usageState.tokens.outputVisible ?? 0)
                    : undefined,
              },
              completeness: "complete",
              billingMode: "subscription",
              costSource: cashCostUsd !== undefined ? "provider" : "unknown",
              ...(cashCostUsd !== undefined ? { cashCostUsd } : {}),
            },
      // The raw fact §7 needs to reach watchdog_timeout: the legacy classifier
      // collapses it into "transient", and the D1-07 bridge recovers the
      // distinction from THIS flag, not from the class.
      ...(reason.kind === "timeout" ? { timedOut: true } : {}),
      stderrTail: boundTailBytes(notes.join("\n"), MAX_STDERR_TAIL_BYTES),
    };

    // §4.1: the transport normally supplies the attempt's ONE terminal event.
    // The push is awaited but raced against the cleanup budget so a wedged
    // sink cannot hang the return; the harness owns the slot and the sink.
    let cancelTerminalPush: (() => void) | undefined;
    try {
      const status =
        completion === "success"
          ? "completed"
          : completion === "failed"
            ? "failed"
            : "cancelled";
      const origin =
        outcome.terminalProof !== undefined ? "provider" : "transport";
      const terminalEvent: ProviderEvent = {
        ...base(),
        type: "terminal",
        origin,
        status,
        ...(outcome.terminalProof !== undefined
          ? { proof: outcome.terminalProof }
          : {}),
        integrity: protocolIntegrity,
      };
      const pushPromise = context.events
        .push(terminalEvent)
        .catch(() => "closed" as const);
      const pushWindow = new Promise<"window_expired">((resolve) => {
        cancelTerminalPush = this.clock.schedule(this.cleanupMs, () =>
          resolve("window_expired"),
        );
      });
      await Promise.race([pushPromise, pushWindow]);
    } finally {
      cancelTerminalPush?.();
    }

    // Watchers observe `settled` and stop on their own; keep references so a
    // rejection inside a watcher after settlement is never unhandled.
    void streamWatcher.catch(() => {});
    void pollWatcher.catch(() => {});

    return outcome;
  }

  // Marker-based mapping: the transport stamps the §4.2/§197/§290 violations
  // into its own stderr notes, and this function turns exactly those stamped
  // facts into TransportFailureCause values — plus provider auth/network text.
  // It can never return a harness cause (format_violation is harness-only, §7).
  classifyFailure(
    outcome: TransportOutcome,
  ): TransportFailureCause | undefined {
    // finalText is deliberately NOT part of the witness. It is model-generated
    // review prose, and pr-hero reviews code for exactly the failure modes
    // these patterns name — "no rate limit on this endpoint", "unauthorized
    // access is possible" — so including it makes the tool's own subject
    // matter look like provider diagnostics. Every violation this transport
    // detects is stamped into `notes`, and the provider's own stream error is
    // recorded there too, so stderrTail is the complete diagnostics channel.
    const witness = outcome.stderrTail;
    if (witness.includes(MARKER_ABORT_UNCONFIRMED)) {
      return "remote_abort_unconfirmed";
    }
    if (
      witness.includes(MARKER_CONFLICT) ||
      witness.includes(MARKER_USAGE_FLIP)
    ) {
      return "protocol_mismatch";
    }
    if (witness.includes(MARKER_STALL)) {
      return "protocol_overflow";
    }
    if (
      witness.includes(MARKER_BOUND_DELTA) ||
      witness.includes(MARKER_BOUND_AGGREGATE)
    ) {
      return "output_limit_exceeded";
    }
    if (
      /unauthorized|invalid[ _-]?api[ _-]?key|not authenticated|authentication (required|failed)|please (log ?in|sign ?in|authenticate)|chatgpt (login|auth)|opencode.*(log ?in|auth)/i.test(
        witness,
      )
    ) {
      return "auth_invalid";
    }
    if (/\b429\b|rate limit|quota exceeded/i.test(witness)) {
      return "rate_limit";
    }
    if (
      /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|network (error|failure)|\b(?:502|503|504)\b|overloaded/i.test(
        witness,
      )
    ) {
      return "network_transient";
    }
    return undefined;
  }
}
