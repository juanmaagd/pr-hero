// Step-level headless engine spawn — the v2 descendant of deep-review's
// runner/session.ts. v1 spawned ONE Claude Code session and let an
// orchestrator prompt fan out hunters via the Task tool; v2 spawns one
// session PER STEP (hunter/refuter) and the driver owns the orchestration.
// Every isolation flag and retry mechanism here encodes a paid-for failure
// from v1 — port, don't rewrite.

import { rename } from "node:fs/promises";
import path from "node:path";
import { parseUsage, type SessionUsage, sumUsage, zeroUsage } from "./usage";

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
  output?: unknown;
  usage: SessionUsage;
  attempts: number;
  stderrTail: string;
  resultText: string;
}

// Doc-contract for Stage 2: any OpenCodeRunner implementing this interface
// inherits these obligations (each one maps to a v1 lesson that must not be
// re-learned on the new backend):
//   - config isolation: an analog of `--setting-sources ""` — the spawned
//     session must see none of the user's global config, hooks, or memory.
//   - completion detection: event-stream + polling, never one blocking HTTP
//     call that can sit on a dead socket forever.
//   - a VERIFIED terminal message — never assume the last chunk seen is the
//     final answer.
//   - total-wins usage accounting: report the run's aggregate, and sum
//     across attempts (failed attempts still cost money).
//   - a transient classifier PER BACKEND: v1's witness regexes are
//     Claude-CLI-shaped and do not transfer.
export interface StepRunner {
  run(step: StepSpec): Promise<StepResult>;
}

// Measured envelope for a healthy v1 replay was 1.7–26 min for the WHOLE
// orchestration; a single v2 step is a strict subset of that work, so 30 min
// is already generous. A step past its ceiling is not slow, it is hung: an
// overnight A/B lost its whole arm A to one session that sat on a dead
// socket for 3h09m at 0.1% CPU while the driver waited forever. Unattended
// runs need a ceiling more than they need patience.
export const DEFAULT_STEP_TIMEOUT_MS = 30 * 60 * 1000;

// Transient API failures are real and they cluster: three of arm B's five
// replays died the same night with "API Error: Connection closed
// mid-response", each leaving a partial run with zero findings. One retry
// converts an unusable hole into a usable data point; more than one risks
// masking a genuine engine failure, which must stay visible as `partial`.
export const DEFAULT_STEP_MAX_ATTEMPTS = 2;

// The format-retry is capped at ONE per step, separate from maxAttempts:
// a hunter that chats instead of emitting JSON burns the step otherwise —
// its failure is deterministic, so a transient-style retry loop would just
// spend the same tokens on the same prose. One explicit reminder is the
// cheapest recoverable path; a second failure means the contract itself is
// confused and must surface as a failed step, not be papered over.
export const FORMAT_RETRY_REMINDER =
  "\n\nREMINDER: your final message must be exactly one JSON object " +
  "matching the mandated shape — no prose, no fences.";

// Answers only "does this witness look like infrastructure?" — deliberately
// NOT "did the run succeed?". The arm-B failures exited ZERO with the API
// error in their result text, so exit code cannot be trusted here. Whether a
// run needs retrying at all is decided by its caller, which checks parse()
// delivery first; that ordering also stops a successful run whose final
// message happens to mention "API error" from being retried.
export function isTransientSessionFailure(result: {
  stderrTail: string;
  resultText: string;
}): boolean {
  const witness = `${result.stderrTail}\n${result.resultText}`;
  return /API Error|Connection closed|ECONNRESET|socket hang up|timed out|502|503|529|overloaded/i.test(
    witness,
  );
}

// Authentication is an operator-actionable terminal condition. Retrying with
// either the format reminder or the transient budget cannot create a login.
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
  // A watchdog kill is infrastructure, not a formatting mistake: the session
  // hung, it did not chat.
  if (outcome.timedOut) return "transient";
  if (isTerminalSessionFailure(outcome)) return "terminal";
  return isTransientSessionFailure(outcome) ? "transient" : "format";
}

