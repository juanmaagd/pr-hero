import type { BucketScope } from "../execution/bucket-id";
import { deriveBucketId } from "../execution/bucket-id";
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

// §9.2 non-secret provider label: this credential kind is opencode_chatgpt_
// oauth (ChatGPT), so "openai" is the correct HMAC input regardless of
// which model family a given step later routes to over the SDK — bucket
// identity is about the CREDENTIAL's rate-limit pool, not the model.
const BUCKET_IDENTITY_PROVIDER = "openai";

// D1-08 PR3 (§9.2): same optional-input shape as ClaudeCliCapabilitiesInput
// — omitted by every existing call site, so capabilities() stays
// byte-identical to pre-PR3 behavior until PR5a's harness wiring supplies a
// real credential's resolved scope.
export interface OpenCodeCapabilitiesInput {
  readonly credentialFingerprint: string;
  readonly bucketScope?: BucketScope;
  readonly localKey: Uint8Array;
}
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

// #132: how many consecutive post-win windows may be extended by a stream that
// keeps delivering. Each cycle is one `cleanupMs`, so this bounds the hold at
// maxDrainCycles x cleanupMs of SUSTAINED delivery — a whole answer draining in
// microseconds costs one cycle and never approaches the budget. It exists so a
// provider that will not stop cannot hold the attempt open until the step
// watchdog fires: exhausting it is an explicit `truncated` outcome, which is a
// louder and more actionable end than a watchdog timeout over a won terminal.
const DEFAULT_MAX_DRAIN_CYCLES = 4;

