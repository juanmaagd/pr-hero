import { mkdir } from "node:fs/promises";
import path from "node:path";
// Lifecycle ownership (§2 docs/multi-runtime-model-diversity-design.md):
//   HARNESS — StepSpec.timeoutMs watchdog, cancellation coordinator, retry/
//   parse, write leases + settlement receipts, event sink, spend reservations,
//   concurrency admission, credential projection destroy AFTER transport teardown.
//   TRANSPORT — provider/process mechanics only: honor AbortSignal, emit bounded
//   protocol events, return TransportOutcome, classify provider/transport causes.
//   TransportRequest deliberately omits timeoutMs, parser, retry, and artifacts.
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
  attemptLogPath,
  type FailureClass,
  FORMAT_RETRY_REMINDER,
  type RetryInfo,
  type StepResult,
  type StepRunner,
  type StepSpec,
  settlementReceiptPath,
} from "../step-runner";
import type { TransportRegistry } from "../transport-registry";
import { DefaultTransportRegistry } from "../transport-registry";
import { ClaudeCodeCliTransport } from "../transports/claude-code-cli";
import { zeroUsage } from "../usage";
import type { AttemptAdmissionGate, AttemptLease } from "./admission";
import { writeJsonAtomically } from "./atomic-write";
import {
  BucketBreakerTrippedError,
  ConcurrencyAdmissionAbortedError,
} from "./concurrency-limiter";
import type {
  AsyncEventSink,
  AuthEvent,
  ProviderTransport,
  StepAdmissionGate,
  TransportOutcome,
  TransportRequest,
} from "./contracts";
import {
  type CauseResolution,
  decideRetryDisposition,
  type FailureCause,
  legacyClassificationFromCause,
  type RetryState,
  resolveFailureCause,
} from "./failure-policy";
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
import {
  beginStep,
  nextCycle,
  type ReserveToken,
  type SpendLedger,
  type SpendReservation,
  SpendReservationFencedError,
  settlementFromUsage,
} from "./spend-limiter";
import type { NormalizedUsage } from "./usage-normalized";
import {
  normalizeUnavailableUsage,
  projectLegacyUsage,
  sumNormalizedUsage,
} from "./usage-normalized";

// §7 line 416: injected sleep for the `rate_limit` capped-exponential
// backoff — a real timer in production, a recording stub in tests (§13 line
// 746: no offline test may actually wait out a delay, let alone the 60s cap).
const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_ATTEMPT_ADMISSION_TIMEOUT_MS = 30 * 60 * 1000;
// Credential projection must not hang the step indefinitely when a broker
// blocks on interactive Keychain prompts or a stalled reader.
const DEFAULT_CREDENTIAL_PROJECTION_TIMEOUT_MS = 60_000;

async function projectCredentialWithBudget(
  broker: CredentialBroker,
  input: Parameters<CredentialBroker["project"]>[0],
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<CredentialProjection> {
  let outcome: "pending" | "budget" | undefined;
  const guarded = broker.project(input).then(async (projection) => {
    if (outcome === "budget") {
      await projection.destroy().catch(() => {});
      throw new Error("credential_projection_superseded");
    }
    outcome = "pending";
    return projection;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const signal = options.signal;

  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  };

  try {
    if (signal?.aborted) {
      throw new Error("credential_projection_aborted");
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("credential_projection_timed_out")),
        options.timeoutMs,
      );
    });

    const racers: Promise<CredentialProjection>[] = [guarded, timeoutPromise];

    if (signal !== undefined) {
      const abortPromise = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("credential_projection_aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      racers.push(abortPromise);
    }

    return await Promise.race(racers);
  } catch (error) {
    if (outcome === undefined) {
      outcome = "budget";
    }
    throw error;
  } finally {
    cleanup();
  }
}

