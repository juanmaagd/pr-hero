// Step-level headless engine spawn — the v2 descendant of deep-review's
// runner/session.ts. v1 spawned ONE Claude Code session and let an
// orchestrator prompt fan out hunters via the Task tool; v2 spawns one
// session PER STEP (hunter/refuter) and the driver owns the orchestration.
// Every isolation flag and retry mechanism here encodes a paid-for failure
// from v1 — port, don't rewrite.

import path from "node:path";
import type {
  AuthEvent,
  DenialCode,
  ExecutableAllowlistEntry,
  StepAdmissionGate,
} from "./execution/contracts";
import { StepExecutionHarness } from "./execution/harness";
import type { NormalizedUsage } from "./execution/usage-normalized";
import type { CredentialBroker } from "./security/credential-broker";
import type { SessionUsage } from "./usage";

export interface StepSpec {
  // "hunter-reliability" | "hunter-resilience" | "hunter-parity" | "refuter"
  name: string;
  // Driver-templated file in the run dir (audit artifact).
  systemPromptPath: string;
  // User message: diff, hop budget, batch path, output contract.
  prompt: string;
  // From agent frontmatter.
  tools: string[];
  // Codegraph-only mcp.json.
  mcpConfigPath: string;
  model: string;
  cwd: string;
  outPath: string;
  // Per-step watchdog; the default (30 min) lives with the caller.
  timeoutMs: number;
  // Transient-only bound (default 2); the format-retry is additional.
  maxAttempts: number;
  // throw = not delivered (v1's draftDelivered role, applied per step).
  parse(finalText: string): unknown;
  // OBSERVATION ONLY. Called just before a retry is spawned, so a retrying
  // step stops looking merely slow — `attempts` was already counted, but only
  // after the fact in PerAgentUsage, which is a post-mortem, not a signal.
  // Nothing here may change retry behavior: no return value is read, and a
  // throwing callback is swallowed (the same rule pipeline.ts's emit() keeps
  // — a cosmetic listener must never kill a paid run).
  onRetry?(info: RetryInfo): void;
  // Stage-2 fields — typed now so specs stay forward-compatible, UNUSED in
  // Stage 1: `backend` selects the runner, `models` fans one spec out to
  // `<step>__<model-slug>` legs sharing a groupId.
  backend?: "claude-code" | "opencode";
  models?: string[];
}

export interface RetryInfo {
  // Step name, e.g. "hunter-reliability" or "refuter-F001".
  step: string;
  // The attempt about to START (1-based).
  attempt: number;
  // The transient budget. Meaningless for `reason: "format"` — that retry has
  // its own cap of exactly one, so a renderer must not print "N of M" there.
  maxAttempts: number;
  reason: RetryFailureClass;
}

export interface StepResult {
  name: string;
  status: "ok" | "failed";
  denialCode?: DenialCode;
  output?: unknown;
  // Legacy flat shape (§8's ONLY consumer boundary: `../deep-review/runner/
  // telemetry.ts` reads `runPipeline()`'s returned `usage` by these field
  // names). Projected from `usageV2` via `projectLegacyUsage`, never hand-built.
  usage: SessionUsage;
  // D1-08 PR2: the normalized disjoint leaves this step's attempts actually
  // reported, summed across attempts. Absent when no attempt ever spawned
  // (a pre-spawn denial, a construction failure) — those cases are genuine
  // zero cost, not "unavailable", and carry no v2 record at all.
  usageV2?: NormalizedUsage;
  attempts: number;
  stderrTail: string;
  resultText: string;
}

export interface StepRunner {
  run(step: StepSpec): Promise<StepResult>;
}

// Where a step's per-attempt artifacts land, derived from its `outPath` — part
// of the RUNNER CONTRACT, not a harness implementation detail, because two
// modules now depend on the answer: the harness writes the files, and
// pipeline.ts indexes them from `pipeline.json` (D1-10c). Deriving the names
// twice is how a pointer starts naming a file that was never written — the
// exact defect the harness's own comment records ("a hardcoded settlement.json
// in a cancellation message pointed at a file that never existed for as long as
// it shipped"), so both callers read the shape from here.
//
// `attempt` is the 1-based attempt NUMBER, which for a settled step equals
// `StepResult.attempts`: the transient loop and the one format retry both
// increment the same counter, and the format retry always ends the loop.
export function attemptLogPath(
  outPath: string,
  stepName: string,
  attempt: number,
): string {
  return path.join(path.dirname(outPath), "logs", `${stepName}.${attempt}.log`);
}

