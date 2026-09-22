// settleCiAdmissionLedger: the one guard that keeps a later exit (or
// teardown's finally) from overwriting a run that already reached a terminal
// status. The only gh boundary is the check-run upsert, doubled through
// `spawnFn`; the ledger record and the check run sent to GitHub are the
// observables.

import { describe, expect, test } from "bun:test";
import {
  type AdmissionAttemptStatus,
  type AdmissionRecord,
  admissionRecordFingerprint,
} from "#ci/admission-ledger";
import {
  type CiAdmissionLedgerState,
  holdCiAdmissionLedger,
  releaseCiAdmissionLedger,
  settleCiAdmissionLedger,
  settleHeldAdmissionLedgerOnSignal,
} from "#pr/admission";

const HEAD = "b".repeat(40);
const PR = 7;
const POLICY_HASH = "0123456789abcdef";
const ORIGINAL_REASON = "reason recorded before settlement";
const SETTLE_REASON = "review path exited without terminal settlement";

function ledgerState(status: AdmissionAttemptStatus): CiAdmissionLedgerState {
  const record: AdmissionRecord = {
    schemaVersion: 1,
    prNumber: PR,
    headSha: HEAD,
    policyHash: POLICY_HASH,
    reservationId: admissionRecordFingerprint(PR, HEAD, POLICY_HASH),
    attemptNumber: 1,
    status,
    decisionReason: ORIGINAL_REASON,
    priorScore: null,
    blockingCount: null,
    advisoryCount: null,
    workflowRunId: null,
    createdAt: "2026-09-17T12:00:00.000Z",
    settledAt: null,
  };
  return { record, checkRunId: 11, headSha: HEAD, operatorRoot: "/repo" };
}

// A gh double: records every argv and answers with the given exit code and
// stdout, like `gh api` does.
function ghSpawn(response: { exitCode: number; stdout: string }): {
  spawnFn: typeof Bun.spawn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const encoder = new TextEncoder();
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (text) controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  const spawnFn = ((argv: string[]) => {
    calls.push(argv);
    return {
      stdout: stream(response.stdout),
      stderr: stream(response.exitCode === 0 ? "" : "gh: boom"),
      exited: Promise.resolve(response.exitCode),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

describe("settleCiAdmissionLedger — a terminal record is never re-settled", () => {
  test.each(["completed", "failed", "cancelled", "skipped"] as const)(
    "a %s record keeps its status and reason and nothing is sent to GitHub",
    async (terminal) => {
      const state = ledgerState(terminal);
      const { spawnFn, calls } = ghSpawn({ exitCode: 0, stdout: '{"id":99}' });

      await settleCiAdmissionLedger(state, "failed", SETTLE_REASON, {
        spawnFn,
      });

      expect(state.record.status).toBe(terminal);
      expect(state.record.decisionReason).toBe(ORIGINAL_REASON);
      expect(calls).toEqual([]);
    },
  );
});

describe("settleCiAdmissionLedger — a pending record is settled and published", () => {
  test.each(["reserved", "provider-started", "unknown"] as const)(
    "a %s record takes the new status and reason, and the check run carries it",
    async (pending) => {
      const state = ledgerState(pending);
      const { spawnFn, calls } = ghSpawn({ exitCode: 0, stdout: '{"id":99}' });

      await settleCiAdmissionLedger(state, "failed", SETTLE_REASON, {
        spawnFn,
      });

      expect(state.record.status).toBe("failed");
      expect(state.record.decisionReason).toBe(SETTLE_REASON);
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain("output[summary]=failed (attempt 1)");
      expect(state.checkRunId).toBe(99);
    },
  );

  test("a gh failure still leaves the record settled and does not throw", async () => {
    const state = ledgerState("reserved");
    const { spawnFn } = ghSpawn({ exitCode: 1, stdout: "" });

    await settleCiAdmissionLedger(state, "failed", SETTLE_REASON, { spawnFn });

    expect(state.record.status).toBe("failed");
    expect(state.record.decisionReason).toBe(SETTLE_REASON);
    expect(state.checkRunId).toBe(11);
  });

  test("no reservation means nothing to settle and nothing sent", async () => {
    const { spawnFn, calls } = ghSpawn({ exitCode: 0, stdout: '{"id":99}' });

    await settleCiAdmissionLedger(null, "failed", SETTLE_REASON, { spawnFn });

    expect(calls).toEqual([]);
  });
});

describe("settleHeldAdmissionLedgerOnSignal", () => {
  test("a provider-started row becomes cancelled and is published", async () => {
    const state = ledgerState("provider-started");
    holdCiAdmissionLedger(state);
    const { spawnFn, calls } = ghSpawn({ exitCode: 0, stdout: '{"id":42}' });

    await settleHeldAdmissionLedgerOnSignal((held, status, reason, options) =>
      settleCiAdmissionLedger(held, status, reason, {
        ...options,
        spawnFn,
      }),
    );

    expect(state.record.status).toBe("cancelled");
    expect(state.record.decisionReason).toBe(
      "workflow cancelled before the review produced anything",
    );
    expect(calls.length).toBe(1);
  });

  test("a second signal finds nothing left to settle", async () => {
    const state = ledgerState("provider-started");
    holdCiAdmissionLedger(state);
    const settle = async () => {
      state.record = { ...state.record, status: "cancelled" };
    };
    await Promise.all([
      settleHeldAdmissionLedgerOnSignal(settle),
      settleHeldAdmissionLedgerOnSignal(settle),
    ]);
    expect(state.record.status).toBe("cancelled");
  });

  test("a completed row is not rewritten", async () => {
    const state = ledgerState("completed");
    holdCiAdmissionLedger(state);
    let calls = 0;
    await settleHeldAdmissionLedgerOnSignal(async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    expect(state.record.status).toBe("completed");
    releaseCiAdmissionLedger();
  });
});
