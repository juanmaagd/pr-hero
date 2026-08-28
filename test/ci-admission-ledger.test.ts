import { describe, expect, test } from "bun:test";
import {
  type AdmissionRecord,
  admissionRecordFingerprint,
  countTerminalAttempts,
  isReservationStale,
  parseAdmissionRecord,
  reserveAdmissionAttempt,
  selectActiveReservation,
  serializeAdmissionRecord,
  settleAdmissionAttempt,
} from "../src/ci-admission-ledger";

const HEAD = "a".repeat(40);
const POLICY_HASH = "abc123def4567890";
const PR = 42;

function baseRecord(overrides: Partial<AdmissionRecord> = {}): AdmissionRecord {
  const reservationId = admissionRecordFingerprint(PR, HEAD, POLICY_HASH);
  return {
    schemaVersion: 1,
    prNumber: PR,
    headSha: HEAD,
    policyHash: POLICY_HASH,
    reservationId,
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

describe("admissionRecordFingerprint", () => {
  test("is stable for the same pr/head/policy tuple", () => {
    const a = admissionRecordFingerprint(PR, HEAD, POLICY_HASH);
    const b = admissionRecordFingerprint(PR, HEAD, POLICY_HASH);
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  test("changes when policy hash changes", () => {
    expect(admissionRecordFingerprint(PR, HEAD, POLICY_HASH)).not.toBe(
      admissionRecordFingerprint(PR, HEAD, "other-policy-hash"),
    );
  });
});

describe("parseAdmissionRecord / serializeAdmissionRecord", () => {
  test("round-trips compact JSON", () => {
    const record = baseRecord({
      status: "completed",
      decisionReason: "review complete",
      priorScore: 4,
      blockingCount: 1,
      advisoryCount: 2,
      settledAt: "2026-08-28T12:05:00.000Z",
    });
    const text = serializeAdmissionRecord(record);
    expect(text).not.toContain("\n");
    expect(parseAdmissionRecord(text)).toEqual(record);
  });

  test("rejects malformed payloads", () => {
    expect(parseAdmissionRecord("not json")).toBeNull();
    expect(parseAdmissionRecord("{}")).toBeNull();
  });
});

describe("countTerminalAttempts", () => {
  test("counts completed, failed, cancelled, provider-started, and skipped", () => {
    const records = [
      baseRecord({ status: "reserved", attemptNumber: 1 }),
      baseRecord({ status: "provider-started", attemptNumber: 2 }),
      baseRecord({ status: "completed", attemptNumber: 3 }),
      baseRecord({ status: "skipped", attemptNumber: 4 }),
      baseRecord({ status: "failed", attemptNumber: 5 }),
      baseRecord({ status: "cancelled", attemptNumber: 6 }),
      baseRecord({ status: "unknown", attemptNumber: 7 }),
    ];
    expect(countTerminalAttempts(records)).toBe(5);
  });
});

describe("isReservationStale", () => {
  test("reserved records expire after TTL", () => {
    const record = baseRecord({
      createdAt: "2026-08-28T12:00:00.000Z",
    });
    const now = new Date("2026-08-28T13:30:00.000Z");
    expect(isReservationStale(record, 3600, now)).toBe(true);
    expect(isReservationStale(record, 7200, now)).toBe(false);
  });

  test("non-reserved records are never stale", () => {
    const record = baseRecord({ status: "provider-started" });
    expect(isReservationStale(record, 1, new Date())).toBe(false);
  });
});

describe("selectActiveReservation", () => {
  test("returns the newest non-stale in-flight reservation", () => {
    const stale = baseRecord({
      attemptNumber: 1,
      createdAt: "2026-08-28T10:00:00.000Z",
    });
    const active = baseRecord({
      attemptNumber: 2,
      status: "provider-started",
      createdAt: "2026-08-28T12:00:00.000Z",
    });
    expect(
      selectActiveReservation(
        [stale, active],
        HEAD,
        POLICY_HASH,
        3600,
        new Date("2026-08-28T12:30:00.000Z"),
      ),
    ).toEqual(active);
  });
});

describe("reserveAdmissionAttempt", () => {
  test("creates a new reserved record with incremented attempt number", () => {
    const existing = [
      baseRecord({ status: "completed", attemptNumber: 1 }),
      baseRecord({ status: "skipped", attemptNumber: 2 }),
    ];
    const { record, created } = reserveAdmissionAttempt({
      existing,
      prNumber: PR,
      headSha: HEAD,
      policyHash: POLICY_HASH,
      reservationTtlSeconds: 3600,
      now: new Date("2026-08-28T13:00:00.000Z"),
    });
    expect(created).toBe(true);
    expect(record.attemptNumber).toBe(3);
    expect(record.status).toBe("reserved");
    expect(record.reservationId).toBe(
      admissionRecordFingerprint(PR, HEAD, POLICY_HASH),
    );
  });

  test("is idempotent for an active reservation within TTL", () => {
    const active = baseRecord({
      status: "reserved",
      attemptNumber: 2,
      createdAt: "2026-08-28T12:00:00.000Z",
    });
    const { record, created } = reserveAdmissionAttempt({
      existing: [active],
      prNumber: PR,
      headSha: HEAD,
      policyHash: POLICY_HASH,
      reservationTtlSeconds: 3600,
      now: new Date("2026-08-28T12:30:00.000Z"),
    });
    expect(created).toBe(false);
    expect(record).toEqual(active);
  });

  test("creates a fresh reservation when the prior reserved row is stale", () => {
    const stale = baseRecord({
      status: "reserved",
      attemptNumber: 1,
      createdAt: "2026-08-28T10:00:00.000Z",
    });
    const { record, created } = reserveAdmissionAttempt({
      existing: [stale],
      prNumber: PR,
      headSha: HEAD,
      policyHash: POLICY_HASH,
      reservationTtlSeconds: 3600,
      now: new Date("2026-08-28T12:00:00.000Z"),
    });
    expect(created).toBe(true);
    expect(record.attemptNumber).toBe(2);
  });
});

describe("settleAdmissionAttempt", () => {
  test("writes terminal status, reason, and settledAt", () => {
    const settledAt = new Date("2026-08-28T12:10:00.000Z");
    const settled = settleAdmissionAttempt(
      baseRecord(),
      "completed",
      "review complete",
      settledAt,
    );
    expect(settled.status).toBe("completed");
    expect(settled.decisionReason).toBe("review complete");
    expect(settled.settledAt).toBe(settledAt.toISOString());
  });
});
