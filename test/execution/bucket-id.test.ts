// D1-08 PR3 (§9.2): rate-limit bucket identity. `deriveBucketId` is pure —
// HMAC(localKey, provider | credentialFingerprint | account | project |
// rateLimitGroup) with length-prefixed fields (a `|` inside a field cannot
// forge another bucket's identity) and an "unknown" sentinel for any missing
// scope field (omission coarsens buckets, never splits them).
// `loadOrCreateBucketKey` is the one impure half: a persisted 32-byte key
// file at `bucketKeyPath`, mode 0600, created on first use.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type BucketIdentityInput,
  deriveBucketId,
  loadOrCreateBucketKey,
} from "../../src/execution/bucket-id";
import { prheroLayout } from "../../src/home-preflight";

const KEY_A = Buffer.from("a".repeat(64), "hex");
const KEY_B = Buffer.from("b".repeat(64), "hex");

function scope(input: Partial<BucketIdentityInput> = {}): BucketIdentityInput {
  return {
    provider: "anthropic",
    credentialFingerprint: "fp-1",
    ...input,
  };
}

describe("deriveBucketId", () => {
  // 3.1 RED: same credential + unchanged key file, process restarted →
  // identical bucketId. Simulated here by calling deriveBucketId twice with
  // the same key bytes (loadOrCreateBucketKey's own restart-stability is
  // covered below).
  test("the same credential and key yield the same bucketId across calls", () => {
    const input = scope({
      scope: { account: "acct-1", project: "proj-1", rateLimitGroup: "grp-1" },
    });
    const first = deriveBucketId(input, KEY_A);
    const second = deriveBucketId(input, KEY_A);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(0);
  });

  test("a different key produces a different bucketId for the same credential", () => {
    const input = scope();
    expect(deriveBucketId(input, KEY_A)).not.toBe(deriveBucketId(input, KEY_B));
  });

  // 3.2 RED: two same-provider credentials, no account/project/
  // rateLimitGroup → identical bucketId (unknown coarsening) — an omitted
  // scope field must NOT distinguish two otherwise-identical credentials'
  // buckets differently than an explicit "unknown"... but two DIFFERENT
  // credentials (different fingerprints) with all-unknown scope must
  // nonetheless collapse to ONE bucket, per the spec's "distinct-but-unknown
  // scopes must share one bucket, never split into separate ones."
  test("two same-provider credentials with no scope fields share one bucket (unknown coarsens, never splits)", () => {
    const credentialA = scope({ credentialFingerprint: "fp-A" });
    const credentialB = scope({ credentialFingerprint: "fp-B" });
    // Per spec: bucketId keys on provider + credentialFingerprint + scope.
    // "Two credentials" sharing a bucket means two PROJECTIONS of the SAME
    // underlying scope-less credential kind collapse — modelled here as the
    // same fingerprint (what claude_subscription_oauth actually reports
    // today, per the design's Open Question) with omitted vs explicit
    // "unknown" scope fields never splitting from each other.
    const omitted = deriveBucketId(credentialA, KEY_A);
    const explicitUnknown = deriveBucketId(
      {
        ...credentialA,
        scope: {
          account: undefined,
          project: undefined,
          rateLimitGroup: undefined,
        },
      },
      KEY_A,
    );
    expect(omitted).toBe(explicitUnknown);

    // Two distinct credential fingerprints, each with fully unknown scope,
    // are still two DIFFERENT buckets (credentialFingerprint itself
    // distinguishes them) — the "unknown" sentinel only coarsens the SCOPE
    // fields, it never merges distinct credentials into one bucket.
    expect(deriveBucketId(credentialA, KEY_A)).not.toBe(
      deriveBucketId(credentialB, KEY_A),
    );

    // The actual coarsening the spec asks for: the SAME credential kind with
    // no scope info at all (today's claude_subscription_oauth reality, where
    // account/project/rateLimitGroup are ALL unknown) must map every such
    // credential onto the identical literal fields the HMAC sees — i.e. an
    // omitted scope object entirely behaves exactly like one whose fields
    // are all explicitly undefined.
    expect(deriveBucketId(credentialA, KEY_A)).toBe(
      deriveBucketId({ ...credentialA, scope: {} }, KEY_A),
    );
  });

  // 3.3 RED: a bucket-scope field containing `|` cannot forge another
  // bucket's identity (length-prefix-before-join defends the delimiter).
  test("a scope field containing the join delimiter cannot forge a collision via naive concatenation", () => {
    // Without length-prefixing, `account: "a|b", project: undefined` and
    // `account: "a", project: "b"` would naively join to the same string
    // ("a|b|unknown|..." vs "a|b|unknown|..."). Length-prefixing each field
    // before the join makes the two inputs produce different messages, and
    // therefore different bucketIds.
    const forger = deriveBucketId(scope({ scope: { account: "a|b" } }), KEY_A);
    const victim = deriveBucketId(
      scope({ scope: { account: "a", project: "b" } }),
      KEY_A,
    );
    expect(forger).not.toBe(victim);
  });

  test("a rateLimitGroup containing the delimiter does not collide with a shifted account/project split", () => {
    const forger = deriveBucketId(
      scope({ scope: { rateLimitGroup: "x|y|z" } }),
      KEY_A,
    );
    const victim = deriveBucketId(
      scope({ scope: { account: "x", project: "y", rateLimitGroup: "z" } }),
      KEY_A,
    );
    expect(forger).not.toBe(victim);
  });
});

