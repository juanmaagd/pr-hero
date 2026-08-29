import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ProviderCapabilityReport,
  ProviderTransport,
  RunnerBackend,
  TransportOutcome,
  TransportRequest,
} from "../src/execution/contracts";
import { aliasModelFamily, aliasModelSnapshot } from "../src/model-catalog";
import {
  computeRouteFingerprint,
  createResolvedRoutePlan,
  type RoutingConfig,
  resolveStepRoute,
} from "../src/model-routing";
import {
  createProductionRuntime,
  MultiProviderRunner,
  ProductionRuntimeError,
} from "../src/production-runtime";
import type { ExecutableAllowlistEntry } from "../src/provider-capabilities";
import {
  resolveBindingAuthority,
  resolveRunnerAuthority,
} from "../src/runner-authority";
import type { CredentialBroker } from "../src/security/credential-broker";
import { OpenCodeAuthBroker } from "../src/security/credential-broker";
import { authorizeWorkspaceCwd } from "../src/security/execution-authority";
import { buildStepArgv } from "../src/step-runner";
import {
  admitRoutePlan,
  type D1_11ReadinessEvidence,
  DefaultTransportRegistry,
  OpenCodeProductionGatedError,
} from "../src/transport-registry";

const MACHO_PREFIX = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

const stubClaudeCredentialBroker: CredentialBroker = {
  async project() {
    throw new Error("stub broker: capability-gate tests never project");
  },
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

function claudeAllowlist(fixture: {
  canonicalPath: string;
  sha256: string;
}): Partial<Record<RunnerBackend, readonly ExecutableAllowlistEntry[]>> {
  return {
    "claude-code": [
      { absolutePath: fixture.canonicalPath, sha256: fixture.sha256 },
    ],
  };
}

function mixedAllowlists(
  claude: { canonicalPath: string; sha256: string },
  opencode: { canonicalPath: string; sha256: string },
): Partial<Record<RunnerBackend, readonly ExecutableAllowlistEntry[]>> {
  return {
    "claude-code": [
      { absolutePath: claude.canonicalPath, sha256: claude.sha256 },
    ],
    opencode: [
      { absolutePath: opencode.canonicalPath, sha256: opencode.sha256 },
    ],
  };
}

function createMockTransport(
  backend: RunnerBackend,
  requests: TransportRequest[] = [],
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

function makeStep(
  tmpDir: string,
  overrides: Partial<import("../src/step-runner").StepSpec> = {},
) {
  return {
    name: "hunter-reliability",
    systemPromptPath: path.join(tmpDir, "system.md"),
    prompt: "review",
    tools: ["Read"],
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

describe("production runtime PR1", () => {
  let tmpDir: string;
  let claudeFixture: { canonicalPath: string; sha256: string };

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-prod-rt-"));
    tmpDir = await realpath(tmpDir);
    claudeFixture = await writeClaudeFixture(tmpDir);
    await writeFile(path.join(tmpDir, "system.md"), "system");
    await writeFile(path.join(tmpDir, "mcp.json"), "{}");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("Task 1.1: route fingerprint identity and shared registry", () => {
    test("routeFingerprint changes when backend/provider/model/variant differ", () => {
      const baseRoute = {
        backend: "claude-code" as const,
        provider: "anthropic",
        gateway: "direct" as const,
        modelFamily: aliasModelFamily("sonnet"),
        modelSnapshot: aliasModelSnapshot("sonnet"),
      };
      const fpBase = computeRouteFingerprint(
        "anthropic/claude-sonnet-4-5",
        baseRoute,
      );
      const fpVariant = computeRouteFingerprint("anthropic/claude-sonnet-4-5", {
        ...baseRoute,
        modelVariant: "thinking",
      });
      const fpProvider = computeRouteFingerprint("openai/gpt-4o", {
        backend: "opencode",
        provider: "openai",
        modelFamily: "gpt-4o",
        modelSnapshot: "gpt-4o",
      });

      expect(fpBase).toHaveLength(64);
      expect(fpVariant).not.toBe(fpBase);
      expect(fpProvider).not.toBe(fpBase);
    });

    test("createProductionRuntime freezes one binding per routeFingerprint", async () => {
      const hunter = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const refuter = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "opus",
      });
      const plan = createResolvedRoutePlan([hunter, refuter]);

      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });

      expect(runtime.bindings.size).toBe(2);
      expect(runtime.bindings.has(hunter.routeFingerprint)).toBe(true);
      expect(runtime.bindings.has(refuter.routeFingerprint)).toBe(true);
      expect(
        runtime.bindings.get(hunter.routeFingerprint)?.route.modelFamily,
      ).toBe(aliasModelFamily("sonnet"));
      expect(
        runtime.bindings.get(refuter.routeFingerprint)?.route.modelFamily,
      ).toBe(aliasModelFamily("opus"));
    });

    test("local and PR modes share the same registry for admission and execution", async () => {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });

      const readmission = await admitRoutePlan(plan, runtime.registry, {
        mode: "conformance",
      });
      expect(readmission.ok).toBe(true);
      expect(runtime.runner).toBeInstanceOf(MultiProviderRunner);
      expect(
        (runtime.runner as MultiProviderRunner).resolveBinding(
          makeStep(tmpDir, {
            routeKey: step.routeFingerprint,
            route: step.route,
          }),
        )?.key,
      ).toBe(step.routeFingerprint);
    });

    test("invalid authority stops before any spawn or reservation", async () => {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      let spawnCount = 0;
      const spawnFn = (() => {
        spawnCount++;
        return {
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
          exited: Promise.resolve(0),
          kill() {},
        };
      }) as unknown as typeof Bun.spawn;

      await expect(
        createProductionRuntime({
          workspaceRoot: tmpDir,
          plan,
          binaryPath: path.join(tmpDir, "missing-claude"),
          registry,
          mode: "conformance",
          spawnFn,
          authorityDeps: {
            realpathFn: async () => {
              throw new Error("not found");
            },
          },
        }),
      ).rejects.toThrow(ProductionRuntimeError);

      expect(spawnCount).toBe(0);
    });

    test("Claude-only runtime preserves buildStepArgv bytes", () => {
      const spec = makeStep(tmpDir);
      const argv = buildStepArgv(spec);
      expect(argv).toEqual([
        "claude",
        "-p",
        spec.prompt,
        "--append-system-prompt-file",
        spec.systemPromptPath,
        "--output-format",
        "json",
        "--mcp-config",
        spec.mcpConfigPath,
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--tools",
        "Read",
        "--permission-mode",
        "bypassPermissions",
        "--model",
        "sonnet",
      ]);
    });

    test("resolveRunnerAuthority remains the Claude compatibility facade", async () => {
      const authority = await resolveRunnerAuthority({
        workspaceRoot: tmpDir,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
      });
      expect(authority.error).toBeUndefined();
      expect(authority.runnerOptions?.binaryPath).toBe(
        claudeFixture.canonicalPath,
      );
      expect(authority.runnerOptions?.executableAllowlist[0].sha256).toBe(
        claudeFixture.sha256,
      );
    });
  });

  describe("Task 1.3/1.4: authority denials before confirmation", () => {
    test("workspace cwd escape is denied with zero transport calls", async () => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), "pr-hero-out-"));
      const outside = await realpath(outsideDir);
      await writeFile(path.join(outside, "secret.txt"), "x");

      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const requests: TransportRequest[] = [];
      const registry = new DefaultTransportRegistry();
      registry.register(
        "claude-code",
        createMockTransport("claude-code", requests),
      );

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
        authorityDeps: {
          existsFn: (p) =>
            p === claudeFixture.canonicalPath || p.startsWith(tmpDir),
          realpathFn: async (p) => p,
        },
      });

      const result = await runtime.runner.run(
        makeStep(path.join(tmpDir, "..", path.basename(outside)), {
          cwd: path.join(tmpDir, "..", path.basename(outside)),
          routeKey: step.routeFingerprint,
          route: step.route,
        }),
      );

      expect(result.status).toBe("failed");
      expect(result.denialCode).toBe("path_not_approved");
      expect(result.attempts).toBe(0);
      expect(requests).toHaveLength(0);

      await rm(outside, { recursive: true, force: true }).catch(() => {});
    });

    test("authorizeWorkspaceCwd rejects relative escape before spawn", () => {
      const auth = authorizeWorkspaceCwd(tmpDir, "../outside");
      expect(auth.approved).toBe(false);
    });

    test("OpenCode without D1-11 evidence fails before runner is returned", async () => {
      const routingConfig: RoutingConfig = {
        mappings: {
          "openai/gpt-4o": {
            backend: "opencode",
            provider: "openai",
            modelFamily: "gpt-4o",
            modelSnapshot: "gpt-4o",
          },
        },
      };
      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "openai/gpt-4o",
        routingConfig,
      });
      const plan = createResolvedRoutePlan([step]);
      const opencodeFixture = await writeOpenCodeFixture(tmpDir);

      await expect(
        createProductionRuntime({
          workspaceRoot: tmpDir,
          plan,
          openCodeBinaryPath: opencodeFixture.canonicalPath,
          executableAllowlists: {
            opencode: [
              {
                absolutePath: opencodeFixture.canonicalPath,
                sha256: opencodeFixture.sha256,
              },
            ],
          },
          mode: "production",
        }),
      ).rejects.toThrow(OpenCodeProductionGatedError);
    });
  });

  describe("Task 1.5: interfaces and optional OpenCode", () => {
    test("binding.capabilities derives facts from the exact route binding", async () => {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });

      const binding = runtime.bindings.get(step.routeFingerprint);
      expect(binding).toBeDefined();
      if (binding === undefined) return;
      const report = await binding.capabilities();
      expect(report.routeKey).toBe(step.routeFingerprint);
      expect(report.backend).toBe("claude-code");
      expect(report.binary.resolved).toBe(true);
      expect(report.binary.sha256).toBe(claudeFixture.sha256);
      const brokered = binding.credential.broker !== undefined;
      expect(report.auth.projectionReady).toBe(brokered);
      expect(report.environment.syntheticHome).toBe(brokered);
      expect(report.environment.enumeratedPassthrough).toBe(!brokered);
    });

    test("mixed Claude/OpenCode conformance admits with evidence and dispatches by routeKey", async () => {
      const routingConfig: RoutingConfig = {
        mappings: {
          "openai/gpt-4o": {
            backend: "opencode",
            provider: "openai",
            modelFamily: "gpt-4o",
            modelSnapshot: "gpt-4o",
            modelVariant: "high",
          },
        },
      };
      const claudeStep = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const openStep = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "openai/gpt-4o",
        routingConfig,
      });
      const plan = createResolvedRoutePlan([claudeStep, openStep]);
      const opencodeFixture = await writeOpenCodeFixture(tmpDir);

      const claudeRequests: TransportRequest[] = [];
      const openRequests: TransportRequest[] = [];
      const registry = new DefaultTransportRegistry();
      registry.register(
        "claude-code",
        createMockTransport("claude-code", claudeRequests),
      );
      registry.register(
        "opencode",
        createMockTransport("opencode", openRequests),
      );

      const evidence: D1_11ReadinessEvidence = {
        sdkAvailable: true,
        credentialAuthority: true,
        workspaceBroker: true,
        pricingReady: true,
      };

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        openCodeBinaryPath: opencodeFixture.canonicalPath,
        executableAllowlists: mixedAllowlists(claudeFixture, opencodeFixture),
        registry,
        mode: "conformance",
        evidence: new Map([["opencode", evidence]]),
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

      expect(runtime.bindings.size).toBe(2);

      const claudeResult = await runtime.runner.run(
        makeStep(tmpDir, {
          routeKey: claudeStep.routeFingerprint,
          route: claudeStep.route,
        }),
      );
      const openResult = await runtime.runner.run(
        makeStep(tmpDir, {
          routeKey: openStep.routeFingerprint,
          route: openStep.route,
        }),
      );

      expect(claudeResult.status).toBe("ok");
      expect(openResult.status).toBe("ok");
      expect(claudeRequests).toHaveLength(1);
      expect(openRequests).toHaveLength(1);
      expect(openRequests[0].route.modelVariant).toBe("high");
      expect(openRequests[0].route.provider).toBe("openai");
    });

    test("resolveBinding matches gateway when routeKey is omitted", async () => {
      const routingConfig: RoutingConfig = {
        mappings: {
          sonnet: {
            backend: "claude-code",
            provider: "anthropic",
            gateway: "direct",
            modelFamily: aliasModelFamily("sonnet"),
            modelSnapshot: aliasModelSnapshot("sonnet"),
          },
          haiku: {
            backend: "claude-code",
            provider: "anthropic",
            gateway: "configured",
            modelFamily: aliasModelFamily("haiku"),
            modelSnapshot: aliasModelSnapshot("haiku"),
          },
        },
      };
      const directStep = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
        routingConfig,
      });
      const configuredStep = resolveStepRoute({
        stepKey: "hunter-resilience",
        role: "hunter",
        cliModel: "haiku",
        routingConfig,
      });
      const plan = createResolvedRoutePlan([directStep, configuredStep]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });
      const runner = runtime.runner as MultiProviderRunner;
      const directBinding = runner.resolveBinding({
        ...makeStep(tmpDir, { route: directStep.route }),
        routeKey: undefined,
      });
      const configuredBinding = runner.resolveBinding({
        ...makeStep(tmpDir, { route: configuredStep.route }),
        routeKey: undefined,
      });
      expect(directBinding?.route.gateway).toBe("direct");
      expect(configuredBinding?.route.gateway).toBe("configured");
    });

    test("bindings sharing a credential coarsen to one bucket id across models", async () => {
      const stepA = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const stepB = resolveStepRoute({
        stepKey: "hunter-resilience",
        role: "hunter",
        cliModel: "haiku",
      });
      const plan = createResolvedRoutePlan([stepA, stepB]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });

      const bindingA = runtime.bindings.get(stepA.routeFingerprint);
      const bindingB = runtime.bindings.get(stepB.routeFingerprint);
      expect(bindingA).toBeDefined();
      expect(bindingB).toBeDefined();
      if (bindingA === undefined || bindingB === undefined) return;
      expect(bindingA.credential.bucketId).toBe(bindingB.credential.bucketId);
      expect(bindingA.credential.bucketId).not.toContain(
        stepA.routeFingerprint.slice(0, 16),
      );
    });

    test("resolveBindingAuthority rejects unsupported backends without fallback", async () => {
      const result = await resolveBindingAuthority(
        "codex",
        { workspaceRoot: tmpDir },
        {
          existsFn: () => true,
          realpathFn: async (p) => p,
          readFileFn: async () => new Uint8Array([1]),
        },
      );
      expect(result.error).toContain("unsupported");
    });

    test("explicit mismatched OpenCode route does not fall back to Claude", async () => {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });
      const runner = runtime.runner as MultiProviderRunner;
      const unmatchedOpenCodeRoute = {
        backend: "opencode" as const,
        provider: "openai",
        modelFamily: "gpt-4o",
        modelSnapshot: "gpt-4o",
      };

      expect(
        runner.resolveBinding({
          ...makeStep(tmpDir),
          route: unmatchedOpenCodeRoute,
        }),
      ).toBeUndefined();

      const result = await runner.run(
        makeStep(tmpDir, { route: unmatchedOpenCodeRoute }),
      );
      expect(result.status).toBe("failed");
      expect(result.stderrTail).toContain("No admitted binding");
    });

    test("resolveBindingAuthority rejects deceptive OpenCode executables not in configured allowlist", async () => {
      const deceptivePath = path.join(tmpDir, "README.sh");
      await writeFile(deceptivePath, "#!/bin/sh\necho deceptive\n");
      await chmod(deceptivePath, 0o755);
      const canonical = await realpath(deceptivePath);

      const result = await resolveBindingAuthority(
        "opencode",
        {
          workspaceRoot: tmpDir,
          openCodeBinaryPath: canonical,
          executableAllowlists: {
            opencode: [
              {
                absolutePath: "/usr/local/bin/opencode",
                sha256:
                  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              },
            ],
          },
        },
        {
          existsFn: () => true,
          realpathFn: async (p) => p,
          readFileFn: async (p) => {
            const text = await readFile(p);
            return new Uint8Array(text);
          },
        },
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("not in configured allowlist");
    });

    test("exposed runtime bindings reject structural mutation", async () => {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });

      expect(() => {
        (runtime.bindings as Map<string, unknown>).set("evil", {});
      }).toThrow(ProductionRuntimeError);

      const binding = runtime.bindings.get(step.routeFingerprint);
      expect(binding).toBeDefined();
      if (binding === undefined) return;
      expect(() => {
        (binding.tools.deniedTools as string[]).push("WebSearch");
      }).toThrow();
    });

    test("execution re-probes exact-binding capabilities before transport acquire", async () => {
      const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-exec-cap-"));
      const claudeFixture = await writeClaudeFixture(tmpDir);
      await writeFile(path.join(tmpDir, "mcp.json"), "{}");
      await writeFile(path.join(tmpDir, "system.md"), "system");
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry({ mode: "conformance" });
      let driftAtExecution = false;
      const mock = createMockTransport("claude-code");
      registry.register("claude-code", {
        ...mock,
        capabilities: async () => {
          if (!driftAtExecution) {
            return mock.capabilities();
          }
          return {
            backend: "claude-code",
            status: "blocking",
            auth: {
              kind: "claude_subscription_oauth",
              projectionReady: false,
              probe: "failed",
            },
            isolation: {
              syntheticHome: true,
              workspaceReadBroker: true,
              codegraphPolicy: false,
            },
            protocol: {
              terminalProof: true,
              boundedEvents: false,
              usageMode: "snapshot",
            },
            cancellation: { deadlineMs: 7500, conformance: "passed" },
            billing: { mode: "subscription", pricingReady: false },
            issues: [
              {
                code: "auth_failed",
                message: "auth drifted",
                blocking: true,
              },
            ],
          };
        },
      });
      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
        credentialBrokers: {
          "claude-code": stubClaudeCredentialBroker,
        },
        authorityDeps: {
          existsFn: (p) =>
            p === claudeFixture.canonicalPath || p.startsWith(tmpDir),
          realpathFn: async (p) => p,
        },
      });
      driftAtExecution = true;
      const result = await runtime.runner.run({
        name: "hunter-reliability",
        systemPromptPath: path.join(tmpDir, "system.md"),
        prompt: "go",
        tools: ["Read"],
        mcpConfigPath: path.join(tmpDir, "mcp.json"),
        model: "sonnet",
        cwd: tmpDir,
        outPath: path.join(tmpDir, "out.json"),
        timeoutMs: 60_000,
        maxAttempts: 1,
        parse: () => ({}),
        route: step.route,
        routeKey: step.routeFingerprint,
      });
      expect(result.status).toBe("failed");
      expect(result.stderrTail).toContain(
        "Exact-binding capability gate failed",
      );
      expect(result.stderrTail).toContain("auth_failed");
      await rm(tmpDir, { recursive: true, force: true });
    });
  });
});
