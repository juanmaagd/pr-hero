import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { evidenceSha256 } from "../../src/execution/attempt-evidence";
import type {
  ProviderTransport,
  TransportOutcome,
  TransportRequest,
} from "../../src/execution/contracts";
import { StepExecutionHarness } from "../../src/execution/harness";
import type { StepSpec } from "../../src/step-runner";
import { attemptEvidencePath, attemptLogPath } from "../../src/step-runner";
import {
  classifyObservationEvidence,
  OpenCodeEvidenceCollector,
} from "../../src/transports/opencode-evidence";

const block = () => {
  throw new Error("NO NETWORK/SPAWN");
};

async function setup(
  change?: (r: TransportRequest) => Promise<void>,
  outcomeOverrides?: Partial<TransportOutcome>,
) {
  const dir = await mkdtemp("/tmp/producer-negative-");
  const binary = path.join(dir, "synthetic-binary");
  const mcp = path.join(dir, "mcp.json");
  const sys = path.join(dir, "system.md");
  await writeFile(binary, "ADMITTED-BINARY");
  await writeFile(mcp, '{"mcpServers":{}}');
  await writeFile(sys, "system");
  const transport: ProviderTransport = {
    backend: "claude-code",
    capabilities: async () => ({
      backend: "claude-code",
      status: "ready",
      auth: {
        kind: "claude_subscription_oauth",
        projectionReady: true,
        probe: "not_run",
      },
      isolation: {
        syntheticHome: true,
        workspaceReadBroker: true,
        codegraphPolicy: true,
      },
      protocol: {
        terminalProof: true,
        boundedEvents: true,
        usageMode: "snapshot",
      },
      cancellation: { deadlineMs: 20, conformance: "passed" },
      billing: { mode: "subscription", pricingReady: true },
      issues: [],
    }),
    execute: async (r: TransportRequest) => {
      await change?.(r);
      return {
        completion: "success",
        protocolIntegrity: "verified",
        terminalProof: {
          eventId: "actual-fixture-exit",
          providerStatus: "process_group_exited",
          providerObservedAt: new Date().toISOString(),
          exitCode: 0,
        },
        finalText: '{"findings":[]}',
        usage: {
          wallMs: 1,
          tokens: {},
          completeness: "complete",
          billingMode: "subscription",
          costSource: "provider",
          cashCostUsd: 0,
        },
        stderrTail:
          "Cookie: session=SYNTHETIC_COOKIE; csrf=SYNTHETIC_CSRF\nhttps://u:SYNTHETIC_PASSWORD@host/path",
        ...outcomeOverrides,
      };
    },
    classifyFailure: () => undefined,
  };
  const harness = new StepExecutionHarness({
    transport,
    binaryPath: binary,
    spawnFn: block as typeof Bun.spawn,
  });
  const step: StepSpec = {
    name: "hunter",
    systemPromptPath: sys,
    prompt: "review",
    tools: [],
    mcpConfigPath: mcp,
    model: "sonnet",
    cwd: dir,
    outPath: path.join(dir, "out.json"),
    timeoutMs: 50,
    maxAttempts: 1,
    parse: JSON.parse,
  };
  return { harness, step, dir, binary, mcp };
}
test("actual harness artifact redacts synthetic Cookie and URL credentials", async () => {
  const x = await setup();
  const result = await x.harness.run(x.step);
  expect(result.status).toBe("ok");
  const log = await readFile(
    attemptLogPath(x.step.outPath, "hunter", 1),
    "utf8",
  );
  console.log(
    "LOG_SECRET_LEAK",
    log.includes("SYNTHETIC_COOKIE"),
    log.includes("SYNTHETIC_CSRF"),
    log.includes("SYNTHETIC_PASSWORD"),
  );
  expect(log).not.toContain("SYNTHETIC_COOKIE");
  expect(log).not.toContain("SYNTHETIC_CSRF");
  expect(log).not.toContain("SYNTHETIC_PASSWORD");
  const e = JSON.parse(
    await readFile(attemptEvidencePath(x.step.outPath, "hunter", 1), "utf8"),
  );
  expect(e.delivered).toBe(true);
  expect(e.outcome.terminalProof.eventId).toBe("actual-fixture-exit");
});
test("actual harness proof preserves frozen inputs when execution mutates files", async () => {
  const x = await setup(async (r) => {
    await writeFile(r.isolation.verifiedBinaryPath, "AFTER-EXECUTION");
    if (!r.mcpConfigPath) throw new Error("missing fixture config");
    await writeFile(r.mcpConfigPath, '{"mcpServers":{"new":{}}}');
  });
  await x.harness.run(x.step);
  const e = JSON.parse(
    await readFile(attemptEvidencePath(x.step.outPath, "hunter", 1), "utf8"),
  );
  console.log(
    "POSTEXEC_IDENTITY",
    e.identity.executableSha256 === evidenceSha256("AFTER-EXECUTION"),
    e.identity.toolsConfigSha256 ===
      evidenceSha256(
        JSON.stringify({ tools: [], mcp: '{"mcpServers":{"new":{}}}' }),
      ),
  );
  expect(e.identity.executableSha256).toBe(evidenceSha256("ADMITTED-BINARY"));
  expect(e.identity.toolsConfigSha256).toBe(
    evidenceSha256(JSON.stringify({ tools: [], mcp: '{"mcpServers":{}}' })),
  );
});
test("actual harness bounds optional evidence write after settlement", async () => {
  const x = await setup();
  const original = Bun.write;
  Bun.write = ((...args: Parameters<typeof Bun.write>) =>
    String(args[0]).includes("evidence.hunter.attempt")
      ? new Promise<number>(() => {})
      : original(...args)) as typeof Bun.write;
  try {
    const result = await Promise.race([
      x.harness.run(x.step).then(() => "finished"),
      new Promise((r) => setTimeout(() => r("pending"), 200)),
    ]);
    console.log(
      "HANG_RESULT",
      result,
      "evidencepath",
      attemptEvidencePath(x.step.outPath, "hunter", 1),
    );
    expect(result).toBe("finished");
  } finally {
    Bun.write = original;
  }
});
test("classifier rejects non-string terminal text as inconclusive", () => {
  const c = new OpenCodeEvidenceCollector({ sessionId: "h", attempt: 1 });
  c.record("session_identity", {
    sessionId: "s",
    userMessageId: "u",
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
          parentID: "u",
          path: { cwd: "/work" },
          finish: "stop",
          time: { completed: 1 },
        },
        parts: [
          { id: "p", sessionID: "s", messageID: "a", type: "text", text: 123 },
        ],
      },
    ],
  });
  const verdict = classifyObservationEvidence(c.snapshot(), "");
  console.log("MALFORMED_TEXT_CLASSIFICATION", verdict);
  expect(verdict).toBe("inconclusive");
});
test("persistAttemptEvidence writes the OpenCode capture once overhead accounting keeps a realistic-sized snapshot under the persist cap", async () => {
  // 1700-byte deltas land ~2313 records: comfortably under the SEPARATE
  // 20000-node budget `redactEvidence` re-applies to the whole parsed blob at
  // persist time (see the sibling test below, which pins that gap), while
  // still landing (pre-fix) ~2000-2100 bytes over the byte cap every run —
  // deterministic, not the flaky few-dozen-byte margin a coarser or finer
  // delta size produces. This isolates the comma/wrapper overhead fix under
  // test here from that other, pre-existing node-budget limit.
  const collector = new OpenCodeEvidenceCollector({
    sessionId: "s",
    attempt: 1,
  });
  for (let i = 0; i < 20000; i++)
    collector.record("event", {
      type: "message.part.delta",
      properties: { delta: "x".repeat(1700) },
    });
  const diagnosticEvidence = collector.snapshot();
  const x = await setup(undefined, { diagnosticEvidence });
  await x.harness.run(x.step);
  const e = JSON.parse(
    await readFile(attemptEvidencePath(x.step.outPath, "hunter", 1), "utf8"),
  );
  console.log("CAPTURE_PERSISTED", e.capture, "DROPPED", e.captureDropped);
  expect(e.capture).toBeDefined();
  expect(e.captureDropped).toBeUndefined();
  expect(e.capture.schema).toBe("pr-hero.opencode-observations.v1");
  const captureFile = path.join(x.dir, e.capture.relativePath);
  const bytes = await readFile(captureFile);
  expect(evidenceSha256(bytes)).toBe(e.capture.sha256);
});
test("persistAttemptEvidence pins the pre-existing persist-time redaction node-budget gap instead of hiding it", async () => {
  // DISCOVERY while verifying the overhead fix above: `record()` redacts
  // each record's `data` with its OWN fresh 20000-node budget (a `redactEvidence`
  // default parameter), but `persistAttemptEvidence` re-redacts the ENTIRE
  // parsed blob in one call sharing a SINGLE 20000-node budget. A capture
  // with many small events (delta=500, ~6800 records here) fits comfortably
  // under the 4 MiB byte cap this commit fixes, but still blows the shared
  // node budget by roughly 8x, and previously that failure was swallowed by
  // the bare `catch {}` this commit also fixes.
  //
  // Raising `redactEvidence`'s budget, or redacting per-record at persist
  // time instead of once for the whole blob, would change a SECURITY
  // module's bound (`src/security/evidence-redaction.ts`) and is outside
  // this slice's authorization — that decision belongs to a human call, not
  // a writer's. This test pins the gap as an OBSERVABLE, reported drop
  // (`captureDropped.reason` names it) rather than papering over it by
  // tuning the payload to slip under both limits.
  const collector = new OpenCodeEvidenceCollector({
    sessionId: "s",
    attempt: 1,
  });
  for (let i = 0; i < 20000; i++)
    collector.record("event", {
      type: "message.part.delta",
      properties: { delta: "x".repeat(500) },
    });
  const diagnosticEvidence = collector.snapshot();
  const x = await setup(undefined, { diagnosticEvidence });
  await x.harness.run(x.step);
  const e = JSON.parse(
    await readFile(attemptEvidencePath(x.step.outPath, "hunter", 1), "utf8"),
  );
  console.log("SHAPE_LIMIT_DROPPED", e.captureDropped, "capture", e.capture);
  expect(e.capture).toBeUndefined();
  expect(e.captureDropped).toBeDefined();
  expect(e.captureDropped.reason).toMatch(/shape limit/);
});
test("persistAttemptEvidence records captureDropped with a reason and size when a capture is too large to persist", async () => {
  const oversized = "x".repeat(5 * 1024 * 1024);
  const redactedJson = JSON.stringify({
    schemaVersion: 1,
    sessionId: "s",
    attempt: 1,
    records: [{ seq: 1, observedMs: 0, kind: "event", data: oversized }],
  });
  const x = await setup(undefined, {
    diagnosticEvidence: {
      schema: "pr-hero.opencode-observations.v1",
      status: "complete",
      redactedJson,
    },
  });
  await x.harness.run(x.step);
  const e = JSON.parse(
    await readFile(attemptEvidencePath(x.step.outPath, "hunter", 1), "utf8"),
  );
  console.log(
    "OVERSIZED_CAPTURE_DROPPED",
    e.captureDropped,
    "capture",
    e.capture,
  );
  expect(e.capture).toBeUndefined();
  expect(e.captureDropped).toBeDefined();
  expect(typeof e.captureDropped.reason).toBe("string");
  expect(e.captureDropped.reason.length).toBeGreaterThan(0);
  expect(e.captureDropped.bytes).toBe(Buffer.byteLength(redactedJson));
});
test("persistAttemptEvidence records captureDropped with a reason when a capture schema is not recognized", async () => {
  const x = await setup(undefined, {
    diagnosticEvidence: {
      schema: "not-a-recognized-schema",
      status: "complete",
      redactedJson: JSON.stringify({
        schemaVersion: 1,
        sessionId: "s",
        attempt: 1,
        records: [],
      }),
    },
  });
  await x.harness.run(x.step);
  const e = JSON.parse(
    await readFile(attemptEvidencePath(x.step.outPath, "hunter", 1), "utf8"),
  );
  console.log("BAD_SCHEMA_DROPPED", e.captureDropped, "capture", e.capture);
  expect(e.capture).toBeUndefined();
  expect(e.captureDropped).toBeDefined();
  expect(typeof e.captureDropped.reason).toBe("string");
  expect(e.captureDropped.reason.length).toBeGreaterThan(0);
});
test("persistAttemptEvidence records captureDropped with a reason when a capture payload cannot be parsed", async () => {
  const x = await setup(undefined, {
    diagnosticEvidence: {
      schema: "pr-hero.opencode-observations.v1",
      status: "complete",
      redactedJson: "not valid json{",
    },
  });
  await x.harness.run(x.step);
  const e = JSON.parse(
    await readFile(attemptEvidencePath(x.step.outPath, "hunter", 1), "utf8"),
  );
  console.log(
    "MALFORMED_CAPTURE_DROPPED",
    e.captureDropped,
    "capture",
    e.capture,
  );
  expect(e.capture).toBeUndefined();
  expect(e.captureDropped).toBeDefined();
  expect(typeof e.captureDropped.reason).toBe("string");
  expect(e.captureDropped.reason.length).toBeGreaterThan(0);
});
