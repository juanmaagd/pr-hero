import { homedir } from "node:os";
import { deriveBucketId, loadOrCreateBucketKey } from "./execution/bucket-id";
import type {
  EnvironmentPolicy,
  ExactBindingCapabilityReport,
  IsolationProjection,
  ProviderTransport,
  ResolvedModelRoute,
  RunnerBackend,
  RuntimeBinding,
  RuntimeBindingCredential,
  TransportLease,
  VerifiedExecutable,
} from "./execution/contracts";
import { StepExecutionHarness } from "./execution/harness";
import type { ResolvedRoutePlan, ResolvedStepRoute } from "./model-routing";
import { freezeRoutePlan } from "./model-routing";
import type { ProviderCapabilityReport } from "./provider-capabilities";
import {
  type BindingAuthorityResolution,
  type ResolvedBindingAuthority,
  type ResolveRunnerAuthorityDeps,
  type RunnerAuthorityOptions,
  resolveBindingAuthority,
  withClaudeDiscoveryAllowlist,
} from "./runner-authority";
import {
  validateBindingAdmission,
  validateRouteDrift,
} from "./security/binding-policy";
import { authorizeWorkspaceCwd } from "./security/execution-authority";
import {
  ClaudeCodeRunner,
  type StepResult,
  type StepRunner,
  type StepSpec,
} from "./step-runner";
import {
  type AdmitRoutePlanOptions,
  type AdmittedRoutePlanResult,
  admitRoutePlan,
  createDefaultTransportRegistry,
  type D1_11ReadinessEvidence,
  type TransportFactoryOptions,
  type TransportRegistry,
} from "./transport-registry";
import { zeroUsage } from "./usage";

export class ProductionRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionRuntimeError";
  }
}

export interface ProductionRuntimeOptions extends RunnerAuthorityOptions {
  readonly plan: ResolvedRoutePlan;
  readonly registry?: TransportRegistry;
  readonly mode?: AdmitRoutePlanOptions["mode"];
  readonly evidence?: Map<RunnerBackend, D1_11ReadinessEvidence>;
  readonly authorityDeps?: ResolveRunnerAuthorityDeps;
  readonly spawnFn?: typeof Bun.spawn;
  readonly signal?: AbortSignal;
}

export interface ProductionRuntime {
  readonly runner: StepRunner;
  readonly registry: TransportRegistry;
  readonly bindings: ReadonlyMap<string, RuntimeBinding>;
  readonly admitted: AdmittedRoutePlanResult;
  dispose(): Promise<void>;
}

interface FrozenRuntimeBindingOptions {
  readonly key: string;
  readonly route: ResolvedModelRoute;
  readonly authority: ResolvedBindingAuthority;
  readonly executable: VerifiedExecutable;
  readonly credential: RuntimeBindingCredential;
  readonly getCapabilityReport: (
    backend: RunnerBackend,
  ) => Promise<ProviderCapabilityReport>;
}

class FrozenRuntimeBinding implements RuntimeBinding {
  readonly key: string;
  readonly route: ResolvedModelRoute;
  readonly executable: VerifiedExecutable;
  readonly credential: RuntimeBindingCredential;
  readonly environment: EnvironmentPolicy;
  readonly tools = Object.freeze({
    allowMapOnly: true,
    deniedTools: Object.freeze(["bash", "Write", "Edit", "Task"]),
  });
  readonly mcp = Object.freeze({
    codegraphOnly: true,
    verifiedConfigRequired: true,
  });

  private readonly authority: ResolvedBindingAuthority;
  private readonly getCapabilityReport: (
    backend: RunnerBackend,
  ) => Promise<ProviderCapabilityReport>;

  constructor(options: FrozenRuntimeBindingOptions) {
    this.key = options.key;
    this.route = Object.freeze({ ...options.route });
    this.executable = Object.freeze({ ...options.executable });
    this.credential = Object.freeze({ ...options.credential });
    this.environment = Object.freeze({
      syntheticHome: options.credential.broker !== undefined,
      workspaceReadBroker: true,
    });
    this.authority = options.authority;
    this.getCapabilityReport = options.getCapabilityReport;
    Object.freeze(this);
  }

