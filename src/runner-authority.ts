import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { CredentialKind, RunnerBackend } from "./execution/contracts";
import type { ResolvedRoutePlan } from "./model-routing";
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
  OPENCODE_OAUTH_PROVIDER,
  OpenCodeApiTokenBroker,
  OpenCodeAuthBroker,
  OpenCodeFreeBroker,
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
  // #133: the full CredentialKind. This field used to re-declare a NARROWER
  // union of its own, which was the single compile-time reason a metered
  // provider route could not be bound — everything downstream (the harness,
  // the projection, the capability report) already spoke the full type.
  readonly credentialKind: CredentialKind;
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
      statFn: deps.statFn,
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

export async function withOpenCodeDiscoveryAllowlist(
  options: RunnerAuthorityOptions,
  deps: ResolveRunnerAuthorityDeps = {},
): Promise<RunnerAuthorityOptions | { readonly error: string }> {
  const configured = options.executableAllowlists?.opencode;
  if (configured !== undefined && configured.length > 0) {
    return options;
  }

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

  return {
    ...options,
    openCodeBinaryPath: resolved.canonicalPath,
    executableAllowlists: {
      ...options.executableAllowlists,
      opencode: [
        { absolutePath: resolved.canonicalPath, sha256: resolved.sha256 },
      ],
    },
  };
}

function planUsesBackend(
  plan: ResolvedRoutePlan,
  backend: RunnerBackend,
): boolean {
  const seen = new Set<RunnerBackend>();
  for (const step of plan.steps) {
    if (!seen.has(step.route.backend)) {
      seen.add(step.route.backend);
      if (step.route.backend === backend) {
        return true;
      }
    }
  }
  return false;
}

