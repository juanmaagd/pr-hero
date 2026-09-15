import { expect, test } from "bun:test";
import {
  OpenCodeEvidenceCollector,
  redactEvidence,
} from "../../src/transports/opencode-evidence";

test("capture uses actual serialized SDK request and observed response, never stderr digits", async () => {
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
  const collector = new OpenCodeEvidenceCollector({
    sessionId: "h",
    attempt: 1,
  });
  const sdk = createOpencodeClient({
    baseUrl: "http://unused.invalid",
    fetch: collector.wrapFetch(
      async () =>
        new Response(JSON.stringify({ error: "timeout 500 ms" }), {
          status: 418,
          headers: { "content-type": "application/json" },
        }),
    ),
  });
  await sdk.session.prompt({
    sessionID: "ses-real",
    messageID: "msg-real",
    directory: "/work",
    variant: "high",
    parts: [{ type: "text", text: "hello" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const data = JSON.parse(collector.snapshot().redactedJson);
  expect(
    data.records.find(
      (r: {
        kind: string;
        data: {
          status: number;
          variant: string;
          body: { variant: string };
          url: string;
        };
      }) => r.kind === "http_response",
    ).data.status,
  ).toBe(418);
  expect(
    data.records.find(
      (r: {
        kind: string;
        data: {
          status: number;
          variant: string;
          body: { variant: string };
          url: string;
        };
      }) => r.kind === "request_body",
    ).data.body.variant,
  ).toBe("high");
  expect(
    data.records.find(
      (r: {
        kind: string;
        data: {
          status: number;
          variant: string;
          body: { variant: string };
          url: string;
        };
      }) => r.kind === "http_request",
    ).data.url,
  ).toContain("directory=%2Fwork");
});

test("capture accounts for JSON array/wrapper overhead so a full snapshot never exceeds the persist cap", () => {
  // A long real hunter fills the default 4 MiB cap with thousands of small
  // records. Each record's own JSON.stringify size was summed correctly, but
  // the array's join commas (N-1 bytes) and the `{"schemaVersion":...,
  // "records":[...]}` wrapper were never counted — only a flat 256-byte
  // reserve stood in for both. With enough records the comma overhead alone
  // dwarfs 256 bytes, so the final serialized snapshot could land past
  // `maxBytes` even though every individual record fit under it.
  const c = new OpenCodeEvidenceCollector({ sessionId: "s", attempt: 1 });
  for (let i = 0; i < 20000; i++)
    c.record("event", {
      type: "message.part.delta",
      properties: { delta: "x".repeat(500) },
    });
  const snapshot = c.snapshot();
  const bytes = Buffer.byteLength(snapshot.redactedJson);
  expect(snapshot.status).toBe("incomplete");
  expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
});

// #228: real production captures hit the 10,000-record cap at ~57.7s into a
// 242-286s attempt, so the silence window (which is what needed diagnosing)
// was never even in the capture. Stopping at the cap keeps only the OLDEST
// records; a real hunter's silence trips at the END of the attempt, so the
// part that matters most was exactly what got cut. Head+tail retention keeps
// the identity-establishing beginning (session_identity, the prompt's
// http_request/response) AND the outcome-establishing end (the last
// readback, any terminal event) — the reasoning-delta-heavy middle is what
// gets sacrificed, marked by exactly one `elided` record.
test("a long capture keeps the head and a rolling tail, eliding the middle with one marker", () => {
  const c = new OpenCodeEvidenceCollector({ sessionId: "s", attempt: 1 });
  c.record("session_identity", {
    sessionId: "s",
    userMessageId: "u",
    cwd: "/work",
  });
  const TOTAL_FILLERS = 30000;
  for (let i = 0; i < TOTAL_FILLERS; i++) {
    c.record("event", {
      type: "message.part.delta",
      properties: { delta: `filler-${i}` },
    });
  }
  c.record("event", { type: "final-marker-event", marker: "LAST" });

  const snapshot = c.snapshot();
  const bytes = Buffer.byteLength(snapshot.redactedJson);
  const parsed = JSON.parse(snapshot.redactedJson);
  const records = parsed.records as Array<{
    seq: number;
    kind: string;
    data: unknown;
  }>;

  expect(snapshot.status).toBe("incomplete");
  expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(records.length).toBeLessThanOrEqual(10000);

  // The first record recorded (session_identity) is first in the emitted sequence.
  expect(records[0].kind).toBe("session_identity");
  expect(records[0].seq).toBe(1);

  // The very last record fed in is the very last one emitted.
  const lastRecord = records[records.length - 1];
  expect(lastRecord.data).toEqual({
    type: "final-marker-event",
    marker: "LAST",
  });

  // Exactly one elided marker, with counts that reconcile against what was
  // actually fed in.
  const markers = records.filter((r) => r.kind === "elided");
  expect(markers).toHaveLength(1);
  const totalFed = 1 /* session_identity */ + TOTAL_FILLERS + 1 /* final */;
  const survivingNonMarker = records.length - 1;
  expect((markers[0].data as { records: number }).records).toBe(
    totalFed - survivingNonMarker,
  );
  expect((markers[0].data as { bytes: number }).bytes).toBeGreaterThan(0);
});

test("a small capture has no elided marker and stays complete", () => {
  const c = new OpenCodeEvidenceCollector({ sessionId: "s", attempt: 1 });
  c.record("session_identity", {
    sessionId: "s",
    userMessageId: "u",
    cwd: "/work",
  });
  c.record("event", {
    type: "message.part.delta",
    properties: { delta: "hi" },
  });
  const snapshot = c.snapshot();
  const parsed = JSON.parse(snapshot.redactedJson);
  expect(
    (parsed.records as Array<{ kind: string }>).some(
      (r) => r.kind === "elided",
    ),
  ).toBe(false);
  expect(snapshot.status).toBe("complete");
});

// #157 follow-up: the old tail-eviction loop found out a record could never
// fit by draining every real tail entry FIRST and only then throwing
// "capture limit" — and that throw landed in a catch which ALSO set the
// early-return gate every future `record()` call checked, so one oversized
// record (a multi-MB response_body at the end of an attempt is the
// realistic case) erased every tail record that had survived up to that
// point AND silenced the rest of the attempt. `closer` below deliberately
// forces the very first oversized-record encounter (before any real tail
// content exists) to make sure it does not consume the room left over for
// the real fillers that follow.
test("an oversized record is skipped without draining the tail or stopping later records", () => {
  const c = new OpenCodeEvidenceCollector({ sessionId: "s", attempt: 1 }, 2000);
  for (let i = 0; i < 5; i++) c.record("hpad", { i });
  // Too big to ever fit, encountered before any tail content exists.
  c.record("closer", { pad: "x".repeat(3000) });
  // Real tail content, recorded AFTER the first oversized encounter.
  const FILLER_COUNT = 15;
  for (let i = 0; i < FILLER_COUNT; i++) c.record("filler", { i });
  // The record too large to fit even an EMPTY tail.
  c.record("oversized", { blob: "x".repeat(8000) });
  // Recorded AFTER the oversized record.
  c.record("event", { marker: "FINAL" });

  const snapshot = c.snapshot();
  expect(snapshot.status).toBe("incomplete");
  const records = JSON.parse(snapshot.redactedJson).records as Array<{
    kind: string;
    data: unknown;
  }>;

  // The final record, recorded AFTER the oversized one, must be present —
  // the old gate would have discarded it.
  expect(
    records.some(
      (r) =>
        r.kind === "event" &&
        (r.data as { marker?: string }).marker === "FINAL",
    ),
  ).toBe(true);

  // Every real filler recorded before the oversized record must survive —
  // the old loop drained the whole tail trying (and failing) to make room
  // for it before giving up.
  const survivingFillers = records.filter((r) => r.kind === "filler");
  expect(survivingFillers).toHaveLength(FILLER_COUNT);

  // The oversized record and the earlier too-big "closer" never appear.
  expect(records.some((r) => r.kind === "oversized")).toBe(false);
  expect(records.some((r) => r.kind === "closer")).toBe(false);

  // Both skips were counted, not silently dropped.
  const marker = records.find((r) => r.kind === "elided") as
    | { data: { records: number; bytes: number } }
    | undefined;
  expect(marker).toBeDefined();
  expect(marker?.data.records).toBe(2);
});

// Same rule, the other failure surface: `body()`'s own catch (a body over
// `maxBytes`, or the 100ms read-deadline) used to set the very same
// `incomplete` flag that blocked every future `record()` call.
test("a body-read failure does not stop later records from being recorded", async () => {
  const c = new OpenCodeEvidenceCollector({ sessionId: "h", attempt: 1 }, 5000);
  const bigBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(10000)));
      controller.close();
    },
  });
  const response = new Response(bigBody, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  await c.wrapFetch(async () => response)("http://unused.invalid/thing");
  // Let the fire-and-forget body-reading IIFE run to completion (and fail).
  await new Promise((resolve) => setTimeout(resolve, 30));

  c.record("event", { marker: "AFTER_BODY_FAILURE" });

  const snapshot = c.snapshot();
  expect(snapshot.status).toBe("incomplete");
  const records = JSON.parse(snapshot.redactedJson).records as Array<{
    kind: string;
    data: unknown;
  }>;
  expect(
    records.some(
      (r) =>
        r.kind === "event" &&
        (r.data as { marker?: string }).marker === "AFTER_BODY_FAILURE",
    ),
  ).toBe(true);
});

