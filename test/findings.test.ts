import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveTier,
  type Finding,
  type FindingsDocument,
  mergeRunEnvelope,
  type RunSummary,
  SCHEMA_VERSION,
  validateFindingsDocument,
  writeFindings,
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

const summary: RunSummary = {
  prose: "This change improves upload state handling.",
  score: 4,
  score_reason: "The change is focused and the main behavior is covered.",
};

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
      engine: { name: "pr-hero", version: "1.0.0" },
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

  // The write gate for the same defect the draft boundary now normalises: a
  // null symbol must never survive into findings.json. REPAIRED, not rejected,
  // because this validator does double duty — `pr-hero post --from <run-dir>`
  // (cli.ts runPostCommand) re-validates an artifact READ BACK off disk, and
  // rejecting there would permanently strand the $3.77 PR #50 run whose post
  // this defect already ate. Repair keeps the recovery path open.
  test("repairs a null symbol instead of rejecting the artifact", () => {
    const doc = baseDocument([
      { ...baseFinding(), symbol: null } as unknown as Finding,
    ]);
    const validated = validateFindingsDocument(doc);
    expect(Object.hasOwn(validated.findings[0] ?? {}, "symbol")).toBe(false);
    expect(validated.findings[0]?.symbol).toBeUndefined();
  });

  test("repairs a null root_cause_id the same way", () => {
    const doc = baseDocument([
      { ...baseFinding(), root_cause_id: null } as unknown as Finding,
    ]);
    const validated = validateFindingsDocument(doc);
    expect(Object.hasOwn(validated.findings[0] ?? {}, "root_cause_id")).toBe(
      false,
    );
  });

  test("keeps a real symbol untouched", () => {
    const doc = baseDocument([baseFinding({ symbol: "save" })]);
    expect(validateFindingsDocument(doc).findings[0]?.symbol).toBe("save");
  });

  // A wrong-typed symbol currently reaches the renderer and throws the same
  // TypeError this defect did ((42).replace is not a function). Rejecting it
  // here turns an unrecoverable crash into a legible error; unlike null there
  // is no meaning to recover, so repair would be a guess.
  test("rejects a symbol that is present but not a string", () => {
    const doc = baseDocument([
      { ...baseFinding(), symbol: 42 } as unknown as Finding,
    ]);
    expect(() => validateFindingsDocument(doc)).toThrow();
  });

  test("rejects a null element inside proof_refs", () => {
    const doc = baseDocument([
      {
        ...baseFinding(),
        proof_refs: ["diff-hunk#1", null],
      } as unknown as Finding,
    ]);
    expect(() => validateFindingsDocument(doc)).toThrow();
  });

  test("accepts an optional summary and validates it", () => {
    const doc = { ...baseDocument(), summary };
    expect(validateFindingsDocument(doc)).toEqual(doc);
  });

  test("rejects an invalid optional summary", () => {
    const doc = { ...baseDocument(), summary: { ...summary, score: 6 } };
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
  function skillOutput(runStatus: "complete" | "partial", withSummary = false) {
    return {
      findings: [],
      debug: { refuted: [] },
      parity_hunter_fired: false,
      run_status: runStatus,
      ...(withSummary ? { summary } : {}),
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
    expect("summary" in doc).toBe(false);
  });

  test("summary is copied from skill output without changing run status", () => {
    const doc = mergeRunEnvelope({
      ...envelopeArgs,
      skillOutput: skillOutput("complete", true),
      sessionFailed: false,
    });
    expect(doc.summary).toEqual(summary);
    expect(doc.run_status).toBe("complete");
  });
});

