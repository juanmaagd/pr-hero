import { readFile } from "node:fs/promises";
// Route-keyed transport factory/cache: one ProviderTransport instance per
// `${backend}:${routeFingerprint}`. `release()` drops a lease; teardown order
// inside OpenCodeSdkTransport is stream → client.close → server (harness owns
// step timeout and calls destroy on credential projection after transport returns).
import type {
  CredentialKind,
  ProviderCapabilityReport,
  ProviderTransport,
  ResolvedModelRoute,
  RunnerBackend,
} from "./execution/contracts";
import type { UsageBillingMode } from "./execution/usage-normalized";
import type { ResolvedRoutePlan, ResolvedStepRoute } from "./model-routing";
import { capabilityGateDecision } from "./provider-capabilities";
import { credentialKindBillsMetered } from "./runner-authority";
import {
  type CredentialBroker,
  OpenCodeAuthBroker,
} from "./security/credential-broker";
import { redactDiagnostic } from "./security/redact";
import { ClaudeCodeCliTransport } from "./transports/claude-code-cli";
import {
  assertOpenCodeSdk,
  createOpenCodeClient,
  type OpenCodeSdkLike,
} from "./transports/opencode-client";
import type { OpenCodeMcpConfig } from "./transports/opencode-mcp";
import {
  type OpenCodeClientLike,
  OpenCodeSdkTransport,
} from "./transports/opencode-sdk";
import {
  launchProjectedOpenCodeServer,
  type OpenCodeServerHandle,
} from "./transports/opencode-server";

// ONE loader for both consumers (the transport factory and probeOpenCodeSdk),
// so the probe proves exactly what the factory will get. `new Function` keeps
// the import out of the static graph — the SDK is an OPTIONAL dependency and
// a Claude-only install must never be asked to resolve it — but the RESULT is
// now validated instead of `as unknown as OpenCodeSdkLike`-cast. That cast was
// the root cause of issue #121: it silenced the only compiler check that could
// have noticed the local interface named a factory the SDK does not export.
async function loadOpenCodeSdk(): Promise<OpenCodeSdkLike> {
  const dynamicImport = new Function("specifier", "return import(specifier)");
  return assertOpenCodeSdk(await dynamicImport("@opencode-ai/sdk"));
}

export class RouteAdmissionError extends Error {}

export class OpenCodeProductionGatedError extends RouteAdmissionError {
  readonly missingPrerequisites: readonly string[];

  constructor(missingPrerequisites: readonly string[] = []) {
    const details =
      missingPrerequisites.length > 0
        ? `: missing D1-11 prerequisites: ${missingPrerequisites.join(", ")}`
        : "";
    super(
      `OpenCode runner backend is gated in production mode until all D1-11 readiness evidence is met${details}.`,
    );
    this.name = "OpenCodeProductionGatedError";
    this.missingPrerequisites = missingPrerequisites;
  }
}

export interface D1_11ReadinessEvidence {
  readonly sdkAvailable: boolean;
  readonly credentialAuthority: boolean;
  readonly workspaceBroker: boolean;
  readonly pricingReady: boolean;
  readonly issues?: readonly {
    code: string;
    message: string;
    blocking: boolean;
  }[];
}

export interface D1_11ReadinessResult {
  readonly ready: boolean;
  readonly missing: readonly string[];
}

