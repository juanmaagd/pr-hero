import anthropicPricing from "../config/models/anthropic-pricing.json";
import zaiPricing from "../config/models/zai-pricing.json";
import { isModelAlias, lookupAlias } from "./model-catalog";

// #137. How long a fetched price table is allowed to speak for its provider.
//
// WHY there is an expiry at all, and why it is the point of this module:
// provider prices change, and a table that silently goes stale reports a
// CONFIDENT WRONG number. That is strictly worse than reporting none — the
// metered gate exists precisely to refuse billing an unknown amount, and a
// stale quote defeats it by making the unknown look known. So a stale
// catalogue degrades to `tokenPricingAvailable: false` and the metered route
// is refused, rather than being billed at last quarter's rate.
//
// WHY that is safe rather than harsh: a metered route with no priceable model
// is refused ANYWAY. A catalogue can only ever WIDEN what is admissible,
// never narrow it. No working route can break from staleness — the worst case
// is the status quo, arrived at loudly (doctor reports each table's age)
// instead of silently.
//
// WHY the files carry `fetched_at` at all, in one paid-for example: Sonnet 5's
// $2/$10 was published as introductory pricing through 2026-08-31, with a rise
// to $3/$15 scheduled for 2026-09-01. That rise was CANCELLED and $2/$10 is now
// standard. A catalogue built from a source cached a day earlier would have
// shipped $3/$15 — a price that never existed. The stamp is what makes that
// class of error observable instead of permanent.
//
// The limit is deliberately ONE number for every provider. A per-catalogue
// max-age would be a knob whose only use is letting a table nobody wants to
// re-fetch keep quoting, which is the failure above with a config option in
// front of it.
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
//
// HONEST SCOPE, and the reason this validator is stricter than today's stakes
// justify: NOTHING in src/ multiplies a ModelPricing into a cost. These rates
// are ADMISSION EVIDENCE — `tokenPricingAvailableFor` asks only whether a
// price EXISTS, never what it is — so a wrong rate cannot mis-bill anything
// today. `costSource: "versioned_rate_table"` is declared in
// docs/multi-runtime-model-diversity-design.md:449 and emitted nowhere. That
// gap is exactly why a wrong rate WILL mis-bill later: it will be wired to
// arithmetic by a slice that reasonably assumes the numbers under it were
// checked, and no test at that point will re-derive them from the vendor's
// page. The guards below, and the second copy of the money in
// test/pricing-catalog.test.ts, are what make that assumption true in advance.
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

// Hand-written config, so "Anthropic" is a capital letter and not another
// company. Trim and case are the ONLY normalisation applied to a provider
// name, at every point one is compared: no aliasing `claude` to `anthropic`,
// no prefix matching. Every such rule is a way for a provider no catalogue
// covers to be mistaken for one that is covered, which is the failure the
// gate at the bottom of this file exists to stop.
function providerKey(provider: string): string {
  return provider.trim().toLowerCase();
}

// Import-time duplicate-provider guard, mirroring model-catalog.ts's duplicate
// alias/canonical guards. Two bundled files declaring the same provider is a
// silent half-catalogue: whichever import lost the race is simply not
// consulted, and the models only IT lists are refused for looking absent
// rather than for being absent — a wrong answer that no test of either file
// alone can see. Exported so that guard is provable without a second real
// JSON file; the production record below is built by this same function, so
// the throw it proves is the throw that runs at import.
//
// Collision is judged on the NORMALISED key, because that is the key
// `pricingCatalogFor` looks a route's provider up under: `"zai"` and `"ZAI"`
// are one provider to every consumer, so admitting both would leave exactly
// the half-catalogue this guard is for.
export function indexPricingCatalogs(
  raws: readonly unknown[],
): Readonly<Record<string, PricingCatalog>> {
  const byProvider: Record<string, PricingCatalog> = {};
  for (const raw of raws) {
    const catalog = normalizePricingCatalog(raw);
    const key = providerKey(catalog.provider);
    if (Object.hasOwn(byProvider, key)) {
      throw new Error(`pricing catalog: duplicate provider "${key}"`);
    }
    byProvider[key] = Object.freeze(catalog);
  }
  return Object.freeze(byProvider);
}