// Resolves independent executable allowlists for every backend the frozen
// plan would execute. Claude discovery stays the default; OpenCode is added
// only when the plan names it — never as a fallback.
export async function prepareProductionRunnerAuthority(
  workspaceRoot: string,
  plan: ResolvedRoutePlan,
  deps: ResolveRunnerAuthorityDeps = {},
  seed: Partial<RunnerAuthorityOptions> = {},
): Promise<RunnerAuthorityOptions | { readonly error: string }> {
  let options: RunnerAuthorityOptions = { workspaceRoot, ...seed };
  if (planUsesBackend(plan, "claude-code")) {
    const withClaude = await withClaudeDiscoveryAllowlist(options, deps);
    if ("error" in withClaude) {
      return withClaude;
    }
    options = withClaude;
  }

  if (!planUsesBackend(plan, "opencode")) {
    return options;
  }

  const withOpenCode = await withOpenCodeDiscoveryAllowlist(options, deps);
  if ("error" in withOpenCode) {
    return withOpenCode;
  }
  return withOpenCode;
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

// #133. WHICH credential a route runs on, decided from the backend AND the
// provider. Backend alone is not enough: OpenCode serves exactly one provider
// from a subscription (OPENCODE_OAUTH_PROVIDER) and everything else from a
// metered API token, and those are different credentials with different
// billing, different projection payloads and different rate-limit buckets.
//
// This is deliberately PROVIDER-KEYED and deliberately does NOT read the
// credential store. The bounded, known limit that buys: an `openai` entry
// holding an API key rather than an OAuth record still resolves to
// `opencode_chatgpt_oauth` here, and is then refused by the OAuth broker's
// existing `type !== "oauth"` lock (credential-broker.ts). That is a loud
// failure with a one-line fix, not a silent metered run. Reading the store
// here to disambiguate would put a credential read inside a pure routing
// decision, and would make the answer depend on machine state the frozen
// plan cannot record.
//
// WHY the default is `provider_api_token` rather than the subscription kind:
// metered is the FAIL-CLOSED direction. A metered route with no pricing is
// refused at the exact-binding gate (`pricing_table_missing`, blocking), so
// the cost of guessing metered is a refusal. A route wrongly marked
// subscription EXECUTES and reports `cashCostUsd: 0` over real spend — the
// cost of guessing subscription is an unmetered bill nobody sees.
export function credentialKindForRoute(
  backend: RunnerBackend,
  provider: string,
): CredentialKind {
  if (backend === "claude-code") {
    return "claude_subscription_oauth";
  }
  if (backend === "opencode") {
    return provider === OPENCODE_OAUTH_PROVIDER
      ? "opencode_chatgpt_oauth"
      : "provider_api_token";
  }
  // Exhaustive on purpose: a backend with no credential authority must not
  // fall into the metered default by accident. It has no binding at all —
  // resolveBindingAuthority refuses it a few lines below — and inventing a
  // kind for it here would make that refusal look like a pricing problem.
  throw new Error(`No credential authority is bound for backend "${backend}"`);
}

// 2026-09-02. THE one place that says "a provider API token is a metered
// credential". Two callers need it and they must not each carry their own
// copy: `FrozenRuntimeBinding.capabilities()` derives the exact binding's
// effective billing mode from it (#133), and the OpenCode transport factory
// derives the billing mode STAMPED ON EVERY USAGE RECORD from it
// (transport-registry.ts). Two copies would be two chances for the capability
// report and the usage records to disagree about how one attempt bills — and
// the metered-zero rule in `settlementFromUsage` reads the usage record, so
// the disagreement would be silently exploitable rather than merely untidy.
//
// A boolean, not a mode: the binding's rule is UPGRADE-ONLY (an OAuth or
// subscription kind keeps whatever the transport reported, `unknown`
// included), and returning a mode here would invite a caller to overwrite
// that instead of asking the question this answers.
export function credentialKindBillsMetered(kind: CredentialKind): boolean {
  return kind === "provider_api_token";
}

// The DEFAULT broker for an opencode route, derived from the same provider
// that decided the kind. Exported because production-runtime.ts resolves the
// plan's one shared broker (#149 keeps it a single instance) and must reach
// the same answer: two copies of this pairing would be two chances to hand a
// route a broker that refuses its kind — a failure that surfaces only at
// projection time, inside a live run.
//
// #182: kind-based selection — the single derivation (the #149 anti-drift
// rule). Callers that already resolved the kind pass it here and never derive
// it twice; `openCodeCredentialBroker` below is the thin wrapper for callers
// holding only a provider.
export function openCodeCredentialBrokerForKind(
  kind: CredentialKind,
  provider: string,
): CredentialBroker {
  if (kind === "provider_free") {
    return new OpenCodeFreeBroker();
  }
  if (kind === "provider_api_token") {
    return new OpenCodeApiTokenBroker(provider);
  }
  return new OpenCodeAuthBroker();
}

export function openCodeCredentialBroker(provider: string): CredentialBroker {
  return openCodeCredentialBrokerForKind(
    credentialKindForRoute("opencode", provider),
    provider,
  );
}

export async function resolveBindingAuthority(
  backend: RunnerBackend,
  // Required, not optional: an optional provider would default silently at
  // every call site, and a silent default here picks the BILLING MODE. tsc
  // finding all five call sites is the point — `bun test` would not.
  provider: string,
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
    const broker =
      options.credentialBrokers?.["claude-code"] ?? claudeCredentialBroker();
    return {
      binding: {
        backend,
        binaryPath: resolved.canonicalPath,
        workspaceRoot: options.workspaceRoot,
        canonicalCwd: options.workspaceRoot,
        executableAllowlist: verified.allowlist,
        credentialKind: credentialKindForRoute(backend, provider),
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
    const credentialKind = credentialKindForRoute(backend, provider);
    return {
      binding: {
        backend,
        binaryPath: resolved.canonicalPath,
        workspaceRoot: options.workspaceRoot,
        canonicalCwd: options.workspaceRoot,
        executableAllowlist: verified.allowlist,
        credentialKind,
        // #133: per-PROVIDER, because two providers on this one backend are
        // two different credentials. `credentialRef` is half of
        // `credentialFingerprint` (production-runtime.ts), which is what
        // separates rate-limit buckets — a shared ref would pool an OAuth
        // subscription's quota and a metered token's quota into one bucket
        // and make both wrong.
        credentialRef: `opencode-auth:${provider}`,
        credentialBroker:
          options.credentialBrokers?.opencode ??
          // #182: the kind above, not a second derivation — deriving again
          // here is how the broker and the kind drift apart unobserved.
          openCodeCredentialBrokerForKind(credentialKind, provider),
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
    // The CLI-compatibility path is Claude-only by construction, and
    // credentialKindForRoute ignores the provider for that backend.
    "anthropic",
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
