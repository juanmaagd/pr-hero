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
import {
  type ActiveSession,
  createSettlement,
  DEFAULT_CANCELLATION_DEADLINE_MS,
  HARNESS_GRACE_MARGIN_MS,
  type SettlementReceipt,
  type SettlementSession,
  synthesizeInternalFailure,
  synthesizeUnconfirmed,
} from "./settlement";

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
  // §5.3: user/pipeline cancellation (SIGINT/SIGTERM role) enters the same
  // settlement coordinator as the watchdog.
  readonly signal?: AbortSignal;
  // Injectable ISO-timestamp source for §5.1 receipt timestamps (offline tests).
  readonly nowIso?: () => string;
  // Test override for the fixed §5.3 step-4 margin; production default is the
  // spec value HARNESS_GRACE_MARGIN_MS = 1000 ms.
  readonly graceMarginMs?: number;
  // Observer for every settled ActiveSession (ledger/tests); observation only,
  // never allowed to alter settlement.
  readonly onSessionSettled?: (info: {
    readonly session: ActiveSession;
    readonly settlement: SettlementSession;
    readonly receipt: SettlementReceipt;
  }) => void;
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
  private readonly cancelSignal?: AbortSignal;
  private readonly nowIso: () => string;
  private readonly graceMarginMs: number;
  private readonly onSessionSettled?: (info: {
    readonly session: ActiveSession;
    readonly settlement: SettlementSession;
    readonly receipt: SettlementReceipt;
  }) => void;

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
    this.cancelSignal = options.signal;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.graceMarginMs = options.graceMarginMs ?? HARNESS_GRACE_MARGIN_MS;
    this.onSessionSettled = options.onSessionSettled;
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

  // §5.3 step 2: once the lease is invalidated every data-plane write is
  // refused AND counted on the fence's rejectedEvents.
  private async guardedDataPlaneWrite(
    settlement: SettlementSession,
    write: () => Promise<void>,
  ): Promise<void> {
    if (!settlement.writeLease.valid) {
      settlement.rejectDataPlaneEvents(1);
      return;
    }
    await write();
  }

  // Control-plane persistence (§5.3 step 7): the receipt is written through
  // its own always-valid atomic path, deliberately NOT lease-guarded — the
  // receipt itself records the closed fence, so refusing this write would
  // erase the evidence that late data-plane events were refused.
  private async persistSettlement(
    outPath: string,
    session: ActiveSession,
    receipt: SettlementReceipt,
  ): Promise<void> {
    // Per-attempt filename (§422): every retry receives its own settlement
    // receipt — a later attempt must never clobber an earlier attempt's
    // audit record of rejected events / fence closure.
    await writeArtifactAtomically(
      path.join(
        path.dirname(outPath),
        `settlement.attempt${session.attempt}.json`,
      ),
      receipt,
    );
  }

  // §5.2: deadlines are declared transport capabilities, not request fields;
  // an unusable capability report falls back to the CLI/POSIX row default.
  private async resolveCancellationDeadlineMs(): Promise<number> {
    try {
      const report = await this.transport.capabilities();
      const declared = report.cancellation?.deadlineMs;
      if (
        typeof declared === "number" &&
        Number.isFinite(declared) &&
        declared > 0
      ) {
        return declared;
      }
    } catch {
      // Fall through to the §5.2 default.
    }
    return DEFAULT_CANCELLATION_DEADLINE_MS;
  }

  private async executeSession(args: {
    readonly step: StepSpec;
    readonly request: TransportRequest;
    readonly deadlineMs: number;
    readonly onData: (
      outcome: TransportOutcome,
      settlement: SettlementSession,
    ) => Promise<AttemptDelivery>;
  }): Promise<{
    readonly session: ActiveSession;
    readonly settlement: SettlementSession;
    readonly outcome?: TransportOutcome;
    readonly delivery?: AttemptDelivery;
    readonly cancelled: boolean;
  }> {
    const { step, request, deadlineMs, onData } = args;

    const settlement = createSettlement(request.sessionId, request.attempt, {
      now: this.nowIso,
    });
    const lease = settlement.writeLease;
    const controller = new AbortController();

    let resolveSettled!: (receipt: SettlementReceipt) => void;
    const settled = new Promise<SettlementReceipt>((resolve) => {
      resolveSettled = resolve;
    });

    let fenceClosed = false;
    let outcome: TransportOutcome | undefined;
    let finalized = false;

    // §5.1: settled always resolves — invariant failures convert below, and a
    // totally broken settlement context still yields a hand-built unconfirmed
    // receipt rather than a rejection.
    const finalize = (build: () => SettlementReceipt): SettlementReceipt => {
      let receipt: SettlementReceipt;
      try {
        receipt = build();
      } catch (error) {
        try {
          receipt = synthesizeInternalFailure(settlement, error);
        } catch {
          const fallbackNow = new Date().toISOString();
          receipt = {
            sessionId: request.sessionId,
            attempt: request.attempt,
            outcome: "local_termination_unconfirmed",
            termination: { requested: true, confirmation: "unconfirmed" },
            resources: {
              localReleased: true,
              processGroupAlive: "unknown",
              remoteStatus: "unknown_may_continue",
            },
            timestamps: { startedAt: fallbackNow, settledAt: fallbackNow },
            lateWriteFence: {
              leaseId: lease.id,
              closed: true,
              rejectedEvents: 0,
            },
            warnings: [
              "internal settlement invariant failure; receipt hand-built",
            ],
          };
        }
      }
      if (!finalized) {
        finalized = true;
        resolveSettled(receipt);
      }
      return receipt;
    };

    // §13 line 747: after sink closure a late event cannot reach the data
    // plane — it is refused and counted on the fence.
    const sink: AsyncEventSink = {
      push: async (event) => {
        if (!lease.valid || fenceClosed) {
          settlement.rejectDataPlaneEvents(1);
          return "closed";
        }
        if (event.type === "terminal") {
          settlement.acceptTerminal(event.origin, event.status, event.proof);
        }
        return "accepted";
      },
      close: () => {
        fenceClosed = true;
        if (lease.valid) {
          lease.invalidate("event sink closed");
          settlement.markLeaseInvalidated();
        }
      },
    };

    const execPromise: Promise<void> = this.transport
      .execute(request, { signal: controller.signal, events: sink })
      .then((resolved) => {
        if (fenceClosed || !lease.valid) {
          // §5.3 step 5: a terminal arriving after grace expiry is counted by
          // the compare-and-set slot but never applied; its payload can no
          // longer reach parse or artifacts either.
          settlement.acceptTerminal(
            "transport",
            completionToStatus(resolved),
            resolved.terminalProof,
          );
          settlement.rejectDataPlaneEvents(1);
          return;
        }
        outcome = resolved;
      });

    // A throwing transport must not hang settlement; it surfaces through the
    // missing-outcome invariant path instead.
    const execGuarded = execPromise.catch(() => {});

    const session: ActiveSession = {
      id: request.sessionId,
      attempt: request.attempt,
      controller,
      transport: this.transport.backend,
      writeLease: lease,
      cancellationDeadlineMs: deadlineMs,
      settled,
    };

    let onCancel: (() => void) | undefined;
    const cancelPromise = new Promise<"cancel">((resolve) => {
      const sig = this.cancelSignal;
      if (!sig) return;
      if (sig.aborted) {
        resolve("cancel");
        return;
      }
      onCancel = () => resolve("cancel");
      sig.addEventListener("abort", onCancel, { once: true });
    });

    try {
      const raced = await Promise.race([
        execGuarded.then(() => "outcome" as const),
        cancelPromise,
      ]);

      if (raced === "outcome") {
        const resolved = outcome;
        if (resolved === undefined) {
          sink.close();
          const receipt = finalize(() =>
            synthesizeUnconfirmed(settlement, {
              warning:
                "transport promise settled without producing an outcome (§5.1 invariant conversion)",
            }),
          );
          await this.persistSettlement(step.outPath, session, receipt);
          this.onSessionSettled?.({ session, settlement, receipt });
          return { session, settlement, cancelled: true };
        }
        settlement.acceptTerminal(
          "transport",
          completionToStatus(resolved),
          resolved.terminalProof,
        );
        if (resolved.terminalProof !== undefined) {
          settlement.markTerminationConfirmed();
        }
        // Data-plane delivery runs while the lease is still valid; settle
        // (sink closure + fence) happens strictly after it. A throw here
        // (e.g. an attempt-log I/O failure) must NOT skip settlement: §5.1
        // requires settled to always resolve, so the catch below settles a
        // failed session instead of leaving the lease valid forever.
        let delivery: AttemptDelivery;
        try {
          delivery = await onData(resolved, settlement);
        } catch (error) {
          if (lease.valid) {
            lease.invalidate("data-plane write failure");
          }
          fenceClosed = true;
          sink.close();
          settlement.acceptTerminal("harness", "failed");
          const receipt = finalize(() =>
            synthesizeInternalFailure(settlement, error),
          );
          await this.persistSettlement(step.outPath, session, receipt);
          this.onSessionSettled?.({ session, settlement, receipt });
          return {
            session,
            settlement,
            outcome: resolved,
            cancelled: false,
          };
        }
        sink.close();
        const receipt = finalize(() =>
          settlement.receipt(
            resolved.completion === "success" ? "completed" : "failed",
            {
              confirmation: resolved.terminalProof
                ? "process_group_exited"
                : "not_required",
              processGroupAlive: "unknown",
              remoteStatus:
                resolved.completion === "success" ? "completed" : "failed",
            },
          ),
        );
        await this.persistSettlement(step.outPath, session, receipt);
        this.onSessionSettled?.({ session, settlement, receipt });
        return {
          session,
          settlement,
          outcome: resolved,
          delivery,
          cancelled: false,
        };
      }
      // §5.3 steps 2–6 in order.
      settlement.markAbortRequested(); // step 3 precondition: cancel recorded
      if (lease.valid) {
        lease.invalidate("cancellation fence (§5.3 step 2)");
        settlement.markLeaseInvalidated();
      }
      fenceClosed = true;
      sink.close(); // step 2: sinks close with the lease; slot stays open
      controller.abort(); // step 3: abort each active controller exactly once

      const graceMs = deadlineMs + this.graceMarginMs;
      await Promise.race([
        execGuarded,
        new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
      ]);

      // Whether the transport's terminal landed before or after the fence
      // closed, the compare-and-set slot is the single source of truth: a
      // transport-origin terminal recorded there means the cancellation was
      // confirmed within grace; otherwise §5.3 steps 5–6 apply.
      const transportTerminal = settlement.terminal;
      let receipt: SettlementReceipt;
      if (
        transportTerminal !== undefined &&
        transportTerminal.origin !== "harness"
      ) {
        receipt = finalize(() =>
          settlement.receipt("cancelled_confirmed", {
            confirmation: transportTerminal.proof
              ? "process_group_exited"
              : "sdk_abort_confirmed",
            processGroupAlive: "unknown",
            remoteStatus: "cancelled",
          }),
        );
      } else {
        // §5.3 step 5: exactly one harness-origin non-success terminal, won
        // atomically by the compare-and-set slot.
        settlement.acceptTerminal("harness", "cancelled");
        // §5.3 step 6: no transport receipt facts → synthesize + quarantine.
        receipt = finalize(() =>
          synthesizeUnconfirmed(settlement, {
            processGroupAlive:
              this.transport.backend === "claude-code"
                ? "unknown"
                : "not_applicable",
          }),
        );
      }

      await this.persistSettlement(step.outPath, session, receipt);
      this.onSessionSettled?.({ session, settlement, receipt });
      return { session, settlement, cancelled: true };
    } finally {
      if (onCancel && this.cancelSignal) {
        this.cancelSignal.removeEventListener("abort", onCancel);
      }
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
    let cancelHit = false;

    const deadlineMs = await this.resolveCancellationDeadlineMs();

    for (let attempt = 1; attempt <= step.maxAttempts; attempt++) {
      // §5.3 step 1: no new attempts once cancellation is admitted.
      if (this.cancelSignal?.aborted) {
        cancelHit = true;
        break;
      }
      attempts++;

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

      const execution = await this.executeSession({
        step,
        request,
        deadlineMs,
        onData: async (outcome, settlement): Promise<AttemptDelivery> => {
          lastOutcome = outcome;
          totalUsage = sumUsage(totalUsage, outcome.usage);

          try {
            const parsed = step.parse(outcome.finalText);
            await this.guardedDataPlaneWrite(settlement, () =>
              writeAttemptLog(step, attempts, "attempt", outcome, "ok"),
            );
            await this.guardedDataPlaneWrite(settlement, () =>
              writeArtifactAtomically(step.outPath, parsed),
            );
            return { delivered: true, parsed };
          } catch {
            const classification = classifyFailure({
              stderrTail: outcome.stderrTail,
              resultText: outcome.finalText,
              timedOut: Boolean(outcome.timedOut),
            });
            // A failing diagnostic log must never escape the failure handler
            // itself — that second throw is what left settlements unwritten
            // (pr-hero F001 on this very PR).
            await this.guardedDataPlaneWrite(settlement, () =>
              writeAttemptLog(
                step,
                attempts,
                "attempt",
                outcome,
                classification,
              ),
            ).catch(() => {});
            // Transient cleanup of the stale artifact is data-plane too, so it
            // runs under the same lease guard while it is still valid.
            if (classification === "transient") {
              await this.guardedDataPlaneWrite(settlement, () =>
                Bun.file(step.outPath)
                  .unlink()
                  .then(() => {})
                  .catch(() => {}),
              );
            }
            return { delivered: false, classification };
          }
        },
      });

      if (execution.cancelled) {
        cancelHit = true;
        break;
      }

      if (execution.delivery?.delivered) {
        return {
          name: step.name,
          status: "ok",
          output: execution.delivery.parsed,
          usage: totalUsage,
          attempts,
          stderrTail: lastOutcome?.stderrTail ?? "",
          resultText: lastOutcome?.finalText.slice(-8192) ?? "",
        };
      }

      const failure = execution.delivery?.classification ?? "format";

      if (failure === "transient") {
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

      // Format retry (cap 1); §5.3 step 1 forbids starting one after cancel.
      if (this.cancelSignal?.aborted) {
        cancelHit = true;
        break;
      }
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

      const retryExecution = await this.executeSession({
        step,
        request: retryRequest,
        deadlineMs,
        onData: async (outcome, settlement): Promise<AttemptDelivery> => {
          lastOutcome = outcome;
          totalUsage = sumUsage(totalUsage, outcome.usage);

          try {
            const parsed = step.parse(outcome.finalText);
            await this.guardedDataPlaneWrite(settlement, () =>
              writeAttemptLog(step, attempts, "format-retry", outcome, "ok"),
            );
            await this.guardedDataPlaneWrite(settlement, () =>
              writeArtifactAtomically(step.outPath, parsed),
            );
            return { delivered: true, parsed };
          } catch {
            const classification = classifyFailure({
              stderrTail: outcome.stderrTail,
              resultText: outcome.finalText,
              timedOut: Boolean(outcome.timedOut),
            });
            await this.guardedDataPlaneWrite(settlement, () =>
              writeAttemptLog(
                step,
                attempts,
                "format-retry",
                outcome,
                classification,
              ),
            );
            return { delivered: false, classification };
          }
        },
      });

      if (retryExecution.cancelled) {
        cancelHit = true;
        break;
      }

      if (retryExecution.delivery?.delivered) {
        return {
          name: step.name,
          status: "ok",
          output: retryExecution.delivery.parsed,
          usage: totalUsage,
          attempts,
          stderrTail: lastOutcome?.stderrTail ?? "",
          resultText: lastOutcome?.finalText.slice(-8192) ?? "",
        };
      }

      break;
    }

    if (cancelHit) {
      return {
        name: step.name,
        status: "failed",
        usage: totalUsage,
        attempts,
        stderrTail: [
          lastOutcome?.stderrTail ?? "",
          "[pr-hero] step cancelled; settled per §5.3 (see settlement.json)",
        ]
          .filter(Boolean)
          .join("\n"),
        resultText: lastOutcome?.finalText.slice(-8192) ?? "",
      };
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

// TransportOutcome.completion → terminal slot status vocabulary.
function completionToStatus(
  outcome: TransportOutcome,
): "completed" | "failed" | "cancelled" {
  return outcome.completion === "success" ? "completed" : outcome.completion;
}

type AttemptDelivery =
  | { readonly delivered: true; readonly parsed: unknown }
  | { readonly delivered: false; readonly classification: FailureClass };