function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onDone = () => {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(onDone, ms);
    const onAbort = () => onDone();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// D1-08 PR5a (§9.2 Open Question): deriving a real bucket id from a
// resolved CredentialProjection's bucketScope is a caller concern (PR3's
// deriveBucketId is available to any caller that has one), not this
// harness's. This sentinel is what a configured AttemptAdmissionGate has to
// key on when no caller has derived a real one yet — every step run by one
// harness instance still coarsens onto ONE bucket, matching the "unknown
// scope coarsens" rule at the harness boundary too.
const DEFAULT_RATE_LIMIT_BUCKET_ID = "default";

export interface StepExecutionHarnessOptions {
  readonly workspaceRoot?: string;
  readonly executableAllowlist?: readonly ExecutableAllowlistEntry[];
  readonly binaryPath?: string;
  readonly admissionGate?: StepAdmissionGate;
  readonly registry?: TransportRegistry;
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
  // D1-08 PR0 (§7 line 416): backoff delay for a `rate_limit` retry_after
  // disposition. Defaults to a real timer; tests inject a recording stub.
  readonly sleep?: (ms: number) => Promise<void>;
  // D1-08 PR5a (§9.2): the attempt-scoped, lease-returning admission gate —
  // admitted per ATTEMPT inside the retry loop, distinct from
  // `admissionGate` (StepAdmissionGate, admitted once per STEP before the
  // loop even starts and left untouched, D4). Left unconfigured, attempts
  // are gated exactly as before this slice — the concurrency limiter stays
  // a dormant module (D1-08 PR3's own framing) until a caller opts in. NO
  // spend-ledger call is made here — that's PR5b.
  readonly attemptAdmissionGate?: AttemptAdmissionGate;
  // The rate-limit bucket every attempt this harness instance runs admits
  // into. See DEFAULT_RATE_LIMIT_BUCKET_ID for why an explicit id is
  // optional.
  readonly rateLimitBucketId?: string;
  // D1-08 PR5b (§9.1): the transactional spend reservation ledger. Left
  // unconfigured, attempts reserve nothing — the ledger stays a dormant
  // module exactly like `attemptAdmissionGate` before PR5a wired it, and
  // every existing caller (PR5a's own tests included) keeps its ledger-free
  // shape unmodified.
  readonly spendLedger?: SpendLedger;
  // What each attempt reserves BEFORE its actual cost is known. Estimating a
  // real per-step dollar figure from prompt/model/provider pricing is a
  // caller concern this slice does not attempt (same framing as PR5a's own
  // `rateLimitBucketId` default: deriving the real number belongs to
  // whoever composes the run, not to this harness). Defaults to 0 so an
  // unconfigured caller reserves nothing rather than an invented ceiling.
  readonly reservedUsdPerAttempt?: number;
  // When `attemptAdmissionGate` is configured but no pipeline cancel
  // `signal` is wired, acquire() uses AbortSignal.timeout(ms) so a stuck
  // FIFO queue cannot hang the run forever.
  readonly attemptAdmissionTimeoutMs?: number;
  readonly credentialProjectionTimeoutMs?: number;
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
  // The subscription credential, and it was MISSING here while the capability
  // gate (§11) already accepted it as proof of auth — the gate and the spawn
  // disagreeing about the same variable. pr-hero's first real CI self-review
  // (2026-08-27) passed the gate, passed the size gate, then lost all three
  // hunters and the summarizer in three seconds to "Not logged in · Please run
  // /login", $0.00 spent, because this projection dropped the token the action
  // had just handed it. It is the same credential class as ANTHROPIC_API_KEY
  // directly above, and it is the ONLY route on Linux: credential projection
  // needs darwin + /usr/bin/security, so every CI runner falls back to exactly
  // this enumerated passthrough.
  "CLAUDE_CODE_OAUTH_TOKEN",
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

// Settlement receipts are named on BOTH axes — step name and attempt — and the
// name is derived from the runner contract's single builder so the writer and
// every message that points a human at the file cannot drift apart (a hardcoded
// "settlement.json" in a cancellation message pointed at a file that never
// existed for as long as it shipped). D1-10c added a second reader of that
// shape — pipeline.json's per-step pointers — which is why the builder now
// lives in step-runner.ts rather than here.
function receiptPathFor(step: StepSpec, attempt: number): string {
  return settlementReceiptPath(step.outPath, step.name, attempt);
}

async function writeAttemptLog(
  step: StepSpec,
  attempt: number,
  kind: "attempt" | "format-retry",
  outcome: TransportOutcome,
  classification: "ok" | FailureClass,
  // D1-08 PR0 (design row 13, additive): the coarse legacy `classification`
  // above collapses watchdog_timeout into "transient", same as a plain
  // network failure — this line is what lets incident triage tell them
  // apart. Absent on a delivered ("ok") attempt.
  cause?: FailureCause | "legacy_terminal",
): Promise<void> {
  const logPath = attemptLogPath(step.outPath, step.name, attempt);
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
      ...(cause !== undefined ? [`cause: ${cause}`] : []),
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
  private readonly registry?: TransportRegistry;
  private readonly explicitTransport?: ProviderTransport;
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
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly attemptAdmissionGate?: AttemptAdmissionGate;
  private readonly rateLimitBucketId: string;
  private readonly spendLedger?: SpendLedger;
  private readonly reservedUsdPerAttempt: number;
  private readonly attemptAdmissionTimeoutMs: number;
  private readonly credentialProjectionTimeoutMs: number;

  constructor(options: StepExecutionHarnessOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.allowlist = options.executableAllowlist;
    this.binaryPath = options.binaryPath;
    this.admissionGate = options.admissionGate;
    this.registry = options.registry;
    if (options.transport !== undefined) {
      this.explicitTransport = options.transport;
      this.transport = options.transport;
    } else {
      this.transport = new ClaudeCodeCliTransport({ spawnFn: options.spawnFn });
    }
    this.onAuthEvent = options.onAuthEvent;
    this.isTestFake = Boolean(options.spawnFn);
    this.projectedEnv = projectChildEnv(options.childEnv ?? process.env);
    this.credentialBroker = options.credentialBroker;
    this.cancelSignal = options.signal;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.graceMarginMs = options.graceMarginMs ?? HARNESS_GRACE_MARGIN_MS;
    this.onSessionSettled = options.onSessionSettled;
    this.sleep = options.sleep ?? DEFAULT_SLEEP;
    this.attemptAdmissionGate = options.attemptAdmissionGate;
    this.rateLimitBucketId =
      options.rateLimitBucketId ?? DEFAULT_RATE_LIMIT_BUCKET_ID;
    this.spendLedger = options.spendLedger;
    this.reservedUsdPerAttempt = options.reservedUsdPerAttempt ?? 0;
    this.attemptAdmissionTimeoutMs =
      options.attemptAdmissionTimeoutMs ?? DEFAULT_ATTEMPT_ADMISSION_TIMEOUT_MS;
    this.credentialProjectionTimeoutMs =
      options.credentialProjectionTimeoutMs ??
      DEFAULT_CREDENTIAL_PROJECTION_TIMEOUT_MS;
  }

  async run(step: StepSpec): Promise<StepResult> {
    let canonicalCwd = step.cwd;

    // Resolve transport for this step
    const effectiveBackend =
      step.route?.backend ?? step.backend ?? "claude-code";
    let transport: ProviderTransport;
    if (this.explicitTransport !== undefined) {
      const declaredBackend = step.route?.backend ?? step.backend;
      if (
        declaredBackend !== undefined &&
        this.explicitTransport.backend !== declaredBackend
      ) {
        return {
          name: step.name,
          status: "failed",
          usage: zeroUsage(),
          attempts: 0,
          stderrTail: `No transport registry configured to handle backend "${declaredBackend}" for step "${step.name}"`,
          resultText: "",
        };
      }
      transport = this.explicitTransport;
    } else if (this.registry) {
      try {
        transport = this.registry.get(effectiveBackend, {
          routeFingerprint: step.routeKey,
          route: step.route,
        });
      } catch (err) {
        return {
          name: step.name,
          status: "failed",
          usage: zeroUsage(),
          attempts: 0,
          stderrTail: `Transport resolution failed: ${(err as Error).message}`,
          resultText: "",
        };
      }
    } else {
      if (effectiveBackend !== "claude-code") {
        return {
          name: step.name,
          status: "failed",
          usage: zeroUsage(),
          attempts: 0,
          stderrTail: `No transport registry configured to handle backend "${effectiveBackend}" for step "${step.name}"`,
          resultText: "",
        };
      }
      transport = this.transport;
    }

    if (
      effectiveBackend === "opencode" &&
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
      const candidate =
        this.binaryPath ??
        (transport.backend === "opencode" ? "opencode" : "claude");
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
      verifiedBinaryPath =
        this.binaryPath ??
        (transport.backend === "opencode" ? "opencode" : "claude");
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
    let projectionWarning: string | undefined;
    if (this.credentialBroker) {
      try {
        projection = await projectCredentialWithBudget(
          this.credentialBroker,
          {
            sessionId: step.name,
            credentialRef: step.credentialRef ?? "claude-code-credentials",
            kind: step.credentialKind ?? "claude_subscription_oauth",
            verifiedBinaryPath,
          },
          {
            timeoutMs: this.credentialProjectionTimeoutMs,
            signal: this.cancelSignal,
          },
        );
      } catch (error) {
        // Class names only the failure class; broker error text is never
        // echoed because third-party brokers may embed arbitrary content.
        const failureClass =
          error instanceof CredentialProjectionError
            ? error.failureClass
            : "broker_error";
        // Deliberate degradation, scoped to exactly ONE failure class
        // (operator decision 2026-08-26): Claude desktop 2.1.246 moved the
        // subscription OAuth record out of the keychain item into its own
        // encrypted store, so missing_subscription_record now means "the CLI
        // keeps its credential somewhere we cannot read" — killing every
        // step made reviews impossible. Every OTHER class is an attack or
        // integrity signal (symlinked layout, tampered payload, unreadable
        // source) and still fails closed: degrading on those would run an
        // adversarial-diff agent with operator credentials precisely when
        // something suspicious happened. The degradation is stated on the
        // result, never silent.
        if (failureClass !== "missing_subscription_record") {
          return {
            name: step.name,
            status: "failed",
            usage: zeroUsage(),
            attempts: 0,
            stderrTail: `Credential projection failed (${failureClass}); step failed before any spawn`,
            resultText: "",
          };
        }
        projection = undefined;
        projectionWarning = `credential projection unavailable (${failureClass}); child runs with operator environment`;
      }
    }

    try {
      const result = await this.admitAndExecute({
        step,
        canonicalCwd,
        verifiedBinaryPath,
        childEnv: this.buildChildEnv(projection),
        projection,
        transport,
      });
      // §6.1: destroy() runs after settlement on EVERY return path; its
      // failure is a warning appended to stderrTail, never a thrown error
      // and never a replacement for the step's own outcome.
      this.appendDestroyFailure(
        await this.destroyProjection(projection),
        result,
      );
      if (projectionWarning !== undefined) {
        result.stderrTail = `${result.stderrTail}\n[pr-hero] ${projectionWarning}`;
      }
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
    step: StepSpec,
    session: ActiveSession,
    receipt: SettlementReceipt,
  ): Promise<void> {
    // Per-STEP *and* per-attempt filename (§422). Two independent collisions
    // are being prevented here and an audit record needs both:
    //   - attempt vs attempt: every retry receives its own receipt, so a later
    //     attempt never clobbers an earlier one's rejected-event / fence record.
    //   - step vs step: every step of a run shares ONE steps/ directory
    //     (hunters, summarizer, refuters, scout all write beside each other),
    //     so a name keyed only on the attempt made each step overwrite the
    //     previous step's receipt. That is not hypothetical — a four-step run
    //     left four attempt logs and exactly one receipt on disk, and three
    //     audit records were destroyed silently.
    // Keying on the step name is what makes the write target unique, which in
    // turn gives writeJsonAtomically's `${outPath}.tmp` staging file a unique
    // name — parallel steps otherwise raced on one tmp path and could corrupt
    // each other mid-rename rather than merely losing the loser.
    await writeJsonAtomically(receiptPathFor(step, session.attempt), receipt);
  }

  // §5.2: deadlines are declared transport capabilities, not request fields;
  // an unusable capability report falls back to the CLI/POSIX row default.
  private async resolveCancellationDeadlineMs(
    transport: ProviderTransport = this.transport,
  ): Promise<number> {
    try {
      const report = await transport.capabilities();
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
    readonly transport: ProviderTransport;
    readonly deadlineMs: number;
    readonly harnessWatchdogMs?: number;
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
    // D1-08 PR5a (§9.2): every return path below builds one via `finalize`
    // before returning — exposed so `runAttempt` can react to
    // `local_fenced_remote_unconfirmed` without re-deriving it.
    readonly receipt: SettlementReceipt;
  }> {
    const { step, request, transport, deadlineMs, harnessWatchdogMs, onData } =
      args;

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

    const execPromise: Promise<void> = transport
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
      transport: transport.backend,
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

    const watchdogPromise =
      harnessWatchdogMs !== undefined && harnessWatchdogMs > 0
        ? new Promise<"watchdog">((resolve) => {
            setTimeout(() => resolve("watchdog"), harnessWatchdogMs);
          })
        : undefined;

    try {
      const racers: Promise<"outcome" | "cancel" | "watchdog">[] = [
        execGuarded.then(() => "outcome" as const),
        cancelPromise,
      ];
      if (watchdogPromise !== undefined) {
        racers.push(watchdogPromise);
      }
      const raced = await Promise.race(racers);

      if (raced === "watchdog") {
        settlement.markAbortRequested();
        if (lease.valid) {
          lease.invalidate("harness watchdog timeout");
          settlement.markLeaseInvalidated();
        }
        fenceClosed = true;
        sink.close();
        controller.abort();
        const receipt = finalize(() =>
          synthesizeInternalFailure(
            settlement,
            new Error(
              `Step timed out after ${harnessWatchdogMs}ms (harness-owned watchdog)`,
            ),
          ),
        );
        await this.persistSettlement(step, session, receipt);
        this.onSessionSettled?.({ session, settlement, receipt });
        return {
          session,
          settlement,
          outcome: {
            completion: "failed",
            protocolIntegrity: "unverified",
            finalText: "",
            usage: normalizeUnavailableUsage({
              wallMs: harnessWatchdogMs ?? 0,
            }),
            stderrTail: `Step timed out after ${harnessWatchdogMs}ms`,
            timedOut: true,
          },
          cancelled: false,
          receipt,
        };
      }

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
          await this.persistSettlement(step, session, receipt);
          this.onSessionSettled?.({ session, settlement, receipt });
          return { session, settlement, cancelled: true, receipt };
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
          await this.persistSettlement(step, session, receipt);
          this.onSessionSettled?.({ session, settlement, receipt });
          return {
            session,
            settlement,
            outcome: resolved,
            cancelled: false,
            receipt,
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
        await this.persistSettlement(step, session, receipt);
        this.onSessionSettled?.({ session, settlement, receipt });
        return {
          session,
          settlement,
          outcome: resolved,
          delivery,
          cancelled: false,
          receipt,
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
        // D1-08 (design doc line 290): a non-CLI (SDK-backed) transport's
        // abort() call carries no confirmed-stopped guarantee the way the
        // CLI's process-group signalling does — that is exactly the
        // "SDK abort without provider confirmation" case whose receipt is
        // local_fenced_remote_unconfirmed, not the generic
        // local_termination_unconfirmed. §9.2's circuit breaker (runAttempt)
        // keys off precisely this outcome to fence the bucket.
        const isSdkBackedTransport = transport.backend !== "claude-code";
        // §5.3 step 6: no transport receipt facts → synthesize + quarantine.
        receipt = finalize(() =>
          synthesizeUnconfirmed(settlement, {
            processGroupAlive: isSdkBackedTransport
              ? "not_applicable"
              : "unknown",
            outcome: isSdkBackedTransport
              ? "local_fenced_remote_unconfirmed"
              : undefined,
          }),
        );
      }

      await this.persistSettlement(step, session, receipt);
      this.onSessionSettled?.({ session, settlement, receipt });
      return { session, settlement, cancelled: true, receipt };
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
    readonly transport: ProviderTransport;
  }): Promise<StepResult> {
    const {
      step,
      canonicalCwd,
      verifiedBinaryPath,
      childEnv,
      projection,
      transport,
    } = args;

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

    // 4. Execution loop with retries — D1-08 PR0 (D1-07 wiring): ONE
    // `runAttempt` per attempt (transient retry AND format retry are now the
    // same shape), driven by the live §7 retry decision
    // (decideRetryDisposition/resolveFailureCause) instead of the legacy
    // step-runner failure classifier.
    // D1-08 PR2 (§8): NormalizedUsage is the single source of truth across
    // attempts now; the legacy SessionUsage is recomputed from it via
    // `projectLegacyUsage` at every return point below, never accumulated
    // independently — that is what keeps the two shapes unable to drift.
    // `undefined` until the first attempt settles: seeding it with a
    // billingMode/costSource-less zero would force `sumNormalizedUsage` to
    // collapse the run's real billing mode to "unknown" on the very first sum.
    let totalUsageV2: NormalizedUsage | undefined;
    let attempts = 0;
    let lastOutcome: TransportOutcome | undefined;
    let cancelHit = false;
    // D1-08 PR5b (§9.1): every attempt that reached the reserve step, in
    // order, each already finalized to a terminal reservation state by the
    // time `runAttempt` returns. Empty when no `spendLedger` is configured.
    const reservations: SpendReservation[] = [];
    // Coupling 2 (spend-limiter.ts): attempt 1 always has a token —
    // `beginStep()` — because there is no disposition yet to consult. Every
    // later cycle's token comes from `nextCycle(disposition)`, which is
    // `undefined` for a `terminal` disposition — structurally preventing a
    // terminal attempt from opening a new reserve+admit cycle.
    let reserveToken: ReserveToken = beginStep();

    const deadlineMs = await this.resolveCancellationDeadlineMs(transport);

    // D3: bind the new transient budget to the EXISTING per-step knob so a
    // step's worst-case spawn count stays byte-identical to the legacy loop
    // (1 initial + up to `maxAttempts - 1` transient retries).
    // failure-policy's own default (3) would silently raise worst-case
    // spawns from 3 to 5 per step — a 67% cost increase nobody asked for.
    const maxTransientAttempts = Math.max(0, step.maxAttempts - 1);

    let retryState: RetryState = {
      transientAttemptsUsed: 0,
      formatRetriesUsed: 0,
    };
    // Set only by a `retry_format_reminder` disposition; consumed by the
    // very next iteration, which is what makes that iteration a
    // "format-retry" rather than a plain "attempt" (row 7).
    let pendingFormatPrompt: string | undefined;

    for (;;) {
      // §5.3 step 1: no new attempt starts once cancellation is admitted —
      // covers both a fresh transient attempt and a format-reminder retry,
      // which are now the same loop iteration shape (row 6).
      if (this.cancelSignal?.aborted) {
        cancelHit = true;
        break;
      }
      attempts++;
      const kind: "attempt" | "format-retry" =
        pendingFormatPrompt === undefined ? "attempt" : "format-retry";

      const request: TransportRequest = {
        sessionId: `${step.name}-${Date.now()}-${attempts}`,
        attempt: attempts,
        executionModel: step.model,
        route: step.route ?? {
          backend: transport.backend,
          provider:
            transport.backend === "claude-code" ? "anthropic" : "opencode",
          modelFamily:
            transport.backend === "claude-code" ? "claude" : "opencode",
          modelSnapshot: step.model,
        },
        systemPromptPath: step.systemPromptPath,
        systemPromptSha256,
        userPrompt: pendingFormatPrompt ?? step.prompt,
        cwd: canonicalCwd,
        tools: step.tools,
        mcpConfigPath: step.mcpConfigPath,
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
              // Degraded mode must describe what ACTUALLY ran, not claim a
              // synthetic identity the env contradicts (§6.1 invariant:
              // env.HOME === syntheticHome). The marker id makes the
              // fallback auditable in artifacts.
              credentialProjectionId: "operator-env-fallback",
              env: childEnv,
              syntheticHome: childEnv.HOME ?? "",
              syntheticConfigHome:
                childEnv.CLAUDE_CONFIG_DIR ??
                path.join(childEnv.HOME ?? "", ".claude"),
              syntheticTmp: childEnv.TMPDIR ?? "",
              verifiedBinaryPath,
            },
      };
      pendingFormatPrompt = undefined;

      const attemptResult = await this.runAttempt({
        step,
        attempt: attempts,
        kind,
        request,
        deadlineMs,
        transport,
        reserveToken,
        harnessWatchdogMs: step.timeoutMs,
      });

      if (attemptResult.reservation !== undefined) {
        reservations.push(attemptResult.reservation);
      }

      if (attemptResult.kind === "cancelled") {
        cancelHit = true;
        break;
      }

      lastOutcome = attemptResult.outcome;
      totalUsageV2 =
        totalUsageV2 === undefined
          ? attemptResult.outcome.usage
          : sumNormalizedUsage(totalUsageV2, attemptResult.outcome.usage);

      if (attemptResult.kind === "delivered") {
        return {
          name: step.name,
          status: "ok",
          output: attemptResult.parsed,
          usage: projectLegacyUsage(totalUsageV2),
          usageV2: totalUsageV2,
          attempts,
          ...(reservations.length === 0 ? {} : { reservations }),
          stderrTail: lastOutcome?.stderrTail ?? "",
          resultText: lastOutcome?.finalText.slice(-8192) ?? "",
        };
      }

      // attemptResult.kind === "failed"
      if (attemptResult.resolution.kind === "legacy_terminal") {
        break;
      }

      const disposition = decideRetryDisposition(
        attemptResult.resolution.cause,
        retryState,
        { maxTransientAttempts },
      );

      if (
        disposition.action === "retry_now" ||
        disposition.action === "retry_after"
      ) {
        retryState = {
          ...retryState,
          transientAttemptsUsed: retryState.transientAttemptsUsed + 1,
        };
        notifyRetry(step, {
          step: step.name,
          attempt: attempts + 1,
          maxAttempts: step.maxAttempts,
          reason: disposition.budget,
        });
        if (disposition.action === "retry_after") {
          if (this.cancelSignal) {
            await cancellableSleep(disposition.delayMs, this.cancelSignal);
          } else {
            await this.sleep(disposition.delayMs);
          }
        }
        // Non-null: `nextCycle` only returns `undefined` for a `terminal`
        // disposition, and this branch is reached only on `retry_now`/
        // `retry_after`.
        // biome-ignore lint/style/noNonNullAssertion: guaranteed by nextCycle's own contract for a non-terminal disposition
        reserveToken = nextCycle(disposition)!;
        continue;
      }

      if (disposition.action === "retry_format_reminder") {
        retryState = {
          ...retryState,
          formatRetriesUsed: retryState.formatRetriesUsed + 1,
        };
        notifyRetry(step, {
          step: step.name,
          attempt: attempts + 1,
          maxAttempts: step.maxAttempts,
          reason: disposition.budget,
        });
        pendingFormatPrompt = step.prompt + FORMAT_RETRY_REMINDER;
        // biome-ignore lint/style/noNonNullAssertion: guaranteed by nextCycle's own contract for a non-terminal disposition
        reserveToken = nextCycle(disposition)!;
        continue;
      }

      // disposition.action === "terminal"
      break;
    }

    if (cancelHit) {
      // Name the receipt that was ACTUALLY written for THIS step and attempt.
      // The previous text pointed at a bare "settlement.json" that has never
      // existed on disk. Cancellation before the first attempt admits no
      // session at all, so there is no receipt to name — saying so beats
      // naming attempt0.json, which would be the same lie in a new font.
      const receiptPointer =
        attempts >= 1
          ? `see ${receiptPathFor(step, attempts)}`
          : "no attempt was admitted, so no receipt was written";
      return {
        name: step.name,
        status: "failed",
        usage:
          totalUsageV2 === undefined
            ? zeroUsage()
            : projectLegacyUsage(totalUsageV2),
        ...(totalUsageV2 === undefined ? {} : { usageV2: totalUsageV2 }),
        attempts,
        ...(reservations.length === 0 ? {} : { reservations }),
        stderrTail: [
          lastOutcome?.stderrTail ?? "",
          `[pr-hero] step cancelled; settled per §5.3 (${receiptPointer})`,
        ]
          .filter(Boolean)
          .join("\n"),
        resultText: lastOutcome?.finalText.slice(-8192) ?? "",
      };
    }

    return {
      name: step.name,
      status: "failed",
      usage:
        totalUsageV2 === undefined
          ? zeroUsage()
          : projectLegacyUsage(totalUsageV2),
      ...(totalUsageV2 === undefined ? {} : { usageV2: totalUsageV2 }),
      attempts,
      ...(reservations.length === 0 ? {} : { reservations }),
      stderrTail: lastOutcome?.stderrTail ?? "",
      resultText: lastOutcome?.finalText.slice(-8192) ?? "",
    };
  }

  // D1-08 PR0: the ONE place a single attempt (transient OR format-retry —
  // `kind` only affects logging/request framing) executes, gets logged, and
  // has its failure resolved to a §7 cause. Replaces the two
  // near-duplicate closures `admitAndExecute` used to run inline, one for
  // the initial/transient loop and a second, slightly-out-of-sync one for
  // the format retry (row 9's `.catch` asymmetry was exactly that drift).
  private async runAttempt(args: {
    readonly step: StepSpec;
    readonly attempt: number;
    readonly kind: "attempt" | "format-retry";
    readonly request: TransportRequest;
    readonly deadlineMs: number;
    readonly transport: ProviderTransport;
    readonly reserveToken: ReserveToken;
    readonly harnessWatchdogMs?: number;
  }): Promise<AttemptRunResult> {
    const {
      step,
      attempt,
      kind,
      request,
      deadlineMs,
      transport,
      reserveToken,
      harnessWatchdogMs,
    } = args;

    // D1-08 PR5b (§9.1 five-step order): acquire (1) → reserve (2) →
    // execute (3) → settle-or-unresolved (4) → release-if-unstarted (5),
    // all inside ONE acquire/finally-release wrapper. Lease release stays a
    // SEPARATE `finally`, independent of the ledger transition (§9.2: an
    // abort AFTER the provider attempt started releases the local
    // concurrency slot but NOT the spend reservation) — this is why the
    // ledger's own finalization lives in the `try` body below, never in the
    // outer `finally` beside `lease?.release()`.
    let lease: AttemptLease | undefined;
    try {
      if (this.attemptAdmissionGate) {
        const acquireSignal =
          this.cancelSignal ??
          AbortSignal.timeout(this.attemptAdmissionTimeoutMs);
        lease = await this.attemptAdmissionGate.acquire({
          sessionId: request.sessionId,
          attempt,
          rateLimitBucketId: this.rateLimitBucketId,
          signal: acquireSignal,
        });
      }

      // Step 2: reserve spend transactionally. Left unconfigured, no
      // `SpendLedger` call is made at all — attempts reserve nothing,
      // exactly the ledger-free shape PR5a shipped. A refusing ledger
      // (fenced bucket, spec: "Unresolved bucket blocks the next paid
      // attempt") throws HERE, before the transport is ever invoked.
      let reservation: SpendReservation | undefined;
      if (this.spendLedger) {
        reservation = await this.spendLedger.reserve(
          {
            bucketId: this.rateLimitBucketId,
            reservedUsd: this.reservedUsdPerAttempt,
            sessionId: request.sessionId,
            attempt,
          },
          reserveToken,
        );
      }

      // §9.2 / spec "Abort timing determines release": the ONLY point at
      // which the provider attempt has PROVABLY never started — a
      // cancellation that raced ahead of the reservation itself, before
      // `runAdmittedAttempt` (and therefore the transport) is ever called.
      // Once execution begins below, an abort must NOT release the
      // reservation; it settles as unresolved instead (finalizeReservation).
      if (reservation !== undefined && this.cancelSignal?.aborted) {
        await this.spendLedger?.releaseUnstarted(
          reservation.reservationId,
          `${reservation.reservationId}:release-unstarted`,
        );
        return {
          kind: "cancelled",
          reservation: { ...reservation, state: "released_unstarted" },
        };
      }

      // Step 3: mark the attempt started and execute.
      const result = await this.runAdmittedAttempt({
        step,
        attempt,
        kind,
        request,
        deadlineMs,
        transport,
        harnessWatchdogMs,
      });

      // Step 4: settle actual known cost exactly once (or route to
      // markUnresolvedRemote when usage completeness never became
      // "complete" — coupling 1, spend-limiter.ts).
      if (reservation === undefined) return result;
      const finalReservation = await this.finalizeReservation(
        reservation,
        result,
      );
      return { ...result, reservation: finalReservation };
    } catch (error) {
      if (
        error instanceof ConcurrencyAdmissionAbortedError ||
        error instanceof BucketBreakerTrippedError
      ) {
        return { kind: "cancelled" };
      }
      if (error instanceof SpendReservationFencedError) {
        return {
          kind: "failed",
          outcome: {
            completion: "failed",
            protocolIntegrity: "unverified",
            finalText: "",
            usage: normalizeUnavailableUsage({ wallMs: 0 }),
            stderrTail: error.message,
          },
          resolution: { kind: "legacy_terminal" },
        };
      }
      throw error;
    } finally {
      lease?.release();
    }
  }

  // Coupling 1 consumer: routes a finished attempt's usage through
  // `settlementFromUsage` and applies whichever CAS transition it names.
  // `result.kind === "cancelled"` here means the provider attempt WAS
  // invoked (executeSession calls the transport unconditionally) but no
  // usage ever arrived — that case can never settle as a number either, so
  // it takes the same unresolved path with `knownUsd: undefined`.
  private async finalizeReservation(
    reservation: SpendReservation,
    result: AttemptRunResult,
  ): Promise<SpendReservation> {
    const ledger = this.spendLedger;
    if (ledger === undefined) return reservation;
    const idempotencyKey = `${reservation.reservationId}:finalize`;
    const usage =
      result.kind === "cancelled" ? undefined : result.outcome.usage;
    if (usage === undefined) {
      await ledger.markUnresolvedRemote(
        reservation.reservationId,
        undefined,
        idempotencyKey,
      );
      return {
        ...reservation,
        state: "unresolved_remote",
        knownUsd: undefined,
      };
    }
    const decision = settlementFromUsage(usage);
    if (decision.kind === "settle") {
      await ledger.settle(reservation.reservationId, decision, idempotencyKey);
      return {
        ...reservation,
        state: "settled",
        settledUsd: decision.actualUsd,
      };
    }
    await ledger.markUnresolvedRemote(
      reservation.reservationId,
      decision.knownUsd,
      idempotencyKey,
    );
    return {
      ...reservation,
      state: "unresolved_remote",
      knownUsd: decision.knownUsd,
    };
  }

  // The body of a single attempt, unchanged from PR0 except for the §9.2
  // breaker-trip check — split out so `runAttempt` itself stays a thin
  // acquire/finally-release wrapper (D1-08 PR5a) around it.
  private async runAdmittedAttempt(args: {
    readonly step: StepSpec;
    readonly attempt: number;
    readonly kind: "attempt" | "format-retry";
    readonly request: TransportRequest;
    readonly deadlineMs: number;
    readonly transport: ProviderTransport;
    readonly harnessWatchdogMs?: number;
  }): Promise<AttemptRunResult> {
    const {
      step,
      attempt,
      kind,
      request,
      deadlineMs,
      transport,
      harnessWatchdogMs,
    } = args;

    const execution = await this.executeSession({
      step,
      request,
      transport,
      deadlineMs,
      harnessWatchdogMs,
      onData: async (outcome, settlement): Promise<AttemptDelivery> => {
        try {
          const parsed = step.parse(outcome.finalText);
          await this.guardedDataPlaneWrite(settlement, () =>
            writeAttemptLog(step, attempt, kind, outcome, "ok"),
          );
          await this.guardedDataPlaneWrite(settlement, () =>
            writeJsonAtomically(step.outPath, parsed),
          );
          return { delivered: true, parsed };
        } catch {
          // D1-08 PR0: cause resolution now goes through the transport's OWN
          // failure classifier first (the second, previously unwired
          // mechanism this slice closes) before ever falling back to the
          // legacy step-runner one.
          const resolution = resolveFailureCause({
            outcome,
            classifyFailure: transport.classifyFailure,
            parseThrew: true,
          });
          const classification = legacyClassificationFromCause(resolution);
          // A failing diagnostic log must never escape the failure handler
          // itself — that second throw is what left settlements unwritten
          // (pr-hero F001 on this very PR). Unified across BOTH `kind`s now
          // (row 9: the format-retry twin used to be missing this `.catch`).
          await this.guardedDataPlaneWrite(settlement, () =>
            writeAttemptLog(
              step,
              attempt,
              kind,
              outcome,
              classification,
              resolution.kind === "cause"
                ? resolution.cause
                : "legacy_terminal",
            ),
          ).catch(() => {});
          // Transient cleanup of the stale artifact is data-plane too, so it
          // runs under the same lease guard while it is still valid. Scope
          // widened (row 8) to both transient retry arms — retry_now AND
          // retry_after mean "another attempt is coming" alike.
          if (classification === "transient") {
            await this.guardedDataPlaneWrite(settlement, () =>
              Bun.file(step.outPath)
                .unlink()
                .then(() => {})
                .catch(() => {}),
            );
          }
          return { delivered: false, resolution };
        }
      },
    });

    // D1-08 PR5a (§9.2 "Circuit Breaker Fences An Unconfirmed-Abort
    // Bucket"): an SDK abort the harness could not confirm remotely stopped
    // fences this bucket for the rest of the run — the NEXT admission
    // attempt (this step's own retry, or a different step sharing the
    // credential) must refuse before ever reaching the transport again.
    if (execution.receipt.outcome === "local_fenced_remote_unconfirmed") {
      this.attemptAdmissionGate?.reportUnconfirmedRemote?.(
        this.rateLimitBucketId,
      );
    }

    if (execution.cancelled) {
      return { kind: "cancelled" };
    }

    // Both remaining branches (delivered/failed) always carry `outcome`:
    // `execution.cancelled` is the only path executeSession takes without
    // ever invoking `onData`, and `onData` is what both delivery variants
    // above come from.
    const outcome = execution.outcome as TransportOutcome;

    if (execution.delivery?.delivered) {
      return { kind: "delivered", outcome, parsed: execution.delivery.parsed };
    }

    return {
      kind: "failed",
      outcome,
      resolution:
        execution.delivery?.resolution ??
        resolveFailureCause({
          outcome,
          classifyFailure: transport.classifyFailure,
          parseThrew: false,
        }),
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
  | { readonly delivered: false; readonly resolution: CauseResolution };

// D1-08 PR0: `runAttempt`'s result — one attempt's outcome reduced to what
// the retry loop needs to decide what happens next.
// D1-08 PR5b: every variant gains an optional `reservation` — the
// finalized `SpendReservation` for this attempt, present exactly when a
// `SpendLedger` is configured. `runAdmittedAttempt` never sets it (it knows
// nothing about the ledger); only `runAttempt` attaches it once the
// reservation has reached its terminal state.
type AttemptRunResult =
  | { readonly kind: "cancelled"; readonly reservation?: SpendReservation }
  | {
      readonly kind: "delivered";
      readonly outcome: TransportOutcome;
      readonly parsed: unknown;
      readonly reservation?: SpendReservation;
    }
  | {
      readonly kind: "failed";
      readonly outcome: TransportOutcome;
      readonly resolution: CauseResolution;
      readonly reservation?: SpendReservation;
    };