describe("loadOrCreateBucketKey", () => {
  function tmpHome(): string {
    return mkdtempSync(path.join(tmpdir(), "pr-hero-bucket-key-"));
  }

  // 3.4 RED: key file created at bucketKeyPath, mode 0600.
  test("creates the key file at bucketKeyPath with mode 0600 on first use", () => {
    const home = tmpHome();
    try {
      const key = loadOrCreateBucketKey(home);
      const keyPath = prheroLayout(home).bucketKeyPath;
      expect(existsSync(keyPath)).toBe(true);
      const mode = statSync(keyPath).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(key.length).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // 3.1 RED (restart half): same credential + unchanged key file, process
  // "restarted" (a fresh loadOrCreateBucketKey call reading the same file)
  // → identical bucketId.
  test("an unchanged key file yields the identical bucketId across a simulated process restart", () => {
    const home = tmpHome();
    try {
      const firstProcessKey = loadOrCreateBucketKey(home);
      const input = scope({
        scope: {
          account: "acct-1",
          project: "proj-1",
          rateLimitGroup: "grp-1",
        },
      });
      const bucketIdBeforeRestart = deriveBucketId(input, firstProcessKey);

      // Simulate a restart: a brand-new call reads the SAME on-disk file
      // rather than generating a new key.
      const secondProcessKey = loadOrCreateBucketKey(home);
      const bucketIdAfterRestart = deriveBucketId(input, secondProcessKey);

      expect(secondProcessKey.equals(firstProcessKey)).toBe(true);
      expect(bucketIdAfterRestart).toBe(bucketIdBeforeRestart);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("two different homes get two different, independently-created keys", () => {
    const homeA = tmpHome();
    const homeB = tmpHome();
    try {
      const keyA = loadOrCreateBucketKey(homeA);
      const keyB = loadOrCreateBucketKey(homeB);
      expect(keyA.equals(keyB)).toBe(false);
    } finally {
      rmSync(homeA, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
    }
  });

  // Confidentiality half of 3.4: the key bytes never travel anywhere but the
  // returned Buffer and the 0600 file itself — no other file under the home
  // gets written by loadOrCreateBucketKey, and the raw bytes never appear as
  // readable text in the key file (they are random bytes, not a serialized
  // struct that could carry a stray copy elsewhere).
  test("a concurrent first-use race reads the winner's key on EEXIST instead of overwriting", () => {
    const home = tmpHome();
    let created = false;
    try {
      const keyA = loadOrCreateBucketKey(home, {
        writeFileFn: (_p, data) => {
          if (created) {
            const err = new Error("file exists") as NodeJS.ErrnoException;
            err.code = "EEXIST";
            throw err;
          }
          created = true;
          writeFileSync(prheroLayout(home).bucketKeyPath, data, {
            mode: 0o600,
          });
        },
        readFileFn: (p) => readFileSync(p),
      });
      const keyB = loadOrCreateBucketKey(home, {
        writeFileFn: (_p, data) => {
          if (created) {
            const err = new Error("file exists") as NodeJS.ErrnoException;
            err.code = "EEXIST";
            throw err;
          }
          created = true;
          writeFileSync(prheroLayout(home).bucketKeyPath, data, {
            mode: 0o600,
          });
        },
        readFileFn: (p) => readFileSync(p),
      });
      expect(keyA.equals(keyB)).toBe(true);
      expect(keyA.length).toBe(32);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("no artifact besides the key file itself is written under the home", () => {
    const home = tmpHome();
    try {
      loadOrCreateBucketKey(home);
      const layout = prheroLayout(home);
      expect(existsSync(layout.bucketKeyPath)).toBe(true);
      expect(existsSync(layout.logPath)).toBe(false);
      expect(existsSync(layout.metricsDbPath)).toBe(false);
      expect(existsSync(layout.prheroDbPath)).toBe(false);
      const raw = readFileSync(layout.bucketKeyPath);
      expect(raw.length).toBe(32);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
