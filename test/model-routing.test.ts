import { describe, expect, test } from "bun:test";
import {
  AmbiguousMappingError,
  computeRouteFingerprint,
  createResolvedRoutePlan,
  freezeRoutePlan,
  ModelRoutingError,
  parseLogicalIdentity,
  type ResolvedModelRoute,
  type ResolvedRoutePlan,
  type ResolvedStepRoute,
  type RoutingConfig,
  resolveLogicalModel,
  resolveModelRoute,
  resolveStepRoute,
  spawnModelForClaudeCli,
  UnauthorizedRouteError,
  UnmappedRouteError,
} from "../src/model-routing";
import { ReviewSpecValidationError, validateReviewSpec } from "../src/spec";

describe("Task 1.1: Model Routing - parseLogicalIdentity", () => {
  test("parses explicit aliases: sonnet, opus, haiku", () => {
    const sonnet = parseLogicalIdentity("sonnet");
    expect(sonnet.canonical).toBe("anthropic/claude-sonnet-5");
    expect(sonnet.provider).toBe("anthropic");
    expect(sonnet.model).toBe("claude-sonnet-5");
    expect(sonnet.alias).toBe("sonnet");
    expect(sonnet.variant).toBeUndefined();

    const opus = parseLogicalIdentity("opus");
    expect(opus.canonical).toBe("anthropic/claude-opus-5");
    expect(opus.provider).toBe("anthropic");
    expect(opus.model).toBe("claude-opus-5");
    expect(opus.alias).toBe("opus");
    expect(opus.variant).toBeUndefined();

    const haiku = parseLogicalIdentity("haiku");
    expect(haiku.canonical).toBe("anthropic/claude-haiku-4-5");
    expect(haiku.provider).toBe("anthropic");
    expect(haiku.model).toBe("claude-haiku-4-5");
    expect(haiku.alias).toBe("haiku");
    expect(haiku.variant).toBeUndefined();
  });

  test("parses slash grammar provider/model and provider/model#variant", () => {
    const gpt = parseLogicalIdentity("openai/gpt-4o");
    expect(gpt.canonical).toBe("openai/gpt-4o");
    expect(gpt.provider).toBe("openai");
    expect(gpt.model).toBe("gpt-4o");
    expect(gpt.variant).toBeUndefined();
    expect(gpt.alias).toBeUndefined();

    const o3 = parseLogicalIdentity("openai/o3-mini#high");
    expect(o3.canonical).toBe("openai/o3-mini#high");
    expect(o3.provider).toBe("openai");
    expect(o3.model).toBe("o3-mini");
    expect(o3.variant).toBe("high");
    expect(o3.alias).toBeUndefined();

    const openrouterClaude = parseLogicalIdentity(
      "anthropic/claude-3.7-sonnet#thinking",
    );
    expect(openrouterClaude.canonical).toBe(
      "anthropic/claude-3.7-sonnet#thinking",
    );
    expect(openrouterClaude.provider).toBe("anthropic");
    expect(openrouterClaude.model).toBe("claude-3.7-sonnet");
    expect(openrouterClaude.variant).toBe("thinking");
  });

  test("trims whitespace from input", () => {
    const sonnet = parseLogicalIdentity("  sonnet  ");
    expect(sonnet.canonical).toBe("anthropic/claude-sonnet-5");

    const slash = parseLogicalIdentity("  openai/gpt-4o#fast  ");
    expect(slash.canonical).toBe("openai/gpt-4o#fast");
    expect(slash.variant).toBe("fast");
  });

  test("rejects bare unknown strings without slash", () => {
    expect(() => parseLogicalIdentity("gpt-4o")).toThrow(ModelRoutingError);
    expect(() => parseLogicalIdentity("gemini-2.5-pro")).toThrow(/bare/i);
    expect(() => parseLogicalIdentity("llama3")).toThrow(ModelRoutingError);
  });

  test("rejects non-string, empty, blank, or invalid slash strings", () => {
    // @ts-expect-error test non-string input
    expect(() => parseLogicalIdentity(123)).toThrow(ModelRoutingError);
    // @ts-expect-error test null input
    expect(() => parseLogicalIdentity(null)).toThrow(ModelRoutingError);
    expect(() => parseLogicalIdentity("")).toThrow(ModelRoutingError);
    expect(() => parseLogicalIdentity("   ")).toThrow(ModelRoutingError);
    expect(() => parseLogicalIdentity("openai/")).toThrow(ModelRoutingError);
    expect(() => parseLogicalIdentity("/gpt-4o")).toThrow(ModelRoutingError);
    expect(() => parseLogicalIdentity("openai//gpt-4o")).toThrow(
      ModelRoutingError,
    );
    expect(() => parseLogicalIdentity("openai/gpt-4o#")).toThrow(
      ModelRoutingError,
    );
  });
});

