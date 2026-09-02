import { describe, expect, test } from "bun:test";
import { resolveStepRoute } from "../src/model-routing";
import {
  indexPricingCatalogs,
  isPricingCatalogFresh,
  lookupModelPricing,
  type ModelPricing,
  PRICING_CATALOGS,
  PRICING_MAX_AGE_DAYS,
  type PricingCatalog,
  pricingCatalogAge,
  pricingCatalogFor,
  tokenPricingAvailableFor,
} from "../src/pricing-catalog";

// `pricingCatalogFor` returns `| undefined` because an unknown provider is a
// real answer on the gate path. In a test the absence is a bug in the bundle,
// not a case to handle, so it throws once here instead of being `!`-asserted
// at every use.
function requireCatalog(provider: string): PricingCatalog {
  const catalog = pricingCatalogFor(provider);
  if (catalog === undefined) {
    throw new Error(`bundled pricing catalogue missing for "${provider}"`);
  }
  return catalog;
}

const ANTHROPIC = requireCatalog("anthropic");
const ZAI = requireCatalog("zai");

// Each catalogue's own stamp, as a UTC instant. Every `now` below is built by
// offsetting from one of these: `new Date("2026-09-01")` is UTC midnight, so
// a local-time `now` would put the +89/+90 boundary on either side of the line
// depending on the machine's timezone and make these tests flaky by geography.
//
// TWO anchors, not one, because freshness is per catalogue. A zai assertion
// clocked off Anthropic's stamp would silently test the wrong table's age.
const DAY_MS = 86_400_000;

function daysAfterFetchOf(catalog: PricingCatalog, days: number): Date {
  return new Date(Date.parse(catalog.fetched_at) + days * DAY_MS);
}

function daysAfterFetch(days: number): Date {
  return daysAfterFetchOf(ANTHROPIC, days);
}

function daysAfterZaiFetch(days: number): Date {
  return daysAfterFetchOf(ZAI, days);
}

// Transcribed from https://platform.claude.com/docs/en/about-claude/pricing.md
// on 2026-09-01, USD per million tokens. This table IS the drift guard: it is a
// second, independent copy of the money, so a typo in the JSON has to be made
// twice to ship.
const ANTHROPIC_EXPECTED: ReadonlyArray<readonly [string, ModelPricing]> = [
  [
    "claude-fable-5",
    {
      input: 10,
      cache_write_5m: 12.5,
      cache_write_1h: 20,
      cache_read: 1,
      output: 50,
    },
  ],
  [
    "claude-mythos-5",
    {
      input: 10,
      cache_write_5m: 12.5,
      cache_write_1h: 20,
      cache_read: 1,
      output: 50,
    },
  ],
  [
    "claude-opus-5",
    {
      input: 5,
      cache_write_5m: 6.25,
      cache_write_1h: 10,
      cache_read: 0.5,
      output: 25,
    },
  ],
  [
    "claude-opus-4-8",
    {
      input: 5,
      cache_write_5m: 6.25,
      cache_write_1h: 10,
      cache_read: 0.5,
      output: 25,
    },
  ],
  [
    "claude-opus-4-7",
    {
      input: 5,
      cache_write_5m: 6.25,
      cache_write_1h: 10,
      cache_read: 0.5,
      output: 25,
    },
  ],
  [
    "claude-opus-4-6",
    {
      input: 5,
      cache_write_5m: 6.25,
      cache_write_1h: 10,
      cache_read: 0.5,
      output: 25,
    },
  ],
  [
    "claude-opus-4-5",
    {
      input: 5,
      cache_write_5m: 6.25,
      cache_write_1h: 10,
      cache_read: 0.5,
      output: 25,
    },
  ],
  [
    "claude-sonnet-5",
    {
      input: 2,
      cache_write_5m: 2.5,
      cache_write_1h: 4,
      cache_read: 0.2,
      output: 10,
    },
  ],
  [
    "claude-sonnet-4-6",
    {
      input: 3,
      cache_write_5m: 3.75,
      cache_write_1h: 6,
      cache_read: 0.3,
      output: 15,
    },
  ],
  [
    "claude-sonnet-4-5",
    {
      input: 3,
      cache_write_5m: 3.75,
      cache_write_1h: 6,
      cache_read: 0.3,
      output: 15,
    },
  ],
  [
    "claude-haiku-4-5",
    {
      input: 1,
      cache_write_5m: 1.25,
      cache_write_1h: 2,
      cache_read: 0.1,
      output: 5,
    },
  ],
];