export interface OpenCodeClientSession {
  readonly id: string;
  // The tool allow map the client actually sent, resolved against the
  // provider's enumerated surface. Optional because `OpenCodeClientLike` is an
  // injectable contract and a client that cannot express a tool gate has
  // nothing to report — a client that CAN must report it, so the enforcement
  // is provable from the attempt's artifacts instead of assumed from source.
  readonly toolMap?: Readonly<Record<string, boolean>>;
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
  // #124: a reasoning delta the mapper DISCARDED. Deliberately carries no
  // payload — not the text, not even its length. The text is not the answer
  // and must not spend the answer's content budget; and nothing derived from
  // it may reach `notes`, which is classifyFailure's witness (see the note
  // this event ends up producing for what a bare number does there). What
  // survives the boundary is the bare fact that the model thought, which is
  // all the transport needs to tell a turn that reasoned and never answered
  // apart from one that produced nothing at all.
  | { readonly kind: "reasoning" }
  | { readonly kind: "terminal"; readonly proof: ProviderTerminalProof };

export type OpenCodePollResult =
  | { readonly kind: "pending" }
  | { readonly kind: "terminal"; readonly proof: ProviderTerminalProof }
  // The session itself failed, so no turn will ever produce a terminal. It is
  // NOT a terminal — the transport issues no proof of its own — and it is not
  // a failed observation either: it is a successful observation of a fact that
  // ends the attempt. The distinction is load-bearing. A poll that THROWS is
  // counted (`pollTimeouts += 1; continue`) and the loop runs on forever, so
  // reporting this by throwing would have swapped one silent hang for another.
  | { readonly kind: "failed"; readonly detail: string };

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
  close?(): Promise<void>;
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
  readonly maxDrainCycles?: number;
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

const MARKER_CONFLICT =
  "[pr-hero] opencode sdk: conflicting provider terminal observed after the compare-and-set slot was won";
// Already the literal prefix of the stderrTail this transport writes when
// createSession throws; naming it here makes it a classification witness too.
const MARKER_SESSION_CREATE = "[pr-hero] opencode sdk: session creation failed";
// Already the literal text the client puts on the error it hands the stream
// when session.prompt is refused (opencode-client.ts, via unwrap); naming it
// here makes it a classification witness too. The coupling is pinned by an
// end-to-end test rather than by this constant —
// test/conformance/opencode-resolved-error-arm.test.ts drives a refusal
// through the real client and asserts what comes out here.
const MARKER_PROMPT_REFUSED = "opencode session.prompt failed";
// #132, and #124's sibling in CAUSE rather than in fact: that one says the
// turn reasoned and never opened a text part, this one says it opened one and
// was cut off mid-delivery. Both map to `protocol_truncation` because a FRESH
// attempt is the only remedy that can work on either.
//
// Deliberately digit-free and worded clear of every classifier pattern: it
// shares the witness with the provider's own text, so a marker that reads like
// a rate limit or a socket error would decide the cause instead of reporting
// the fact (#126).
const MARKER_UNDELIVERED_CONTENT =
  "[pr-hero] opencode sdk: the drain budget expired while the stream was still delivering; the answer is incomplete";
// #124. Distinct from an empty answer in general: this says the turn REASONED
// and never opened a text part, so there is no malformed output to reformat
// and the format-reminder budget would be spent on nothing — the same argument
// that made a turn which never started `runtime_unavailable` (#121, #123).
// The cause it maps to differs, though, and deliberately: the runtime WAS
// available and the model DID run, so the honest fact is that the answer
// channel delivered no content. See classifyFailure.
const MARKER_REASONING_ONLY =
  "[pr-hero] opencode sdk: the turn completed with reasoning parts only and no answer text part";

type SettleReason =
  // #132: `drained` records whether the stream had gone QUIET when the
  // post-win window closed. False means the drain budget ran out with content
  // still arriving — a provider terminal over an unfinished delivery, which is
  // the one shape of this reason that must never report success.
  | { readonly kind: "provider_terminal"; readonly drained: boolean }
  | { readonly kind: "conflict"; readonly detail: string }
  | { readonly kind: "usage_flip"; readonly detail: string }
  | { readonly kind: "bound"; readonly target: "delta" | "aggregate" }
  | { readonly kind: "stall" }
  | { readonly kind: "stream_error"; readonly detail: string }
  | { readonly kind: "session_failed"; readonly detail: string }
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
  private readonly maxDrainCycles: number;
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
    this.maxDrainCycles = options.maxDrainCycles ?? DEFAULT_MAX_DRAIN_CYCLES;
    this.clock = options.clock ?? systemClock;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  // §11/D1-09 honesty: every unimplemented feature is claimed false with a
  // non-blocking issue, never assumed green — hence status "degraded", not
  // "ready". The real adapter, credential route, and pricing table are D1-11.
  async capabilities(
    input?: OpenCodeCapabilitiesInput,
  ): Promise<ProviderCapabilityReport> {
    return {
      backend: "opencode",
      status: "degraded",
      auth: {
        kind: "opencode_chatgpt_oauth",
        projectionReady: true,
        probe: "passed",
      },
      isolation: {
        syntheticHome: true,
        workspaceReadBroker: true,
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
        // D1-08 PR3 does not touch pricing readiness (see the identical note
        // on ClaudeCodeCliTransport.capabilities) — the real pricing table
        // is D1-11's job, unrelated to bucketScope.
        pricingReady: false,
      },
      ...(input !== undefined
        ? {
            rateLimitBucketId: deriveBucketId(
              {
                provider: BUCKET_IDENTITY_PROVIDER,
                credentialFingerprint: input.credentialFingerprint,
                scope: input.bucketScope,
              },
              input.localKey,
            ),
          }
        : {}),
      issues: [
        {
          code: "codegraph_policy_unenforced",
          message:
            "no dedicated codegraph sensitive-file policy is enforced for this backend yet",
          blocking: false,
        },
        {
          code: "pricing_table_missing",
          message:
            "token pricing metadata is not available for this backend yet",
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
    // `notes` becomes stderrTail, which is the classification WITNESS: the
    // markers this transport stamps, plus the provider's own words verbatim.
    // Nothing else belongs in it.
    const notes: string[] = [];
    // #126: our own observation tallies. Same attempt log, different channel,
    // and NO classifier reads this one — see TransportOutcome.diagnosticsTail
    // for the measured collisions that made the separation necessary.
    const diagnostics: string[] = [];
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

    // ---- #132 post-win drain window ---------------------------------------
    // `deltaSinceArm` is the whole delivery signal: set when a delta is picked
    // up by the stream watcher and cleared every time the window re-arms, so a
    // window that closes with it false saw a stream that said nothing for a
    // full cleanup budget. In real time that is decisive — the client hands
    // events over through an in-process queue, so a buffered delta reaches the
    // watcher within a microtask, never a timer.
    let deltaSinceArm = false;
    let drainCyclesLeft = 0;
    const armDrainWindow = (): void => {
      deltaSinceArm = false;
      scheduleTracked(this.cleanupMs, () => {
        if (settled) return;
        if (!deltaSinceArm) {
          settle({ kind: "provider_terminal", drained: true });
          return;
        }
        if (drainCyclesLeft <= 0) {
          settle({ kind: "provider_terminal", drained: false });
          return;
        }
        drainCyclesLeft -= 1;
        armDrainWindow();
      });
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
        diagnostics.push(
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
        // Post-win window, with TWO purposes now.
        //
        // §197's, which came first: a later conflicting terminal must be able
        // to flip the outcome malformed, so settlement is held open for one
        // cleanup budget before the win is recorded.
        //
        // #132's: the other observer may still be delivering this turn's
        // answer. The poll reaches the boundary from `/session/status` while
        // the stream is mid-delivery, and a window that simply expired
        // reported success over a truncated finalText — silently, since the
        // proof is valid and the completion is real. So the window now asks
        // whether the stream went quiet, and re-arms while it has not.
        //
        // This does NOT couple the observers. What §197 keeps independent is
        // the EVIDENCE — `observedActive` is owned by the poll and is never
        // armed from the stream (opencode-client.ts), because two observers of
        // one derived fact are not two observers. "Have you finished
        // delivering?" is a question about DELIVERY, and the answer changes no
        // observer's verdict about when the turn ended.
        drainCyclesLeft = this.maxDrainCycles;
        armDrainWindow();
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

    // ONE line per attempt (#122), so the tools/MCP axis is provable by
    // reading the artifact rather than trusting `allowMapEnforced: true`.
    // Keys are sorted so the line is byte-stable across runs.
    //
    // On the diagnostics channel, not the witness (#126). This line records
    // what WE resolved, and it interpolates a provider-supplied id vocabulary
    // we do not control — the two properties that make a witness lie. It used
    // to sit in `notes` under a caveat asking every future author to check
    // that no new id trips a classifyFailure pattern ("invalid" alone does not
    // match `invalid api key`, nothing here looks like a rate limit or a
    // socket error). That caveat is now unnecessary rather than merely
    // satisfied: no classifier reads this channel, so no id CAN misclassify an
    // attempt, and the line is free to widen.
    if (session.toolMap !== undefined) {
      const rendered = Object.keys(session.toolMap)
        .sort()
        .map((id) => `${id}=${session.toolMap?.[id] === true}`)
        .join(",");
      diagnostics.push(
        `[pr-hero] opencode sdk: resolved tool map: ${rendered}`,
      );
    }

    // ---- mutable attempt state --------------------------------------------
    const finalParts: string[] = [];
    let aggregateBytes = 0;
    // #124: the bare fact, not a volume. Nothing about reasoning is added to
    // `aggregateBytes` either — reasoning is not the answer, so it must not
    // consume the answer's §4.2 content budget.
    let sawReasoning = false;
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

    // Per-attempt step timeout is harness-owned (StepSpec.timeoutMs → watchdog
    // → AbortSignal). This transport reacts to the supplied signal only; it
    // does not arm its own attempt deadline from the request.

    // ---- stream watcher ----------------------------------------------------
    let streamIterator: AsyncIterator<OpenCodeClientEvent> | undefined;
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
      streamIterator = iterator;
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
              // #132: set BEFORE the push, not after it. The window must count
              // a delta the watcher is still handing to the sink, or a slow
              // consumer turns the one delta in flight into the one delta
              // lost — the same gap that let `finalParts.push` below run after
              // settlement had already frozen the answer.
              deltaSinceArm = true;
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
            case "reasoning": {
              // Recorded, never forwarded. There is no sink push and no bound
              // check: nothing is being delivered and nothing is being spent —
              // the content was dropped at the client boundary and only this
              // one bit survives it.
              sawReasoning = true;
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
    // Observe FIRST, delay BETWEEN rounds — never before the first one. The
    // poll observer can only read absence as a boundary once it has seen the
    // provider name this session through its own endpoint, and a full
    // pollIntervalMs of blindness at the start meant a turn finishing inside
    // that first interval was never observed working at all. Absence was then
    // all it ever saw, absence alone proves nothing (it is also what a wrong
    // status scope looks like), and the fallback that exists precisely for a
    // stream EOF without `session.idle` had no path to a terminal — the
    // attempt ran to the harness watchdog over a turn already sitting
    // completed in session.messages().
    //
    // This NARROWS that window to the provider's own busy-registration
    // latency, it does not close it: the prompt is fired-not-awaited, so a
    // first poll can still land before the server marks the session busy. No
    // sampling observer can do better without arming from the STREAM, and
    // that is forbidden by design (see SessionState.observedActive) — a status
    // scope that cannot see the session would then read step 1's completion as
    // the turn's terminal and reopen #127, trading a loud hang for a silent
    // truncation.
    //
    // The delay MOVED rather than being dropped, so every `continue` above it
    // had to go: a `continue` that now skips the delay is a busy loop.
    const runPoll = async (): Promise<void> => {
      for (;;) {
        if (settled) return;
        const result = await pollScriptRound();
        if (settled) return;
        if (result === "round_timeout") {
          // §197: a poll timeout cannot win the slot; it is only counted.
          pollTimeouts += 1;
        } else if (result.kind === "failed") {
          // §197's second observer, seeing the SAME fact the stream carries
          // when it is still alive to carry it. Settled, not counted: the
          // session cannot produce a terminal any more, so continuing to poll
          // for one would only wait out the harness watchdog.
          settle({ kind: "session_failed", detail: result.detail });
          return;
        } else if (result.kind === "terminal") {
          onProviderTerminalCandidate(result.proof, "poll");
          if (settled) return;
        }
        if (settled) return;
        await delay(this.pollIntervalMs);
      }
    };

    const streamWatcher = runStream();
    const pollWatcher = runPoll();

    let outcome: TransportOutcome;
    try {
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
          reason.kind === "session_failed" ||
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
      if (reason.kind === "stream_error") {
        notes.push(`[pr-hero] opencode sdk: stream errored: ${reason.detail}`);
      }
      if (reason.kind === "session_failed") {
        // Carries the provider's own words verbatim, which is what makes the
        // poll path classify exactly like the stream path — classifyFailure
        // substring-matches MARKER_PROMPT_REFUSED inside this detail rather
        // than pattern-matching this note's own wording.
        notes.push(
          `[pr-hero] opencode sdk: poll observed a session failure: ${reason.detail}`,
        );
      }
      if (reason.kind === "abort_unconfirmed")
        notes.push(MARKER_ABORT_UNCONFIRMED);
      if (reason.kind === "abort_confirmed") {
        notes.push(
          "[pr-hero] opencode sdk: provider terminal proof confirmed the abort inside the confirmation window",
        );
      }
      // #132: gated on `completed`, and the gate is the whole rationale.
      // Truncation-as-failure exists because SUCCESS is the one verdict that
      // hides a short answer. A terminal whose status is `cancelled` or
      // `failed` was never going to report success, and its answer is
      // incomplete by definition — so the drain budget has nothing to add
      // there, while stamping the marker would hand `protocol_truncation` a
      // fresh transient attempt to re-run a turn the provider already ended.
      const drainTruncated =
        reason.kind === "provider_terminal" &&
        !reason.drained &&
        (slotProof?.providerStatus ?? "").toLowerCase() === "completed";
      if (drainTruncated) {
        notes.push(MARKER_UNDELIVERED_CONTENT);
      }
      if (sawReasoning) {
        // A FIXED string: no model prose, and no free-form numbers either.
        //
        // `notes` becomes stderrTail, which is classifyFailure's whole
        // witness. Prose is the obvious hazard — reasoning is model-generated
        // text about the very failure modes those patterns name, which is
        // exactly why finalText is excluded from the witness and reasoning is
        // finalText's sibling. The counts are the SUBTLE one, and they were
        // measured, not guessed: the witness patterns include `\b429\b` and
        // `\b(?:502|503|504)\b`, so a reasoning stream of exactly 429 bytes
        // would have classified its own attempt `rate_limit`, and one of 503
        // bytes `network_transient`. A byte count lands in that range often.
        // The volume is not worth a note that can lie about why an attempt
        // failed, and the fact that matters — reasoning and no answer — is
        // stated below without a single digit.
        notes.push(
          "[pr-hero] opencode sdk: reasoning parts were received and discarded; reasoning is not the answer",
        );
      }
      // Only on a turn the provider actually finished. An aborted or errored
      // turn legitimately has no answer text, and saying otherwise would put a
      // second, competing diagnosis on an attempt that already has one.
      if (
        reason.kind === "provider_terminal" &&
        sawReasoning &&
        finalParts.length === 0
      ) {
        notes.push(MARKER_REASONING_ONLY);
      }
      // #126: the four tallies below go to `diagnostics`, never `notes`. They
      // interpolate raw counts, and a count is a number we chose — landing it
      // in the witness lets our own bookkeeping answer a question only the
      // provider may answer. `429` poll timeouts filed as `rate_limit`, `503`
      // as `network_transient`, and — the leak that needs no rare number at
      // all — "poll round(s) timed out" carries the literal words `timed out`,
      // which the legacy classifier reads as transient at EVERY count.
      if (sinkClosed) {
        diagnostics.push(
          `[pr-hero] opencode sdk: sink closed early; ${closedDataPlaneEvents} data-plane event(s) not delivered`,
        );
      }
      if (pollTimeouts > 0) {
        diagnostics.push(
          `[pr-hero] opencode sdk: ${pollTimeouts} poll round(s) timed out; timeouts cannot win the terminal slot`,
        );
      }
      if (pollConfirmations > 0) {
        diagnostics.push(
          `[pr-hero] opencode sdk: poll confirmed the winning terminal ${pollConfirmations} time(s) without creating a second terminal`,
        );
      }
      if (invalidProofs > 0) {
        diagnostics.push(
          `[pr-hero] opencode sdk: ${invalidProofs} invalid terminal proof(s) ignored`,
        );
      }

      let completion: TransportOutcome["completion"];
      let protocolIntegrity: TransportOutcome["protocolIntegrity"];
      switch (reason.kind) {
        case "provider_terminal":
        case "abort_confirmed": {
          // #132: a won terminal over a delivery that never finished. The
          // proof is real and stays attached as EVIDENCE — the same rule the
          // conflict arm follows — but §4.2 line 191 forbids reporting a
          // truncated answer as anything but truncated, and success is the one
          // verdict that would hide it. Only the completed status can reach
          // here; see `drainTruncated` above for why the others must not.
          if (drainTruncated) {
            completion = "failed";
            protocolIntegrity = "truncated";
            break;
          }
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
        case "session_failed":
          // Unverified, never malformed: nothing contradicted anything. The
          // provider simply never opened a turn, and the transport refuses to
          // manufacture a proof for the one it did not run.
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

      outcome = {
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
        // D1-07 bridge recovers watchdog_timeout from harness-set timedOut on
        // the outcome, not from transport notes.
        stderrTail: boundTailBytes(notes.join("\n"), MAX_STDERR_TAIL_BYTES),
        // Bounded like the witness (§4.2 line 191) because it lands on disk
        // through the same attempt log and the same redaction.
        diagnosticsTail: boundTailBytes(
          diagnostics.join("\n"),
          MAX_STDERR_TAIL_BYTES,
        ),
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
    } finally {
      if (streamIterator !== undefined) {
        await Promise.race([
          streamIterator.return?.() ??
            Promise.resolve({ done: true as const, value: undefined }),
          new Promise<void>((resolve) => {
            setTimeout(resolve, this.cleanupMs);
          }),
        ]).catch(() => {});
      }
    }
  }

  // Lease teardown only: execute() must not close the shared client because
  // the cached transport instance is reused across retries and concurrent steps
  // on the same routeFingerprint until registry.release() evicts it.
  async dispose(): Promise<void> {
    await this.client.close?.().catch(() => {});
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
    // LAST, and the position is the point. A session that never opened — or a
    // TURN that never started, which is the same fact one call later: the
    // provider refused the prompt, so no message exists and the model never
    // saw the request — is the runtime being unavailable. §7 makes that
    // terminal, so it stops instead
    // of spending the format-reminder budget on an attempt the model never
    // saw. That is what went wrong in issue #121: `sdk.createClient is not a
    // function` reached the harness with no mapped witness, fell through to
    // the legacy classifier, and was filed as `format_violation` — a
    // TypeError in our own transport recorded in the bucket reserved for
    // model misbehaviour, burning a retry on the way.
    //
    // Checked after the auth/rate-limit/network patterns because both
    // messages CARRY the provider's own text: "session creation failed:
    // fetch failed" is a transient network failure that keeps its retry, and
    // a refused prompt is if anything more likely to be a 429 or a 401. A
    // marker check above them would silently delete those paths.
    if (
      witness.includes(MARKER_SESSION_CREATE) ||
      witness.includes(MARKER_PROMPT_REFUSED)
    ) {
      return "runtime_unavailable";
    }
    // LAST, under the same ordering rule as the two markers above and for the
    // same reason: this note sits beside the provider's own text in the same
    // witness, so a 429 or a 401 recorded on the same attempt must still win.
    //
    // `protocol_truncation`, not `runtime_unavailable` and not
    // `format_violation`. §7 freezes the cause vocabulary, so the choice is
    // between existing members: the runtime WAS available and the model DID
    // run, which rules out the first; nothing malformed was written, which
    // rules out the second — a format reminder would spend that budget telling
    // the model to reformat an answer it never produced. What actually
    // happened is that the answer channel delivered no content, and
    // truncation's disposition is the remedy that can work: a FRESH attempt on
    // the transient budget, bounded at 3, never the format budget.
    // #132, and LAST for the same reason as the markers above: this note sits
    // beside the provider's own text in one witness, so a 429 or a 401
    // recorded on the same attempt must still win. `protocol_truncation` is
    // the literal fact — the answer channel was cut short — and its
    // disposition is the remedy that can work: a FRESH attempt on the
    // transient budget, never the format budget, which would spend a reminder
    // telling the model to reformat text it did finish writing.
    if (witness.includes(MARKER_UNDELIVERED_CONTENT)) {
      return "protocol_truncation";
    }
    if (witness.includes(MARKER_REASONING_ONLY)) return "protocol_truncation";
    return undefined;
  }
}
