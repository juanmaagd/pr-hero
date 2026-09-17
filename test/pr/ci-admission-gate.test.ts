// Offline behavior tests for pr/ci-admission-gate.ts's evaluateCiAdmissionGate
// — zero direct tests existed before this file (rg over test/ for the name
// returned nothing).
//
// Every gh()-backed call this gate makes (listAdmissionCheckRuns,
// fetchPrComments, fetchPrReviewComments, ghPrHeroWorkflowRunHeads,
// ghCompareChangedFilesWithStatus) already accepts an invisible-to-production
// `options.spawnFn` — the gate itself just never exposed it, so it gained one
// `spawnFn` field threaded to all five. `recordCiAdmissionGateSkip` has no
// spawnFn of its own (its ledger persist goes through admission.ts, out of
// scope for this slice), so the gate also gained a `recordSkip` seam.
// `publishCiSkip` is exercised FOR REAL (no seam): with `options.post` left
// unset it never touches gh, only the two env-path files GITHUB_STEP_SUMMARY
// and GITHUB_OUTPUT, so their content is asserted as the real observable
// instead of a fake's captured args.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderCiAdmissionBlock } from "#ci/review-admission";
import { evaluateCiAdmissionGate } from "#pr/ci-admission-gate";
import { CommentsTruncatedError } from "#pr/pr";
import { PR_COMMENT_MARKER_PREFIX } from "#pr/preflight";
import {
  type CliOptions,
  EMPTY_LOCAL_CONFIG,
  type LocalConfig,
} from "#review/preflight";

const PR = 42;
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

function baseOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    repo: "/repo",
    head: HEAD_B,
    full: false,
    hopBudget: 8,
    dryRun: false,
    yes: false,
    twoDot: false,
    onPush: false,
    force: false,
    all: false,
    fixes: false,
    incidents: false,
    issues: false,
    proximity: false,
    threads: false,
    ...overrides,
  };
}

function summaryComment(
  id: number,
  head: string,
  counts: { blocking: number; advisory: number },
  reviews: number,
): { id: number; user: string; body: string } {
  return {
    id,
    user: "pr-hero[bot]",
    body:
      `${PR_COMMENT_MARKER_PREFIX}head=${head} -->\n` +
      renderCiAdmissionBlock(head, counts, reviews),
  };
}

// argv-substring matching, same shape as test/ci/admission-integration.test.ts's
// makeFakeGh — duplicated per this repo's convention that a test file's own
// gh fixture is not a shared module.
type ScriptEntry = {
  match: string[];
  response: { stdout?: string; stderr?: string; exitCode?: number };
};

