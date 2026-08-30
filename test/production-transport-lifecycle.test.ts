import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConcurrencyAttemptAdmissionGate } from "../src/execution/admission";
import { ConcurrencyLimiter } from "../src/execution/concurrency-limiter";
import type {
  IsolationProjection,
  ProviderCapabilityReport,
  ProviderTerminalProof,
  ProviderTransport,
  ResolvedModelRoute,
  RunnerBackend,
  TransportOutcome,
  TransportRequest,
} from "../src/execution/contracts";
import { StepExecutionHarness } from "../src/execution/harness";
import type { SettlementReceipt } from "../src/execution/settlement";
import { InMemorySpendLedger } from "../src/execution/spend-limiter";
import {
  createResolvedRoutePlan,
  type RoutingConfig,
  resolveStepRoute,
} from "../src/model-routing";
import { createProductionRuntime } from "../src/production-runtime";
import type { ExecutableAllowlistEntry } from "../src/provider-capabilities";
import type { CredentialBroker } from "../src/security/credential-broker";
import { OpenCodeAuthBroker } from "../src/security/credential-broker";
import { type StepSpec, settlementReceiptPath } from "../src/step-runner";
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
import type { OpenCodeClientLike } from "../src/transports/opencode-sdk";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminalProof(eventId: string): ProviderTerminalProof {
  return {
    eventId,
    providerStatus: "process_group_exited",
    providerObservedAt: new Date().toISOString(),
    exitCode: 0,
  };
}

function wrapRegistryWithReleaseTracking(registry: DefaultTransportRegistry): {
  registry: TransportRegistry;
  releases: string[];
} {
  const releases: string[] = [];
  const wrapped: TransportRegistry = {
    register: (backend, factoryOrInstance) =>
      registry.register(backend, factoryOrInstance),
    has: (backend) => registry.has(backend),
    get: (backend, options) => registry.get(backend, options),
    getCapabilityReport: (backend, options) =>
      registry.getCapabilityReport(backend, options),
    getAllCapabilityReports: (options) =>
      registry.getAllCapabilityReports(options),
    release: (routeFingerprint) => {
      releases.push(routeFingerprint);
      registry.release(routeFingerprint);
    },
  };
  return { registry: wrapped, releases };
}

class DestroyOrderBroker implements CredentialBroker {
  constructor(
    private readonly inner: CredentialBroker,
    private readonly order: string[],
  ) {}

