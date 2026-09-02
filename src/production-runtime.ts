import { homedir } from "node:os";
// Production runtime composition (§2 design): frozen route-keyed bindings admit
// once; MultiProviderRunner acquires a per-step transport lease, delegates
// lifecycle to StepExecutionHarness, and disposes stream/client/server before
// credential projection destroy. Registry caches transports by routeFingerprint.
import type { AttemptAdmissionGate } from "./execution/admission";
import { deriveBucketId, loadOrCreateBucketKey } from "./execution/bucket-id";
import type {
  CredentialKind,
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
import {
  InMemorySpendLedger,
  type SpendLedger,
} from "./execution/spend-limiter";
import type {
  ResolvedRoutePlan,
  ResolvedStepRoute,
  RoutingConfig,
} from "./model-routing";
import { buildResolvedRoutePlan, freezeRoutePlan } from "./model-routing";
import { tokenPricingAvailableFor } from "./pricing-catalog";
import type { ProviderCapabilityReport } from "./provider-capabilities";
import {
  type CapabilityGateDecision,
  exactBindingCapabilityGate,
} from "./provider-capabilities";
import {
  type BindingAuthorityResolution,
  credentialKindBillsMetered,
  credentialKindForRoute,
  openCodeCredentialBroker,
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
import { OPENCODE_OAUTH_PROVIDER } from "./security/credential-broker";
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
  // #137: the clock the bundled pricing catalogues' freshness is judged
  // against, forwarded to every binding. A seam and not `new Date()` inline
  // for the same reason doctor.ts has one: a test proving a fresh table
  // prices a route would otherwise turn red on the calendar day the shipped
  // table for THAT route's provider crosses PRICING_MAX_AGE_DAYS, with no
  // commit behind it. Each provider's table expires on its own stamp, so a
  // test must anchor its clock on the catalogue its route actually reads.
  readonly now?: () => Date;
}

export interface ProductionRuntime {
  readonly runner: StepRunner;
  readonly registry: TransportRegistry;
  readonly bindings: ReadonlyMap<string, RuntimeBinding>;
  readonly admitted: AdmittedRoutePlanResult;
  // The D1-11 evidence this runtime was admitted with, echoed back verbatim.
  // admitRoutePlan reads evidence ONLY from its own options and never from the
  // registry, so a later admission (the pipeline's pre-confirm gate) has no way
  // to recover it from `registry` alone — it has to be carried.
  readonly evidence?: Map<RunnerBackend, D1_11ReadinessEvidence>;
  dispose(): Promise<void>;
}

interface ActiveTransportLeaseTracker {
  register(routeKey: string): void;
  /** Returns true when the last active lease for this routeKey was released. */
  unregister(routeKey: string): boolean;
  activeCount(routeKey: string): number;
  teardownTransportIfLast(input: {
    routeKey: string;
    transport: ProviderTransport;
  }): Promise<void>;
  endLease(input: {
    routeKey: string;
    registry: { release?(routeFingerprint: string): void };
  }): Promise<void>;
  releaseAll(registry: { release?(routeFingerprint: string): void }): void;
}

class DefaultActiveTransportLeaseTracker
  implements ActiveTransportLeaseTracker
{
  private readonly refcounts = new Map<string, number>();
  private readonly gates = new Map<string, Promise<void>>();

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

  async teardownTransportIfLast(input: {
    routeKey: string;
    transport: ProviderTransport;
  }): Promise<void> {
    await this.exclusive(input.routeKey, async () => {
      if (this.activeCount(input.routeKey) !== 1) {
        return;
      }
      if (
        "dispose" in input.transport &&
        typeof input.transport.dispose === "function"
      ) {
        await (input.transport as { dispose(): Promise<void> }).dispose();
      }
    });
  }

  async endLease(input: {
    routeKey: string;
    registry: { release?(routeFingerprint: string): void };
  }): Promise<void> {
    await this.exclusive(input.routeKey, async () => {
      if (this.unregister(input.routeKey)) {
        input.registry.release?.(input.routeKey);
      }
    });
  }

  releaseAll(registry: { release?(routeFingerprint: string): void }): void {
    for (const routeKey of [...this.refcounts.keys()]) {
      registry.release?.(routeKey);
    }
    this.refcounts.clear();
  }

  private async exclusive<T>(
    routeKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.gates.get(routeKey) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    this.gates.set(
      routeKey,
      previous.then(() => gate),
    );
    await previous;
    try {
      return await fn();
    } finally {
      releaseGate();
    }
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
  readonly now?: () => Date;
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
  private readonly now: () => Date;

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
    // Resolved into a field BEFORE Object.freeze(this), like every other
    // injected dependency here — the instance is frozen, so a clock added
    // after this line could never be assigned.
    this.now = options.now ?? (() => new Date());
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
    // #133. ONE effective billing mode, computed once and fed to all THREE
    // readers below (`pricingApplicable`, `billingMode`,
    // `cashCostAccountingValid`). They used to read `report.billing.mode`
    // independently, and that is precisely the trap: upgrading only
    // `billingMode` would leave `pricingApplicability` at "not_applicable",
    // the pricing gate would never fire, and a metered route would be
    // admitted as priced-not-required — executing on real spend while
    // reporting `cashCostUsd: 0`. Under-reporting is the failure this whole
    // issue exists to prevent, so the correction has to be applied ONCE,
    // upstream of every consumer, not per-expression.
    //
    // The legacy backend-wide report cannot know this: it is produced before
    // any route resolves, so it cannot see the provider. The credential KIND
    // can — `provider_api_token` IS a metered API token by definition
    // (runner-authority.ts credentialKindForRoute).
    //
    // 2026-09-02: that "by definition" moved into `credentialKindBillsMetered`
    // rather than staying an inline comparison, because a SECOND caller
    // appeared — the OpenCode transport factory, which stamps the same
    // billing mode onto every usage record so the report and the records
    // cannot disagree about one attempt. Two copies of the rule would be two
    // chances for exactly that disagreement.
    //
    // UPGRADE ONLY, never downgrade. An OAuth or subscription kind keeps
    // whatever the transport reported, `unknown` included — which is what
    // keeps the narrowing guarantee below true for every other kind.
    const effectiveBillingMode: ProviderCapabilityReport["billing"]["mode"] =
      credentialKindBillsMetered(this.credential.kind)
        ? "metered"
        : report.billing.mode;
    const pricingApplicable =
      effectiveBillingMode === "metered" ? "required" : "not_applicable";
    // The legacy report carries THREE billing modes (subscription | metered |
    // unknown) and the exact contract carries two, so `unknown` narrows into
    // "subscription" here. WHY that narrowing is not a lie: it is sound ONLY
    // because `cashCostAccountingValid` below reads the three-state
    // `effectiveBillingMode` and independently blocks `unknown` — the design
    // doc makes `billingMode: "unknown"` a blocking preflight result
    // (docs/multi-runtime-model-diversity-design.md:461), and the pricing
    // gate cannot enforce it because `unknown` is not `metered`, leaving
    // pricingApplicability at "not_applicable". Delete or weaken the
    // cash-cost derivation and this narrowing silently starts claiming that
    // an unknown-billing route bills like a subscription.
    //
    // #133 keeps that intact: the effective mode only ever REPLACES `unknown`
    // with `metered`, and a metered route is caught by the pricing gate
    // instead. Nothing reaches "subscription" that did not already.
    const billingMode: ExactBindingCapabilityReport["billing"]["mode"] =
      effectiveBillingMode === "metered" ? "metered" : "subscription";
    // #137. THE place the bundled catalogue is consulted, and the only one:
    // this is the sole site where a provider (`this.route.provider`), a model
    // id (`this.route.modelSnapshot`) and a billing decision are all in
    // scope. The provider is not decoration -- it SELECTS which provider's
    // bundled table is consulted, and a route may name any provider beside
    // any model snapshot, so a route naming a provider no table covers is
    // refused rather than priced from a neighbour's. The three remaining
    // `pricingReady: false` sites upstream are backend-wide reports produced
    // before any route resolves, so they stay the honest default and say so
    // in their own comments.
    //
    // Two INDEPENDENT sources for one fact, either sufficient: a transport
    // that reports its own cost keeps working when the table expires, and a
    // provider that reports nothing is still priceable from the table.
    //
    // 2026-09-02: the FIRST disjunct is now connected, and the count above
    // dropped from four to three. `report.billing.pricingReady` was false at
    // every site, so only the table could ever answer — which inverted the
    // design's own ordering (§8 line 461 names provider cost FIRST and the
    // rate table second). The OpenCode transport reports provider cost per
    // assistant message and now says so, which is what lets a metered route
    // on a model no bundled table covers be priced at all.
    //
    // This was a no-op when #137 landed — no route reported
    // `billingMode: "metered"`, so `pricingApplicability` was never
    // "required" and nothing gated on this value. #133 made it LIVE: an
    // OpenCode route on any provider but `openai` resolves to
    // `provider_api_token`, which the effective mode above reports as
    // metered. So today a metered route with a catalogued model and a
    // CURRENT table is admissible, and one with an expired or absent table is
    // refused rather than billed at a guessed price. That refusal is #137's
    // entire point: an old price is worse than no price, because the gate
    // exists to refuse billing an unknown amount and a stale quote defeats it
    // by making the unknown look known. #161 (a real metered mode derived
    // from the transport itself) remains the other way into this branch.
    const tokenPricingAvailable =
      report.billing.pricingReady ||
      tokenPricingAvailableFor(
        this.route.provider,
        this.route.modelSnapshot,
        this.now(),
      );
    // Spec (same design line): subscription OAuth may truthfully report
    // `cashCostUsd: 0`; metered routes require provider cost or a versioned
    // rate table; unknown is blocking. The catalogue IS "a versioned rate
    // table", so this reads the SAME combined fact as tokenPricingAvailable
    // above — deriving it from the raw transport flag instead would ship a
    // metered report claiming priced-but-not-accountable, which is
    // self-contradictory and would strand the route in a gate that no longer
    // has a reason to refuse it.
    const cashCostAccountingValid =
      effectiveBillingMode === "subscription"
        ? true
        : effectiveBillingMode === "metered"
          ? tokenPricingAvailable
          : false;
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
        tokenPricingAvailable,
        cashCostAccountingValid,
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
      // 2026-09-02: the SAME field `capabilities()` derives
      // `effectiveBillingMode` from, handed to the transport factory that
      // derives `usageBillingMode`. One fact, one source — because it was two,
      // and two derivations of one fact diverge in silence (#149's "two
      // brokers", identical shape).
      //
      // `this.credential.kind` is authoritative and the factory's own
      // `merged.credentialKind` is not: this kind was resolved BY THIS ROUTE
      // through `resolveBindingAuthority` -> `credentialKindForRoute(backend,
      // provider)`, while the factory could only ever read a registry-wide
      // default fixed at construction. `productionFallbackRegistry` is the
      // ONLY wiring that sets that default, and it runs only for a caller
      // that supplies no registry — so the public `createProductionRuntime`,
      // which accepts an arbitrary `options.registry`, bypassed it entirely
      // and the factory silently fell back to "subscription" on a metered
      // route. That stamp is what `settlementFromUsage`'s metered-zero rule
      // keys on, so the fallback made the rule DEAD: an unaccountable
      // provider $0 settled as a truthful cost instead of fencing the bucket.
      // (`collectDoctorExactBindingReports` supplies its own kind-less
      // registry too, but it only ever calls `capabilities()` — no attempt,
      // so no usage record, so nothing there could observe the divergence.
      // Being unobservable is what let it ship.)
      //
      // Required on `RuntimeBindingCredential`, so it is forwarded
      // unconditionally rather than through a conditional spread — and
      // `get()` merges `{ ...defaultOptions, ...options }`, so this wins over
      // the construction-time default rather than being shadowed by it. That
      // default survives as the fallback for callers holding no binding.
      credentialKind: this.credential.kind,
    });
    const routeKey = this.key;
    this.leaseTracker.register(routeKey);
    return {
      transport,
      dispose: async () => {
        await this.leaseTracker.endLease({ routeKey, registry });
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
      // #133: the provider was in scope here all along and was dropped. It is
      // what decides the credential kind, and through it the billing mode.
      step.route.provider,
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
      ...(options.now === undefined ? {} : { now: options.now }),
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

export interface BindingsCapabilityGateResult {
  readonly decision: CapabilityGateDecision;
  readonly reports: readonly ExactBindingCapabilityReport[];
}

// SUGGESTION-1: `capabilities()` is deliberately NOT memoised — it re-probes
// on every call — so the reports gathered here are the expensive artifact,
// not a by-product to throw away. They are returned so a caller that needs
// both the gate decision and the facts (doctor) pays ONE probe pass.
// WHY this no longer short-circuits on the first blocking binding: doctor
// reports on every binding regardless of the decision, so stopping early
// would hand it a truncated view of the plan. The extra probes are bounded
// by plan size and only occur on the already-failing path.
export async function gateBindingsCapabilities(
  bindings: ReadonlyMap<string, RuntimeBinding>,
): Promise<BindingsCapabilityGateResult> {
  const reports: ExactBindingCapabilityReport[] = [];
  for (const binding of bindings.values()) {
    reports.push(await binding.capabilities());
  }
  const failed = reports
    .map((report) => exactBindingCapabilityGate(report))
    .find((gate) => !gate.ok);
  return { decision: failed ?? { ok: true }, reports };
}

export interface ProbeBindingsReadinessResult {
  readonly decision: CapabilityGateDecision;
  // The exact reports the decision was taken on, in binding order. Consumers
  // must reuse these instead of re-calling `capabilities()`.
  readonly reports: readonly ExactBindingCapabilityReport[];
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
  const registry = options.registry ?? productionFallbackRegistry(options);
  const leaseTracker = new DefaultActiveTransportLeaseTracker();
  const bindings = await resolveFrozenBindings(
    plan,
    options,
    registry,
    leaseTracker,
  );
  const { decision, reports } = await gateBindingsCapabilities(bindings);
  return {
    decision,
    reports,
    bindings,
    registry,
    dispose: async () => {
      leaseTracker.releaseAll(registry);
    },
  };
}

export function buildDoctorRoutePlan(
  routingConfig?: RoutingConfig,
): ResolvedRoutePlan {
  return buildResolvedRoutePlan({
    agents: [
      { key: "reliability", role: "hunter", model: "sonnet" },
      { key: "refuter", role: "refuter", model: "opus" },
    ],
    ...(routingConfig === undefined ? {} : { routingConfig }),
  });
}

export async function collectDoctorExactBindingReports(input: {
  readonly workspaceRoot: string;
  readonly routingConfig?: RoutingConfig;
  readonly authorityDeps?: ResolveRunnerAuthorityDeps;
  readonly env?: RunnerAuthorityOptions["env"];
  readonly loadSdk?: () => Promise<
    import("./transports/opencode-client").OpenCodeSdkLike
  >;
}): Promise<readonly ExactBindingCapabilityReport[]> {
  const plan = buildDoctorRoutePlan(input.routingConfig);
  const authority = await prepareProductionRunnerAuthority(
    input.workspaceRoot,
    plan,
    input.authorityDeps,
    input.env === undefined ? {} : { env: input.env },
  );
  if ("error" in authority) {
    throw new Error(authority.error);
  }
  // WHY the conformance mode is unconditional, and why `mode` is repeated on
  // BOTH the probe options and the registry: this diagnostic is the phase that
  // PRODUCES D1-11 readiness evidence, so gating it on that evidence can only
  // ever fail. It used to be split into two disagreeing branches — a
  // conformance registry when a test injected `loadSdk`, nothing at all
  // otherwise — and the injected branch was the only one any test exercised.
  // The real doctor/wizard path therefore reached the OpenCode transport
  // factory with no mode, which defaults to "production", and every OpenCode
  // route came back blocking. Passing `mode` here too is not redundant:
  // resolveFrozenBindings forwards `mode: options.mode` on every capability
  // call, and an explicit `undefined` key overrides the registry's default
  // through the factory's `{ ...defaultOptions, ...opts }` spread.
  const probe = await probeBindingsReadiness({
    ...authority,
    plan,
    workspaceRoot: input.workspaceRoot,
    authorityDeps: input.authorityDeps,
    mode: "conformance",
    registry: createDefaultTransportRegistry({
      mode: "conformance",
      env: authority.env,
      ...(input.loadSdk === undefined ? {} : { loadSdk: input.loadSdk }),
    }),
  });
  try {
    // SUGGESTION-1: the readiness probe already called capabilities() once
    // per binding to reach its decision. capabilities() re-probes on every
    // call, so re-collecting here would double the probe cost for a doctor
    // run that needs exactly the reports the gate already produced.
    return probe.reports;
  } finally {
    await probe.dispose();
  }
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

// #133. The OpenCode server is ONE per backend and outlives every step, so
// the credential it launches under is a whole-plan fact, not a per-step one.
// A plan mixing an `openai` OAuth route with a `zai` API-token route would
// need two credentials behind one server; until a server-per-credential
// exists, that plan is REFUSED here by name rather than silently served
// whichever provider happened to be resolved last.
//
// Returns the sole provider and the kind it resolves to. The BROKER is not
// built here — `openCodeCredentialBroker` (runner-authority.ts) owns that
// pairing for both this site and binding resolution, because two copies of it
// would be two chances to hand a route a broker that refuses its kind.
export function soleOpenCodeCredential(plan: ResolvedRoutePlan):
  | {
      readonly kind: CredentialKind;
      readonly provider: string;
      readonly error?: undefined;
    }
  | {
      readonly error: string;
      readonly kind?: undefined;
      readonly provider?: undefined;
    } {
  const providers = new Set<string>();
  for (const step of plan.steps) {
    if (step.route.backend === "opencode") {
      providers.add(step.route.provider);
    }
  }
  if (providers.size > 1) {
    return {
      error: `plan names ${providers.size} OpenCode providers (${[...providers].sort().join(", ")}); the OpenCode server holds one credential for its whole life, so a mixed-provider plan is not supported yet`,
    };
  }
  // No opencode route: the value is never read, and the OAuth default keeps
  // the pre-#133 shape for every caller that passes a claude-only plan.
  const provider = [...providers][0] ?? OPENCODE_OAUTH_PROVIDER;
  return { kind: credentialKindForRoute("opencode", provider), provider };
}

export async function prepareProductionAdmissionContext(input: {
  readonly workspaceRoot: string;
  readonly plan: ResolvedRoutePlan;
  readonly authorityDeps?: ResolveRunnerAuthorityDeps;
  readonly loadSdk?: () => Promise<
    import("./transports/opencode-client").OpenCodeSdkLike
  >;
  readonly env?: RunnerAuthorityOptions["env"];
  readonly credentialBrokers?: RunnerAuthorityOptions["credentialBrokers"];
}): Promise<ProductionAdmissionContext | { readonly error: string }> {
  // #133: ONE opencode credential per plan, decided here, because the
  // OpenCode SERVER is one per backend and outlives every step — it cannot
  // hold two providers' credentials at once. A plan naming two of them is
  // refused by NAME rather than served the wrong one.
  const openCodeCredential = soleOpenCodeCredential(input.plan);
  if (openCodeCredential.error !== undefined) {
    return { error: openCodeCredential.error };
  }
  // #149: resolve the opencode broker ONCE, here, and seed it into the
  // authority so runner-authority.ts binding resolution and the transport
  // registry that launches the server are handed the SAME object. Each side
  // defaulting its own `new OpenCodeAuthBroker()` is the "two brokers,
  // diverging in silence" case: a caller injecting a fake would get the fake
  // at the binding and a real broker at the server.
  //
  // #133 adds the second half: the default must MATCH the plan's provider.
  // An unconditional `new OpenCodeAuthBroker()` here made the api-token route
  // unreachable on the default path — it would resolve the right kind at the
  // authority and then be handed a broker that refuses that kind.
  const credentialBrokers = {
    ...input.credentialBrokers,
    opencode:
      input.credentialBrokers?.opencode ??
      openCodeCredentialBroker(openCodeCredential.provider),
  };
  const authorityResult = await prepareProductionRunnerAuthority(
    input.workspaceRoot,
    input.plan,
    input.authorityDeps,
    {
      ...(input.env === undefined ? {} : { env: input.env }),
      credentialBrokers,
    },
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
    // #149: the SAME instance seeded into the binding authority above.
    credentialBroker: credentialBrokers.opencode,
    // #133: and the kind it was resolved FOR. The launcher pairs the two;
    // sending the broker without its kind would leave the launcher defaulting
    // to the OAuth kind over an api-token broker.
    credentialKind: openCodeCredential.kind,
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
    // #149: the SAME instance seeded into the binding authority above.
    credentialBroker: credentialBrokers.opencode,
    // #133: and the kind it was resolved FOR. The launcher pairs the two;
    // sending the broker without its kind would leave the launcher defaulting
    // to the OAuth kind over an api-token broker.
    credentialKind: openCodeCredential.kind,
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
  // 2026-09-02: ONE ledger for the whole run, and note the shape — it is
  // injectable but NOT optional-off, unlike `attemptAdmissionGate` beside it.
  // That difference is the point: the concurrency gate is an opt-in policy, a
  // spend ledger is a GUARANTEE. Before 2026-09-02 nothing in src/ built one,
  // and that absence made `settlementFromUsage` unreachable on every real run
  // — it is only ever called from `finalizeReservation`, which returns early
  // when no ledger is configured. An opt-in default would reintroduce exactly
  // that, one forgetful caller at a time.
  //
  // Run-scoped because this runner is: `createProductionRuntime` builds
  // exactly one `MultiProviderRunner` per run, while `run()` below builds a
  // FRESH `StepExecutionHarness` per step. A ledger constructed down there
  // would carry a `fencedBuckets` set that dies with the step — it would look
  // wired and fence nothing, which is worse than none because it reads as
  // covered. Holding it here is what makes the fence span the run.
  private readonly spendLedger: SpendLedger;

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
    // Injected only by tests that need to observe the CAS calls; production
    // takes the default, which is the whole point of defaulting rather than
    // requiring a caller to remember.
    readonly spendLedger?: SpendLedger;
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
    this.spendLedger = options.spendLedger ?? new InMemorySpendLedger();
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

    // 2026-09-02. WHICH steps reserve into the run's ledger: metered ones
    // only, read off the report the gate above just admitted rather than
    // re-derived from `binding.credential.kind`. One derivation of one fact —
    // the same `effectiveBillingMode` #133 computes once and feeds to all
    // three billing readers — so the fact that decided admission is the fact
    // that decides reservation.
    //
    // WHY not every step. The ledger's guarantee is "an unresolved bucket
    // blocks the next paid attempt", and `finalizeReservation` reaches it on
    // more than the metered-zero rule: partial usage, unavailable usage (an
    // OpenCode attempt where no usage event ever arrived, and ANY backend's
    // harness watchdog timeout, which normalizes to unavailable), and an
    // attempt that comes back `cancelled`. Any one of those fences the bucket
    // for the rest of the ledger's life.
    //
    // On a metered bucket that is exactly right and fail-closed: we do not
    // know what we spent, so we stop spending. On a SUBSCRIPTION bucket it
    // would refuse later steps over dollars that cannot be spent — and it
    // would do so against a pipeline built to survive exactly this. Hunters
    // run under `Promise.allSettled` and `runPipeline` tolerates a lost
    // hunter (`hunterFailures`, failing the run only when ALL of them fail),
    // so one hunter whose stdout would not parse would fence the credential
    // and take the refuter down with it. That trades a degraded run for a
    // dead one, buying nothing, on the one backend that demonstrably works
    // today.
    //
    // Same reasoning keeps `ClaudeCodeRunner` (step-runner.ts) ledger-free:
    // claude-code resolves to `claude_subscription_oauth` for every provider
    // (`credentialKindForRoute`), so its usage records are truthfully
    // `subscription` and the metered-zero rule structurally cannot fire
    // there. A ledger on that path is a state machine with no guarantee to
    // enforce. The known limitation, deliberately not addressed here: a
    // claude-code run under a real `ANTHROPIC_API_KEY` does spend money, but
    // the engine models that backend as subscription on purpose — ci-gates.ts
    // documents why deriving it instead is an ADMISSION hazard, and
    // `resolveCiBudgetCeiling` is where that case is handled.
    //
    // A claude-only run therefore records no reservations at all, and the
    // absent `reservations` key on those steps is the truthful signal — not a
    // gap.
    const reservesSpend = capabilityReport.billing.mode === "metered";

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
        // The bucket id is per provider+credential (`bindingBucketId`), so a
        // fence lands on the credential that could not account for its spend
        // and leaves every other route admissible.
        //
        // `reservedUsdPerAttempt` is deliberately left at the harness default
        // of 0 rather than given an invented number: `reservedUsd` is
        // RECORDED on the reservation and read by no gate anywhere — the
        // fence keys on `fencedBuckets`, never on an amount — so a figure
        // here would be a budget nobody has decided, dressed as one that was.
        ...(reservesSpend ? { spendLedger: this.spendLedger } : {}),
        ...(this.graceMarginMs !== undefined
          ? { graceMarginMs: this.graceMarginMs }
          : {}),
        onBeforeCredentialProjectionDestroy: async () => {
          if (this.leaseTracker === undefined) {
            return;
          }
          await this.leaseTracker.teardownTransportIfLast({
            routeKey,
            transport: lease.transport,
          });
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
  const registry = options.registry ?? productionFallbackRegistry(options);

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
    evidence: options.evidence,
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
    // Claude-only by construction; credentialKindForRoute ignores the
    // provider for this backend.
    return resolveBindingAuthority(
      "claude-code",
      "anthropic",
      resolvedOptions,
      deps,
    ).then((result) => {
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
    });
  });
}

export type { BindingAuthorityResolution, ResolvedBindingAuthority };

// #149, second round: the registry a caller gets when it supplies none. Shared
// by both fallbacks because they had drifted into the same defect twice — the
// caller supplied `credentialBrokers` and the registry dropped it, so the
// binding authority got the caller broker (runner-authority.ts:335) and the
// server that actually runs the inference got a fresh real one. Found by
// pr-hero own review of the first fix, which patched only the third site.
export function productionFallbackRegistry(options: {
  readonly mode?: "production" | "conformance";
  readonly evidence?: Map<RunnerBackend, D1_11ReadinessEvidence>;
  readonly binaryPath?: string;
  readonly env?: Record<string, string>;
  readonly credentialBrokers?: RunnerAuthorityOptions["credentialBrokers"];
  // #133: optional because this function is also called with a bare
  // `{ mode }` by callers that never reach an opencode route. When it IS
  // present it decides the credential KIND, and dropping it here is how this
  // fallback drifts from the binding authority for the THIRD time — the two
  // earlier rounds are recorded in the comment above, both found by pr-hero
  // reviewing its own fix.
  readonly plan?: ResolvedRoutePlan;
}): TransportRegistry {
  const credential =
    options.plan === undefined
      ? undefined
      : soleOpenCodeCredential(options.plan);
  if (credential?.error !== undefined) {
    throw new ProductionRuntimeError(credential.error);
  }
  return createDefaultTransportRegistry({
    mode: options.mode,
    evidence: options.evidence,
    binaryPath: options.binaryPath,
    env: options.env,
    // Forwarded only when the caller actually supplied one. Substituting a
    // fresh broker here would erase the difference between "no preference"
    // and "use THIS one", which is the whole defect.
    ...(options.credentialBrokers?.opencode === undefined
      ? {}
      : { credentialBroker: options.credentialBrokers.opencode }),
    // The KIND travels even when the broker does not: the registry's own
    // default broker (openCodeLaunchServerFor) must be built for the plan's
    // provider, and its default kind must match whatever broker it ends up
    // with. Without this, a `zai` plan gave the binding an
    // OpenCodeApiTokenBroker and the server an OAuth broker asking for the
    // OAuth kind — which would project the operator's OpenAI record under a
    // zai route. Wrong, not loud, and the worse of the two failure shapes.
    ...(credential === undefined ? {} : { credentialKind: credential.kind }),
  });
}