function makeFakeGh(script: ScriptEntry[]): typeof Bun.spawn {
  const encoder = new TextEncoder();
  return ((argv: string[]) => {
    const joined = argv.join(" ");
    const entry = script.find((s) =>
      s.match.every((token) => joined.includes(token)),
    );
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
}

const EMPTY_CHECK_RUNS: ScriptEntry = {
  match: ["check-runs"],
  response: { stdout: "" },
};
const EMPTY_REVIEW_COMMENTS: ScriptEntry = {
  match: ["pulls", "comments"],
  response: { stdout: "" },
};
const REPO_VIEW: ScriptEntry = {
  match: ["repo", "view", "owner,name"],
  response: {
    stdout: JSON.stringify({ owner: { login: "acme" }, name: "widgets" }),
  },
};
const compareResponse = (changedPath: string): ScriptEntry => ({
  match: ["compare"],
  response: {
    stdout: JSON.stringify({
      files: [{ filename: changedPath, status: "modified" }],
    }),
  },
});

async function tmpCiFiles(): Promise<{
  summaryPath: string;
  outputPath: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-gate-"));
  return {
    summaryPath: path.join(dir, "step-summary.md"),
    outputPath: path.join(dir, "outputs.txt"),
  };
}

describe("evaluateCiAdmissionGate — early no-op guards", () => {
  test("a dry run touches no gh call and resolves the default policy", async () => {
    const result = await evaluateCiAdmissionGate({
      operatorRoot: "/repo",
      prNumber: PR,
      headSha: HEAD_B,
      config: EMPTY_LOCAL_CONFIG,
      isCi: true,
      options: baseOptions({ dryRun: true }),
      // No spawnFn: any gh call here would throw "gh not found on PATH" in
      // an environment without gh installed, or make a real network call in
      // one that has it — either way, this proves the guard, not a mock.
    });
    expect(result).toEqual({
      ciPolicy: {
        schemaVersion: 1,
        mode: "risk_aware",
        maxAttempts: 2,
        rereviewMinScore: expect.any(Number),
        blockingWeight: expect.any(Number),
        advisoryWeight: expect.any(Number),
        reservationTtlSeconds: expect.any(Number),
      },
      ciPolicyHash: expect.any(String),
      ledgerRecords: [],
      exitCode: undefined,
    });
  });

  test("outside CI, the gate is a pure pass-through", async () => {
    const result = await evaluateCiAdmissionGate({
      operatorRoot: "/repo",
      prNumber: PR,
      headSha: HEAD_B,
      config: EMPTY_LOCAL_CONFIG,
      isCi: false,
      options: baseOptions({ dryRun: false, force: false }),
    });
    expect(result.ledgerRecords).toEqual([]);
    expect(result.exitCode).toBeUndefined();
  });

  test("--force still reads the ledger but skips the admission decision", async () => {
    // The comments fetch is scripted to return an already-reviewed-this-head
    // summary — a decision the admission block would turn into a "skip" if
    // --force did not bypass it entirely. A silent no-op here would not
    // distinguish "guard held" from "guard bypassed on harmless input", so
    // the script deliberately hands it a non-harmless one.
    const spawnFn = makeFakeGh([
      EMPTY_CHECK_RUNS,
      {
        match: ["issues", "comments"],
        response: {
          stdout: `${JSON.stringify(summaryComment(1, HEAD_B, { blocking: 0, advisory: 1 }, 1))}\n`,
        },
      },
      EMPTY_REVIEW_COMMENTS,
    ]);
    const recordCalls: unknown[] = [];
    const result = await evaluateCiAdmissionGate({
      operatorRoot: "/repo",
      prNumber: PR,
      headSha: HEAD_B,
      config: EMPTY_LOCAL_CONFIG,
      isCi: true,
      options: baseOptions({ dryRun: false, force: true }),
      spawnFn,
      recordSkip: async (recorded) => {
        recordCalls.push(recorded);
      },
    });
    expect(result.ledgerRecords).toEqual([]);
    expect(result.exitCode).toBeUndefined();
    expect(recordCalls).toEqual([]);
  });
});

describe("evaluateCiAdmissionGate — admission decisions", () => {
  test("a PR with no posted summary comment runs, recording nothing", async () => {
    const spawnFn = makeFakeGh([
      EMPTY_CHECK_RUNS,
      { match: ["issues", "comments"], response: { stdout: "" } },
      EMPTY_REVIEW_COMMENTS,
    ]);
    const recordCalls: unknown[] = [];
    const { summaryPath, outputPath } = await tmpCiFiles();
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    process.env.GITHUB_OUTPUT = outputPath;
    delete process.env.GITHUB_HEAD_REF;
    try {
      const result = await evaluateCiAdmissionGate({
        operatorRoot: "/repo",
        prNumber: PR,
        headSha: HEAD_B,
        config: EMPTY_LOCAL_CONFIG,
        isCi: true,
        options: baseOptions(),
        spawnFn,
        recordSkip: async (recorded) => {
          recordCalls.push(recorded);
        },
      });
      expect(result.exitCode).toBeUndefined();
      expect(recordCalls).toEqual([]);
      await expect(readFile(summaryPath, "utf8")).rejects.toThrow();
    } finally {
      delete process.env.GITHUB_STEP_SUMMARY;
      delete process.env.GITHUB_OUTPUT;
    }
  });

  test("re-running the same reviewed head skips, records it, and publishes the coverage-skip step summary", async () => {
    const spawnFn = makeFakeGh([
      EMPTY_CHECK_RUNS,
      {
        match: ["issues", "comments"],
        response: {
          stdout: `${JSON.stringify(summaryComment(1, HEAD_B, { blocking: 0, advisory: 1 }, 1))}\n`,
        },
      },
      EMPTY_REVIEW_COMMENTS,
    ]);
    const recordCalls: { reason: string; headSha: string }[] = [];
    const { summaryPath, outputPath } = await tmpCiFiles();
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    process.env.GITHUB_OUTPUT = outputPath;
    delete process.env.GITHUB_HEAD_REF;
    try {
      const result = await evaluateCiAdmissionGate({
        operatorRoot: "/repo",
        prNumber: PR,
        headSha: HEAD_B,
        config: EMPTY_LOCAL_CONFIG,
        isCi: true,
        options: baseOptions(),
        spawnFn,
        recordSkip: async (recorded) => {
          recordCalls.push({
            reason: recorded.reason,
            headSha: recorded.headSha,
          });
        },
      });
      expect(result.exitCode).toBe(0);
      expect(recordCalls).toEqual([
        { reason: "this commit was already reviewed", headSha: HEAD_B },
      ]);
      const summary = await readFile(summaryPath, "utf8");
      expect(summary).toContain("this commit was already reviewed");
      const outputs = await readFile(outputPath, "utf8");
      expect(outputs).toContain("status=skipped-coverage");
    } finally {
      delete process.env.GITHUB_STEP_SUMMARY;
      delete process.env.GITHUB_OUTPUT;
    }
  });

  test("an exhausted attempt budget on a new head requires manual override", async () => {
    const spawnFn = makeFakeGh([
      EMPTY_CHECK_RUNS,
      {
        match: ["issues", "comments"],
        response: {
          stdout: `${JSON.stringify(summaryComment(1, HEAD_A, { blocking: 0, advisory: 1 }, 2))}\n`,
        },
      },
      EMPTY_REVIEW_COMMENTS,
      REPO_VIEW,
      compareResponse("docs/readme.md"),
    ]);
    const recordCalls: { reason: string }[] = [];
    const { summaryPath, outputPath } = await tmpCiFiles();
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    process.env.GITHUB_OUTPUT = outputPath;
    delete process.env.GITHUB_HEAD_REF;
    try {
      const result = await evaluateCiAdmissionGate({
        operatorRoot: "/repo",
        prNumber: PR,
        headSha: HEAD_B,
        config: EMPTY_LOCAL_CONFIG,
        isCi: true,
        options: baseOptions(),
        spawnFn,
        recordSkip: async (recorded) => {
          recordCalls.push({ reason: recorded.reason });
        },
      });
      expect(result.exitCode).toBe(0);
      expect(recordCalls).toEqual([
        {
          reason:
            "automatic review budget exhausted (2/2 attempts on this PR). " +
            "Run `pr-hero review --pr <n> --post --force` locally to override.",
        },
      ]);
      const summary = await readFile(summaryPath, "utf8");
      expect(summary).toContain("automatic review budget exhausted");
      expect(summary).toContain("Remaining budget");
      const outputs = await readFile(outputPath, "utf8");
      expect(outputs).toContain("status=manual-required");
    } finally {
      delete process.env.GITHUB_STEP_SUMMARY;
      delete process.env.GITHUB_OUTPUT;
    }
  });

  test("observe-only mode logs a would-skip decision but never records or publishes it", async () => {
    const spawnFn = makeFakeGh([
      EMPTY_CHECK_RUNS,
      {
        match: ["issues", "comments"],
        response: {
          stdout: `${JSON.stringify(summaryComment(1, HEAD_B, { blocking: 0, advisory: 1 }, 1))}\n`,
        },
      },
      EMPTY_REVIEW_COMMENTS,
    ]);
    const recordCalls: unknown[] = [];
    const { summaryPath, outputPath } = await tmpCiFiles();
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    process.env.GITHUB_OUTPUT = outputPath;
    delete process.env.GITHUB_HEAD_REF;
    const observeOnlyConfig: LocalConfig = {
      ...EMPTY_LOCAL_CONFIG,
      ci_admission_observe_only: true,
    };
    try {
      const result = await evaluateCiAdmissionGate({
        operatorRoot: "/repo",
        prNumber: PR,
        headSha: HEAD_B,
        config: observeOnlyConfig,
        isCi: true,
        options: baseOptions(),
        spawnFn,
        recordSkip: async (recorded) => {
          recordCalls.push(recorded);
        },
      });
      expect(result.exitCode).toBeUndefined();
      expect(recordCalls).toEqual([]);
      await expect(readFile(summaryPath, "utf8")).rejects.toThrow();
    } finally {
      delete process.env.GITHUB_STEP_SUMMARY;
      delete process.env.GITHUB_OUTPUT;
    }
  });

  test("a truncated comment fetch fails open to run, recording nothing", async () => {
    const spawnFn = (() => {
      throw new CommentsTruncatedError("comments truncated");
    }) as unknown as typeof Bun.spawn;
    // Only the comments fetch needs to throw; give evaluateCiAdmissionGate a
    // fake that always throws to prove the catch block, not a scripted
    // response, is what keeps this offline.
    const recordCalls: unknown[] = [];
    delete process.env.GITHUB_HEAD_REF;
    const result = await evaluateCiAdmissionGate({
      operatorRoot: "/repo",
      prNumber: PR,
      headSha: HEAD_B,
      config: EMPTY_LOCAL_CONFIG,
      isCi: true,
      options: baseOptions(),
      spawnFn,
      recordSkip: async (recorded) => {
        recordCalls.push(recorded);
      },
    });
    expect(result.exitCode).toBeUndefined();
    expect(recordCalls).toEqual([]);
  });
});