test("capture is bounded and never invokes getters or leaks cookie/query credentials", () => {
  const c = new OpenCodeEvidenceCollector({ sessionId: "h", attempt: 1 }, 400);
  let invoked = false;
  c.record("event", {
    get secret() {
      invoked = true;
      throw new Error("bad");
    },
  });
  expect(invoked).toBe(false);
  c.record("event", { text: "x".repeat(1000) });
  expect(c.snapshot().status).toBe("incomplete");
  const result = JSON.stringify(
    redactEvidence({
      text: "Cookie: session=SYNTHETIC_A; csrf=SYNTHETIC_B\nhttp://user:password@host/?access_token=SYNTHETIC_C",
      cookie: "SYNTHETIC_D",
    }),
  );
  expect(result).not.toContain("SYNTHETIC_");
});

import { classifyObservationEvidence } from "../../src/transports/opencode-evidence";

function observed(text: string, parentID = "msg-user", toolState?: string) {
  const c = new OpenCodeEvidenceCollector({ sessionId: "h", attempt: 1 });
  c.record("session_identity", {
    sessionId: "s",
    userMessageId: "msg-user",
    cwd: "/work",
  });
  c.record("readback", {
    sessionId: "s",
    cwd: "/work",
    coverage: "complete",
    messages: [
      {
        info: {
          id: "a",
          sessionID: "s",
          role: "assistant",
          parentID,
          path: { cwd: "/work" },
          finish: "stop",
          time: { completed: 100 },
        },
        parts: [
          { id: "p", sessionID: "s", messageID: "a", type: "text", text },
          ...(toolState
            ? [
                {
                  id: "t",
                  sessionID: "s",
                  messageID: "a",
                  type: "tool",
                  state: { status: toolState },
                },
              ]
            : []),
        ],
      },
    ],
  });
  return c.snapshot();
}
test("actual owned complete readback distinguishes loss and valid empty from missing ownership/pending tools", () => {
  expect(classifyObservationEvidence(observed("answer"), "")).toBe(
    "demonstrated_reconstruction_defect",
  );
  expect(classifyObservationEvidence(observed(""), "")).toBe(
    "persisted_final_empty",
  );
  expect(classifyObservationEvidence(observed("answer", "wrong"), "")).toBe(
    "inconclusive",
  );
  expect(
    classifyObservationEvidence(observed("answer", "msg-user", "pending"), ""),
  ).toBe("inconclusive");
  expect(classifyObservationEvidence(undefined, "")).toBe("inconclusive");
});
// #228's collector refactor (internal head/tail retention instead of a
// single flat array) must not change classification for the common case: a
// small, non-elided capture (status stays "complete"). This is a pure
// regression pin — the behavior is identical to the assertion above, kept
// separate to name exactly what it protects.
test("classifyObservationEvidence still classifies a complete (non-elided) capture the same after the head/tail refactor", () => {
  expect(classifyObservationEvidence(observed("answer"), "")).toBe(
    "demonstrated_reconstruction_defect",
  );
});
test("SSE capture does not consume streaming response bodies or wait on an endless body", async () => {
  const c = new OpenCodeEvidenceCollector({ sessionId: "h", attempt: 1 });
  const response = new Response(new ReadableStream({ start() {} }), {
    headers: { "content-type": "text/event-stream" },
  });
  const result = await c.wrapFetch(async () => response)(
    "http://unused.invalid/event",
  );
  expect(result).toBe(response);
  expect(response.bodyUsed).toBe(false);
  expect(c.snapshot().status).toBe("complete");
});