  async project(
    input: Parameters<CredentialBroker["project"]>[0],
  ): ReturnType<CredentialBroker["project"]> {
    const projection = await this.inner.project(input);
    const destroy = projection.destroy.bind(projection);
    return {
      ...projection,
      destroy: async () => {
        this.order.push("projection-destroy");
        await destroy();
      },
    };
  }
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
        createOpencodeClient: () => ({
          // #122: the tool surface is READ from the provider, so a fake that
          // cannot report one cannot open a session at all. That is the point
          // — enumerating is the only way "denied" means anything.
          tool: {
            ids: async () => ({ data: ["read", "grep", "glob", "bash"] }),
          },
          session: {
            create: async () => ({ data: { id: "oc-sess-1" } }),
            prompt: async (options: {
              body: { model: { providerID: string; modelID: string } };
            }) => {
              promptModels.push(options.body.model);
              return { data: {} };
            },
            messages: async () => ({ data: {} }),
            // #127: the poll observer's turn boundary, GET /session/status.
            // An empty map is a session opencode is not working on — it omits
            // an idle session rather than reporting {"type":"idle"}.
            status: async () => ({ data: {} }),
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
        capabilities: async () => {
          const base = await createRecordingTransport(
            [],
            "opencode",
          ).capabilities();
          return {
            ...base,
            cancellation: { deadlineMs: 5, conformance: "passed" },
          };
        },
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
        graceMarginMs: 0,
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
      expect(captured[0]).not.toHaveProperty("timeoutMs");
      expect(result.stderrTail).toMatch(/timeout|timed out/i);
    });
  });

  describe("Task 2.3 RED: unknown-outcome fencing, settlement, and ordered disposal", () => {
    async function createClaudeProductionRuntime(
      requests: TransportRequest[],
      options: { signal?: AbortSignal } = {},
    ) {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const baseRegistry = new DefaultTransportRegistry();
      baseRegistry.register(
        "claude-code",
        createRecordingTransport(requests, "claude-code"),
      );
      const { registry, releases } =
        wrapRegistryWithReleaseTracking(baseRegistry);
      const runtime = await createProductionRuntime({
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
        signal: options.signal,
      });
      return { step, runtime, releases };
    }

    test("production runner acquires binding transport lease per step and disposes after settlement", async () => {
      const requests: TransportRequest[] = [];
      const { step, runtime, releases } =
        await createClaudeProductionRuntime(requests);

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("ok");
      expect(releases).toEqual([step.routeFingerprint]);
    });

    test("unconfirmed opencode abort through production runner fences the binding credential bucket", async () => {
      const limiter = new ConcurrencyLimiter({ bucketCeiling: 5 });
      const gate = new ConcurrencyAttemptAdmissionGate(limiter);

      const controller = new AbortController();
      let transportCalls = 0;
      const hangingTransport: ProviderTransport = {
        backend: "opencode",
        capabilities: async () => {
          const base = await createRecordingTransport(
            [],
            "opencode",
          ).capabilities();
          return {
            ...base,
            cancellation: { deadlineMs: 5, conformance: "passed" },
          };
        },
        execute: async () => {
          transportCalls += 1;
          if (transportCalls === 1) {
            await new Promise<never>(() => {});
          }
          return {
            completion: "success",
            protocolIntegrity: "verified",
            finalText: '{"findings":[]}',
            usage: {
              wallMs: 1,
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

      const baseRegistry = new DefaultTransportRegistry();
      baseRegistry.register("opencode", hangingTransport);
      const sharedRuntimeOptions = {
        workspaceRoot: tmpDir,
        binaryPath: claudeFixture.canonicalPath,
        openCodeBinaryPath: opencodeFixture.canonicalPath,
        executableAllowlists: mixedAllowlists(claudeFixture, opencodeFixture),
        mode: "conformance" as const,
        evidence: new Map<RunnerBackend, D1_11ReadinessEvidence>([
          ["opencode", COMPLETE_EVIDENCE],
        ]),
        attemptAdmissionGate: gate,
        graceMarginMs: 5,
        credentialBrokers: {
          opencode: new OpenCodeAuthBroker({
            readerFn: async () =>
              JSON.stringify({
                openai: { type: "oauth", access: "test", refresh: "test" },
              }),
          }),
        },
        authorityDeps: {
          existsFn: (p: string) =>
            p === claudeFixture.canonicalPath ||
            p === opencodeFixture.canonicalPath ||
            p.startsWith(tmpDir),
          realpathFn: async (p: string) => p,
        },
      };

      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "openai/gpt-4o",
        routingConfig: openCodeRoutingConfig(),
      });
      const plan = createResolvedRoutePlan([step]);

      const runtimeA = await createProductionRuntime({
        ...sharedRuntimeOptions,
        plan,
        registry: baseRegistry,
        signal: controller.signal,
      });

      const binding = runtimeA.bindings.get(step.routeFingerprint);
      expect(binding?.credential.bucketId).toBeDefined();

      const runPromise = runtimeA.runner.run(
        makeStep(tmpDir, {
          name: "hunter-a",
          model: "openai/gpt-4o",
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );
      await sleep(10);
      controller.abort();
      const resultA = await runPromise;
      expect(resultA.status).toBe("failed");
      await sleep(50);

      const runtimeB = await createProductionRuntime({
        ...sharedRuntimeOptions,
        plan,
        registry: baseRegistry,
      });

      const resultB = await runtimeB.runner.run(
        makeStep(tmpDir, {
          name: "hunter-b",
          model: "openai/gpt-4o",
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(resultB.status).toBe("failed");
      expect(transportCalls).toBe(1);
    });

    test("runtime.dispose releases all active binding transport leases", async () => {
      const baseRegistry = new DefaultTransportRegistry();
      baseRegistry.register(
        "claude-code",
        createRecordingTransport([], "claude-code"),
      );
      baseRegistry.register(
        "opencode",
        createRecordingTransport([], "opencode"),
      );

      const stepClaude = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const stepOpenCode = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "openai/gpt-4o",
        routingConfig: openCodeRoutingConfig(),
      });
      const { registry, releases } =
        wrapRegistryWithReleaseTracking(baseRegistry);

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan: createResolvedRoutePlan([stepClaude, stepOpenCode]),
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

      const claudeBinding = runtime.bindings.get(stepClaude.routeFingerprint);
      const openCodeBinding = runtime.bindings.get(
        stepOpenCode.routeFingerprint,
      );
      expect(claudeBinding).toBeDefined();
      expect(openCodeBinding).toBeDefined();
      if (claudeBinding === undefined || openCodeBinding === undefined) return;

      await claudeBinding.acquire(ISOLATION_STUB, registry);
      await openCodeBinding.acquire(ISOLATION_STUB, registry);
      expect(releases).toHaveLength(0);

      await runtime.dispose();

      expect(releases.sort()).toEqual(
        [stepClaude.routeFingerprint, stepOpenCode.routeFingerprint].sort(),
      );
    });

    test("opencode step teardown disposes stream then client then server before credential projection destroy", async () => {
      const teardownOrder: string[] = [];
      const mockClient: OpenCodeClientLike & { close(): Promise<void> } = {
        createSession: async () => ({ id: "sess-1" }),
        streamEvents: () => ({
          [Symbol.asyncIterator]() {
            const inner = (async function* () {
              yield {
                kind: "terminal" as const,
                proof: terminalProof("e1"),
              };
            })();
            return {
              next: () => inner.next(),
              return: async () => {
                teardownOrder.push("stream-disposed");
                const result = await inner.return?.();
                return result ?? { done: true as const, value: undefined };
              },
            };
          },
        }),
        pollStatus: async () => ({ kind: "pending" }),
        abort: async () => {},
        close: async () => {
          teardownOrder.push("client-close");
          teardownOrder.push("server-close");
        },
      };

      const broker = new DestroyOrderBroker(
        new OpenCodeAuthBroker({
          readerFn: async () =>
            JSON.stringify({
              openai: { type: "oauth", access: "test", refresh: "test" },
            }),
        }),
        teardownOrder,
      );

      const registry = new DefaultTransportRegistry({
        mode: "conformance",
        evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
        binaryPath: opencodeFixture.canonicalPath,
        openCodeClient: mockClient,
      });

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
        credentialBrokers: { opencode: broker },
        authorityDeps: {
          existsFn: (p) =>
            p === claudeFixture.canonicalPath ||
            p === opencodeFixture.canonicalPath ||
            p.startsWith(tmpDir),
          realpathFn: async (p) => p,
        },
      });

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          model: "openai/gpt-4o",
          route: step.route,
          routeKey: step.routeFingerprint,
          parse: (text) => (text === "" ? {} : JSON.parse(text)),
        }),
      );

      expect(result.status).toBe("ok");
      expect(teardownOrder).toEqual([
        "stream-disposed",
        "client-close",
        "server-close",
        "projection-destroy",
      ]);
    });

    test("transient retry through production runner persists one settlement receipt per attempt", async () => {
      let calls = 0;
      const scriptedTransport: ProviderTransport = {
        backend: "claude-code",
        capabilities: async () =>
          createRecordingTransport([], "claude-code").capabilities(),
        execute: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              completion: "failed",
              protocolIntegrity: "unverified",
              finalText: "not json",
              usage: {
                wallMs: 1,
                tokens: {},
                completeness: "complete",
                billingMode: "subscription",
                costSource: "provider",
                cashCostUsd: 0,
              },
              stderrTail: "ECONNRESET",
            };
          }
          return {
            completion: "success",
            protocolIntegrity: "verified",
            finalText: '{"findings":[]}',
            usage: {
              wallMs: 1,
              tokens: {},
              completeness: "complete",
              billingMode: "subscription",
              costSource: "provider",
              cashCostUsd: 0,
            },
            stderrTail: "",
          };
        },
        classifyFailure: (outcome) =>
          outcome.completion === "failed" ? "network_transient" : undefined,
      };

      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const baseRegistry = new DefaultTransportRegistry();
      baseRegistry.register("claude-code", scriptedTransport);
      const runtime = await createProductionRuntime({
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
        registry: baseRegistry,
        mode: "conformance",
      });

      const outPath = path.join(tmpDir, "hunter-reliability.json");
      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          outPath,
          maxAttempts: 2,
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("ok");
      expect(calls).toBe(2);

      const attempt1Path = settlementReceiptPath(
        outPath,
        "hunter-reliability",
        1,
      );
      const attempt2Path = settlementReceiptPath(
        outPath,
        "hunter-reliability",
        2,
      );
      expect(existsSync(attempt1Path)).toBe(true);
      expect(existsSync(attempt2Path)).toBe(true);

      const receipt1 = JSON.parse(
        await readFile(attempt1Path, "utf8"),
      ) as SettlementReceipt;
      const receipt2 = JSON.parse(
        await readFile(attempt2Path, "utf8"),
      ) as SettlementReceipt;
      expect(receipt1.outcome).not.toBe(receipt2.outcome);
      expect(receipt2.outcome).toBe("completed");
    });

    test("claude step does not pass timeoutMs on TransportRequest", async () => {
      const requests: TransportRequest[] = [];
      const { step, runtime } = await createClaudeProductionRuntime(requests);

      const result = await runtime.runner.run(
        makeStep(tmpDir, {
          timeoutMs: 40,
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("ok");
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty("timeoutMs");
    });
  });
});
