import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import {
  type ExecutableAllowlistEntry,
  verifyExecutableAuthority,
} from "../provider-capabilities";
import type {
  CredentialBroker,
  CredentialProjection,
} from "../security/credential-broker";
import { CredentialProjectionError } from "../security/credential-broker";
import { redactDiagnostic } from "../security/redact";
import { WorkspaceReadBroker } from "../security/workspace-read-broker";
import {
  classifyFailure,
  type FailureClass,
  FORMAT_RETRY_REMINDER,
  type RetryInfo,
  type StepResult,
  type StepRunner,
  type StepSpec,
} from "../step-runner";
import { ClaudeCodeCliTransport } from "../transports/claude-code-cli";
import { sumUsage, zeroUsage } from "../usage";
import type {
  AsyncEventSink,
  AuthEvent,
  ProviderTransport,
  StepAdmissionGate,
  TransportOutcome,
  TransportRequest,
} from "./contracts";

export interface StepExecutionHarnessOptions {
  readonly workspaceRoot?: string;
  readonly executableAllowlist?: readonly ExecutableAllowlistEntry[];
  readonly binaryPath?: string;
  readonly admissionGate?: StepAdmissionGate;
  readonly transport?: ProviderTransport;
  readonly onAuthEvent?: (event: AuthEvent) => void;
  readonly spawnFn?: typeof Bun.spawn;
  // §6.1 D1-05: when set, credentials are projected per run and the child's
  // HOME/TMPDIR/config identity come from the ephemeral projection.
  readonly credentialBroker?: CredentialBroker;
  // Source for child-env projection; injectable so tests never touch the
  // real process environment.
  readonly childEnv?: Readonly<Record<string, string | undefined>>;
}

