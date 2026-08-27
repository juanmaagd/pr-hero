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
import type { OpenCodeClientEvent } from "./opencode-sdk";

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

  // §3.2: an unrecognised finish must never silently become success. The SDK
  // declares `finish?: string` with no enumerated value space, so the proof
  // reports what the provider said and the transport's own status mapping
  // decides — but an errored message is not a clean stop whatever `finish`
  // claims, and a missing finish is unknown, never completed.
  const errored = message.error !== undefined && message.error !== null;
  const finish = message.finish;
  const providerStatus = errored
    ? "error"
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
