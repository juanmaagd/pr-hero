// CI admission ledger state and skip publishing helpers.
// Extracted from cli.ts (cli-decomp S5).

import {
  type AdmissionAttemptStatus,
  type AdmissionRecord,
  reserveAdmissionAttempt,
  settleAdmissionAttempt,
} from "#ci/admission-ledger";
import {
  type CiGateSkipPlan,
  shouldWriteCiOutputs,
  shouldWriteStepSummary,
} from "#ci/gates";
import {
  appendCiOutputs,
  appendStepSummary,
  formatWorkflowCommand,
} from "#ci/reporter";
import type { CiReviewPolicy } from "#ci/review-admission";
import { postPrComment, upsertAdmissionCheckRun } from "#pr/pr";
import { log } from "#ui/primitives";

// ROADMAP Pillar 3 (GitHub Actions CI). The mechanical glue behind a gate
// skip in CI mode: every DECISION (what to say, which marker, what the
// outputs are) already happened in `plan` (planCiSizeSkip/planCiBudgetSkip,
// ci/gates.ts) — this function has nothing left to decide, only three
// straight-line I/O calls gated by shouldWriteStepSummary/shouldWriteCiOutputs.
// `postPrComment`'s own `markerPrefix` (Phase 3's parameterization) makes
// this idempotent: a repeat CI run on the same still-failing PR updates its
// own prior skip comment rather than stacking a new one on every push.
export type CiAdmissionLedgerState = {
  record: AdmissionRecord;
  checkRunId: number;
  headSha: string;
  operatorRoot: string;
};

export async function persistCiAdmissionLedger(
  state: CiAdmissionLedgerState,
): Promise<void> {
  state.checkRunId = await upsertAdmissionCheckRun(state.operatorRoot, {
    headSha: state.headSha,
    record: state.record,
    checkRunId: state.checkRunId,
  });
}

export async function tryPersistCiAdmissionLedger(
  state: CiAdmissionLedgerState | null,
): Promise<void> {
  if (state === null) return;
  try {
    await persistCiAdmissionLedger(state);
  } catch {
    // Best-effort: settlement must not mask the underlying review failure.
  }
}

export async function settleCiAdmissionLedger(
  state: CiAdmissionLedgerState | null,
  status: AdmissionAttemptStatus,
  reason: string,
): Promise<void> {
  if (state === null) return;
  const terminal = new Set<AdmissionAttemptStatus>([
    "completed",
    "failed",
    "cancelled",
    "skipped",
  ]);
  if (
    terminal.has(state.record.status) &&
    state.record.status !== "provider-started"
  ) {
    return;
  }
  state.record = settleAdmissionAttempt(state.record, status, reason);
  await tryPersistCiAdmissionLedger(state);
}

export async function reserveCiAdmissionLedger(input: {
  operatorRoot: string;
  prNumber: number;
  headSha: string;
  policy: CiReviewPolicy;
  policyHash: string;
  existing: readonly AdmissionRecord[];
  decisionReason: string;
  priorScore?: number | null;
  blockingCount?: number | null;
  advisoryCount?: number | null;
}): Promise<CiAdmissionLedgerState> {
  const { record } = reserveAdmissionAttempt({
    existing: input.existing,
    prNumber: input.prNumber,
    headSha: input.headSha,
    policyHash: input.policyHash,
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    decisionReason: input.decisionReason,
    priorScore: input.priorScore ?? null,
    blockingCount: input.blockingCount ?? null,
    advisoryCount: input.advisoryCount ?? null,
    reservationTtlSeconds: input.policy.reservationTtlSeconds,
  });
  const checkRunId = await upsertAdmissionCheckRun(input.operatorRoot, {
    headSha: input.headSha,
    record,
  });
  return {
    record,
    checkRunId,
    headSha: input.headSha,
    operatorRoot: input.operatorRoot,
  };
}

export async function recordCiAdmissionGateSkip(input: {
  operatorRoot: string;
  prNumber: number;
  headSha: string;
  policy: CiReviewPolicy;
  policyHash: string;
  existing: readonly AdmissionRecord[];
  reason: string;
  priorScore: number | null;
  blockingCount: number | null;
  advisoryCount: number | null;
}): Promise<void> {
  try {
    const state = await reserveCiAdmissionLedger({
      operatorRoot: input.operatorRoot,
      prNumber: input.prNumber,
      headSha: input.headSha,
      policy: input.policy,
      policyHash: input.policyHash,
      existing: input.existing,
      decisionReason: input.reason,
      priorScore: input.priorScore,
      blockingCount: input.blockingCount,
      advisoryCount: input.advisoryCount,
    });
    await settleCiAdmissionLedger(state, "skipped", input.reason);
  } catch {
    // The skip notice is the operator-facing outcome; a check-run write must
    // not block publishing it.
  }
}

export async function publishCiSkip(input: {
  operatorRoot: string;
  prNumber: number;
  post: boolean;
  isCi: boolean;
  stepSummaryFlag: boolean | undefined;
  plan: CiGateSkipPlan;
  noticeMessage: string;
}): Promise<number> {
  log(formatWorkflowCommand("notice", input.noticeMessage));
  if (input.post) {
    await postPrComment(
      input.operatorRoot,
      input.prNumber,
      input.plan.comment,
      undefined,
      undefined,
      input.plan.markerPrefix,
    );
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (shouldWriteStepSummary(input.isCi, input.stepSummaryFlag, summaryPath)) {
    await appendStepSummary(summaryPath as string, input.plan.summaryMarkdown);
  }
  const outputPath = process.env.GITHUB_OUTPUT;
  if (shouldWriteCiOutputs(input.isCi, outputPath)) {
    await appendCiOutputs(outputPath as string, input.plan.outputs);
  }
  return 0;
}
