// Offline behavior tests for pr/teardown.ts (settleCommitStatusAndLedger,
// finalizePrReviewRun): the two `finally` blocks wrapping reviewPr()'s run.
// Zero direct tests existed before this file (rg over test/ for both
// exported names returned nothing).
//
// Neither tryPublishCommitStatus (#pr/status) nor settleCiAdmissionLedger
// (#pr/admission) nor runGc (#store/gc) exposes a spawnFn seam of its own,
// and both status.ts/admission.ts/gc.ts are out of scope for this slice —
// so teardown.ts gained three optional, production-defaulted parameters
// (`publish`, `settle`, `gc`) purely to let these tests replace the real
// gh-calling collaborators. `releasePidLock` stays real: it is a plain
// `fs.rm` against a caller-supplied path, so a real temp lock file already
// gives an observable effect.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AdmissionAttemptStatus,
  type AdmissionRecord,
  admissionRecordFingerprint,
} from "#ci/admission-ledger";
import type { CiAdmissionLedgerState } from "#pr/admission";
import type { InlinePostOutcome } from "#pr/inline";
import { COMMIT_STATUS_CONTEXT } from "#pr/preflight";
import {
  heldCommitStatusLock,
  holdCommitStatusLock,
  releaseCommitStatusLock,
} from "#pr/status";
import { finalizePrReviewRun, settleCommitStatusAndLedger } from "#pr/teardown";
import type { PipelineResult } from "#review/pipeline";

const HEAD = "a".repeat(40);
const POLICY_HASH = "abc123def4567890";
const PR = 42;
const SETTLED_REASON = "review path exited without terminal settlement";

function baseRecord(overrides: Partial<AdmissionRecord> = {}): AdmissionRecord {
  return {
    schemaVersion: 1,
    prNumber: PR,
    headSha: HEAD,
    policyHash: POLICY_HASH,
    reservationId: admissionRecordFingerprint(PR, HEAD, POLICY_HASH),
    attemptNumber: 1,
    status: "reserved",
    decisionReason: "",
    priorScore: null,
    blockingCount: null,
    advisoryCount: null,
    workflowRunId: null,
    createdAt: "2026-08-28T12:00:00.000Z",
    settledAt: null,
    ...overrides,
  };
}

function ledgerState(status: AdmissionAttemptStatus): CiAdmissionLedgerState {
  return {
    record: baseRecord({ status }),
    checkRunId: 7,
    headSha: HEAD,
    operatorRoot: "/repo",
  };
}

// Only `sessionFailed` is read by the code under test (commitStatusCompletion
// via settleCommitStatusAndLedger); the rest of PipelineResult's shape is
// pipeline internals this slice has no business constructing.
function pipelineResult(sessionFailed: boolean): PipelineResult {
  return { sessionFailed } as unknown as PipelineResult;
}

// Only "is this null or not" is read by the code under test; the rest of
// InlinePostOutcome's shape is posting-stage internals.
function postedOutcome(): InlinePostOutcome {
  return { reviewOutcome: "posted" } as unknown as InlinePostOutcome;
}

async function tmpLockPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-teardown-"));
  const lockPath = path.join(dir, "pid.lock");
  await writeFile(lockPath, "1234\n");
  return lockPath;
}

describe("settleCommitStatusAndLedger — commit status matrix", () => {
  test.each([
    [
      "no result yet, nothing posted",
      undefined,
      null,
      { state: "error", description: "review did not finish" },
    ],
    [
      "no result yet, a stray posted outcome",
      undefined,
      postedOutcome(),
      { state: "error", description: "review did not finish" },
    ],
    [
      "finished clean, nothing posted",
      pipelineResult(false),
      null,
      { state: "success", description: "review complete" },
    ],
    [
      "finished clean, posted",
      pipelineResult(false),
      postedOutcome(),
      { state: "success", description: "review posted" },
    ],
    [
      "finished but session failed, nothing posted",
      pipelineResult(true),
      null,
      { state: "error", description: "review did not finish" },
    ],
    [
      "finished but session failed, still posted",
      pipelineResult(true),
      postedOutcome(),
      { state: "error", description: "review did not finish" },
    ],
  ] as const)("%s", async (_name, result, posted, expected) => {
    const requests: unknown[] = [];
    await settleCommitStatusAndLedger({
      result,
      posted,
      operatorRoot: "/repo",
      headSha: HEAD,
      statusTargetUrl: "https://runs.example/1",
      ciAdmissionLedger: null,
      publish: async (_root, _sha, request) => {
        requests.push(request);
      },
    });
    expect(requests).toEqual([
      {
        state: expected.state,
        context: COMMIT_STATUS_CONTEXT,
        description: expected.description,
        targetUrl: "https://runs.example/1",
      },
    ]);
  });
});

