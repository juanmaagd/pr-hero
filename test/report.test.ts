import { describe, expect, test } from "bun:test";
import type { Finding, FindingsDocument, Telemetry } from "../src/findings";
import { estimateCost, type ReportMeta, renderReport } from "../src/report";
import { clusterByRootCause } from "../src/root-cause";

const ANCHOR = "src/duration.ts:19-20";

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    category: 12,
    path: "src/app.ts",
    line: 42,
    severity: "BLOCKER",
    evidence_class: "deterministic",
    refuter_verdict: "corroborated",
    causal_disposition: "introduced",
    claim: "the value is stored in seconds and read as milliseconds",
    proof_refs: [`${ANCHOR} (fromSeconds stores raw seconds)`],
    hunter: "reliability",
    tier: "blocking",
    hops_used: 2,
    hop_trail: [],
    dedupe_key: `${overrides.path ?? "src/app.ts"}::12`,
    ...overrides,
  };
}

const TELEMETRY: Telemetry = {
  index_ms: 0,
  index_mode: "sync",
  index_disk_mb: 0,
  wall_ms: 754_000,
  tokens_in: 100,
  tokens_out: 20,
  tokens_total: 120,
  cost_usd_est: 12.9,
  per_agent: {
    reliability: { tokens_total: 60, duration_ms: 1000 },
    lifecycle: { tokens_total: 60, duration_ms: 1000 },
  },
};

function doc(overrides: Partial<FindingsDocument> = {}): FindingsDocument {
  const findings = overrides.findings ?? [];
  return {
    schema_version: "1.0.0",
    pr: 0,
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    model: "sonnet",
    iteration: 0,
    engine: { name: "pr-hero", version: "0.1.0" },
    parity_hunter_fired: false,
    run_status: "complete",
    telemetry: TELEMETRY,
    findings,
    debug: { refuted: [], root_causes: clusterByRootCause(findings) },
    ...overrides,
  };
}

const META: ReportMeta = {
  repo: "musive",
  base: "main",
  head: "feature",
  diffStat: { files: 3, insertions: 120, deletions: 45 },
  costUsd: 12.9,
  wallMs: 754_000,
};

