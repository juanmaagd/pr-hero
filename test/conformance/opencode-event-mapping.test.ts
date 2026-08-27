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
      expect(terminal.proof.providerStatus).toBe("completed");
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