// findings.json is the artifact the sibling lab reads and the scorer measures;
// what lands in those BYTES is the contract, so this asserts on the raw file
// text rather than on a re-parsed object (a re-parse cannot tell an absent key
// from one JSON.stringify happened to drop).
describe("writeFindings", () => {
  test("never writes a null symbol into the artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-hero-findings-"));
    const out = join(dir, "findings.json");
    await writeFindings(
      out,
      baseDocument([{ ...baseFinding(), symbol: null } as unknown as Finding]),
    );
    const raw = await Bun.file(out).text();
    expect(raw).not.toContain("null");
    expect(raw).not.toContain('"symbol"');
    expect(JSON.parse(raw).findings[0].symbol).toBeUndefined();
  });

  test("still writes a real symbol", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-hero-findings-"));
    const out = join(dir, "findings.json");
    await writeFindings(out, baseDocument([baseFinding({ symbol: "save" })]));
    expect(await Bun.file(out).text()).toContain('"symbol": "save"');
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
  // The options element is LAST and optional so every case predating the
  // refuter-cut-short axis reads exactly as it did — an omitted element is the
  // default (`refuterCutShort: false`), which is also `deriveTier`'s own.
  const cases: Array<
    [
      string,
      Parameters<typeof deriveTier>[0],
      "blocking" | "advisory",
      Parameters<typeof deriveTier>[1]?,
    ]
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
    // The refuter-cut-short axis. When a refuter WAS configured and a
    // ceiling-truncated run refused its leg admission, the survivors carry
    // `not_submitted` — and blocking tier would then assert an adversarial
    // check that never happened. Only that exact pair demotes; the
    // neighbouring cases below are what keeps the demotion from swallowing
    // work that DID happen or a configuration that never asked for a refuter.
    //
    // Note what this table can and cannot see. `deriveTier` takes ONE boolean,
    // deliberately: truncation and zero-refuter configuration are orthogonal,
    // and the caller must conjoin them before calling (src/pipeline.ts
    // `finish()`). So "the ceiling fired but no refuter was configured"
    // appears here as `refuterCutShort: false` — cases 5 and 6 below spell out
    // both ways of arriving at that false, because they are different
    // statements and both must land on blocking.
    [
      "a cut-short refuter demotes an unsubmitted deterministic BLOCKER",
      {
        severity: "BLOCKER",
        evidence_class: "deterministic",
        refuter_verdict: "not_submitted",
      },
      "advisory",
      { refuterCutShort: true },
    ],
    [
      "a cut-short refuter demotes an unsubmitted deterministic CRITICAL",
      {
        severity: "CRITICAL",
        evidence_class: "deterministic",
        refuter_verdict: "not_submitted",
      },
      "advisory",
      { refuterCutShort: true },
    ],
    [
      "a cut-short refuter keeps a CORROBORATED deterministic BLOCKER blocking",
      {
        severity: "BLOCKER",
        evidence_class: "deterministic",
        refuter_verdict: "corroborated",
      },
      "blocking",
      { refuterCutShort: true },
    ],
    [
      "a cut-short refuter keeps an INCONCLUSIVE deterministic BLOCKER blocking",
      {
        severity: "BLOCKER",
        evidence_class: "deterministic",
        refuter_verdict: "inconclusive",
      },
      "blocking",
      { refuterCutShort: true },
    ],
    [
      "a complete run with a refuter configured keeps its deterministic BLOCKER blocking",
      {
        severity: "BLOCKER",
        evidence_class: "deterministic",
        refuter_verdict: "not_submitted",
      },
      "blocking",
      { refuterCutShort: false },
    ],
    // The zero-refuter half of that same `false`, and the reason the option is
    // a conjunction rather than "was the run truncated". With no refuter
    // configured, `not_submitted` is the designed steady state and blocking is
    // intended REGARDLESS of how the run ended — a ceiling that fired on the
    // hunters cut no refuter check short, because none was ever going to
    // submit. The caller passes false for this run even though it truncated.
    [
      "a ceiling-fired run with NO refuter configured keeps its deterministic BLOCKER blocking",
      {
        severity: "BLOCKER",
        evidence_class: "deterministic",
        refuter_verdict: "not_submitted",
      },
      "blocking",
      { refuterCutShort: false },
    ],
    [
      "a cut-short refuter leaves an unrefuted inferential BLOCKER where it already was",
      {
        severity: "BLOCKER",
        evidence_class: "inferential",
        refuter_verdict: "not_submitted",
      },
      "advisory",
      { refuterCutShort: true },
    ],
  ];

  for (const [name, input, expected, options] of cases) {
    test(name, () => {
      expect(deriveTier(input, options)).toBe(expected);
    });
  }
});