describe("renderReport", () => {
  // The reason this whole module exists: one systemic defect reported at K
  // call sites must read as ONE thing to fix, not as K problems.
  test("a fan-out renders one root-cause heading listing every site", () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", path: "src/b.ts", line: 20 }),
      finding({ id: "F003", path: "src/c.ts", line: 30 }),
    ];
    const markdown = renderReport(doc({ findings }), META);
    expect(markdown).toContain("## Blocking (3 findings, 1 root cause)");
    expect(markdown).toContain(`### RC001 — \`${ANCHOR}\``);
    expect(markdown).toContain("One defect reported at 3 sites");
    expect(markdown).toContain("- F001 `src/a.ts:10` —");
    expect(markdown).toContain("- F002 `src/b.ts:20` —");
    expect(markdown).toContain("- F003 `src/c.ts:30` —");
    // Exactly one heading for the cluster, never one per site.
    expect(markdown.match(/^### /gm)?.length).toBe(1);
  });

  test("singletons render with their full detail", () => {
    const findings = [
      finding({
        id: "F001",
        symbol: "toMillis",
        proof_refs: ["src/a.ts:10 (producer)", "src/b.ts:20 (consumer)"],
      }),
      finding({
        id: "F002",
        path: "src/other.ts",
        line: 7,
        severity: "CRITICAL",
        evidence_class: "inferential",
        causal_disposition: "worsened",
        hunter: "lifecycle",
        proof_refs: ["src/other.ts:7 (unrelated anchor)"],
      }),
    ];
    const markdown = renderReport(doc({ findings }), META);
    expect(markdown).toContain("## Blocking (2 findings, 2 root causes)");
    expect(markdown).toContain("### F001 — `src/app.ts:42` (toMillis)");
    expect(markdown).toContain(
      "- BLOCKER · evidence deterministic · introduced · hunter reliability · " +
        "refuter corroborated",
    );
    expect(markdown).toContain("- Proof:");
    expect(markdown).toContain("  - src/b.ts:20 (consumer)");
    expect(markdown).toContain("### F002 — `src/other.ts:7`");
    expect(markdown).toContain("hunter lifecycle");
  });

  test("a finding with no symbol still renders", () => {
    const markdown = renderReport(
      doc({ findings: [finding({ id: "F001" })] }),
      META,
    );
    expect(markdown).toContain("### F001 — `src/app.ts:42`\n");
    expect(markdown).not.toContain("undefined");
  });

  // Older artifacts predate debug.root_causes entirely; the renderer must
  // recompute rather than degrade to a flat list.
  test("a document without debug.root_causes is clustered on the fly", () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", path: "src/b.ts", line: 20 }),
    ];
    const markdown = renderReport(
      doc({ findings, debug: { refuted: [] } }),
      META,
    );
    expect(markdown).toContain("## Blocking (2 findings, 1 root cause)");
    expect(markdown).toContain(`### RC001 — \`${ANCHOR}\``);
    expect(markdown).toContain("One defect reported at 2 sites");
  });

  test("clusters that straddle the tier split count only their own sites", () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", path: "src/b.ts", line: 20 }),
      finding({
        id: "F003",
        path: "src/c.ts",
        line: 30,
        severity: "WARNING",
        tier: "advisory",
      }),
    ];
    const markdown = renderReport(doc({ findings }), META);
    expect(markdown).toContain("## Blocking (2 findings, 1 root cause)");
    expect(markdown).toContain("One defect reported at 2 sites");
    expect(markdown).toContain("## Advisory (1 finding, 1 root cause)");
    expect(markdown).toContain("### F003 — `src/c.ts:30`");
  });

  test("an empty document renders every section without throwing", () => {
    const markdown = renderReport(doc(), META);
    expect(markdown).toContain("## Blocking (0 findings, 0 root causes)");
    expect(markdown).toContain("_Nothing blocking._");
    expect(markdown).toContain("## Advisory (0 findings, 0 root causes)");
    expect(markdown).toContain("_Nothing advisory._");
    expect(markdown).toContain(
      "Nothing was refuted, and nothing was merged as a duplicate.",
    );
    expect(markdown).toContain("3 files, +120 −45 · run complete · $12.90");
  });

  test("advisory-only documents leave blocking empty", () => {
    const findings = [
      finding({ id: "F001", severity: "WARNING", tier: "advisory" }),
    ];
    const markdown = renderReport(doc({ findings }), META);
    expect(markdown).toContain("## Blocking (0 findings, 0 root causes)");
    expect(markdown).toContain("## Advisory (1 finding, 1 root cause)");
  });

  test("the not-reported section keeps drops attributable", () => {
    const { tier: _tier, ...base } = finding({
      id: "F009",
      claim: "double free",
    });
    const markdown = renderReport(
      doc({
        debug: {
          refuted: [{ ...base, refuter_verdict: "refuted" }],
          deduped: [],
          root_causes: clusterByRootCause([]),
        },
      }),
      META,
    );
    expect(markdown).toContain("1 refuted, 0 merged as duplicates.");
    expect(markdown).toContain(
      "- F009 `src/app.ts:42` — double free — refuted",
    );
  });

  test("a document with no per_agent telemetry still renders the run line", () => {
    const markdown = renderReport(
      doc({ telemetry: { ...TELEMETRY, per_agent: undefined } }),
      META,
    );
    expect(markdown).toContain("run complete");
    expect(markdown).not.toContain("Agents:");
  });

  test("per-agent status is surfaced when the engine recorded it", () => {
    const markdown = renderReport(
      doc({
        telemetry: {
          ...TELEMETRY,
          per_agent: {
            reliability: {
              tokens_total: 1,
              duration_ms: 1,
              status: "ok",
            } as never,
            lifecycle: {
              tokens_total: 1,
              duration_ms: 1,
              status: "failed",
            } as never,
          },
        },
      }),
      META,
    );
    expect(markdown).toContain("Agents: reliability ok · lifecycle failed");
  });

  test("hunter prose that could break markdown is neutralised", () => {
    const findings = [
      finding({
        id: "F001",
        claim: "line one\nline two",
        path: "src/`weird`.ts",
        proof_refs: ["src/x.ts:1 (a\nmultiline ref)"],
      }),
    ];
    const markdown = renderReport(doc({ findings }), META);
    expect(markdown).toContain("line one line two");
    expect(markdown).toContain("### F001 — `src/'weird'.ts:42`");
    expect(markdown).toContain("  - src/x.ts:1 (a multiline ref)");
  });

  test("rendering is deterministic", () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", severity: "WARNING", tier: "advisory" }),
    ];
    const first = renderReport(doc({ findings }), META);
    const second = renderReport(doc({ findings }), META);
    expect(first).toBe(second);
  });

  test("the closing note names the engine and disclaims a merge gate", () => {
    const markdown = renderReport(doc(), META);
    expect(markdown).toContain("Generated by pr-hero 0.1.0.");
    expect(markdown).toContain("not a merge gate");
  });
});

describe("estimateCost", () => {
  const SMALL = { files: 3, insertions: 120, deletions: 45 };
  const LARGE = { files: 45, insertions: 2775, deletions: 1237 };

  test("returns a band, never a point", () => {
    const estimate = estimateCost(SMALL, 4);
    expect(estimate.low).toBeLessThan(estimate.high);
    expect(estimate.basis).toContain("band");
  });

  // The two measured calibration points must land inside the band they were
  // fitted from, or the fit is decoration.
  test("brackets the measured 45-file run", () => {
    const estimate = estimateCost(LARGE, 5);
    expect(estimate.low).toBeLessThanOrEqual(11);
    expect(estimate.high).toBeGreaterThanOrEqual(14.78);
  });

  test("brackets the measured small run", () => {
    const estimate = estimateCost(
      { files: 5, insertions: 150, deletions: 50 },
      4,
    );
    expect(estimate.low).toBeLessThanOrEqual(2.61);
    expect(estimate.high).toBeGreaterThanOrEqual(2.61);
  });

  test("grows with diff size", () => {
    expect(estimateCost(LARGE, 4).high).toBeGreaterThan(
      estimateCost(SMALL, 4).high,
    );
    expect(estimateCost(LARGE, 4).low).toBeGreaterThan(
      estimateCost(SMALL, 4).low,
    );
  });

  test("grows with hunter count", () => {
    expect(estimateCost(SMALL, 5).high).toBeGreaterThan(
      estimateCost(SMALL, 3).high,
    );
  });

  test("a zero diff is non-negative and still a band", () => {
    const estimate = estimateCost({ files: 0, insertions: 0, deletions: 0 }, 4);
    expect(estimate.low).toBeGreaterThanOrEqual(0);
    expect(estimate.low).toBeLessThan(estimate.high);
  });

  test("negative inputs and a zero hunter count cannot produce a bad band", () => {
    const estimate = estimateCost(
      { files: -5, insertions: -10, deletions: -10 },
      0,
    );
    expect(estimate.low).toBeGreaterThanOrEqual(0);
    expect(estimate.low).toBeLessThan(estimate.high);
  });
});