// WHY an enumerated passthrough instead of `process.env` verbatim and instead
// of `{}`: `{}` is what Phase 1 shipped and it broke every real run — a claude
// CLI spawned without HOME cannot find its OAuth credentials ("Not logged in")
// and dies in seconds. The full ambient environment is the opposite failure:
// it leaks operator config into the child. Until credential projection (D1-05)
// lands, the isolation projection carries exactly the keys auth, network and
// binary execution need. GIT_* is deliberately absent — repo redirection must
// not reach the child (the workspace broker enforces the same rule for its own
// git spawns).
const ENV_PASSTHROUGH = [
  "HOME",
  // WHY USER/LOGNAME: on macOS the CLI reads OAuth credentials from the
  // Keychain under an account named after the user; spawned without USER it
  // cannot resolve that entry and reports "Not logged in" even with HOME set.
  // Bisected live against the real CLI (2026-08-26): HOME+PATH+TERM fails,
  // adding USER alone succeeds.
  "USER",
  "LOGNAME",
  "CLAUDE_CONFIG_DIR",
  "PATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

export function projectChildEnv(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const projected: Record<string, string> = {};
  for (const key of ENV_PASSTHROUGH) {
    const value = source[key];
    if (value !== undefined) projected[key] = value;
  }
  return projected;
}

// §6.3: user and system prompt payloads each carry a predeclared 2 MiB byte
// bound; larger steps fail before provider admission.
export const MAX_SYSTEM_PROMPT_BYTES = 2 * 1024 * 1024;

function notifyRetry(step: StepSpec, info: RetryInfo): void {
  if (!step.onRetry) return;
  try {
    step.onRetry(info);
  } catch {
    // Swallowed
  }
}

async function writeArtifactAtomically(
  outPath: string,
  output: unknown,
): Promise<void> {
  const tmpPath = `${outPath}.tmp`;
  await mkdir(path.dirname(outPath), { recursive: true });
  await Bun.write(tmpPath, `${JSON.stringify(output, null, 2)}\n`);
  await rename(tmpPath, outPath);
}

async function writeAttemptLog(
  step: StepSpec,
  attempt: number,
  kind: "attempt" | "format-retry",
  outcome: TransportOutcome,
  classification: "ok" | FailureClass,
): Promise<void> {
  const logPath = path.join(
    path.dirname(step.outPath),
    "logs",
    `${step.name}.${attempt}.log`,
  );
  await mkdir(path.dirname(logPath), { recursive: true });
  await Bun.write(
    logPath,
    [
      `step: ${step.name}`,
      `attempt: ${attempt}`,
      `kind: ${kind}`,
      `exit_code: ${outcome.exitCode ?? (outcome.completion === "success" ? 0 : 1)}`,
      `timed_out: ${outcome.timedOut ?? false}`,
      `classification: ${classification}`,
      "--- stderr tail (4096) ---",
      // §6.3: redaction before persistence — nothing unredacted hits disk.
      redactDiagnostic(outcome.stderrTail),
      "--- result tail (8192) ---",
      redactDiagnostic(outcome.finalText.slice(-8192)),
      "",
    ].join("\n"),
  );
}

export class StepExecutionHarness implements StepRunner {
  private readonly workspaceRoot?: string;
  private readonly allowlist?: readonly ExecutableAllowlistEntry[];
  private readonly binaryPath?: string;
  private readonly admissionGate?: StepAdmissionGate;
  private readonly transport: ProviderTransport;
  private readonly onAuthEvent?: (event: AuthEvent) => void;
  private readonly isTestFake: boolean;
  private readonly projectedEnv: Record<string, string>;
  private readonly credentialBroker?: CredentialBroker;

  constructor(options: StepExecutionHarnessOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.allowlist = options.executableAllowlist;
    this.binaryPath = options.binaryPath;
    this.admissionGate = options.admissionGate;
    this.transport =
      options.transport ??
      new ClaudeCodeCliTransport({ spawnFn: options.spawnFn });
    this.onAuthEvent = options.onAuthEvent;
    this.isTestFake = Boolean(options.spawnFn);
    this.projectedEnv = projectChildEnv(options.childEnv ?? process.env);
    this.credentialBroker = options.credentialBroker;
  }

  async run(step: StepSpec): Promise<StepResult> {
    let canonicalCwd = step.cwd;

    // 1. Workspace authorization
    if (this.workspaceRoot !== undefined) {
      const workspaceBroker = new WorkspaceReadBroker({
        workspaceRoot: this.workspaceRoot,
      });
      const wsResult = workspaceBroker.authorizePath(step.cwd);

      if (!wsResult.approved) {
        this.onAuthEvent?.({
          kind: "workspace",
          status: "denied",
          reason: wsResult.reason,
        });
        return {
          name: step.name,
          status: "failed",
          denialCode: "path_not_approved",
          usage: zeroUsage(),
          attempts: 0,
          stderrTail: `Workspace denied: ${wsResult.reason}`,
          resultText: "",
        };
      }
      // The step must execute against the broker-approved canonical path, not
      // the caller-supplied alias: a symlinked cwd would silently re-widen the
      // sandbox boundary the broker just verified.
      canonicalCwd = wsResult.canonicalPath;
      this.onAuthEvent?.({ kind: "workspace", status: "approved" });
    } else {
      this.onAuthEvent?.({ kind: "workspace", status: "approved" });
    }

    // 2. Executable authorization
    let verifiedBinaryPath: string;

    if (this.allowlist !== undefined) {
      const candidate = this.binaryPath ?? "claude";
      const execResult = await verifyExecutableAuthority({
        candidatePath: candidate,
        allowlist: this.allowlist,
      });

      if (!execResult.approved) {
        this.onAuthEvent?.({
          kind: "executable",
          status: "denied",
          reason: execResult.reason,
        });
        return {
          name: step.name,
          status: "failed",
          denialCode: "executable_not_approved",
          usage: zeroUsage(),
          attempts: 0,
          stderrTail: `Executable denied: ${execResult.reason}`,
          resultText: "",
        };
      }
      this.onAuthEvent?.({ kind: "executable", status: "approved" });
      verifiedBinaryPath = execResult.executable.verifiedExecutionPath;
    } else if (this.isTestFake) {
      // Offline unit test runner with fake spawn
      this.onAuthEvent?.({ kind: "executable", status: "approved" });
      verifiedBinaryPath = this.binaryPath ?? "claude";
    } else {
      // Production without configured allowlist -> fail closed
      this.onAuthEvent?.({
        kind: "executable",
        status: "denied",
        reason: "Missing execution authority: no allowlist configured",
      });
      return {
        name: step.name,
        status: "failed",
        denialCode: "executable_not_approved",
        usage: zeroUsage(),
        attempts: 0,
        stderrTail: "Missing execution authority: no allowlist configured",
        resultText: "",
      };
    }

    // §6.1 D1-05: project credentials ONCE per run, BEFORE admission or
    // spawn — a projection failure must never reach a provider or leak into
    // an attempt count.
    let projection: CredentialProjection | undefined;
    if (this.credentialBroker) {
      try {
        projection = await this.credentialBroker.project({
          sessionId: step.name,
          credentialRef: "claude-code-credentials",
          kind: "claude_subscription_oauth",
          verifiedBinaryPath,
        });
      } catch (error) {
        // Class names only the failure class; broker error text is never
        // echoed because third-party brokers may embed arbitrary content.
        const failureClass =
          error instanceof CredentialProjectionError
            ? error.failureClass
            : "broker_error";
        return {
          name: step.name,
          status: "failed",
          usage: zeroUsage(),
          attempts: 0,
          stderrTail: `Credential projection failed (${failureClass}); step failed before any spawn`,
          resultText: "",
        };
      }
    }

    try {
      const result = await this.admitAndExecute({
        step,
        canonicalCwd,
        verifiedBinaryPath,
        childEnv: this.buildChildEnv(projection),
        projection,
      });
      // §6.1: destroy() runs after settlement on EVERY return path; its
      // failure is a warning appended to stderrTail, never a thrown error
      // and never a replacement for the step's own outcome.
      this.appendDestroyFailure(
        await this.destroyProjection(projection),
        result,
      );
      return result;
    } catch (error) {
      this.appendDestroyFailure(await this.destroyProjection(projection));
      throw error;
    }
  }

  private buildChildEnv(
    projection: CredentialProjection | undefined,
  ): Record<string, string> {
    if (projection === undefined) return this.projectedEnv;
    // The projection owns HOME/TMPDIR/config identity (§6.1); strip the
    // enumerated-passthrough copies first so real values cannot survive.
    const stripped = { ...this.projectedEnv };
    delete stripped.HOME;
    delete stripped.TMPDIR;
    delete stripped.CLAUDE_CONFIG_DIR;
    return { ...stripped, ...projection.env };
  }

  // Returns true when destruction failed (caller annotates the result).
  private async destroyProjection(
    projection: CredentialProjection | undefined,
  ): Promise<boolean> {
    if (projection === undefined) return false;
    try {
      await projection.destroy();
      return false;
    } catch {
      return true;
    }
  }

  private appendDestroyFailure(
    destroyFailed: boolean,
    result?: StepResult,
  ): void {
    if (!destroyFailed) return;
    const line = "[pr-hero] credential projection destroy failed";
    if (result !== undefined) {
      result.stderrTail += `${result.stderrTail}\n${line}`;
    }
  }

  private async admitAndExecute(args: {
    readonly step: StepSpec;
    readonly canonicalCwd: string;
    readonly verifiedBinaryPath: string;
    readonly childEnv: Readonly<Record<string, string>>;
    readonly projection?: CredentialProjection;
  }): Promise<StepResult> {
    const { step, canonicalCwd, verifiedBinaryPath, childEnv, projection } =
      args;

    // 3. Admission gate: called once after successful authorization
    if (this.admissionGate) {
      await this.admissionGate.admit(step);
    }

    // 3.5 §6.3 prompt integrity inputs: read once, bound it, and pin its hash
    // into every TransportRequest so the transport can re-verify the bytes
    // immediately before spawn (the gap in between is exactly the TOCTOU the
    // transport check exists to close).
    let systemPromptSha256: string;
    try {
      const promptBytes = await Bun.file(step.systemPromptPath).bytes();
      if (promptBytes.byteLength > MAX_SYSTEM_PROMPT_BYTES) {
        return {
          name: step.name,
          status: "failed",
          usage: zeroUsage(),
          attempts: 0,
          stderrTail: `System prompt exceeds the predeclared ${MAX_SYSTEM_PROMPT_BYTES}-byte bound (${promptBytes.byteLength} bytes); step failed before any spawn`,
          resultText: "",
        };
      }
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(promptBytes);
      systemPromptSha256 = hasher.digest("hex");
    } catch {
      return {
        name: step.name,
        status: "failed",
        usage: zeroUsage(),
        attempts: 0,
        stderrTail: `Could not read system prompt at ${step.systemPromptPath}; step failed before any spawn`,
        resultText: "",
      };
    }

    // 4. Execution loop with retries
    let totalUsage = zeroUsage();
    let attempts = 0;
    let lastOutcome: TransportOutcome | undefined;

    const noopSink: AsyncEventSink = {
      push: async () => "accepted",
      close: () => {},
    };

    for (let attempt = 1; attempt <= step.maxAttempts; attempt++) {
      attempts++;
      const controller = new AbortController();

      const request: TransportRequest = {
        sessionId: `${step.name}-${Date.now()}-${attempt}`,
        attempt,
        route: {
          backend: this.transport.backend,
          provider: "anthropic",
          modelFamily: "claude",
          modelSnapshot: step.model,
        },
        systemPromptPath: step.systemPromptPath,
        systemPromptSha256,
        userPrompt: step.prompt,
        cwd: canonicalCwd,
        tools: step.tools,
        mcpConfigPath: step.mcpConfigPath,
        timeoutMs: step.timeoutMs,
        isolation: projection
          ? {
              credentialProjectionId: projection.projectionId,
              env: childEnv,
              syntheticHome: projection.syntheticHome,
              syntheticConfigHome: projection.syntheticConfigHome,
              syntheticTmp: projection.syntheticTmp,
              verifiedBinaryPath,
            }
          : {
              credentialProjectionId: "ephemeral",
              env: childEnv,
              syntheticHome: "/tmp",
              syntheticConfigHome: "/tmp",
              syntheticTmp: "/tmp",
              verifiedBinaryPath,
            },
      };

      const outcome = await this.transport.execute(request, {
        signal: controller.signal,
        events: noopSink,
      });

      lastOutcome = outcome;
      totalUsage = sumUsage(totalUsage, outcome.usage);

      // Check parse delivery
      let parsedOutput: unknown;
      let delivered = false;
      try {
        parsedOutput = step.parse(outcome.finalText);
        delivered = true;
      } catch {
        delivered = false;
      }

      if (delivered) {
        await writeAttemptLog(step, attempts, "attempt", outcome, "ok");
        await writeArtifactAtomically(step.outPath, parsedOutput);
        return {
          name: step.name,
          status: "ok",
          output: parsedOutput,
          usage: totalUsage,
          attempts,
          stderrTail: outcome.stderrTail,
          resultText: outcome.finalText.slice(-8192),
        };
      }

      const outcomeForClassify = {
        stderrTail: outcome.stderrTail,
        resultText: outcome.finalText,
        timedOut: Boolean(outcome.timedOut),
      };
      const failure = classifyFailure(outcomeForClassify);
      await writeAttemptLog(step, attempts, "attempt", outcome, failure);

      if (failure === "transient") {
        await Bun.file(step.outPath)
          .unlink()
          .catch(() => {});
        if (attempt < step.maxAttempts) {
          notifyRetry(step, {
            step: step.name,
            attempt: attempt + 1,
            maxAttempts: step.maxAttempts,
            reason: "transient",
          });
        }
        continue;
      }

      if (failure === "terminal") {
        break;
      }

      // Format retry (cap 1)
      attempts++;
      notifyRetry(step, {
        step: step.name,
        attempt: attempts,
        maxAttempts: step.maxAttempts,
        reason: "format",
      });

      const retryRequest: TransportRequest = {
        ...request,
        attempt: attempts,
        userPrompt: step.prompt + FORMAT_RETRY_REMINDER,
      };

      const retryOutcome = await this.transport.execute(retryRequest, {
        signal: controller.signal,
        events: noopSink,
      });

      totalUsage = sumUsage(totalUsage, retryOutcome.usage);
      lastOutcome = retryOutcome;

      let retryParsed: unknown;
      let retryDelivered = false;
      try {
        retryParsed = step.parse(retryOutcome.finalText);
        retryDelivered = true;
      } catch {
        retryDelivered = false;
      }

      await writeAttemptLog(
        step,
        attempts,
        "format-retry",
        retryOutcome,
        retryDelivered
          ? "ok"
          : classifyFailure({
              stderrTail: retryOutcome.stderrTail,
              resultText: retryOutcome.finalText,
              timedOut: Boolean(retryOutcome.timedOut),
            }),
      );

      if (retryDelivered) {
        await writeArtifactAtomically(step.outPath, retryParsed);
        return {
          name: step.name,
          status: "ok",
          output: retryParsed,
          usage: totalUsage,
          attempts,
          stderrTail: retryOutcome.stderrTail,
          resultText: retryOutcome.finalText.slice(-8192),
        };
      }

      break;
    }

    return {
      name: step.name,
      status: "failed",
      usage: totalUsage,
      attempts,
      stderrTail: lastOutcome?.stderrTail ?? "",
      resultText: lastOutcome?.finalText.slice(-8192) ?? "",
    };
  }
}
