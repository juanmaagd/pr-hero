import { createHash } from "node:crypto";
import type { ResolvedModelRoute, RunnerBackend } from "./execution/contracts";
import { redactDiagnostic } from "./security/redact";

export type ModelGateway = "configured" | "direct" | "openrouter";
export type { ResolvedModelRoute, RunnerBackend };

export interface RouteMapping {
  readonly logical?: string;
  readonly backend: RunnerBackend;
  readonly provider: string;
  readonly gateway?: ModelGateway;
  readonly modelFamily?: string;
  readonly modelSnapshot?: string;
  readonly modelVariant?: string;
  readonly disabled?: boolean;
  readonly allowSpend?: boolean;
}

export interface RoutingConfig {
  readonly default?: RouteMapping;
  readonly mappings?: readonly RouteMapping[] | Record<string, RouteMapping>;
  readonly disabled?: boolean;
}

export interface ParsedLogicalIdentity {
  readonly raw: string;
  readonly canonical: string;
  readonly provider: string;
  readonly model: string;
  readonly variant?: string;
  readonly alias?: "sonnet" | "opus" | "haiku";
}

export interface ResolvedStepRoute {
  readonly stepKey: string;
  readonly role: string;
  readonly logicalIdentity: string;
  readonly route: ResolvedModelRoute;
  readonly routeFingerprint: string;
}

export interface ResolvedRoutePlan {
  readonly planId?: string;
  readonly steps: readonly ResolvedStepRoute[];
  readonly routeFingerprint?: string;
}

export class ModelRoutingError extends Error {}
export class UnmappedRouteError extends ModelRoutingError {}
export class AmbiguousMappingError extends ModelRoutingError {}
export class UnauthorizedRouteError extends ModelRoutingError {}

const CANONICAL_ALIASES: Record<
  "sonnet" | "opus" | "haiku",
  {
    provider: string;
    model: string;
    canonical: string;
    alias: "sonnet" | "opus" | "haiku";
  }
> = {
  sonnet: {
    provider: "anthropic",
    model: "claude-3-7-sonnet",
    canonical: "anthropic/claude-3-7-sonnet",
    alias: "sonnet",
  },
  opus: {
    provider: "anthropic",
    model: "claude-3-opus",
    canonical: "anthropic/claude-3-opus",
    alias: "opus",
  },
  haiku: {
    provider: "anthropic",
    model: "claude-3-5-haiku",
    canonical: "anthropic/claude-3-5-haiku",
    alias: "haiku",
  },
};

