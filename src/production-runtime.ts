import { homedir } from "node:os";
// Production runtime composition (§2 design): frozen route-keyed bindings admit
// once; MultiProviderRunner acquires a per-step transport lease, delegates
// lifecycle to StepExecutionHarness, and disposes stream/client/server before
// credential projection destroy. Registry caches transports by routeFingerprint.
import type { AttemptAdmissionGate } from "./execution/admission";
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
  type CapabilityGateDecision,
  exactBindingCapabilityGate,
  mergeExactBindingCapabilityReports,
} from "./provider-capabilities";
import {
  type BindingAuthorityResolution,
  prepareProductionRunnerAuthority,
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
  DefaultTransportRegistry,
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
  readonly attemptAdmissionGate?: AttemptAdmissionGate;
  readonly graceMarginMs?: number;
}

export interface ProductionRuntime {
  readonly runner: StepRunner;
  readonly registry: TransportRegistry;
  readonly bindings: ReadonlyMap<string, RuntimeBinding>;
  readonly admitted: AdmittedRoutePlanResult;
  dispose(): Promise<void>;
}

interface ActiveTransportLeaseTracker {
  register(routeKey: string): void;
  /** Returns true when the last active lease for this routeKey was released. */
  unregister(routeKey: string): boolean;
  activeCount(routeKey: string): number;
  releaseAll(registry: { release?(routeFingerprint: string): void }): void;
}

class DefaultActiveTransportLeaseTracker
  implements ActiveTransportLeaseTracker
{
  private readonly refcounts = new Map<string, number>();

  register(routeKey: string): void {
    this.refcounts.set(routeKey, (this.refcounts.get(routeKey) ?? 0) + 1);
  }

  unregister(routeKey: string): boolean {
    const current = this.refcounts.get(routeKey) ?? 0;
    if (current <= 1) {
      this.refcounts.delete(routeKey);
      return true;
    }
    this.refcounts.set(routeKey, current - 1);
    return false;
  }

  activeCount(routeKey: string): number {
    return this.refcounts.get(routeKey) ?? 0;
  }

  releaseAll(registry: { release?(routeFingerprint: string): void }): void {
    for (const routeKey of [...this.refcounts.keys()]) {
      registry.release?.(routeKey);
    }
    this.refcounts.clear();
  }
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
  readonly leaseTracker: ActiveTransportLeaseTracker;
}

function minimalIsolationFromExecutable(
  executable: VerifiedExecutable,
): IsolationProjection {
  return {
    credentialProjectionId: "production-binding",
    env: {},
    syntheticHome: "",
    syntheticConfigHome: "",
    syntheticTmp: "",
    verifiedBinaryPath: executable.verifiedExecutionPath,
  };
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
  private readonly leaseTracker: ActiveTransportLeaseTracker;

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
    this.leaseTracker = options.leaseTracker;
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
    this.leaseTracker.register(routeKey);
    return {
      transport,
      dispose: async () => {
        if (this.leaseTracker.unregister(routeKey)) {
          registry.release?.(routeKey);
        }
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
  leaseTracker: ActiveTransportLeaseTracker,
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
      leaseTracker,
    });
    bindings.set(step.routeFingerprint, binding);
    Object.freeze(binding);
  }

  return bindings;
}

export async function gateBindingsCapabilities(
  bindings: ReadonlyMap<string, RuntimeBinding>,
): Promise<CapabilityGateDecision> {
  for (const binding of bindings.values()) {
    const report = await binding.capabilities();
    const gate = exactBindingCapabilityGate(report);
    if (!gate.ok) {
      return gate;
    }
  }
  return { ok: true };
}

export interface ProbeBindingsReadinessResult {
  readonly decision: CapabilityGateDecision;
  readonly bindings: ReadonlyMap<string, RuntimeBinding>;
  readonly registry: TransportRegistry;
  dispose(): Promise<void>;
}

