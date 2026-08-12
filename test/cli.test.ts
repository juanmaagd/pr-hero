// Caller-level tests for cli.ts's ROADMAP B6 wiring (WU6/PR3): the step-14
// posting orchestration (postInlineFindings/postInlineIfEligible) and the
// pure decisions around it (postingExitCode, assertRunMatchesPr).
//
// PR2 verification (#3296) flagged this exact layer as load-bearing and
// missing: pr.ts's primitives (postPrReview, postIssueComment, postPrComment)
// are individually correct and individually tested, but nothing proved the
// CALLER wires them the way design D6 requires — ordering, the
// `sessionFailed` guard, and the exit-1 rule are all decisions this file
// makes, not pr.ts. Same fake-gh pattern as test/pr.test.ts, extended to
// capture stdin (needed to tell a per-finding comment from the summary
// comment — both hit the same `issues/<pr>/comments` endpoint).

import { describe, expect, test } from "bun:test";
import {
  assertRunMatchesPr,
  type InlinePostOutcome,
  postInlineFindings,
  postInlineIfEligible,
  postingExitCode,
} from "../src/cli";
import type { Finding, FindingsDocument, Telemetry } from "../src/findings";
import { findingMarker, PR_FINDING_MARKER_PREFIX } from "../src/pr-preflight";
import { CliUsageError } from "../src/preflight";

// ---------------------------------------------------------------------------
// FakeGh: records every call's argv AND stdin (decoded), in order. Routes
// responses by argv predicate, same shape as test/pr.test.ts's makeFakeGh —
// duplicated rather than imported: pr.ts's test harness is a TEST file, and
// importing test fixtures across test files is the kind of coupling that
// breaks one suite when the other's fixture shape changes for unrelated
// reasons.

interface ScriptedResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

interface ScriptEntry {
  match: string[];
  response: ScriptedResponse;
}

interface RecordedCall {
  argv: string[];
  stdin: string | undefined;
}

function argvContains(argv: string[], tokens: string[]): boolean {
  const joined = argv.join(" ");
  return tokens.every((token) => joined.includes(token));
}

