import type {
  CredentialKind,
  ExecutableAllowlistEntry,
  ExecutableDenialCode,
  ProviderCapabilityReport,
  RunnerBackend,
  VerifiedExecutable,
} from "../provider-capabilities";
import type { WorkspaceDenialCode } from "../security/workspace-read-broker";
import type { StepSpec } from "../step-runner";
import type { SessionUsage } from "../usage";

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
  readonly systemPromptPath: string;
  readonly systemPromptSha256: string;
  readonly userPrompt: string;
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly mcpConfigPath?: string;
  readonly isolation: IsolationProjection;
  readonly timeoutMs?: number;
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
      readonly usage: Partial<SessionUsage>;
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
  readonly usage: SessionUsage;
  readonly stderrTail: string;
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