describe("Task 1.1: Model Precedence (CLI > AgentSpec > frontmatter)", () => {
  test("CLI model overrides AgentSpec and frontmatter", () => {
    const resolved = resolveLogicalModel(
      "openai/gpt-4o",
      "opus",
      "haiku",
      "reliability",
    );
    expect(resolved).toBe("openai/gpt-4o");
  });

  test("AgentSpec model overrides frontmatter when CLI is unset", () => {
    const resolved = resolveLogicalModel(
      undefined,
      "opus",
      "haiku",
      "reliability",
    );
    expect(resolved).toBe("opus");
  });

  test("frontmatter model is used when CLI and AgentSpec are unset", () => {
    const resolved = resolveLogicalModel(
      undefined,
      undefined,
      "haiku",
      "reliability",
    );
    expect(resolved).toBe("haiku");
  });

  test("throws when no model is available anywhere", () => {
    expect(() =>
      resolveLogicalModel(undefined, undefined, undefined, "reliability"),
    ).toThrow(/reliability/);
  });
});

describe("Task 1.1: ReviewSpec validation - models[] rejection & model validation", () => {
  test("rejects agents with models property (including empty array [])", () => {
    expect(() =>
      validateReviewSpec({
        agents: [
          {
            key: "reliability",
            file: "deep-review-reliability.md",
            role: "hunter",
            models: [],
          },
          { key: "refuter", file: "review-refuter.md", role: "refuter" },
        ],
      }),
    ).toThrow(
      /agents\[0\]\.models is not supported in D2; fan-out is a D3 capability/,
    );

    expect(() =>
      validateReviewSpec({
        agents: [
          {
            key: "reliability",
            file: "deep-review-reliability.md",
            role: "hunter",
            models: ["sonnet", "opus"],
          },
          { key: "refuter", file: "review-refuter.md", role: "refuter" },
        ],
      }),
    ).toThrow(
      /agents\[0\]\.models is not supported in D2; fan-out is a D3 capability/,
    );
  });

  test("validates agent.model against aliases and slash grammar", () => {
    // Valid alias
    const validAlias = validateReviewSpec({
      agents: [
        {
          key: "reliability",
          file: "deep-review-reliability.md",
          role: "hunter",
          model: "sonnet",
        },
        { key: "refuter", file: "review-refuter.md", role: "refuter" },
      ],
    });
    expect(validAlias.agents[0].model).toBe("sonnet");

    // Valid slash grammar
    const validSlash = validateReviewSpec({
      agents: [
        {
          key: "reliability",
          file: "deep-review-reliability.md",
          role: "hunter",
          model: "openai/gpt-4o#high",
        },
        { key: "refuter", file: "review-refuter.md", role: "refuter" },
      ],
    });
    expect(validSlash.agents[0].model).toBe("openai/gpt-4o#high");

    // Invalid model throws ReviewSpecValidationError
    expect(() =>
      validateReviewSpec({
        agents: [
          {
            key: "reliability",
            file: "deep-review-reliability.md",
            role: "hunter",
            model: "unknown-bare-model",
          },
          { key: "refuter", file: "review-refuter.md", role: "refuter" },
        ],
      }),
    ).toThrow(ReviewSpecValidationError);
  });
});

