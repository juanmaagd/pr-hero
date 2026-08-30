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

// BOTH arms of the SDK's `RequestResult`. With its default
// `ThrowOnError = false` every session call resolves to either
// `{ data, error: undefined }` or `{ data: undefined, error }` — an API error
// is a RESOLVED promise, not a rejected one. The first version of this
// interface declared only the success arm, so a rejected model or a bad body
// reached `.data.id` with `data` undefined and became a TypeError carrying
// none of the provider's diagnosis (issue #121).
//
// Modelled as a union rather than collapsed with `throwOnError: true`
// deliberately: the collapse is a per-call TYPE inference on the SDK's own
// generic signatures, and it cannot travel through a narrow non-generic
// interface like this one — the declared return type governs at every call
// site here. The union is the shape the transport must actually survive.
export type OpenCodeSdkResult<T> =
  | { readonly data: T; readonly error?: undefined }
  | { readonly data?: undefined; readonly error: unknown };

// Deliberately narrow: the transport needs five methods, not the SDK's
// twenty namespaces. test/conformance/opencode-sdk-surface.test.ts asserts at
// COMPILE TIME that the real `OpencodeClient` is assignable to this, so the
// narrowing can never drift back into a guess. Members are method shorthand,
// not properties, on purpose — property-style function types are checked
// contravariantly under `strict` and would reject the real client's generic
// signatures for a reason that has nothing to do with conformance.
export interface OpenCodeSdkClientApi {
  readonly session: {
    create(options?: unknown): Promise<OpenCodeSdkResult<{ id: string }>>;
    prompt(options: unknown): Promise<OpenCodeSdkResult<unknown>>;
    messages(options: unknown): Promise<OpenCodeSdkResult<unknown>>;
    abort(options?: unknown): Promise<OpenCodeSdkResult<unknown>>;
  };
  readonly event: {
    subscribe(options?: unknown): Promise<{ stream: AsyncIterable<unknown> }>;
  };
  // `GET /experimental/tool/ids` — "List all tool IDs (including built-in and
  // dynamically registered)". REQUIRED, never optional: an optional member
  // lets a fake skip the surface silently, which is the shape of issue #121.
  // The endpoint is experimental-prefixed, so pinning it here (and in the
  // surface conformance test) is what keeps a rename from going unnoticed.
  readonly tool: {
    ids(options?: unknown): Promise<OpenCodeSdkResult<readonly string[]>>;
  };
}

export interface OpenCodeSdkLike {
  // `createOpencodeClient`, and the name is the whole of issue #121: this
  // interface used to declare `createClient`, which the SDK has never
  // exported. Nothing compared the two, so every live OpenCode step died on
  // `sdk.createClient is not a function` while the offline suite stayed green
  // — every mock was shaped to the same guess.
  createOpencodeClient(config: { baseUrl: string }): OpenCodeSdkClientApi;
}

// The runtime half of the conformance check. `import type` is erased, so it
// cannot guard the DYNAMIC import the transport registry performs; the loaded
// module is therefore validated instead of asserted. This replaces two
// `as unknown as OpenCodeSdkLike` casts — the strongest assertion TypeScript
// has, pointed at a hand-written guess, which is precisely why the guess was
// never caught.
export function assertOpenCodeSdk(module: unknown): OpenCodeSdkLike {
  const candidate = module as Partial<OpenCodeSdkLike> | null | undefined;
  if (
    candidate === null ||
    candidate === undefined ||
    typeof candidate.createOpencodeClient !== "function"
  ) {
    throw new Error(
      "@opencode-ai/sdk resolved but does not export createOpencodeClient(), " +
        "which pr-hero needs to open a session. The installed package is not " +
        `the SDK this transport was built against (got ${describeModule(module)}).`,
    );
  }
  return candidate as OpenCodeSdkLike;
}

function describeModule(module: unknown): string {
  if (typeof module !== "object" || module === null) return typeof module;
  const keys = Object.keys(module).sort();
  return keys.length === 0 ? "an object with no exports" : keys.join(", ");
}

// Every `.data` read in this file goes through here. The alternative — reading
// `.data` and trusting it — is the defect.
function unwrap<T>(result: OpenCodeSdkResult<T>, call: string): T {
  const data = result.data;
  if (result.error !== undefined || data === undefined) {
    throw new Error(
      `opencode ${call} failed: ${describeSdkError(result.error)}`,
    );
  }
  return data;
}

