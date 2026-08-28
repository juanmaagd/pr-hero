// D1-08 PR3 (§9.2): "The limiter enforces global and per-bucket ceilings
// with abort-aware FIFO queues. A lease is released exactly once in
// finally. `local_fenced_remote_unconfirmed` releases the local execution
// slot but trips the bucket circuit breaker to zero new capacity until
// reconciliation or operator reset."
//
// This module is the pure mechanism only — no harness wiring, no
// AttemptAdmissionGate (that interface, and the lease-acquire/release call
// sites inside the attempt loop, land in PR5a per the design's own tripwire
// table: "PR3 | None — pure"). `ConcurrencyLimiter` is deliberately
// standalone and directly testable so PR5a's wiring work is "wrap this in
// AttemptAdmissionGate," not "invent FIFO/breaker semantics under time
// pressure."
//
// Design notes worth pinning here because a queue implementation drifts
// easily:
//  - Admission is FIFO per bucket. A global ceiling is checked ALONGSIDE the
//    per-bucket ceiling — both must have room before a queued request is
//    admitted, so a busy bucket cannot starve capacity another bucket is
//    entitled to, and the global cap still holds when every bucket is under
//    its own ceiling.
//  - `release()` is idempotent (§9.2 "released exactly once in finally" is
//    the CALLER's contract; this module tolerates a caller that calls it
//    twice anyway, cheaply, rather than making a caller bug corrupt the
//    slot count).
//  - Aborting a QUEUED request removes it from the queue and rejects it
//    without ever having consumed a slot — required by "FIFO Abort-Aware
//    Admission."
//  - `tripBreaker` is permanent for the lifetime of this limiter instance
//    (the process, i.e. "the rest of the run" per spec — cross-run
//    persistence is explicitly out of scope, §"In-Memory Ledger With
//    Surfaced Cross-Run Gap"). It rejects every currently-queued request for
//    that bucket immediately, and every future `acquire()` call for it,
//    without ever granting a slot.

export class BucketBreakerTrippedError extends Error {
  readonly bucketId: string;

  constructor(bucketId: string) {
    super(
      `bucket "${bucketId}" circuit breaker is tripped: no new capacity this run`,
    );
    this.name = "BucketBreakerTrippedError";
    this.bucketId = bucketId;
  }
}

export class ConcurrencyAdmissionAbortedError extends Error {
  readonly bucketId: string;

  constructor(bucketId: string) {
    super(
      `admission to bucket "${bucketId}" was aborted before a slot was granted`,
    );
    this.name = "ConcurrencyAdmissionAbortedError";
    this.bucketId = bucketId;
  }
}

export interface ConcurrencyLease {
  release(): void;
}

export interface ConcurrencyLimiterOptions {
  // Per-bucket ceiling. Uniform across buckets in PR3 — a per-bucket
  // override table is not part of this slice's scope.
  readonly bucketCeiling: number;
  // Optional global ceiling across every bucket combined. Defaults to
  // Number.POSITIVE_INFINITY (no global cap beyond the per-bucket ones).
  readonly globalCeiling?: number;
}

interface QueueEntry {
  readonly resolve: (lease: ConcurrencyLease) => void;
  readonly reject: (error: Error) => void;
  readonly detachAbortListener: () => void;
}

export class ConcurrencyLimiter {
  private readonly bucketCeiling: number;
  private readonly globalCeiling: number;
  private readonly bucketInUse = new Map<string, number>();
  private readonly bucketQueues = new Map<string, QueueEntry[]>();
  private readonly trippedBuckets = new Set<string>();
  private globalInUse = 0;

  constructor(options: ConcurrencyLimiterOptions) {
    this.bucketCeiling = options.bucketCeiling;
    this.globalCeiling = options.globalCeiling ?? Number.POSITIVE_INFINITY;
  }

  acquire(bucketId: string, signal?: AbortSignal): Promise<ConcurrencyLease> {
    if (this.trippedBuckets.has(bucketId)) {
      return Promise.reject(new BucketBreakerTrippedError(bucketId));
    }
    if (signal?.aborted) {
      return Promise.reject(new ConcurrencyAdmissionAbortedError(bucketId));
    }
    return new Promise<ConcurrencyLease>((resolve, reject) => {
      const onAbort = (): void => {
        this.removeQueued(bucketId, entry);
        reject(new ConcurrencyAdmissionAbortedError(bucketId));
      };
      const detachAbortListener = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      const entry: QueueEntry = { resolve, reject, detachAbortListener };
      signal?.addEventListener("abort", onAbort, { once: true });

      const queue = this.bucketQueues.get(bucketId) ?? [];
      queue.push(entry);
      this.bucketQueues.set(bucketId, queue);
      this.pump(bucketId);
    });
  }

  // Permanent for the life of this limiter instance ("the rest of the
  // run"). Every currently-queued request for the bucket is rejected right
  // away — none of them was ever granted a slot, so there is nothing to
  // release.
  tripBreaker(bucketId: string): void {
    this.trippedBuckets.add(bucketId);
    const queue = this.bucketQueues.get(bucketId);
    if (queue === undefined) return;
    this.bucketQueues.set(bucketId, []);
    for (const entry of queue) {
      entry.detachAbortListener();
      entry.reject(new BucketBreakerTrippedError(bucketId));
    }
  }

  private removeQueued(bucketId: string, entry: QueueEntry): void {
    const queue = this.bucketQueues.get(bucketId);
    if (queue === undefined) return;
    const index = queue.indexOf(entry);
    if (index !== -1) queue.splice(index, 1);
  }

  private pump(bucketId: string): void {
    const queue = this.bucketQueues.get(bucketId);
    if (queue === undefined) return;
    while (
      queue.length > 0 &&
      (this.bucketInUse.get(bucketId) ?? 0) < this.bucketCeiling &&
      this.globalInUse < this.globalCeiling
    ) {
      const entry = queue.shift();
      if (entry === undefined) break;
      entry.detachAbortListener();
      this.bucketInUse.set(bucketId, (this.bucketInUse.get(bucketId) ?? 0) + 1);
      this.globalInUse++;
      let released = false;
      entry.resolve({
        release: () => {
          if (released) return;
          released = true;
          this.bucketInUse.set(
            bucketId,
            (this.bucketInUse.get(bucketId) ?? 0) - 1,
          );
          this.globalInUse--;
          // Releasing a slot frees per-bucket capacity for THIS bucket and
          // global capacity for every bucket — a queued request in a
          // DIFFERENT bucket may be waiting on the global ceiling alone, so
          // every bucket with a non-empty queue must get a pump chance, not
          // only the one that just released.
          this.pump(bucketId);
          for (const otherBucketId of this.bucketQueues.keys()) {
            if (otherBucketId !== bucketId) this.pump(otherBucketId);
          }
        },
      });
    }
  }
}
