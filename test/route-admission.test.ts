import { describe, expect, test } from "bun:test";
import {
  aliasCanonical,
  aliasModelFamily,
  aliasModelSnapshot,
} from "../src/model-catalog";
import type {
  ProviderCapabilityReport,
  ProviderTransport,
  RunnerBackend,
  TransportOutcome,
  TransportRequest,
} from "../src/execution/contracts";
import {
  createResolvedRoutePlan,
  type RoutingConfig,
  resolveStepRoute,
} from "../src/model-routing";
import {
  admitRoutePlan,
  checkD1_11Readiness,
  createDefaultTransportRegistry,
  type D1_11ReadinessEvidence,
  DefaultTransportRegistry,
  OpenCodeProductionGatedError,
  RouteAdmissionError,
} from "../src/transport-registry";

function createMockTransport(
  backend: RunnerBackend,
  reportOverrides: Partial<ProviderCapabilityReport> = {},
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
      cancellation: {
        deadlineMs: 5000,
        conformance: "passed",
      },
      billing: {
        mode: "subscription",
        pricingReady: true,
      },
      issues: [],
      ...reportOverrides,
    }),
    execute: async (_request: TransportRequest): Promise<TransportOutcome> => ({
      completion: "success",
      protocolIntegrity: "verified",
      finalText: '{"findings":[]}',
      usage: {
        wallMs: 100,
        tokens: { totalKnown: 10 },
        completeness: "complete",
        billingMode: "subscription",
        costSource: "provider",
        cashCostUsd: 0,
      },
      stderrTail: "",
    }),
    classifyFailure: () => undefined,
  };
}

