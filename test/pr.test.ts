// Offline tests for pr.ts's WU4/WU5 additions (ROADMAP B6): the review-level
// fetcher, the atomic review submission with its 422 recovery, and the
// per-finding issue comment. Same fake-spawn pattern as
// test/step-runner.test.ts's makeFakeSpawn: no real gh/PR anywhere here.

import { describe, expect, test } from "bun:test";
import type { Finding } from "../src/findings";
import {
  fetchPostedFindingComments,
  fetchPrReviewComments,
  postIssueComment,
  postPrReview,
} from "../src/pr";

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

describe("postPrReview", () => {
  test("zero anchorable findings never reaches gh at all", async () => {
    const { spawnFn, calls } = makeFakeGh([]);
    const outcome = await postPrReview({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      findings: [],
      consumedCommentIds: [],
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
      consumedCommentIds: [],
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
      consumedCommentIds: [],
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
      consumedCommentIds: [],
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
      consumedCommentIds: [],
      spawnFn,
    });
    expect(outcome.outcome).toBe("demoted");
    // F001 already has a home (the leftover comment); only F002 is fresh.
    expect(outcome.findings.map((f) => f.id)).toEqual(["F002"]);
  });

  // A comment the PLAN already claimed for a persisting finding must not be
  // available to the recovery's re-match: matchPostedFindings is one-to-one
  // only across the list it is handed, and the recovery is handed a SUBSET,
  // so a claimed comment would swallow a genuinely new finding and drop it
  // from both channels. Fails without `consumedCommentIds`.
  test("a claimed comment cannot swallow a fresh finding on 422", async () => {
    const claimed =
      "<!-- pr-hero-finding path=src%2Fa.ts line=100 head=" +
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
              body: claimed,
              path: "src/a.ts",
              line: 100,
              original_line: 100,
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
      // Comment 7 belongs to a persisting finding the plan handled; F002 sits
      // 3 lines away, inside FINDING_LINE_WINDOW.
      findings: [finding({ id: "F002", path: "src/a.ts", line: 103 })],
      consumedCommentIds: [7],
      spawnFn,
    });
    expect(outcome.outcome).toBe("demoted");
    expect(outcome.findings.map((f) => f.id)).toEqual(["F002"]);
  });

  test("a non-422 failure fails loud rather than silently degrading", async () => {
    const { spawnFn } = makeFakeGh([
      {
        match: ["pulls/42/reviews"],
        response: { stderr: "gh: server error (HTTP 500)", exitCode: 1 },
      },
    ]);
    await expect(
      postPrReview({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        headSha: HEAD,
        findings: [finding({ id: "F001" })],
        consumedCommentIds: [],
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