export async function probeBindingsReadiness(
  options: ProductionRuntimeOptions,
): Promise<ProbeBindingsReadinessResult> {
  const workspaceAuth = authorizeWorkspaceCwd(
    options.workspaceRoot,
    options.workspaceRoot,
  );
  if (!workspaceAuth.approved) {
    throw new ProductionRuntimeError(
      `workspace root denied before binding probe: ${workspaceAuth.reason}`,
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
  const leaseTracker = new DefaultActiveTransportLeaseTracker();
  const bindings = await resolveFrozenBindings(
    plan,
    options,
    registry,
    leaseTracker,
  );
  const decision = await gateBindingsCapabilities(bindings);
  return {
    decision,
    bindings,
    registry,
    dispose: async () => {
      leaseTracker.releaseAll(registry);
    },
  };
}

export async function produceExecutionCapabilityReport(
  options: ProductionRuntimeOptions,
): Promise<ProviderCapabilityReport> {
  const probe = await probeBindingsReadiness(options);
  const reports = await Promise.all(
    [...probe.bindings.values()].map((binding) => binding.capabilities()),
  );
  await probe.dispose();
  return mergeExactBindingCapabilityReports(reports);
}

export function d1_11EvidenceFromExactBinding(
  report: ExactBindingCapabilityReport,
  sdkAvailable = report.sdk.available,
): D1_11ReadinessEvidence {
  return {
    sdkAvailable,
    credentialAuthority:
      report.auth.projectionReady || report.auth.probe === "passed",
    workspaceBroker: report.isolation.workspaceReadBroker,
    pricingReady:
      report.billing.pricingApplicability !== "required" ||
      report.billing.tokenPricingAvailable,
  };
}

export interface ProductionAdmissionContext {
  readonly registry: DefaultTransportRegistry;
  readonly authorityOptions: RunnerAuthorityOptions;
  readonly evidence: Map<RunnerBackend, D1_11ReadinessEvidence>;
}

export async function prepareProductionAdmissionContext(input: {
  readonly workspaceRoot: string;
  readonly plan: ResolvedRoutePlan;
  readonly authorityDeps?: ResolveRunnerAuthorityDeps;
  readonly loadSdk?: () => Promise<
    import("./transports/opencode-client").OpenCodeSdkLike
  >;
  readonly env?: RunnerAuthorityOptions["env"];
}): Promise<ProductionAdmissionContext | { readonly error: string }> {
  const authorityResult = await prepareProductionRunnerAuthority(
    input.workspaceRoot,
    input.plan,
    input.authorityDeps,
    input.env === undefined ? {} : { env: input.env },
  );
  if ("error" in authorityResult) {
    return authorityResult;
  }
  const authorityOptions = authorityResult;

  const probeRegistry = createDefaultTransportRegistry({
    mode: "conformance",
    binaryPath: authorityOptions.binaryPath,
    openCodeBinaryPath: authorityOptions.openCodeBinaryPath,
    env: authorityOptions.env,
    ...(input.loadSdk !== undefined ? { loadSdk: input.loadSdk } : {}),
  });
  const probe = await probeBindingsReadiness({
    ...authorityOptions,
    plan: input.plan,
    workspaceRoot: input.workspaceRoot,
    registry: probeRegistry,
    mode: "conformance",
    authorityDeps: input.authorityDeps,
  });
  if (!probe.decision.ok) {
    await probe.dispose();
    return {
      error: probe.decision.reason ?? "exact-binding readiness gate failed",
    };
  }

  const evidence = new Map<RunnerBackend, D1_11ReadinessEvidence>();
  const needsOpenCode = [...probe.bindings.values()].some(
    (binding) => binding.route.backend === "opencode",
  );
  if (needsOpenCode) {
    if (probeRegistry instanceof DefaultTransportRegistry) {
      try {
        await probeRegistry.probeOpenCodeSdk();
      } catch (error) {
        await probe.dispose();
        const message = error instanceof Error ? error.message : String(error);
        return { error: `OpenCode SDK pre-confirm failed: ${message}` };
      }
    }
    for (const binding of probe.bindings.values()) {
      if (binding.route.backend !== "opencode") continue;
      const report = await binding.capabilities();
      evidence.set("opencode", d1_11EvidenceFromExactBinding(report, true));
    }
  }
  await probe.dispose();

  const registry = createDefaultTransportRegistry({
    mode: "production",
    evidence,
    binaryPath: authorityOptions.binaryPath,
    openCodeBinaryPath: authorityOptions.openCodeBinaryPath,
    env: authorityOptions.env,
    ...(input.loadSdk !== undefined ? { loadSdk: input.loadSdk } : {}),
  }) as DefaultTransportRegistry;

  return { registry, authorityOptions, evidence };
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
  private readonly attemptAdmissionGate?: AttemptAdmissionGate;
  private readonly graceMarginMs?: number;
  private readonly leaseTracker?: ActiveTransportLeaseTracker;

  constructor(options: {
    readonly workspaceRoot: string;
    readonly bindings: ReadonlyMap<string, RuntimeBinding>;
    readonly registry: TransportRegistry;
    readonly defaultBindingKey?: string;
    readonly spawnFn?: typeof Bun.spawn;
    readonly signal?: AbortSignal;
    readonly attemptAdmissionGate?: AttemptAdmissionGate;
    readonly graceMarginMs?: number;
    readonly leaseTracker?: ActiveTransportLeaseTracker;
  }) {
    this.workspaceRoot = options.workspaceRoot;
    this.bindings = options.bindings;
    this.registry = options.registry;
    this.defaultBindingKey = options.defaultBindingKey;
    this.spawnFn = options.spawnFn;
    this.signal = options.signal;
    this.attemptAdmissionGate = options.attemptAdmissionGate;
    this.graceMarginMs = options.graceMarginMs;
    this.leaseTracker = options.leaseTracker;
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

    if (
      binding.route.backend === "opencode" &&
      this.registry instanceof DefaultTransportRegistry &&
      this.registry.needsOpenCodeSdkProbe()
    ) {
      try {
        await this.registry.probeOpenCodeSdk();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          name: step.name,
          status: "failed",
          usage: zeroUsage(),
          attempts: 0,
          stderrTail: `OpenCode SDK pre-confirm failed: ${message}`,
          resultText: "",
        };
      }
    }

    const capabilityReport = await binding.capabilities();
    const capabilityGate = exactBindingCapabilityGate(capabilityReport);
    if (!capabilityGate.ok) {
      return {
        name: step.name,
        status: "failed",
        usage: zeroUsage(),
        attempts: 0,
        stderrTail: `Exact-binding capability gate failed: ${capabilityGate.reason}`,
        resultText: "",
      };
    }

    const isolation = minimalIsolationFromExecutable(binding.executable);
    const lease = await binding.acquire(isolation, this.registry);
    const routeKey = binding.key;
    try {
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
        transport: lease.transport,
        spawnFn: this.spawnFn,
        signal: this.signal,
        ...(this.attemptAdmissionGate !== undefined
          ? { attemptAdmissionGate: this.attemptAdmissionGate }
          : {}),
        rateLimitBucketId: binding.credential.bucketId,
        ...(this.graceMarginMs !== undefined
          ? { graceMarginMs: this.graceMarginMs }
          : {}),
        onBeforeCredentialProjectionDestroy: async () => {
          if ((this.leaseTracker?.activeCount(routeKey) ?? 0) !== 1) {
            return;
          }
          if (
            "dispose" in lease.transport &&
            typeof lease.transport.dispose === "function"
          ) {
            await (lease.transport as { dispose(): Promise<void> }).dispose();
          }
        },
      });

      return await harness.run({
        ...step,
        cwd: cwdAuth.canonicalCwd,
        route: binding.route,
        routeKey: binding.key,
        credentialKind: binding.credential.kind,
        credentialRef: binding.credential.ref,
      });
    } finally {
      await lease.dispose();
    }
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

  const leaseTracker = new DefaultActiveTransportLeaseTracker();
  const bindings = await resolveFrozenBindings(
    plan,
    options,
    registry,
    leaseTracker,
  );
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
    attemptAdmissionGate: options.attemptAdmissionGate,
    graceMarginMs: options.graceMarginMs,
    leaseTracker,
  });

  return {
    runner,
    registry,
    bindings: createImmutableBindingsMap(bindings),
    admitted,
    dispose: async () => {
      leaseTracker.releaseAll(registry);
    },
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
