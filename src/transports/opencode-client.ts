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
import {
  ALL_MCP_TOOL_IDS,
  assertMcpConnected,
  mcpToolIdsFor,
  type OpenCodeMcpConfig,
  translateMcpConfig,
} from "./opencode-mcp";
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
// one — its entire payload is {sessionID} — so the proof CONTENT is taken from
// the assistant message, which carries a real completion record. Both §197
// observers reach it independently: the stream through `message.updated`, the
// poll through session.messages.
//
// A proof is not a BOUNDARY, and issue #127 is the whole cost of confusing the
// two. This function answers "did this STEP end", never "did the turn end":
// OpenCode creates one assistant message per agentic step, each with its own
// `time.completed`. The turn's boundary is `session.idle` on the stream and
// the session leaving `GET /session/status` on the poll; see mapOpenCodeEvents
// and pollStatus below.
export function terminalProofFromAssistant(
  info: unknown,
): ProviderTerminalProof | undefined {
  const message = asRecord(info);
  if (message === undefined) return undefined;
  if (message.role !== "assistant") return undefined;

  const id = message.id;
  if (typeof id !== "string" || id.length === 0) return undefined;

  const completed = asNumber(asRecord(message.time)?.completed);
  // Not finished is not a completion record. An assistant message exists from
  // the moment its step starts; only `time.completed` says the step ended and
  // therefore that there is anything here to quote as proof.
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

// TRAP 4 (issue #124): `message.part.delta` carries NO part type. Its whole
// payload is {sessionID, messageID, partID, field, delta}, so the only way to
// know what a delta belongs to is to correlate its `partID` against the part
// announced earlier by `message.part.updated`.
//
// Filtering on `field === "text"` — the FIELD NAME — is not that correlation
// and never was: the SDK declares `ReasoningPart` with a member literally
// called `text`, exactly as `TextPart` has, so with a reasoning model the
// model's private thinking was concatenated into finalText as if it were the
// answer. The #116 smoke pass 3 artifact shows it verbatim, two reasoning
// deltas glued together with no separator where the JSON answer belonged, and
// every hunter in that run failed format_violation over it.
//
// This is the state that correlation needs. It travels with the SessionState
// so it dies with the session rather than with the process, and BOTH maps are
// bounded: an SSE subscription is long-lived and a map keyed by a
// provider-generated id would otherwise grow for as long as the session does.
// Eviction is oldest-first (a Map iterates in insertion order), which is the
// safe direction — parts are announced and streamed in order, so the oldest
// entry is the one no delta can still name.
export interface OpenCodeTurnState {
  // Assistant-owned message ids. TRAP 2 lives here now: `message.part.updated`
  // fires for the USER message too, and the recorded one carried the prompt
  // text itself, so registering every text part would make a delta naming the
  // user's part echo the prompt into finalText — the exact defect TRAP 2 was
  // written to prevent, re-entering through the door the fix had to open.
  readonly assistantMessages: Set<string>;
  readonly parts: Map<string, "answer" | "reasoning">;
  // #127: the turn's usage, kept per MESSAGE ID rather than as one running
  // figure. Each step message restates its OWN totals, so within a message the
  // newest value replaces the older one — and the recorded probe
  // (test/fixtures/opencode/probe-events.json, indices 21 and 22) emits the
  // completed message twice, byte for byte, which a per-event sum would
  // double-count. Across messages the values are added, because each step is a
  // separately billed provider call.
  readonly usage: Map<string, StepUsage>;
  // What the bounded map above has already forgotten. The cap is a MEMORY
  // bound and must never become an accounting one: summing only the entries
  // still present made an evicted step's tokens vanish from every later total
  // — and the running figure could go DOWN at the instant of eviction, which
  // is the under-reporting direction this file calls the worst one to be wrong
  // in. Folding the evicted value in here keeps the figure whole while the map
  // stays bounded.
  carriedUsage: StepUsage;
  // The most recent completion record observed for this turn. This is the
  // proof CONTENT the boundary quotes; it is never itself a boundary.
  lastProof?: ProviderTerminalProof;
  // One terminal per turn. `session.idle` should fire once, but a second one
  // must not be able to manufacture a second proof — §197's slot reads a
  // repeat as a confirmation and a DIFFERENT proof as a conflict, so the
  // cheapest place to guarantee "once" is here, at the source.
  boundaryReported: boolean;
}

interface StepUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

// Generous on purpose: a long hunter turn announces a part per tool call, per
// step boundary and per text block, and evicting a part that is still being
// streamed would DROP answer text. The bound exists to make growth impossible,
// not to be reached.
const MAX_TRACKED_PARTS = 4096;
const MAX_TRACKED_MESSAGES = 512;

export function createTurnState(): OpenCodeTurnState {
  return {
    assistantMessages: new Set(),
    parts: new Map(),
    usage: new Map(),
    carriedUsage: {},
    boundaryReported: false,
  };
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done === true) return;
    map.delete(oldest.value);
  }
}

