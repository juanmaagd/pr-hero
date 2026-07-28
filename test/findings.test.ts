import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  deriveTier,
  type Finding,
  type FindingsDocument,
  SCHEMA_VERSION,
  validateFindingsDocument,
} from "../src/findings";

function baseFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F001",
    category: 1,
    path: "packages/backend/src/Domain/Entities/Project/Project.ts",
    line: 42,
    severity: "BLOCKER",
    evidence_class: "deterministic",
    refuter_verdict: "not_submitted",
    causal_disposition: "introduced",
    claim: "stale derived state after mutation",
    proof_refs: ["diff-hunk#1"],
    hunter: "reliability",
    tier: "blocking",
    hops_used: 1,
    hop_trail: [],
    dedupe_key: "Project.ts:save:1",
    ...overrides,
  };
}

function baseDocument(findings: Finding[] = [baseFinding()]): FindingsDocument {
  return {
    schema_version: SCHEMA_VERSION,
    pr: 1546,
    base_sha: "b4efc4c2c2e3b37445b4505171006ed05130c2cc",
    head_sha: "067297acd7e7aac125a156bf597f4d05d255659e",
    model: "sonnet",
    iteration: 1,
    parity_hunter_fired: false,
    run_status: "complete",
    telemetry: {
      index_ms: 1000,
      index_mode: "fresh",
      index_disk_mb: 12,
      wall_ms: 5000,
      tokens_in: 100,
      tokens_out: 50,
      tokens_total: 150,
      cost_usd_est: 0.5,
    },
    findings,
    debug: { refuted: [] },
  };
}

describe("findings schema round-trip", () => {
  test("validates a well-formed document unchanged", () => {
    const doc = baseDocument();
    expect(validateFindingsDocument(doc)).toEqual(doc);
  });

  test("rejects the wrong schema_version", () => {
    const doc = { ...baseDocument(), schema_version: "0.9.0" };
    expect(() => validateFindingsDocument(doc)).toThrow();
  });

  test("rejects a finding missing a required field", () => {
    const { id: _id, ...withoutId } = baseFinding();
    expect(() =>
      validateFindingsDocument(baseDocument([withoutId as Finding])),
    ).toThrow();
  });

  test("accepts the not_submitted refuter verdict (canonical n/a)", () => {
    const doc = baseDocument([
      baseFinding({ refuter_verdict: "not_submitted" }),
    ]);
    expect(() => validateFindingsDocument(doc)).not.toThrow();
  });

  test("accepts an optional engine envelope field", () => {
    const doc = {
      ...baseDocument(),
      engine: { name: "pr-hero", version: "0.1.0" },
    };
    expect(() => validateFindingsDocument(doc)).not.toThrow();
  });
});

// Port check (plan slice 1 eval): the ported validator must accept a REAL
// historical artifact produced by the v1 lab, proving byte-level schema
// compatibility. Skipped when the sibling deep-review checkout is absent
// (e.g. CI on a lone pr-hero clone) — locally it must run.
const historicalRunsDir = join(
  import.meta.dir,
  "../../deep-review/bench/runs/3",
);
describe.skipIf(!existsSync(historicalRunsDir))(
  "v1 lab artifact compatibility",
  () => {
    test("accepts every historical runs/3 findings.json unchanged", async () => {
      const glob = new Bun.Glob("*/findings.json");
      let seen = 0;
      for await (const rel of glob.scan(historicalRunsDir)) {
        const doc = await Bun.file(join(historicalRunsDir, rel)).json();
        expect(() => validateFindingsDocument(doc)).not.toThrow();
        seen++;
      }
      expect(seen).toBeGreaterThan(0);
    });
  },
);

describe("tier derivation (full table)", () => {
  const cases: Array<
    [string, Parameters<typeof deriveTier>[0], "blocking" | "advisory"]
  > = [
    [
      "deterministic BLOCKER bypasses the refuter",
      {
        severity: "BLOCKER",
        evidence_class: "deterministic",
        refuter_verdict: "not_submitted",
      },
      "blocking",
    ],
    [
      "deterministic CRITICAL bypasses the refuter",
      {
        severity: "CRITICAL",
        evidence_class: "deterministic",
        refuter_verdict: "not_submitted",
      },
      "blocking",
    ],
    [
      "inferential BLOCKER corroborated by the refuter",
      {
        severity: "BLOCKER",
        evidence_class: "inferential",
        refuter_verdict: "corroborated",
      },
      "blocking",
    ],
    [
      "inferential BLOCKER left inconclusive",
      {
        severity: "BLOCKER",
        evidence_class: "inferential",
        refuter_verdict: "inconclusive",
      },
      "advisory",
    ],
    [
      "inferential CRITICAL refuted (excluded upstream, tier is moot but defined)",
      {
        severity: "CRITICAL",
        evidence_class: "inferential",
        refuter_verdict: "refuted",
      },
      "advisory",
    ],
    [
      "insufficient evidence is always advisory",
      {
        severity: "BLOCKER",
        evidence_class: "insufficient",
        refuter_verdict: "not_submitted",
      },
      "advisory",
    ],
    [
      "WARNING severity is always advisory",
      {
        severity: "WARNING",
        evidence_class: "deterministic",
        refuter_verdict: "not_submitted",
      },
      "advisory",
    ],
    [
      "SUGGESTION severity is always advisory",
      {
        severity: "SUGGESTION",
        evidence_class: "inferential",
        refuter_verdict: "corroborated",
      },
      "advisory",
    ],
  ];

  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(deriveTier(input)).toBe(expected);
    });
  }
});