// Pure argv builder, exported so the contamination-posture tests can assert
// every isolation flag verbatim without spawning anything.
export function buildStepArgv(
  step: StepSpec,
  prompt: string = step.prompt,
): string[] {
  return [
    "claude",
    "-p",
    prompt,
    // The step instructions are injected as SYSTEM PROMPT, never as a file
    // the session is asked to read and obey: a Read-me-and-comply bootstrap
    // of a gated skill file triggered principled refusals ("self-authorizing
    // file"), nondeterministically. The system prompt is the legitimately
    // authoritative channel, and the file lives run-dir-side as an audit
    // artifact the PR can review.
    "--append-system-prompt-file",
    step.systemPromptPath,
    "--output-format",
    "json",
    // LOAD-BEARING contamination enforcer: `--strict-mcp-config` makes the
    // spawned session ignore every other MCP source (project `.mcp.json`,
    // user-level config) so `gh`/Engram are unreachable, not merely
    // un-instructed.
    "--mcp-config",
    step.mcpConfigPath,
    "--strict-mcp-config",
    // EMPTY setting sources: `--setting-sources user` leaked the Engram
    // SessionStart hook's memory dump and the interactive persona into
    // replays — a contamination channel and the cause of nondeterministic
    // refusals. (`--bare` would be stronger but also skips the stored login,
    // dying with "Not logged in".)
    // Deliberate delta from v1: NO `--agents` — v1 needed the inline agent
    // registry because no setting sources also meant no user agent registry
    // and its orchestrator spawned hunters via Task; in v2 each agent IS the
    // session, its body arriving via --append-system-prompt-file.
    "--setting-sources",
    "",
    // Deliberate delta from v1: no Write/Task grants. v1's orchestrator
    // needed Write to deliver its draft file and Task to spawn hunters; in
    // v2 the driver owns ALL file writes (the final message is the delivery
    // channel) and there are no subagents, so a step gets exactly its
    // frontmatter tools.
    "--tools",
    step.tools.join(","),
    "--permission-mode",
    // Unattended benchmark loop; the tool allow-list is the real boundary,
    // not prompts.
    "bypassPermissions",
    "--model",
    step.model,
  ];
}

// A throwing observer is swallowed HERE, in the runner, not only in whatever
// wires it: StepSpec is a public interface other callers implement against,
// and "the progress panel cannot kill a paid step" must hold whoever wired the
// callback.
function notifyRetry(step: StepSpec, info: RetryInfo): void {
  if (!step.onRetry) return;
  try {
    step.onRetry(info);
  } catch {
    // Swallowed — see above.
  }
}

// The minimal surface this runner needs from a spawned process — lets tests
// inject a scripted fake for the retry/watchdog paths (untested in v1).
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

interface AttemptOutcome {
  usage: SessionUsage;
  exitCode: number;
  timedOut: boolean;
  // The FULL `result` string from the JSON envelope — NEVER sliced before
  // parse. The 8192/4096 slices below apply ONLY to the stored log tails
  // (`resultText`/`stderrTail`): a multi-finding draft easily exceeds 8KB,
  // and truncating the parse input would misclassify delivered drafts as
  // not-delivered and burn retries deterministically (JD finding).
  fullResult: string;
  stderrTail: string;
  resultText: string;
}

type Delivery = { delivered: true; output: unknown } | { delivered: false };

export class ClaudeCodeRunner implements StepRunner {
  private readonly spawnFn: typeof Bun.spawn;

  constructor(options: { spawnFn?: typeof Bun.spawn } = {}) {
    this.spawnFn = options.spawnFn ?? Bun.spawn;
  }

  async run(step: StepSpec): Promise<StepResult> {
    let usage = zeroUsage();
    let attempts = 0;
    let last: AttemptOutcome | undefined;

    for (let attempt = 1; attempt <= step.maxAttempts; attempt++) {
      attempts++;
      last = await this.runAttempt(step, step.prompt);
      usage = sumUsage(usage, last.usage);
      // v1 ordering, preserved: delivered-check FIRST, transient-check
      // second. A run that produced a parseable final message is done,
      // however ugly the exit was — the pipeline validates the contents
      // itself, so never spend a second attempt on it. This also stops a
      // successful run whose text mentions "API error" from being retried.
      const parsed = deliver(step, last);
      if (parsed.delivered) {
        await writeAttemptLog(step, attempts, "attempt", last, "ok");
        return this.succeed(step, parsed.output, usage, attempts, last);
      }
      const failure = classifyFailure(last);
      await writeAttemptLog(step, attempts, "attempt", last, failure);
      if (failure === "transient") {
        // Clear a stale artifact so the retry cannot be fooled by its own
        // debris.
        await Bun.file(step.outPath)
          .unlink()
          .catch(() => {});
        // Announced only when a retry will actually happen: on the last
        // attempt the loop falls through to "failed" and there is nothing to
        // watch for.
        if (attempt < step.maxAttempts) {
          notifyRetry(step, {
            step: step.name,
            attempt: attempt + 1,
            maxAttempts: step.maxAttempts,
            reason: "transient",
          });
        }
        continue; // exhausting maxAttempts falls through to "failed"
      }
      if (failure === "terminal") break;
      // Non-transient parse failure: the model delivered SOMETHING, just not
      // the mandated shape — one format-retry (cap 1, see the rationale on
      // FORMAT_RETRY_REMINDER), then the step fails visibly.
      attempts++;
      notifyRetry(step, {
        step: step.name,
        attempt: attempts,
        maxAttempts: step.maxAttempts,
        reason: "format",
      });
      const retry = await this.runAttempt(
        step,
        step.prompt + FORMAT_RETRY_REMINDER,
      );
      usage = sumUsage(usage, retry.usage);
      last = retry;
      const retried = deliver(step, retry);
      await writeAttemptLog(
        step,
        attempts,
        "format-retry",
        retry,
        retried.delivered ? "ok" : classifyFailure(retry),
      );
      if (retried.delivered) {
        return this.succeed(step, retried.output, usage, attempts, retry);
      }
      break; // format-retry exhausted — never loops
    }

    return {
      name: step.name,
      status: "failed",
      usage,
      attempts,
      stderrTail: last?.stderrTail ?? "",
      resultText: last?.resultText ?? "",
    };
  }

