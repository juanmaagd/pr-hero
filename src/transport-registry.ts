import { readFile } from "node:fs/promises";
// Route-keyed transport factory/cache: one ProviderTransport instance per
// `${backend}:${routeFingerprint}`. `release()` drops a lease; teardown order
// inside OpenCodeSdkTransport is stream → client.close → server (harness owns
// step timeout and calls destroy on credential projection after transport returns).
import type {
  ProviderCapabilityReport,
  ProviderTransport,
  ResolvedModelRoute,
  RunnerBackend,
} from "./execution/contracts";
import type { ResolvedRoutePlan, ResolvedStepRoute } from "./model-routing";
import { capabilityGateDecision } from "./provider-capabilities";
import { redactDiagnostic } from "./security/redact";
import { ClaudeCodeCliTransport } from "./transports/claude-code-cli";
import {
  createOpenCodeClient,
  type OpenCodeSdkLike,
} from "./transports/opencode-client";
import {
  type OpenCodeClientLike,
  OpenCodeSdkTransport,
} from "./transports/opencode-sdk";
import {
  launchOpenCodeServer,
  type OpenCodeServerHandle,
} from "./transports/opencode-server";

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
  readonly launchServer?: () => Promise<OpenCodeServerHandle>;
  readonly readSystemPrompt?: (path: string) => Promise<string>;
  readonly binaryPath?: string;
  readonly env?: Record<string, string>;
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

      if (merged.openCodeClient) {
        return new OpenCodeSdkTransport({
          client: merged.openCodeClient,
        });
      }

      const route = merged.route;
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
        loadSdk:
          merged.loadSdk ??
          (async () => {
            const dynamicImport = new Function(
              "specifier",
              "return import(specifier)",
            );
            return (await dynamicImport(
              "@opencode-ai/sdk",
            )) as unknown as OpenCodeSdkLike;
          }),
        launchServer:
          merged.launchServer ??
          (async () => {
            return await launchOpenCodeServer({
              verifiedBinaryPath:
                merged.binaryPath ?? "/usr/local/bin/opencode",
              env: merged.env ?? {},
            });
          }),
        readSystemPrompt:
          merged.readSystemPrompt ??
          (async (filePath: string) => {
            return await readFile(filePath, "utf8");
          }),
      });

      return new OpenCodeSdkTransport({ client });
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
    const loadSdk =
      this.defaultOptions.loadSdk ??
      (async () => {
        const dynamicImport = new Function(
          "specifier",
          "return import(specifier)",
        );
        return (await dynamicImport(
          "@opencode-ai/sdk",
        )) as unknown as OpenCodeSdkLike;
      });
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
