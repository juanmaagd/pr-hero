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
import { PRICING_CATALOG, PRICING_MAX_AGE_DAYS } from "../src/pricing-catalog";
import {
  collectDoctorExactBindingReports,
  createProductionRuntime,
  MultiProviderRunner,
  ProductionRuntimeError,
  probeBindingsReadiness,
} from "../src/production-runtime";
import {
  type ExecutableAllowlistEntry,
  exactBindingCapabilityGate,
  exactBindingCapabilityIssues,
} from "../src/provider-capabilities";
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
  capabilityOverrides: Partial<ProviderCapabilityReport> = {},
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
      ...capabilityOverrides,
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

    test("the runtime echoes the D1-11 evidence it was admitted with", async () => {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const evidence = new Map<RunnerBackend, D1_11ReadinessEvidence>([
        [
          "opencode",
          {
            sdkAvailable: true,
            credentialAuthority: true,
            workspaceBroker: true,
            pricingReady: true,
          },
        ],
      ]);

      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
        evidence,
      });

      // The evidence has to survive the runtime boundary: admitRoutePlan reads
      // it ONLY from its own options, so every downstream admission call site
      // needs the runtime to hand it back out.
      expect(runtime.evidence).toBe(evidence);
    });

    test("a runtime built without evidence exposes none", async () => {
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

      expect(runtime.evidence).toBeUndefined();
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

    // FOLLOW-UP-1: the legacy ProviderCapabilityReport carries THREE billing
    // modes (subscription | metered | unknown, provider-capabilities.ts:266)
    // while the exact contract carries two (contracts.ts:167). The producer
    // narrows `unknown` into `"subscription"`, so `cashCostAccountingValid`
    // must NOT be derived from the narrowed value — the design doc is
    // explicit that `billingMode: "unknown"` is a blocking preflight result
    // (docs/multi-runtime-model-diversity-design.md:461), and the pricing
    // gate cannot catch it because `unknown` is not `metered`.
    // #137 clock seam. Built from Date.parse of the catalogue's own stamp so
    // every arm below is timezone-stable and, more importantly, dateless: an
    // arm that read the wall clock would flip on the calendar day the bundled
    // table crosses PRICING_MAX_AGE_DAYS, with no commit behind it.
    const catalogAgeClock = (days: number): (() => Date) => {
      const at = new Date(
        Date.parse(PRICING_CATALOG.fetched_at) + days * 86_400_000,
      );
      return () => at;
    };
    const FRESH_CATALOG = catalogAgeClock(0);
    const STALE_CATALOG = catalogAgeClock(PRICING_MAX_AGE_DAYS);

    async function bindingReportForBilling(
      billing: ProviderCapabilityReport["billing"],
      now?: () => Date,
      routingConfig?: RoutingConfig,
    ) {
      // No routingConfig resolves through the alias fallback in
      // model-routing.ts, which pins provider "anthropic" -- the catalogue's
      // own provider. That is what keeps every arm below meaning what it meant
      // before the provider gate existed.
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
        ...(routingConfig === undefined ? {} : { routingConfig }),
      });
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry();
      registry.register(
        "claude-code",
        createMockTransport("claude-code", [], { billing }),
      );
      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
        ...(now === undefined ? {} : { now }),
      });
      const binding = runtime.bindings.get(step.routeFingerprint);
      if (binding === undefined) throw new Error("missing binding");
      return await binding.capabilities();
    }

    test("an unknown legacy billing mode blocks the exact-binding gate through the real producer", async () => {
      const report = await bindingReportForBilling({
        mode: "unknown",
        pricingReady: false,
      });

      // The 2-state narrowing stays: `unknown` still projects as
      // "subscription" on the exact contract.
      expect(report.billing.mode).toBe("subscription");
      // ...which is exactly why the pricing gate cannot see it.
      expect(report.billing.pricingApplicability).toBe("not_applicable");
      // The cash-cost fact is the enforcement point, and it must say NO.
      expect(report.billing.cashCostAccountingValid).toBe(false);

      const decision = exactBindingCapabilityGate(report);
      expect(decision.ok).toBe(false);
      expect(decision.reason).toContain("cash_cost_accounting_invalid");
    });

    test("subscription and metered billing modes keep their spec-defined cash-cost accounting", async () => {
      const subscription = await bindingReportForBilling({
        mode: "subscription",
        pricingReady: false,
      });
      // Spec: subscription OAuth may truthfully report cashCostUsd: 0, with
      // no pricing table involved.
      expect(subscription.billing.cashCostAccountingValid).toBe(true);
      expect(exactBindingCapabilityGate(subscription).ok).toBe(true);

      // #137: STALE_CATALOG is what keeps this arm meaning what it has always
      // meant. The route's model (claude-sonnet-5) is now IN the bundled
      // catalogue, so a fresh table would price this metered route on the
      // catalogue alone and the arm would stop being the unpriced case it
      // exists to prove. Expiring the table is how "no pricing is available"
      // is still expressible — the assertions below are unchanged.
      const meteredUnpriced = await bindingReportForBilling(
        {
          mode: "metered",
          pricingReady: false,
        },
        STALE_CATALOG,
      );
      // Spec: metered routes require provider cost or a versioned rate table.
      expect(meteredUnpriced.billing.cashCostAccountingValid).toBe(false);
      // The cash gate stays silent for metered (its guard is
      // `pricingApplicability !== "required"`); pricing_table_missing is the
      // blocker on this arm.
      const meteredDecision = exactBindingCapabilityGate(meteredUnpriced);
      expect(meteredDecision.ok).toBe(false);
      expect(meteredDecision.reason).toContain("pricing_table_missing");
      expect(meteredDecision.reason).not.toContain(
        "cash_cost_accounting_invalid",
      );

      const meteredPriced = await bindingReportForBilling({
        mode: "metered",
        pricingReady: true,
      });
      expect(meteredPriced.billing.cashCostAccountingValid).toBe(true);
      expect(exactBindingCapabilityGate(meteredPriced).ok).toBe(true);
    });

    // #137. The binding is the ONLY place a model id and a billing decision
    // are both in scope, so it is the only place the bundled catalogue can be
    // consulted. These arms are the proof that consulting it does what the
    // issue asked: price what is known and current, refuse everything else.
    describe("bundled pricing catalogue as a second pricing source", () => {
      test("a catalogued model on a fresh table prices a metered route the transport could not price", async () => {
        // The route resolves to claude-sonnet-5, which the catalogue covers.
        const report = await bindingReportForBilling(
          { mode: "metered", pricingReady: false },
          FRESH_CATALOG,
        );

        expect(report.billing.pricingApplicability).toBe("required");
        expect(report.billing.tokenPricingAvailable).toBe(true);
        // Coherence: the design line this file already quotes says metered
        // needs "provider cost or a versioned rate table". A bundled,
        // date-stamped table IS the second half of that sentence, so the
        // cash-cost fact must move with the pricing fact — a report claiming
        // priced-but-not-accountable would be self-contradictory.
        expect(report.billing.cashCostAccountingValid).toBe(true);
        expect(exactBindingCapabilityGate(report).ok).toBe(true);
      });

      test("an expired table refuses the same route rather than billing a guessed price", async () => {
        const report = await bindingReportForBilling(
          { mode: "metered", pricingReady: false },
          STALE_CATALOG,
        );

        expect(report.billing.tokenPricingAvailable).toBe(false);
        const decision = exactBindingCapabilityGate(report);
        expect(decision.ok).toBe(false);
        expect(decision.reason).toContain("pricing_table_missing");
      });

      test("the transport's own pricingReady still suffices when the table is expired", async () => {
        // Two INDEPENDENT sources for one fact; either alone is enough. A
        // provider that reports its own cost must not be held hostage by the
        // freshness of a table it never needed.
        const report = await bindingReportForBilling(
          { mode: "metered", pricingReady: true },
          STALE_CATALOG,
        );

        expect(report.billing.tokenPricingAvailable).toBe(true);
        expect(exactBindingCapabilityGate(report).ok).toBe(true);
      });

      test("a foreign provider on a catalogued model is refused, not billed at Anthropic's rates", async () => {
        // The finding: pr-hero reviewing PR #162 on the OpenCode route,
        // refuter verdict `corroborated`. `parseRouteMapping`
        // (preflight.ts) validates `provider` as any non-empty string and
        // never cross-checks it against `modelSnapshot`, so this mapping is
        // admissible -- and the predicate, seeing only the model id, priced
        // it from the Anthropic-only catalogue. Same fresh table, same
        // catalogued model as the arm above; only the provider differs.
        const routingConfig: RoutingConfig = {
          default: {
            backend: "claude-code",
            provider: "openai",
            modelFamily: "claude-sonnet-5",
            modelSnapshot: "claude-sonnet-5",
          },
        };
        const report = await bindingReportForBilling(
          { mode: "metered", pricingReady: false },
          FRESH_CATALOG,
          routingConfig,
        );

        expect(report.billing.pricingApplicability).toBe("required");
        expect(report.billing.tokenPricingAvailable).toBe(false);
        expect(report.billing.cashCostAccountingValid).toBe(false);
        const decision = exactBindingCapabilityGate(report);
        expect(decision.ok).toBe(false);
        expect(decision.reason).toContain("pricing_table_missing");
      });
    });

    // #133. The credential KIND is what decides how a route bills, and it is
    // provider-keyed: an OpenCode route on any provider but `openai` runs on a
    // metered API token. The legacy backend-wide report cannot know that --
    // it is produced before any route resolves -- so it keeps saying
    // "subscription" and the binding corrects it.
    //
    // Why the correction has to reach all THREE billing expressions and not
    // just `billing.mode`: `pricingApplicability`, `mode` and
    // `cashCostAccountingValid` each read the mode independently. Upgrading
    // only `mode` leaves `pricingApplicability` at "not_applicable", the
    // pricing gate never fires, and a metered route is admitted as
    // priced-not-required -- which is precisely the under-reporting this
    // issue exists to prevent: the run executes on real spend and reports $0.
    describe("provider_api_token routes bill as metered", () => {
      async function openCodeBindingReport(provider: string) {
        const opencodeFixture = await writeOpenCodeFixture(tmpDir);
        const routingConfig: RoutingConfig = {
          mappings: {
            "zai/glm-5": {
              backend: "opencode",
              provider,
              modelFamily: "glm-5",
              modelSnapshot: "glm-5",
            },
          },
        };
        const step = resolveStepRoute({
          stepKey: "hunter-reliability",
          role: "hunter",
          cliModel: "zai/glm-5",
          routingConfig,
        });
        const plan = createResolvedRoutePlan([step]);
        const registry = new DefaultTransportRegistry();
        registry.register(
          "opencode",
          createMockTransport("opencode", [], {
            // Load-bearing: the mock's default is `pricingReady: true`, which
            // would make `tokenPricingAvailable` true from the transport alone
            // and the arm would prove nothing about the gate.
            billing: { mode: "subscription", pricingReady: false },
          }),
        );
        const runtime = await createProductionRuntime({
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
          registry,
          mode: "conformance",
        });
        const binding = runtime.bindings.get(step.routeFingerprint);
        if (binding === undefined) throw new Error("missing binding");
        return { binding, report: await binding.capabilities() };
      }

      test("an unpriced zai route is refused by the pricing gate, not billed as a subscription", async () => {
        const { binding, report } = await openCodeBindingReport("zai");

        expect(binding.credential.kind).toBe("provider_api_token");
        expect(report.auth.kind).toBe("provider_api_token");
        expect(report.billing.mode).toBe("metered");
        // The three independent readers must move together.
        expect(report.billing.pricingApplicability).toBe("required");
        expect(report.billing.tokenPricingAvailable).toBe(false);
        expect(report.billing.cashCostAccountingValid).toBe(false);

        const issues = exactBindingCapabilityIssues(report);
        const pricing = issues.find(
          (issue) => issue.code === "pricing_table_missing",
        );
        expect(pricing).toBeDefined();
        expect(pricing?.blocking).toBe(true);
        expect(exactBindingCapabilityGate(report).ok).toBe(false);
      });

      test("the openai OAuth route on the same backend still bills as a subscription", async () => {
        const { binding, report } = await openCodeBindingReport("openai");

        expect(binding.credential.kind).toBe("opencode_chatgpt_oauth");
        expect(report.billing.mode).toBe("subscription");
        expect(report.billing.pricingApplicability).toBe("not_applicable");
        expect(report.billing.cashCostAccountingValid).toBe(true);
        expect(exactBindingCapabilityGate(report).ok).toBe(true);
      });

      // The upgrade is one-way. A metered legacy report on an OAuth route
      // must NOT be downgraded to subscription, and `unknown` must still
      // reach `cashCostAccountingValid: false` for every kind that is not
      // provider_api_token -- that is what keeps the narrowing comment on
      // FrozenRuntimeBinding.capabilities() true.
      test("the effective mode only ever upgrades", async () => {
        const opencodeFixture = await writeOpenCodeFixture(tmpDir);
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
          stepKey: "hunter-reliability",
          role: "hunter",
          cliModel: "openai/gpt-4o",
          routingConfig,
        });
        const plan = createResolvedRoutePlan([step]);
        const registry = new DefaultTransportRegistry();
        registry.register(
          "opencode",
          createMockTransport("opencode", [], {
            billing: { mode: "unknown", pricingReady: false },
          }),
        );
        const runtime = await createProductionRuntime({
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
          registry,
          mode: "conformance",
        });
        const binding = runtime.bindings.get(step.routeFingerprint);
        if (binding === undefined) throw new Error("missing binding");
        const report = await binding.capabilities();

        expect(binding.credential.kind).toBe("opencode_chatgpt_oauth");
        expect(report.billing.mode).toBe("subscription");
        expect(report.billing.cashCostAccountingValid).toBe(false);
        const decision = exactBindingCapabilityGate(report);
        expect(decision.ok).toBe(false);
        expect(decision.reason).toContain("cash_cost_accounting_invalid");
      });

      // #133 scope note, proven rather than asserted: the OpenCode SERVER is
      // one per backend and outlives every step, so a plan mixing an `openai`
      // OAuth route with a `zai` API-token route would need two credentials
      // behind one server. That is out of scope here -- but it must fail
      // LOUD, not run one provider's steps under the other's credential.
      // `resolveFrozenBindings` gates per BINDING, so the unpriced metered
      // route is refused before anything launches.
      test("a plan mixing an OAuth provider and an API-token provider is refused per binding", async () => {
        const opencodeFixture = await writeOpenCodeFixture(tmpDir);
        const routingConfig: RoutingConfig = {
          mappings: {
            "openai/gpt-4o": {
              backend: "opencode",
              provider: "openai",
              modelFamily: "gpt-4o",
              modelSnapshot: "gpt-4o",
            },
            "zai/glm-5": {
              backend: "opencode",
              provider: "zai",
              modelFamily: "glm-5",
              modelSnapshot: "glm-5",
            },
          },
        };
        const oauthStep = resolveStepRoute({
          stepKey: "hunter-reliability",
          role: "hunter",
          cliModel: "openai/gpt-4o",
          routingConfig,
        });
        const tokenStep = resolveStepRoute({
          stepKey: "refuter",
          role: "refuter",
          cliModel: "zai/glm-5",
          routingConfig,
        });
        const plan = createResolvedRoutePlan([oauthStep, tokenStep]);
        const registry = new DefaultTransportRegistry();
        registry.register(
          "opencode",
          createMockTransport("opencode", [], {
            billing: { mode: "subscription", pricingReady: false },
          }),
        );

        const probe = await probeBindingsReadiness({
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
          registry,
          mode: "conformance",
        });

        expect(probe.decision.ok).toBe(false);
        expect(probe.decision.reason).toContain("pricing_table_missing");
        // The two bindings differ: the OAuth one is admissible on its own.
        const kinds = [...probe.bindings.values()]
          .map((binding) => binding.credential.kind)
          .sort();
        expect(kinds).toEqual(["opencode_chatgpt_oauth", "provider_api_token"]);
        await probe.dispose();
      });
    });

    // SUGGESTION-1: capabilities() is deliberately non-memoised (it re-probes
    // by design, and DefaultTransportRegistry.getCapabilityReport calls
    // transport.capabilities() on every call), so a caller that gates and
    // then re-collects pays two full probe passes. The readiness probe must
    // hand its reports back so doctor consumes ONE pass.
    test("probeBindingsReadiness probes each binding once and returns the reports it gated on", async () => {
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

      let probeCount = 0;
      const base = createMockTransport("claude-code");
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", {
        ...base,
        capabilities: async () => {
          probeCount += 1;
          return await base.capabilities();
        },
      });

      const probe = await probeBindingsReadiness({
        workspaceRoot: tmpDir,
        plan,
        binaryPath: claudeFixture.canonicalPath,
        executableAllowlists: claudeAllowlist(claudeFixture),
        registry,
        mode: "conformance",
      });
      try {
        expect(probe.decision.ok).toBe(true);
        expect(probe.bindings.size).toBe(2);
        expect(probe.reports.length).toBe(2);
        expect([...probe.reports].map((r) => r.routeKey).sort()).toEqual(
          [...probe.bindings.keys()].sort(),
        );
        // One probe per binding — no second collection pass.
        expect(probeCount).toBe(probe.bindings.size);
      } finally {
        await probe.dispose();
      }
    });

    // WHY this test exists: collectDoctorExactBindingReports carried TWO
    // disagreeing branches and only the `loadSdk`-injected one was ever
    // exercised by a test. The real doctor/wizard path passes no loadSdk, so
    // it fell through to a registry with no mode at all — which the OpenCode
    // transport factory defaults to "production" — and every OpenCode route
    // was gated on the very D1-11 evidence this diagnostic probe exists to
    // produce. Fully hermetic: PATH-scoped fixture binaries, and neither
    // transport's capabilities() spawns a process or loads @opencode-ai/sdk.
    test("collectDoctorExactBindingReports probes an OpenCode route without the production D1-11 gate when no SDK loader is injected", async () => {
      await writeOpenCodeFixture(tmpDir);
      const routingConfig: RoutingConfig = {
        mappings: [
          {
            logical: "opus",
            backend: "opencode",
            provider: "openai",
            modelFamily: "gpt-4o",
            modelSnapshot: "gpt-4o",
          },
        ],
      };

      const reports = await collectDoctorExactBindingReports({
        workspaceRoot: tmpDir,
        routingConfig,
        env: { PATH: tmpDir },
      });

      expect(reports.length).toBe(2);
      expect([...reports].map((report) => report.backend).sort()).toEqual([
        "claude-code",
        "opencode",
      ]);
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
        "openai",
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
        "openai",
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
