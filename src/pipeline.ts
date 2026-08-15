// orchestrator-prompt.md Steps 1-8 as driver code. v1 delegated this whole
// sequence to prose inside one Claude session; v2 keeps every decision that
// was ever "yours alone" in the prose (parity trigger, dedupe, tiering,
// assembly) deterministic and testable here, and spends model tokens only on
// the hunts and the refutation themselves.

import path from "node:path";
import {
  type DedupedSurvivor,
  type DedupeLoser,
  mergeAndDedupe,
} from "./dedupe";
import {
  type DraftFinding,
  extractJsonObject,
  type HunterDraft,
  type RefuterOutcome,
  type RefuterResult,
  validateHunterDraft,
  validateRefuterResult,
  validateSummary,
} from "./drafts";
import {
  type DebugRefutedFinding,
  deriveTier,
  type Finding,
  type Hunter,
  type RefuterVerdict,
  type RunSummary,
  type SkillOutput,
} from "./findings";
import {
  parseAgentFile,
  renderAgentBody,
  type SuspicionPrior,
} from "./prompt-set";
import { clusterByRootCause, rootCauseIdByFinding } from "./root-cause";
import {
  type AgentSpec,
  defaultReviewSpec,
  type ReviewSpec,
  validateReviewSpec,
} from "./spec";
import {
  DEFAULT_STEP_MAX_ATTEMPTS,
  DEFAULT_STEP_TIMEOUT_MS,
  type StepResult,
  type StepRunner,
  type StepSpec,
} from "./step-runner";
import { type SessionUsage, sumUsage, zeroUsage } from "./usage";

export interface PipelineInput {
  pr: number;
  baseSha: string;
  headSha: string;
  // Where hunters resolve the diff's changed-file list (steps run cwd here).
  worktree: string;
  // The EFFECTIVE diff: whatever is at this path is what every hunter reads,
  // verbatim. The driver filters generated content out before writing it.
  diffPath: string;
  // Provenance only — the paths the driver excluded from that diff. Recorded
  // in pipeline.json so a run's diff.patch can be told apart from its range.
  excludedPaths?: string[];
  gotchasPath: string;
  agentsDir: string;
  runDir: string;
  // Where the CALLER will write the final findings document after merging the
  // run envelope — the pipeline itself never writes it (it returns the
  // SkillOutput draft); carried here so pipeline.json can record the full
  // resolved plan.
  outPath: string;
  mcpConfigPath: string;
  hopBudget: number;
  // Override wins for EVERY step (JD decision: v1's replay `--model` note
  // generalized). Full precedence: input.model > AgentSpec.model > agent
  // frontmatter model.
  model?: string;
  parityTriggerPaths: string[];
  suspicionPriors: SuspicionPrior[];
  // Per-step watchdog; defaults to the runner's 30 min.
  stepTimeoutMs?: number;
  // Whole-pipeline ceiling; defaults to DEFAULT_PIPELINE_TIMEOUT_MS.
  pipelineTimeoutMs?: number;
  // Optional engine-owned summary step. It is deliberately outside ReviewSpec:
  // this prompt is bundled with pr-hero, not part of the benchmarked agent set.
  summarizer?: { promptPath: string; model?: string };
  // Pipeline-as-data: which agents run and how they're wired. Defaults to
  // defaultReviewSpec() — EXACTLY the wiring that used to be hard-coded here,
  // so callers that pass nothing see byte-identical step names, per_agent
  // keys, and parity semantics.
  spec?: ReviewSpec;
}

export interface PipelineDeps {
  runner: StepRunner;
  // Live-progress tap, born from a real incident: the CLI went silent for
  // ~10 minutes mid-run and a PAID run died to a Ctrl-C from a user who
  // reasonably believed it hung. OPTIONAL and observational only — absent
  // means byte-identical behavior, and emission never changes control flow
  // (see emit()).
  onProgress?: (event: PipelineProgressEvent) => void;
}

