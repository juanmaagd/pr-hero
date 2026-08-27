import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
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

function mapAll(sessionId = SESSION_ID): OpenCodeClientEvent[] {
  return PROBE_EVENTS.flatMap((raw) => mapOpenCodeEvents(raw, sessionId));
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
    expect(mapOpenCodeEvents(userPartUpdate as object, SESSION_ID)).toEqual([]);
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
      expect(mapOpenCodeEvents(noise as object, SESSION_ID)).toEqual([]);
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
      expect(mapOpenCodeEvents(raw, SESSION_ID)).toEqual([]);
    }
  });

  test("a busy status is a heartbeat", () => {
    expect(mapAll().some((e) => e.kind === "heartbeat")).toBe(true);
  });

  test("session.idle is NOT a terminal — it carries no proof to be one", () => {
    // Its entire payload is {sessionID}. Synthesising a proof from it would
    // mean the transport issuing its own proof and letting it win the §197
    // slot, which is exactly what that slot exists to prevent.
    const idle = PROBE_EVENTS.find((e) => e.type === "session.idle");
    expect(Object.keys((idle as { properties: object }).properties)).toEqual([
      "sessionID",
    ]);
    expect(mapOpenCodeEvents(idle as object, SESSION_ID)).toEqual([]);
  });

  test("the assistant's completed message IS the terminal", () => {
    const terminals = mapAll().filter((e) => e.kind === "terminal");
    // The recorded run restated the completed message twice. That is fine and
    // must stay fine: §197's compare-and-set accepts an identical repeat and
    // only conflicts on a DIFFERENT proof, so the mapping does not dedupe.
    expect(terminals.length).toBeGreaterThanOrEqual(1);
    for (const terminal of terminals) {
      if (terminal.kind !== "terminal") throw new Error("unreachable");
      expect(terminal.proof.eventId).toBe(ASSISTANT.id as string);
      expect(terminal.proof.providerStatus).toBe("stop");
    }
  });

  // Ordering is load-bearing, not incidental: the completed assistant message
  // carries BOTH the real usage and the terminal proof, and the transport
  // settles on the terminal. Emitting the terminal first would drop the only
  // accurate usage figure the attempt ever gets.
  test("usage is emitted before the terminal it shares an event with", () => {
    const completed = PROBE_EVENTS.filter(
      (e) =>
        e.type === "message.updated" &&
        (e.properties as { info?: { time?: { completed?: number } } })?.info
          ?.time?.completed !== undefined,
    );
    expect(completed.length).toBeGreaterThan(0);
    for (const raw of completed) {
      const mapped = mapOpenCodeEvents(raw, SESSION_ID);
      expect(mapped.map((e) => e.kind)).toEqual(["usage", "terminal"]);
    }
  });
});

describe("terminalProofFromAssistant", () => {
  test("builds a provider-issued proof from the recorded message", () => {
    const proof = terminalProofFromAssistant(ASSISTANT);
    expect(proof).toBeDefined();
    expect(proof?.eventId).toBe(ASSISTANT.id as string);
    expect(proof?.providerStatus).toBe("stop");
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

  // §3.2: an unrecognised finish must not silently become success. The SDK
  // declares `finish?: string` with no enumerated value space, so the proof
  // reports what the provider said and lets the transport's own status
  // mapping decide — but a message with an ERROR is never a clean stop.
  test("an errored message reports the error, not the finish", () => {
    const proof = terminalProofFromAssistant({
      ...ASSISTANT,
      finish: "stop",
      error: { name: "ProviderAuthError", data: {} },
    });
    expect(proof?.providerStatus).toBe("error");
  });

  test("a missing finish is reported as unknown, never as completed", () => {
    const { finish: _dropped, ...withoutFinish } = ASSISTANT;
    const proof = terminalProofFromAssistant(withoutFinish);
    expect(proof?.providerStatus).toBe("unknown");
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
