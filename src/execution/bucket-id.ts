// D1-08 PR3 (§9.2): rate-limit bucket identity.
//
//   bucketId = HMAC(localKey, provider | credentialFingerprint | account |
//                    project | rateLimitGroup)
//
// Two design invariants that make this NON-obvious to implement naively:
//
// 1. Unknown scope MUST coarsen, never split (spec: "Bucket Identity
//    Coarsens Unknown Scope"). An omitted `account`/`project`/
//    `rateLimitGroup` enters the HMAC as the literal sentinel "unknown", so
//    distinct-but-unknown scopes collapse onto ONE bucket rather than each
//    silently getting its own ceiling. This is not a fallback for a bug —
//    it is the correct, conservative behavior for every credential kind
//    that has not yet learned to report its scope (today: 100% of
//    claude_subscription_oauth).
//
// 2. Fields are length-prefixed BEFORE the `|` join (threat matrix:
//    "Delimiter collision"). Naive concatenation lets a scope field that
//    itself contains `|` shift the join boundary and forge another bucket's
//    identity — e.g. `{account:"a|b"}` naively joining to the same string as
//    `{account:"a", project:"b"}`. `len:value` prefixes make that shift
//    structurally impossible: the decoder (conceptually) always knows where
//    one field ends because its length is stated up front.
//
// `deriveBucketId` is pure. `loadOrCreateBucketKey` is the one impure half —
// injectable for offline tests, defaulting to real fs/crypto in production.

import { createHmac, randomBytes as nodeRandomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { prheroLayout } from "../home-preflight";

const UNKNOWN_SCOPE_SENTINEL = "unknown";
const BUCKET_KEY_BYTES = 32;

export interface BucketScope {
  readonly account?: string;
  readonly project?: string;
  readonly rateLimitGroup?: string;
}

export interface BucketIdentityInput {
  readonly provider: string;
  readonly credentialFingerprint: string;
  readonly scope?: BucketScope;
}

// `len:value` — a field's stated length is checked before its content is
// consumed, so a `|` (or any other byte) inside `value` cannot be mistaken
// for the next field's boundary.
function encodeField(value: string): string {
  return `${value.length}:${value}`;
}

function scopeFieldOrUnknown(value: string | undefined): string {
  return value === undefined || value.length === 0
    ? UNKNOWN_SCOPE_SENTINEL
    : value;
}

// Exposed for tests that want to assert on the exact pre-HMAC message shape
// without duplicating the encoding rule; not otherwise a public contract.
export function bucketIdentityMessage(input: BucketIdentityInput): string {
  const fields = [
    input.provider,
    input.credentialFingerprint,
    scopeFieldOrUnknown(input.scope?.account),
    scopeFieldOrUnknown(input.scope?.project),
    scopeFieldOrUnknown(input.scope?.rateLimitGroup),
  ];
  return fields.map(encodeField).join("|");
}

// The output is a non-secret bucket ID (redaction, not authentication —
// §9.2/Q5): safe to appear in pipeline.json or logs. The localKey is what
// must never appear there.
export function deriveBucketId(
  input: BucketIdentityInput,
  localKey: Uint8Array,
): string {
  return createHmac("sha256", localKey)
    .update(bucketIdentityMessage(input))
    .digest("hex");
}

export interface LoadOrCreateBucketKeyDeps {
  readonly existsFn?: (p: string) => boolean;
  readonly readFileFn?: (p: string) => Buffer;
  readonly writeFileFn?: (p: string, data: Buffer) => void;
  readonly mkdirFn?: (p: string) => void;
  readonly randomBytesFn?: (n: number) => Buffer;
}

// spec: "Persisted HMAC Key Yields Cross-Run-Stable Bucket IDs" — a 32-byte
// key file at `bucketKeyPath` (Q5: persisted, not per-process, so bucket IDs
// stay comparable across runs for the deferred durable ledger), mode 0600,
// created on first use. Rotation is delete-the-file; there is no versioning
// because the key's job is redaction, not authentication, so an old bucket
// ID silently going stale after rotation is an accepted, harmless cost.
export function loadOrCreateBucketKey(
  home: string,
  deps: LoadOrCreateBucketKeyDeps = {},
): Buffer {
  const exists = deps.existsFn ?? existsSync;
  const readBytes = deps.readFileFn ?? ((p: string) => readFileSync(p));
  const writeBytes =
    deps.writeFileFn ??
    ((p: string, data: Buffer) => writeFileSync(p, data, { mode: 0o600 }));
  const mkdir =
    deps.mkdirFn ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const makeRandomBytes =
    deps.randomBytesFn ?? ((n: number) => nodeRandomBytes(n));

  const layout = prheroLayout(home);
  if (exists(layout.bucketKeyPath)) {
    return readBytes(layout.bucketKeyPath);
  }
  mkdir(layout.dir);
  const key = makeRandomBytes(BUCKET_KEY_BYTES);
  writeBytes(layout.bucketKeyPath, key);
  return key;
}