export function checkD1_11Readiness(
  evidence?: D1_11ReadinessEvidence | ProviderCapabilityReport,
): D1_11ReadinessResult {
  if (!evidence) {
    return {
      ready: false,
      missing: [
        "sdkAvailable",
        "credentialAuthority",
        "workspaceBroker",
        "pricingReady",
      ],
    };
  }

  const missing: string[] = [];

  // Check if evidence is a ProviderCapabilityReport
  if ("auth" in evidence && "isolation" in evidence && "billing" in evidence) {
    const report = evidence as ProviderCapabilityReport;
    if (!report.auth.projectionReady) {
      missing.push("credentialAuthority");
    }
    if (!report.isolation.workspaceReadBroker) {
      missing.push("workspaceBroker");
    }
    if (!report.billing.pricingReady) {
      missing.push("pricingReady");
    }
    const hasDeferredSdkIssue = (report.issues ?? []).some(
      (i) => i.code === "real_sdk_adapter_deferred_to_d1_11",
    );
    if (hasDeferredSdkIssue) {
      missing.push("sdkAvailable");
    }
  } else {
    const d1Evidence = evidence as D1_11ReadinessEvidence;
    if (!d1Evidence.sdkAvailable) {
      missing.push("sdkAvailable");
    }
    if (!d1Evidence.credentialAuthority) {
      missing.push("credentialAuthority");
    }
    if (!d1Evidence.workspaceBroker) {
      missing.push("workspaceBroker");
    }
    if (!d1Evidence.pricingReady) {
      missing.push("pricingReady");
    }
  }

  return {
    ready: missing.length === 0,
    missing,
  };
}

export interface TransportFactoryOptions {
  readonly spawnFn?: typeof Bun.spawn;
  readonly openCodeClient?: OpenCodeClientLike;
  readonly loadSdk?: () => Promise<OpenCodeSdkLike>;
  readonly launchServer?: (
    mcp?: OpenCodeMcpConfig,
  ) => Promise<OpenCodeServerHandle>;
  readonly readSystemPrompt?: (path: string) => Promise<string>;
  readonly readMcpConfig?: (path: string) => Promise<string>;
  readonly binaryPath?: string;
  readonly openCodeBinaryPath?: string;
  // #141: absolute, and resolved HERE rather than inside the client. The
  // client is the wrong place for a PATH lookup — the same rule
  // opencode-server.ts states for the opencode binary itself — and the
  // launcher-side default below keeps the operator's override on the same
  // option path as every other binary this registry hands out.
  readonly codegraphBinaryPath?: string;
  readonly env?: Record<string, string>;
  // #149: the credential broker the authority resolved for the opencode
  // backend. The server runs under its projection for the servers whole life.
  readonly credentialBroker?: CredentialBroker;
  // #133: the KIND that broker was resolved for. Travels beside it and is
  // only ever meaningful as a pair — see openCodeLaunchServerFor.
  readonly credentialKind?: CredentialKind;
  readonly evidence?: Map<RunnerBackend, D1_11ReadinessEvidence>;
  readonly mode?: "production" | "conformance";
  readonly routeFingerprint?: string;
  readonly route?: ResolvedModelRoute;
  [key: string]: unknown;
}

export type TransportFactory = (
  options?: TransportFactoryOptions,
) => ProviderTransport | Promise<ProviderTransport>;

export interface TransportRegistry {
  register(
    backend: RunnerBackend,
    factoryOrInstance: ProviderTransport | TransportFactory,
  ): void;
  get(
    backend: RunnerBackend,
    options?: TransportFactoryOptions,
  ): ProviderTransport;
  has(backend: RunnerBackend): boolean;
  getCapabilityReport(
    backend: RunnerBackend,
    options?: TransportFactoryOptions,
  ): Promise<ProviderCapabilityReport>;
  getAllCapabilityReports(
    options?: TransportFactoryOptions,
  ): Promise<Map<RunnerBackend, ProviderCapabilityReport>>;
  release?(routeFingerprint: string): void;
}

export interface CreateTransportRegistryOptions
  extends TransportFactoryOptions {
  readonly mode?: "production" | "conformance";
}

export class DefaultTransportRegistry implements TransportRegistry {
  private readonly factories = new Map<
    RunnerBackend,
    ProviderTransport | TransportFactory
  >();
  private readonly instances = new Map<RunnerBackend, ProviderTransport>();
  private readonly routeInstances = new Map<string, ProviderTransport>();
  private readonly userOverriddenBackends = new Set<RunnerBackend>();
  private readonly defaultOptions: TransportFactoryOptions;