function makeFakeGh(script: ScriptEntry[]): {
  spawnFn: typeof Bun.spawn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // gh api's create/update calls always print `{"id": N}`-shaped JSON; N
  // increments per call so two comments created in the same test never
  // collide on id.
  let nextId = 100;
  const spawnFn = ((argv: string[], opts?: { stdin?: Uint8Array }) => {
    const stdin =
      opts?.stdin === undefined ? undefined : decoder.decode(opts.stdin);
    calls.push({ argv, stdin });
    const entry = script.find((s) => argvContains(argv, s.match));
    let scripted = entry?.response;
    if (scripted === undefined) {
      // Default: any unscripted --method POST/PATCH create succeeds with a
      // fresh id — covers the per-finding issue comments and the summary
      // create/patch without a script entry per call.
      scripted = { stdout: JSON.stringify({ id: nextId++ }), exitCode: 0 };
    }
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    return {
      stdout: stream(scripted.stdout ?? ""),
      stderr: stream(scripted.stderr ?? ""),
      exited: Promise.resolve(scripted.exitCode ?? 0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

function ndjson(rows: unknown[]): string {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

// Empty issue/review comment streams — the common "nothing posted yet"
// baseline every scripted PR extends.
function emptyCommentScript(): ScriptEntry[] {
  return [
    { match: ["issues/42/comments", "--paginate"], response: { stdout: "" } },
    { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
  ];
}

const OPERATOR_ROOT = "/repo";
const HEAD = "b".repeat(40);
const OLD_HEAD = "a".repeat(40);

function diffAddingLines(path: string, count: number): string {
  const body = Array.from({ length: count }, (_, i) => `+line ${i + 1}`).join(
    "\n",
  );
  return (
    `diff --git a/${path} b/${path}\n` +
    `index 0000000..1111111 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -0,0 +1,${count} @@\n` +
    `${body}\n`
  );
}

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    category: 12,
    path: "src/app.ts",
    line: 10,
    severity: "BLOCKER",
    evidence_class: "deterministic",
    refuter_verdict: "corroborated",
    causal_disposition: "introduced",
    claim: "the value is stored in seconds and read as milliseconds",
    proof_refs: [],
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
  wall_ms: 1000,
  tokens_in: 10,
  tokens_out: 10,
  tokens_total: 20,
  cost_usd_est: 1,
};

function doc(overrides: Partial<FindingsDocument> = {}): FindingsDocument {
  const findings = overrides.findings ?? [];
  return {
    schema_version: "1.0.0",
    pr: 42,
    base_sha: OLD_HEAD,
    head_sha: HEAD,
    model: "sonnet",
    iteration: 0,
    parity_hunter_fired: false,
    run_status: "complete",
    telemetry: TELEMETRY,
    findings,
    debug: { refuted: [] },
    ...overrides,
  };
}

describe("postInlineFindings — step-14 ordering", () => {
  // Design D6: review submission → per-finding issue comments → summary
  // PATCHed LAST, because the summary's delta must describe what was
  // actually posted this run.
  test("review, then issue comments, then the summary — always last", async () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }), // anchorable
      finding({ id: "F002", path: "src/b.ts", line: 999 }), // un-anchorable
    ];
    const { spawnFn, calls } = makeFakeGh([
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewOutcome).toBe("posted");
    expect(outcome.reviewFindingCount).toBe(1);
    expect(outcome.issueCommentIds.length).toBe(1);
    expect(outcome.droppedFindingIds).toEqual([]);

    const reviewIndex = calls.findIndex((c) =>
      c.argv.join(" ").includes("pulls/42/reviews"),
    );
    const issueIndex = calls.findIndex(
      (c) =>
        c.argv.join(" ").includes("issues/42/comments") &&
        c.stdin?.startsWith(PR_FINDING_MARKER_PREFIX),
    );
    const summaryIndex = calls.findIndex(
      (c) =>
        c.argv.join(" ").includes("issues/42/comments") &&
        c.stdin?.startsWith("<!-- pr-hero-report "),
    );
    expect(reviewIndex).toBeGreaterThanOrEqual(0);
    expect(issueIndex).toBeGreaterThan(reviewIndex);
    expect(summaryIndex).toBeGreaterThan(issueIndex);
    // The summary PATCH/POST is the very LAST call this run makes.
    expect(summaryIndex).toBe(calls.length - 1);
  });

  test("zero anchorable findings never reaches the reviews endpoint at all", async () => {
    const findings = [finding({ id: "F001", path: "src/never.ts", line: 1 })];
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      // "src/never.ts" is not in the diff at all — un-anchorable.
      diffPatch: diffAddingLines("src/other.ts", 5),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewOutcome).toBe("posted");
    expect(outcome.reviewFindingCount).toBe(0);
    expect(outcome.issueCommentIds.length).toBe(1);
    expect(calls.some((c) => c.argv.join(" ").includes("reviews"))).toBe(false);
  });
});

describe("postInlineFindings — consumedCommentIds (CRIT-1 regression guard)", () => {
  // Mirrors verify-report-pr2 (#3296)'s CRIT-1 repro at THIS composition
  // layer: a prior comment already claimed by a PERSISTING finding must not
  // become available to swallow a DIFFERENT, genuinely fresh finding during
  // the 422 recovery. Proven by mutation (Method, per the brief): with
  // `plan.persisting.map(...)` replaced by `[]` in postInlineFindings, this
  // test's assertion on `issueCommentIds.length` fails (F002 disappears
  // from both channels); reverted after observing the failure.
  test("a claimed comment does not swallow a fresh finding on 422", async () => {
    const claimedMarker = findingMarker({
      path: "src/a.ts",
      line: 100,
      headSha: OLD_HEAD,
      claim: "F001's claim",
    });
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 100 }), // persists to P
      finding({ id: "F002", path: "src/a.ts", line: 103 }), // fresh, near P
    ];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        response: { stdout: "" },
      },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 7,
              user: "pr-hero",
              body: `${claimedMarker}\nclaim`,
              path: "src/a.ts",
              line: 100,
              original_line: 100,
              in_reply_to_id: null,
            },
          ]),
        },
      },
      {
        match: ["pulls/42/reviews"],
        response: {
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 200),
      webUrl: undefined,
      spawnFn,
    });
    // F001 already had a home (comment 7); F002 must land in the issue
    // channel — never dropped.
    expect(outcome.reviewOutcome).toBe("demoted");
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(outcome.issueCommentIds.length).toBe(1);
    const issueCall = calls.find(
      (c) =>
        c.argv.join(" ").includes("issues/42/comments") &&
        c.stdin?.startsWith(PR_FINDING_MARKER_PREFIX),
    );
    expect(issueCall?.stdin).toContain("line=103");
  });
});

