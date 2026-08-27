// D1-08 PR3 (§9.2): the abort-aware FIFO concurrency limiter and its circuit
// breaker. Pure/offline — no harness wiring yet (that is PR5a). These tests
// exercise `ConcurrencyLimiter` directly, at the limiter level, per the
// design's own tripwire table ("PR3 | None — pure").

import { describe, expect, test } from "bun:test";
import {
  BucketBreakerTrippedError,
  ConcurrencyLimiter,
} from "../../src/execution/concurrency-limiter";

describe("ConcurrencyLimiter FIFO admission", () => {
  // 3.5 RED: two same-bucket ceiling-1 submissions serialize FIFO by
  // submission order (limiter-level, no harness).
  test("two ceiling-1 submissions on the same bucket start strictly in submission order, never overlapping", async () => {
    const limiter = new ConcurrencyLimiter({ bucketCeiling: 1 });
    const events: string[] = [];

    const leaseAPromise = limiter.acquire("bucket-1");
    const leaseBPromise = limiter.acquire("bucket-1");

    const leaseA = await leaseAPromise;
    events.push("A-started");

    // B must NOT have started yet — it is still queued behind A's ceiling.
    let bStarted = false;
    leaseBPromise.then(() => {
      bStarted = true;
      events.push("B-started");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bStarted).toBe(false);

    leaseA.release();
    const leaseB = await leaseBPromise;
    expect(bStarted).toBe(true);
    leaseB.release();

    expect(events).toEqual(["A-started", "B-started"]);
  });

  test("submissions on DIFFERENT buckets each at ceiling 1 do not block each other", async () => {
    const limiter = new ConcurrencyLimiter({ bucketCeiling: 1 });
    const leaseX = await limiter.acquire("bucket-x");
    const leaseYPromise = limiter.acquire("bucket-y");
    let yStarted = false;
    leaseYPromise.then(() => {
      yStarted = true;
    });
    await Promise.resolve();
    expect(yStarted).toBe(true);
    leaseX.release();
    (await leaseYPromise).release();
  });

  test("a bucket ceiling above 1 admits multiple concurrent leases before queuing", async () => {
    const limiter = new ConcurrencyLimiter({ bucketCeiling: 2 });
    const leaseA = await limiter.acquire("bucket-1");
    const leaseB = await limiter.acquire("bucket-1");
    const leaseCPromise = limiter.acquire("bucket-1");
    let cStarted = false;
    leaseCPromise.then(() => {
      cStarted = true;
    });
    await Promise.resolve();
    expect(cStarted).toBe(false);
    leaseA.release();
    const leaseC = await leaseCPromise;
    expect(cStarted).toBe(true);
    leaseB.release();
    leaseC.release();
  });

  test("the global ceiling caps admission across every bucket combined", async () => {
    const limiter = new ConcurrencyLimiter({
      bucketCeiling: 5,
      globalCeiling: 1,
    });
    const leaseA = await limiter.acquire("bucket-1");
    const leaseBPromise = limiter.acquire("bucket-2");
    let bStarted = false;
    leaseBPromise.then(() => {
      bStarted = true;
    });
    await Promise.resolve();
    expect(bStarted).toBe(false);
    leaseA.release();
    (await leaseBPromise).release();
    expect(bStarted).toBe(true);
  });

  test("aborting a queued acquire rejects it and does not consume a slot", async () => {
    const limiter = new ConcurrencyLimiter({ bucketCeiling: 1 });
    const leaseA = await limiter.acquire("bucket-1");
    const controller = new AbortController();
    const queued = limiter.acquire("bucket-1", controller.signal);
    controller.abort();
    await expect(queued).rejects.toThrow();

    // Releasing A must free the slot for a THIRD request — proving the
    // aborted request never held (or leaked) a slot.
    leaseA.release();
    const leaseC = await limiter.acquire("bucket-1");
    expect(leaseC).toBeDefined();
    leaseC.release();
  });
});

describe("ConcurrencyLimiter circuit breaker", () => {
  // 3.6 RED: local_fenced_remote_unconfirmed trips that bucket's breaker to
  // zero new capacity for the run.
  test("tripping a bucket's breaker refuses a subsequent admission without contacting anything", async () => {
    const limiter = new ConcurrencyLimiter({ bucketCeiling: 5 });
    limiter.tripBreaker("bucket-fenced");
    await expect(limiter.acquire("bucket-fenced")).rejects.toBeInstanceOf(
      BucketBreakerTrippedError,
    );
  });

  test("a tripped breaker does not affect other buckets", async () => {
    const limiter = new ConcurrencyLimiter({ bucketCeiling: 5 });
    limiter.tripBreaker("bucket-fenced");
    const lease = await limiter.acquire("bucket-healthy");
    expect(lease).toBeDefined();
    lease.release();
  });

  test("tripping the breaker while requests are already queued rejects them immediately, releasing no slot", async () => {
    const limiter = new ConcurrencyLimiter({ bucketCeiling: 1 });
    const first = await limiter.acquire("bucket-1");
    const queued = limiter.acquire("bucket-1");
    limiter.tripBreaker("bucket-1");
    await expect(queued).rejects.toBeInstanceOf(BucketBreakerTrippedError);
    // First lease's own release() must still work — tripping the breaker
    // fences NEW admission, it does not reach back into an in-flight lease.
    expect(() => first.release()).not.toThrow();
  });

  test("the breaker stays tripped for every subsequent admission attempt this run", async () => {
    const limiter = new ConcurrencyLimiter({ bucketCeiling: 5 });
    limiter.tripBreaker("bucket-fenced");
    await expect(limiter.acquire("bucket-fenced")).rejects.toBeInstanceOf(
      BucketBreakerTrippedError,
    );
    await expect(limiter.acquire("bucket-fenced")).rejects.toBeInstanceOf(
      BucketBreakerTrippedError,
    );
  });
});
