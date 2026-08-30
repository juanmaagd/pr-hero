import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createTurnState,
  mapOpenCodeEvents,
  retryHintFromStatus,
  terminalProofFromAssistant,
} from "../../src/transports/opencode-client";
import type { OpenCodeClientEvent } from "../../src/transports/opencode-sdk";

// Recorded from a live probe (scripts/opencode-probe.ts, 2026-08-27) and
// scrubbed of machine paths. The whole point of these fixtures is that the
// mapping is tested against what the SDK REALLY emits — the declared Event
// union has 32 members and reveals none of the traps below. Findings:
// docs/research/opencode-adapter-mapping.md.
const FIXTURE_DIR = path.join(import.meta.dir, "..", "fixtures", "opencode");
const PROBE_EVENTS = JSON.parse(
  readFileSync(path.join(FIXTURE_DIR, "probe-events.json"), "utf-8"),
) as Array<Record<string, unknown>>;
const ASSISTANT = JSON.parse(
  readFileSync(path.join(FIXTURE_DIR, "assistant-message.json"), "utf-8"),
) as Record<string, unknown>;

const SESSION_ID = (
  PROBE_EVENTS.find((e) => e.type === "session.idle") as {
    properties: { sessionID: string };
  }
).properties.sessionID;

// ONE index across the whole replay, because that is how the client uses it:
// #124 made the mapper stateful, and the state is the partID -> part kind
// correlation that `message.part.delta` cannot carry itself. A per-event index
// would drop every delta, which is exactly why the parameter is required
// rather than optional.
function mapAll(sessionId = SESSION_ID): OpenCodeClientEvent[] {
  const index = createTurnState();
  return PROBE_EVENTS.flatMap((raw) =>
    mapOpenCodeEvents(raw, sessionId, index),
  );
}

// For the single-event assertions: an event mapped in isolation gets an index
// that has seen nothing else.
function mapOne(raw: unknown, sessionId = SESSION_ID): OpenCodeClientEvent[] {
  return mapOpenCodeEvents(raw, sessionId, createTurnState());
}

