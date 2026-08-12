// Offline tests for pr.ts's WU4/WU5 additions (ROADMAP B6): the review-level
// fetcher, the atomic review submission with its 422 recovery, and the
// per-finding issue comment. Same fake-spawn pattern as
// test/step-runner.test.ts's makeFakeSpawn: no real gh/PR anywhere here.
//
// Design Threat Matrix scope note (PR2 verification, WARN-1): the matrix's
// "Git repository selection" row (Applicable — "the `post` verb resolves
// operator root; rejects a run-dir from another PR") names a RED test that
// genuinely cannot be written here. The `post` verb it describes is WU6
// (tasks 3.1-3.3), not yet built — this file only exercises the I/O
// primitives (fetch/postPrReview/postIssueComment) the verb will eventually
// call, and none of them take a run-dir or resolve an operator root by
// themselves (their caller already has one). That RED test belongs beside
// the verb's own parsing/dispatch, in a future test/cli.test.ts addition
// for WU6 — flagged here rather than skipped in silence.
//
// The matrix's OTHER applicable row — "PR commands" (bodies travel on
// stdin, never interpolated into argv) — IS in scope for this file, and is
// covered below: "the body reaching gh on stdin carries the finding's
// identity marker and its claim, verbatim, never via argv".

import { describe, expect, test } from "bun:test";
import type { PrHeroFindingRef } from "../src/compare";
import type { Finding } from "../src/findings";
import {
  fetchPostedFindingComments,
  fetchPrReviewComments,
  postIssueComment,
  postPrReview,
} from "../src/pr";
import { PR_FINDING_MARKER_PREFIX } from "../src/pr-preflight";
import { renderIssueFindingComment } from "../src/report";

// ---------------------------------------------------------------------------
// FakeSpawn: scripted {stdout, stderr, exitCode} per call, in call order.
// Mirrors makeFakeSpawn (test/step-runner.test.ts) but keyed off an argv
// PREDICATE list instead of a flat sequence — pr.ts issues concurrent gh
// calls (fetchPostedFindingComments's Promise.all), so "the Nth call" is not
// a stable enough key.
// ---------------------------------------------------------------------------

interface ScriptedResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

interface ScriptEntry {
  // Matches when every token appears, in order, somewhere in argv.
  match: string[];
  response: ScriptedResponse;
}

interface RecordedCall {
  argv: string[];
  cwd: string | undefined;
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
  const spawnFn = ((argv: string[], opts?: { cwd?: string }) => {
    calls.push({ argv, cwd: opts?.cwd });
    const entry = script.find((s) => argvContains(argv, s.match));
    const scripted = entry?.response ?? { stdout: "", exitCode: 0 };
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

const OPERATOR_ROOT = "/repo";
const HEAD = "b".repeat(40);

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
    proof_refs: [],
    hunter: "reliability",
    tier: "blocking",
    hops_used: 2,
    hop_trail: [],
    dedupe_key: `${overrides.path ?? "src/app.ts"}::12`,
    ...overrides,
  };
}

// ndjson helper matching gh's `--jq` line-per-object streaming.
function ndjson(rows: unknown[]): string {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

describe("fetchPrReviewComments", () => {
  test("projects id, user, body, path, line, original_line, in_reply_to_id", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["pulls/42/comments"],
        response: {
          stdout: ndjson([
            {
              id: 1,
              user: "octocat",
              body: "looks good",
              path: "src/a.ts",
              line: 10,
              original_line: 10,
              in_reply_to_id: null,
            },
          ]),
        },
      },
    ]);
    const comments = await fetchPrReviewComments(OPERATOR_ROOT, 42, {
      spawnFn,
    });
    expect(comments).toEqual([
      {
        id: 1,
        user: "octocat",
        body: "looks good",
        path: "src/a.ts",
        line: 10,
        original_line: 10,
        in_reply_to_id: null,
      },
    ]);
    const call = calls[0];
    expect(call?.argv).toContain("--paginate");
    expect(call?.argv.join(" ")).toContain("pulls/42/comments");
    // The fake gh harness returns scripted stdout regardless of --jq, so
    // pinning the RESPONSE (above) never proves the projection string
    // itself asks for every field the matcher needs — dropping one from
    // `--jq` would still pass a fixture-shaped test. Assert the field
    // names the matcher and a human reader both rely on actually reached
    // gh's argv (WARN-2, PR2 verification): id/user/body for identity and
    // display, path/line for the matcher's live-location preference (D2),
    // original_line + in_reply_to_id for the fields a raw fetch documents.
    const jqIndex = call?.argv.indexOf("--jq") ?? -1;
    expect(jqIndex).toBeGreaterThanOrEqual(0);
    const projection = call?.argv[jqIndex + 1] ?? "";
    // Exact "<key>: .<jq-path>" tokens, not bare field names: "line" is a
    // substring of "original_line", so a bare-name check would stay green
    // even if the `line: .line` clause itself were dropped.
    for (const token of [
      "id: .id",
      "user: .user.login",
      "body: .body",
      "path: .path",
      "line: .line",
      "original_line: .original_line",
      "in_reply_to_id: .in_reply_to_id",
    ]) {
      expect(projection).toContain(token);
    }
  });

  test("a non-2xx response fails loud", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/42/comments"],
        response: { stderr: "gh: not found (HTTP 404)", exitCode: 1 },
      },
    ]);
    await expect(
      fetchPrReviewComments(OPERATOR_ROOT, 42, { spawnFn }),
    ).rejects.toThrow(/pulls\/42\/comments failed/);
  });

  test("an unparseable line fails loud rather than silently dropping it", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/42/comments"],
        response: { stdout: "not json\n" },
      },
    ]);
    await expect(
      fetchPrReviewComments(OPERATOR_ROOT, 42, { spawnFn }),
    ).rejects.toThrow(/unparseable line/);
  });
});

