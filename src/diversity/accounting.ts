import type { NormalizedUsage } from "../execution/usage-normalized";
import { sumNormalizedUsage } from "../execution/usage-normalized";
import type { FindingObservation } from "./clustering";

export type DiversityAttemptStatus =
  | "completed"
  | "failed"
  | "retry"
  | "duplicate"
  | "refuted";

export interface DiversityAttemptRecord {
  readonly attemptId: string;
  readonly legId: string;
  readonly armId: string;
  readonly specialty: string;
  readonly replicate: number;
  readonly attempt: number;
  readonly status: DiversityAttemptStatus;
  readonly usage: NormalizedUsage;
}

export interface DiversityObservationRecord {
  readonly observation: FindingObservation;
  readonly attemptId: string;
  readonly legId: string;
  readonly armId: string;
}

export interface DiversityLedger {
  readonly attempts: readonly DiversityAttemptRecord[];
  readonly observations: readonly DiversityObservationRecord[];
  readonly failures: readonly DiversityAttemptRecord[];
}

export interface DiversityAccountingTotals {
  readonly cashCostUsd: number;
  readonly notionalCostUsd: number;
  readonly attemptCount: number;
  readonly observationCount: number;
  readonly failureCount: number;
}

export function appendAttempt(
  ledger: DiversityLedger,
  attempt: DiversityAttemptRecord,
): DiversityLedger {
  const attempts = [...ledger.attempts, attempt];
  const failures =
    attempt.status === "failed"
      ? [...ledger.failures, attempt]
      : ledger.failures;
  return { ...ledger, attempts, failures };
}

export function appendObservation(
  ledger: DiversityLedger,
  record: DiversityObservationRecord,
): DiversityLedger {
  return {
    ...ledger,
    observations: [...ledger.observations, record],
  };
}

export function emptyDiversityLedger(): DiversityLedger {
  return { attempts: [], observations: [], failures: [] };
}

export function summarizeDiversityAccounting(
  ledger: DiversityLedger,
): DiversityAccountingTotals {
  const usage = ledger.attempts.map((attempt) => attempt.usage);
  const summed =
    usage.length === 0
      ? undefined
      : usage.reduce((acc, current) => sumNormalizedUsage(acc, current));
  return {
    cashCostUsd: summed?.cashCostUsd ?? 0,
    notionalCostUsd: summed?.notionalCostUsd ?? 0,
    attemptCount: ledger.attempts.length,
    observationCount: ledger.observations.length,
    failureCount: ledger.failures.length,
  };
}

export function retainPartialFailureEvidence(ledger: DiversityLedger): boolean {
  if (ledger.failures.length === 0) return true;
  return ledger.observations.length > 0 || ledger.failures.length > 0;
}