  // #149: read-only, and it exists for exactly one reason — the invariant that
  // the server launcher and the binding authority share ONE broker instance
  // was unobservable from outside, which is how the forwarding that claimed to
  // guarantee it shipped dead. Identity here is the assertion.
  get openCodeCredentialBroker(): CredentialBroker | undefined {
    return this.defaultOptions.credentialBroker;
  }

  // #133: the same reason, for the other half of the pair. The kind travels
  // beside the broker and decides which credential the server projects; a
  // fallback that silently dropped it would be unobservable from outside, and
  // an unobservable invariant is how the #149 forwarding shipped dead twice.
  get openCodeCredentialKind(): CredentialKind | undefined {
    return this.defaultOptions.credentialKind;
  }

  constructor(options: CreateTransportRegistryOptions = {}) {
    this.defaultOptions = options;

    // Register Claude CLI transport factory
    this.register("claude-code", (opts) => {
      const merged = { ...this.defaultOptions, ...opts };
      return new ClaudeCodeCliTransport({
        spawnFn: merged.spawnFn,
      });
    });

    // Register OpenCode transport factory with D1-11 gate
    this.register("opencode", (opts) => {
      const merged = { ...this.defaultOptions, ...opts };
      const mode = merged.mode ?? "production";
      const evidence = merged.evidence?.get("opencode");

      // Check D1-11 readiness in production mode
      if (mode === "production") {
        const readiness = checkD1_11Readiness(evidence);
        if (!readiness.ready) {
          throw new OpenCodeProductionGatedError(readiness.missing);
        }
      }

      // 2026-09-02: the billing mode stamped on every usage record this
      // transport emits, derived from the credential kind the authority
      // resolved. THE factory is the only place that holds both the kind and
      // the transport, and `credentialKindBillsMetered` is the one predicate
      // the exact-binding report derives its own effective mode from (#133),
      // so the report and the usage records cannot disagree about how an
      // attempt bills. Computed once, above both construction branches —
      // wiring only the second is how the injected-client path (every test
      // and every doctor probe) would keep the pre-#133 default.
      const usageBillingMode: UsageBillingMode =
        merged.credentialKind !== undefined &&
        credentialKindBillsMetered(merged.credentialKind)
          ? "metered"
          : "subscription";

      if (merged.openCodeClient) {
        return new OpenCodeSdkTransport({
          client: merged.openCodeClient,
          billingMode: usageBillingMode,
        });
      }

      const route = merged.route;
      // Resolved ONCE per client, before the options object is built: the
      // lookup hits the filesystem, and a spread that called it twice would
      // pay for it twice for one value.
      const codegraphBinaryPath =
        merged.codegraphBinaryPath ?? Bun.which("codegraph") ?? undefined;
      const client = createOpenCodeClient({
        model: route
          ? {
              providerID: route.provider,
              modelID: route.modelSnapshot,
            }
          : {
              providerID: "openai",
              modelID: "gpt-4o",
            },
        loadSdk: merged.loadSdk ?? loadOpenCodeSdk,
        launchServer: merged.launchServer ?? openCodeLaunchServerFor(merged),
        readSystemPrompt:
          merged.readSystemPrompt ??
          (async (filePath: string) => {
            return await readFile(filePath, "utf8");
          }),
        // #141: the SAME mcp.json `binding-policy.ts` already validates —
        // not a second, OpenCode-shaped registry the integrity gate would
        // never see. The path arrives on the request; this only reads it.
        readMcpConfig:
          merged.readMcpConfig ??
          (async (filePath: string) => {
            return await readFile(filePath, "utf8");
          }),
        // An unresolved binary is carried through as "unresolved" rather than
        // refused here: the translation is the only place that knows whether a
        // codegraph binary was needed at all. A repo with no index needs none,
        // and refusing to build a client for it would break the parity case
        // #116's ledger recorded as correct.
        ...(codegraphBinaryPath === undefined ? {} : { codegraphBinaryPath }),
      });

      return new OpenCodeSdkTransport({
        client,
        billingMode: usageBillingMode,
      });
    });
  }