describe("fetchPostedFindingComments — marker prefix disjointness", () => {
  // The regression the design calls for explicitly (WARN scope, PR2): both
  // marker families now live in the SAME issue-comment stream, so the
  // summary comment must never be mistaken for a per-finding one, and vice
  // versa, when scanned by the ACTUAL matcher this run uses — not merely by
  // comparing the two prefix strings (that test already exists, PR1).
  test("a pr-hero-report summary comment is excluded from the finding set", async () => {
    const summaryMarker = `<!-- pr-hero-report head=${HEAD} -->\n## pr-hero review`;
    const findingMarkerBody =
      "<!-- pr-hero-finding path=src%2Fa.ts line=10 head=" +
      `${HEAD} c=abcdef123456 -->\nclaim text`;
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/42/comments"],
        response: { stdout: ndjson([]) },
      },
      {
        match: ["issues/42/comments"],
        response: {
          stdout: ndjson([
            { id: 1, user: "pr-hero", body: summaryMarker },
            { id: 2, user: "pr-hero", body: findingMarkerBody },
            { id: 3, user: "octocat", body: "just a human reply" },
          ]),
        },
      },
    ]);
    const posted = await fetchPostedFindingComments(OPERATOR_ROOT, 42, {
      spawnFn,
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.id).toBe(2);
    expect(posted[0]?.channel).toBe("issue");
  });

  test("review comments with a finding marker are projected with their live path/line", async () => {
    const findingMarkerBody =
      "<!-- pr-hero-finding path=src%2Fa.ts line=10 head=" +
      `${HEAD} c=abcdef123456 -->\nclaim text`;
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/42/comments"],
        response: {
          stdout: ndjson([
            {
              id: 9,
              user: "pr-hero",
              body: findingMarkerBody,
              path: "src/a.ts",
              line: 12,
              original_line: 10,
              in_reply_to_id: null,
            },
          ]),
        },
      },
      { match: ["issues/42/comments"], response: { stdout: ndjson([]) } },
    ]);
    const posted = await fetchPostedFindingComments(OPERATOR_ROOT, 42, {
      spawnFn,
    });
    expect(posted).toEqual([
      {
        id: 9,
        channel: "review",
        marker: {
          path: "src/a.ts",
          line: 10,
          headSha: HEAD,
          c: "abcdef123456",
        },
        livePath: "src/a.ts",
        liveLine: 12,
      },
    ]);
  });
});

// PrHeroFindingRef conversion — postPrReview's `allFindings` argument is the
// FULL finding list the plan matched against (CRIT-A fix, verify-report-pr3
// #3305), not the review-submission subset. Findings' own shape already
// carries every field a ref needs.
function toRef(f: Finding): PrHeroFindingRef {
  return { id: f.id, path: f.path, line: f.line, claim: f.claim, tier: f.tier };
}