// What the pipeline is doing, as it does it. `hunter-finished` and
// `refuter-step-finished` fire as EACH parallel step settles, never at the
// join — at the join every event would fire at once at the end, which is
// exactly the silence this exists to break.
// Every field beyond the original five kinds' own is OPTIONAL on purpose: a
// listener written against the older shape keeps compiling, and the pipeline
// stays free to emit an event before it knows the extra (the resolved model,
// a draft count for a hunter that died).
export type PipelineProgressEvent =
  | {
      kind: "hunters-started";
      hunters: string[];
      // key -> the model resolveModel actually chose. Only the pipeline knows
      // it: the CLI sees spec/frontmatter overrides, not the outcome.
      models?: Record<string, string>;
    }
  | {
      kind: "hunter-finished";
      hunter: string;
      ok: boolean;
      durationMs: number;
      // Findings in THIS hunter's draft, pre-dedupe. Absent for a failed step
      // — there is no draft to count.
      drafts?: number;
    }
  | { kind: "dedupe-finished"; drafts: number; findings: number }
  | {
      kind: "refuter-started";
      severeFindings: number;
      // The submitted batch, so a renderer can show the leg's full shape
      // before the first verdict lands (the count alone cannot name a leaf).
      findings?: Array<{ id: string; location: string }>;
    }
  | {
      kind: "refuter-step-finished";
      findingId: string;
      verdict: string;
      durationMs: number;
    }
  | {
      kind: "summarizer-finished";
      ok: boolean;
      durationMs: number;
    }
  // A step about to be retried. Until this existed a retrying hunter looked
  // merely slow: `attempts` was counted in PerAgentUsage after the fact, which
  // is a post-mortem, never a live signal. OBSERVATION ONLY — the runner's
  // retry ordering, budgets and watchdog numbers are untouched.
  | {
      kind: "step-retry";
      // Step name, e.g. "hunter-reliability" or "refuter-F001".
      step: string;
      attempt: number;
      // The transient budget; meaningless when reason is "format" (that retry
      // is capped at exactly one, separately).
      maxAttempts: number;
      reason: "transient" | "format";
    };

// A throwing callback is swallowed ON PURPOSE: the review outranks the
// progress bar, and a cosmetic listener must never be able to kill a paid
// run.
function emit(deps: PipelineDeps, event: PipelineProgressEvent): void {
  if (!deps.onProgress) return;
  try {
    deps.onProgress(event);
  } catch {
    // Swallowed — see above.
  }
}

export interface PerAgentUsage {
  tokens_total: number;
  duration_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd_est: number;
  attempts: number;
  status: string;
}

export interface PipelineResult {
  skillOutput: SkillOutput;
  // Keyed by AgentSpec.key — with the default spec that is exactly
  // reliability | resilience | parity | refuter.
  perAgent: Record<string, PerAgentUsage>;
  usage: SessionUsage;
  // True only when ALL hunter steps failed — nothing was hunted. A single
  // hunter failure is a partial run (prose Step 4: "proceed with whatever
  // hunters did complete"), never a session failure.
  sessionFailed: boolean;
}

// JD-derived arithmetic: v1's 45-min ceiling covered ONE session doing
// everything; v2 runs the hunters in parallel (worst case 2 transient
// attempts x 30-min watchdog = 60 min for the slowest lane) FOLLOWED by a
// sequential refuter leg, so 45 no longer bounds the honest worst case.
// 60 + 15 min of refuter/assembly headroom = 75.
export const DEFAULT_PIPELINE_TIMEOUT_MS = 75 * 60 * 1000;

// Prose Step 3's changed-path extraction: `+++ b/<path>` headers carry the
// post-image path of every modified/added file; pure renames have no hunk
// headers at all, so `rename to <path>` lines are read too. Deletions show
// `+++ /dev/null` and are skipped — a deleted file cannot trigger parity.
export function changedPathsFromDiff(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split("\n")) {
    let candidate: string | undefined;
    if (line.startsWith("+++ b/")) candidate = line.slice("+++ b/".length);
    else if (line.startsWith("rename to "))
      candidate = line.slice("rename to ".length);
    if (candidate && !paths.includes(candidate)) paths.push(candidate);
  }
  return paths;
}