describe("Task 1.1: resolveModelRoute - Gateways, Mappings, Errors", () => {
  test("unmapped alias without config resolves to default direct claude-code", () => {
    const sonnetRoute = resolveModelRoute("sonnet");
    expect(sonnetRoute).toEqual({
      backend: "claude-code",
      provider: "anthropic",
      gateway: "direct",
      modelFamily: "claude-sonnet-5",
      modelSnapshot: "claude-sonnet-5",
    });

    const opusRoute = resolveModelRoute("opus");
    expect(opusRoute).toEqual({
      backend: "claude-code",
      provider: "anthropic",
      gateway: "direct",
      modelFamily: "claude-opus-5",
      modelSnapshot: "claude-opus-5",
    });

    const haikuRoute = resolveModelRoute("haiku");
    expect(haikuRoute).toEqual({
      backend: "claude-code",
      provider: "anthropic",
      gateway: "direct",
      modelFamily: "claude-haiku-4-5",
      modelSnapshot: "claude-haiku-4-5",
    });
  });

  test("exact configured|direct|openrouter gateways from config mappings", () => {
    const config: RoutingConfig = {
      mappings: [
        {
          logical: "anthropic/claude-sonnet-5",
          backend: "claude-code",
          provider: "anthropic",
          gateway: "direct",
          modelFamily: "claude-sonnet-5",
          modelSnapshot: "claude-sonnet-5-20250219",
        },
        {
          logical: "openai/gpt-4o",
          backend: "opencode",
          provider: "openai",
          gateway: "configured",
          modelFamily: "gpt-4o",
          modelSnapshot: "gpt-4o-2024-08-06",
        },
        {
          logical: "deepseek/deepseek-r1",
          backend: "opencode",
          provider: "deepseek",
          gateway: "openrouter",
          modelFamily: "deepseek-r1",
          modelSnapshot: "deepseek/deepseek-r1",
        },
      ],
    };

    const direct = resolveModelRoute("sonnet", config);
    expect(direct.gateway).toBe("direct");
    expect(direct.backend).toBe("claude-code");

    const configured = resolveModelRoute("openai/gpt-4o", config);
    expect(configured.gateway).toBe("configured");
    expect(configured.backend).toBe("opencode");
    expect(configured.provider).toBe("openai");

    const openrouter = resolveModelRoute("deepseek/deepseek-r1", config);
    expect(openrouter.gateway).toBe("openrouter");
    expect(openrouter.backend).toBe("opencode");
  });

  test("preserves variant in resolved route", () => {
    const config: RoutingConfig = {
      mappings: [
        {
          logical: "openai/o3-mini#high",
          backend: "opencode",
          provider: "openai",
          gateway: "configured",
          modelFamily: "o3-mini",
          modelSnapshot: "o3-mini-2025-01-31",
          modelVariant: "high",
        },
      ],
    };

    const route = resolveModelRoute("openai/o3-mini#high", config);
    expect(route.modelVariant).toBe("high");
  });

  test("unmapped non-alias without default throws UnmappedRouteError", () => {
    expect(() => resolveModelRoute("openai/gpt-4o")).toThrow(
      UnmappedRouteError,
    );
    expect(() => resolveModelRoute("openai/gpt-4o", { mappings: [] })).toThrow(
      UnmappedRouteError,
    );
    expect(() =>
      resolveModelRoute("anthropic/claude-sonnet-5", { mappings: [] }),
    ).toThrow(UnmappedRouteError);
  });

  test("unmapped non-alias with default resolves to default mapping", () => {
    const config: RoutingConfig = {
      default: {
        backend: "opencode",
        provider: "openrouter",
        gateway: "openrouter",
        modelFamily: "auto",
        modelSnapshot: "auto",
      },
    };

    const route = resolveModelRoute("google/gemini-2.5-flash", config);
    expect(route.backend).toBe("opencode");
    expect(route.provider).toBe("openrouter");
    expect(route.gateway).toBe("openrouter");
  });

  test("duplicate mapping throws AmbiguousMappingError", () => {
    const config: RoutingConfig = {
      mappings: [
        {
          logical: "openai/gpt-4o",
          backend: "opencode",
          provider: "openai",
          gateway: "configured",
          modelFamily: "gpt-4o",
          modelSnapshot: "gpt-4o-1",
        },
        {
          logical: "openai/gpt-4o",
          backend: "opencode",
          provider: "openai",
          gateway: "openrouter",
          modelFamily: "gpt-4o",
          modelSnapshot: "gpt-4o-2",
        },
      ],
    };

    expect(() => resolveModelRoute("openai/gpt-4o", config)).toThrow(
      AmbiguousMappingError,
    );
  });

  test("disabled spend throws UnauthorizedRouteError", () => {
    const config: RoutingConfig = {
      mappings: [
        {
          logical: "openai/gpt-4o",
          backend: "opencode",
          provider: "openai",
          gateway: "configured",
          modelFamily: "gpt-4o",
          modelSnapshot: "gpt-4o",
          disabled: true,
        },
        {
          logical: "anthropic/claude-sonnet-5",
          backend: "claude-code",
          provider: "anthropic",
          gateway: "direct",
          modelFamily: "claude-sonnet-5",
          modelSnapshot: "claude-sonnet-5",
          allowSpend: false,
        },
      ],
    };

    expect(() => resolveModelRoute("openai/gpt-4o", config)).toThrow(
      UnauthorizedRouteError,
    );
    expect(() => resolveModelRoute("sonnet", config)).toThrow(
      UnauthorizedRouteError,
    );
  });

  test("config.disabled throws UnauthorizedRouteError", () => {
    const config: RoutingConfig = {
      disabled: true,
      mappings: [
        {
          logical: "openai/gpt-4o",
          backend: "opencode",
          provider: "openai",
        },
      ],
    };
    expect(() => resolveModelRoute("openai/gpt-4o", config)).toThrow(
      UnauthorizedRouteError,
    );
  });

  test("resolves route from record mappings object", () => {
    const config: RoutingConfig = {
      mappings: {
        "openai/gpt-4o": {
          backend: "opencode",
          provider: "openai",
          gateway: "configured",
          modelFamily: "gpt-4o",
          modelSnapshot: "gpt-4o-2024-08-06",
        },
        sonnet: {
          backend: "claude-code",
          provider: "anthropic",
          gateway: "direct",
          modelFamily: "claude-sonnet-5",
          modelSnapshot: "claude-sonnet-5",
          disabled: true,
        },
      },
    };

    const route = resolveModelRoute("openai/gpt-4o", config);
    expect(route.backend).toBe("opencode");
    expect(route.provider).toBe("openai");
    expect(route.gateway).toBe("configured");

    expect(() => resolveModelRoute("sonnet", config)).toThrow(
      UnauthorizedRouteError,
    );
  });

  test("record mappings with multiple matching keys (alias + canonical) throws AmbiguousMappingError", () => {
    const config: RoutingConfig = {
      mappings: {
        sonnet: {
          backend: "claude-code",
          provider: "anthropic",
          disabled: true,
        },
        "anthropic/claude-sonnet-5": {
          backend: "claude-code",
          provider: "anthropic",
          disabled: false,
        },
      },
    };

    expect(() => resolveModelRoute("sonnet", config)).toThrow(
      AmbiguousMappingError,
    );
    expect(() =>
      resolveModelRoute("anthropic/claude-sonnet-5", config),
    ).toThrow(AmbiguousMappingError);
  });

  test("disabled default route throws UnauthorizedRouteError", () => {
    const disabledDef: RoutingConfig = {
      default: {
        backend: "opencode",
        provider: "openrouter",
        disabled: true,
      },
    };
    expect(() =>
      resolveModelRoute("google/gemini-2.5-pro", disabledDef),
    ).toThrow(UnauthorizedRouteError);

    const noSpendDef: RoutingConfig = {
      default: {
        backend: "opencode",
        provider: "openrouter",
        allowSpend: false,
      },
    };
    expect(() =>
      resolveModelRoute("google/gemini-2.5-pro", noSpendDef),
    ).toThrow(UnauthorizedRouteError);
  });
});