describe("postPrReview", () => {
  test("zero anchorable findings never reaches gh at all", async () => {
    const { spawnFn, calls } = makeFakeGh([]);
    const outcome = await postPrReview({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      findings: [],
      allFindings: [],
      spawnFn,
    });
    expect(outcome).toEqual({ outcome: "posted", findings: [] });
    expect(calls).toHaveLength(0);
  });

  test("multiple findings post as ONE review submission, not one per finding", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["pulls/42/reviews"],
        response: { stdout: "{}", exitCode: 0 },
      },
    ]);
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", path: "src/b.ts", line: 20 }),
    ];
    const outcome = await postPrReview({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      findings,
      allFindings: findings.map(toRef),
      spawnFn,
    });
    expect(outcome).toEqual({ outcome: "posted", findings });
    // Exactly one gh invocation for the review, carrying BOTH comments.
    const reviewCalls = calls.filter((c) =>
      c.argv.join(" ").includes("reviews"),
    );
    expect(reviewCalls).toHaveLength(1);
    const call = reviewCalls[0];
    expect(call?.argv).toContain("--input");
    expect(call?.argv.join(" ")).toContain("pulls/42/reviews");
  });

  // The load-bearing check itself: prove the body sent on stdin carries
  // event: COMMENT and a comments[] array with one entry per finding.
  test("the request body is a single COMMENT review with comments[] per finding", async () => {
    let capturedStdin: Uint8Array | undefined;
    const spawnFn = ((argv: string[], opts?: { stdin?: Uint8Array }) => {
      if (argv.join(" ").includes("reviews")) capturedStdin = opts?.stdin;
      const encoder = new TextEncoder();
      const stream = (text: string) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
          },
        });
      return {
        stdout: stream("{}"),
        stderr: stream(""),
        exited: Promise.resolve(0),
        kill() {},
      };
    }) as unknown as typeof Bun.spawn;
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", path: "src/b.ts", line: 20 }),
    ];
    await postPrReview({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      findings,
      allFindings: findings.map(toRef),
      spawnFn,
    });
    expect(capturedStdin).toBeDefined();
    const body = JSON.parse(new TextDecoder().decode(capturedStdin));
    expect(body.event).toBe("COMMENT");
    expect(body.comments).toHaveLength(2);
    expect(body.comments[0].path).toBe("src/a.ts");
    expect(body.comments[0].line).toBe(10);
    expect(typeof body.comments[0].body).toBe("string");
  });

  // The 422 recovery (spec "GitHub is the anchor authority", design D1):
  // the atomic submission is rejected, and every finding still reaches a
  // channel — none are silently dropped.
  test("a 422 demotes every still-unmatched finding, none dropped", async () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", path: "src/b.ts", line: 20 }),
      finding({ id: "F003", path: "src/c.ts", line: 30 }),
    ];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["pulls/42/reviews"],
        response: {
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        },
      },
      { match: ["pulls/42/comments"], response: { stdout: ndjson([]) } },
      { match: ["issues/42/comments"], response: { stdout: ndjson([]) } },
    ]);
    const outcome = await postPrReview({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      findings,
      allFindings: findings.map(toRef),
      spawnFn,
    });
    expect(outcome.outcome).toBe("demoted");
    expect(outcome.findings.map((f) => f.id).sort()).toEqual([
      "F001",
      "F002",
      "F003",
    ]);
    // The recovery re-fetches BOTH streams (the matcher's own contract).
    expect(
      calls.some((c) => c.argv.join(" ").includes("pulls/42/comments")),
    ).toBe(true);
    expect(
      calls.some((c) => c.argv.join(" ").includes("issues/42/comments")),
    ).toBe(true);
    // The rejected submission is never retried — exactly one attempt at the
    // review endpoint.
    expect(
      calls.filter((c) => c.argv.join(" ").includes("reviews")),
    ).toHaveLength(1);
  });

  // The matcher doubles as the recovery mechanism: a finding that the
  // re-fetch shows is ALREADY posted (e.g. a leftover from a crashed prior
  // run) is not reposted — it drops out of the demoted set because it is no
  // longer "fresh".
  test("a 422 does not repost a finding already covered by a leftover comment", async () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      finding({ id: "F002", path: "src/b.ts", line: 20 }),
    ];
    const leftoverMarker =
      "<!-- pr-hero-finding path=src%2Fa.ts line=10 head=" +
      `${HEAD} c=abcdef123456 -->\nclaim text`;
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/42/reviews"],
        response: {
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        },
      },
      {
        match: ["pulls/42/comments"],
        response: {
          stdout: ndjson([
            {
              id: 7,
              user: "pr-hero",
              body: leftoverMarker,
              path: "src/a.ts",
              line: 10,
              original_line: 10,
              in_reply_to_id: null,
            },
          ]),
        },
      },
      { match: ["issues/42/comments"], response: { stdout: ndjson([]) } },
    ]);
    const outcome = await postPrReview({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      findings,
      allFindings: findings.map(toRef),
      spawnFn,
    });
    expect(outcome.outcome).toBe("demoted");
    // F001 already has a home (the leftover comment); only F002 is fresh.
    expect(outcome.findings.map((f) => f.id)).toEqual(["F002"]);
  });

  // CRIT-A (verify-report-pr3, #3305) — the property this whole recovery
  // exists to hold: a finding must reach neither-channel NEVER, for ANY
  // arrangement, not just the one arrangement PR2's regression test covered.
  // This is the verifier's exact tie-dissolution repro. Prior comments R1 @
  // line 100 and R2 @ line 104 both sit within FINDING_LINE_WINDOW (5) of
  // F001 @ line 102 — a genuine tie the ORIGINAL plan (buildPostPlan, called
  // with the full finding list) resolves by posting F001 fresh, because
  // F002 @ line 104 exactly claims R2 and F001's distance to R1 and R2 is
  // identical (2 and 2). The bug this guards: re-matching only the review
  // submission's OWN subset (`findings: [F001]`) against a comment set with
  // R2 excluded would leave R1 as F001's SOLE candidate, dissolving the tie
  // and silently swallowing F001. Passing the FULL finding list as
  // `allFindings` reproduces the plan's own tie exactly, so F001 stays
  // fresh — this is the assertion that fails if `allFindings` is ever
  // narrowed back to `findings` (reintroducing CRIT-A).
  test("a tie the plan already resolved to 'post fresh' survives the 422 recovery (CRIT-A)", async () => {
    const r1 =
      "<!-- pr-hero-finding path=src%2Fa.ts line=100 head=" +
      `${HEAD} c=000000000000 -->\nprior claim one`;
    const r2 =
      "<!-- pr-hero-finding path=src%2Fa.ts line=104 head=" +
      `${HEAD} c=000000000000 -->\nprior claim two`;
    const f001 = finding({
      id: "F001",
      path: "src/a.ts",
      line: 102,
      claim: "a genuinely new finding, distinct from either prior comment",
    });
    const f002 = finding({
      id: "F002",
      path: "src/a.ts",
      line: 104,
      claim: "matches the prior comment at line 104 exactly",
    });
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/42/reviews"],
        response: {
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        },
      },
      {
        match: ["pulls/42/comments"],
        response: {
          stdout: ndjson([
            {
              id: 101,
              user: "pr-hero",
              body: r1,
              path: "src/a.ts",
              line: 100,
              original_line: 100,
              in_reply_to_id: null,
            },
            {
              id: 102,
              user: "pr-hero",
              body: r2,
              path: "src/a.ts",
              line: 104,
              original_line: 104,
              in_reply_to_id: null,
            },
          ]),
        },
      },
      { match: ["issues/42/comments"], response: { stdout: ndjson([]) } },
    ]);
    const outcome = await postPrReview({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      // The submission the plan actually made: only F001 (F002 already
      // persisted to R2 and never reached the review endpoint at all).
      findings: [f001],
      // The FULL finding list, exactly as buildPostPlan saw it — this is
      // what preserves the tie.
      allFindings: [f001, f002].map(toRef),
      spawnFn,
    });
    expect(outcome.outcome).toBe("demoted");
    // F001 must still be here — reaching the issue-comment channel — never
    // silently dropped because R2 (claimed by F002) briefly looked like its
    // sole remaining candidate.
    expect(outcome.findings.map((f) => f.id)).toEqual(["F001"]);
  });

  test("a non-422 failure fails loud rather than silently degrading", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/42/reviews"],
        response: { stderr: "gh: server error (HTTP 500)", exitCode: 1 },
      },
    ]);
    const f001 = finding({ id: "F001" });
    await expect(
      postPrReview({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        headSha: HEAD,
        findings: [f001],
        allFindings: [f001].map(toRef),
        spawnFn,
      }),
    ).rejects.toThrow(/post PR review/);
  });
});

