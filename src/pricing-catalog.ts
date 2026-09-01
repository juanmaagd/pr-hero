import anthropicPricing from "../config/models/anthropic-pricing.json";
import { aliasModelSnapshot, isModelAlias } from "./model-catalog";

// #137. How long a fetched price table is allowed to speak for the provider.
//
// WHY there is an expiry at all, and why it is the point of this module:
// provider prices change, and a table that silently goes stale reports a
// CONFIDENT WRONG number. That is strictly worse than reporting none — the
// metered gate exists precisely to refuse billing an unknown amount, and a
// stale quote defeats it by making the unknown look known. So a stale
// catalogue degrades to `tokenPricingAvailable: false` and the metered route
// is refused, rather than being billed at last quarter's rate.
//
// WHY that is safe rather than harsh: a metered route is refused TODAY,
// unconditionally, at every hardcoded `pricingReady: false` site. This
// catalogue can only ever WIDEN what is admissible, never narrow it. No
// working route can break from staleness — the worst case is the status quo,
// arrived at loudly (doctor reports the age) instead of silently.
//
// WHY the file carries `fetched_at` at all, in one paid-for example: Sonnet 5's
// $2/$10 was published as introductory pricing through 2026-08-31, with a rise
// to $3/$15 scheduled for 2026-09-01. That rise was CANCELLED and $2/$10 is now
// standard. A catalogue built from a source cached a day earlier would have
// shipped $3/$15 — a price that never existed. The stamp is what makes that
// class of error observable instead of permanent.
export const PRICING_MAX_AGE_DAYS = 90;

const DAY_MS = 86_400_000;

export interface ModelPricing {
  readonly input: number;
  readonly cache_write_5m: number;
  readonly cache_write_1h: number;
  readonly cache_read: number;
  readonly output: number;
}

export interface PricingCatalog {
  readonly provider: string;
  readonly source_url: string;
  readonly fetched_at: string;
  readonly currency: string;
  readonly unit: string;
  readonly batch_multiplier: number;
  readonly models: Readonly<Record<string, ModelPricing>>;
}

const RATE_FIELDS = [
  "input",
  "cache_write_5m",
  "cache_write_1h",
  "cache_read",
  "output",
] as const satisfies readonly (keyof ModelPricing)[];

// Fail-loud at import, like model-catalog.ts's normalizeProviderCatalog. The
// JSON field names are mirrored verbatim into ModelPricing on purpose: a
// camelCase-to-snake_case mapping layer is one more place two rate fields can
// be transposed, and a transposed rate is a wrong bill that every type check
// still passes.
function normalizePricingCatalog(raw: unknown): PricingCatalog {
  if (!raw || typeof raw !== "object") {
    throw new Error("pricing catalog: root must be an object");
  }
  const record = raw as Record<string, unknown>;
  for (const key of [
    "provider",
    "source_url",
    "fetched_at",
    "currency",
    "unit",
  ] as const) {
    if (typeof record[key] !== "string" || record[key].trim().length === 0) {
      throw new Error(`pricing catalog: ${key} must be a non-empty string`);
    }
  }
  if (Number.isNaN(Date.parse(record.fetched_at as string))) {
    throw new Error("pricing catalog: fetched_at must be an ISO date");
  }
  if (
    typeof record.batch_multiplier !== "number" ||
    !Number.isFinite(record.batch_multiplier)
  ) {
    throw new Error(
      "pricing catalog: batch_multiplier must be a finite number",
    );
  }
  if (!record.models || typeof record.models !== "object") {
    throw new Error("pricing catalog: models must be an object");
  }

  const models: Record<string, ModelPricing> = {};
  for (const [modelId, entry] of Object.entries(
    record.models as Record<string, unknown>,
  )) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`pricing catalog: models.${modelId} must be an object`);
    }
    const rates = entry as Record<string, unknown>;
    for (const field of RATE_FIELDS) {
      const value = rates[field];
      // A missing or string-typed rate would otherwise reach arithmetic as
      // undefined/NaN and produce a cost of NaN — which reads as "we computed
      // something" rather than "we have no price".
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(
          `pricing catalog: models.${modelId}.${field} must be a finite non-negative number`,
        );
      }
    }
    models[modelId] = {
      input: rates.input as number,
      cache_write_5m: rates.cache_write_5m as number,
      cache_write_1h: rates.cache_write_1h as number,
      cache_read: rates.cache_read as number,
      output: rates.output as number,
    };
  }

  if (Object.keys(models).length === 0) {
    throw new Error("pricing catalog: models must not be empty");
  }

  return {
    provider: record.provider as string,
    source_url: record.source_url as string,
    fetched_at: record.fetched_at as string,
    currency: record.currency as string,
    unit: record.unit as string,
    batch_multiplier: record.batch_multiplier,
    models: Object.freeze(models),
  };
}

export const PRICING_CATALOG: PricingCatalog = Object.freeze(
  normalizePricingCatalog(anthropicPricing),
);

const FETCHED_AT_MS = Date.parse(PRICING_CATALOG.fetched_at);

// Exact model id, or a logical alias. Alias knowledge is NOT duplicated here:
// model-catalog.ts owns the alias -> snapshot mapping and is the only place
// that may answer it, so an alias repointed there repoints its price too.
export function lookupModelPricing(modelId: string): ModelPricing | undefined {
  const resolved = isModelAlias(modelId)
    ? aliasModelSnapshot(modelId)
    : modelId;
  // Object.hasOwn, not a bare index. `models` is a plain object, so indexing
  // it with an arbitrary model id reaches Object.prototype: `lookupModelPricing
  // ("constructor")` returned the Object constructor, and every prototype
  // member made tokenPricingAvailableFor answer TRUE for a model that does not
  // exist. That is the precise failure this module was built to prevent -- a
  // confident wrong price instead of an honest absent one -- arriving through
  // the language rather than through a stale table.
  //
  // Found by pr-hero reviewing this module's own PR (#162).
  if (!Object.hasOwn(PRICING_CATALOG.models, resolved)) return undefined;
  return PRICING_CATALOG.models[resolved];
}

// Whole days, floored: a table fetched this morning is zero days old all day.
export function pricingCatalogAge(now: Date): number {
  return Math.floor((now.getTime() - FETCHED_AT_MS) / DAY_MS);
}

export function isPricingCatalogFresh(now: Date): boolean {
  return pricingCatalogAge(now) < PRICING_MAX_AGE_DAYS;
}

// The one predicate a `pricingReady` site should call. Membership alone is not
// enough — see PRICING_MAX_AGE_DAYS: a known model at an expired price is the
// confident-wrong case the metered gate exists to prevent.
export function tokenPricingAvailableFor(modelId: string, now: Date): boolean {
  return (
    lookupModelPricing(modelId) !== undefined && isPricingCatalogFresh(now)
  );
}
