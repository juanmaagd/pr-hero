// PR1b (spec: "Provider Fixtures Cover All Three Providers Including Partial
// And Unknown Cases"): drives every `test/fixtures/usage/*.json` fixture
// through the appropriate PR1a pure builder and asserts the result matches
// the fixture's expected leaf split + completeness. Each provider's real
// event shape differs (Anthropic reports disjoint cache counts, OpenAI nests
// cached/reasoning tokens under `*_details`, Gemini's prompt/candidates
// totals already include cache/thoughts detail) — the fixtures pin those
// differences so the inclusion rules are verified per-provider, not assumed
// uniform.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type InclusiveUsageInput,
  type NormalizedUsage,
  normalizeInclusiveUsage,
  normalizePartialUsage,
  normalizeUnavailableUsage,
  type PartialUsageInput,
  type UnavailableUsageInput,
} from "../../src/execution/usage-normalized";

type UsageFixtureCase = "complete" | "partial" | "unknown";

interface UsageFixture {
  readonly provider: string;
  readonly case: UsageFixtureCase;
  readonly description: string;
  readonly input: Record<string, unknown>;
  readonly expected: NormalizedUsage;
}

const FIXTURES_DIR = join(import.meta.dir, "../fixtures/usage");
const EXPECTED_PROVIDERS = ["anthropic", "openai", "gemini"] as const;
const EXPECTED_CASES: readonly UsageFixtureCase[] = [
  "complete",
  "partial",
  "unknown",
];

function loadFixtures(): UsageFixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".json"))
    .map(
      (name) =>
        JSON.parse(
          readFileSync(join(FIXTURES_DIR, name), "utf8"),
        ) as UsageFixture,
    );
}

function normalizeFixture(fixture: UsageFixture): NormalizedUsage {
  switch (fixture.case) {
    case "complete":
      return normalizeInclusiveUsage(
        fixture.input as unknown as InclusiveUsageInput,
      );
    case "partial":
      return normalizePartialUsage(
        fixture.input as unknown as PartialUsageInput,
      );
    case "unknown":
      return normalizeUnavailableUsage(
        fixture.input as unknown as UnavailableUsageInput,
      );
  }
}

const fixtures = loadFixtures();

describe("usage fixtures — table-driven provider normalization (spec: Provider Fixtures Cover All Three Providers)", () => {
  test("fixture set covers exactly anthropic/openai/gemini x complete/partial/unknown (9 fixtures)", () => {
    expect(fixtures).toHaveLength(9);

    const providers = new Set(fixtures.map((f) => f.provider));
    expect(providers).toEqual(new Set(EXPECTED_PROVIDERS));

    for (const provider of EXPECTED_PROVIDERS) {
      const cases = new Set(
        fixtures.filter((f) => f.provider === provider).map((f) => f.case),
      );
      expect(cases).toEqual(new Set(EXPECTED_CASES));
    }
  });

  for (const fixture of fixtures) {
    test(`${fixture.provider}/${fixture.case}: ${fixture.description}`, () => {
      const result = normalizeFixture(fixture);
      expect(result).toEqual(fixture.expected);
    });
  }
});