describe("postIssueComment", () => {
  test("posts a standalone comment per finding and returns its id", async () => {
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments"],
        response: { stdout: JSON.stringify({ id: 55 }), exitCode: 0 },
      },
    ]);
    const id = await postIssueComment(
      OPERATOR_ROOT,
      42,
      finding({ id: "F001", path: "src/a.ts", line: 10 }),
      HEAD,
      undefined,
      spawnFn,
    );
    expect(id).toBe(55);
    const call = calls.find((c) =>
      c.argv.join(" ").includes("issues/42/comments"),
    );
    expect(call?.argv).toContain("POST");
    expect(call?.argv).toContain("-F");
  });

  // WARN-1 from the PR2 verification: mutating this function to send
  // NOTHING on stdin left the suite green, so nothing proved the body —
  // including its identity marker, the thing spec R11's no-repost
  // guarantee rides on — ever reaches gh. Also closes the design's
  // Threat Matrix "PR commands" row's promised RED test: a body with
  // shell-special characters posts VERBATIM on stdin, never composed
  // into argv (no interpolation surface).
  test("the body reaching gh on stdin carries the finding's identity marker and its claim, verbatim, never via argv", async () => {
    let capturedStdin: Uint8Array | undefined;
    let capturedArgv: string[] = [];
    const spawnFn = ((argv: string[], opts?: { stdin?: Uint8Array }) => {
      capturedArgv = argv;
      capturedStdin = opts?.stdin;
      const encoder = new TextEncoder();
      const stream = (text: string) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
          },
        });
      return {
        stdout: stream(JSON.stringify({ id: 55 })),
        stderr: stream(""),
        exited: Promise.resolve(0),
        kill() {},
      };
    }) as unknown as typeof Bun.spawn;
    const tricky = finding({
      id: "F009",
      path: "src/a.ts",
      line: 10,
      claim: "shell danger: `backticks`, --flags, $(subshell), and | pipes",
    });
    const id = await postIssueComment(
      OPERATOR_ROOT,
      42,
      tricky,
      HEAD,
      undefined,
      spawnFn,
    );
    expect(id).toBe(55);
    expect(capturedStdin).toBeDefined();
    const body = new TextDecoder().decode(capturedStdin);
    // Byte-identical to the renderer's own output — the exact body a
    // second run's matcher will parse back.
    expect(body).toBe(renderIssueFindingComment(tricky, HEAD, undefined));
    expect(body.startsWith(PR_FINDING_MARKER_PREFIX)).toBe(true);
    expect(body).toContain(
      "shell danger: `backticks`, --flags, $(subshell), and | pipes",
    );
    // No shell interpolation surface: none of the tricky claim text ever
    // reaches argv — the body travels ONLY on stdin.
    const argvJoined = capturedArgv.join(" ");
    expect(argvJoined).not.toContain("backticks");
    expect(argvJoined).not.toContain("subshell");
  });

  test("a response with no comment id fails loud", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["issues/42/comments"],
        response: { stdout: "{}", exitCode: 0 },
      },
    ]);
    await expect(
      postIssueComment(
        OPERATOR_ROOT,
        42,
        finding({ id: "F001" }),
        HEAD,
        undefined,
        spawnFn,
      ),
    ).rejects.toThrow(/no comment id/);
  });

  test("a gh failure fails loud", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["issues/42/comments"],
        response: { stderr: "gh: boom", exitCode: 1 },
      },
    ]);
    await expect(
      postIssueComment(
        OPERATOR_ROOT,
        42,
        finding({ id: "F001" }),
        HEAD,
        undefined,
        spawnFn,
      ),
    ).rejects.toThrow(/post finding issue comment/);
  });
});