  async capabilities(): Promise<ExactBindingCapabilityReport> {
    const report = await this.getCapabilityReport(this.route.backend);
    const projectionBrokered = this.credential.broker !== undefined;
    const sdkAvailable =
      this.route.backend === "claude-code" ||
      !report.issues.some(
        (issue) => issue.code === "real_sdk_adapter_deferred_to_d1_11",
      );
    const pricingApplicable =
      report.billing.mode === "metered" ? "required" : "not_applicable";
    const billingMode: ExactBindingCapabilityReport["billing"]["mode"] =
      report.billing.mode === "metered" ? "metered" : "subscription";
    return {
      routeKey: this.key,
      backend: this.route.backend,
      sdk: { available: sdkAvailable },
      binary: {
        resolved: true,
        absolutePath: this.executable.absolutePath,
        sha256: this.executable.sha256,
      },
      auth: {
        kind: this.credential.kind,
        projectionReady: projectionBrokered,
        probe: projectionBrokered ? report.auth.probe : "not_run",
      },
      environment: {
        syntheticHome: projectionBrokered,
        enumeratedPassthrough: !projectionBrokered,
      },
      isolation: {
        workspaceReadBroker: report.isolation.workspaceReadBroker,
        codegraphPolicy: report.isolation.codegraphPolicy,
      },
      toolsMcp: {
        allowMapEnforced: this.tools.allowMapOnly,
        mcpIntegrityChecked: this.mcp.verifiedConfigRequired,
      },
      protocol: {
        terminalProof: report.protocol.terminalProof,
        boundedEvents: report.protocol.boundedEvents,
        usageMode: report.protocol.usageMode,
      },
      usage: { normalized: true },
      billing: {
        mode: billingMode,
        pricingApplicability: pricingApplicable,
        tokenPricingAvailable: report.billing.pricingReady,
        cashCostAccountingValid: billingMode === "subscription",
      },
    };
  }

  async acquire(
    _isolation: IsolationProjection,
    registry: {
      get(
        backend: RunnerBackend,
        options?: TransportFactoryOptions,
      ): ProviderTransport;
      release?(routeFingerprint: string): void;
    },
  ): Promise<TransportLease> {
    const transport = registry.get(this.route.backend, {
      routeFingerprint: this.key,
      route: this.route,
    });
    const routeKey = this.key;
    return {
      transport,
      dispose: async () => {
        registry.release?.(routeKey);
      },
    };
  }
}

function toVerifiedExecutable(
  authority: ResolvedBindingAuthority,
): VerifiedExecutable {
  const entry = authority.executableAllowlist[0];
  return {
    absolutePath: entry.absolutePath,
    sha256: entry.sha256,
    verifiedExecutionPath: authority.binaryPath,
  };
}

function uniqueRoutesByFingerprint(
  plan: ResolvedRoutePlan,
): readonly ResolvedStepRoute[] {
  const seen = new Map<string, ResolvedStepRoute>();
  for (const step of plan.steps) {
    if (!seen.has(step.routeFingerprint)) {
      seen.set(step.routeFingerprint, step);
    }
  }
  return [...seen.values()];
}

function bindingBucketId(
  authority: ResolvedBindingAuthority,
  route: ResolvedModelRoute,
): string {
  const localKey = loadOrCreateBucketKey(homedir());
  return deriveBucketId(
    {
      provider: route.provider,
      credentialFingerprint: `${authority.credentialKind}:${authority.credentialRef}`,
    },
    localKey,
  );
}