// Field-wise addition, and every field is INDEPENDENT: a field stays absent
// unless at least one step reported it. The mapper has never invented a zero,
// and a fabricated 0 would be indistinguishable from a real one to §8's
// "unavailable vs proven zero" distinction downstream.
function addField(
  base: number | undefined,
  step: number | undefined,
): number | undefined {
  if (step === undefined) return base;
  return (base ?? 0) + step;
}

function addUsage(base: StepUsage, step: StepUsage): StepUsage {
  const inputTokens = addField(base.inputTokens, step.inputTokens);
  const outputTokens = addField(base.outputTokens, step.outputTokens);
  const costUsd = addField(base.costUsd, step.costUsd);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

// The usage map's OWN eviction path, deliberately not the generic `remember`.
// A generic helper shared with `state.parts` would have to grow an eviction
// callback that exactly one of its two callers passes, and an optional hook
// that silently changes what a caller keeps is the same hazard as an absent
// tool key in resolveToolMap: the question gets made moot instead of answered.
// Parts want the evicted entry GONE — an id no delta can still name — while
// usage wants its value kept and its key forgotten. Those are different needs
// and they get different code.
//
// A message evicted and then restated is counted twice, and that is the
// accepted residual: bounded memory over an unbounded id space cannot dedupe
// perfectly, and the leftover error is an OVER-count — spend made visible,
// never hidden, which is the direction this transport chooses everywhere else.
function rememberUsage(
  state: OpenCodeTurnState,
  messageId: string,
  usage: StepUsage,
): void {
  state.usage.set(messageId, usage);
  while (state.usage.size > MAX_TRACKED_MESSAGES) {
    const oldest = state.usage.keys().next();
    if (oldest.done === true) return;
    const evicted = state.usage.get(oldest.value);
    state.usage.delete(oldest.value);
    // Folded BEFORE the entry is unreachable, so no path deletes a value the
    // carried total has not already absorbed.
    if (evicted !== undefined) {
      state.carriedUsage = addUsage(state.carriedUsage, evicted);
    }
  }
}

// The turn's figure: everything the map has forgotten, plus every step
// message's LATEST snapshot still in it. Starting from the carried total is
// what makes the cap a memory bound rather than an accounting one.
function turnUsage(state: OpenCodeTurnState): StepUsage {
  let total = state.carriedUsage;
  for (const step of state.usage.values()) total = addUsage(total, step);
  return total;
}

function rememberId(set: Set<string>, id: string, cap: number): void {
  set.add(id);
  while (set.size > cap) {
    const oldest = set.values().next();
    if (oldest.done === true) return;
    set.delete(oldest.value);
  }
}

// Returns a LIST because one raw event can carry two facts: the assistant's
// completed `message.updated` is both the attempt's real usage figure and its
// terminal proof. Usage is emitted FIRST so the transport has banked it before
// the terminal can settle the attempt out from under it.
//
// STATEFUL since #124, and the index is a REQUIRED parameter rather than an
// optional one. An optional index would need a default for "no index", and
// both available defaults are wrong: accepting every delta is the defect, and
// dropping every delta is an empty answer. An absent argument that silently
// changes what the mapper harvests is the same hazard as the absent tool key
// in resolveToolMap — the question is made moot instead of answered.
export function mapOpenCodeEvents(
  raw: unknown,
  sessionId: string,
  state: OpenCodeTurnState,
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
      const partId = p.partID;
      if (typeof partId !== "string") return [];
      // TRAP 4: the part's KIND decides, never the field name.
      //
      // An UNANNOUNCED part id is dropped, and that choice is deliberate. The
      // recorded probe settles the ordering question it turns on: the part is
      // announced by `message.part.updated` (type "text", text "") and only
      // then delta'd, and its owning `message.updated` precedes that — so a
      // delta whose part was never announced is not a race the provider is
      // known to run. Both directions can be wrong, and they are not equally
      // wrong: accepting an unannounced delta re-opens THIS bug for every part
      // type the provider adds next, silently, while dropping one costs at
      // worst an answer that arrives short — which fails the harness's parse
      // loudly and buys a fresh attempt on the transient budget.
      const kind = state.parts.get(partId);
      if (kind === "answer") return [{ kind: "delta", text: delta }];
      // Discarded HERE, at the boundary: the text does not travel, only the
      // fact that it existed. Dropping it downstream instead would spend the
      // answer's §4.2 content budget on text that is not the answer.
      if (kind === "reasoning") return [{ kind: "reasoning" }];
      return [];
    }

    // Consumed for the part's TYPE, never for its content — the TRAP 2
    // reasoning above is unchanged and this arm still maps to nothing. What it
    // does is register what the following deltas are allowed to become.
    case "message.part.updated": {
      const part = asRecord(p.part);
      const partId = part?.id;
      const messageId = part?.messageID;
      if (typeof partId !== "string" || typeof messageId !== "string") {
        return [];
      }
      // Assistant-owned parts only. The user's message has a text part too,
      // carrying the prompt itself, and it must never become a channel the
      // answer can be assembled from.
      if (!state.assistantMessages.has(messageId)) return [];
      if (part?.type === "text") {
        remember(state.parts, partId, "answer", MAX_TRACKED_PARTS);
      } else if (part?.type === "reasoning") {
        remember(state.parts, partId, "reasoning", MAX_TRACKED_PARTS);
      }
      return [];
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
      // Registered before the early returns below: this event is the ONLY
      // place the provider says which message is the assistant's, and the
      // part index needs that fact even on the mid-turn restatements that
      // carry neither usage nor a proof.
      if (typeof info.id === "string" && info.id.length > 0) {
        rememberId(state.assistantMessages, info.id, MAX_TRACKED_MESSAGES);
      }
      const out: OpenCodeClientEvent[] = [];

      // Usage rides the assistant message and is a SNAPSHOT: the MESSAGE's own
      // running totals, restated. Emitted even mid-turn, where they are zeros
      // — harmless, since a later restatement of the same message replaces
      // them.
      //
      // #127: what is emitted is the TURN's snapshot, not the message's. One
      // assistant message per agentic step means the attempt's REPLACE
      // semantics would keep only the last step's counters and under-report a
      // multi-step turn — in the direction that hides spend, which is the
      // worst direction to be wrong in and the axis the #116 ledger is waiting
      // on. Summing here rather than switching the attempt to `delta` mode is
      // deliberate: the mode is fixed by the FIRST usage event and a later flip
      // aborts the attempt, and a delta stream would have to reconstruct each
      // message's increment from its own restatements anyway. Snapshot of a
      // running sum keeps one mode for the whole attempt and stays correct
      // under the duplicate completed message the probe records.
      const tokens = asRecord(info.tokens);
      const messageId = typeof info.id === "string" ? info.id : undefined;
      if (messageId !== undefined) {
        const inputTokens = asNumber(tokens?.input);
        const outputTokens = asNumber(tokens?.output);
        const costUsd = asNumber(info.cost);
        if (
          inputTokens !== undefined ||
          outputTokens !== undefined ||
          costUsd !== undefined
        ) {
          rememberUsage(state, messageId, {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            ...(costUsd !== undefined ? { costUsd } : {}),
          });
          out.push({ kind: "usage", mode: "snapshot", ...turnUsage(state) });
        }
      }

      // Recorded, never emitted. A completed STEP is not a completed TURN
      // (#127); this is the content the boundary will quote when it arrives.
      const proof = terminalProofFromAssistant(info);
      if (proof !== undefined) state.lastProof = proof;
      return out;
    }

    // #127: THE turn boundary. `session.idle` fires exactly once for a whole
    // agentic turn — measured on the live provider at three assistant messages
    // to one idle — while `time.completed` fires once per STEP. Reading a step
    // completion as the turn's terminal settled the attempt on step 1,
    // harvested the model's plan narration as the answer and stopped a working
    // model; that is every "hunter finished in 10-33s with one line" symptom.
    //
    // The §5.2/§3.2 objection to `session.idle` still stands and is respected:
    // its whole payload is {sessionID}, so it supplies no proof and none is
    // synthesised from it. It supplies only the BOUNDARY, and the proof quoted
    // at that boundary is the provider's own completion record for the last
    // step that finished. A turn that reached idle having completed nothing
    // yields no terminal at all — the transport never issues its own proof,
    // and the harness watchdog remains the backstop for a turn that can never
    // produce one.
    //
    // Emitted from the mapper, not deferred to a quiet stream, so the terminal
    // travels as an ordinary mapped event: streamEvents' drain-before-failure
    // ordering is untouched and a buffered terminal still beats a failure. The
    // recorded probe puts `session.idle` last (index 25, after both copies of
    // the completed message at 21/22), so the last proof at the boundary is
    // the turn's final one. If a build ever reordered them, the poll observer
    // would quote the later message and §197 would raise a CONFLICT — loud,
    // and exactly what that slot is for.
    case "session.idle": {
      if (state.boundaryReported) return [];
      const proof = state.lastProof;
      if (proof === undefined) return [];
      state.boundaryReported = true;
      return [{ kind: "terminal", proof }];
    }

    // A busy session is the provider saying it is still working — exactly what
    // §4.2's heartbeat is for. A `retry` status is NOT a heartbeat: it is
    // backoff, and it reaches the policy through retryHintFromStatus.
    case "session.status": {
      const status = asRecord(p.status);
      return status?.type === "busy" ? [{ kind: "heartbeat" }] : [];
    }

    // TRAP 3, corrected by #127. `session.idle` used to be dropped here on the
    // grounds that its payload ({sessionID} — no id, no status, no timestamp)
    // cannot supply a proof. That grounds is still true and still honoured:
    // the `session.idle` arm above synthesises nothing and quotes the
    // provider's own completion record. What was wrong was the conclusion —
    // dropping the event entirely left `time.completed` as the only terminal
    // signal, and that is a STEP boundary, not a turn boundary.
    //
    // The predicate this file used to export for the same job (`isSessionIdle`)
    // is gone with it: it had no caller anywhere in src, and biome does not
    // flag an unused EXPORT, so it was dead code hiding behind a keyword. The
    // arm above is the caller it was waiting for.
    default:
      return [];
  }
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
    // `GET /session/status` — the POLL observer's turn boundary (#127), and a
    // different endpoint from session.messages(), which is the point: §197
    // wants two INDEPENDENT observers, not two pipes onto one fact. REQUIRED,
    // never optional, for the same reason `tool.ids` is: an optional member
    // lets a fake skip the surface silently, which is the shape of issue #121.
    status(options?: unknown): Promise<OpenCodeSdkResult<unknown>>;
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
  // `GET /mcp` — the §E readback's endpoint, and the only place a connected
  // MCP server is visible at all: it contributes nothing to `tool.ids` or
  // `tool.list` (measured, #141 fact 3). REQUIRED, never optional, for the
  // same reason as the two above — an optional member lets a fake skip the
  // surface silently, which is the shape of issue #121, and a skipped readback
  // is an unverified tool channel rather than a missing convenience.
  readonly mcp: {
    status(options?: unknown): Promise<OpenCodeSdkResult<unknown>>;
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
  // #141: the run's MCP registry travels INTO the launch. OpenCode reads it
  // from the environment at startup, so a server already running cannot be
  // given one without leaving a window between "server up" and "MCP
  // connected" for a prompt to fall into (the #128 race class).
  readonly launchServer: (
    mcp?: OpenCodeMcpConfig,
  ) => Promise<OpenCodeServerHandle>;
  readonly model: { readonly providerID: string; readonly modelID: string };
  readonly readSystemPrompt: (promptPath: string) => Promise<string>;
  // #141: reads the Claude-shaped mcp.json named by the request. Optional only
  // because a request may carry no registry at all; a request that DOES carry
  // one and finds no reader here aborts rather than running without MCP, which
  // is the silent degradation this issue is about.
  readonly readMcpConfig?: (configPath: string) => Promise<string>;
  // Absolute, resolved by the caller (transport-registry.ts). The client never
  // looks a binary up: resolution is a PATH question, and this module has no
  // business answering one — the same rule opencode-server.ts states for the
  // opencode binary itself.
  readonly codegraphBinaryPath?: string;
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
// #141: `mcp__codegraph__codegraph_explore` used to be absent from this table,
// on the grounds that it mapped onto no OpenCode built-in and that dropping it
// was parity with a codegraph-less repo. That was true of the TABLE and false
// of the ROUTE: `mcpConfigPath` was threaded all the way into createSession
// and then applied to nothing, so every OpenCode hunter ran without codegraph
// even on an indexed repo — a silent capability gap between the two backends,
// invisible in any artifact because the map recorded only ids the provider
// reported.
//
// The id is OpenCode's `<server>_<tool>` normalisation of the codegraph
// server's single tool, and it is MEASURED rather than derived (#141 fact 4):
// with this key written false the model answered REFUSED and no tool call
// appeared in the stream. Parity for the codegraph-less case is unchanged and
// now explicit — an empty registry leaves the key written FALSE rather than
// absent.
const CANONICAL_TO_OPENCODE_TOOL: Readonly<Record<string, string>> = {
  Read: "read",
  Grep: "grep",
  Glob: "glob",
  mcp__codegraph__codegraph_explore: "codegraph_codegraph_explore",
};

const MCP_TOOL_ID_SET: ReadonlySet<string> = new Set(ALL_MCP_TOOL_IDS);

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
  // #141: the MCP tool ids this session's registry actually delivers. Empty
  // when no registry was delivered — which is the common case and the parity
  // case, not an error.
  deliveredMcpToolIds: ReadonlySet<string>,
): Record<string, boolean> {
  const tools: Record<string, boolean> = {};
  for (const id of surface) tools[id] = false;
  // #141: MCP ids are legitimately ABSENT from the reported surface. Measured
  // on both endpoints, both providers, before and after connect: a connected
  // MCP server contributes nothing to `tool.ids()` or `tool.list()`, and the
  // SDK docstring promising "including built-in and dynamically registered" is
  // simply wrong about MCP. So they are seeded from pr-hero's own table — the
  // enumeration rule is unchanged, only its source differs for these ids.
  for (const id of ALL_MCP_TOOL_IDS) tools[id] = false;
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
    // An MCP id can only be allowed by a registry that actually delivered it.
    // The `id in tools` guard below cannot make this call — the id is seeded
    // above, so it is always present — and it must not be allowed to: writing
    // true for a server that was never launched would grant the model a tool
    // that does not exist and hide the gap #141 exists to close.
    if (MCP_TOOL_ID_SET.has(id)) {
      if (deliveredMcpToolIds.has(id)) tools[id] = true;
      continue;
    }
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
  // #124: partID → part kind, correlated from `message.part.updated`. #127
  // added the turn's proof and usage accumulators alongside them. Lives on the
  // session because that is the scope both are valid in, and because they must
  // be released with the session rather than with the client.
  readonly turn: OpenCodeTurnState;
  // #127, and OWNED BY THE POLL OBSERVER ALONE — never written from the
  // stream. `GET /session/status` reports a working session as busy and simply
  // OMITS one that is not working (measured against opencode 1.18.23; see
  // pollStatus), so absence is this observer's boundary. Absence is also
  // exactly what a wrong directory scope looks like, and the two are
  // indistinguishable in the response — so absence only counts once this
  // observer has proved, through its own endpoint, that it can see this
  // session at all.
  observedActive: boolean;
  ended: boolean;
  wake?: () => void;
  // The handoff can end two ways. The pump ending is an EOF and says nothing
  // about the turn; this says the turn never started, and carries the
  // provider's diagnosis to the consumer instead of leaving it to infer a
  // silence. Set only for a failure the stream itself could never report,
  // because a refused prompt creates no message and therefore no events.
  //
  // Read by BOTH observers, and that is not redundancy. streamEvents can only
  // see this while it is still being read, and the pump ends the handoff
  // asynchronously from the prompt it knows nothing about — so when the pump
  // wins that race the stream reader is already gone and pollStatus is the
  // only door left. §197 asks for two independent observers of one fact; one
  // observer plus a blind spot is not that.
  failure?: string;
}

