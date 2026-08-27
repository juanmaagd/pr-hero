// D1-06: the mapping between what @opencode-ai/sdk actually emits and the
// narrow `OpenCodeClientLike` contract the transport was built against.
//
// Everything here is derived from a recorded live probe
// (scripts/opencode-probe.ts), not from the SDK's type declarations: the
// declared Event union has 32 members and answers none of the questions that
// decide this mapping. The full findings, including the three traps encoded
// below, are in docs/research/opencode-adapter-mapping.md.
//
// This module is PURE. The impure half — spawning a server with the projected
// credential environment and a verified absolute binary — is a separate slice,
// because the SDK's own `createOpencodeServer` cannot be used for it: it
// inherits process.env wholesale and resolves the binary off PATH, so it would
// defeat both the credential projection (§6.1) and the verified-binary rule
// (§13).

import type { ProviderTerminalProof } from "../execution/contracts";
import type {
  OpenCodeClientEvent,
  OpenCodeClientLike,
  OpenCodeClientSession,
  OpenCodeCreateSessionInput,
  OpenCodePollResult,
} from "./opencode-sdk";
import type { OpenCodeServerHandle } from "./opencode-server";

// Structural, not imported from the SDK: pr-hero ships with ZERO runtime
// dependencies, and a Claude-only install must not pull an OpenCode SDK it
// will never call. The adapter slice declares the SDK an OPTIONAL peer and
// reaches it through a dynamic import.
interface RawEvent {
  readonly type?: unknown;
  readonly properties?: unknown;
}

