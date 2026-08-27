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
  readonly server: OpenCodeServerHandle;
  readonly buffered: unknown[];
  readonly stream: AsyncIterable<unknown>;
  drained: boolean;
}

export function createOpenCodeClient(
  options: CreateOpenCodeClientOptions,
): OpenCodeClientLike & { close(): Promise<void> } {
  const states = new Map<string, SessionState>();
  const denyFloor = options.denyFloor ?? DEFAULT_DENY_FLOOR;

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

      const server = await options.launchServer();
      const api = sdk.createClient({ baseUrl: server.url });
      const created = await api.session.create({
        body: { title: "pr-hero review step" },
      });
      const session: OpenCodeClientSession = { id: created.data.id };

      // Subscribed BEFORE the prompt, and the ordering is not stylistic.
      // event.subscribe() is live and unbuffered, so a subscription opened
      // afterwards silently loses the early events — which are exactly the
      // ones carrying the first deltas. The contract splits createSession and
      // streamEvents into separate calls, so unless the buffering happens
      // here that window cannot be closed at all.
      const subscription = await api.event.subscribe();
      const buffered: unknown[] = [];
      const state: SessionState = {
        api,
        server,
        buffered,
        stream: subscription.stream,
        drained: false,
      };
      states.set(session.id, state);

      // Pump the live stream into the buffer immediately. Without this the
      // "subscribe before prompt" ordering buys nothing: nobody reads the
      // stream until streamEvents() is called, and an unread SSE iterator is
      // not a recording — the events simply have not been pulled yet, and
      // anything the server pushed meanwhile sits in a socket nobody drains.
      void (async () => {
        for await (const raw of subscription.stream) {
          if (state.drained) return;
          buffered.push(raw);
        }
      })().catch(() => {
        // A stream that dies is observed by streamEvents/poll, not here.
      });

      const tools: Record<string, boolean> = {};
      for (const tool of denyFloor) tools[tool] = false;
      for (const tool of input.tools) tools[tool] = true;

      // FIRED, never awaited. session.prompt blocks until the turn finishes —
      // the probe measured 4.5s — and returns the completed message. The
      // ROADMAP forbids completing an attempt from one blocking HTTP call, so
      // this is the trigger and the event stream is the truth. A rejection
      // here would otherwise become an unhandled rejection that outlives the
      // attempt.
      void api.session
        .prompt({
          path: { id: session.id },
          query: { directory: input.cwd },
          body: {
            model: { ...options.model },
            system: await options.readSystemPrompt(input.systemPromptPath),
            tools,
            parts: [{ type: "text", text: input.userPrompt }],
          },
        })
        .catch(() => {
          // The stream and the poll both observe the failure; swallowing it
          // here keeps a trigger-shaped call from killing the process.
        });

      return session;
    },

    async *streamEvents(session: OpenCodeClientSession) {
      const state = stateFor(session);
      // Buffered first, in arrival order, then straight into the live stream.
      while (state.buffered.length > 0) {
        const raw = state.buffered.shift();
        yield* mapOpenCodeEvents(raw, session.id);
      }
      state.drained = true;
      for await (const raw of state.stream) {
        yield* mapOpenCodeEvents(raw, session.id);
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
      for (const state of states.values()) await state.server.close();
      states.clear();
    },
  };
}