// Transcribed from https://docs.z.ai/guides/overview/pricing on 2026-09-02,
// USD per million tokens, and the same drift guard as the table above: a
// second, independent copy of the money, so a typo in the JSON has to be made
// twice to ship.
//
// The KEYS are OpenCode's model ids (`opencode models`, 2026-09-02), NOT the
// page's casing -- the page prints `GLM-4.6` and the route resolves
// `glm-4.6`. See the route-resolved arm below, which is the one that catches
// a wrong-case table; this table alone would not, because it would be wrong
// in the same direction as the JSON.
//
// `cache_write_5m` and `cache_write_1h` repeat `input` on every row. That is
// not a transcription slip: z.ai has no cache-write premium and no 5m/1h TTL
// tiers, so Anthropic's two fields collapse onto the input rate. The WHY is
// in src/pricing-catalog.ts beside the import; it is deliberately NOT
// asserted as its own "cache_write === input" invariant here, because such a
// test would also flip when a real input rate changes and would stop these
// per-model arms from being the single thing a rate typo breaks.
const ZAI_EXPECTED: ReadonlyArray<readonly [string, ModelPricing]> = [
  [
    "glm-5.3",
    {
      input: 1.4,
      cache_write_5m: 1.4,
      cache_write_1h: 1.4,
      cache_read: 0.26,
      output: 4.4,
    },
  ],
  [
    "glm-5.2",
    {
      input: 1.4,
      cache_write_5m: 1.4,
      cache_write_1h: 1.4,
      cache_read: 0.26,
      output: 4.4,
    },
  ],
  [
    "glm-5.1",
    {
      input: 1.4,
      cache_write_5m: 1.4,
      cache_write_1h: 1.4,
      cache_read: 0.26,
      output: 4.4,
    },
  ],
  [
    "glm-5",
    {
      input: 1,
      cache_write_5m: 1,
      cache_write_1h: 1,
      cache_read: 0.2,
      output: 3.2,
    },
  ],
  [
    "glm-4.7",
    {
      input: 0.6,
      cache_write_5m: 0.6,
      cache_write_1h: 0.6,
      cache_read: 0.11,
      output: 2.2,
    },
  ],
  [
    "glm-4.7-flashx",
    {
      input: 0.07,
      cache_write_5m: 0.07,
      cache_write_1h: 0.07,
      cache_read: 0.01,
      output: 0.4,
    },
  ],
  [
    "glm-4.6",
    {
      input: 0.6,
      cache_write_5m: 0.6,
      cache_write_1h: 0.6,
      cache_read: 0.11,
      output: 2.2,
    },
  ],
  [
    "glm-4.5",
    {
      input: 0.6,
      cache_write_5m: 0.6,
      cache_write_1h: 0.6,
      cache_read: 0.11,
      output: 2.2,
    },
  ],
  [
    "glm-4.5-air",
    {
      input: 0.2,
      cache_write_5m: 0.2,
      cache_write_1h: 0.2,
      cache_read: 0.03,
      output: 1.1,
    },
  ],
  [
    "glm-4.6v",
    {
      input: 0.3,
      cache_write_5m: 0.3,
      cache_write_1h: 0.3,
      cache_read: 0.05,
      output: 0.9,
    },
  ],
  [
    "glm-4.5v",
    {
      input: 0.6,
      cache_write_5m: 0.6,
      cache_write_1h: 0.6,
      cache_read: 0.11,
      output: 1.8,
    },
  ],
];