function props(raw: unknown): Record<string, unknown> | undefined {
  const candidate = (raw as RawEvent)?.properties;
  return typeof candidate === "object" && candidate !== null
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

// §5.2/§3.2: the proof must be PROVIDER-issued. `session.idle` cannot supply
// one — its entire payload is {sessionID} — so the proof is taken from the
// assistant message, which carries a real completion record. Both §197
// observers reach it independently: the stream through `message.updated`, the
// poll through session.get/session.messages.
export function terminalProofFromAssistant(
  info: unknown,
): ProviderTerminalProof | undefined {
  const message = asRecord(info);
  if (message === undefined) return undefined;
  if (message.role !== "assistant") return undefined;

  const id = message.id;
  if (typeof id !== "string" || id.length === 0) return undefined;

  const completed = asNumber(asRecord(message.time)?.completed);
  // Not finished is not a terminal. An assistant message exists from the
  // moment the turn starts; only `time.completed` says the turn ended.
  if (completed === undefined) return undefined;

  // providerStatus is a NORMALISED field, not a passthrough. The transport
  // maps "completed" to success, "cancelled" to cancelled and EVERYTHING ELSE
  // to failed (opencode-sdk.ts:781-789), so handing it OpenCode's raw finish
  // reason reported every successful completion as a failure — pr-hero found
  // exactly that, filed BLOCKER, on PR #82. The provider's vocabulary is
  // translated here rather than leaked into a field whose meaning is fixed
  // somewhere else.
  //
  // §3.2 sets the direction of every uncertain case: an unrecognised outcome
  // must never become success. `finish` is declared `finish?: string` with no
  // enumerated value space, so anything outside the known set stays outside
  // "completed" and the transport's else-branch turns it into a failure.
  const error = asRecord(message.error);
  const finish = message.finish;
  const providerStatus =
    error !== undefined
      ? // An abort is a cancellation, not a failure — the harness accounts
        // for those differently (§5.3), and calling one the other loses the
        // distinction that says whether remote work may still be running.
        error.name === "MessageAbortedError"
        ? "cancelled"
        : "failed"
      : finish === "stop"
        ? "completed"
        : typeof finish === "string" && finish.length > 0
          ? finish
          : "unknown";

  return {
    eventId: id,
    providerStatus,
    providerObservedAt: new Date(completed).toISOString(),
  };
}

// SessionStatus's `retry` arm carries `next`, a timestamp. This is the
// provider-issued backoff hint decideRetryDisposition (§7) has accepted as an
// optional retryAfterMs since D1-07 and that no transport has ever been able
// to supply — the CLI transport reads the child's stdout and never sees an
// HTTP header. Returned as a DURATION because that is what the policy takes,
// and only when it is still in the future: a hint that already elapsed is not
// a hint, and passing a negative delay would be worse than passing none.
export function retryHintFromStatus(
  status: unknown,
  nowMs: number,
): number | undefined {
  const record = asRecord(status);
  if (record?.type !== "retry") return undefined;
  const next = asNumber(record.next);
  if (next === undefined) return undefined;
  const delta = next - nowMs;
  return delta > 0 ? delta : undefined;
}

// Returns a LIST because one raw event can carry two facts: the assistant's
// completed `message.updated` is both the attempt's real usage figure and its
// terminal proof. Usage is emitted FIRST so the transport has banked it before
// the terminal can settle the attempt out from under it.
export function mapOpenCodeEvents(
  raw: unknown,
  sessionId: string,
): OpenCodeClientEvent[] {
  const type = (raw as RawEvent)?.type;
  if (typeof type !== "string") return [];
  const p = props(raw);
  if (p === undefined) return [];

  // TRAP 1: event.subscribe() is GLOBAL, not scoped to a session. One trivial
  // prompt produced 71 events, 45 of them `plugin.added`. Every event that
  // matters carries properties.sessionID and none of the noise does, so this
  // one check is both the session filter and the noise filter.
  if (p.sessionID !== sessionId) return [];

  switch (type) {
    // TRAP 2: text deltas come from `message.part.delta` ONLY.
    // `message.part.updated` also fires for the USER message — the recorded
    // one carried the prompt text itself — so an adapter that treated every
    // text part as a delta would echo the prompt into finalText and hand it
    // to StepSpec.parse as though the model had written it.
    case "message.part.delta": {
      if (p.field !== "text") return [];
      const delta = p.delta;
      if (typeof delta !== "string" || delta.length === 0) return [];
      return [{ kind: "delta", text: delta }];
    }

    // `session.updated` is deliberately NOT a usage source. Its info.tokens
    // stayed {input:0, output:0, ...} for the ENTIRE recorded run while the
    // real figures (24012 in / 6 out) only ever appeared on the assistant
    // message. Since §4.2 snapshot mode REPLACES the counters, a zero
    // snapshot arriving after a real one would wipe the attempt's usage —
    // silently, and in the direction that under-reports spend.

    case "message.updated": {
      const info = asRecord(p.info);
      if (info === undefined || info.role !== "assistant") return [];
      const out: OpenCodeClientEvent[] = [];

      // Usage rides the assistant message and is a SNAPSHOT: the message's
      // own running totals, restated. Emitted even mid-turn, where they are
      // zeros — harmless under REPLACE semantics, since the completed message
      // that follows carries the real figures.
      const tokens = asRecord(info.tokens);
      const inputTokens = asNumber(tokens?.input);
      const outputTokens = asNumber(tokens?.output);
      const costUsd = asNumber(info.cost);
      if (
        inputTokens !== undefined ||
        outputTokens !== undefined ||
        costUsd !== undefined
      ) {
        out.push({
          kind: "usage",
          mode: "snapshot",
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(costUsd !== undefined ? { costUsd } : {}),
        });
      }

      const proof = terminalProofFromAssistant(info);
      if (proof !== undefined) out.push({ kind: "terminal", proof });
      return out;
    }

    // A busy session is the provider saying it is still working — exactly what
    // §4.2's heartbeat is for. A `retry` status is NOT a heartbeat: it is
    // backoff, and it reaches the policy through retryHintFromStatus.
    case "session.status": {
      const status = asRecord(p.status);
      return status?.type === "busy" ? [{ kind: "heartbeat" }] : [];
    }

    // TRAP 3: `session.idle` is deliberately NOT mapped. Its entire payload is
    // {sessionID} — no id, no status, no timestamp — so synthesising a proof
    // from it would mean the transport issuing its own proof and then letting
    // it win the §197 slot, which is precisely what that slot exists to
    // prevent. Idle keeps a job, just not this one: it tells the caller the
    // session stopped working, i.e. when to stop polling.
    default:
      return [];
  }
}

// The one thing `session.idle` IS good for.
export function isSessionIdle(raw: unknown, sessionId: string): boolean {
  return (
    (raw as RawEvent)?.type === "session.idle" &&
    props(raw)?.sessionID === sessionId
  );
}

// ---------------------------------------------------------------------------
// The impure half: an OpenCodeClientLike over the real SDK.
//
// Everything the SDK touches is behind `OpenCodeSdkLike` and reached through
// an injectable loader. pr-hero ships with ZERO runtime dependencies, so the
// SDK is an OPTIONAL PEER: a Claude-only install must never pull it, and an
// install that does route here must be told what to add rather than handed a
// module-resolution stack trace.
// ---------------------------------------------------------------------------

export interface OpenCodeSdkClientApi {
  readonly session: {
    create(options?: unknown): Promise<{ data: { id: string } }>;
    prompt(options: unknown): Promise<{ data: unknown }>;
    messages(options: unknown): Promise<{ data: unknown }>;
    abort(options?: unknown): Promise<{ data: unknown }>;
  };
  readonly event: {
    subscribe(options?: unknown): Promise<{ stream: AsyncIterable<unknown> }>;
  };
}

export interface OpenCodeSdkLike {
  createClient(config: { baseUrl: string }): OpenCodeSdkClientApi;
}

export interface CreateOpenCodeClientOptions {
  readonly loadSdk: () => Promise<OpenCodeSdkLike>;
  readonly launchServer: () => Promise<OpenCodeServerHandle>;
  readonly model: { readonly providerID: string; readonly modelID: string };
  readonly readSystemPrompt: (promptPath: string) => Promise<string>;
  // §6 deny floor: tools that stay false unless the spec names them. Absent is
  // NOT the same as false — an absent key asks for the provider's default, and
  // the provider's default is not ours to inherit.
  readonly denyFloor?: readonly string[];
}

const DEFAULT_DENY_FLOOR = ["bash"] as const;

interface SessionState {
  readonly api: OpenCodeSdkClientApi;
  // ONE consumer of the subscription, ever. The pump owns the iterator and
  // hands events over through this queue; streamEvents never touches the
  // stream itself. Two for-awaits on one async iterator is a race with two
  // losing sides: the second consumer can miss an event the first already
  // took, and either one exiting fires an implicit .return() that ends the
  // SHARED generator under the other. pr-hero found exactly that here
  // (F002/F003 on PR #84) — in a repo that had already written the hazard
  // down, in opencode-sdk.ts, and walked into it anyway.
  readonly queue: unknown[];
  ended: boolean;
  wake?: () => void;
}

export function createOpenCodeClient(
  options: CreateOpenCodeClientOptions,
): OpenCodeClientLike & { close(): Promise<void> } {
  const states = new Map<string, SessionState>();
  const denyFloor = options.denyFloor ?? DEFAULT_DENY_FLOOR;
  // ONE server for the whole client, launched lazily. A server per SESSION
  // left a spawned process behind for every attempt, released only by a
  // whole-client close() that is not even part of OpenCodeClientLike
  // (pr-hero F004 on PR #84). One server hosts many sessions; that is what
  // the session API is for.
  let serverPromise: Promise<OpenCodeServerHandle> | undefined;
  let server: OpenCodeServerHandle | undefined;
  // Calls that have committed to the shared server but have not registered a
  // session yet. `states` alone cannot answer "is anyone using this?": its
  // entry appears only after session.create AND event.subscribe both
  // succeed, so a sibling mid-establishment is invisible to it — and a
  // failing call would then SIGTERM the server that healthy sibling is using.
  // Sharing one server is what created this hazard; per-session servers could
  // not have had it.
  let establishing = 0;

  function stateFor(session: OpenCodeClientSession): SessionState {
    const state = states.get(session.id);
    if (state === undefined) {
      throw new Error(`unknown opencode session: ${session.id}`);
    }
    return state;
  }

  return {
    async createSession(
      input: OpenCodeCreateSessionInput,
    ): Promise<OpenCodeClientSession> {
      let sdk: OpenCodeSdkLike;
      try {
        sdk = await options.loadSdk();
      } catch (error) {
        throw new Error(
          "the opencode backend needs @opencode-ai/sdk, which is an optional " +
            "peer dependency of pr-hero. Install it alongside pr-hero to use " +
            `this backend. (${(error as Error).message})`,
        );
      }

      // Read BEFORE anything is spawned. It is the one step that fails on the
      // operator's filesystem, and doing it first means an unreadable prompt
      // costs nothing to unwind. pr-hero F005 found it running AFTER the
      // server, the remote session and the registered state — leaking all
      // three, with the caller never given the id needed to abort any of them.
      const systemPrompt = await options.readSystemPrompt(
        input.systemPromptPath,
      );

      if (serverPromise === undefined) {
        serverPromise = options.launchServer();
        try {
          server = await serverPromise;
        } catch (error) {
          // A failed launch must not poison the client forever.
          serverPromise = undefined;
          throw error;
        }
      }
      const handle = server ?? (await serverPromise);
      const api = sdk.createClient({ baseUrl: handle.url });

      let sessionId: string | undefined;
      establishing += 1;
      try {
        const created = await api.session.create({
          body: { title: "pr-hero review step" },
        });
        sessionId = created.data.id;

        // Subscribed BEFORE the prompt, and the ordering is not stylistic.
        // event.subscribe() is live and unbuffered, so a subscription opened
        // afterwards silently loses the early events — the ones carrying the
        // first deltas. The contract splits createSession and streamEvents
        // into separate calls, so unless the buffering happens here that
        // window cannot be closed at all.
        const subscription = await api.event.subscribe();
        const state: SessionState = { api, queue: [], ended: false };
        states.set(sessionId, state);

        // The ONLY consumer of the subscription. Subscribing without pulling
        // buys nothing — an SSE iterator nobody reads is not a recording, the
        // events simply have not been requested yet.
        void (async () => {
          try {
            for await (const raw of subscription.stream) {
              state.queue.push(raw);
              state.wake?.();
              state.wake = undefined;
            }
          } catch {
            // A dead stream ends the handoff; the poll still observes the
            // attempt.
          } finally {
            state.ended = true;
            state.wake?.();
            state.wake = undefined;
          }
        })();

        const tools: Record<string, boolean> = {};
        for (const tool of denyFloor) tools[tool] = false;
        for (const tool of input.tools) tools[tool] = true;

        // FIRED, never awaited. session.prompt blocks until the turn finishes
        // — the probe measured 4.5s — and returns the completed message. The
        // ROADMAP forbids completing an attempt from one blocking HTTP call,
        // so this is the trigger and the event stream is the truth.
        void api.session
          .prompt({
            path: { id: sessionId },
            query: { directory: input.cwd },
            body: {
              model: { ...options.model },
              system: systemPrompt,
              tools,
              parts: [{ type: "text", text: input.userPrompt }],
            },
          })
          .catch(() => {
            // Both observers see the failure; swallowing it here keeps a
            // trigger-shaped call from becoming an unhandled rejection that
            // outlives the attempt.
          });

        return { id: sessionId };
      } catch (error) {
        // Unwind whatever this call managed to create. Without this the
        // caller gets an exception and no id, so nothing can be released by
        // hand afterwards.
        if (sessionId !== undefined) {
          states.delete(sessionId);
          // A remote session that WAS created is real work on the provider's
          // side; dropping the local map entry does not release it.
          await api.session.abort({ path: { id: sessionId } }).catch(() => {});
        }
        throw error;
      } finally {
        establishing -= 1;
        // Close only when NOBODY is left — no registered session and no call
        // still establishing one. On a successful call states is non-empty,
        // so this never fires; on the last failure with no siblings it
        // releases the subprocess instead of leaking it.
        if (establishing === 0 && states.size === 0) {
          const dying = server;
          serverPromise = undefined;
          server = undefined;
          if (dying !== undefined) await dying.close().catch(() => {});
        }
      }
    },

    async *streamEvents(session: OpenCodeClientSession) {
      const state = stateFor(session);
      // Reads the QUEUE, never the stream. Everything buffered before this
      // call is already here in arrival order, and everything after arrives
      // through the same door — so there is no handoff to race.
      for (;;) {
        while (state.queue.length > 0) {
          yield* mapOpenCodeEvents(state.queue.shift(), session.id);
        }
        if (state.ended) return;
        await new Promise<void>((resolve) => {
          state.wake = resolve;
        });
      }
    },

    async pollStatus(
      session: OpenCodeClientSession,
    ): Promise<OpenCodePollResult> {
      const state = stateFor(session);
      const response = await state.api.session.messages({
        path: { id: session.id },
      });
      const list = Array.isArray(response.data) ? response.data : [];
      // Last completed assistant message wins; the same helper the stream
      // uses, on purpose. §197 wants two INDEPENDENT observers of ONE fact,
      // not two facts that happen to resemble each other — two copies of this
      // derivation could drift and manufacture a conflict out of nothing.
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const info = (list[i] as { info?: unknown })?.info;
        const proof = terminalProofFromAssistant(info);
        if (proof !== undefined) return { kind: "terminal", proof };
      }
      return { kind: "pending" };
    },

    async abort(session: OpenCodeClientSession): Promise<void> {
      const state = stateFor(session);
      await state.api.session.abort({ path: { id: session.id } });
    },

    async close(): Promise<void> {
      states.clear();
      const handle = server;
      server = undefined;
      serverPromise = undefined;
      if (handle !== undefined) await handle.close();
    },
  };
}