  register(
    backend: RunnerBackend,
    factoryOrInstance: ProviderTransport | TransportFactory,
  ): void {
    if (this.factories.has(backend)) {
      this.userOverriddenBackends.add(backend);
    }
    this.factories.set(backend, factoryOrInstance);
    this.instances.delete(backend);
    for (const key of [...this.routeInstances.keys()]) {
      if (key.startsWith(`${backend}:`)) {
        this.routeInstances.delete(key);
      }
    }
  }

  private routeCacheKey(
    backend: RunnerBackend,
    routeFingerprint: string,
  ): string {
    return `${backend}:${routeFingerprint}`;
  }

  async probeOpenCodeSdk(): Promise<void> {
    const loadSdk = this.defaultOptions.loadSdk ?? loadOpenCodeSdk;
    await loadSdk();
  }

  needsOpenCodeSdkProbe(): boolean {
    return !this.userOverriddenBackends.has("opencode");
  }

  release(routeFingerprint: string): void {
    for (const key of [...this.routeInstances.keys()]) {
      if (key.endsWith(`:${routeFingerprint}`)) {
        this.routeInstances.delete(key);
      }
    }
  }

  has(backend: RunnerBackend): boolean {
    return this.factories.has(backend);
  }

  get(
    backend: RunnerBackend,
    options?: TransportFactoryOptions,
  ): ProviderTransport {
    if (options?.routeFingerprint !== undefined) {
      const routeKey = this.routeCacheKey(backend, options.routeFingerprint);
      const routeCached = this.routeInstances.get(routeKey);
      if (routeCached !== undefined) {
        return routeCached;
      }
    } else if (!options) {
      const cached = this.instances.get(backend);
      if (cached !== undefined) {
        return cached;
      }
    }
    const entry = this.factories.get(backend);
    if (!entry) {
      throw new RouteAdmissionError(
        redactDiagnostic(`No transport registered for backend "${backend}"`),
      );
    }
    if (typeof entry === "function") {
      const merged = { ...this.defaultOptions, ...options };
      const instance = (entry as TransportFactory)(merged);
      if (instance instanceof Promise) {
        throw new RouteAdmissionError(
          `Async transport factory for backend "${backend}" cannot be resolved synchronously in get()`,
        );
      }
      if (options?.routeFingerprint !== undefined) {
        const routeKey = this.routeCacheKey(backend, options.routeFingerprint);
        this.routeInstances.set(routeKey, instance);
      } else if (!options) {
        this.instances.set(backend, instance);
      }
      return instance;
    }
    if (options?.routeFingerprint !== undefined) {
      const routeKey = this.routeCacheKey(backend, options.routeFingerprint);
      this.routeInstances.set(routeKey, entry);
    } else if (!options) {
      this.instances.set(backend, entry);
    }
    return entry;
  }

  async getCapabilityReport(
    backend: RunnerBackend,
    options?: TransportFactoryOptions,
  ): Promise<ProviderCapabilityReport> {
    const transport = this.get(backend, options);
    return await transport.capabilities();
  }

  async getAllCapabilityReports(
    options?: TransportFactoryOptions,
  ): Promise<Map<RunnerBackend, ProviderCapabilityReport>> {
    const reports = new Map<RunnerBackend, ProviderCapabilityReport>();
    for (const backend of this.factories.keys()) {
      try {
        const report = await this.getCapabilityReport(backend, options);
        reports.set(backend, report);
      } catch (err) {
        if (err instanceof OpenCodeProductionGatedError) {
          reports.set(backend, {
            backend,
            status: "blocking",
            auth: {
              kind: "opencode_chatgpt_oauth",
              projectionReady: false,
              probe: "not_run",
            },
            isolation: {
              syntheticHome: false,
              workspaceReadBroker: false,
              codegraphPolicy: false,
            },
            protocol: {
              terminalProof: true,
              boundedEvents: true,
              usageMode: "none",
            },
            cancellation: {
              deadlineMs: 6500,
              conformance: "passed",
            },
            billing: {
              mode: "subscription",
              // #137 leaves this hardcoded: no model id is in scope. This is
              // the synthetic report for a backend whose transport could not
              // be CONSTRUCTED (OpenCodeProductionGatedError), so there is no
              // route, no client and no model behind it — and the report is
              // already blocking on `d1_11_production_gated`.
              //
              // 2026-09-02: NOT the case the OpenCode transport's `true`
              // covers. That claim is a TRANSPORT reporting the provider cost
              // it reads off each assistant message; here there is no
              // transport to make the claim, so `false` is the only honest
              // answer and stays one.
              pricingReady: false,
            },
            issues: [
              {
                code: "d1_11_production_gated",
                message: err.message,
                blocking: true,
              },
            ],
          });
        } else {
          throw err;
        }
      }
    }
    return reports;
  }
}

