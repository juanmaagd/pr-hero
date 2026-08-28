import anthropicCatalog from "../config/models/anthropic.json";
import type { RunnerBackend } from "./execution/contracts";

export interface CatalogAliasModel {
  readonly modelFamily: string;
  readonly modelSnapshot: string;
}

export interface ProviderModelCatalog {
  readonly provider: string;
  readonly defaultBackend?: RunnerBackend;
  readonly aliases: Readonly<Record<string, CatalogAliasModel>>;
}

export interface ResolvedCatalogAlias {
  readonly provider: string;
  readonly alias: string;
  readonly modelFamily: string;
  readonly modelSnapshot: string;
  readonly canonical: string;
  readonly defaultBackend?: RunnerBackend;
}

function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`model catalog: ${label} must be a non-empty string`);
  }
}

function normalizeProviderCatalog(raw: unknown): ProviderModelCatalog {
  if (!raw || typeof raw !== "object") {
    throw new Error("model catalog: provider entry must be an object");
  }
  const record = raw as Record<string, unknown>;
  assertNonEmptyString(record.provider, "provider");
  if (
    record.defaultBackend !== undefined &&
    typeof record.defaultBackend !== "string"
  ) {
    throw new Error("model catalog: defaultBackend must be a string");
  }
  if (!record.aliases || typeof record.aliases !== "object") {
    throw new Error(
      `model catalog: ${record.provider} aliases must be an object`,
    );
  }

  const aliases: Record<string, CatalogAliasModel> = {};
  for (const [alias, entry] of Object.entries(
    record.aliases as Record<string, unknown>,
  )) {
    assertNonEmptyString(alias, `${record.provider}.alias key`);
    if (!entry || typeof entry !== "object") {
      throw new Error(
        `model catalog: ${record.provider}.aliases.${alias} must be an object`,
      );
    }
    const model = entry as Record<string, unknown>;
    assertNonEmptyString(
      model.modelFamily,
      `${record.provider}.aliases.${alias}.modelFamily`,
    );
    assertNonEmptyString(
      model.modelSnapshot,
      `${record.provider}.aliases.${alias}.modelSnapshot`,
    );
    aliases[alias] = {
      modelFamily: model.modelFamily as string,
      modelSnapshot: model.modelSnapshot as string,
    };
  }

  if (Object.keys(aliases).length === 0) {
    throw new Error(`model catalog: ${record.provider} must define aliases`);
  }

  return {
    provider: record.provider as string,
    ...(record.defaultBackend === undefined
      ? {}
      : { defaultBackend: record.defaultBackend as RunnerBackend }),
    aliases,
  };
}

function canonicalIdentity(provider: string, modelFamily: string): string {
  return `${provider}/${modelFamily}`;
}

const PROVIDER_CATALOGS = {
  anthropic: normalizeProviderCatalog(anthropicCatalog),
} as const satisfies Record<string, ProviderModelCatalog>;

export const MODEL_CATALOG = Object.freeze({
  providers: PROVIDER_CATALOGS,
});

const aliasIndex = new Map<string, ResolvedCatalogAlias>();
const canonicalToAlias = new Map<string, string>();

for (const catalog of Object.values(PROVIDER_CATALOGS)) {
  for (const [alias, model] of Object.entries(catalog.aliases)) {
    if (aliasIndex.has(alias)) {
      throw new Error(`model catalog: duplicate alias "${alias}"`);
    }
    const canonical = canonicalIdentity(catalog.provider, model.modelFamily);
    if (canonicalToAlias.has(canonical)) {
      throw new Error(`model catalog: duplicate canonical "${canonical}"`);
    }
    const resolved: ResolvedCatalogAlias = {
      provider: catalog.provider,
      alias,
      modelFamily: model.modelFamily,
      modelSnapshot: model.modelSnapshot,
      canonical,
      ...(catalog.defaultBackend === undefined
        ? {}
        : { defaultBackend: catalog.defaultBackend }),
    };
    aliasIndex.set(alias, resolved);
    canonicalToAlias.set(canonical, alias);
  }
}

export type ModelAlias = "sonnet" | "opus" | "haiku";

const REQUIRED_ALIASES: readonly ModelAlias[] = ["sonnet", "opus", "haiku"];
for (const alias of REQUIRED_ALIASES) {
  if (!aliasIndex.has(alias)) {
    throw new Error(`model catalog: missing required alias "${alias}"`);
  }
}

export function isModelAlias(value: string): value is ModelAlias {
  return aliasIndex.has(value);
}

export function allModelAliases(): readonly ModelAlias[] {
  return Object.freeze([...aliasIndex.keys()] as ModelAlias[]);
}

export function lookupAlias(alias: ModelAlias): ResolvedCatalogAlias {
  const entry = aliasIndex.get(alias);
  if (entry === undefined) {
    throw new Error(`model catalog: unknown alias "${alias}"`);
  }
  return entry;
}

export function aliasCanonical(alias: ModelAlias): string {
  return lookupAlias(alias).canonical;
}

export function aliasModelFamily(alias: ModelAlias): string {
  return lookupAlias(alias).modelFamily;
}

export function aliasModelSnapshot(alias: ModelAlias): string {
  return lookupAlias(alias).modelSnapshot;
}

export function reverseAliasForCanonical(
  canonical: string,
): ModelAlias | undefined {
  const alias = canonicalToAlias.get(canonical);
  return alias === undefined ? undefined : (alias as ModelAlias);
}

export function providerCatalog(
  provider: keyof typeof PROVIDER_CATALOGS,
): ProviderModelCatalog {
  return PROVIDER_CATALOGS[provider];
}