async function resolveFrozenBindings(
  plan: ResolvedRoutePlan,
  options: ProductionRuntimeOptions,
  registry: TransportRegistry,
): Promise<Map<string, RuntimeBinding>> {
  const bindings = new Map<string, RuntimeBinding>();
  const deps = options.authorityDeps ?? {};

  for (const step of uniqueRoutesByFingerprint(plan)) {
    const authorityResult = await resolveBindingAuthority(
      step.route.backend,
      options,
      deps,
    );
    if (
      authorityResult.error !== undefined ||
      authorityResult.binding === undefined
    ) {
      throw new ProductionRuntimeError(
        `binding authority unavailable for route ${step.routeFingerprint}: ${authorityResult.error}`,
      );
    }

    const authority = authorityResult.binding;
    const executable = toVerifiedExecutable(authority);
    const binding = new FrozenRuntimeBinding({
      key: step.routeFingerprint,
      route: step.route,
      authority,
      executable,
      credential: {
        kind: authority.credentialKind,
        ref: authority.credentialRef,
        ...(authority.credentialBroker
          ? { broker: authority.credentialBroker }
          : {}),
        bucketId: bindingBucketId(authority, step.route),
      },
      getCapabilityReport: (backend) =>
        registry.getCapabilityReport(backend, {
          mode: options.mode,
          evidence: options.evidence,
          binaryPath: authority.binaryPath,
        }),
    });
    bindings.set(step.routeFingerprint, binding);
    Object.freeze(binding);
  }

  return bindings;
}

