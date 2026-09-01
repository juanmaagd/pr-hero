import { describe, expect, test } from "bun:test";
import {
  isPricingCatalogFresh,
  lookupModelPricing,
  type ModelPricing,
  PRICING_CATALOG,
  PRICING_MAX_AGE_DAYS,
  pricingCatalogAge,
  tokenPricingAvailableFor,
} from "../src/pricing-catalog";

// The catalogue's own stamp, as a UTC instant. Every `now` below is built from
// Date.UTC and offset from here: `new Date("2026-09-01")` is UTC midnight, so
// a local-time `now` would put the +89/+90 boundary on either side of the line
// depending on the machine's timezone and make these tests flaky by geography.
const FETCHED_AT_MS = Date.UTC(2026, 8, 1);
const DAY_MS = 86_400_000;

function daysAfterFetch(days: number): Date {
  return new Date(FETCHED_AT_MS + days * DAY_MS);
}

// Transcribed from https://platform.claude.com/docs/en/about-claude/pricing.md
// on 2026-09-01, USD per million tokens. This table IS the drift guard: it is a
// second, independent copy of the money, so a typo in the JSON has to be made
// twice to ship.
const EXPECTED: ReadonlyArray<readonly [string, ModelPricing]> = [
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

describe("pricing catalog", () => {
  describe("rates", () => {
    for (const [modelId, expected] of EXPECTED) {
      test(`${modelId} resolves its exact published rates`, () => {
        expect(lookupModelPricing(modelId)).toEqual(expected);
      });
    }

    test("carries exactly the models this engine routes", () => {
      expect(Object.keys(PRICING_CATALOG.models).sort()).toEqual(
        EXPECTED.map(([id]) => id).sort(),
      );
    });

    test("the Batch API discount is recorded, not inferred", () => {
      expect(PRICING_CATALOG.batch_multiplier).toBe(0.5);
    });
  });

  describe("alias resolution", () => {
    test("a logical alias resolves through the model catalog", () => {
      expect(lookupModelPricing("sonnet")).toEqual(
        lookupModelPricing("claude-sonnet-5") as ModelPricing,
      );
      expect(lookupModelPricing("opus")).toEqual(
        lookupModelPricing("claude-opus-5") as ModelPricing,
      );
      expect(lookupModelPricing("haiku")).toEqual(
        lookupModelPricing("claude-haiku-4-5") as ModelPricing,
      );
    });

    test("an alias is available exactly as long as its snapshot is", () => {
      expect(tokenPricingAvailableFor("sonnet", daysAfterFetch(0))).toBe(true);
    });
  });

  describe("unknown models", () => {
    test("an unlisted model id has no price and is never available", () => {
      expect(lookupModelPricing("gpt-4o")).toBeUndefined();
      expect(lookupModelPricing("claude-opus-4-1")).toBeUndefined();
      expect(tokenPricingAvailableFor("gpt-4o", daysAfterFetch(0))).toBe(false);
    });
  });

  describe("freshness", () => {
    test("age is whole days since fetched_at", () => {
      expect(pricingCatalogAge(daysAfterFetch(0))).toBe(0);
      expect(pricingCatalogAge(daysAfterFetch(89))).toBe(89);
      expect(pricingCatalogAge(daysAfterFetch(90))).toBe(90);
    });

    test(`fresh below ${PRICING_MAX_AGE_DAYS} days, stale at and beyond it`, () => {
      expect(isPricingCatalogFresh(daysAfterFetch(89))).toBe(true);
      expect(isPricingCatalogFresh(daysAfterFetch(90))).toBe(false);
      expect(isPricingCatalogFresh(daysAfterFetch(91))).toBe(false);
    });

    test("a stale catalogue withdraws pricing for a KNOWN model", () => {
      // The point of the whole module: an old price is worse than no price,
      // because the metered gate would bill a confident wrong number instead
      // of refusing. Staleness must beat catalogue membership.
      expect(lookupModelPricing("claude-opus-5")).toBeDefined();
      expect(
        tokenPricingAvailableFor("claude-opus-5", daysAfterFetch(89)),
      ).toBe(true);
      expect(
        tokenPricingAvailableFor("claude-opus-5", daysAfterFetch(90)),
      ).toBe(false);
    });
  });

  describe("structure", () => {
    test("fetched_at is a real date and source_url is the published table", () => {
      expect(PRICING_CATALOG.source_url).toBe(
        "https://platform.claude.com/docs/en/about-claude/pricing.md",
      );
      expect(PRICING_CATALOG.fetched_at).toBe("2026-09-01");
      expect(Number.isNaN(Date.parse(PRICING_CATALOG.fetched_at))).toBe(false);
      expect(PRICING_CATALOG.currency).toBe("USD");
      expect(PRICING_CATALOG.unit).toBe("per_mtok");
      expect(PRICING_CATALOG.provider).toBe("anthropic");
    });
  });
});