const SLASH_GRAMMAR_REGEX =
  /^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9._-]+)(?:#([a-zA-Z0-9._-]+))?$/;

export function parseLogicalIdentity(raw: string): ParsedLogicalIdentity {
  if (typeof raw !== "string") {
    throw new ModelRoutingError("Model identity must be a string");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ModelRoutingError("Model identity cannot be empty");
  }

  if (trimmed === "sonnet" || trimmed === "opus" || trimmed === "haiku") {
    const aliasInfo = CANONICAL_ALIASES[trimmed];
    return {
      raw: trimmed,
      canonical: aliasInfo.canonical,
      provider: aliasInfo.provider,
      model: aliasInfo.model,
      alias: aliasInfo.alias,
    };
  }

  const match = trimmed.match(SLASH_GRAMMAR_REGEX);
  if (match) {
    const [, provider, model, variant] = match;
    const canonical = `${provider}/${model}${variant ? `#${variant}` : ""}`;
    return {
      raw: trimmed,
      canonical,
      provider,
      model,
      ...(variant !== undefined ? { variant } : {}),
    };
  }

  const safeRaw = redactDiagnostic(raw);
  throw new ModelRoutingError(
    `Unknown model identity "${safeRaw}": bare model names must be an alias (sonnet|opus|haiku) or use slash grammar provider/model(#variant)`,
  );
}

export function resolveModelRoute(
  logicalInput: string,
  config?: RoutingConfig,
): ResolvedModelRoute {
  const parsed = parseLogicalIdentity(logicalInput);
  const reverseAlias = (
    Object.keys(CANONICAL_ALIASES) as Array<keyof typeof CANONICAL_ALIASES>
  ).find((k) => CANONICAL_ALIASES[k].canonical === parsed.canonical);

  if (config !== undefined) {
    if (config.disabled === true) {
      throw new UnauthorizedRouteError(
        redactDiagnostic(
          `Spend is disabled for model route "${parsed.canonical}"`,
        ),
      );
    }

    if (config.mappings !== undefined) {
      if (Array.isArray(config.mappings)) {
        const matches = config.mappings.filter((entry) => {
          if (!entry || typeof entry !== "object") return false;
          if (entry.logical === parsed.canonical) return true;
          if (entry.logical === parsed.raw) return true;
          if (parsed.alias && entry.logical === parsed.alias) return true;
          if (reverseAlias && entry.logical === reverseAlias) return true;
          return false;
        });

        if (matches.length > 1) {
          throw new AmbiguousMappingError(
            redactDiagnostic(
              `Ambiguous model routing: found ${matches.length} duplicate mappings for "${parsed.canonical}"`,
            ),
          );
        }

        if (matches.length === 1) {
          const m = matches[0];
          if (m.disabled === true || m.allowSpend === false) {
            throw new UnauthorizedRouteError(
              redactDiagnostic(
                `Spend is disabled for model route "${parsed.canonical}"`,
              ),
            );
          }
          return {
            backend: m.backend,
            provider: m.provider,
            gateway: m.gateway ?? "configured",
            modelFamily: m.modelFamily ?? parsed.model,
            modelSnapshot: m.modelSnapshot ?? parsed.model,
            ...(m.modelVariant !== undefined || parsed.variant !== undefined
              ? { modelVariant: m.modelVariant ?? parsed.variant }
              : {}),
          };
        }
      } else if (
        typeof config.mappings === "object" &&
        config.mappings !== null
      ) {
        const record = config.mappings as Record<string, RouteMapping>;
        const candidateKeys = Array.from(
          new Set(
            [parsed.canonical, parsed.alias, reverseAlias, parsed.raw].filter(
              (key): key is string => key !== undefined,
            ),
          ),
        );
        const matchedKeys = candidateKeys.filter((key) => key in record);

        if (matchedKeys.length > 1) {
          throw new AmbiguousMappingError(
            redactDiagnostic(
              `Ambiguous model routing: found ${matchedKeys.length} duplicate mappings for "${parsed.canonical}" in record mappings`,
            ),
          );
        }

        const m = matchedKeys.length > 0 ? record[matchedKeys[0]] : undefined;

        if (m !== undefined) {
          if (m.disabled === true || m.allowSpend === false) {
            throw new UnauthorizedRouteError(
              redactDiagnostic(
                `Spend is disabled for model route "${parsed.canonical}"`,
              ),
            );
          }
          return {
            backend: m.backend,
            provider: m.provider,
            gateway: m.gateway ?? "configured",
            modelFamily: m.modelFamily ?? parsed.model,
            modelSnapshot: m.modelSnapshot ?? parsed.model,
            ...(m.modelVariant !== undefined || parsed.variant !== undefined
              ? { modelVariant: m.modelVariant ?? parsed.variant }
              : {}),
          };
        }
      }
    }

    if (config.default !== undefined) {
      const def = config.default;
      if (def.disabled === true || def.allowSpend === false) {
        throw new UnauthorizedRouteError(
          redactDiagnostic("Spend is disabled for default model route"),
        );
      }
      return {
        backend: def.backend,
        provider: def.provider,
        gateway: def.gateway ?? "configured",
        modelFamily: def.modelFamily ?? parsed.model,
        modelSnapshot: def.modelSnapshot ?? parsed.model,
        ...(def.modelVariant !== undefined || parsed.variant !== undefined
          ? { modelVariant: def.modelVariant ?? parsed.variant }
          : {}),
      };
    }
  }

  if (parsed.alias !== undefined) {
    return {
      backend: "claude-code",
      provider: "anthropic",
      gateway: "direct",
      modelFamily: parsed.model,
      modelSnapshot: parsed.model,
      ...(parsed.variant !== undefined ? { modelVariant: parsed.variant } : {}),
    };
  }

  throw new UnmappedRouteError(
    redactDiagnostic(
      `No route mapping found for logical model "${parsed.canonical}"`,
    ),
  );
}

export function computeRouteFingerprint(
  canonicalLogical: string,
  route: ResolvedModelRoute,
): string {
  const payload = JSON.stringify({
    logical: canonicalLogical,
    backend: route.backend,
    provider: route.provider,
    gateway: route.gateway ?? "",
    modelFamily: route.modelFamily,
    modelSnapshot: route.modelSnapshot,
    modelVariant: route.modelVariant ?? "",
  });
  return createHash("sha256").update(payload).digest("hex");
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

export function freezeRoutePlan(plan: ResolvedRoutePlan): ResolvedRoutePlan {
  return deepFreeze(plan);
}

export function resolveLogicalModel(
  cliModel?: string,
  specModel?: string,
  frontmatterModel?: string,
  stepName?: string,
): string {
  const model = cliModel ?? specModel ?? frontmatterModel;
  if (!model || (typeof model === "string" && model.trim().length === 0)) {
    throw new ModelRoutingError(
      `agent ${stepName ?? "step"} has no model and no override given`,
    );
  }
  return model.trim();
}

export interface ResolveStepRouteInput {
  readonly stepKey: string;
  readonly role: string;
  readonly cliModel?: string;
  readonly specModel?: string;
  readonly frontmatterModel?: string;
  readonly routingConfig?: RoutingConfig;
}

export function resolveStepRoute(
  input: ResolveStepRouteInput,
): ResolvedStepRoute {
  const logical = resolveLogicalModel(
    input.cliModel,
    input.specModel,
    input.frontmatterModel,
    input.stepKey,
  );
  const parsed = parseLogicalIdentity(logical);
  const route = resolveModelRoute(logical, input.routingConfig);
  const routeFingerprint = computeRouteFingerprint(parsed.canonical, route);
  return {
    stepKey: input.stepKey,
    role: input.role,
    logicalIdentity: parsed.canonical,
    route,
    routeFingerprint,
  };
}

export function createResolvedRoutePlan(
  steps: readonly ResolvedStepRoute[],
): ResolvedRoutePlan {
  const sortedFingerprints = steps
    .map((s) => `${s.stepKey}:${s.routeFingerprint}`)
    .sort()
    .join(";");
  const planFingerprint = createHash("sha256")
    .update(sortedFingerprints)
    .digest("hex");
  const plan: ResolvedRoutePlan = {
    steps,
    routeFingerprint: planFingerprint,
  };
  return freezeRoutePlan(plan);
}
