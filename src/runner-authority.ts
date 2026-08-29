import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { RunnerBackend } from "./execution/contracts";
import type {
  ClaudeBinaryResolutionDeps,
  ExecutableAllowlistEntry,
} from "./provider-capabilities";
import {
  resolveClaudeCanonicalBinary,
  verifyExecutableAuthority,
} from "./provider-capabilities";
import {
  type CredentialBroker,
  KeychainCredentialBroker,
  OpenCodeAuthBroker,
} from "./security/credential-broker";

export interface RunnerAuthorityOptions {
  readonly binaryPath?: string;
  readonly openCodeBinaryPath?: string;
  readonly workspaceRoot: string;
  readonly env?: { PATH?: string };
  readonly credentialBrokers?: Partial<Record<RunnerBackend, CredentialBroker>>;
  /** Independent executable authority — never derived from the candidate binary. */
  readonly executableAllowlists?: Partial<
    Record<RunnerBackend, readonly ExecutableAllowlistEntry[]>
  >;
}

export interface ResolvedRunnerOptions {
  readonly binaryPath: string;
  readonly workspaceRoot: string;
  readonly executableAllowlist: readonly ExecutableAllowlistEntry[];
  readonly credentialBroker?: CredentialBroker;
}

export type RunnerAuthorityResolution =
  | {
      readonly runnerOptions: ResolvedRunnerOptions;
      readonly error?: undefined;
    }
  | { readonly error: string; readonly runnerOptions?: undefined };

export interface ResolveRunnerAuthorityDeps
  extends ClaudeBinaryResolutionDeps {}

export interface ResolvedBindingAuthority {
  readonly backend: RunnerBackend;
  readonly binaryPath: string;
  readonly workspaceRoot: string;
  readonly canonicalCwd: string;
  readonly executableAllowlist: readonly ExecutableAllowlistEntry[];
  readonly credentialKind:
    | "claude_subscription_oauth"
    | "opencode_chatgpt_oauth";
  readonly credentialRef: string;
  readonly credentialBroker?: CredentialBroker;
  readonly bucketId: string;
}

export type BindingAuthorityResolution =
  | { readonly binding: ResolvedBindingAuthority; readonly error?: undefined }
  | { readonly error: string; readonly binding?: undefined };

const OPENCODE_BINARY_NAME = "opencode";

async function resolveOpenCodeCanonicalBinary(
  lookup: {
    readonly binaryPath?: string;
    readonly env?: { PATH?: string };
  },
  deps: ClaudeBinaryResolutionDeps = {},
): Promise<
  | { readonly canonicalPath: string; readonly sha256: string }
  | { readonly error: string }
> {
  const exists = deps.existsFn ?? existsSync;
  const toRealpath = deps.realpathFn ?? realpath;
  const readBytes =
    deps.readFileFn ?? ((p: string) => readFile(p) as Promise<Uint8Array>);

  let candidate: string;
  if (lookup.binaryPath !== undefined) {
    if (!path.isAbsolute(lookup.binaryPath)) {
      return {
        error: `binary override must be an absolute path: ${lookup.binaryPath}`,
      };
    }
    candidate = lookup.binaryPath;
  } else {
    const searchDirs = (lookup.env?.PATH ?? process.env.PATH ?? "")
      .split(path.delimiter)
      .filter((dir) => dir.length > 0);
    candidate = "";
    for (const dir of searchDirs) {
      const probe = path.join(dir, OPENCODE_BINARY_NAME);
      if (exists(probe)) {
        candidate = probe;
        break;
      }
    }
    if (candidate === "") {
      return { error: "opencode binary not found on PATH" };
    }
  }

  try {
    const canonical = await toRealpath(candidate);
    const bytes = await readBytes(canonical);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    return { canonicalPath: canonical, sha256: hasher.digest("hex") };
  } catch (error) {
    return {
      error: `failed to resolve opencode binary ${candidate}: ${(error as Error).message}`,
    };
  }
}

function claudeCredentialBroker(): KeychainCredentialBroker | undefined {
  return process.platform === "darwin" && existsSync("/usr/bin/security")
    ? new KeychainCredentialBroker()
    : undefined;
}

async function verifyConfiguredExecutable(
  backend: RunnerBackend,
  candidatePath: string,
  options: RunnerAuthorityOptions,
  deps: ResolveRunnerAuthorityDeps = {},
): Promise<
  | { readonly allowlist: readonly ExecutableAllowlistEntry[] }
  | { readonly error: string }
