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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertRunMatchesPr,
  computeDroppedFindingIds,
  type InlinePostOutcome,
  postInlineFindings,
  postInlineIfEligible,
  postingExitCode,
  runPostCommand,
} from "../src/cli";
import type { PrHeroFindingRef } from "../src/compare";
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
  // Design rework (Juanma's PR #2 feedback item 2): the summary is CREATED
  // FIRST — before any finding is posted — so its position in the
  // Conversation timeline is fixed early, then PATCHED again LAST with the
  // final delta and comment links. Creation is a POST to
  // `issues/<pr>/comments`; the closing PATCH targets
  // `issues/comments/<id>` — two distinct endpoints, so the test tells them
  // apart by argv shape, not just by stdin prefix (both carry the same
  // marker prefix).
  test("summary created first, then review, then issue comments, then the summary PATCHed last", async () => {
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

    const createIndex = calls.findIndex(
      (c) =>
        c.argv.join(" ").includes("POST") &&
        c.argv.join(" ").includes("issues/42/comments") &&
        c.stdin?.startsWith("<!-- pr-hero-report "),
    );
    const reviewIndex = calls.findIndex((c) =>
      c.argv.join(" ").includes("pulls/42/reviews"),
    );
    const issueIndex = calls.findIndex(
      (c) =>
        c.argv.join(" ").includes("issues/42/comments") &&
        c.stdin?.startsWith(PR_FINDING_MARKER_PREFIX),
    );
    const patchIndex = calls.findIndex(
      (c) =>
        c.argv.join(" ").includes("PATCH") &&
        c.argv.join(" ").includes("issues/comments/") &&
        c.stdin?.startsWith("<!-- pr-hero-report "),
    );
    expect(createIndex).toBeGreaterThanOrEqual(0);
    // The summary create is the FIRST mutating (POST/PATCH) call this run
    // makes — every call before it is a read-only fetch (resolving the
    // plan), never another write.
    const firstMutatingIndex = calls.findIndex(
      (c) => c.argv.includes("POST") || c.argv.includes("PATCH"),
    );
    expect(createIndex).toBe(firstMutatingIndex);
    expect(reviewIndex).toBeGreaterThan(createIndex);
    expect(issueIndex).toBeGreaterThan(reviewIndex);
    expect(patchIndex).toBeGreaterThan(issueIndex);
    // The summary PATCH is the very LAST call this run makes.
    expect(patchIndex).toBe(calls.length - 1);
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

  // CRIT-C (verify-report-pr3, #3305): spec R4 requires EXACTLY one issue
  // comment per un-anchorable finding, never pooled. The prior suite only
  // ever exercised one un-anchorable finding at a time, so a mutation that
  // posts only the FIRST (`toIssuePost.slice(0, 1)`) left the suite green —
  // "at least one" was pinned, "exactly N" was not. Two un-anchorable
  // findings, two distinct marker bodies, closes it.
  test("two un-anchorable findings post as two SEPARATE issue comments, never pooled (R4)", async () => {
    const findings = [
      finding({ id: "F001", path: "src/never-a.ts", line: 1 }),
      finding({ id: "F002", path: "src/never-b.ts", line: 1 }),
    ];
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      // Neither path is in the diff at all — both un-anchorable.
      diffPatch: diffAddingLines("src/other.ts", 5),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewFindingCount).toBe(0);
    expect(outcome.issueCommentIds.length).toBe(2);
    expect(outcome.droppedFindingIds).toEqual([]);
    const findingComments = calls.filter(
      (c) =>
        c.argv.join(" ").includes("issues/42/comments") &&
        c.stdin?.startsWith(PR_FINDING_MARKER_PREFIX),
    );
    expect(findingComments).toHaveLength(2);
    const bodies = findingComments.map((c) => c.stdin);
    expect(bodies[0]).not.toEqual(bodies[1]);
    expect(bodies.some((b) => b?.includes("path=src%2Fnever-a.ts"))).toBe(true);
    expect(bodies.some((b) => b?.includes("path=src%2Fnever-b.ts"))).toBe(true);
  });
});