function describeSdkError(error: unknown): string {
  if (error === undefined) return "the provider returned no data and no error";
  if (typeof error === "string") return error;
  const message = asRecord(error)?.message;
  if (typeof message === "string" && message.length > 0) return message;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
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

// The engine's canonical tool names are Claude Code's namespace
// (`BINDING_ALLOWED_TOOLS`, and the `tools:` line of every bundled prompt).
// They stay that way: the gate is backend-neutral and the prompt set is shared
// across backends, so the translation into a provider's vocabulary belongs
// HERE and nowhere else.
//
// Issue #122: this table did not exist, and the canonical names were written
// into the prompt's `tools` map verbatim. That map is an OPEN
// `{[key: string]: boolean}`, so OpenCode accepted "Read"/"Grep"/"Glob"/
// "mcp__codegraph__codegraph_explore" and silently ignored all four — no
// error, no warning, nothing in the response. The allowlist allowed nothing
// and the denylist denied only "bash", which landed by pure naming
// coincidence.
//
// `mcp__codegraph__codegraph_explore` is deliberately absent. It maps onto no
// OpenCode built-in, and dropping it is PARITY, not a gap: on claude-code a
// repo without a codegraph index runs its hunters with the other three tools
// and an empty mcp.json. MCP expressibility on OpenCode is a separate open
// question — opencode-sdk.ts threads an `mcpConfigPath` into the request that
// this client never applies to the session.
const CANONICAL_TO_OPENCODE_TOOL: Readonly<Record<string, string>> = {
  Read: "read",
  Grep: "grep",
  Glob: "glob",
};

// ENUMERATE, never trust a default. Every id the provider reports is written
// into the map explicitly — the allows true, everything else false — so no key
// is ever absent. An absent key asks for the provider's default, and
// opencode.ai/docs/tools says "By default, all tools are enabled": leaving
// `write`, `edit`, `apply_patch` or `task` absent hands the model exactly the
// tools §6 exists to withhold. Enumerating makes the question moot rather than
// answering it, which is the only durable form of the fix.
function resolveToolMap(
  surface: readonly string[],
  canonicalTools: readonly string[],
  denyFloor: readonly string[],
): Record<string, boolean> {
  const tools: Record<string, boolean> = {};
  for (const id of surface) tools[id] = false;
  // Defense in depth. Ordering is unchanged from before the fix — the floor is
  // written first and a named allow may still flip it (`denyFloor`'s contract
  // says so) — but no canonical name in the table above maps onto a floor id,
  // so the floor cannot be lifted by a prompt's `tools:` line.
  for (const tool of denyFloor) tools[tool] = false;
  for (const canonical of canonicalTools) {
    const id = CANONICAL_TO_OPENCODE_TOOL[canonical];
    // Two separate drops, both intentional. An unmapped canonical name (the
    // codegraph MCP tool) has no built-in to name; an id the provider did not
    // report is not on this build's surface. Writing either one in would be
    // the absent-key hazard in reverse — a key we invented, meaning whatever
    // the provider decides it means.
    if (id === undefined) continue;
    if (!(id in tools)) continue;
    tools[id] = true;
  }
  return tools;
}

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
  // The handoff can end two ways. The pump ending is an EOF and says nothing
  // about the turn; this says the turn never started, and carries the
  // provider's diagnosis to the consumer instead of leaving it to infer a
  // silence. Set only for a failure the stream itself could never report,
  // because a refused prompt creates no message and therefore no events.
  failure?: string;
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
      const api = sdk.createOpencodeClient({ baseUrl: handle.url });

      let sessionId: string | undefined;
      establishing += 1;
      try {
        // FIRST, and inside the try on purpose. The tool surface is the one
        // thing this call must establish before anything else exists: a
        // session whose isolation cannot be expressed is the runtime being
        // unavailable, and failing here unwinds through the `finally` below
        // that releases the shared server (F004's hazard, already paid for).
        // There is deliberately NO hardcoded fallback list and no partial
        // map — either one would rebuild the "we believe this is enforced"
        // claim the defect was made of, while production-runtime.ts keeps
        // reporting `allowMapEnforced: true` to the admission gate.
        let reported: readonly string[];
        try {
          reported = unwrap(
            await api.tool.ids({ query: { directory: input.cwd } }),
            "tool.ids",
          );
        } catch (error) {
          // Rethrown with context, never swallowed. The provider's own text is
          // APPENDED rather than replaced: classifyFailure checks its
          // auth/rate-limit/network patterns before the session-creation
          // marker, so "fetch failed" here still keeps its transient retry
          // instead of being flattened into a terminal ruling.
          throw new Error(
            "opencode could not report its tool surface, so the allow map " +
              `cannot be enumerated: ${(error as Error).message}`,
          );
        }
        const surface = (Array.isArray(reported) ? reported : []).filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        );
        if (surface.length === 0) {
          throw new Error(
            "opencode reported an empty tool surface, so the allow map cannot " +
              "be enumerated and no tool can be proven denied; refusing to " +
              "open a session whose isolation is unverifiable",
          );
        }
        const tools = resolveToolMap(surface, input.tools, denyFloor);

        const created = await api.session.create({
          body: { title: "pr-hero review step" },
        });
        sessionId = unwrap(created, "session.create").id;

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

        // FIRED, never awaited. session.prompt blocks until the turn finishes
        // — the probe measured 4.5s — and returns the completed message. The
        // ROADMAP forbids completing an attempt from one blocking HTTP call,
        // so this is the trigger and the event stream is the truth.
        //
        // Its RESULT is still observed, and the earlier `.catch()` was not
        // enough to do that: under the SDK's default `ThrowOnError = false` an
        // API-level refusal RESOLVES with `{ data: undefined, error }`, so the
        // handler never ran and the refusal was dropped. The comment that
        // stood here claimed both §197 observers would see it anyway, which is
        // false in exactly the case that matters — a prompt the provider
        // refused creates no message, so no event fires and the poll has
        // nothing to find. The attempt then sat armed waiting for a terminal
        // that a turn which never started could never produce, until the
        // harness watchdog charged it as a timeout.
        //
        // A refusal answers at CALL time, not at turn end, so observing it
        // costs the trigger shape nothing: this stays fired-not-awaited, and
        // only the failure travels — through the same `ended`/`wake` handoff
        // the pump uses, so the consumer needs no second door.
        void (async () => {
          try {
            unwrap(
              await api.session.prompt({
                path: { id: sessionId },
                query: { directory: input.cwd },
                body: {
                  model: { ...options.model },
                  system: systemPrompt,
                  tools,
                  parts: [{ type: "text", text: input.userPrompt }],
                },
              }),
              "session.prompt",
            );
          } catch (error) {
            state.failure = (error as Error).message;
            state.ended = true;
            state.wake?.();
            state.wake = undefined;
          }
        })();

        // The map travels with the session so the attempt can stamp what was
        // ACTUALLY sent into its stderr notes. #116's ledger requires the
        // tools/MCP axis be provable by reading artifacts; before this,
        // nothing recorded the map at all and the only evidence of the defect
        // was a hunter narrating tool use it never performed.
        return { id: sessionId, toolMap: Object.freeze(tools) };
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
        // Checked AFTER the drain and BEFORE `ended`: anything the provider
        // already said is delivered first — a terminal buffered before the
        // failure still wins its slot — and a failure is a louder end than an
        // EOF, so it must not be swallowed by the plain return below.
        if (state.failure !== undefined) throw new Error(state.failure);
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
      // Throws on the error arm rather than reporting "pending": the caller
      // treats a poll that throws as a FAILED OBSERVATION and counts it
      // (opencode-sdk.ts:707), whereas a silent "pending" would let the
      // attempt run to its stall deadline on an API error the provider
      // already explained.
      const messages = unwrap(response, "session.messages");
      const list = Array.isArray(messages) ? messages : [];
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
      // The result is CHECKED, not discarded. Awaiting the error arm proves
      // nothing on its own — it resolves — so a provider-side refusal used to
      // return here as an ordinary success and the caller recorded a confirmed
      // abort over a remote session that may still be running, and billing.
      // Throwing is what makes it visible: the single caller
      // (opencode-sdk.ts's callAbortOnce) catches and stamps a note into
      // stderrTail, which keeps abort best-effort — observed, never fatal to
      // the teardown it runs inside.
      unwrap(
        await state.api.session.abort({ path: { id: session.id } }),
        "session.abort",
      );
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