// The bundled tables, one per provider.
//
// TRANSCRIPTION DOCTRINE for anything added here, because a rate file is the
// one kind of source that is wrong without being broken:
//
// - Model KEYS are the ids the ROUTE produces, never the vendor page's
//   casing. `model-routing.ts`'s non-alias branch puts the parsed model
//   segment into `modelSnapshot` verbatim, so `zai/glm-4.6` looks itself up
//   as `glm-4.6` while z.ai's page prints `GLM-4.6`. A wrong-case table is
//   refused 100% of the time, silently, and a test written against the
//   table's own keys still passes — which is why test/pricing-catalog.test.ts
//   resolves real routes instead of hand-typing ids.
// - Include a model ONLY when it has one unambiguous positive price in every
//   column AND its id is verified present in `opencode models`. An omitted
//   model is refused, which is the honest outcome; a guessed one is a
//   confident wrong price, which is the failure this module exists to stop.
//
// z.ai specifics that the JSON cannot carry itself:
// - `cache_write_5m` and `cache_write_1h` are ANTHROPIC's axis, collapsed
//   onto the input rate. z.ai charges no cache-write premium and publishes no
//   5m/1h TTL tiers, so do NOT read `glm-5.3`'s `cache_write_1h: 1.4` as a
//   genuine one-hour tier price — it is the input rate, recorded twice
//   because ModelPricing has two fields for a distinction this provider does
//   not make. The page's "Cached Input Storage: Limited-time Free" is the
//   STORAGE fee, not the write: the tokens themselves are still charged at
//   the input rate. If z.ai starts charging for that storage, nothing here
//   notices — `fetched_at` plus the 90-day expiry is the ONLY mechanism that
//   catches it, which is what the expiry is for.
// - `batch_multiplier: 1` means "no multiplier is applied", NOT "a batch API
//   was verified absent". The page states no batch discount; that is all that
//   is known.
const PRICING_CATALOGS_INTERNAL = indexPricingCatalogs([
  anthropicPricing,
  zaiPricing,
]);

export const PRICING_CATALOGS: Readonly<Record<string, PricingCatalog>> =
  PRICING_CATALOGS_INTERNAL;

// The provider axis, answered in ONE place. Every other function in this file
// is catalogue-scoped and therefore cannot get the provider wrong.
//
// Object.hasOwn, not a bare index — the SAME failure as the model lookup
// below, through a second door. `PRICING_CATALOGS` is a plain object, so
// `PRICING_CATALOGS["constructor"]` reaches Object.prototype and hands back
// the Object constructor, and a route whose provider is literally
// `"constructor"` would then be "covered by a catalogue".
export function pricingCatalogFor(
  provider: string,
): PricingCatalog | undefined {
  const key = providerKey(provider);
  if (!Object.hasOwn(PRICING_CATALOGS_INTERNAL, key)) return undefined;
  return PRICING_CATALOGS_INTERNAL[key];
}

