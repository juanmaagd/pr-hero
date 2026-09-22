import { describe, expect, test } from "bun:test";
import {
  appendAttempt,
  appendObservation,
  emptyDiversityLedger,
  retainPartialFailureEvidence,
  summarizeDiversityAccounting,
} from "../../src/diversity/accounting";
import type { FindingObservation } from "../../src/diversity/clustering";
import { normalizeInclusiveUsage } from "../../src/execution/usage-normalized";

const usage = normalizeInclusiveUsage({
  wallMs: 10,
  inputTotal: 100,
  outputTotal: 50,
  billingMode: "metered",
  costSource: "provider",
  cashCostUsd: 0.2,
  notionalCostUsd: 0.15,
});

const observation = (): FindingObservation => ({
  observationId: "o1",
  specialty: "reliability",
  legId: "leg-1",
  backend: "claude-code",
  provider: "anthropic",
  modelFamily: "claude",
  modelSnapshot: "sonnet",
  replicate: 1,
  attempt: 1,
  promptFingerprint: "prompt",
  routeFingerprint: "route",
  path: "src/a.ts",
  line: 1,
  category: 1,
  severity: "CRITICAL",
  claim: "claim",
  evidence: "evidence",
  proofRefs: [],
  causalHypothesis: "hypothesis",
  artifactSha256: "sha",
});

describe("diversity accounting", () => {
  test("counts retries, failures, and successes in numerator cash/notional", () => {
    let ledger = emptyDiversityLedger();
    ledger = appendAttempt(ledger, {
      attemptId: "a1",
      legId: "leg-1",
      armId: "arm",
      specialty: "reliability",
      replicate: 1,
      attempt: 1,
      status: "failed",
      usage,
    });
    ledger = appendAttempt(ledger, {
      attemptId: "a2",
      legId: "leg-1",
      armId: "arm",
      specialty: "reliability",
      replicate: 1,
      attempt: 2,
      status: "completed",
      usage,
    });
    ledger = appendObservation(ledger, {
      observation: observation(),
      attemptId: "a2",
      legId: "leg-1",
      armId: "arm",
    });
    const totals = summarizeDiversityAccounting(ledger);
    expect(totals.attemptCount).toBe(2);
    expect(totals.failureCount).toBe(1);
    expect(totals.cashCostUsd).toBeCloseTo(0.4);
    expect(totals.notionalCostUsd).toBeCloseTo(0.3);
    expect(retainPartialFailureEvidence(ledger)).toBe(true);
  });
});