describe("postInlineFindings — the 422 recovery never drops a finding", () => {
  // Mirrors verify-report-pr2 (#3296)'s CRIT-1 repro at THIS composition
  // layer: a prior comment already claimed by a PERSISTING finding must not
  // become available to swallow a DIFFERENT, genuinely fresh finding during
  // the 422 recovery. Proven by mutation (Method, per the brief): with
  // `allFindings` narrowed back to just the review-submission subset
  // (`reviewFindings`) in postInlineFindings, this test's assertion on
  // `issueCommentIds.length` fails (F002 disappears from both channels);
  // reverted after observing the failure.
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

  // CRIT-A (verify-report-pr3, #3305) — the verifier's exact tie-dissolution
  // repro, driven through the FULL composition (resolveInlinePostPlan →
  // postPrReview's 422 recovery), not just the pr.ts unit. Prior comments R1
  // @ line 100 and R2 @ line 104 sit equidistant (2, 2) from F001 @ line
  // 102 — a genuine ambiguous tie the ORIGINAL plan resolves by posting F001
  // fresh, per spec "Ambiguous matches post as new, never a forced match".
  // F002 @ line 104 exactly claims R2 and persists. The failure this guards:
  // narrowing the 422 recovery's re-match to just the review submission's
  // own subset ([F001]) drops R2 from the candidate set (it is "claimed" by
  // F002), leaving R1 as F001's SOLE remaining candidate — dissolving the
  // tie and silently swallowing F001 into neither channel. Property under
  // test: no finding reaches neither channel, for this arrangement too, not
  // only the CRIT-1 arrangement above.
  test("a tie the plan resolved to post-fresh survives the 422 recovery, even though a sibling finding persists to the OTHER tied candidate (CRIT-A)", async () => {
    const r1 = findingMarker({
      path: "src/a.ts",
      line: 100,
      headSha: OLD_HEAD,
      claim: "prior claim one",
    });
    const r2 = findingMarker({
      path: "src/a.ts",
      line: 104,
      headSha: OLD_HEAD,
      claim: "prior claim two",
    });
    const findings = [
      finding({
        id: "F001",
        path: "src/a.ts",
        line: 102,
        claim: "a genuinely new finding, tied between R1 and R2",
      }),
      finding({
        id: "F002",
        path: "src/a.ts",
        line: 104,
        claim: "exactly claims the prior comment at line 104",
      }),
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
              id: 101,
              user: "pr-hero",
              body: `${r1}\nprior claim one`,
              path: "src/a.ts",
              line: 100,
              original_line: 100,
              in_reply_to_id: null,
            },
            {
              id: 102,
              user: "pr-hero",
              body: `${r2}\nprior claim two`,
              path: "src/a.ts",
              line: 104,
              original_line: 104,
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
    // F001 must still reach a channel — never dropped because R2 (F002's
    // match) briefly looked like its sole remaining tie candidate.
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(outcome.reviewOutcome).toBe("demoted");
    expect(outcome.issueCommentIds.length).toBe(1);
    const issueCall = calls.find(
      (c) =>
        c.argv.join(" ").includes("issues/42/comments") &&
        c.stdin?.startsWith(PR_FINDING_MARKER_PREFIX),
    );
    expect(issueCall?.stdin).toContain("line=102");
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
    // F002 fix: the exact same-head branch now consults the claim
    // fingerprint too, so this genuinely idempotent case needs the
    // finding's claim to match what the marker was posted with — an
    // UNCHANGED claim, as the describe block's name promises.
    const findings = [
      finding({
        id: "F001",
        path: "src/a.ts",
        line: 100,
        claim: "unchanged claim",
      }),
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

// Juanma's PR #2 feedback: the summary's index links each line to its own
// comment. Three sources feed `buildCommentUrlMap` (cli.ts) and none are
// exercised by makeFakeGh's STATELESS script — a persisting match's url
// needs no extra fetch, but a FRESHLY posted review comment's url needs a
// re-fetch to see what THIS run just posted, which a stateless fixture
// cannot simulate. This test uses a bespoke, call-counting fake instead.
describe("postInlineFindings — comment url map reaches the summary's index", () => {
  test("persisting, freshly-issued, and freshly-reviewed findings all resolve to a comment url", async () => {
    const WEB_URL = "https://github.com/musivetech/musive";
    const priorMarker = findingMarker({
      path: "src/a.ts",
      line: 10,
      headSha: OLD_HEAD,
      claim: "unchanged claim",
    });
    const findings = [
      // Persists — matched to comment id 7 from a prior run.
      finding({
        id: "F001",
        path: "src/a.ts",
        line: 10,
        claim: "unchanged claim",
      }),
      // Fresh, anchorable — goes into the review submission.
      finding({
        id: "F002",
        path: "src/a.ts",
        line: 20,
        claim: "a fresh anchorable finding",
      }),
      // Fresh, un-anchorable — goes to its own issue comment.
      finding({
        id: "F003",
        path: "src/never.ts",
        line: 1,
        claim: "a fresh un-anchorable finding",
      }),
    ];
    let pullsCommentsCalls = 0;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const calls: RecordedCall[] = [];
    let nextId = 200;
    const respond = (stdout: string, exitCode = 0) => {
      const stream = (text: string) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (text) controller.enqueue(encoder.encode(text));
            controller.close();
          },
        });
      return {
        stdout: stream(stdout),
        stderr: stream(""),
        exited: Promise.resolve(exitCode),
        kill() {},
      };
    };
    const spawnFn = ((argv: string[], opts?: { stdin?: Uint8Array }) => {
      const stdin =
        opts?.stdin === undefined ? undefined : decoder.decode(opts.stdin);
      calls.push({ argv, stdin });
      const joined = argv.join(" ");
      if (
        joined.includes("issues/42/comments") &&
        joined.includes("--paginate")
      ) {
        return respond("");
      }
      if (
        joined.includes("pulls/42/comments") &&
        joined.includes("--paginate")
      ) {
        pullsCommentsCalls += 1;
        const rows: unknown[] = [
          {
            id: 7,
            user: "pr-hero",
            body: `${priorMarker}\nunchanged claim`,
            path: "src/a.ts",
            line: 10,
            original_line: 10,
            in_reply_to_id: null,
          },
        ];
        // Only the SECOND+ fetch (the re-fetch after the review posted)
        // sees F002's own comment — simulating "this run just created it".
        if (pullsCommentsCalls > 1) {
          const freshMarker = findingMarker({
            path: "src/a.ts",
            line: 20,
            headSha: HEAD,
            claim: "a fresh anchorable finding",
          });
          rows.push({
            id: 55,
            user: "pr-hero",
            body: `${freshMarker}\nfresh`,
            path: "src/a.ts",
            line: 20,
            original_line: 20,
            in_reply_to_id: null,
          });
        }
        return respond(ndjson(rows));
      }
      if (joined.includes("pulls/42/reviews")) {
        return respond("");
      }
      return respond(JSON.stringify({ id: nextId++ }));
    }) as unknown as typeof Bun.spawn;

    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 30),
      webUrl: WEB_URL,
      spawnFn,
    });

    expect(outcome.reviewFindingCount).toBe(1); // F002
    expect(outcome.issueCommentIds.length).toBe(1); // F003

    const patchCall = calls.find(
      (c) =>
        c.argv.join(" ").includes("PATCH") &&
        c.stdin?.startsWith("<!-- pr-hero-report "),
    );
    // F001, persisting, linked from plan.persisting with no extra fetch.
    expect(patchCall?.stdin).toContain(`${WEB_URL}/pull/42#discussion_r7`);
    // F002, freshly posted to the review, linked via the post-posting
    // re-fetch + marker match.
    expect(patchCall?.stdin).toContain(`${WEB_URL}/pull/42#discussion_r55`);
    // F003, freshly posted as an issue comment, linked directly from
    // postIssueComment's own return value.
    const issueId = outcome.issueCommentIds[0];
    expect(patchCall?.stdin).toContain(
      `${WEB_URL}/pull/42#issuecomment-${issueId}`,
    );
  });
});