describe("postInlineFindings — idempotency, same head, drifted live line", () => {
  // Spec "Idempotency across two runs on the same head" + PR1's verify-report
  // §9 note: exercise a same-head case where liveLine != marker.line. GitHub
  // re-anchors a review comment's live `line` whenever the diff changes
  // (e.g. the base moved), even with no new push to THIS head — the
  // same-head match must key on the MARKER's stored line, not the drifted
  // live one, or an unmoved finding reposts.
  test("same head, live line drifted from the marker's stored line: zero reposts", async () => {
    const marker = findingMarker({
      path: "src/a.ts",
      line: 100,
      headSha: HEAD, // SAME head as this run
      claim: "unchanged claim",
    });
    const findings = [finding({ id: "F001", path: "src/a.ts", line: 100 })];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        response: { stdout: "" },
      },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 7,
              user: "pr-hero",
              body: `${marker}\nunchanged claim`,
              path: "src/a.ts",
              // Drifted live line (base advanced, no new push) — 12 away
              // from the marker's stored 100, well outside the ±5 window.
              line: 112,
              original_line: 112,
              in_reply_to_id: null,
            },
          ]),
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 200),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewFindingCount).toBe(0); // matched, not fresh
    expect(outcome.issueCommentIds.length).toBe(0);
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(outcome.delta).toEqual({ resolved: 0, new: 0, persist: 1 });
    // No POST to pulls/42/reviews and no per-finding issue comment — the
    // ONLY mutating call is the summary PATCH/POST.
    expect(calls.some((c) => c.argv.join(" ").includes("reviews"))).toBe(false);
    expect(
      calls.filter(
        (c) =>
          c.argv.join(" ").includes("issues/42/comments") &&
          c.stdin?.startsWith(PR_FINDING_MARKER_PREFIX),
      ).length,
    ).toBe(0);
  });
});

describe("postInlineIfEligible — sessionFailed suppresses all posting", () => {
  test("sessionFailed true: zero HTTP calls, returns null", async () => {
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
    const outcome = await postInlineIfEligible({
      sessionFailed: true,
      skippedReason: "post skipped: every hunter failed",
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings: [finding({ id: "F001" })] }),
      diffPatch: diffAddingLines("src/app.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome).toBeNull();
    expect(calls.length).toBe(0);
  });

  test("sessionFailed false: posts normally and returns the outcome", async () => {
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
    const outcome = await postInlineIfEligible({
      sessionFailed: false,
      skippedReason: "unreachable",
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/app.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome).not.toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("postingExitCode — design D6's exit-1 rule", () => {
  function outcome(overrides: Partial<InlinePostOutcome>): InlinePostOutcome {
    return {
      reviewOutcome: "posted",
      reviewFindingCount: 0,
      issueCommentIds: [],
      summary: { action: "created", commentId: 1 },
      delta: { resolved: 0, new: 0, persist: 0 },
      droppedFindingIds: [],
      ...overrides,
    };
  }

  test("exit 0 when every finding reached a channel", () => {
    expect(postingExitCode(outcome({ droppedFindingIds: [] }))).toBe(0);
  });

  test("exit 1 when any finding reached neither channel", () => {
    expect(postingExitCode(outcome({ droppedFindingIds: ["F002"] }))).toBe(1);
  });

  test("a null outcome (sessionFailed, or --post not given) is not itself a posting failure", () => {
    expect(postingExitCode(null)).toBe(0);
  });
});

describe("assertRunMatchesPr — Threat Matrix: Git repository selection", () => {
  test("a run-dir for the SAME pr passes silently", () => {
    expect(() =>
      assertRunMatchesPr(doc({ pr: 42 }), 42, "/runs/x"),
    ).not.toThrow();
  });

  // Deferred from PR2's verification (WARN-1's scope note): the `post` verb
  // must reject a run-dir belonging to a DIFFERENT PR than --pr names,
  // rather than silently publishing PR #17's findings to PR #18.
  test("a run-dir for a DIFFERENT pr is rejected, naming both", () => {
    try {
      assertRunMatchesPr(doc({ pr: 17 }), 18, "/runs/pr-17-run");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain("17");
      expect((error as Error).message).toContain("18");
      expect((error as Error).message).toContain("/runs/pr-17-run");
    }
  });
});