// PR #228 review, F001: the oversized-record pre-check in `record()` used to
// run `fits()` BEFORE `elidedCount` was incremented — so on the very
// first-ever skip, the check ran with no marker at all, and nothing ever
// re-validated the already-accepted head+tail against the marker that skip
// itself creates. Once a marker exists, later skips can also grow its
// `records`/`bytes` digit width without anything re-checking the total
// either. With a tail already packed close to `maxBytes`, either path could
// push `snapshot().redactedJson` past the cap.
function withinCap(
  collector: OpenCodeEvidenceCollector,
  maxBytes: number,
): boolean {
  return (
    Buffer.byteLength(collector.snapshot().redactedJson, "utf8") <= maxBytes
  );
}

test("a tail packed near the cap plus one oversized record still fits maxBytes (F001)", () => {
  const maxBytes = 2000;
  const c = new OpenCodeEvidenceCollector(
    { sessionId: "s", attempt: 1 },
    maxBytes,
  );
  for (let i = 0; i < 200; i++) c.record("filler", { i });
  c.record("oversized", { blob: "x".repeat(20000) });
  expect(withinCap(c, maxBytes)).toBe(true);
});

test("repeated oversized skips growing the marker's digit width still fit maxBytes (F001)", () => {
  const maxBytes = 2000;
  const c = new OpenCodeEvidenceCollector(
    { sessionId: "s", attempt: 1 },
    maxBytes,
  );
  for (let i = 0; i < 200; i++) c.record("filler", { i });
  for (let i = 0; i < 15; i++) {
    c.record(`oversized${i}`, { blob: "x".repeat(20000 + i) });
  }
  expect(withinCap(c, maxBytes)).toBe(true);
});

test("a mixed sequence of small, large and oversized records never exceeds maxBytes at any prefix (F001)", () => {
  const maxBytes = 2000;
  const ops: Array<{ kind: string; data: unknown }> = [];
  for (let i = 0; i < 200; i++) ops.push({ kind: "small", data: { i } });
  for (let i = 0; i < 10; i++) {
    ops.push({ kind: "oversized", data: { i, blob: "w".repeat(20000 + i) } });
    for (let j = 0; j < 3; j++) ops.push({ kind: "small", data: { i, j } });
  }
  for (let prefix = 1; prefix <= ops.length; prefix++) {
    const c = new OpenCodeEvidenceCollector(
      { sessionId: "s", attempt: 1 },
      maxBytes,
    );
    for (const op of ops.slice(0, prefix)) c.record(op.kind, op.data);
    expect(withinCap(c, maxBytes)).toBe(true);
  }
});
