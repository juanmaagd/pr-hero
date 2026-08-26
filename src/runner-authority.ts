import { existsSync } from "node:fs";
import type { ExecutableAllowlistEntry } from "./provider-capabilities";
import {
  type ClaudeBinaryResolutionDeps,
  resolveClaudeCanonicalBinary,
} from "./provider-capabilities";
import { KeychainCredentialBroker } from "./security/credential-broker";

export interface RunnerAuthorityOptions {
  readonly binaryPath?: string;
  readonly workspaceRoot: string;
  readonly env?: { PATH?: string };
}

export interface ResolvedRunnerOptions {
  readonly binaryPath: string;
  readonly workspaceRoot: string;
  readonly executableAllowlist: readonly ExecutableAllowlistEntry[];
}

export type RunnerAuthorityResolution =
  | {
      readonly runnerOptions: ResolvedRunnerOptions;
      readonly error?: undefined;
    }
  | { readonly error: string; readonly runnerOptions?: undefined };

export interface ResolveRunnerAuthorityDeps
  extends ClaudeBinaryResolutionDeps {}

export async function resolveRunnerAuthority(
  options: RunnerAuthorityOptions,
  deps: ResolveRunnerAuthorityDeps = {},
): Promise<RunnerAuthorityResolution> {
  // §13: the same verified absolute binary preflight reports on is the one
  // execution runs — resolution lives in ONE shared helper.
  const resolved = await resolveClaudeCanonicalBinary(options, deps);
  if (resolved.error !== undefined) {
    return { error: resolved.error };
  }
  const canonical = resolved.canonicalPath;
  const sha256 = resolved.sha256;
  // §6.1: on macOS the subscription OAuth record lives in the Keychain, so
  // production projects it into an ephemeral 0700/0600 synthetic home
  // instead of handing the child the real HOME. Elsewhere (Linux CI reads a
  // plain credentials file) there is nothing to project yet — the broker is
  // omitted and the enumerated-passthrough env applies.
  const credentialBroker =
    process.platform === "darwin" && existsSync("/usr/bin/security")
      ? new KeychainCredentialBroker()
      : undefined;
  return {
    runnerOptions: {
      binaryPath: canonical,
      workspaceRoot: options.workspaceRoot,
      executableAllowlist: [{ absolutePath: canonical, sha256 }],
      ...(credentialBroker ? { credentialBroker } : {}),
    },
  };
}
