import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  IsolationProjection,
  ProviderCapabilityReport,
  ProviderTransport,
  ResolvedModelRoute,
  TransportOutcome,
  TransportRequest,
} from "../src/execution/contracts";
import { StepExecutionHarness } from "../src/execution/harness";
import { InMemorySpendLedger } from "../src/execution/spend-limiter";
import {
  createResolvedRoutePlan,
  type RoutingConfig,
  resolveStepRoute,
} from "../src/model-routing";
import { createProductionRuntime } from "../src/production-runtime";
import type { ExecutableAllowlistEntry } from "../src/provider-capabilities";
import { OpenCodeAuthBroker } from "../src/security/credential-broker";
import type { StepSpec } from "../src/step-runner";
import type {
  D1_11ReadinessEvidence,
  TransportFactoryOptions,
} from "../src/transport-registry";
import {
  DefaultTransportRegistry,
  type TransportRegistry,
} from "../src/transport-registry";
import type { OpenCodeSdkLike } from "../src/transports/opencode-client";
import { createOpenCodeClient } from "../src/transports/opencode-client";

const MACHO_PREFIX = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

const ISOLATION_STUB: IsolationProjection = {
  credentialProjectionId: "test-projection",
  env: {},
  syntheticHome: "/tmp/home",
  syntheticConfigHome: "/tmp/config",
  syntheticTmp: "/tmp/tmp",
  verifiedBinaryPath: "/usr/bin/opencode",
};

const COMPLETE_EVIDENCE: D1_11ReadinessEvidence = {
  sdkAvailable: true,
  credentialAuthority: true,
  workspaceBroker: true,
  pricingReady: true,
};

async function writeClaudeFixture(
  dir: string,
): Promise<{ canonicalPath: string; sha256: string }> {
  const claudePath = path.join(dir, "claude");
  const bytes = Buffer.concat([
    MACHO_PREFIX,
    Buffer.from('#!/bin/sh\necho \'{"result":"ok"}\'\n'),
  ]);
  await writeFile(claudePath, bytes);
  await chmod(claudePath, 0o755);
  const canonicalPath = await realpath(claudePath);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return { canonicalPath, sha256: hasher.digest("hex") };
}

async function writeOpenCodeFixture(
  dir: string,
): Promise<{ canonicalPath: string; sha256: string }> {
  const opencodePath = path.join(dir, "opencode");
  const bytes = Buffer.concat([MACHO_PREFIX, Buffer.from("opencode")]);
  await writeFile(opencodePath, bytes);
  await chmod(opencodePath, 0o755);
  const canonicalPath = await realpath(opencodePath);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return { canonicalPath, sha256: hasher.digest("hex") };
}

function mixedAllowlists(
  claude: { canonicalPath: string; sha256: string },
  opencode: { canonicalPath: string; sha256: string },
): Partial<
  Record<"claude-code" | "opencode", readonly ExecutableAllowlistEntry[]>
> {
  return {
    "claude-code": [
      { absolutePath: claude.canonicalPath, sha256: claude.sha256 },
    ],
    opencode: [
      { absolutePath: opencode.canonicalPath, sha256: opencode.sha256 },
    ],
  };
}