// CONTAINS-COMPATIBLE glob matching (JD finding): the prose rules say "path
// contains AbortFileMultipartUpload" but the config encodes that rule as the
// glob `**/AbortFileMultipartUpload*`, where `*` does not cross `/` — so the
// glob alone misses `src/AbortFileMultipartUpload/index.ts`, a path the prose
// unambiguously matches. A pattern therefore matches when the glob matches OR
// when its base token (the pattern stripped of `**/` segments, a trailing
// `/**`, and `*` wildcards) is a substring of the path. Config globs stay the
// single source of truth; this reconciles their semantics with the prose.
export function parityTriggered(
  changedPaths: string[],
  patterns: string[],
): boolean {
  return patterns.some((pattern) => {
    const glob = new Bun.Glob(pattern);
    const baseToken = pattern
      .replace(/\*\*\//g, "")
      .replace(/\/\*\*$/, "/")
      .replaceAll("*", "");
    return changedPaths.some(
      (p) => glob.match(p) || (baseToken.length > 0 && p.includes(baseToken)),
    );
  });
}

// Prose Step 4/8 phrasing turned into the engine-owned output contract. This
// text is driver source: it is covered by the engine version, NOT by the
// prompt-set fingerprint.
const HUNTER_OUTPUT_CONTRACT = [
  "Your final message must be exactly one JSON object — no prose, no code",
  'fences — of the shape {"findings":[...]}. Each finding carries: id,',
  "category (1-14), path, line, symbol (optional), severity",
  "(BLOCKER|CRITICAL|WARNING|SUGGESTION), evidence_class",
  "(deterministic|inferential|insufficient), causal_disposition",
  "(introduced|behavior-activated|worsened|pre-existing|base-only|unknown),",
  "claim, proof_refs (array of strings), hunter, hops_used, hop_trail,",
  "dedupe_key (path:symbol:category). If nothing survives scrutiny, return",
  '{"findings":[]} — an empty array is a valid, expected result, not a',
  "failure.",
].join("\n");

const REFUTER_OUTPUT_CONTRACT = [
  "Your final message must be exactly one JSON object — no prose, no code",
  'fences — of the shape {"results":[{"finding_id":"...","outcome":',
  '"corroborated|refuted|downgraded-latent|inconclusive","proof_refs":',
  '["..."]}]} with exactly one verdict per submitted finding id — never',
  "implied, never extra.",
].join("\n");

const SUMMARY_OUTPUT_CONTRACT = [
  "Your final message must be exactly one JSON object — no prose, no code",
  'fences — of the shape {"prose":"...","score":1,"score_reason":"..."}.',
  "The prose is 2-4 general sentences about the change, not a finding list.",
  "The score is an integer from 1 through 5 and is advisory prose only.",
  "The score_reason is 1-2 sentences explaining that advisory score.",
].join("\n");

function hunterPrompt(patch: string, hopBudget: number): string {
  return [
    patch,
    "",
    `Hop budget: ${hopBudget}`,
    "",
    // Ported prose Step 4 wording: the hop counters are the hunter's own
    // claim, and telemetry can contradict them.
    "`hops_used` and `hop_trail` are self-reported and may be cross-checked",
    "against this run's telemetry MCP-call counts.",
    "",
    HUNTER_OUTPUT_CONTRACT,
  ].join("\n");
}

function summarizerPrompt(patch: string): string {
  return [patch, "", SUMMARY_OUTPUT_CONTRACT].join("\n");
}

function refuterPrompt(batchJson: string): string {
  return [
    "Refute or corroborate this finding:",
    "",
    batchJson,
    "",
    "Decide one of `corroborated`, `refuted`, `downgraded-latent`, or",
    "`inconclusive` against the code in this worktree.",
    "",
    // The engine states the semantics because the tier consequences are the
    // engine's, not the prompt set's: `refuted` DELETES the finding, so it
    // demands positive disproof; `downgraded-latent` keeps it and demotes it
    // to advisory. Without this line a reviewer facing a real defect in
    // unreachable code has only the two wrong doors — delete it, or block a
    // merge on it.
    "`refuted` means the code positively contradicts the claim — cite the",
    "contradicting lines. `downgraded-latent` means the claim is a REAL defect",
    "that nothing can execute at this commit (no caller wires it up yet, the",
    "branch is unreachable by construction): it is kept and recorded, never",
    "deleted, but it will not block a merge. `inconclusive` means you could",
    "not tell — it is not a polite `refuted`.",
    "",
    REFUTER_OUTPUT_CONTRACT,
  ].join("\n");
}

// A conditional hunter's trigger, resolved against the ReviewSpec: the
// "input" sentinel reads PipelineInput.parityTriggerPaths (the trigger PATHS
// stay lab config; the spec only wires "this hunter is conditional").
function triggerPatterns(agent: AgentSpec, input: PipelineInput): string[] {
  return agent.trigger === "input"
    ? input.parityTriggerPaths
    : (agent.trigger ?? []);
}

// pipeline.json row: the resolved plan sans prompts (frozen-plan provenance —
// which steps ran, with which model and tool surface, writing where).
interface StepMeta {
  name: string;
  model: string;
  tools: string[];
  systemPromptPath: string;
  outPath: string;
  status?: "ok" | "failed";
}

// Mutated as steps complete so the pipeline-ceiling path can assemble
// whatever exists at the moment the ceiling fires.
interface RunState {
  parityFired: boolean;
  hunterCount: number;
  hunterFailures: number;
  drafts: DraftFinding[];
  survivors?: DedupedSurvivor[];
  deduped?: DedupeLoser[];
  verdicts: Map<string, RefuterOutcome>;
  partial: boolean;
  summary?: RunSummary;
  perAgent: Record<string, PerAgentUsage>;
  usageTotal: SessionUsage;
  steps: StepMeta[];
}

export async function runPipeline(
  input: PipelineInput,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const state: RunState = {
    parityFired: false,
    hunterCount: 0,
    hunterFailures: 0,
    drafts: [],
    verdicts: new Map(),
    partial: false,
    perAgent: {},
    usageTotal: zeroUsage(),
    steps: [],
  };
  // Pipeline ceiling: on firing, return what is assembled so far with
  // run_status "partial". The in-flight step promises are abandoned, not
  // awaited — the runner's own per-step watchdogs will reap the processes.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<PipelineResult>((resolve) => {
    timer = setTimeout(() => {
      state.partial = true;
      resolve(finish(input, state));
    }, input.pipelineTimeoutMs ?? DEFAULT_PIPELINE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([execute(input, deps, state), ceiling]);
  } finally {
    clearTimeout(timer);
  }
}

async function execute(
  input: PipelineInput,
  deps: PipelineDeps,
  state: RunState,
): Promise<PipelineResult> {
  // Step 2 — gotchas fail-loud. Missing or empty gotchas is a deliberate,
  // visible failure signal: run_status "partial" with zero findings is
  // distinguishable from a legitimate "hunters ran, found nothing" complete
  // run. Never silently proceed as if gotchas were simply empty — no step is
  // spawned. sessionFailed stays false: no hunter FAILED, none ever ran.
  const gotchasFile = Bun.file(input.gotchasPath);
  const gotchas = (await gotchasFile.exists()) ? await gotchasFile.text() : "";
  if (gotchas.trim().length === 0) {
    return {
      skillOutput: {
        findings: [],
        debug: { refuted: [] },
        parity_hunter_fired: false,
        run_status: "partial",
      },
      perAgent: {},
      usage: zeroUsage(),
      sessionFailed: false,
    };
  }

  // The DAG wiring is data (see spec.ts). The default spec is re-validated
  // too — it is cheap and keeps a drifted default failing loudly.
  const reviewSpec = validateReviewSpec(input.spec ?? defaultReviewSpec());

  // Step 3 — deterministic trigger evaluation. This decision is the driver's
  // alone; a conditional hunter never self-triggers. An unconditional hunter
  // (no trigger) always runs; a conditional one runs only when a changed path
  // matches its patterns. `parityFired` keeps its lab-facing meaning: true
  // when ANY conditional hunter actually ran — with the default spec that is
  // exactly the old "parity hunter fired" semantics.
  const patch = await Bun.file(input.diffPath).text();
  const changedPaths = changedPathsFromDiff(patch);
  const hunters = reviewSpec.agents.filter(
    (a) =>
      a.role === "hunter" &&
      (a.trigger === undefined ||
        parityTriggered(changedPaths, triggerPatterns(a, input))),
  );
  state.parityFired = hunters.some((a) => a.trigger !== undefined);

  // Step 4 — hunter fan-out.
  const stepsDir = path.join(input.runDir, "steps");
  const stepTimeoutMs = input.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  // validateReviewSpec pins hunter keys inside the findings-schema Hunter
  // enum (v1.0.0 constraint), so the cast below is checked, not assumed.
  const hunterSpecs: Array<{ key: Hunter; spec: StepSpec }> = [];
  for (const hunter of hunters) {
    const agent = await parseAgentFile(path.join(input.agentsDir, hunter.file));
    const name = `hunter-${hunter.key}`;
    const systemPromptPath = path.join(stepsDir, `${name}.system.md`);
    // The rendered body is written run-dir-side as an audit artifact: the
    // exact system prompt each step saw survives next to its draft.
    await Bun.write(
      systemPromptPath,
      renderAgentBody(agent.body, { priors: input.suspicionPriors, gotchas }),
    );
    const spec: StepSpec = {
      name,
      systemPromptPath,
      prompt: hunterPrompt(patch, input.hopBudget),
      tools: agent.tools,
      mcpConfigPath: input.mcpConfigPath,
      model: resolveModel(input, hunter.model, agent.model, hunter.file),
      cwd: input.worktree,
      outPath: path.join(stepsDir, `${name}.draft.json`),
      timeoutMs: stepTimeoutMs,
      maxAttempts: DEFAULT_STEP_MAX_ATTEMPTS,
      parse: (finalText) => {
        const extracted = extractJsonObject(finalText);
        if (extracted === undefined) {
          throw new Error(`${name} final message has no JSON object`);
        }
        // Stamp `hunter` BEFORE validation: the driver owns this field and
        // overwrites it unconditionally below, so a hunter self-reporting its
        // agent name (fixture eval, first live run) must not fail delivery on
        // a value the pipeline was about to discard anyway.
        const candidate = extracted as { findings?: unknown };
        if (Array.isArray(candidate.findings)) {
          for (const f of candidate.findings) {
            if (typeof f === "object" && f !== null) {
              (f as Record<string, unknown>).hunter = hunter.key;
            }
          }
        }
        return validateHunterDraft(extracted);
      },
      // Observational tap only; emit() swallows a throwing listener.
      onRetry: (info) => emit(deps, { kind: "step-retry", ...info }),
    };
    hunterSpecs.push({ key: hunter.key as Hunter, spec });
    state.steps.push(stepMeta(spec));
  }

  let summarizerSpec: StepSpec | undefined;
  let summarizerMeta: StepMeta | undefined;
  let summarizerConstructionFailed = false;
  if (input.summarizer) {
    const name = "summarizer";
    const systemPromptPath = path.join(stepsDir, `${name}.system.md`);
    const outPath = path.join(stepsDir, `${name}.summary.json`);
    summarizerMeta = {
      name,
      model: input.summarizer.model ?? input.model ?? "unresolved",
      tools: [],
      systemPromptPath,
      outPath,
    };
    try {
      const agent = await parseAgentFile(input.summarizer.promptPath);
      await Bun.write(systemPromptPath, agent.body);
      summarizerMeta.model = resolveModel(
        input,
        input.summarizer.model,
        agent.model,
        input.summarizer.promptPath,
      );
      summarizerMeta.tools = agent.tools;
      summarizerSpec = {
        name,
        systemPromptPath,
        prompt: summarizerPrompt(patch),
        tools: agent.tools,
        mcpConfigPath: input.mcpConfigPath,
        model: summarizerMeta.model,
        cwd: input.worktree,
        outPath,
        // The summary is a cosmetic barrier ahead of dedupe/refutation. It
        // must not inherit the 30-minute hunter watchdog or its retry budget.
        timeoutMs: 5 * 60 * 1000,
        maxAttempts: 1,
        parse: (finalText) => {
          const extracted = extractJsonObject(finalText);
          if (extracted === undefined) {
            throw new Error("summarizer final message has no JSON object");
          }
          return validateSummary(extracted);
        },
        onRetry: (info) => emit(deps, { kind: "step-retry", ...info }),
      };
      state.steps.push(summarizerMeta);
    } catch {
      summarizerMeta.status = "failed";
      state.steps.push(summarizerMeta);
      state.perAgent.summary = failedAgentEntry();
      summarizerConstructionFailed = true;
    }
  }
  state.hunterCount = hunterSpecs.length;
  emit(deps, {
    kind: "hunters-started",
    hunters: hunterSpecs.map(({ key }) => key),
    models: Object.fromEntries(
      hunterSpecs.map(({ key, spec }) => [key, spec.model]),
    ),
  });
  if (summarizerConstructionFailed) {
    emit(deps, {
      kind: "summarizer-finished",
      ok: false,
      durationMs: 0,
    });
  }
  // hunter-finished is attached PER PROMISE, before the join. The handlers
  // are attached to each step's promise ahead of allSettled's own, so each
  // event fires as ITS step settles — while the others are still running.
  const startSummarizer = (): Promise<StepResult> => {
    if (!summarizerSpec) {
      throw new Error("summarizer step was not constructed");
    }
    const startedAt = Date.now();
    const promise = deps.runner.run(summarizerSpec);
    promise.then(
      (result) => {
        state.perAgent.summary = perAgentEntry(result);
        state.usageTotal = sumUsage(state.usageTotal, result.usage);
        if (result.status === "ok") {
          state.summary = result.output as RunSummary;
          if (summarizerMeta) summarizerMeta.status = "ok";
        } else {
          if (summarizerMeta) summarizerMeta.status = "failed";
        }
        emit(deps, {
          kind: "summarizer-finished",
          ok: result.status === "ok",
          durationMs: Date.now() - startedAt,
        });
      },
      () => {
        state.perAgent.summary = failedAgentEntry();
        if (summarizerMeta) summarizerMeta.status = "failed";
        emit(deps, {
          kind: "summarizer-finished",
          ok: false,
          durationMs: Date.now() - startedAt,
        });
      },
    );
    return promise;
  };
  const settled = await Promise.allSettled([
    ...hunterSpecs.map(({ key, spec }) => {
      const startedAt = Date.now();
      const promise = deps.runner.run(spec);
      promise.then(
        (result) => {
          // The draft count is read off the SAME validated output the join
          // below consumes, defensively: a failed step has no output, and the
          // panel must never be the thing that throws here.
          const drafts =
            result.status === "ok"
              ? (result.output as HunterDraft | undefined)?.findings?.length
              : undefined;
          emit(deps, {
            kind: "hunter-finished",
            hunter: key,
            ok: result.status === "ok",
            durationMs: Date.now() - startedAt,
            ...(drafts === undefined ? {} : { drafts }),
          });
        },
        () =>
          emit(deps, {
            kind: "hunter-finished",
            hunter: key,
            ok: false,
            durationMs: Date.now() - startedAt,
          }),
      );
      return promise;
    }),
    ...(summarizerSpec === undefined ? [] : [startSummarizer()]),
  ]);
  for (const [i, entry] of hunterSpecs.entries()) {
    const outcome = settled[i];
    if (!outcome || outcome.status === "rejected") {
      state.perAgent[entry.key] = failedAgentEntry();
      state.hunterFailures++;
      state.partial = true;
      continue;
    }
    const result = outcome.value;
    state.perAgent[entry.key] = perAgentEntry(result);
    state.usageTotal = sumUsage(state.usageTotal, result.usage);
    if (result.status !== "ok") {
      state.hunterFailures++;
      state.partial = true;
      continue;
    }
    for (const finding of (result.output as HunterDraft).findings) {
      // The driver stamps `hunter` to the step that actually produced the
      // draft — removes a self-report failure mode where a hunter claiming
      // another's name corrupts attribution and dedupe diagnostics.
      state.drafts.push({ ...finding, hunter: entry.key });
    }
  }

  // Step 5 — merge + dedupe + renumber (final F00N ids assigned here, before
  // the refuter, so the batch and verdict mapping use canonical ids).
  const { survivors, deduped } = mergeAndDedupe(state.drafts);
  state.survivors = survivors;
  state.deduped = deduped;
  emit(deps, {
    kind: "dedupe-finished",
    drafts: state.drafts.length,
    findings: survivors.length,
  });

  // Step 6 — one refuter batch: every BLOCKER/CRITICAL survivor, whatever its
  // evidence_class. Severity alone is the test, because severity alone decides
  // whether a finding can block a merge, and the refuter is the gate that
  // protects merges.
  //
  // This used to also require `evidence_class === "inferential"`, on the theory
  // that a code-provable claim needs no adversary. The 2026-07-29 AudioTrimmer
  // runs killed that theory with data: 26 of 26 blocking findings across six
  // reviews were `deterministic`, so the batch was empty every single time and
  // the refuter never ran — blocking tier, the one tier that stops a merge,
  // had no adversarial check at all. The label was not wrong (those defects
  // really were locally provable); the filter was.
  const batch = survivors.filter(
    (s) => s.severity === "BLOCKER" || s.severity === "CRITICAL",
  );
  // A spec with no refuter (allowed: "at most one") skips the leg entirely —
  // configured absence, not failure: every finding stays not_submitted (so
  // inferential BLOCKER/CRITICAL findings can never reach blocking tier) and
  // the run stays complete.
  const refuterAgent = reviewSpec.agents.find((a) => a.role === "refuter");
  if (batch.length > 0 && refuterAgent) {
    emit(deps, {
      kind: "refuter-started",
      severeFindings: batch.length,
      findings: batch.map((s) => ({
        id: s.id,
        location: `${s.path}:${s.line}`,
      })),
    });
    await runRefuter(input, deps, state, batch, {
      stepsDir,
      stepTimeoutMs,
      agent: refuterAgent,
    });
  }

  // Steps 7 + 8 live in finish(), shared with the ceiling path.
  return finish(input, state);
}

// ONE STEP PER FINDING, not one batch (ROADMAP A2). The batch shape had a
// failure mode that cost a real smoke tree: `validateRefuterResult` demands the
// returned id set match the submitted set EXACTLY, and on iteration 910's
// `27e85937` the model returned a mismatched set over a 4-finding batch, so the
// whole step was rejected, retried, and finally degraded the run to partial —
// every verdict lost, including the ones it got right. A step that carries a
// single finding cannot return a mismatched id set: the invariant becomes
// unbreakable by construction rather than enforced after the fact.
//
// It also stops one hard finding from poisoning the verdicts of easy ones, and
// it makes the per-finding own-expansion the prompt asks for actually
// affordable — a single claim gets a whole context window instead of a share.
async function runRefuter(
  input: PipelineInput,
  deps: PipelineDeps,
  state: RunState,
  batch: DedupedSurvivor[],
  options: { stepsDir: string; stepTimeoutMs: number; agent: AgentSpec },
): Promise<void> {
  // Kept as the audit manifest of everything submitted this run, even though
  // no single step consumes it: it is how a reader reconstructs what the gate
  // was asked to judge.
  const batchJson = JSON.stringify(
    batch.map((s) => ({
      id: s.id,
      location: `${s.path}:${s.line}`,
      severity: s.severity,
      claim: s.claim,
      proof_refs: s.proof_refs,
    })),
    null,
    2,
  );
  await Bun.write(
    path.join(options.stepsDir, "refuter-batch.json"),
    `${batchJson}\n`,
  );
  const agent = await parseAgentFile(
    path.join(input.agentsDir, options.agent.file),
  );
  // One shared body, written once: every step is the same agent asked about a
  // different finding.
  const systemPromptPath = path.join(options.stepsDir, "refuter.system.md");
  // The refuter body carries no {{PRIORS}}/{{GOTCHAS}} anchors — written
  // as-is, same audit-artifact role as the hunter system prompts.
  await Bun.write(systemPromptPath, agent.body);
  const model = resolveModel(
    input,
    options.agent.model,
    agent.model,
    options.agent.file,
  );
  const specs = batch.map((survivor) => {
    const oneJson = JSON.stringify(
      [
        {
          id: survivor.id,
          location: `${survivor.path}:${survivor.line}`,
          severity: survivor.severity,
          claim: survivor.claim,
          proof_refs: survivor.proof_refs,
        },
      ],
      null,
      2,
    );
    const spec: StepSpec = {
      name: `refuter-${survivor.id}`,
      systemPromptPath,
      // Finding CONTENT inline, not a path: the refuter's tool surface is
      // read-only over the worktree; its work order must arrive in the prompt.
      prompt: refuterPrompt(oneJson),
      tools: agent.tools,
      mcpConfigPath: input.mcpConfigPath,
      model,
      cwd: input.worktree,
      outPath: path.join(
        options.stepsDir,
        `refuter-${survivor.id}.result.json`,
      ),
      timeoutMs: options.stepTimeoutMs,
      maxAttempts: DEFAULT_STEP_MAX_ATTEMPTS,
      parse: (finalText) => {
        const extracted = extractJsonObject(finalText);
        if (extracted === undefined) {
          throw new Error("refuter final message has no JSON object");
        }
        return validateRefuterResult(extracted, [survivor.id]);
      },
      // Same observational tap as the hunter steps: a refuter step retries
      // through the same loop, and the non-TTY log is where that shows.
      onRetry: (info) => emit(deps, { kind: "step-retry", ...info }),
    };
    return { id: survivor.id, spec };
  });
  for (const { spec } of specs) state.steps.push(stepMeta(spec));
  // Parallel, matching the hunter fan-out: the steps are independent by
  // construction and one slow claim must not gate the rest.
  //
  // Measured around the fan-out because summed `wall_ms` is NOT elapsed time
  // once the steps overlap: N concurrent steps of 60s each sum to N*60s while
  // the leg really took ~60s. Every hunter row reports one step's real
  // `wall_ms` (see `perAgentEntry`), so a summed refuter row would be both
  // inflated and incomparable with its siblings — and this engine exists to be
  // compared on time and cost against a paid competitor.
  const legStartedAt = Date.now();
  // Same per-promise attachment as the hunter fan-out: each step's event
  // fires as IT settles. A failed or rejected step reports the same
  // conservative "inconclusive" the join below records for it.
  const settled = await Promise.allSettled(
    specs.map(({ id, spec }) => {
      const startedAt = Date.now();
      const promise = deps.runner.run(spec);
      promise.then(
        (result) =>
          emit(deps, {
            kind: "refuter-step-finished",
            findingId: id,
            verdict:
              result.status === "ok"
                ? ((result.output as RefuterResult).results.find(
                    (r) => r.finding_id === id,
                  )?.outcome ?? "inconclusive")
                : "inconclusive",
            durationMs: Date.now() - startedAt,
          }),
        () =>
          emit(deps, {
            kind: "refuter-step-finished",
            findingId: id,
            verdict: "inconclusive",
            durationMs: Date.now() - startedAt,
          }),
      );
      return promise;
    }),
  );
  const legElapsedMs = Date.now() - legStartedAt;
  let usage: SessionUsage | undefined;
  let attempts = 0;
  let anyFailed = false;
  for (const [i, entry] of specs.entries()) {
    const outcome = settled[i];
    const result = outcome?.status === "fulfilled" ? outcome.value : undefined;
    if (result) {
      usage = usage ? sumUsage(usage, result.usage) : result.usage;
      attempts += result.attempts;
      state.usageTotal = sumUsage(state.usageTotal, result.usage);
    }
    if (result?.status === "ok") {
      for (const r of (result.output as RefuterResult).results) {
        state.verdicts.set(r.finding_id, r.outcome);
      }
      continue;
    }
    // Conservative default, now scoped to the one finding whose gate died: a
    // dead step must not delete a finding (it was never refuted) nor grant
    // blocking tier (it was never corroborated). Under the batch shape this
    // fallback swallowed every verdict in the run; now it costs exactly one.
    anyFailed = true;
    state.verdicts.set(entry.id, "inconclusive");
  }
  // The spec carries ONE refuter agent, so its telemetry stays one row —
  // token and cost fields summed across the steps it fanned into, which keeps
  // `per_agent` totals reconcilable against the run total. `duration_ms` is the
  // one field that cannot be summed: it reports the leg's measured elapsed
  // time. `attempts` IS a sum on purpose — N steps have no single attempt
  // count, so the total is the meaningful number; do not read it as "retries of
  // one step".
  state.perAgent[options.agent.key] = usage
    ? {
        tokens_total: usage.tokens_total,
        duration_ms: legElapsedMs,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        cost_usd_est: usage.cost_usd_est,
        attempts,
        status: anyFailed ? "failed" : "ok",
      }
    : failedAgentEntry();
  if (anyFailed) state.partial = true;
}

// Steps 7 + 8: map verdicts, assign tiers, assemble the SkillOutput draft and
// write pipeline.json. Also the ceiling path's landing zone — it dedupes
// whatever hunters completed so even a truncated run emits canonical ids.
async function finish(
  input: PipelineInput,
  state: RunState,
): Promise<PipelineResult> {
  if (!state.survivors) {
    const { survivors, deduped } = mergeAndDedupe(state.drafts);
    state.survivors = survivors;
    state.deduped = deduped;
  }
  const findings: Finding[] = [];
  const refuted: DebugRefutedFinding[] = [];
  for (const survivor of state.survivors) {
    const verdict: RefuterVerdict =
      state.verdicts.get(survivor.id) ?? "not_submitted";
    if (verdict === "refuted") {
      // Refuted BLOCKER/CRITICAL inferential findings leave findings[]
      // entirely — debug.refuted[] keeps them visible (tier never assigned).
      refuted.push({ ...survivor, refuter_verdict: "refuted" });
      continue;
    }
    findings.push({
      ...survivor,
      refuter_verdict: verdict,
      tier: deriveTier({
        severity: survivor.severity,
        evidence_class: survivor.evidence_class,
        refuter_verdict: verdict,
      }),
    });
  }
  // Merge losers were never submitted to the refuter — stamp the canonical
  // not_submitted verdict the debug shape requires.
  const deduped = (state.deduped ?? []).map((loser) => ({
    ...loser,
    refuter_verdict: "not_submitted" as const,
  }));
  // Derived root causes (ROADMAP C1). The engine counts distinct root causes
  // itself so blocking volume is never read as a raw finding count: ONE
  // systemic defect reported at N call sites is one true positive fanned out,
  // and reading it as N precision failures is exactly how a correct review
  // ends up scored as a precision collapse. Purely additive — the findings
  // above keep their ids, order, tiers and verdicts; only `root_cause_id` is
  // stamped on, and only when the clusterer actually placed the finding.
  const rootCauses = clusterByRootCause(findings);
  const rootCauseId = rootCauseIdByFinding(rootCauses);
  const clustered = findings.map((finding) => {
    const id = rootCauseId.get(finding.id);
    return id === undefined ? finding : { ...finding, root_cause_id: id };
  });
  const skillOutput: SkillOutput = {
    findings: clustered,
    debug: {
      refuted,
      ...(deduped.length > 0 ? { deduped } : {}),
      root_causes: rootCauses,
    },
    parity_hunter_fired: state.parityFired,
    run_status: state.partial ? "partial" : "complete",
    ...(state.summary === undefined ? {} : { summary: state.summary }),
  };
  await writePipelinePlan(input, state);
  return {
    skillOutput,
    perAgent: state.perAgent,
    usage: state.usageTotal,
    sessionFailed:
      state.hunterCount > 0 && state.hunterFailures === state.hunterCount,
  };
}

async function writePipelinePlan(
  input: PipelineInput,
  state: RunState,
): Promise<void> {
  const plan = {
    pr: input.pr,
    base_sha: input.baseSha,
    head_sha: input.headSha,
    out_path: input.outPath,
    excluded_paths: input.excludedPaths ?? [],
    parity_hunter_fired: state.parityFired,
    steps: state.steps,
  };
  await Bun.write(
    path.join(input.runDir, "pipeline.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
  );
}

function resolveModel(
  input: PipelineInput,
  specModel: string | undefined,
  frontmatterModel: string | undefined,
  agentName: string,
): string {
  // Precedence: input.model (CLI --model, the JD decision generalized) >
  // AgentSpec.model (per-agent config) > agent frontmatter model.
  const model = input.model ?? specModel ?? frontmatterModel;
  if (!model) {
    throw new Error(`agent ${agentName} has no model and no override given`);
  }
  return model;
}

function perAgentEntry(result: StepResult): PerAgentUsage {
  return {
    tokens_total: result.usage.tokens_total,
    duration_ms: result.usage.wall_ms,
    tokens_in: result.usage.tokens_in,
    tokens_out: result.usage.tokens_out,
    cost_usd_est: result.usage.cost_usd_est,
    attempts: result.attempts,
    status: result.status,
  };
}

function failedAgentEntry(): PerAgentUsage {
  return {
    tokens_total: 0,
    duration_ms: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd_est: 0,
    attempts: 0,
    status: "failed",
  };
}

function stepMeta(spec: StepSpec): StepMeta {
  return {
    name: spec.name,
    model: spec.model,
    tools: spec.tools,
    systemPromptPath: spec.systemPromptPath,
    outPath: spec.outPath,
  };
}
