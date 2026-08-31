import type {
  CredentialKind,
  ExecutableAllowlistEntry,
  ExecutableDenialCode,
  ProviderCapabilityReport,
  RunnerBackend,
  VerifiedExecutable,
} from "../provider-capabilities";
import type { CredentialBroker } from "../security/credential-broker";
import type { WorkspaceDenialCode } from "../security/workspace-read-broker";
import type { StepSpec } from "../step-runner";
import type { NormalizedTokens, NormalizedUsage } from "./usage-normalized";

export type {
  CredentialKind,
  ExecutableAllowlistEntry,
  ExecutableDenialCode,
  ProviderCapabilityReport,
  RunnerBackend,
  VerifiedExecutable,
  WorkspaceDenialCode,
};

export type DenialCode = WorkspaceDenialCode | ExecutableDenialCode;

export interface ResolvedModelRoute {
  readonly backend: RunnerBackend;
  readonly provider: string;
  readonly gateway?: string;
  readonly modelFamily: string;
  readonly modelSnapshot: string;
  readonly modelVariant?: string;
}

export interface IsolationProjection {
  readonly credentialProjectionId: string;
  readonly env: Readonly<Record<string, string>>;
  readonly syntheticHome: string;
  readonly syntheticConfigHome: string;
  readonly syntheticTmp: string;
  readonly verifiedBinaryPath: string;
}

export interface TransportRequest {
  readonly sessionId: string;
  readonly attempt: number;
  readonly route: ResolvedModelRoute;
  // The model string the provider CLI/SDK actually receives. For Claude Code
  // direct routes this is the logical alias (sonnet|opus|haiku); configured
  // routes use route.modelSnapshot instead.
  readonly executionModel: string;
  readonly systemPromptPath: string;
  readonly systemPromptSha256: string;
  readonly userPrompt: string;
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly mcpConfigPath?: string;
  readonly isolation: IsolationProjection;
}

export interface ProviderTerminalProof {
  readonly eventId: string;
  readonly providerStatus: string;
  readonly providerObservedAt: string;
  readonly exitCode?: number;
  readonly signal?: string;
}

export interface ProviderEventBase {
  readonly sessionId: string;
  readonly attempt: number;
  readonly seq: number;
  readonly observedAt: string;
}

export type ProviderEvent =
  | (ProviderEventBase & { readonly type: "delta"; readonly text: string })
  | (ProviderEventBase & {
      readonly type: "usage";
      readonly mode: "snapshot" | "delta";
      readonly final: boolean;
      // D1-08 PR2 (§8): a streamed usage UPDATE, not a full snapshot — only
      // the leaves this event actually reports are present. cashCostUsd
      // carries a per-event cost delta/snapshot alongside the token leaves;
      // `applyUsageUpdate` (usage-normalized.ts) folds a sequence of these
      // through the same snapshot/delta state machine as the tokens.
      readonly usage: Partial<NormalizedTokens> & {
        readonly cashCostUsd?: number;
      };
    })
  | (ProviderEventBase & {
      readonly type: "diagnostic";
      readonly level: "info" | "warn" | "error";
      readonly message: string;
    })
  | (ProviderEventBase & { readonly type: "heartbeat" })
  | (ProviderEventBase & {
      readonly type: "terminal";
      readonly origin: "provider" | "transport" | "harness";
      readonly proof?: ProviderTerminalProof;
      readonly status: "completed" | "failed" | "cancelled";
      readonly integrity: TransportOutcome["protocolIntegrity"];
    });

export interface AsyncEventSink {
  push(event: ProviderEvent): Promise<"accepted" | "closed">;
  close(): void;
}

export interface TransportOutcome {
  readonly completion: "success" | "failed" | "cancelled";
  readonly protocolIntegrity:
    | "verified"
    | "truncated"
    | "malformed"
    | "overflow"
    | "unverified";
  readonly terminalProof?: ProviderTerminalProof;
  readonly finalText: string;
  // D1-08 PR2 (§8): normalized disjoint usage leaves, not the legacy flat
  // shape. `projectLegacyUsage` (usage-normalized.ts) is the ONLY bridge back
  // to `SessionUsage`, applied at the `runPipeline` return boundary.
  readonly usage: NormalizedUsage;
  readonly stderrTail: string;
  // #126: the transport's OWN diagnostics — counts and tallies that describe
  // how the transport observed the attempt, not what the provider said.
  // `stderrTail` is the classification witness and its declared meaning is
  // "the provider's words"; finalText is already excluded from it for exactly
  // that reason, and our own text is the same hazard from the other
  // direction. Measured, not guessed: a `429` poll-timeout count classified
  // `rate_limit` and a `503` one `network_transient` on the transport's own
  // patterns, while the legacy classifier's unanchored `502|503|529` turned
  // `1502` into a transient too — and the prose "poll round(s) timed out"
  // matched the legacy `timed out` pattern at EVERY count, deterministically.
  // This channel exists so those facts stay visible in the attempt log
  // without any classifier being able to read them. Nothing may classify off
  // it; every witness pattern lives on `stderrTail` alone.
  readonly diagnosticsTail?: string;
  readonly timedOut?: boolean;
  readonly exitCode?: number;
}

