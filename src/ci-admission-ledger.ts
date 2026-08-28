// Durable CI admission attempt ledger (WU-02): pure reserve/settle/idempotency.
// Persistence is GitHub Check Runs (pr.ts); PR comments stay presentation-only.

import { createHash } from "node:crypto";

export const ADMISSION_LEDGER_SCHEMA_VERSION = 1;
export const ADMISSION_CHECK_RUN_NAME = "pr-hero/ci-admission";

export type AdmissionAttemptStatus =
  | "reserved"
  | "provider-started"
  | "completed"
  | "skipped"
  | "failed"
  | "cancelled"
  | "unknown";

export interface AdmissionRecord {
  schemaVersion: 1;
  prNumber: number;
  headSha: string;
  policyHash: string;
  reservationId: string;
  attemptNumber: number;
  status: AdmissionAttemptStatus;
  decisionReason: string;
  priorScore: number | null;
  blockingCount: number | null;
  advisoryCount: number | null;
  workflowRunId: string | null;
  createdAt: string;
  settledAt: string | null;
}

const TERMINAL_BUDGET_STATUSES: ReadonlySet<AdmissionAttemptStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "provider-started",
  "skipped",
]);

const ACTIVE_RESERVATION_STATUSES: ReadonlySet<AdmissionAttemptStatus> =
  new Set(["reserved", "provider-started"]);

export function admissionRecordFingerprint(
  prNumber: number,
  headSha: string,
  policyHash: string,
): string {
  const canonical = `${prNumber}:${headSha}:${policyHash}`;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function parseAdmissionRecord(text: string): AdmissionRecord | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<AdmissionRecord>;
    if (
      parsed.schemaVersion !== ADMISSION_LEDGER_SCHEMA_VERSION ||
      typeof parsed.prNumber !== "number" ||
      typeof parsed.headSha !== "string" ||
      typeof parsed.policyHash !== "string" ||
      typeof parsed.reservationId !== "string" ||
      typeof parsed.attemptNumber !== "number" ||
      typeof parsed.status !== "string" ||
      typeof parsed.decisionReason !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      prNumber: parsed.prNumber,
      headSha: parsed.headSha,
      policyHash: parsed.policyHash,
      reservationId: parsed.reservationId,
      attemptNumber: parsed.attemptNumber,
      status: parsed.status as AdmissionAttemptStatus,
      decisionReason: parsed.decisionReason,
      priorScore:
        parsed.priorScore === null || typeof parsed.priorScore === "number"
          ? (parsed.priorScore ?? null)
          : null,
      blockingCount:
        parsed.blockingCount === null ||
        typeof parsed.blockingCount === "number"
          ? (parsed.blockingCount ?? null)
          : null,
      advisoryCount:
        parsed.advisoryCount === null ||
        typeof parsed.advisoryCount === "number"
          ? (parsed.advisoryCount ?? null)
          : null,
      workflowRunId:
        parsed.workflowRunId === null ||
        typeof parsed.workflowRunId === "string"
          ? (parsed.workflowRunId ?? null)
          : null,
      createdAt: parsed.createdAt,
      settledAt:
        parsed.settledAt === null || typeof parsed.settledAt === "string"
          ? (parsed.settledAt ?? null)
          : null,
    };
  } catch {
    return null;
  }
}

export function serializeAdmissionRecord(record: AdmissionRecord): string {
  return JSON.stringify(record);
}

export function countTerminalAttempts(
  records: readonly AdmissionRecord[],
): number {
  return records.filter((record) => TERMINAL_BUDGET_STATUSES.has(record.status))
    .length;
}

function recordsForFingerprint(
  records: readonly AdmissionRecord[],
  prNumber: number,
  headSha: string,
  policyHash: string,
): AdmissionRecord[] {
  const reservationId = admissionRecordFingerprint(
    prNumber,
    headSha,
    policyHash,
  );
  return records.filter(
    (record) =>
      record.prNumber === prNumber &&
      record.headSha === headSha &&
      record.policyHash === policyHash &&
      record.reservationId === reservationId,
  );
}

function nextAttemptNumber(records: readonly AdmissionRecord[]): number {
  let max = 0;
  for (const record of records) {
    if (record.attemptNumber > max) max = record.attemptNumber;
  }
  return max + 1;
}

export function isReservationStale(
  record: AdmissionRecord,
  ttlSeconds: number,
  now: Date = new Date(),
): boolean {
  if (record.status !== "reserved") return false;
  const createdMs = Date.parse(record.createdAt);
  if (Number.isNaN(createdMs)) return true;
  const ageSeconds = (now.getTime() - createdMs) / 1000;
  return ageSeconds > ttlSeconds;
}

export function selectActiveReservation(
  records: readonly AdmissionRecord[],
  headSha: string,
  policyHash: string,
  ttlSeconds: number,
  now?: Date,
): AdmissionRecord | null {
  const matches = records
    .filter(
      (record) =>
        record.headSha === headSha &&
        record.policyHash === policyHash &&
        ACTIVE_RESERVATION_STATUSES.has(record.status),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const record of matches) {
    if (
      record.status === "reserved" &&
      isReservationStale(record, ttlSeconds, now)
    ) {
      continue;
    }
    return record;
  }
  return null;
}

export function reserveAdmissionAttempt(input: {
  existing: readonly AdmissionRecord[];
  prNumber: number;
  headSha: string;
  policyHash: string;
  workflowRunId?: string | null;
  now?: Date;
  decisionReason?: string;
  priorScore?: number | null;
  blockingCount?: number | null;
  advisoryCount?: number | null;
  reservationTtlSeconds: number;
}): { record: AdmissionRecord; created: boolean } {
  const now = input.now ?? new Date();
  const active = selectActiveReservation(
    input.existing,
    input.headSha,
    input.policyHash,
    input.reservationTtlSeconds,
    now,
  );
  if (active !== null) {
    return { record: active, created: false };
  }

  const scoped = recordsForFingerprint(
    input.existing,
    input.prNumber,
    input.headSha,
    input.policyHash,
  );
  const reservationId = admissionRecordFingerprint(
    input.prNumber,
    input.headSha,
    input.policyHash,
  );
  const record: AdmissionRecord = {
    schemaVersion: 1,
    prNumber: input.prNumber,
    headSha: input.headSha,
    policyHash: input.policyHash,
    reservationId,
    attemptNumber: nextAttemptNumber(scoped),
    status: "reserved",
    decisionReason: input.decisionReason ?? "",
    priorScore: input.priorScore ?? null,
    blockingCount: input.blockingCount ?? null,
    advisoryCount: input.advisoryCount ?? null,
    workflowRunId: input.workflowRunId ?? null,
    createdAt: now.toISOString(),
    settledAt: null,
  };
  return { record, created: true };
}

export function settleAdmissionAttempt(
  record: AdmissionRecord,
  status: AdmissionAttemptStatus,
  decisionReason: string,
  settledAt?: Date,
): AdmissionRecord {
  const at = settledAt ?? new Date();
  return {
    ...record,
    status,
    decisionReason,
    settledAt: at.toISOString(),
  };
}