// #141. Returns an EMPTY registry for a request that names none, which is the
// parity case rather than an error: a repo with no `.codegraph` index gets
// {"mcpServers":{}} from the driver (src/cli.ts:1263-1272) and its hunters run
// on read/grep/glob, exactly as they do on claude-code.
async function resolveMcpConfig(
  options: CreateOpenCodeClientOptions,
  input: OpenCodeCreateSessionInput,
): Promise<OpenCodeMcpConfig> {
  const configPath = input.mcpConfigPath;
  if (configPath === undefined) return {};
  const read = options.readMcpConfig;
  // Aborts rather than proceeding without MCP. Silently skipping is the whole
  // of #141: the path was threaded through three layers and applied to
  // nothing, so an indexed repo's hunters ran blind and no artifact said so.
  if (read === undefined) {
    throw new Error(
      `the request names an mcp registry (${configPath}) but this opencode ` +
        "client has no reader for it, so MCP cannot be delivered; refusing to " +
        "run a step without the tools it was configured with",
    );
  }
  return translateMcpConfig({
    json: await read(configPath),
    configPath,
    cwd: input.cwd,
    ...(options.codegraphBinaryPath === undefined
      ? {}
      : { codegraphBinaryPath: options.codegraphBinaryPath }),
  });
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
  // #141: the registry the shared server was actually launched with, as its
  // own JSON. The readback (§E) compares NAMES, and names are not the whole
  // config: two sessions on different trees would agree on "codegraph" while
  // disagreeing on the `-p <cwd>` baked into the command at spawn — which is
  // precisely the wrong-tree failure `-p` exists to prevent, and it would be
  // invisible to every other check here. Production does not hit this today
  // (one cwd per pipeline); the guard is for the day that changes.
  let launchedMcp: string | undefined;
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

      // #141: read and translated BEFORE anything is spawned, for the same
      // F005 reason as the system prompt — a registry that cannot be honoured
      // must cost nothing to unwind — and because §D needs the config in hand
      // at launch, not after it.
      const mcpConfig = await resolveMcpConfig(options, input);
      const mcpFingerprint = JSON.stringify(mcpConfig);

      if (serverPromise === undefined) {
        serverPromise = options.launchServer(mcpConfig);
        // Recorded synchronously, before the first await: a sibling call that
        // arrives mid-launch must compare against this launch, not against
        // whatever it would have asked for.
        launchedMcp = mcpFingerprint;
        try {
          server = await serverPromise;
        } catch (error) {
          // A failed launch must not poison the client forever.
          serverPromise = undefined;
          launchedMcp = undefined;
          throw error;
        }
      } else if (launchedMcp !== mcpFingerprint) {
        throw new Error(
          "the opencode server for this client was launched with a different " +
            "MCP registry; its servers are fixed at spawn, so this session " +
            "would silently ride the first one's project scope",
        );
      }
      const handle = server ?? (await serverPromise);
      const api = sdk.createOpencodeClient({ baseUrl: handle.url });

      let sessionId: string | undefined;
      establishing += 1;
      try {
        // §E, and FIRST: the OpenCode analogue of claude-code's
        // `--strict-mcp-config`, except claude-code DECLARES its isolation
        // with a flag and this reads the connected set back from the provider.
        // Verified beats declared, and the concrete threat is measured (#141
        // fact 7): `--pure` suppresses neither config-delivered nor
        // config-FILE MCP servers, so a server that ever saw the operator's
        // real HOME connects whatever ~/.config/opencode/opencode.jsonc names.
        // Production is shielded only INCIDENTALLY, by the synthetic
        // XDG_CONFIG_HOME the credential projection happens to set — and
        // nothing else here could notice the difference, since a connected MCP
        // server contributes nothing to the tool surface enumerated below.
        //
        // The `directory` scope mirrors what the request asked for, and the
        // #127 analogue was checked rather than assumed. session.status
        // reported {} for a BUSY session given a directory the server was not
        // started in, so pollStatus below omits the parameter entirely — the
        // obvious worry is that mcp.status scopes the same way and would then
        // abort every PR-mode step, since the server inherits pr-hero's cwd
        // and never the worktree.
        //
        // It does not. MEASURED against a real PR worktree, with the server's
        // cwd deliberately elsewhere: `directory` set to the worktree, to the
        // server's own cwd, to /tmp, and omitted altogether all returned the
        // same `{"codegraph":{"status":"connected"}}`. A config-delivered MCP
        // server belongs to the server process, not to a directory. The
        // mismatch arm in scripts/opencode-mcp-probe.ts runs by default and
        // re-derives this, so a provider that starts scoping it is a probe
        // failure rather than a silent PR-mode outage.
        assertMcpConnected(
          unwrap(
            await api.mcp.status({ query: { directory: input.cwd } }),
            "mcp.status",
          ),
          Object.keys(mcpConfig),
        );

        // The tool surface comes next, and inside the try on purpose. It is
        // the one thing this call must establish before anything else exists: a
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
        const tools = resolveToolMap(
          surface,
          input.tools,
          denyFloor,
          mcpToolIdsFor(mcpConfig),
        );

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
        const state: SessionState = {
          api,
          queue: [],
          turn: createTurnState(),
          observedActive: false,
          ended: false,
        };
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
            // attempt — including any failure recorded after this point, which
            // is why pollStatus reads `state.failure` too. Before it did, this
            // line was a claim the poll could not honour: it queries
            // session.messages(), and a turn that never started has none.
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
        // the pump uses. That handoff alone was NOT enough, though: the pump
        // ends it on its own schedule, so when the pump wins the race the
        // stream reader has already returned and the wake below is a no-op
        // into a state nobody reads again. Hence the second door, pollStatus,
        // which reads the same `state.failure`.
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
          //
          // The result is OBSERVED, like every other call in this file: the
          // `.catch(() => {})` that stood here could not see a refusal at all,
          // because under `ThrowOnError = false` an API-level failure RESOLVES
          // with `{ data: undefined, error }`. A refused abort leaves remote
          // work running — and billing — with no trail at all.
          //
          // The trail is APPENDED to the error that caused the unwind, never
          // thrown over it. This handler has no notes channel; the propagated
          // error is the channel, since the transport stamps it into
          // stderrTail as "session creation failed: …". And the failure that
          // caused the unwind is the one the caller must still see — masking
          // it with a teardown detail would trade a diagnosis for a symptom.
          try {
            unwrap(
              await api.session.abort({ path: { id: sessionId } }),
              "session.abort",
            );
          } catch (abortError) {
            const detail = (abortError as Error).message;
            if (error instanceof Error) {
              error.message = `${error.message} (${detail})`;
            } else {
              throw new Error(`${String(error)} (${detail})`);
            }
          }
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
          // Cleared WITH the server it describes. The fingerprint is only
          // meaningful while a launched server exists; keeping the two in step
          // is what makes "compare against the launch" a local invariant
          // rather than an ordering the next reader has to reconstruct.
          launchedMcp = undefined;
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
          yield* mapOpenCodeEvents(state.queue.shift(), session.id, state.turn);
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

      // #127: the BOUNDARY first, and from a different endpoint. This observer
      // has no event stream, so it cannot see `session.idle`; scanning
      // session.messages() for the last completed assistant message is not a
      // substitute, because at any poll instant "last completed" is step 1
      // until step 2 exists. Two observers of one wrong fact are not two
      // observers, which is precisely why the §197 cross-check could not catch
      // the defect.
      //
      // Measured against opencode 1.18.23 at $0 — a local `opencode serve`
      // plus a model-free `POST /session/{id}/shell` running `sleep 6`:
      //
      //   while the session is working        {"ses_…":{"type":"busy"}}
      //   after it stops, and when freshly created   {}
      //
      // An idle session is simply ABSENT from the map; it is never reported as
      // {"type":"idle"}. Requiring the explicit value — the reading the SDK's
      // `SessionStatus` union invites — would have left this observer
      // permanently blind and §197 down to one observer again. The explicit
      // arm is still honoured for the build that does send it.
      //
      // NO `directory` query, and that is measured too: the session is created
      // without one, so it registers under the SERVER's cwd, while prompts
      // carry the step's cwd. `GET /session/status?directory=<step cwd>`
      // returned {} for a session that was BUSY at that moment. Passing the
      // step cwd here would have made every busy session look absent — which
      // is to say, look finished — and reopened #127 through its own fix.
      const statuses = asRecord(
        unwrap(await state.api.session.status({}), "session.status"),
      );
      const statusType = asRecord(statuses?.[session.id])?.type;
      // Both are the provider still working. `retry` especially: a session in
      // backoff is neither done nor idle, and it will produce more steps — its
      // `next` timestamp is what retryHintFromStatus reads for the policy.
      if (statusType === "busy" || statusType === "retry") {
        state.observedActive = true;
      } else if (statusType === "idle" || statusType === undefined) {
        // Absence is the boundary, but it is ALSO what a session this call
        // cannot see looks like (wrong scope, unknown id, a pruned entry), and
        // the response cannot tell the two apart. So it only counts once this
        // observer has seen the provider name this session through this same
        // endpoint. An explicit idle names it, so it arms and settles at once.
        if (statusType === "idle") state.observedActive = true;
        if (state.observedActive) {
          const response = await state.api.session.messages({
            path: { id: session.id },
          });
          // Throws on the error arm rather than reporting "pending": the
          // caller treats a poll that throws as a FAILED OBSERVATION and
          // counts it (opencode-sdk.ts:707), whereas a silent "pending" would
          // let the attempt run to its stall deadline on an API error the
          // provider already explained.
          const messages = unwrap(response, "session.messages");
          const list = Array.isArray(messages) ? messages : [];
          // The turn has ended; the last completed assistant message supplies
          // the proof CONTENT — the same helper the stream uses, on purpose.
          // §197 wants two INDEPENDENT observers of ONE fact, not two facts
          // that happen to resemble each other: two copies of this derivation
          // could drift and manufacture a conflict out of nothing.
          //
          // No completed message means no proof, and none is invented. The
          // attempt then falls to the harness watchdog, which is the correct
          // place for a turn that never produced a completion record.
          for (let i = list.length - 1; i >= 0; i -= 1) {
            const info = (list[i] as { info?: unknown })?.info;
            const proof = terminalProofFromAssistant(info);
            if (proof !== undefined) return { kind: "terminal", proof };
          }
        }
      }
      // The SECOND observer of the failure, and the reason it exists: the
      // stream can only carry a failure while it is still being read, and the
      // subscription pump ends the handoff on its own schedule — completely
      // asynchronously from the fired-not-awaited prompt. Lose that race and
      // streamEvents has already returned at `if (state.ended) return`, so
      // whatever the prompt's catch writes afterwards would reach nobody, and
      // this poll would answer "pending" forever over a session that can never
      // produce a message. §197 wants two INDEPENDENT observers of ONE fact; a
      // failure only one of them can see is not two observers.
      //
      // Checked AFTER the message scan, for the same reason streamEvents
      // checks it after draining the queue: a terminal the provider ALREADY
      // sent still wins its slot.
      if (state.failure !== undefined) {
        return { kind: "failed", detail: state.failure };
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
      launchedMcp = undefined;
      if (handle !== undefined) await handle.close();
    },
  };
}