describe("Task 2.1 RED: Route Admission & Transport Registry", () => {
  describe("Pre-confirm route plan admission", () => {
    test("admits a valid route plan with registered capable backends", async () => {
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const step1 = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const step2 = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "opus",
      });

      const plan = createResolvedRoutePlan([step1, step2]);

      const admission = await admitRoutePlan(plan, registry);
      expect(admission.ok).toBe(true);
      expect(admission.admittedSteps).toHaveLength(2);
      expect(admission.admittedSteps[0].stepKey).toBe("hunter-reliability");
      expect(admission.admittedSteps[1].stepKey).toBe("refuter");
    });

    test("fails closed if a step backend is not registered in the registry", async () => {
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const routingConfig: RoutingConfig = {
        mappings: [
          {
            logical: "openai/gpt-4o",
            backend: "codex" as RunnerBackend,
            provider: "openai",
          },
        ],
      };

      const step1 = resolveStepRoute({
        stepKey: "hunter-resilience",
        role: "hunter",
        cliModel: "openai/gpt-4o",
        routingConfig,
      });

      const plan = createResolvedRoutePlan([step1]);

      expect(admitRoutePlan(plan, registry)).rejects.toThrow(
        RouteAdmissionError,
      );
    });

    test("fails closed if capability report contains blocking issues", async () => {
      const registry = new DefaultTransportRegistry();
      registry.register(
        "claude-code",
        createMockTransport("claude-code", {
          status: "blocking",
          issues: [
            {
              code: "binary_unresolved",
              message: "claude executable not found",
              blocking: true,
            },
          ],
        }),
      );

      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);

      expect(admitRoutePlan(plan, registry)).rejects.toThrow(
        RouteAdmissionError,
      );
    });
  });

  describe("Heterogeneous singular routes", () => {
    test("supports distinct admitted routes per stage with exactly one singular route per step", async () => {
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));
      registry.register(
        "opencode",
        createMockTransport("opencode", {
          billing: { mode: "subscription", pricingReady: true },
        }),
      );

      const routingConfig: RoutingConfig = {
        mappings: {
          "openai/o3-mini": {
            backend: "opencode",
            provider: "openai",
            modelFamily: "o3-mini",
            modelSnapshot: "o3-mini-2025-01-31",
          },
        },
      };

      const hunter1 = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
        routingConfig,
      });
      const hunter2 = resolveStepRoute({
        stepKey: "hunter-resilience",
        role: "hunter",
        cliModel: "haiku",
        routingConfig,
      });
      const refuter = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "openai/o3-mini",
        routingConfig,
      });

      const plan = createResolvedRoutePlan([hunter1, hunter2, refuter]);

      expect(hunter1.route.backend).toBe("claude-code");
      expect(hunter1.route.modelFamily).toBe(aliasModelFamily("sonnet"));

      expect(hunter2.route.backend).toBe("claude-code");
      expect(hunter2.route.modelFamily).toBe(aliasModelFamily("haiku"));

      expect(refuter.route.backend).toBe("opencode");
      expect(refuter.route.provider).toBe("openai");
      expect(refuter.route.modelFamily).toBe("o3-mini");

      // Evidence provided for opencode
      const evidence: D1_11ReadinessEvidence = {
        sdkAvailable: true,
        credentialAuthority: true,
        workspaceBroker: true,
        pricingReady: true,
      };

      const admission = await admitRoutePlan(plan, registry, {
        evidence: new Map([["opencode", evidence]]),
      });
      expect(admission.ok).toBe(true);
      expect(admission.admittedSteps).toHaveLength(3);
    });
  });

  describe("Exact route identity preservation", () => {
    test("preserves exact route fingerprints and immutability throughout admission", async () => {
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const step = resolveStepRoute({
        stepKey: "reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);

      const admission = await admitRoutePlan(plan, registry);
      expect(admission.plan.routeFingerprint).toBe(plan.routeFingerprint);
      expect(admission.admittedSteps[0].routeFingerprint).toBe(
        step.routeFingerprint,
      );
      expect(admission.admittedSteps[0].route).toEqual(step.route);
      expect(Object.isFrozen(admission.plan)).toBe(true);
    });
  });

  describe("D1-11 Reconciliation & Enablement Gate", () => {
    test("D1-11 outcome 1: incomplete prerequisites reject OpenCode in production mode", async () => {
      const registry = createDefaultTransportRegistry({ mode: "production" });

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

      // In production mode without D1-11 evidence, OpenCode admission must throw OpenCodeProductionGatedError
      let caughtError: unknown;
      try {
        await admitRoutePlan(plan, registry, { mode: "production" });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(OpenCodeProductionGatedError);
      expect((caughtError as Error).message).toContain("D1-11");
    });

    test("D1-11 checkD1_11Readiness identifies incomplete vs complete evidence", () => {
      const incomplete: D1_11ReadinessEvidence = {
        sdkAvailable: true,
        credentialAuthority: false,
        workspaceBroker: true,
        pricingReady: false,
      };

      const incompleteResult = checkD1_11Readiness(incomplete);
      expect(incompleteResult.ready).toBe(false);
      expect(incompleteResult.missing).toContain("credentialAuthority");
      expect(incompleteResult.missing).toContain("pricingReady");

      const complete: D1_11ReadinessEvidence = {
        sdkAvailable: true,
        credentialAuthority: true,
        workspaceBroker: true,
        pricingReady: true,
      };

      const completeResult = checkD1_11Readiness(complete);
      expect(completeResult.ready).toBe(true);
      expect(completeResult.missing).toHaveLength(0);
    });

    test("D1-11 outcome 2: complete evidence permits composition of OpenCode", async () => {
      const completeEvidence: D1_11ReadinessEvidence = {
        sdkAvailable: true,
        credentialAuthority: true,
        workspaceBroker: true,
        pricingReady: true,
      };

      const registry = createDefaultTransportRegistry({
        mode: "conformance",
        evidence: new Map([["opencode", completeEvidence]]),
        openCodeClient: {
          createSession: async () => ({ id: "sess-1" }),
          streamEvents: async function* () {},
          pollStatus: async () => ({
            kind: "terminal",
            proof: {
              eventId: "e1",
              providerStatus: "completed",
              providerObservedAt: new Date().toISOString(),
            },
          }),
          abort: async () => {},
        },
      });

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

      const admission = await admitRoutePlan(plan, registry, {
        evidence: new Map([["opencode", completeEvidence]]),
      });
      expect(admission.ok).toBe(true);
      expect(admission.admittedSteps[0].route.backend).toBe("opencode");
    });

    test("admitRoutePlan supports Map<RunnerBackend, ProviderCapabilityReport> as 2nd parameter", async () => {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);

      const capReport: ProviderCapabilityReport = {
        backend: "claude-code",
        status: "ready",
        auth: {
          kind: "claude_subscription_oauth",
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
      };

      const capabilitiesMap = new Map<RunnerBackend, ProviderCapabilityReport>([
        ["claude-code", capReport],
      ]);

      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const admission = await admitRoutePlan(plan, capabilitiesMap, registry);
      expect(admission.ok).toBe(true);
      expect(admission.reports.get("claude-code")).toBeDefined();
    });

    test("DefaultTransportRegistry caches created transport instances across get() calls", () => {
      const registry = new DefaultTransportRegistry();
      const t1 = registry.get("claude-code");
      const t2 = registry.get("claude-code");
      expect(t1).toBe(t2);
    });
  });
});