> {
  const configuredAllowlist = options.executableAllowlists?.[backend];
  if (configuredAllowlist === undefined || configuredAllowlist.length === 0) {
    return {
      error: `executable allowlist required for ${backend} binding authority`,
    };
  }

  const verification = await verifyExecutableAuthority(
    {
      candidatePath,
      allowlist: configuredAllowlist,
    },
    {
      // Binding resolution already canonicalized the candidate path.
      realpathFn: async (p) => p,
      readFileFn: deps.readFileFn,
      statFn: deps.existsFn
        ? (p) => ({
            mode: deps.existsFn?.(p) ? 0o755 : 0o644,
          })
        : undefined,
    },
  );
  if (!verification.approved) {
    return {
      error:
        verification.reason ??
        `executable ${candidatePath} is not in configured allowlist for ${backend}`,
    };
  }

  return { allowlist: configuredAllowlist };
}

export async function withClaudeDiscoveryAllowlist(
  options: RunnerAuthorityOptions,
  deps: ResolveRunnerAuthorityDeps = {},
): Promise<RunnerAuthorityOptions | { readonly error: string }> {
  const configured = options.executableAllowlists?.["claude-code"];
  if (configured !== undefined && configured.length > 0) {
    return options;
  }

  const resolved = await resolveClaudeCanonicalBinary(options, deps);
  if (resolved.error !== undefined) {
    return { error: resolved.error };
  }

  return {
    ...options,
    executableAllowlists: {
      ...options.executableAllowlists,
      "claude-code": [
        { absolutePath: resolved.canonicalPath, sha256: resolved.sha256 },
      ],
    },
  };
}

export async function resolveBindingAuthority(
  backend: RunnerBackend,
  options: RunnerAuthorityOptions,
  deps: ResolveRunnerAuthorityDeps = {},
): Promise<BindingAuthorityResolution> {
  if (backend === "claude-code") {
    const resolved = await resolveClaudeCanonicalBinary(options, deps);
    if (resolved.error !== undefined) {
      return { error: resolved.error };
    }
    const verified = await verifyConfiguredExecutable(
      backend,
      resolved.canonicalPath,
      options,
      deps,
    );
    if ("error" in verified) {
      return { error: verified.error };
    }
    const broker = claudeCredentialBroker();
    return {
      binding: {
        backend,
        binaryPath: resolved.canonicalPath,
        workspaceRoot: options.workspaceRoot,
        canonicalCwd: options.workspaceRoot,
        executableAllowlist: verified.allowlist,
        credentialKind: "claude_subscription_oauth",
        credentialRef: "claude-code-credentials",
        ...(broker ? { credentialBroker: broker } : {}),
        bucketId: "claude-code",
      },
    };
  }

  if (backend === "opencode") {
    const resolved = await resolveOpenCodeCanonicalBinary(
      {
        binaryPath: options.openCodeBinaryPath ?? options.binaryPath,
        env: options.env,
      },
      deps,
    );
    if ("error" in resolved) {
      return { error: resolved.error };
    }
    const verified = await verifyConfiguredExecutable(
      backend,
      resolved.canonicalPath,
      options,
      deps,
    );
    if ("error" in verified) {
      return { error: verified.error };
    }
    return {
      binding: {
        backend,
        binaryPath: resolved.canonicalPath,
        workspaceRoot: options.workspaceRoot,
        canonicalCwd: options.workspaceRoot,
        executableAllowlist: verified.allowlist,
        credentialKind: "opencode_chatgpt_oauth",
        credentialRef: "opencode-auth",
        credentialBroker:
          options.credentialBrokers?.opencode ?? new OpenCodeAuthBroker(),
        bucketId: "opencode",
      },
    };
  }

  return {
    error: `unsupported production backend "${backend}" in PR1`,
  };
}

export async function resolveRunnerAuthority(
  options: RunnerAuthorityOptions,
  deps: ResolveRunnerAuthorityDeps = {},
): Promise<RunnerAuthorityResolution> {
  const resolvedOptions = await withClaudeDiscoveryAllowlist(options, deps);
  if ("error" in resolvedOptions) {
    return { error: resolvedOptions.error };
  }

  const result = await resolveBindingAuthority(
    "claude-code",
    resolvedOptions,
    deps,
  );
  if (result.error !== undefined || result.binding === undefined) {
    return { error: result.error ?? "claude binding unavailable" };
  }
  const binding = result.binding;
  return {
    runnerOptions: {
      binaryPath: binding.binaryPath,
      workspaceRoot: binding.workspaceRoot,
      executableAllowlist: binding.executableAllowlist,
      ...(binding.credentialBroker
        ? { credentialBroker: binding.credentialBroker }
        : {}),
    },
  };
}
