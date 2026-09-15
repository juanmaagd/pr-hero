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
  console.log("CAPTURE_TOTAL_BYTES", bytes, "PERSIST_CAP", 4 * 1024 * 1024);
  expect(snapshot.status).toBe("incomplete");
  expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
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