export function createDefaultTransportRegistry(
  options: CreateTransportRegistryOptions = {},
): TransportRegistry {
  return new DefaultTransportRegistry(options);
}

export interface AdmitRoutePlanOptions {
  readonly mode?: "production" | "conformance";
  readonly evidence?: Map<RunnerBackend, D1_11ReadinessEvidence>;
  readonly capabilities?:
    | ProviderCapabilityReport
    | Map<RunnerBackend, ProviderCapabilityReport>;
}

export interface AdmittedRoutePlanResult {
  readonly ok: true;
  readonly plan: ResolvedRoutePlan;
  readonly admittedSteps: readonly ResolvedStepRoute[];
  readonly reports: ReadonlyMap<RunnerBackend, ProviderCapabilityReport>;
}

export async function admitRoutePlan(
  plan: ResolvedRoutePlan,
  registryOrCapabilities:
    | TransportRegistry
    | ProviderCapabilityReport
    | Map<RunnerBackend, ProviderCapabilityReport>,
  optionsOrRegistry?: TransportRegistry | AdmitRoutePlanOptions,
  maybeOptions?: AdmitRoutePlanOptions,
): Promise<AdmittedRoutePlanResult> {
  let registry: TransportRegistry;
  let options: AdmitRoutePlanOptions;

  const isRegistry = (obj: unknown): obj is TransportRegistry => {
    return (
      typeof obj === "object" &&
      obj !== null &&
      !(obj instanceof Map) &&
      !("backend" in obj) &&
      "get" in obj &&
      typeof (obj as TransportRegistry).get === "function"
    );
  };

  if (isRegistry(registryOrCapabilities)) {
    registry = registryOrCapabilities;
    options = (optionsOrRegistry as AdmitRoutePlanOptions) ?? {};
  } else {
    // Signature: admitRoutePlan(plan, capabilities, registry?, options?)
    if (isRegistry(optionsOrRegistry)) {
      registry = optionsOrRegistry;
      options = {
        ...(maybeOptions ?? {}),
        capabilities: registryOrCapabilities,
      };
    } else {
      registry = new DefaultTransportRegistry();
      options = {
        capabilities: registryOrCapabilities,
        ...((optionsOrRegistry as AdmitRoutePlanOptions) ?? {}),
      };
    }
  }

  const reports = new Map<RunnerBackend, ProviderCapabilityReport>();
  const mode = options.mode ?? "production";

  for (const step of plan.steps) {
    const backend = step.route.backend;

    if (!registry.has(backend)) {
      throw new RouteAdmissionError(
        redactDiagnostic(
          `Step "${step.stepKey}" route backend "${backend}" is not registered`,
        ),
      );
    }

    // Check OpenCode D1-11 gate in production mode
    if (backend === "opencode") {
      const evidence = options.evidence?.get("opencode");
      if (mode === "production") {
        const readiness = checkD1_11Readiness(evidence);
        if (!readiness.ready) {
          throw new OpenCodeProductionGatedError(readiness.missing);
        }
      }
    }

    // Get and validate capability report
    let report: ProviderCapabilityReport | undefined;
    if (options.capabilities) {
      if ("backend" in options.capabilities) {
        if (options.capabilities.backend === backend) {
          report = options.capabilities;
        }
      } else if (options.capabilities instanceof Map) {
        report = options.capabilities.get(backend);
      }
    }

    if (!report) {
      report = await registry.getCapabilityReport(backend, {
        mode,
        evidence: options.evidence,
      });
    }

    reports.set(backend, report);

    const gate = capabilityGateDecision(report);
    if (!gate.ok) {
      throw new RouteAdmissionError(
        redactDiagnostic(
          `Step "${step.stepKey}" route backend "${backend}" rejected by capability gate: ${gate.reason}`,
        ),
      );
    }
  }

  return {
    ok: true,
    plan,
    admittedSteps: plan.steps,
    reports,
  };
}

