// D1-05 §6.1: credential projection. The broker copies ONLY the minimum
// credential record out of a trusted source into an ephemeral 0700 projection
// with a single 0600 file; every component is lstat-checked so a pre-planted
// symlink cannot redirect the credential write outside the projection root.
// Credential values, source paths and file contents never appear in errors,
// metadata or logs — only the projected file's sha256 is exposed.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CredentialKind } from "../provider-capabilities";

export type CredentialProjectionFile = {
  readonly path: string;
  readonly mode: 0o600;
  readonly sha256: string;
};

// Verbatim shape of docs/multi-runtime-model-diversity-design.md §6.1.
export interface CredentialProjection {
  readonly projectionId: string;
  readonly kind: CredentialKind;
  readonly syntheticHome: string;
  readonly syntheticConfigHome: string;
  readonly syntheticTmp: string;
  readonly env: Readonly<Record<string, string>>;
  readonly files: readonly CredentialProjectionFile[];
  destroy(): Promise<void>;
}

// Verbatim shape of docs/multi-runtime-model-diversity-design.md §6.1.
export interface CredentialBroker {
  project(input: {
    readonly sessionId: string;
    readonly credentialRef: string;
    readonly kind: CredentialKind;
    readonly verifiedBinaryPath: string;
  }): Promise<CredentialProjection>;
}

export const CLAUDE_CREDENTIALS_KEYCHAIN_SERVICE = "Claude Code-credentials";
const SECURITY_BIN = "/usr/bin/security";

export type CredentialProjectionFailureClass =
  | "unsupported_kind"
  | "source_read_failed"
  | "malformed_payload"
  | "missing_subscription_record"
  | "projection_layout_invalid";

export class CredentialProjectionError extends Error {
  readonly failureClass: CredentialProjectionFailureClass;

  constructor(failureClass: CredentialProjectionFailureClass) {
    // Message names only the failure class — never source content, paths or
    // keychain output (§6.1 redaction rule).
    super(`Credential projection failed (${failureClass})`);
    this.name = "CredentialProjectionError";
    this.failureClass = failureClass;
  }
}

export interface KeychainCredentialBrokerOptions {
  readonly securityBinPath?: string;
  // Injectable for offline tests; returns the raw JSON payload of the
  // keychain item. Production default shells out to /usr/bin/security.
  readonly readerFn?: (service: string) => Promise<string>;
}

interface ClaudeOauthRecord {
  [key: string]: unknown;
}

export class KeychainCredentialBroker implements CredentialBroker {
  private readonly securityBinPath: string;
  private readonly readerFn: (service: string) => Promise<string>;

  constructor(options: KeychainCredentialBrokerOptions = {}) {
    this.securityBinPath = options.securityBinPath ?? SECURITY_BIN;
    if (options.readerFn !== undefined) {
      this.readerFn = options.readerFn;
    } else {
      // Fail loud at construction, not at first spawn: a missing pinned
      // helper is an environment defect (§6.1 pins absolute helper paths).
      if (!existsSync(this.securityBinPath)) {
        throw new Error(
          `Pinned security binary not found at ${this.securityBinPath}`,
        );
      }
      this.readerFn = (service) => this.readKeychain(service);
    }
  }

  async project(input: {
    readonly sessionId: string;
    readonly credentialRef: string;
    readonly kind: CredentialKind;
    readonly verifiedBinaryPath: string;
  }): Promise<CredentialProjection> {
    void input.sessionId;
    void input.credentialRef;
    void input.verifiedBinaryPath;
    if (input.kind !== "claude_subscription_oauth") {
      throw new Error(
        `Unsupported credential kind: ${input.kind} (KeychainCredentialBroker projects only claude_subscription_oauth)`,
      );
    }

    let raw: string;
    try {
      raw = await this.readerFn(CLAUDE_CREDENTIALS_KEYCHAIN_SERVICE);
    } catch {
      throw new CredentialProjectionError("source_read_failed");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CredentialProjectionError("malformed_payload");
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("claudeAiOauth" in parsed)
    ) {
      throw new CredentialProjectionError("missing_subscription_record");
    }

    // Carry ONLY the subscription OAuth record: mcpOAuth and any other keys
    // in the store are unrelated secrets and must not leave the source.
    const oauthRecord = (parsed as Record<string, unknown>).claudeAiOauth;
    if (typeof oauthRecord !== "object" || oauthRecord === null) {
      throw new CredentialProjectionError("missing_subscription_record");
    }

    return this.buildProjection(input.kind, oauthRecord as ClaudeOauthRecord);
  }

  private buildProjection(
    kind: CredentialKind,
    oauthRecord: ClaudeOauthRecord,
  ): CredentialProjection {
    // Fresh UUID root per projection: no reuse across runs, nothing to collide
    // with (§6.1 ephemeral layout).
    const projectionRoot = path.join(
      tmpdir(),
      "prhero-cred-projections",
      randomUUID(),
    );
    const claudeDir = path.join(projectionRoot, ".claude");
    const syntheticTmp = path.join(projectionRoot, "tmp");
    const credentialsFile = path.join(claudeDir, ".credentials.json");

    mkdirSync(projectionRoot, { recursive: true, mode: 0o700 });
    mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    mkdirSync(syntheticTmp, { recursive: true, mode: 0o700 });

    // Empirically proven live (2026-08-26): the CLI authenticates purely from
    // <syntheticHome>/.claude/.credentials.json containing this exact shape.
    const payload = `${JSON.stringify({ claudeAiOauth: oauthRecord }, null, 2)}\n`;
    writeFileSync(credentialsFile, payload, { mode: 0o600 });

    // Defense per §6.1: lstat EVERY component after writing — any symlink in
    // the chain means the credential landed outside our control; fail loud.
    for (const component of [
      tmpdir(),
      path.dirname(path.dirname(credentialsFile)),
      path.dirname(credentialsFile),
      credentialsFile,
    ]) {
      const stats = lstatSync(component);
      if (stats.isSymbolicLink()) {
        // Never leave a possibly-redirected credential tree behind.
        rmSync(projectionRoot, { recursive: true, force: true });
        throw new CredentialProjectionError("projection_layout_invalid");
      }
    }

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(new TextEncoder().encode(payload));
    const sha256 = hasher.digest("hex");

    const projection: CredentialProjection = {
      projectionId: `cred-${randomUUID()}`,
      kind,
      syntheticHome: projectionRoot,
      syntheticConfigHome: claudeDir,
      syntheticTmp,
      env: {
        HOME: projectionRoot,
        TMPDIR: syntheticTmp,
      },
      files: [{ path: credentialsFile, mode: 0o600, sha256 }],
      destroy: async () => {
        rmSync(projectionRoot, { recursive: true, force: true });
      },
    };
    return projection;
  }

  private async readKeychain(service: string): Promise<string> {
    const proc = Bun.spawn(
      [this.securityBinPath, "find-generic-password", "-s", service, "-w"],
      {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error("security lookup failed");
    }
    return stdout.trim();
  }
}