// Exact model id, or a logical alias, within ONE catalogue. Alias knowledge is
// NOT duplicated here: model-catalog.ts owns the alias -> snapshot mapping and
// is the only place that may answer it, so an alias repointed there repoints
// its price too.
//
// Takes a CATALOGUE, not a provider, and that is the same doctrine this
// function has always carried rather than a widening of it. This is the raw
// lookup; the provider axis is answered ONCE, in `pricingCatalogFor`, whose
// single caller on the gate path is `tokenPricingAvailableFor` below. A
// provider argument HERE would be a check every caller has to remember to
// pass, which is how the gate went missing in the first place (#162). Passing
// a catalogue instead makes it un-forgettable: there is no way to call this
// without having already chosen whose prices you are reading.
export function lookupModelPricing(
  catalog: PricingCatalog,
  modelId: string,
): ModelPricing | undefined {
  let resolved = modelId;
  if (isModelAlias(modelId)) {
    const alias = lookupAlias(modelId);
    // An alias belongs to a PROVIDER. `sonnet|opus|haiku` are Anthropic's, and
    // resolving one inside a foreign catalogue would ask z.ai's table for
    // `claude-sonnet-5` — today that answers undefined by luck, because no
    // z.ai model happens to be named like an Anthropic snapshot. Luck is not
    // a gate: refuse structurally, so a future catalogue that DOES collide
    // cannot quietly price another provider's alias.
    if (providerKey(alias.provider) !== providerKey(catalog.provider)) {
      return undefined;
    }
    resolved = alias.modelSnapshot;
  }
  // Object.hasOwn, not a bare index. `models` is a plain object, so indexing
  // it with an arbitrary model id reaches Object.prototype: looking up
  // "constructor" returned the Object constructor, and every prototype member
  // made tokenPricingAvailableFor answer TRUE for a model that does not
  // exist. That is the precise failure this module was built to prevent -- a
  // confident wrong price instead of an honest absent one -- arriving through
  // the language rather than through a stale table.
  //
  // Found by pr-hero reviewing this module's own PR (#162).
  if (!Object.hasOwn(catalog.models, resolved)) return undefined;
  return catalog.models[resolved];
}

// Whole days, floored: a table fetched this morning is zero days old all day.
//
// Per CATALOGUE, not per process. The age used to be a module-global scalar
// read off the single bundled table, which was indistinguishable from correct
// while there was one table and becomes a lie the moment there are two: a
// freshly fetched provider would inherit an expired provider's age, or the
// reverse, and the reverse is the dangerous one — an expired table quoting
// under a fresh one's stamp is exactly the confident-wrong-price case the
// expiry exists to prevent.
export function pricingCatalogAge(catalog: PricingCatalog, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(catalog.fetched_at)) / DAY_MS);
}

export function isPricingCatalogFresh(
  catalog: PricingCatalog,
  now: Date,
): boolean {
  return pricingCatalogAge(catalog, now) < PRICING_MAX_AGE_DAYS;
}

// The one predicate a `pricingReady` site should call. THREE facts have to
// agree, and each one alone is a way to report a confident wrong price:
//
// 1. Provider. A catalogue has ALWAYS declared whose prices it holds --
//    config/models/*-pricing.json carries `"provider"` and
//    normalizePricingCatalog parses it into PricingCatalog.provider -- and
//    this predicate ignored it, answering from the model id alone. The
//    collision is REACHABLE, not theoretical: parseRouteMapping
//    (preflight.ts) validates `provider` as any non-empty string and never
//    cross-checks it against `modelSnapshot`, so a route of
//    `{ provider: "openai", modelSnapshot: "claude-sonnet-5" }` was admitted
//    as priced and would have billed another provider at Anthropic's rates.
//    Adding a second catalogue does not soften this: the provider now SELECTS
//    the table rather than merely matching one, so an unknown provider still
//    finds nothing and a known provider can only ever see its own prices.
// 2. Membership -- see lookupModelPricing's Object.hasOwn guard, and note
//    that it is asked of the catalogue the provider selected, never of all of
//    them.
// 3. Freshness -- see PRICING_MAX_AGE_DAYS: a known model at an expired price
//    is the same confident-wrong case arriving through the calendar. Judged
//    on THAT catalogue's stamp, so one provider's stale table cannot withdraw
//    another's current prices, and cannot borrow them either.
//
// The provider gate is the same shape as the prototype bug in
// lookupModelPricing, through a door the design did not consider, and was
// found the same way: pr-hero reviewing this very module's own PR, refuter
// verdict `corroborated`.
export function tokenPricingAvailableFor(
  provider: string,
  modelId: string,
  now: Date,
): boolean {
  const catalog = pricingCatalogFor(provider);
  if (catalog === undefined) return false;
  return (
    lookupModelPricing(catalog, modelId) !== undefined &&
    isPricingCatalogFresh(catalog, now)
  );
}