export type TransportFailureCause =
  | "auth_invalid"
  | "quota_exhausted"
  | "rate_limit"
  | "network_transient"
  | "protocol_truncation"
  | "protocol_mismatch"
  | "protocol_overflow"
  | "output_limit_exceeded"
  | "context_window_exceeded"
  | "safety_refusal"
  | "provider_configuration_invalid"
  | "runtime_unavailable"
  | "remote_abort_unconfirmed";

export interface ProviderTransport {
  readonly backend: RunnerBackend;
  capabilities(): Promise<ProviderCapabilityReport>;
  execute(
    request: TransportRequest,
    context: {
      readonly signal: AbortSignal;
      readonly events: AsyncEventSink;
    },
  ): Promise<TransportOutcome>;
  classifyFailure(outcome: TransportOutcome): TransportFailureCause | undefined;
}

export interface StepAdmissionGate {
  admit(spec: StepSpec): Promise<void> | void;
}

export interface AuthEvent {
  readonly kind: "workspace" | "executable";
  readonly status: "approved" | "denied";
  readonly reason?: string;
}

export type BillingMode = "subscription" | "metered";

export interface EnvironmentPolicy {
  readonly syntheticHome: boolean;
  readonly workspaceReadBroker: boolean;
}

export interface ToolPolicy {
  readonly allowMapOnly: boolean;
  readonly deniedTools: readonly string[];
}

export interface McpPolicy {
  readonly codegraphOnly: boolean;
  readonly verifiedConfigRequired: boolean;
}

export interface VerifiedExecutableStatus {
  readonly resolved: boolean;
  readonly absolutePath?: string;
  readonly sha256?: string;
  readonly reason?: string;
}

export interface AuthProjectionFacts {
  readonly kind: CredentialKind;
  readonly projectionReady: boolean;
  readonly probe: "passed" | "failed" | "not_run";
}

export interface EnvironmentFacts {
  readonly syntheticHome: boolean;
  readonly enumeratedPassthrough: boolean;
}

export interface IsolationFacts {
  readonly workspaceReadBroker: boolean;
  readonly codegraphPolicy: boolean;
}

export interface ToolMcpFacts {
  readonly allowMapEnforced: boolean;
  readonly mcpIntegrityChecked: boolean;
}

export interface ProtocolFacts {
  readonly terminalProof: boolean;
  readonly boundedEvents: boolean;
  readonly usageMode: "snapshot" | "delta" | "none";
}

export interface UsageFacts {
  readonly normalized: boolean;
}

export interface ExactBindingCapabilityReport {
  readonly routeKey: string;
  readonly backend: RunnerBackend;
  readonly sdk: { readonly available: boolean; readonly version?: string };
  readonly binary: VerifiedExecutableStatus;
  readonly auth: AuthProjectionFacts;
  readonly environment: EnvironmentFacts;
  readonly isolation: IsolationFacts;
  readonly toolsMcp: ToolMcpFacts;
  readonly protocol: ProtocolFacts;
  readonly usage: UsageFacts;
  readonly billing: {
    readonly mode: BillingMode;
    readonly pricingApplicability: "required" | "not_applicable";
    readonly tokenPricingAvailable: boolean;
    readonly cashCostAccountingValid: boolean;
  };
}

export interface RuntimeBindingCredential {
  readonly kind: CredentialKind;
  readonly ref: string;
  readonly broker?: CredentialBroker;
  readonly bucketId: string;
}

export interface RuntimeBinding {
  readonly key: string;
  readonly route: ResolvedModelRoute;
  readonly executable: VerifiedExecutable;
  readonly credential: RuntimeBindingCredential;
  readonly environment: EnvironmentPolicy;
  readonly tools: ToolPolicy;
  readonly mcp: McpPolicy;
  capabilities(): Promise<ExactBindingCapabilityReport>;
  acquire(
    isolation: IsolationProjection,
    registry: {
      get(backend: RunnerBackend): ProviderTransport;
    },
  ): Promise<TransportLease>;
}

export interface TransportLease {
  readonly transport: ProviderTransport;
  dispose(): Promise<void>;
}
