import { describe, expect, test } from "bun:test";
import type { Finding, FindingsDocument, Telemetry } from "../src/findings";
import { PR_COMMENT_MARKER } from "../src/pr-preflight";
import {
  estimateCost,
  formatElapsed,
  type ReportMeta,
  renderPrComment,
  renderReport,
} from "../src/report";
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

describe("renderPrComment", () => {
  // The idempotency contract: postPrComment finds the previous comment by
  // this exact prefix, so the marker must be the very first line, always.
  test("the first line is exactly the marker", () => {
    expect(renderPrComment(doc()).split("\n")[0]).toBe(PR_COMMENT_MARKER);
    expect(
      renderPrComment(doc({ findings: [finding({ id: "F001" })] })).split(
        "\n",
      )[0],
    ).toBe(PR_COMMENT_MARKER);
  });

  test("the title carries the blocking/advisory counts", () => {
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
    const body = renderPrComment(doc({ findings }));
    expect(body).toContain("## pr-hero review — 2 blocking, 1 advisory");
  });

  test("each finding carries tier, path:line and claim", () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({
        id: "F002",
        path: "src/c.ts",
        line: 30,
        severity: "WARNING",
        tier: "advisory",
        claim: "the spinner loop never gets a cleanup",
      }),
    ];
    const body = renderPrComment(doc({ findings }));
    expect(body).toContain(
      "- **blocking** `src/a.ts:10` — the value is stored in seconds and " +
        "read as milliseconds",
    );
    expect(body).toContain(
      "- **advisory** `src/c.ts:30` — the spinner loop never gets a cleanup",
    );
  });

  test("zero findings render the explicit clean bill", () => {
    const body = renderPrComment(doc());
    expect(body).toContain("## pr-hero review — 0 blocking, 0 advisory");
    expect(body).toContain(
      "pr-hero reviewed this PR and found nothing to report.",
    );
  });

  // doc.base_sha IS the diff-from commit (the recorded rule in cli.ts), so
  // the footer's two 8-char shas name the exact range that was reviewed.
  test("the footer names the range, the run status and the engine", () => {
    const body = renderPrComment(doc());
    expect(body).toContain("`bbbbbbbb`");
    expect(body).toContain("`aaaaaaaa`");
    expect(body).toContain("run complete");
    expect(body).toContain("pr-hero 0.1.0");
  });

  test("a document without engine info degrades honestly", () => {
    const body = renderPrComment(doc({ engine: undefined }));
    expect(body).toContain("pr-hero (version not recorded)");
  });

  // The no-economics contract: the fixture telemetry carries cost_usd_est
  // 12.9 and token counts, and none of it may reach a public comment — a
  // "$" anywhere in the body means the contract broke.
  test("no cost and no token counts anywhere", () => {
    const bodies = [
      renderPrComment(doc()),
      renderPrComment(doc({ findings: [finding({ id: "F001" })] })),
    ];
    for (const body of bodies) {
      expect(body).not.toContain("$");
      expect(body).not.toContain("token");
    }
  });

  test("hunter prose that could break markdown is neutralised", () => {
    const body = renderPrComment(
      doc({
        findings: [
          finding({
            id: "F001",
            claim: "line one\nline two",
            path: "src/`weird`.ts",
          }),
        ],
      }),
    );
    expect(body).toContain("line one line two");
    expect(body).toContain("`src/'weird'.ts:42`");
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

  // PR 1682's tree, run twice (2026-08-10/11): $4.74 and $3.92. The band
  // must bracket BOTH — this is the per-agent-floor evidence that retired
  // the legacy ~$2.61 point (two same-engine runs of a comparable tree both
  // landed far above it; a point the instrument contradicts is decoration).
  test("brackets both measured runs of the 1682 tree", () => {
    const estimate = estimateCost(
      { files: 7, insertions: 21, deletions: 8 },
      3,
    );
    expect(estimate.low).toBeLessThanOrEqual(3.92);
    expect(estimate.high).toBeGreaterThanOrEqual(4.74);
  });

  test("brackets the first B0 local run", () => {
    const estimate = estimateCost(
      { files: 5, insertions: 484, deletions: 0 },
      4,
    );
    expect(estimate.low).toBeLessThanOrEqual(3.68);
    expect(estimate.high).toBeGreaterThanOrEqual(3.68);
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

describe("formatElapsed", () => {
  test("seconds only under a minute, floored never rounded", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(59_000)).toBe("59s");
    // 59.9s must not tick the minute early.
    expect(formatElapsed(59_999)).toBe("59s");
  });

  test("minutes with zero-padded seconds from 60s up", () => {
    expect(formatElapsed(60_000)).toBe("1m00s");
    expect(formatElapsed(192_000)).toBe("3m12s");
    expect(formatElapsed(302_000)).toBe("5m02s");
  });

  test("minutes never roll into hours", () => {
    expect(formatElapsed(61 * 60_000)).toBe("61m00s");
  });

  test("negative input clamps to zero", () => {
    expect(formatElapsed(-5)).toBe("0s");
  });
});