  private async succeed(
    step: StepSpec,
    output: unknown,
    usage: SessionUsage,
    attempts: number,
    last: AttemptOutcome,
  ): Promise<StepResult> {
    await writeArtifactAtomically(step.outPath, output);
    return {
      name: step.name,
      status: "ok",
      output,
      usage,
      attempts,
      stderrTail: last.stderrTail,
      resultText: last.resultText,
    };
  }

  private async runAttempt(
    step: StepSpec,
    prompt: string,
  ): Promise<AttemptOutcome> {
    const args = buildStepArgv(step, prompt);
    const start = performance.now();
    const proc = this.spawnFn(args, {
      cwd: step.cwd,
      stdout: "pipe",
      stderr: "pipe",
    }) as unknown as SpawnedProcess;
    ACTIVE_CHILD_PROCS.add(proc);
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      console.error(
        `step ${step.name} exceeded ${step.timeoutMs / 60000} min, killing it`,
      );
      proc.kill();
    }, step.timeoutMs);
    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
    } finally {
      ACTIVE_CHILD_PROCS.delete(proc);
      clearTimeout(watchdog);
    }
    const wall_ms = Math.round(performance.now() - start);
    let fullResult = "";
    try {
      fullResult = (JSON.parse(stdout) as { result?: string }).result ?? "";
    } catch {
      // Non-JSON stdout is already handled by parseUsage's zero fallback;
      // an empty fullResult makes parse() throw, which is the point.
    }
    return {
      usage: parseUsage(stdout, wall_ms),
      exitCode,
      timedOut,
      fullResult,
      stderrTail: stderr.slice(-4096),
      resultText: fullResult.slice(-8192),
    };
  }
}

function deliver(step: StepSpec, outcome: AttemptOutcome): Delivery {
  try {
    // FULL result in — never the sliced tail (see AttemptOutcome.fullResult).
    return { delivered: true, output: step.parse(outcome.fullResult) };
  } catch {
    return { delivered: false };
  }
}

// tmp file + rename: a kill mid-write must never leave a truncated artifact
// that satisfies an exists() check — v1's draftDelivered() existed precisely
// to detect that hole after the fact; writing atomically closes it at the
// source. The artifact either exists complete or not at all.
async function writeArtifactAtomically(
  outPath: string,
  output: unknown,
): Promise<void> {
  const tmpPath = `${outPath}.tmp`;
  await Bun.write(tmpPath, `${JSON.stringify(output, null, 2)}\n`);
  await rename(tmpPath, outPath);
}

// One log per attempt, next to the artifact: when a shadow replicate goes
// wrong at 3am, the run dir must already contain the evidence.
async function writeAttemptLog(
  step: StepSpec,
  attempt: number,
  kind: "attempt" | "format-retry",
  outcome: AttemptOutcome,
  classification: "ok" | FailureClass,
): Promise<void> {
  const logPath = path.join(
    path.dirname(step.outPath),
    "logs",
    `${step.name}.${attempt}.log`,
  );
  await Bun.write(
    logPath,
    [
      `step: ${step.name}`,
      `attempt: ${attempt}`,
      `kind: ${kind}`,
      `exit_code: ${outcome.exitCode}`,
      `timed_out: ${outcome.timedOut}`,
      `classification: ${classification}`,
      "--- stderr tail (4096) ---",
      outcome.stderrTail,
      "--- result tail (8192) ---",
      outcome.resultText,
      "",
    ].join("\n"),
  );
}