export function settlementReceiptPath(
  outPath: string,
  stepName: string,
  attempt: number,
): string {
  return path.join(
    path.dirname(outPath),
    `settlement.${stepName}.attempt${attempt}.json`,
  );
}

export const DEFAULT_STEP_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_STEP_MAX_ATTEMPTS = 2;

export const FORMAT_RETRY_REMINDER =
  "\n\nREMINDER: your final message must be exactly one JSON object " +
  "matching the mandated shape — no prose, no fences.";

export function isTransientSessionFailure(result: {
  stderrTail: string;
  resultText: string;
}): boolean {
  const witness = `${result.stderrTail}\n${result.resultText}`;
  return /API Error|Connection closed|ECONNRESET|socket hang up|timed out|502|503|529|overloaded/i.test(
    witness,
  );
}

export function isTerminalSessionFailure(result: {
  stderrTail: string;
  resultText: string;
}): boolean {
  const witness = `${result.stderrTail}\n${result.resultText}`;
  return /Not logged in\s*[·.]\s*Please run \/login/i.test(witness);
}

export type FailureClass = "transient" | "terminal" | "format";
export type RetryFailureClass = Exclude<FailureClass, "terminal">;

export function classifyFailure(outcome: {
  stderrTail: string;
  resultText: string;
  timedOut: boolean;
}): FailureClass {
  if (outcome.timedOut) return "transient";
  if (isTerminalSessionFailure(outcome)) return "terminal";
  return isTransientSessionFailure(outcome) ? "transient" : "format";
}

export function buildStepArgv(
  step: StepSpec,
  prompt: string = step.prompt,
): string[] {
  return [
    "claude",
    "-p",
    prompt,
    "--append-system-prompt-file",
    step.systemPromptPath,
    "--output-format",
    "json",
    "--mcp-config",
    step.mcpConfigPath,
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--tools",
    step.tools.join(","),
    "--permission-mode",
    "bypassPermissions",
    "--model",
    step.model,
  ];
}

export interface SpawnedProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export const ACTIVE_CHILD_PROCS = new Set<SpawnedProcess>();

export function killAllChildProcesses(): void {
  for (const proc of ACTIVE_CHILD_PROCS) {
    try {
      proc.kill();
    } catch {
      // Swallowed — process may have already exited
    }
  }
  ACTIVE_CHILD_PROCS.clear();
}

export interface ClaudeCodeRunnerOptions {
  spawnFn?: typeof Bun.spawn;
  workspaceRoot?: string;
  executableAllowlist?: readonly ExecutableAllowlistEntry[];
  binaryPath?: string;
  admissionGate?: StepAdmissionGate;
  onAuthEvent?: (event: AuthEvent) => void;
  // §6.1 D1-05 credential projection; forwarded to the harness.
  credentialBroker?: CredentialBroker;
  // §5.3 D1-10b: the pipeline ceiling's cancellation signal. This is the ONLY
  // entry point to the harness's §5.3 sequence (no new attempts, lease fence,
  // abort, bounded grace) — the whole sequence shipped implemented and
  // unreachable because this option was missing here, so nothing in src/ ever
  // handed the harness a signal.
  signal?: AbortSignal;
}

export class ClaudeCodeRunner implements StepRunner {
  private readonly harness: StepExecutionHarness;

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.harness = new StepExecutionHarness({
      workspaceRoot: options.workspaceRoot,
      executableAllowlist: options.executableAllowlist,
      binaryPath: options.binaryPath,
      admissionGate: options.admissionGate,
      onAuthEvent: options.onAuthEvent,
      credentialBroker: options.credentialBroker,
      spawnFn: options.spawnFn,
      signal: options.signal,
    });
  }

  async run(step: StepSpec): Promise<StepResult> {
    return this.harness.run(step);
  }
}
