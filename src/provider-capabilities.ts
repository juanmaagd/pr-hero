import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type RunnerBackend =
  | "claude-code"
  | "opencode"
  | "antigravity"
  | "codex";

export type CredentialKind =
  | "claude_subscription_oauth"
  | "opencode_chatgpt_oauth"
  | "provider_api_token";

export type ExecutableDenialCode = "executable_not_approved";

export interface ExecutableAllowlistEntry {
  readonly absolutePath: string;
  readonly sha256: string;
}

export interface VerifiedExecutable {
  readonly absolutePath: string;
  readonly sha256: string;
  readonly verifiedExecutionPath: string;
  readonly kind?: "binary" | "script-launcher";
  readonly version?: string;
}

export interface ExecutableVerificationApproved {
  readonly approved: true;
  readonly executable: VerifiedExecutable;
  readonly code?: undefined;
  readonly reason?: undefined;
}

export interface ExecutableVerificationDenied {
  readonly approved: false;
  readonly code: ExecutableDenialCode;
  readonly reason: string;
  readonly executable?: undefined;
}

export type ExecutableVerificationResult =
  | ExecutableVerificationApproved
  | ExecutableVerificationDenied;

export interface VerifyExecutableOptions {
  readonly candidatePath: string;
  readonly allowlist?: readonly ExecutableAllowlistEntry[];
  readonly snapshotDir?: string;
}

export async function verifyExecutableAuthority(
  options: VerifyExecutableOptions,
): Promise<ExecutableVerificationResult> {
  const { candidatePath, allowlist = [] } = options;

  // 1. Validate allowlist integrity: reject relative paths in allowlist entries
  for (const entry of allowlist) {
    if (!path.isAbsolute(entry.absolutePath)) {
      return {
        approved: false,
        code: "executable_not_approved",
        reason: `Allowlist entry contains relative path: ${entry.absolutePath}`,
      };
    }
  }

  // 2. Candidate path must be absolute
  if (!path.isAbsolute(candidatePath)) {
    return {
      approved: false,
      code: "executable_not_approved",
      reason: `Relative executable path not allowed: ${candidatePath}`,
    };
  }

  // 3. Resolve canonical path
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidatePath);
  } catch (error) {
    return {
      approved: false,
      code: "executable_not_approved",
      reason: `Executable not found or realpath failed: ${(error as Error).message}`,
    };
  }

  // 4. Check executable mode bit
  try {
    const stats = statSync(canonicalPath);
    const isExecutable = (stats.mode & 0o111) !== 0;
    if (!isExecutable) {
      return {
        approved: false,
        code: "executable_not_approved",
        reason: `Missing executable permissions on: ${canonicalPath}`,
      };
    }
  } catch (error) {
    return {
      approved: false,
      code: "executable_not_approved",
      reason: `Failed to inspect permissions: ${(error as Error).message}`,
    };
  }

  // 5. Read bytes and compute SHA-256
  let content: Buffer;
  let digest: string;
  try {
    const raw = await readFile(canonicalPath);
    content = Buffer.from(raw);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    digest = hasher.digest("hex");
  } catch (error) {
    return {
      approved: false,
      code: "executable_not_approved",
      reason: `Failed to read and hash binary: ${(error as Error).message}`,
    };
  }

  // 6. Match against allowlist
  const matchingEntry = allowlist.find(
    (entry) =>
      path.resolve(entry.absolutePath) === canonicalPath &&
      entry.sha256.toLowerCase() === digest.toLowerCase(),
  );

  if (!matchingEntry) {
    return {
      approved: false,
      code: "executable_not_approved",
      reason: `Binary ${canonicalPath} (sha256:${digest}) is not in configured allowlist`,
    };
  }

  // WHY scripts are not snapshotted: a shebang launcher's interpreter resolves
  // relative imports against the script's own location, so a snapshot copy
  // breaks sibling imports. The launcher executes from its canonical path; the
  // residual TOCTOU window on scripts is accepted until credential projection
  // lands.
  if (content.subarray(0, 2).toString("latin1") === "#!") {
    return {
      approved: true,
      executable: {
        absolutePath: canonicalPath,
        sha256: digest,
        verifiedExecutionPath: canonicalPath,
        kind: "script-launcher",
      },
    };
  }

  // 7. TOCTOU Defense: Create private verified execution snapshot bound to verified bytes
  const snapBase =
    options.snapshotDir ?? path.join(tmpdir(), "prhero-exec-snapshots");
  const snapDir = path.join(snapBase, `${digest.slice(0, 16)}-${randomUUID()}`);
  try {
    mkdirSync(snapDir, { recursive: true, mode: 0o700 });
    chmodSync(snapDir, 0o700);
    const snapBinaryName = path.basename(canonicalPath);
    const snapBinaryPath = path.join(snapDir, snapBinaryName);
    // Exclusive, no-follow create: a symlink planted at this exact path must
    // make the write fail closed rather than redirect the verified bytes.
    const fd = openSync(
      snapBinaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o700,
    );
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    chmodSync(snapBinaryPath, 0o700);

    const snapshotBytes = readFileSync(snapBinaryPath);
    const verifyHasher = new Bun.CryptoHasher("sha256");
    verifyHasher.update(snapshotBytes);
    if (verifyHasher.digest("hex") !== digest.toLowerCase()) {
      rmSync(snapDir, { recursive: true, force: true });
      return {
        approved: false,
        code: "executable_not_approved",
        reason: "snapshot verification failed",
      };
    }

    return {
      approved: true,
      executable: {
        absolutePath: canonicalPath,
        sha256: digest,
        verifiedExecutionPath: snapBinaryPath,
        kind: "binary",
      },
    };
  } catch (error) {
    rmSync(snapDir, { recursive: true, force: true });
    return {
      approved: false,
      code: "executable_not_approved",
      reason: `Failed to create verified execution snapshot: ${(error as Error).message}`,
    };
  }
}

export interface ProviderCapabilityReport {
  readonly backend: RunnerBackend;
  readonly status: "ready" | "degraded" | "blocking";
  readonly binary?: { absolutePath: string; sha256: string; version: string };
  readonly auth: {
    kind: CredentialKind;
    projectionReady: boolean;
    probe: "passed" | "failed" | "not_run";
  };
  readonly isolation: {
    syntheticHome: boolean;
    workspaceReadBroker: boolean;
    codegraphPolicy: boolean;
  };
  readonly protocol: {
    terminalProof: boolean;
    boundedEvents: boolean;
    usageMode: "snapshot" | "delta" | "none";
  };
  readonly cancellation: {
    deadlineMs: number;
    conformance: "passed" | "failed" | "not_run";
  };
  readonly billing: {
    mode: "subscription" | "metered" | "unknown";
    pricingReady: boolean;
  };
  readonly rateLimitBucketId?: string;
  readonly issues: readonly {
    code: string;
    message: string;
    blocking: boolean;
  }[];
}