function createImmutableBindingsMap(
  bindings: Map<string, RuntimeBinding>,
): ReadonlyMap<string, RuntimeBinding> {
  const frozen = new Map(bindings);
  return new Proxy(frozen, {
    get(target, prop) {
      if (prop === "set" || prop === "delete" || prop === "clear") {
        return () => {
          throw new ProductionRuntimeError("runtime bindings are immutable");
        };
      }
      const value = Reflect.get(target, prop);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as ReadonlyMap<string, RuntimeBinding>;
}

export class MultiProviderRunner implements StepRunner {
  private readonly workspaceRoot: string;
  private readonly bindings: ReadonlyMap<string, RuntimeBinding>;
  private readonly registry: TransportRegistry;
  private readonly defaultBindingKey?: string;
  private readonly spawnFn?: typeof Bun.spawn;
  private readonly signal?: AbortSignal;

  constructor(options: {
    readonly workspaceRoot: string;
    readonly bindings: ReadonlyMap<string, RuntimeBinding>;
    readonly registry: TransportRegistry;
    readonly defaultBindingKey?: string;
    readonly spawnFn?: typeof Bun.spawn;
    readonly signal?: AbortSignal;
  }) {
    this.workspaceRoot = options.workspaceRoot;
    this.bindings = options.bindings;
    this.registry = options.registry;
    this.defaultBindingKey = options.defaultBindingKey;
    this.spawnFn = options.spawnFn;
    this.signal = options.signal;
  }

  resolveBinding(step: StepSpec): RuntimeBinding | undefined {
    if (step.routeKey !== undefined) {
      return this.bindings.get(step.routeKey);
    }
    if (step.route !== undefined) {
      for (const binding of this.bindings.values()) {
        if (
          binding.route.backend === step.route.backend &&
          binding.route.provider === step.route.provider &&
          binding.route.modelFamily === step.route.modelFamily &&
          binding.route.modelSnapshot === step.route.modelSnapshot &&
          binding.route.modelVariant === step.route.modelVariant &&
          (binding.route.gateway ?? "") === (step.route.gateway ?? "")
        ) {
          return binding;
        }
      }
      return undefined;
    }
    if (this.defaultBindingKey !== undefined) {
      return this.bindings.get(this.defaultBindingKey);
    }
    if (this.bindings.size === 1) {
      return [...this.bindings.values()][0];
    }
    return undefined;
  }

  async run(step: StepSpec): Promise<StepResult> {
    const binding = this.resolveBinding(step);
    if (binding === undefined) {
      return {
        name: step.name,
        status: "failed",
        usage: zeroUsage(),
        attempts: 0,
        stderrTail:
          step.routeKey !== undefined
            ? `No admitted binding for routeKey ${step.routeKey}`
            : "No admitted binding for step route",
        resultText: "",
      };
    }

    const cwdAuth = authorizeWorkspaceCwd(this.workspaceRoot, step.cwd);
    if (!cwdAuth.approved) {
      return {
        name: step.name,
        status: "failed",
        denialCode: "path_not_approved",
        usage: zeroUsage(),
        attempts: 0,
        stderrTail: `Workspace denied: ${cwdAuth.reason}`,
        resultText: "",
      };
    }

    if (step.routeKey !== undefined && step.route !== undefined) {
      const driftError = validateRouteDrift(binding.route, step.route);
      if (driftError !== undefined) {
        return {
          name: step.name,
          status: "failed",
          usage: zeroUsage(),
          attempts: 0,
          stderrTail: driftError,
          resultText: "",
        };
      }
    }

    const policyError = await validateBindingAdmission(step, binding);
    if (policyError !== undefined) {
      return {
        name: step.name,
        status: "failed",
        usage: zeroUsage(),
        attempts: 0,
        stderrTail: policyError,
        resultText: "",
      };
    }

    const harness = new StepExecutionHarness({
      workspaceRoot: this.workspaceRoot,
      executableAllowlist: [
        {
          absolutePath: binding.executable.absolutePath,
          sha256: binding.executable.sha256,
        },
      ],
      binaryPath: binding.executable.absolutePath,
      credentialBroker: binding.credential.broker,
      registry: this.registry,
      spawnFn: this.spawnFn,
      signal: this.signal,
    });

    return harness.run({
      ...step,
      cwd: cwdAuth.canonicalCwd,
      route: binding.route,
      routeKey: binding.key,
      credentialKind: binding.credential.kind,
      credentialRef: binding.credential.ref,
    });
  }
}

export async function createProductionRuntime(
  options: ProductionRuntimeOptions,
): Promise<ProductionRuntime> {
  const workspaceAuth = authorizeWorkspaceCwd(
    options.workspaceRoot,
    options.workspaceRoot,
  );
  if (!workspaceAuth.approved) {
    throw new ProductionRuntimeError(
      `workspace root denied before admission: ${workspaceAuth.reason}`,
    );
  }

  const plan = freezeRoutePlan(options.plan);
  const registry =
    options.registry ??
    createDefaultTransportRegistry({
      mode: options.mode,
      evidence: options.evidence,
      binaryPath: options.binaryPath,
      env: options.env,
    });

  const bindings = await resolveFrozenBindings(plan, options, registry);
  const admitted = await admitRoutePlan(plan, registry, {
    mode: options.mode,
    evidence: options.evidence,
  });

  const defaultClaude = [...bindings.values()].find(
    (binding) => binding.route.backend === "claude-code",
  );
  const runnerBindings = createImmutableBindingsMap(bindings);
  const runner = new MultiProviderRunner({
    workspaceRoot: options.workspaceRoot,
    bindings: runnerBindings,
    registry,
    defaultBindingKey: defaultClaude?.key,
    spawnFn: options.spawnFn,
    signal: options.signal,
  });

  return {
    runner,
    registry,
    bindings: createImmutableBindingsMap(bindings),
    admitted,
    dispose: async () => {},
  };
}

export function createClaudeCompatibilityRunner(
  options: RunnerAuthorityOptions,
  deps: ResolveRunnerAuthorityDeps = {},
): Promise<StepRunner> {
  return withClaudeDiscoveryAllowlist(options, deps).then((resolvedOptions) => {
    if ("error" in resolvedOptions) {
      throw new ProductionRuntimeError(resolvedOptions.error);
    }
    return resolveBindingAuthority("claude-code", resolvedOptions, deps).then(
      (result) => {
        if (result.error !== undefined || result.binding === undefined) {
          throw new ProductionRuntimeError(
            result.error ?? "claude authority unavailable",
          );
        }
        const binding = result.binding;
        return new ClaudeCodeRunner({
          workspaceRoot: binding.workspaceRoot,
          binaryPath: binding.binaryPath,
          executableAllowlist: binding.executableAllowlist,
          ...(binding.credentialBroker
            ? { credentialBroker: binding.credentialBroker }
            : {}),
        });
      },
    );
  });
}

export type { BindingAuthorityResolution, ResolvedBindingAuthority };