describe("mapOpenCodeEvent against the recorded stream", () => {
  test("text deltas come from message.part.delta, never from part.updated", () => {
    // THE trap. `message.part.updated` also fires for the USER message — the
    // recorded one carries the prompt text itself. An adapter that treated
    // every text part as a delta would echo the prompt into finalText and
    // then hand it to StepSpec.parse as if the model had written it.
    const deltas = mapAll().filter((e) => e.kind === "delta");
    expect(deltas.map((d) => (d as { text: string }).text).join("")).toBe(
      "PONG",
    );
    const userPartUpdate = PROBE_EVENTS.find(
      (e) =>
        e.type === "message.part.updated" &&
        (e.properties as { part?: { text?: string } })?.part?.text?.includes(
          "Reply with exactly",
        ),
    );
    expect(userPartUpdate).toBeDefined();
    expect(mapOne(userPartUpdate)).toEqual([]);
  });

  // #124's fix has to consume `message.part.updated` for the part TYPE, and
  // that same event fires for the USER message — whose recorded part carries
  // the prompt text itself. If the fix registered it, a delta naming that part
  // would echo the prompt into finalText: TRAP 2 walking back in through the
  // door the fix had to open. Registration is gated on the part's owning
  // message having been announced as the ASSISTANT's.
  test("the recorded user part is never a channel a delta can fill", () => {
    const index = createTurnState();
    for (const raw of PROBE_EVENTS) mapOpenCodeEvents(raw, SESSION_ID, index);

    const userPart = PROBE_EVENTS.find(
      (e) =>
        e.type === "message.part.updated" &&
        (e.properties as { part?: { text?: string } })?.part?.text?.includes(
          "Reply with exactly",
        ),
    ) as { properties: { part: { id: string; messageID: string } } };
    expect(index.parts.has(userPart.properties.part.id)).toBe(false);
    expect(
      index.assistantMessages.has(userPart.properties.part.messageID),
    ).toBe(false);

    // The behaviour that property buys, stated directly.
    expect(
      mapOpenCodeEvents(
        {
          type: "message.part.delta",
          properties: {
            sessionID: SESSION_ID,
            messageID: userPart.properties.part.messageID,
            partID: userPart.properties.part.id,
            field: "text",
            delta: "the prompt, echoed back",
          },
        },
        SESSION_ID,
        index,
      ),
    ).toEqual([]);
  });

  // The correlation index is keyed by provider-generated ids on a
  // subscription that outlives any one turn, so it needs a ceiling. Eviction
  // is oldest-first: parts are announced and streamed in order, so the oldest
  // entry is the one no delta can still name.
  test("the part index is bounded, and evicts the oldest first", () => {
    const index = createTurnState();
    mapOpenCodeEvents(
      {
        type: "message.updated",
        properties: {
          sessionID: SESSION_ID,
          info: { id: "msg_a", role: "assistant", time: { created: 1 } },
        },
      },
      SESSION_ID,
      index,
    );
    for (let i = 0; i < 5000; i += 1) {
      mapOpenCodeEvents(
        {
          type: "message.part.updated",
          properties: {
            sessionID: SESSION_ID,
            part: {
              id: `prt_${i}`,
              messageID: "msg_a",
              type: "text",
              text: "",
            },
            time: 1,
          },
        },
        SESSION_ID,
        index,
      );
    }
    expect(index.parts.size).toBeLessThanOrEqual(4096);
    expect(index.parts.has("prt_0")).toBe(false);
    expect(index.parts.has("prt_4999")).toBe(true);
  });

  // The twin bound, and a SECOND eviction implementation — the assistant-message
  // set is what gates part registration, so an unbounded one would grow for as
  // long as the subscription lives just as surely as the part map would.
  test("the assistant-message set is bounded too", () => {
    const index = createTurnState();
    for (let i = 0; i < 700; i += 1) {
      mapOpenCodeEvents(
        {
          type: "message.updated",
          properties: {
            sessionID: SESSION_ID,
            info: { id: `msg_${i}`, role: "assistant", time: { created: 1 } },
          },
        },
        SESSION_ID,
        index,
      );
    }
    expect(index.assistantMessages.size).toBeLessThanOrEqual(512);
    expect(index.assistantMessages.has("msg_0")).toBe(false);
    expect(index.assistantMessages.has("msg_699")).toBe(true);
  });

  test("events for another session are dropped, noise and all", () => {
    // event.subscribe() is GLOBAL. The recorded run produced 45 plugin.added
    // events for one prompt; none of the noise carries a sessionID, so an
    // adapter that did not filter would drown in another session's traffic.
    expect(mapAll("ses_someone_else")).toHaveLength(0);
    for (const type of [
      "plugin.added",
      "catalog.updated",
      "reference.updated",
      "integration.updated",
      "server.connected",
    ]) {
      const noise = PROBE_EVENTS.find((e) => e.type === type);
      expect(mapOne(noise)).toEqual([]);
    }
  });

  test("usage is snapshot and comes from the assistant message", () => {
    const usage = mapAll().filter((e) => e.kind === "usage");
    expect(usage.length).toBeGreaterThan(0);
    for (const event of usage) {
      expect((event as { mode: string }).mode).toBe("snapshot");
    }
    // The REAL figures, which only ever appear on the assistant message.
    const last = usage[usage.length - 1] as {
      inputTokens?: number;
      outputTokens?: number;
    };
    expect(last.inputTokens).toBe(24_012);
    expect(last.outputTokens).toBe(6);
  });

  // The bug this pins would have shipped silently. session.updated's
  // info.tokens stayed {input:0, output:0, ...} for the ENTIRE recorded run,
  // while the real figures only ever landed on the assistant message. Under
  // §4.2 snapshot semantics the counters are REPLACED, so a zero snapshot
  // arriving after a real one wipes the attempt's usage — under-reporting
  // spend, and doing it quietly.
  test("session.updated is never a usage source", () => {
    for (const raw of PROBE_EVENTS.filter(
      (e) => e.type === "session.updated",
    )) {
      expect(mapOne(raw)).toEqual([]);
    }
  });

  test("a busy status is a heartbeat", () => {
    expect(mapAll().some((e) => e.kind === "heartbeat")).toBe(true);
  });

  // #127: session.idle is the turn BOUNDARY and supplies no proof of its own.
  // Its entire payload is {sessionID}, so synthesising one from it would mean
  // the transport issuing its own proof and letting it win the §197 slot,
  // which is exactly what that slot exists to prevent. Mapped in isolation —
  // no completion record seen — it therefore yields nothing at all.
  test("session.idle on its own carries no proof and yields nothing", () => {
    const idle = PROBE_EVENTS.find((e) => e.type === "session.idle");
    expect(Object.keys((idle as { properties: object }).properties)).toEqual([
      "sessionID",
    ]);
    expect(mapOne(idle)).toEqual([]);
  });

  // #127: the completed assistant message is the PROOF, session.idle is the
  // BOUNDARY, and the terminal is the two together. `time.completed` says a
  // STEP ended — OpenCode writes one assistant message per agentic step — so
  // reading it as the turn's terminal settled the attempt on step 1.
  test("the turn's terminal quotes the last completed assistant message", () => {
    const terminals = mapAll().filter((e) => e.kind === "terminal");
    // ONE, from the whole replay. The recorded run restates the completed
    // message twice (indices 21 and 22) and reaches idle once, so a mapping
    // that emitted per completion would emit two.
    expect(terminals.length).toBe(1);
    const terminal = terminals[0];
    if (terminal?.kind !== "terminal") throw new Error("unreachable");
    expect(terminal.proof.eventId).toBe(ASSISTANT.id as string);
    expect(terminal.proof.providerStatus).toBe("completed");
  });

  // Ordering is load-bearing, not incidental: the transport SETTLES on the
  // terminal, so a terminal that reached the slot before the turn's usage was
  // banked would drop the only accurate figure the attempt ever gets. Since
  // #127 the two no longer share an event at all — usage rides every step's
  // message, the terminal rides the boundary that follows them — so the
  // ordering holds by construction. This pins that it really does.
  test("every usage event precedes the turn's terminal", () => {
    const kinds = mapAll()
      .map((e) => e.kind)
      .filter((kind) => kind === "usage" || kind === "terminal");

    expect(kinds.filter((kind) => kind === "usage").length).toBeGreaterThan(0);
    expect(kinds.lastIndexOf("usage")).toBeLessThan(kinds.indexOf("terminal"));
  });

  // The turn's usage is the SUM of its steps', and it is summed per MESSAGE
  // ID: the recorded run restates the same completed message twice, byte for
  // byte, which a per-event sum would double-count into 48,024 input tokens.
  test("a restated message does not double-count its own usage", () => {
    const usage = mapAll().filter((e) => e.kind === "usage");
    const last = usage[usage.length - 1];
    if (last?.kind !== "usage") throw new Error("unreachable");

    expect(last.inputTokens).toBe(24_012);
    expect(last.outputTokens).toBe(6);
  });
});