export async function admitDiversityRoutePlan(
  plan: ResolvedRoutePlan,
  registryOrCapabilities: Parameters<typeof admitRoutePlan>[1],
  optionsOrRegistry?: Parameters<typeof admitRoutePlan>[2],
  maybeOptions?: Parameters<typeof admitRoutePlan>[3],
): Promise<AdmittedRoutePlanResult> {
  const { requireInternalFindingsCapability } = await import(
    "./diversity/admission"
  );
  requireInternalFindingsCapability();
  return admitRoutePlan(
    plan,
    registryOrCapabilities,
    optionsOrRegistry,
    maybeOptions,
  );
}

// #149: the launcher the registry hands out when the caller injects none.
// Named and exported because it is the ONLY place production chooses the
// opencode server environment, and every existing test injects `launchServer`
// instead — so an inline closure here was, by construction, untested.
export function defaultOpenCodeLaunchServer(options: {
  readonly verifiedBinaryPath: string;
  readonly broker: CredentialBroker;
  readonly credentialKind: CredentialKind;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly spawnFn?: typeof Bun.spawn;
  readonly killFn?: (pid: number, signal?: string | number) => unknown;
}): (mcp?: OpenCodeMcpConfig) => Promise<OpenCodeServerHandle> {
  return async (mcp?: OpenCodeMcpConfig) => {
    return await launchProjectedOpenCodeServer({
      ...options,
      // #141: the run’s registry rides the SPAWN. OpenCode reads
      // `OPENCODE_CONFIG_CONTENT` at startup, so a server already running
      // cannot be given one without opening a window between "server up" and
      // "MCP connected".
      ...(mcp === undefined ? {} : { mcp }),
    });
  };
}

// #149: how the registry turns its options into a launcher. Split out from the
// factory so the WIRING is reachable from a test — the factory itself only
// hands `launchServer` to the client, and every existing test injects one,
// which is how the previous inline closure went untested for its whole life.
export function openCodeLaunchServerFor(
  merged: TransportFactoryOptions,
): (mcp?: OpenCodeMcpConfig) => Promise<OpenCodeServerHandle> {
  return defaultOpenCodeLaunchServer({
    verifiedBinaryPath:
      merged.openCodeBinaryPath ??
      merged.binaryPath ??
      "/usr/local/bin/opencode",
    // The same broker the credential authority resolved for this backend.
    // Defaulting a second instance here would be a second source of truth
    // beside runner-authority.ts, and a caller injecting a fake at the
    // authority would silently get a real one at the server.
    broker: merged.credentialBroker ?? new OpenCodeAuthBroker(),
    // #133: the kind the authority resolved for that broker. The default
    // below is the OAuth kind because the default BROKER on the line above is
    // the OAuth broker — the pair is only ever defaulted together, here.
    //
    // The one case where they intentionally MISMATCH: a caller that supplies
    // a metered `credentialKind` but no broker gets the OAuth default, which
    // then refuses `provider_api_token` by name. That is deliberate. #149's
    // invariant is that an absent broker stays absent rather than being
    // silently stood in for, so the honest outcome is a loud refusal, not a
    // guess — and never the reverse, an OAuth record projected under a
    // metered route.
    credentialKind: merged.credentialKind ?? "opencode_chatgpt_oauth",
    // pr-hero own environment, filtered to operational keys only. The
    // projection owns HOME/TMPDIR/XDG_* and overrides whatever survives;
    // see composeOpenCodeServerEnv.
    baseEnv: merged.env ?? process.env,
  });
}
