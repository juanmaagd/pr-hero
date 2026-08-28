import { describe, expect, test } from "bun:test";
import { resolveRoutePlanAtConfirm } from "../src/cli";
import {
  createResolvedRoutePlan,
  resolveStepRoute,
} from "../src/model-routing";
import {
  DefaultTransportRegistry,
  OpenCodeProductionGatedError,
  RouteAdmissionError,
} from "../src/transport-registry";

describe("resolveRoutePlanAtConfirm", () => {
  const sonnetPlan = createResolvedRoutePlan([
    resolveStepRoute({
      stepKey: "hunter-reliability",
      role: "hunter",
      cliModel: "sonnet",
    }),
  ]);

  test("returns undefined when build fails and routing is not configured", async () => {
    const result = await resolveRoutePlanAtConfirm({
      routingConfigured: false,
      buildRoutePlan: async () => {
        throw new Error("unmapped model");
      },
    });
    expect(result).toBeUndefined();
  });

  test("rethrows build failures when routing is configured", async () => {
    await expect(
      resolveRoutePlanAtConfirm({
        routingConfigured: true,
        buildRoutePlan: async () => {
          throw new Error("unmapped model");
        },
      }),
    ).rejects.toThrow("unmapped model");
  });

  test("rethrows admission failures even when routing is not configured", async () => {
    const opencodePlan = createResolvedRoutePlan([
      resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "openai/gpt-4o",
        routingConfig: {
          mappings: {
            "openai/gpt-4o": {
              backend: "opencode",
              provider: "openai",
              modelFamily: "gpt-4o",
              modelSnapshot: "gpt-4o",
            },
          },
        },
      }),
    ]);

    await expect(
      resolveRoutePlanAtConfirm({
        routingConfigured: false,
        buildRoutePlan: async () => opencodePlan,
        registry: new DefaultTransportRegistry(),
      }),
    ).rejects.toThrow(OpenCodeProductionGatedError);
  });

  test("rethrows unregistered backend admission failures without routing config", async () => {
    const codexPlan = createResolvedRoutePlan([
      resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        specModel: "openai/gpt-4o",
        routingConfig: {
          mappings: {
            "openai/gpt-4o": {
              backend: "codex",
              provider: "openai",
              modelFamily: "gpt-4o",
              modelSnapshot: "gpt-4o",
            },
          },
        },
      }),
    ]);

    await expect(
      resolveRoutePlanAtConfirm({
        routingConfigured: false,
        buildRoutePlan: async () => codexPlan,
        registry: new DefaultTransportRegistry(),
      }),
    ).rejects.toThrow(RouteAdmissionError);
  });

  test("returns the plan when build and admission succeed", async () => {
    const result = await resolveRoutePlanAtConfirm({
      routingConfigured: false,
      buildRoutePlan: async () => sonnetPlan,
      registry: new DefaultTransportRegistry({ mode: "conformance" }),
    });
    expect(result).toBe(sonnetPlan);
  });
});