describe("pricing catalog", () => {
  describe("rates", () => {
    for (const [modelId, expected] of ANTHROPIC_EXPECTED) {
      test(`${modelId} resolves its exact published rates`, () => {
        expect(lookupModelPricing(ANTHROPIC, modelId)).toEqual(expected);
      });
    }

    test("carries exactly the models this engine routes", () => {
      expect(Object.keys(ANTHROPIC.models).sort()).toEqual(
        ANTHROPIC_EXPECTED.map(([id]) => id).sort(),
      );
    });

    test("the Batch API discount is recorded, not inferred", () => {
      expect(ANTHROPIC.batch_multiplier).toBe(0.5);
    });
  });

  describe("bare aliases carry no price", () => {
    // #175. A bare alias no longer names a version -- `sonnet` is a name the
    // PROVIDER resolves at spawn time, and this table is keyed on versions.
    // Pricing one would mean re-deriving the pin #175 removed, from a
    // mapping nobody verified, which is the confident-wrong-price failure
    // this whole module exists to refuse.
    test("an alias has no price even in its own provider's catalogue", () => {
      for (const alias of ["sonnet", "opus", "haiku"]) {
        expect(lookupModelPricing(ANTHROPIC, alias)).toBeUndefined();
        expect(
          tokenPricingAvailableFor("anthropic", alias, daysAfterFetch(0)),
        ).toBe(false);
      }
    });

    test("a route that names a snapshot is still priced", () => {
      // The escape hatch, and the reason the arm above costs nothing: an
      // operator who wants table pricing pins `modelSnapshot` in the routing
      // config, and that id is looked up verbatim.
      expect(
        tokenPricingAvailableFor(
          "anthropic",
          "claude-sonnet-5",
          daysAfterFetch(0),
        ),
      ).toBe(true);
    });
  });

  describe("unknown models", () => {
    test("an unlisted model id has no price and is never available", () => {
      expect(lookupModelPricing(ANTHROPIC, "gpt-4o")).toBeUndefined();
      expect(lookupModelPricing(ANTHROPIC, "claude-opus-4-1")).toBeUndefined();
      expect(
        tokenPricingAvailableFor("anthropic", "gpt-4o", daysAfterFetch(0)),
      ).toBe(false);
    });

    test("an Object.prototype member is not a model", () => {
      // `models` is a plain object, so a bare index reached the prototype
      // chain: lookupModelPricing(ANTHROPIC, "constructor") returned the Object
      // constructor, and tokenPricingAvailableFor answered TRUE for every one
      // of these -- a confident price for a model that does not exist, which
      // is the exact failure this module exists to prevent, arriving through
      // the language instead of through a stale table.
      //
      // Found by pr-hero reviewing this module's own PR (#162).
      for (const member of [
        "constructor",
        "toString",
        "hasOwnProperty",
        "valueOf",
        "__proto__",
        "isPrototypeOf",
      ]) {
        expect(lookupModelPricing(ANTHROPIC, member)).toBeUndefined();
        // The catalogue's own provider, so the provider gate is not what is
        // answering here -- the model axis has to refuse on its own.
        expect(
          tokenPricingAvailableFor("anthropic", member, daysAfterFetch(0)),
        ).toBe(false);
      }
    });
  });

  describe("freshness", () => {
    test("age is whole days since fetched_at", () => {
      expect(pricingCatalogAge(ANTHROPIC, daysAfterFetch(0))).toBe(0);
      expect(pricingCatalogAge(ANTHROPIC, daysAfterFetch(89))).toBe(89);
      expect(pricingCatalogAge(ANTHROPIC, daysAfterFetch(90))).toBe(90);
    });

    test(`fresh below ${PRICING_MAX_AGE_DAYS} days, stale at and beyond it`, () => {
      expect(isPricingCatalogFresh(ANTHROPIC, daysAfterFetch(89))).toBe(true);
      expect(isPricingCatalogFresh(ANTHROPIC, daysAfterFetch(90))).toBe(false);
      expect(isPricingCatalogFresh(ANTHROPIC, daysAfterFetch(91))).toBe(false);
    });

    test("a stale catalogue withdraws pricing for a KNOWN model", () => {
      // The point of the whole module: an old price is worse than no price,
      // because the metered gate would bill a confident wrong number instead
      // of refusing. Staleness must beat catalogue membership.
      expect(lookupModelPricing(ANTHROPIC, "claude-opus-5")).toBeDefined();
      // Anthropic on both arms, so staleness -- not the provider gate -- is
      // the only thing that can flip the answer between them.
      expect(
        tokenPricingAvailableFor(
          "anthropic",
          "claude-opus-5",
          daysAfterFetch(89),
        ),
      ).toBe(true);
      expect(
        tokenPricingAvailableFor(
          "anthropic",
          "claude-opus-5",
          daysAfterFetch(90),
        ),
      ).toBe(false);
    });
  });

  describe("provider gate", () => {
    test("a foreign provider is never priced from this catalogue", () => {
      // The reported finding: pr-hero reviewing PR #162 on the OpenCode route,
      // refuter verdict `corroborated`. `parseRouteMapping` (preflight.ts)
      // validates `provider` as any non-empty string and never cross-checks it
      // against `modelSnapshot`, so `{ provider: "openai", modelSnapshot:
      // "claude-sonnet-5" }` is an admissible route mapping. The predicate saw
      // only the model id, found it in the Anthropic-only catalogue, and
      // reported a metered route as PRICED -- billing another provider at
      // Anthropic's rates. A confident wrong price instead of an honest absent
      // one, which is the exact failure this module exists to prevent.
      expect(
        tokenPricingAvailableFor(
          "openai",
          "claude-sonnet-5",
          daysAfterFetch(0),
        ),
      ).toBe(false);
      // Not a quirk of one id: every catalogued model is off-limits to it.
      for (const [modelId] of ANTHROPIC_EXPECTED) {
        expect(
          tokenPricingAvailableFor("openai", modelId, daysAfterFetch(0)),
        ).toBe(false);
      }
    });

    test("the catalogue's own provider still prices its own models", () => {
      // The behaviour the gate must not cost us: same model, same fresh table,
      // the provider the catalogue declares.
      expect(
        tokenPricingAvailableFor(
          "anthropic",
          "claude-sonnet-5",
          daysAfterFetch(0),
        ),
      ).toBe(true);
    });

    test("case and surrounding whitespace are not a different provider", () => {
      // config/models/*.json and the routing config are both hand-written.
      // "Anthropic" is a capital letter, not another company.
      for (const provider of [
        "Anthropic",
        " anthropic ",
        "ANTHROPIC",
        "\tAnthropic\n",
      ]) {
        expect(
          tokenPricingAvailableFor(
            provider,
            "claude-sonnet-5",
            daysAfterFetch(0),
          ),
        ).toBe(true);
      }
    });

    test("a third provider is refused like any other non-match", () => {
      // Deliberately NOT an exhaustive provider list: the gate SELECTS a
      // catalogue by provider, so a provider no catalogue declares finds
      // nothing without this module having to know what it is.
      for (const provider of ["openrouter", "bedrock", ""]) {
        expect(
          tokenPricingAvailableFor(
            provider,
            "claude-opus-5",
            daysAfterFetch(0),
          ),
        ).toBe(false);
      }
    });

    test("a KNOWN second provider is refused for a model that is not its own", () => {
      // `zai` used to sit in the list above as one more unknown. It is now a
      // provider the engine ships a table for, which makes this the STRONGER
      // fact: selecting a catalogue is not the same as pricing from it, and a
      // provider that has its own prices still cannot borrow Anthropic's.
      // This is the arm that would go quiet if catalogue selection ever fell
      // back to searching every table for the model id.
      expect(pricingCatalogFor("zai")).toBeDefined();
      for (const [modelId] of ANTHROPIC_EXPECTED) {
        expect(
          tokenPricingAvailableFor("zai", modelId, daysAfterZaiFetch(0)),
        ).toBe(false);
      }
      // ...and the reverse, so neither direction is load-bearing for the
      // other.
      for (const [modelId] of ZAI_EXPECTED) {
        expect(
          tokenPricingAvailableFor("anthropic", modelId, daysAfterFetch(0)),
        ).toBe(false);
      }
    });

    test("an Object.prototype member is not a provider", () => {
      // The provider axis has the SAME prototype door the model axis had
      // (#162): PRICING_CATALOGS is a plain object, so a bare index would
      // hand `PRICING_CATALOGS["constructor"]` back the Object constructor
      // and a route whose provider is literally "constructor" would count as
      // covered by a catalogue.
      for (const member of [
        "constructor",
        "toString",
        "hasOwnProperty",
        "valueOf",
        "__proto__",
        "isPrototypeOf",
      ]) {
        expect(pricingCatalogFor(member)).toBeUndefined();
        // A real, catalogued model id on both arms, so the MODEL axis is not
        // what is answering here -- the provider axis has to refuse on its
        // own.
        expect(
          tokenPricingAvailableFor(member, "glm-4.6", daysAfterZaiFetch(0)),
        ).toBe(false);
        expect(
          tokenPricingAvailableFor(member, "claude-opus-5", daysAfterFetch(0)),
        ).toBe(false);
      }
    });

    test("a foreign provider stays refused on a stale table too", () => {
      // Both axes refuse independently; neither is load-bearing for the other.
      expect(
        tokenPricingAvailableFor("openai", "claude-opus-5", daysAfterFetch(90)),
      ).toBe(false);
    });
  });

  describe("structure", () => {
    test("fetched_at is a real date and source_url is the published table", () => {
      expect(ANTHROPIC.source_url).toBe(
        "https://platform.claude.com/docs/en/about-claude/pricing.md",
      );
      expect(ANTHROPIC.fetched_at).toBe("2026-09-01");
      expect(Number.isNaN(Date.parse(ANTHROPIC.fetched_at))).toBe(false);
      expect(ANTHROPIC.currency).toBe("USD");
      expect(ANTHROPIC.unit).toBe("per_mtok");
      expect(ANTHROPIC.provider).toBe("anthropic");
    });

    test("the zai table names its own date and published source", () => {
      expect(ZAI.source_url).toBe("https://docs.z.ai/guides/overview/pricing");
      expect(ZAI.fetched_at).toBe("2026-09-02");
      expect(Number.isNaN(Date.parse(ZAI.fetched_at))).toBe(false);
      expect(ZAI.currency).toBe("USD");
      expect(ZAI.unit).toBe("per_mtok");
      expect(ZAI.provider).toBe("zai");
    });
  });

  describe("zai rates", () => {
    for (const [modelId, expected] of ZAI_EXPECTED) {
      test(`${modelId} resolves its exact published rates`, () => {
        expect(lookupModelPricing(ZAI, modelId)).toEqual(expected);
      });
    }

    test("carries exactly the models transcribed from the published table", () => {
      expect(Object.keys(ZAI.models).sort()).toEqual(
        ZAI_EXPECTED.map(([id]) => id).sort(),
      );
    });

    test("no batch multiplier is applied, which is not the same as none existing", () => {
      // 1 means "nothing is multiplied", NOT "a batch API was verified
      // absent". z.ai's page states no batch discount; that is the whole of
      // what is known, and recording a guess either way would be the
      // confident-wrong-number failure in miniature.
      expect(ZAI.batch_multiplier).toBe(1);
    });
  });

  // The class this whole describe exists for: the pricing table's keys must
  // be the ids a ROUTE produces, not the ids a vendor's marketing page
  // prints. z.ai publishes `GLM-4.6`; `model-routing.ts` resolves `zai/glm-4.6`
  // to `modelSnapshot: "glm-4.6"`. A table keyed the page's way is refused
  // 100% of the time, in silence -- and every test written against the
  // table's OWN keys still passes, because it is wrong in the same direction.
  //
  // So these ids are a hardcoded literal, transcribed from `opencode models`
  // on 2026-09-02, and they are put through the real resolver rather than
  // compared to the JSON. Deriving them from `Object.keys(ZAI.models)` would
  // reintroduce exactly the blindness above.
  describe("route-resolved model ids", () => {
    const ROUTABLE_ZAI_IDS: readonly string[] = [
      "glm-5.3",
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "glm-4.7",
      "glm-4.7-flashx",
      "glm-4.6",
      "glm-4.5",
      "glm-4.5-air",
      "glm-4.6v",
      "glm-4.5v",
    ];

    for (const modelId of ROUTABLE_ZAI_IDS) {
      test(`zai/${modelId} is priced under the id the router actually produces`, () => {
        const logical = `zai/${modelId}`;
        const step = resolveStepRoute({
          stepKey: "hunter-reliability",
          role: "hunter",
          cliModel: logical,
          routingConfig: {
            // modelFamily and modelSnapshot are deliberately OMITTED: that is
            // what makes the router fall through to the parsed model segment
            // verbatim, which is the value a real route carries and the value
            // the catalogue is keyed on. Spelling the snapshot out here would
            // let this test pass against a table it does not match.
            mappings: { [logical]: { backend: "opencode", provider: "zai" } },
          },
        });

        expect(step.route.modelSnapshot).toBe(modelId);
        expect(
          tokenPricingAvailableFor(
            step.route.provider,
            step.route.modelSnapshot,
            daysAfterZaiFetch(0),
          ),
        ).toBe(true);
      });
    }

    test("the bundled table holds exactly those ids and no others", () => {
      expect(Object.keys(ZAI.models).sort()).toEqual(
        [...ROUTABLE_ZAI_IDS].sort(),
      );
    });
  });

  describe("deliberate omissions", () => {
    // Every id below is routable in OpenCode and refused here on purpose.
    // Refusal is the honest outcome: the gate exists to decline billing an
    // unknown amount, and each of these has no ONE unambiguous price to
    // record.
    test("a promotional dual price is not recorded, so the model is refused", () => {
      // The page prints `$0.15 $0.075` for GLM-5.3-Flash. Recording the
      // discount under-reports the day it ends; recording the list price
      // over-reports today. Omission is the only honest third option.
      expect(lookupModelPricing(ZAI, "glm-5.3-flash")).toBeUndefined();
      expect(
        tokenPricingAvailableFor("zai", "glm-5.3-flash", daysAfterZaiFetch(0)),
      ).toBe(false);
    });

    test("an all-Free model is refused rather than admitted at zero", () => {
      // A `0` rate passes the `>= 0` validation and would admit a metered
      // route at cashCostUsd: 0 -- truthful today, known to change, and
      // indistinguishable from a subscription's truthful zero once it does.
      for (const modelId of [
        "glm-4.7-flash",
        "glm-4.5-flash",
        "glm-4.6v-flash",
      ]) {
        expect(
          tokenPricingAvailableFor("zai", modelId, daysAfterZaiFetch(0)),
        ).toBe(false);
      }
    });

    test("a model absent from the published table is refused", () => {
      // Routable in OpenCode, priced nowhere z.ai publishes. No price, no
      // entry -- and this is the id the production-runtime and CLI suites
      // use as their durable "unpriced zai route".
      for (const modelId of ["glm-5-turbo", "glm-5v-turbo"]) {
        expect(
          tokenPricingAvailableFor("zai", modelId, daysAfterZaiFetch(0)),
        ).toBe(false);
      }
    });
  });

  describe("model ids are looked up verbatim", () => {
    // #175 replaced the cross-provider alias guard this block used to hold.
    // That guard existed because `lookupModelPricing` RESOLVED an Anthropic
    // alias to a snapshot and could therefore ask z.ai's table for
    // `claude-sonnet-5`. No resolution survives, so the hazard is gone by
    // construction rather than by a check -- and the arm below is what keeps
    // it from being reintroduced as an alias-shaped early return, which
    // would look equivalent and is not.
    test("a foreign catalogue's own model named like an alias is priced", () => {
      // The discriminating case. Re-add ANY alias special-casing to
      // lookupModelPricing -- `if (isModelAlias(modelId)) return undefined`
      // included -- and this arm reds: z.ai would be refused a price for a
      // model z.ai published, because pr-hero happens to use that word as an
      // Anthropic alias. Provider names are the provider's business.
      const colliding = indexPricingCatalogs([
        {
          provider: "zai",
          source_url: "https://example.invalid/pricing",
          fetched_at: "2026-09-02",
          currency: "USD",
          unit: "per_mtok",
          batch_multiplier: 1,
          models: { sonnet: { ...zeroRates() } },
        },
      ]).zai;
      if (colliding === undefined) throw new Error("fixture not indexed");

      expect(lookupModelPricing(colliding, "sonnet")).toEqual(zeroRates());
    });

    test("an Anthropic alias still finds nothing in a foreign catalogue", () => {
      // Same outcome as the deleted provider guard produced, reached without
      // one: z.ai's real table holds no key named `sonnet|opus|haiku`, and
      // nothing resolves those words into `claude-*` any more.
      for (const alias of ["sonnet", "opus", "haiku"]) {
        expect(lookupModelPricing(ZAI, alias)).toBeUndefined();
        expect(
          tokenPricingAvailableFor("zai", alias, daysAfterZaiFetch(0)),
        ).toBe(false);
      }
    });
  });

  describe("per-catalogue freshness", () => {
    // PREMISE, asserted rather than assumed: Anthropic's table is stamped
    // EARLIER than z.ai's. Every arm below depends on that ordering, and on
    // the real bundle it means only ONE direction of independence is
    // observable -- anthropic can be stale while zai is fresh, but not the
    // reverse, because zai going stale implies anthropic already is. A
    // re-fetch that reorders the stamps must fail here, loudly, instead of
    // leaving the arms below quietly vacuous.
    test("the bundled stamps are ordered anthropic-then-zai", () => {
      expect(Date.parse(ANTHROPIC.fetched_at)).toBeLessThan(
        Date.parse(ZAI.fetched_at),
      );
    });

    test("age and freshness are answered per catalogue, not per process", () => {
      const now = daysAfterFetch(PRICING_MAX_AGE_DAYS);
      expect(pricingCatalogAge(ANTHROPIC, now)).toBe(PRICING_MAX_AGE_DAYS);
      expect(isPricingCatalogFresh(ANTHROPIC, now)).toBe(false);
      // The SAME instant, the other table: younger by its own stamp, so still
      // speaking. A module-global fetched_at made this impossible to express.
      expect(pricingCatalogAge(ZAI, now)).toBeLessThan(PRICING_MAX_AGE_DAYS);
      expect(isPricingCatalogFresh(ZAI, now)).toBe(true);
    });

    test("one provider's expired table does not withdraw another's prices", () => {
      // The fact that matters on the gate path, through the one predicate a
      // pricingReady site calls: at an instant where Anthropic's table has
      // expired, an Anthropic route is refused and a zai route is still
      // priced. Shared freshness state would have collapsed both.
      const now = daysAfterFetch(PRICING_MAX_AGE_DAYS);
      expect(tokenPricingAvailableFor("anthropic", "claude-opus-5", now)).toBe(
        false,
      );
      expect(tokenPricingAvailableFor("zai", "glm-4.6", now)).toBe(true);
    });

    test("a zai route is refused once ITS OWN table expires", () => {
      const now = daysAfterZaiFetch(PRICING_MAX_AGE_DAYS);
      expect(lookupModelPricing(ZAI, "glm-4.6")).toBeDefined();
      expect(tokenPricingAvailableFor("zai", "glm-4.6", now)).toBe(false);
      expect(
        tokenPricingAvailableFor(
          "zai",
          "glm-4.6",
          daysAfterZaiFetch(PRICING_MAX_AGE_DAYS - 1),
        ),
      ).toBe(true);
    });
  });

  describe("catalogue index", () => {
    const catalogRaw = (provider: string) => ({
      provider,
      source_url: "https://example.invalid/pricing",
      fetched_at: "2026-09-02",
      currency: "USD",
      unit: "per_mtok",
      batch_multiplier: 1,
      models: { "model-a": { ...zeroRates() } },
    });

    test("two files declaring the same provider throw at import", () => {
      // A silent half-catalogue is the failure: whichever import lost would
      // simply not be consulted, and the models only IT listed would be
      // refused for looking absent rather than for being absent -- a wrong
      // answer no test of either file alone can see. The production record is
      // built by this same function, so the throw proven here is the throw
      // that runs at import.
      expect(() =>
        indexPricingCatalogs([catalogRaw("zai"), catalogRaw("zai")]),
      ).toThrow(/duplicate provider "zai"/);
    });

    test("the duplicate check reads the normalised key, not the raw string", () => {
      // "ZAI" and " zai " are ONE provider to pricingCatalogFor, so admitting
      // both would leave exactly the half-catalogue above with a capital
      // letter in front of it.
      expect(() =>
        indexPricingCatalogs([catalogRaw(" zai "), catalogRaw("ZAI")]),
      ).toThrow(/duplicate provider "zai"/);
    });

    test("the exported record is the same thing the selection seam reads", () => {
      // PRICING_CATALOGS is keyed by NORMALISED provider, and
      // pricingCatalogFor looks a route's provider up under that same key.
      // Two shapes for one fact is how they drift, so assert they are the one
      // object -- doctor iterates the record while the gate calls the seam,
      // and a record holding a table the seam cannot reach would report an
      // age for prices nothing can use.
      expect(Object.keys(PRICING_CATALOGS).sort()).toEqual([
        "anthropic",
        "zai",
      ]);
      expect(Object.isFrozen(PRICING_CATALOGS)).toBe(true);
      expect(pricingCatalogFor("anthropic")).toBe(PRICING_CATALOGS.anthropic);
      expect(pricingCatalogFor(" ZAI ")).toBe(PRICING_CATALOGS.zai);
    });

    test("distinct providers index side by side", () => {
      const index = indexPricingCatalogs([
        catalogRaw("anthropic"),
        catalogRaw("zai"),
      ]);
      expect(Object.keys(index).sort()).toEqual(["anthropic", "zai"]);
    });

    test("selection tolerates case and surrounding whitespace, and nothing else", () => {
      // config/models/*.json and the routing config are both hand-written, so
      // "ZAI" is a shift key and not another company. Trim and case are the
      // ONLY normalisation: no aliasing, no prefix matching, because each
      // such rule is a way for an uncovered provider to be priced from a
      // covered one's table.
      for (const provider of ["zai", "ZAI", " zai ", "\tZai\n"]) {
        expect(
          tokenPricingAvailableFor(provider, "glm-4.6", daysAfterZaiFetch(0)),
        ).toBe(true);
      }
      for (const provider of ["z-ai", "zai-coding-plan", "za", "zaix"]) {
        expect(
          tokenPricingAvailableFor(provider, "glm-4.6", daysAfterZaiFetch(0)),
        ).toBe(false);
      }
    });
  });
});

function zeroRates(): ModelPricing {
  return {
    input: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
    output: 0,
  };
}