describe("Task 1.1: Deterministic Fingerprint, Plan Freeze, Secret-Free Guarantee", () => {
  test("computes deterministic SHA-256 fingerprint over canonical logical + target dimensions", () => {
    const route: ResolvedModelRoute = {
      backend: "claude-code",
      provider: "anthropic",
      gateway: "direct",
      modelFamily: "claude-sonnet-5",
      modelSnapshot: "claude-sonnet-5-20250219",
      modelVariant: "thinking",
    };

    const fp1 = computeRouteFingerprint(
      "anthropic/claude-sonnet-5#thinking",
      route,
    );
    const fp2 = computeRouteFingerprint(
      "anthropic/claude-sonnet-5#thinking",
      route,
    );
    expect(fp1).toBeString();
    expect(fp1).toHaveLength(64);
    expect(fp1).toBe(fp2);

    // Changing any target dimension changes the fingerprint
    const fpDiff = computeRouteFingerprint(
      "anthropic/claude-sonnet-5#thinking",
      {
        ...route,
        gateway: "configured",
      },
    );
    expect(fpDiff).not.toBe(fp1);
  });

  test("fingerprint and error messages never include credentials or secret tokens", () => {
    const secretToken = "sk-ant-api03-abcdef1234567890_super_secret_token";
    const route: ResolvedModelRoute = {
      backend: "opencode",
      provider: "openai",
      gateway: "configured",
      modelFamily: "gpt-4o",
      modelSnapshot: "gpt-4o",
    };

    const fp = computeRouteFingerprint("openai/gpt-4o", route);
    expect(fp).not.toContain(secretToken);
    expect(fp).toHaveLength(64);

    // Errors thrown by model routing redact secrets
    try {
      parseLogicalIdentity(`invalid/${secretToken}`);
    } catch (err: unknown) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(secretToken);
      expect(msg).toContain("[REDACTED]");
    }
  });

  test("freezeRoutePlan recursively freezes whole route plan immutably", () => {
    const stepRoute: ResolvedStepRoute = {
      stepKey: "reliability",
      role: "hunter",
      logicalIdentity: "anthropic/claude-sonnet-5",
      route: {
        backend: "claude-code",
        provider: "anthropic",
        gateway: "direct",
        modelFamily: "claude-sonnet-5",
        modelSnapshot: "claude-sonnet-5",
      },
      routeFingerprint: "a".repeat(64),
    };

    const plan: ResolvedRoutePlan = {
      steps: [stepRoute],
      routeFingerprint: "b".repeat(64),
    };

    const frozen = freezeRoutePlan(plan);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.steps)).toBe(true);
    expect(Object.isFrozen(frozen.steps[0])).toBe(true);
    expect(Object.isFrozen(frozen.steps[0].route)).toBe(true);

    expect(() => {
      // @ts-expect-error test mutating frozen plan
      frozen.steps = [];
    }).toThrow();
  });

  test("resolveStepRoute and createResolvedRoutePlan build end-to-end frozen plan", () => {
    const step = resolveStepRoute({
      stepKey: "reliability",
      role: "hunter",
      cliModel: "sonnet",
    });

    expect(step.stepKey).toBe("reliability");
    expect(step.role).toBe("hunter");
    expect(step.logicalIdentity).toBe("anthropic/claude-sonnet-5");
    expect(step.route.backend).toBe("claude-code");
    expect(step.routeFingerprint).toHaveLength(64);

    const plan = createResolvedRoutePlan([step]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.routeFingerprint).toBeString();
  });
});

describe("spawnModelForClaudeCli", () => {
  test("direct gateway passes the logical alias to Claude Code --model", () => {
    expect(
      spawnModelForClaudeCli(
        {
          backend: "claude-code",
          provider: "anthropic",
          gateway: "direct",
          modelFamily: "claude-sonnet-5",
          modelSnapshot: "claude-sonnet-5",
        },
        "sonnet",
      ),
    ).toBe("sonnet");
  });

  test("configured gateway passes the operator snapshot to Claude Code --model", () => {
    expect(
      spawnModelForClaudeCli(
        {
          backend: "claude-code",
          provider: "anthropic",
          gateway: "configured",
          modelFamily: "claude-sonnet-5",
          modelSnapshot: "claude-sonnet-5-20250219",
        },
        "sonnet",
      ),
    ).toBe("claude-sonnet-5-20250219");
  });
});