function createRecordingTransport(
  requests: TransportRequest[],
  backend: "claude-code" | "opencode" = "claude-code",
): ProviderTransport {
  return {
    backend,
    capabilities: async (): Promise<ProviderCapabilityReport> => ({
      backend,
      status: "ready",
      auth: {
        kind:
          backend === "claude-code"
            ? "claude_subscription_oauth"
            : "opencode_chatgpt_oauth",
        projectionReady: true,
        probe: "passed",
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
      cancellation: { deadlineMs: 5000, conformance: "passed" },
      billing: { mode: "subscription", pricingReady: true },
      issues: [],
    }),
    execute: async (request: TransportRequest): Promise<TransportOutcome> => {
      requests.push(request);
      return {
        completion: "success",
        protocolIntegrity: "verified",
        finalText: '{"findings":[]}',
        usage: {
          wallMs: 10,
          tokens: { totalKnown: 1 },
          completeness: "complete",
          billingMode: "subscription",
          costSource: "provider",
          cashCostUsd: 0,
        },
        stderrTail: "",
      };
    },
    classifyFailure: () => undefined,
  };
}

function makeStep(tmpDir: string, overrides: Partial<StepSpec> = {}): StepSpec {
  return {
    name: "hunter-reliability",
    systemPromptPath: path.join(tmpDir, "system.md"),
    prompt: "review",
    tools: ["Read", "Grep", "Glob", "mcp__codegraph__codegraph_explore"],
    mcpConfigPath: path.join(tmpDir, "mcp.json"),
    model: "sonnet",
    cwd: tmpDir,
    outPath: path.join(tmpDir, "out.json"),
    timeoutMs: 5000,
    maxAttempts: 1,
    parse: (text: string) => JSON.parse(text),
    ...overrides,
  };
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function openCodeRoutingConfig(): RoutingConfig {
  return {
    mappings: {
      "openai/gpt-4o": {
        backend: "opencode",
        provider: "openai",
        modelFamily: "gpt-4o",
        modelSnapshot: "gpt-4o",
        modelVariant: "high",
      },
      "anthropic/claude-3-5-sonnet": {
        backend: "opencode",
        provider: "anthropic",
        modelFamily: "claude-3-5-sonnet",
        modelSnapshot: "claude-3-5-sonnet-20241022",
        modelVariant: "default",
      },
    },
  };
}

describe("Task 2.1 RED: production transport lifecycle", () => {
  let tmpDir: string;
  let claudeFixture: { canonicalPath: string; sha256: string };
  let opencodeFixture: { canonicalPath: string; sha256: string };

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-prod-tl-"));
    tmpDir = await realpath(tmpDir);
    claudeFixture = await writeClaudeFixture(tmpDir);
    opencodeFixture = await writeOpenCodeFixture(tmpDir);
    await writeFile(path.join(tmpDir, "system.md"), "system");
    await writeFile(
      path.join(tmpDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          codegraph: { command: "codegraph", args: ["mcp"] },
        },
      }),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("route-keyed transport cache", () => {
    test("DefaultTransportRegistry caches transports per routeFingerprint not per backend", () => {
      const registry = new DefaultTransportRegistry();
      registry.register("opencode", () => {
        return createRecordingTransport([], "opencode");
      });

      const routeA: ResolvedModelRoute = {
        backend: "opencode",
        provider: "openai",
        modelFamily: "gpt-4o",
        modelSnapshot: "gpt-4o",
        modelVariant: "high",
      };
      const routeB: ResolvedModelRoute = {
        backend: "opencode",
        provider: "anthropic",
        modelFamily: "claude-3-5-sonnet",
        modelSnapshot: "claude-3-5-sonnet-20241022",
      };

      const optionsA: TransportFactoryOptions = {
        routeFingerprint: "fp-route-a",
        route: routeA,
      };
      const optionsB: TransportFactoryOptions = {
        routeFingerprint: "fp-route-b",
        route: routeB,
      };

      const firstA = registry.get("opencode", optionsA);
      const secondA = registry.get("opencode", optionsA);
      const firstB = registry.get("opencode", optionsB);

      expect(firstA).toBe(secondA);
      expect(firstB).not.toBe(firstA);
    });

    test("variant routes do not share one backend-cached opencode transport instance", async () => {
      const registry = new DefaultTransportRegistry();
      registry.register("opencode", () =>
        createRecordingTransport([], "opencode"),
      );

      const routingConfig = openCodeRoutingConfig();
      const stepA = resolveStepRoute({
        stepKey: "refuter-a",
        role: "refuter",
        cliModel: "openai/gpt-4o",
        routingConfig,
      });
      const stepB = resolveStepRoute({
        stepKey: "refuter-b",
        role: "refuter",
        cliModel: "anthropic/claude-3-5-sonnet",
        routingConfig,
      });
      const plan = createResolvedRoutePlan([stepA, stepB]);

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        openCodeBinaryPath: opencodeFixture.canonicalPath,
        executableAllowlists: mixedAllowlists(claudeFixture, opencodeFixture),
        registry,
        mode: "conformance",
        evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
        credentialBrokers: {
          opencode: new OpenCodeAuthBroker({
            readerFn: async () =>
              JSON.stringify({
                openai: { type: "oauth", access: "test", refresh: "test" },
              }),
          }),
        },
        authorityDeps: {
          existsFn: (p) =>
            p === claudeFixture.canonicalPath ||
            p === opencodeFixture.canonicalPath ||
            p.startsWith(tmpDir),
          realpathFn: async (p) => p,
        },
      });

      const bindingA = runtime.bindings.get(stepA.routeFingerprint);
      const bindingB = runtime.bindings.get(stepB.routeFingerprint);
      expect(bindingA).toBeDefined();
      expect(bindingB).toBeDefined();
      if (bindingA === undefined || bindingB === undefined) return;

      const leaseA = await bindingA.acquire(ISOLATION_STUB, registry);
      const leaseB = await bindingB.acquire(ISOLATION_STUB, registry);

      expect(leaseA.transport).not.toBe(leaseB.transport);
      await leaseA.dispose();
      await leaseB.dispose();
    });
  });

  describe("binding lease lifecycle", () => {
    test("binding.acquire dispose releases the route-scoped lease so the next acquire is fresh", async () => {
      const disposeLog: string[] = [];
      let factoryCalls = 0;

      const registry: TransportRegistry = {
        register() {},
        has: () => true,
        get(_backend, options?: TransportFactoryOptions) {
          factoryCalls += 1;
          const key =
            typeof options?.routeFingerprint === "string"
              ? options.routeFingerprint
              : "backend-only";
          return {
            backend: "opencode" as const,
            capabilities: async () =>
              createRecordingTransport([], "opencode").capabilities(),
            execute: async () => ({
              completion: "success" as const,
              protocolIntegrity: "verified" as const,
              finalText: "{}",
              usage: {
                wallMs: 1,
                tokens: {},
                completeness: "complete" as const,
                billingMode: "subscription" as const,
                costSource: "provider" as const,
                cashCostUsd: 0,
              },
              stderrTail: "",
            }),
            classifyFailure: () => undefined,
            __leaseKey: key,
          } as ProviderTransport & { __leaseKey: string };
        },
        getCapabilityReport: async () =>
          createRecordingTransport([], "opencode").capabilities(),
        getAllCapabilityReports: async () => new Map(),
        release(routeFingerprint: string) {
          disposeLog.push(routeFingerprint);
        },
      } as TransportRegistry & {
        release(routeFingerprint: string): void;
      };

      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "openai/gpt-4o",
        routingConfig: openCodeRoutingConfig(),
      });
      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan: createResolvedRoutePlan([step]),
        binaryPath: claudeFixture.canonicalPath,
        openCodeBinaryPath: opencodeFixture.canonicalPath,
        executableAllowlists: mixedAllowlists(claudeFixture, opencodeFixture),
        registry,
        mode: "conformance",
        evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
        credentialBrokers: {
          opencode: new OpenCodeAuthBroker({
            readerFn: async () =>
              JSON.stringify({
                openai: { type: "oauth", access: "test", refresh: "test" },
              }),
          }),
        },
        authorityDeps: {
          existsFn: (p) =>
            p === claudeFixture.canonicalPath ||
            p === opencodeFixture.canonicalPath ||
            p.startsWith(tmpDir),
          realpathFn: async (p) => p,
        },
      });

      const binding = runtime.bindings.get(step.routeFingerprint);
      expect(binding).toBeDefined();
      if (binding === undefined) return;

      const lease1 = await binding.acquire(ISOLATION_STUB, registry);
      await lease1.dispose();
      const lease2 = await binding.acquire(ISOLATION_STUB, registry);

      expect(disposeLog).toEqual([step.routeFingerprint]);
      expect(lease2.transport).not.toBe(lease1.transport);
      expect(factoryCalls).toBe(2);
    });
  });

  describe("exact OpenCode provider/model/variant requests", () => {
    test("built-in opencode factory must pass route provider/model into createOpenCodeClient", async () => {
      const promptModels: Array<{
        providerID: string;
        modelID: string;
      }> = [];
      const route: ResolvedModelRoute = {
        backend: "opencode",
        provider: "anthropic",
        modelFamily: "claude-3-5-sonnet",
        modelSnapshot: "claude-3-5-sonnet-20241022",
        modelVariant: "thinking",
      };

      const loadSdk = async (): Promise<OpenCodeSdkLike> => ({
        createClient: () => ({
          session: {
            create: async () => ({ data: { id: "oc-sess-1" } }),
            prompt: async (options: {
              body: { model: { providerID: string; modelID: string } };
            }) => {
              promptModels.push(options.body.model);
              return { data: {} };
            },
            messages: async () => ({ data: {} }),
            abort: async () => ({ data: {} }),
          },
          event: {
            subscribe: async () => ({
              stream: (async function* () {
                yield undefined;
              })(),
            }),
          },
        }),
      });

      const client = createOpenCodeClient({
        model: { providerID: route.provider, modelID: route.modelSnapshot },
        loadSdk,
        readSystemPrompt: async () => "system prompt",
        launchServer: async () => ({
          url: "http://127.0.0.1:4096",
          pid: 4242,
          close: async () => {},
        }),
      });

      await client.createSession({
        cwd: tmpDir,
        userPrompt: "review",
        systemPromptPath: path.join(tmpDir, "system.md"),
        tools: ["Read"],
      });

      expect(promptModels).toEqual([
        {
          providerID: route.provider,
          modelID: route.modelSnapshot,
        },
      ]);
    });
  });

  describe("binding tool and MCP admission", () => {
    async function createClaudeRuntime(requests: TransportRequest[]) {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const registry = new DefaultTransportRegistry();
      registry.register(
        "claude-code",
        createRecordingTransport(requests, "claude-code"),
      );
      return {
        step,
        runtime: await createProductionRuntime({
          workspaceRoot: tmpDir,
          plan: createResolvedRoutePlan([step]),
          binaryPath: claudeFixture.canonicalPath,
          executableAllowlists: {
            "claude-code": [
              {
                absolutePath: claudeFixture.canonicalPath,
                sha256: claudeFixture.sha256,
              },
            ],
          },
          registry,
          mode: "conformance",
        }),
      };
    }

    test("denies bash before transport execute with zero attempts", async () => {
      const requests: TransportRequest[] = [];
      const { step, runtime } = await createClaudeRuntime(requests);

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          tools: ["Read", "bash"],
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.stderrTail).toMatch(/bash|allow.?map|tool/i);
    });

    test("denies Write/Edit/Task before transport execute", async () => {
      for (const denied of ["Write", "Edit", "Task"] as const) {
        const requests: TransportRequest[] = [];
        const { step, runtime } = await createClaudeRuntime(requests);

        const result = await runtime.runner.run(
          makeStep(tmpDir, {
            tools: ["Read", denied],
            routeKey: step.routeFingerprint,
            route: step.route,
          }),
        );

        expect(result.status).toBe("failed");
        expect(result.attempts).toBe(0);
        expect(requests).toHaveLength(0);
        expect(result.stderrTail).toMatch(
          new RegExp(`${denied}|allow.?map|tool`, "i"),
        );
      }
    });

    test("denies unknown tools outside the allow map before transport execute", async () => {
      const requests: TransportRequest[] = [];
      const { step, runtime } = await createClaudeRuntime(requests);

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          tools: ["Read", "WebSearch"],
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.stderrTail).toMatch(/WebSearch|allow.?map|tool/i);
    });

    test("denies non-codegraph MCP tool prefixes before transport execute", async () => {
      const requests: TransportRequest[] = [];
      const { step, runtime } = await createClaudeRuntime(requests);

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          tools: ["Read", "mcp__playwright__browser_navigate"],
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.stderrTail).toMatch(/codegraph|mcp/i);
    });

    test("denies mcp.json that registers a non-codegraph server", async () => {
      const requests: TransportRequest[] = [];
      const { step, runtime } = await createClaudeRuntime(requests);
      const badMcpPath = path.join(tmpDir, "bad-mcp.json");
      await writeFile(
        badMcpPath,
        JSON.stringify({
          mcpServers: {
            playwright: { command: "npx", args: ["playwright", "mcp"] },
          },
        }),
      );

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          mcpConfigPath: badMcpPath,
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.stderrTail).toMatch(/codegraph|mcp/i);
    });

    test("denies symlinked mcp.json before transport execute", async () => {
      const requests: TransportRequest[] = [];
      const { step, runtime } = await createClaudeRuntime(requests);
      const outsideDir = await mkdtemp(path.join(tmpdir(), "pr-hero-mcp-out-"));
      const outsideMcp = path.join(outsideDir, "outside-mcp.json");
      await writeFile(
        outsideMcp,
        JSON.stringify({
          mcpServers: {
            codegraph: { command: "codegraph", args: ["mcp"] },
          },
        }),
      );
      const linkPath = path.join(tmpDir, "linked-mcp.json");
      await symlink(outsideMcp, linkPath);

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          mcpConfigPath: linkPath,
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.stderrTail).toMatch(/symlink|mcp/i);

      await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
    });

    test("denies mcp.json content hash mismatch before transport execute", async () => {
      const requests: TransportRequest[] = [];
      const { step, runtime } = await createClaudeRuntime(requests);
      const mcpPath = path.join(tmpDir, "pinned-mcp.json");
      const content = JSON.stringify({
        mcpServers: {
          codegraph: { command: "codegraph", args: ["mcp"] },
        },
      });
      await writeFile(mcpPath, content);

      const result = await runtime.runner.run({
        ...makeStep(tmpDir, {
          mcpConfigPath: mcpPath,
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
        mcpConfigSha256: sha256Hex("stale-content"),
      } as StepSpec & { mcpConfigSha256: string });

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.stderrTail).toMatch(/hash|mcp/i);
    });
  });

  describe("pre-confirm authority gates", () => {
    test("missing SDK blocks opencode step before transport execute and spend reservation", async () => {
      const requests: TransportRequest[] = [];
      const ledger = new InMemorySpendLedger();
      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "openai/gpt-4o",
        routingConfig: openCodeRoutingConfig(),
      });

      const registry = new DefaultTransportRegistry({
        mode: "conformance",
        evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
        binaryPath: opencodeFixture.canonicalPath,
        readSystemPrompt: async () => "system",
        launchServer: async () => ({
          url: "http://127.0.0.1:4096",
          pid: 1,
          close: async () => {},
        }),
        loadSdk: async () => {
          throw new Error("Cannot find module '@opencode-ai/sdk'");
        },
      });

      const harness = new StepExecutionHarness({
        workspaceRoot: tmpDir,
        registry,
        executableAllowlist: [
          {
            absolutePath: opencodeFixture.canonicalPath,
            sha256: opencodeFixture.sha256,
          },
        ],
        binaryPath: opencodeFixture.canonicalPath,
        spendLedger: ledger,
        reservedUsdPerAttempt: 0.01,
        spawnFn: (() => ({})) as unknown as typeof Bun.spawn,
      });

      const result = await harness.run(
        makeStep(tmpDir, {
          model: "openai/gpt-4o",
          route: step.route,
          routeKey: step.routeFingerprint,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.reservations ?? []).toHaveLength(0);
      expect(result.stderrTail).toMatch(/sdk|@opencode-ai/i);
    });

    test("unverified opencode binary blocks before transport execute and spend reservation", async () => {
      const requests: TransportRequest[] = [];
      const ledger = new InMemorySpendLedger();
      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "openai/gpt-4o",
        routingConfig: openCodeRoutingConfig(),
      });

      const registry = new DefaultTransportRegistry();
      registry.register(
        "opencode",
        createRecordingTransport(requests, "opencode"),
      );

      const harness = new StepExecutionHarness({
        workspaceRoot: tmpDir,
        registry,
        executableAllowlist: [
          {
            absolutePath: opencodeFixture.canonicalPath,
            sha256: "0".repeat(64),
          },
        ],
        binaryPath: opencodeFixture.canonicalPath,
        spendLedger: ledger,
        reservedUsdPerAttempt: 0.01,
        spawnFn: (() => ({})) as unknown as typeof Bun.spawn,
      });

      const result = await harness.run(
        makeStep(tmpDir, {
          model: "openai/gpt-4o",
          route: step.route,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.reservations ?? []).toHaveLength(0);
      expect(result.denialCode).toBe("executable_not_approved");
    });
  });

  describe("binding drift and harness-owned opencode timeout", () => {
    test("route drift under a frozen routeKey forces re-probe before transport execute", async () => {
      const requests: TransportRequest[] = [];
      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "openai/gpt-4o",
        routingConfig: openCodeRoutingConfig(),
      });
      const registry = new DefaultTransportRegistry();
      registry.register(
        "opencode",
        createRecordingTransport(requests, "opencode"),
      );

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan: createResolvedRoutePlan([step]),
        binaryPath: claudeFixture.canonicalPath,
        openCodeBinaryPath: opencodeFixture.canonicalPath,
        executableAllowlists: mixedAllowlists(claudeFixture, opencodeFixture),
        registry,
        mode: "conformance",
        evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
        credentialBrokers: {
          opencode: new OpenCodeAuthBroker({
            readerFn: async () =>
              JSON.stringify({
                openai: { type: "oauth", access: "test", refresh: "test" },
              }),
          }),
        },
        authorityDeps: {
          existsFn: (p) =>
            p === claudeFixture.canonicalPath ||
            p === opencodeFixture.canonicalPath ||
            p.startsWith(tmpDir),
          realpathFn: async (p) => p,
        },
      });

      const driftedRoute: ResolvedModelRoute = {
        ...step.route,
        modelVariant: "drifted-variant",
      };

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          model: "openai/gpt-4o",
          routeKey: step.routeFingerprint,
          route: driftedRoute,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);
      expect(result.stderrTail).toMatch(/drift|re-probe|fingerprint/i);
    });

    test("harness enforces opencode step timeout without passing timeoutMs to transport", async () => {
      const captured: TransportRequest[] = [];
      const hangingTransport: ProviderTransport = {
        backend: "opencode",
        capabilities: async () =>
          createRecordingTransport([], "opencode").capabilities(),
        execute: async (request) => {
          captured.push(request);
          await new Promise<never>(() => {});
          return {
            completion: "success",
            protocolIntegrity: "verified",
            finalText: "{}",
            usage: {
              wallMs: 0,
              tokens: {},
              completeness: "complete",
              billingMode: "subscription",
              costSource: "provider",
              cashCostUsd: 0,
            },
            stderrTail: "",
          };
        },
        classifyFailure: () => undefined,
      };

      const registry = new DefaultTransportRegistry();
      registry.register("opencode", hangingTransport);

      const harness = new StepExecutionHarness({
        registry,
        spawnFn: (() => ({})) as unknown as typeof Bun.spawn,
      });

      const runPromise = harness.run(
        makeStep(tmpDir, {
          timeoutMs: 40,
          route: {
            backend: "opencode",
            provider: "openai",
            modelFamily: "gpt-4o",
            modelSnapshot: "gpt-4o",
          },
        }),
      );

      const result = await Promise.race([
        runPromise,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("harness did not enforce step timeout")),
            500,
          );
        }),
      ]);

      expect(result.status).toBe("failed");
      expect(captured).toHaveLength(1);
      expect(captured[0]?.timeoutMs).toBeUndefined();
      expect(result.stderrTail).toMatch(/timeout|timed out/i);
    });
  });
});