// WARN-5 (verify-report-pr3, #3305): `previousHeadSha` and the finding
// `claim` feed are dead at the composition layer — pinned one layer down
// (report.ts/inline.ts) but not proven to actually REACH those functions
// from here. Both closed below.
describe("postInlineFindings — previousHeadSha reaches the rendered summary", () => {
  test("a prior summary comment's head= is threaded through to the delta's 'since' clause", async () => {
    const priorSummary = `<!-- pr-hero-report head=${OLD_HEAD} -->\n## pr-hero review`;
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([{ id: 1, user: "pr-hero", body: priorSummary }]),
        },
      },
      { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
    ]);
    await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    const summaryCall = calls.find((c) =>
      c.stdin?.startsWith("<!-- pr-hero-report "),
    );
    expect(summaryCall).toBeDefined();
    // "diff from `aaaaaaaa`" (base_sha) ALSO contains OLD_HEAD's 8-char
    // prefix unconditionally, so assert the SPECIFIC "since" clause, not
    // merely the substring's presence — the weaker assertion would pass
    // even with previousHeadSha wired to undefined.
    expect(summaryCall?.stdin).toContain(`Δ since \`${OLD_HEAD.slice(0, 8)}\``);
  });
});

// WARN-5's other half: the fingerprint tie-break (design D3) depends on the
// REAL claim text reaching the matcher through resolveInlinePostPlan's
// `findingRefs` — a claim silently replaced by "" would disable the
// tie-break for every real run.
describe("postInlineFindings — the claim feed reaches the fingerprint tie-break", () => {
  test("a tie resolved by a matching fingerprint persists, using the finding's REAL claim text", async () => {
    const priorClaim = "the exact claim text this run's finding repeats";
    const r1 = findingMarker({
      path: "src/a.ts",
      line: 100,
      headSha: OLD_HEAD,
      claim: "a different prior claim, at the same distance",
    });
    const r2 = findingMarker({
      path: "src/a.ts",
      line: 104,
      headSha: OLD_HEAD,
      claim: priorClaim,
    });
    // F001 sits equidistant (2) from both R1 (line 100) and R2 (line 104) —
    // an ambiguous tie UNLESS the fingerprint on its real claim breaks it
    // toward R2, whose stored fingerprint matches priorClaim.
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 102, claim: priorClaim }),
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
              id: 101,
              user: "pr-hero",
              body: `${r1}\na different prior claim, at the same distance`,
              path: "src/a.ts",
              line: 100,
              original_line: 100,
              in_reply_to_id: null,
            },
            {
              id: 102,
              user: "pr-hero",
              body: `${r2}\n${priorClaim}`,
              path: "src/a.ts",
              line: 104,
              original_line: 104,
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
    // The fingerprint tie-break resolved the ambiguity: F001 persists
    // (matched to R2), never posted fresh.
    expect(outcome.reviewFindingCount).toBe(0);
    expect(outcome.issueCommentIds.length).toBe(0);
    // R1 (unmatched this run) is the delta's "resolved" side; F001 is the
    // "persist" side (matched to R2 via the fingerprint tie-break).
    expect(outcome.delta).toEqual({ resolved: 1, new: 0, persist: 1 });
    expect(calls.some((c) => c.argv.join(" ").includes("reviews"))).toBe(false);
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

describe("computeDroppedFindingIds — design D6's oracle", () => {
  // WARN-1 (verify-report-pr3, #3305): under the CRIT-A fix, a genuine drop
  // is no longer reachable through normal postInlineFindings execution — the
  // formula itself still needs its own pin, hand-built, the same way
  // postingExitCode is tested against a literal rather than a live outcome.
  function ref(id: string): PrHeroFindingRef {
    return { id, path: "src/a.ts", line: 1, claim: "x", tier: "blocking" };
  }

  test("every expected id reached: nothing dropped", () => {
    expect(
      computeDroppedFindingIds(
        [ref("F001"), ref("F002")],
        new Set(["F001", "F002"]),
      ),
    ).toEqual([]);
  });

  test("an expected id absent from reached: dropped", () => {
    expect(
      computeDroppedFindingIds([ref("F001"), ref("F002")], new Set(["F001"])),
    ).toEqual(["F002"]);
  });

  test("reached carrying an id NOT in expected does not manufacture a drop", () => {
    expect(
      computeDroppedFindingIds([ref("F001")], new Set(["F001", "F999"])),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runPostCommand — CRIT-B (verify-report-pr3, #3305): the `post` verb is the
// $0 gate standing in front of the first live GitHub write this project will
// ever make. It had zero covering tests and was structurally untestable —
// unexported, and its dry-run branch never threaded `spawnFn`, so even an
// exported version would still have reached the real `gh`. Fixed by
// extracting `runPostCommand` (everything after `resolveRepoRoot`'s real
// `git` call, which stays in the unexported, untested-by-design
// `postCommand` shell) as an exported, `spawnFn`-injectable function.
//
// Uses a REAL temp directory for findings.json/diff.patch (runPostCommand
// reads them off disk via Bun.file — that I/O is not worth faking) but a
// FAKE gh for every network-shaped call, via the same makeFakeGh harness
// used everywhere else in this file.

const RUN_HEAD = "c".repeat(40);

async function writeRunDir(
  overrides: Partial<FindingsDocument> = {},
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-post-test-"));
  const runDoc = doc({ head_sha: RUN_HEAD, ...overrides });
  await Bun.write(
    path.join(dir, "findings.json"),
    JSON.stringify(runDoc, null, 2),
  );
  await Bun.write(
    path.join(dir, "diff.patch"),
    diffAddingLines("src/a.ts", 200),
  );
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("runPostCommand — CRIT-B: the $0 gate before the first live write", () => {
  test("dry-run performs ZERO mutating gh calls — inverting this must fail a test", async () => {
    const { dir, cleanup } = await writeRunDir({
      findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
    });
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: true,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      // The read-only comment fetches DID happen (this is a real preview,
      // not a no-op) — but nothing in them mutates.
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.argv).not.toContain("--method");
        expect(call.argv.join(" ")).not.toContain("reviews");
      }
    } finally {
      await cleanup();
    }
  });

  test("a live post (no --dry-run) performs exactly the expected mutating calls and writes post.json", async () => {
    const { dir, cleanup } = await writeRunDir({
      findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
    });
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...emptyCommentScript(),
        { match: ["pulls/42/reviews"], response: { stdout: "" } },
      ]);
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(
        calls.some((c) => c.argv.join(" ").includes("pulls/42/reviews")),
      ).toBe(true);
      expect(
        calls.some(
          (c) =>
            c.argv.join(" ").includes("issues/42/comments") &&
            c.stdin?.startsWith("<!-- pr-hero-report "),
        ),
      ).toBe(true);
      // WARN-2 (verify-report-pr3): post.json is written but was never
      // asserted anywhere — WU7/4.4's idempotency proof reads it back.
      const receiptPath = path.join(dir, "post.json");
      const receipt = JSON.parse(await Bun.file(receiptPath).text());
      expect(receipt.pr).toBe(42);
      expect(receipt.head_sha).toBe(RUN_HEAD);
      expect(receipt.review.outcome).toBe("posted");
      expect(receipt.review.finding_count).toBe(1);
      expect(Array.isArray(receipt.issue_comment_ids)).toBe(true);
      expect(receipt.dropped_finding_ids).toEqual([]);
      expect(receipt.summary_comment.action).toBe("created");
    } finally {
      await cleanup();
    }
  });

  // WARN-3 (deferred from PR2's verification): assertRunMatchesPr's call
  // site inside the verb, not just the pure function — reject a run-dir
  // whose OWN findings.json disagrees with --pr, before any gh call at all.
  test("a run-dir for a DIFFERENT pr is rejected before any gh call — assertRunMatchesPr's call site", async () => {
    const { dir, cleanup } = await writeRunDir({ pr: 17 });
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 18,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(CliUsageError);
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  // The run-status guard: a partial run refuses to post live and makes zero
  // gh calls — this is the property M4 (verify-report-pr3's mutation table)
  // proved unpinned by forcing the guard to `false`.
  test("the run-status guard refuses a partial run on a live post: exit 1, zero gh calls", async () => {
    const { dir, cleanup } = await writeRunDir({ run_status: "partial" });
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(1);
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("the run-status guard on a dry-run of a partial run: exit 0, zero gh calls, no plan printed", async () => {
    const { dir, cleanup } = await writeRunDir({ run_status: "partial" });
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: true,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  // Juanma's decision (verify-report-pr3, #3305): the verb guards on the
  // PERSISTED `sessionFailed`, matching `--pr --post` exactly — a partial
  // run with `sessionFailed: false` (some hunter found nothing, or none ran
  // because gotchas were missing) still posts, same as the live path.
  test("sessionFailed: false persisted on a partial run — posts anyway, matching --pr --post", async () => {
    const { dir, cleanup } = await writeRunDir({
      run_status: "partial",
      sessionFailed: false,
      findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
    });
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...emptyCommentScript(),
        { match: ["pulls/42/reviews"], response: { stdout: "" } },
      ]);
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(
        calls.some((c) => c.argv.join(" ").includes("pulls/42/reviews")),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  // The other branch of the same decision: sessionFailed: true persisted —
  // even on a "complete"-looking run_status, the persisted flag is
  // authoritative and refuses to publish.
  test("sessionFailed: true persisted — refuses to post even if run_status looks complete", async () => {
    const { dir, cleanup } = await writeRunDir({
      run_status: "complete",
      sessionFailed: true,
    });
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(1);
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  // Back-compat (mandatory): an artifact written BEFORE this change has no
  // `sessionFailed` field at all. Absent must fall back to today's
  // conservative `run_status !== "complete"` proxy — never to `false`,
  // which would publish a dead run as clean.
  test("sessionFailed absent (legacy artifact) — falls back to the run_status proxy: partial refuses", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-post-test-"));
    try {
      // Hand-built, deliberately WITHOUT `sessionFailed`, unlike writeRunDir
      // (which always calls doc(), and doc()'s spread would carry `undefined`
      // through JSON.stringify as an omitted key anyway — written explicitly
      // here so the "legacy artifact" shape is unambiguous to a reader).
      const legacyDoc = {
        schema_version: "1.0.0",
        pr: 42,
        base_sha: OLD_HEAD,
        head_sha: RUN_HEAD,
        model: "sonnet",
        iteration: 0,
        parity_hunter_fired: false,
        run_status: "partial",
        telemetry: TELEMETRY,
        findings: [],
        debug: { refuted: [] },
      };
      expect("sessionFailed" in legacyDoc).toBe(false);
      await Bun.write(
        path.join(dir, "findings.json"),
        JSON.stringify(legacyDoc, null, 2),
      );
      await Bun.write(
        path.join(dir, "diff.patch"),
        diffAddingLines("src/a.ts", 200),
      );
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(1);
      expect(calls.length).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sessionFailed absent (legacy artifact), run_status complete — the proxy proceeds to post", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-post-test-"));
    try {
      const legacyDoc = {
        schema_version: "1.0.0",
        pr: 42,
        base_sha: OLD_HEAD,
        head_sha: RUN_HEAD,
        model: "sonnet",
        iteration: 0,
        parity_hunter_fired: false,
        run_status: "complete",
        telemetry: TELEMETRY,
        findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
        debug: { refuted: [] },
      };
      await Bun.write(
        path.join(dir, "findings.json"),
        JSON.stringify(legacyDoc, null, 2),
      );
      await Bun.write(
        path.join(dir, "diff.patch"),
        diffAddingLines("src/a.ts", 200),
      );
      const { spawnFn, calls } = makeFakeGh([
        ...emptyCommentScript(),
        { match: ["pulls/42/reviews"], response: { stdout: "" } },
      ]);
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(
        calls.some((c) => c.argv.join(" ").includes("pulls/42/reviews")),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