describe("settleCommitStatusAndLedger — commit status lock lifecycle", () => {
  test("holds the lock through the publish attempt and releases it after", async () => {
    holdCommitStatusLock({
      operatorRoot: "/repo",
      sha: HEAD,
      targetUrl: undefined,
    });
    let lockDuringPublish: unknown = "not called";
    await settleCommitStatusAndLedger({
      result: pipelineResult(false),
      posted: null,
      operatorRoot: "/repo",
      headSha: HEAD,
      statusTargetUrl: undefined,
      ciAdmissionLedger: null,
      publish: async () => {
        lockDuringPublish = heldCommitStatusLock();
      },
    });
    expect(lockDuringPublish).not.toBeNull();
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("keeps the lock held and skips ledger settlement when the status publish throws", async () => {
    holdCommitStatusLock({
      operatorRoot: "/repo",
      sha: HEAD,
      targetUrl: undefined,
    });
    const settleCalls: unknown[] = [];
    await expect(
      settleCommitStatusAndLedger({
        result: pipelineResult(false),
        posted: null,
        operatorRoot: "/repo",
        headSha: HEAD,
        statusTargetUrl: undefined,
        ciAdmissionLedger: ledgerState("reserved"),
        publish: async () => {
          throw new Error("boom");
        },
        settle: async () => {
          settleCalls.push(1);
        },
      }),
    ).rejects.toThrow("boom");
    expect(heldCommitStatusLock()).not.toBeNull();
    expect(settleCalls).toEqual([]);
    releaseCommitStatusLock();
  });
});

const LEDGER_GUARD_CASES: readonly [
  AdmissionAttemptStatus,
  [AdmissionAttemptStatus, string][],
][] = [
  ["reserved", [["failed", SETTLED_REASON]]],
  ["provider-started", [["failed", SETTLED_REASON]]],
  ["completed", []],
  ["skipped", []],
  ["failed", []],
  ["cancelled", []],
  ["unknown", []],
];

describe("settleCommitStatusAndLedger — ledger settlement guard", () => {
  test.each(LEDGER_GUARD_CASES)("status=%s", async (status, expectedCalls) => {
    const calls: [AdmissionAttemptStatus, string][] = [];
    await settleCommitStatusAndLedger({
      result: pipelineResult(false),
      posted: null,
      operatorRoot: "/repo",
      headSha: HEAD,
      statusTargetUrl: undefined,
      ciAdmissionLedger: ledgerState(status),
      publish: async () => {},
      settle: async (_state, s, reason) => {
        calls.push([s, reason]);
      },
    });
    expect(calls).toEqual(expectedCalls);
  });

  test("settles nothing when there is no ledger reservation to begin with", async () => {
    const calls: unknown[] = [];
    await settleCommitStatusAndLedger({
      result: pipelineResult(false),
      posted: null,
      operatorRoot: "/repo",
      headSha: HEAD,
      statusTargetUrl: undefined,
      ciAdmissionLedger: null,
      publish: async () => {},
      settle: async () => {
        calls.push(1);
      },
    });
    expect(calls).toEqual([]);
  });
});

describe("finalizePrReviewRun — cleanup ordering", () => {
  test("settles the ledger and releases the pid lock before gc ever looks at it", async () => {
    const lockPath = await tmpLockPath();
    const observed = { settleSawLock: false, gcSawLock: true };
    await finalizePrReviewRun({
      ciAdmissionLedger: ledgerState("reserved"),
      lockPath,
      home: "/home/pr-hero",
      repoId: "owner/repo",
      settle: async () => {
        observed.settleSawLock = existsSync(lockPath);
      },
      gc: async () => {
        observed.gcSawLock = existsSync(lockPath);
        return { collected: 0, kept: 0, failed: 0 };
      },
    });
    expect(observed).toEqual({ settleSawLock: true, gcSawLock: false });
    expect(existsSync(lockPath)).toBe(false);
  });

  test("removes the pid lock before gc runs even when gc itself throws", async () => {
    const lockPath = await tmpLockPath();
    await expect(
      finalizePrReviewRun({
        ciAdmissionLedger: null,
        lockPath,
        home: "/home/pr-hero",
        repoId: "owner/repo",
        gc: async () => {
          throw new Error("gc boom");
        },
      }),
    ).rejects.toThrow("gc boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("passes gc the exact repo scope, always non-dry and always silent", async () => {
    const lockPath = await tmpLockPath();
    const gcCalls: unknown[] = [];
    await finalizePrReviewRun({
      ciAdmissionLedger: null,
      lockPath,
      home: "/home/pr-hero",
      repoId: "owner/repo",
      gc: async (input) => {
        gcCalls.push(input);
        return { collected: 0, kept: 0, failed: 0 };
      },
    });
    expect(gcCalls).toEqual([
      {
        home: "/home/pr-hero",
        repoId: "owner/repo",
        dryRun: false,
        silent: true,
      },
    ]);
  });

  test.each(
    LEDGER_GUARD_CASES.filter(([status]) =>
      ["reserved", "completed"].includes(status),
    ),
  )("ledger settlement guard: status=%s", async (status, expectedCalls) => {
    const lockPath = await tmpLockPath();
    const calls: [AdmissionAttemptStatus, string][] = [];
    await finalizePrReviewRun({
      ciAdmissionLedger: ledgerState(status),
      lockPath,
      home: "/home/pr-hero",
      repoId: "owner/repo",
      settle: async (_state, s, reason) => {
        calls.push([s, reason]);
      },
      gc: async () => ({ collected: 0, kept: 0, failed: 0 }),
    });
    expect(calls).toEqual(expectedCalls);
  });
});