describe("terminalProofFromAssistant", () => {
  test("builds a provider-issued proof from the recorded message", () => {
    const proof = terminalProofFromAssistant(ASSISTANT);
    expect(proof).toBeDefined();
    expect(proof?.eventId).toBe(ASSISTANT.id as string);
    expect(proof?.providerStatus).toBe("completed");
    expect(proof?.providerObservedAt).toBe(
      new Date(1787811448694).toISOString(),
    );
  });

  test("an unfinished assistant message is not a proof", () => {
    expect(
      terminalProofFromAssistant({
        ...ASSISTANT,
        time: { created: 1 },
      }),
    ).toBeUndefined();
  });

  test("a user message is never a proof", () => {
    expect(
      terminalProofFromAssistant({ ...ASSISTANT, role: "user" }),
    ).toBeUndefined();
  });

  // pr-hero F001 on PR #82, filed BLOCKER, and it was right. providerStatus
  // is a NORMALISED field: the transport maps "completed" to success,
  // "cancelled" to cancelled, and EVERYTHING ELSE to failed
  // (opencode-sdk.ts:781-789). Passing OpenCode's raw finish reason through
  // meant every successful completion arrived as "stop" and was reported as
  // a failed transport outcome. The provider's vocabulary is translated here,
  // not leaked into a field whose meaning is fixed elsewhere.
  test("a clean stop is normalised to the vocabulary the transport reads", () => {
    expect(terminalProofFromAssistant(ASSISTANT)?.providerStatus).toBe(
      "completed",
    );
  });

  test("an aborted message is cancelled, not failed", () => {
    const proof = terminalProofFromAssistant({
      ...ASSISTANT,
      error: { name: "MessageAbortedError", data: { message: "aborted" } },
    });
    expect(proof?.providerStatus).toBe("cancelled");
  });

  test("any other error is a failure whatever finish claims", () => {
    const proof = terminalProofFromAssistant({
      ...ASSISTANT,
      finish: "stop",
      error: { name: "ProviderAuthError", data: {} },
    });
    expect(proof?.providerStatus).toBe("failed");
  });

  // §3.2: an unrecognised outcome must never silently become success. The SDK
  // declares `finish?: string` with no enumerated value space, so anything
  // outside the known set stays outside "completed" and the transport's own
  // else-branch turns it into a failure — which is the safe direction.
  test("an unknown finish is never laundered into completed", () => {
    for (const finish of [undefined, "", "length", "tool_calls", "weird"]) {
      const proof = terminalProofFromAssistant({ ...ASSISTANT, finish });
      expect(proof?.providerStatus).not.toBe("completed");
      expect(proof?.providerStatus).not.toBe("cancelled");
    }
  });
});

describe("retryHintFromStatus", () => {
  // SessionStatus has a `retry {attempt, message, next}` arm and `next` is a
  // timestamp. This is the provider-issued backoff hint decideRetryDisposition
  // has accepted as an optional retryAfterMs since D1-07 and that no transport
  // could supply — the CLI reads stdout and never sees an HTTP header.
  test("a retry status yields the milliseconds until `next`", () => {
    const now = 1_000_000;
    expect(
      retryHintFromStatus(
        { type: "retry", attempt: 1, message: "429", next: now + 4_500 },
        now,
      ),
    ).toBe(4_500);
  });

  test("a hint already in the past is not a hint", () => {
    const now = 1_000_000;
    expect(
      retryHintFromStatus({ type: "retry", attempt: 1, next: now - 1 }, now),
    ).toBeUndefined();
  });

  test("idle and busy carry no hint", () => {
    expect(retryHintFromStatus({ type: "busy" }, 0)).toBeUndefined();
    expect(retryHintFromStatus({ type: "idle" }, 0)).toBeUndefined();
  });
});
