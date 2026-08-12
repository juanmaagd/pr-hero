import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  deriveTier,
  type Finding,
  type FindingsDocument,
  mergeRunEnvelope,
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

  // Juanma's decision (verify-report-pr3, #3305): sessionFailed is additive
  // and optional, same root_cause_id precedent — schema stays 1.0.0.
  test("accepts an optional sessionFailed: true", () => {
    const doc = { ...baseDocument(), sessionFailed: true };
    expect(() => validateFindingsDocument(doc)).not.toThrow();
  });

  test("accepts an optional sessionFailed: false", () => {
    const doc = { ...baseDocument(), sessionFailed: false };
    expect(() => validateFindingsDocument(doc)).not.toThrow();
  });

  test("accepts a document with sessionFailed entirely absent (legacy artifact)", () => {
    const doc = baseDocument();
    expect("sessionFailed" in doc).toBe(false);
    expect(() => validateFindingsDocument(doc)).not.toThrow();
  });

  test("rejects a non-boolean sessionFailed", () => {
    const doc = { ...baseDocument(), sessionFailed: "true" };
    expect(() => validateFindingsDocument(doc)).toThrow();
  });
});

describe("mergeRunEnvelope — sessionFailed persistence", () => {
  const envelopeArgs = {
    pr: 1546,
    base_sha: "b4efc4c2c2e3b37445b4505171006ed05130c2cc",
    head_sha: "067297acd7e7aac125a156bf597f4d05d255659e",
    model: "sonnet",
    iteration: 1,
    telemetry: {
      index_ms: 1000,
      index_mode: "fresh" as const,
      index_disk_mb: 12,
      wall_ms: 5000,
      tokens_in: 100,
      tokens_out: 50,
      tokens_total: 150,
      cost_usd_est: 0.5,
    },
  };
  function skillOutput(runStatus: "complete" | "partial") {
    return {
      findings: [],
      debug: { refuted: [] },
      parity_hunter_fired: false,
      run_status: runStatus,
    };
  }

  test("sessionFailed: true is persisted onto the document", () => {
    const doc = mergeRunEnvelope({
      ...envelopeArgs,
      skillOutput: skillOutput("partial"),
      sessionFailed: true,
    });
    expect(doc.sessionFailed).toBe(true);
    expect(doc.run_status).toBe("partial");
  });

  test("sessionFailed: false is persisted, even on a partial run (some hunter died, others found nothing)", () => {
    const doc = mergeRunEnvelope({
      ...envelopeArgs,
      skillOutput: skillOutput("partial"),
      sessionFailed: false,
    });
    expect(doc.sessionFailed).toBe(false);
    expect(doc.run_status).toBe("partial");
    // The artifact can tell "every hunter failed" and "a partial run for
    // some OTHER reason" apart even though run_status alone cannot.
  });

  test("sessionFailed: false on a complete run round-trips through validateFindingsDocument", () => {
    const doc = mergeRunEnvelope({
      ...envelopeArgs,
      skillOutput: skillOutput("complete"),
      sessionFailed: false,
    });
    expect(() => validateFindingsDocument(doc)).not.toThrow();
    expect(doc.sessionFailed).toBe(false);
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
    // ROADMAP A2. `downgraded-latent` means "real, but unreachable today" —
    // the G6 lesson, and the answer to a defect sitting in newly-added code
    // that nothing calls yet. It must outrank the deterministic short-circuit,
    // because that population is exactly where it applies: on the 2026-07-29
    // AudioTrimmer runs, 26 of 26 blocking findings were deterministic, so a
    // verdict that cannot demote them could never demote anything.
    [
      "downgraded-latent demotes a deterministic BLOCKER",
      {
        severity: "BLOCKER",
        evidence_class: "deterministic",
        refuter_verdict: "downgraded-latent",
      },
      "advisory",
    ],
    [
      "downgraded-latent demotes a deterministic CRITICAL",
      {
        severity: "CRITICAL",
        evidence_class: "deterministic",
        refuter_verdict: "downgraded-latent",
      },
      "advisory",
    ],
    [
      "downgraded-latent demotes an inferential BLOCKER",
      {
        severity: "BLOCKER",
        evidence_class: "inferential",
        refuter_verdict: "downgraded-latent",
      },
      "advisory",
    ],
    // The precedence decision, pinned: only a POSITIVE downgrade outranks
    // deterministic. Silence does not demote — a refuter that looked and could
    // not tell leaves a code-provable claim blocking, mirroring the rule that
    // `refuted` requires positive disproof.
    [
      "inconclusive does NOT demote a deterministic BLOCKER",
      {
        severity: "BLOCKER",
        evidence_class: "deterministic",
        refuter_verdict: "inconclusive",
      },
      "blocking",
    ],
  ];

  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(deriveTier(input)).toBe(expected);
    });
  }
});
