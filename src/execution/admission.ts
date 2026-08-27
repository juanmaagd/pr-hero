// D1-08 PR5a (§9.2): the attempt-scoped, lease-returning admission gate.
// `StepAdmissionGate` (contracts.ts) is admitted ONCE per STEP, before the
// retry loop, and returns nothing releasable — design decision D4 leaves it
// untouched: it has 5 implementors, 3 of them in test/security/* and
// test/harness/security-admission.test.ts, and rule 4 requires those
// assertions stay green UNMODIFIED. `AttemptAdmissionGate` is a NEW,
// separate contract admitted per ATTEMPT, inside the retry loop, returning
// an `AttemptLease` the harness releases exactly once in `finally` — the
// shape the concurrency limiter's FIFO/breaker semantics actually need to
// gate paid spawns.
//
// This module is a thin, mechanical wrapper on purpose: `ConcurrencyLimiter`
// (PR3) already owns every FIFO/breaker rule and is tested directly at that
// layer (test/execution/concurrency-limiter.test.ts) — per that module's own
// header comment, PR5a's job is "wrap this in AttemptAdmissionGate," not
// "invent FIFO/breaker semantics under time pressure."

import type { ConcurrencyLimiter } from "./concurrency-limiter";

export interface AttemptLease {
  readonly leaseId: string;
  readonly rateLimitBucketId: string;
  // Idempotent — §9.2 "released exactly once in finally" is the CALLER's
  // contract; this mirrors ConcurrencyLimiter's own idempotent release so a
  // caller bug (a double-release) cannot corrupt the underlying slot count.
  release(): void;
}

export interface AttemptAdmissionGate {
  // Rejects on abort (the limiter's FIFO queue is abort-aware) or on a
  // tripped bucket breaker — never silently grants a slot.
  acquire(input: {
    readonly sessionId: string;
    readonly attempt: number;
    readonly rateLimitBucketId: string;
    readonly signal: AbortSignal;
  }): Promise<AttemptLease>;
  // Called by the harness when an attempt's settlement receipt outcome is
  // `local_fenced_remote_unconfirmed` (spec: "Circuit Breaker Fences An
  // Unconfirmed-Abort Bucket"): trips this bucket's breaker to zero new
  // capacity for the rest of the run. Optional so a minimal stub gate in
  // tests (or a future gate implementation with no breaker semantics) can
  // omit it without breaking the interface.
  reportUnconfirmedRemote?(rateLimitBucketId: string): void;
}

export class ConcurrencyAttemptAdmissionGate implements AttemptAdmissionGate {
  constructor(private readonly limiter: ConcurrencyLimiter) {}

  async acquire(input: {
    readonly sessionId: string;
    readonly attempt: number;
    readonly rateLimitBucketId: string;
    readonly signal: AbortSignal;
  }): Promise<AttemptLease> {
    const lease = await this.limiter.acquire(
      input.rateLimitBucketId,
      input.signal,
    );
    let released = false;
    return {
      leaseId: `${input.sessionId}#${input.attempt}`,
      rateLimitBucketId: input.rateLimitBucketId,
      release: () => {
        if (released) return;
        released = true;
        lease.release();
      },
    };
  }

  reportUnconfirmedRemote(rateLimitBucketId: string): void {
    this.limiter.tripBreaker(rateLimitBucketId);
  }
}
