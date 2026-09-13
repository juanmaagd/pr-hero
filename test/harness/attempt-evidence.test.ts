import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { evidenceSha256 } from "../../src/execution/attempt-evidence";
import type {
  ProviderTransport,
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

async function setup(change?: (r: TransportRequest) => Promise<void>) {
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
