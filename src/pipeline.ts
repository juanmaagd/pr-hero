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
} from "./drafts";
import {
  type DebugRefutedFinding,
  deriveTier,
  type Finding,
  type Hunter,
  type RefuterVerdict,
  type SkillOutput,
} from "./findings";
import {
  parseAgentFile,
  renderAgentBody,
  type SuspicionPrior,
} from "./prompt-set";
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
  diffPath: string;
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
  // Override wins over agent-frontmatter model for EVERY step (JD decision:
  // v1's replay `--model` note generalized); with no override, frontmatter
  // wins.
  model?: string;
  parityTriggerPaths: string[];
  suspicionPriors: SuspicionPrior[];
  // Per-step watchdog; defaults to the runner's 30 min.
  stepTimeoutMs?: number;
  // Whole-pipeline ceiling; defaults to DEFAULT_PIPELINE_TIMEOUT_MS.
  pipelineTimeoutMs?: number;
}

export interface PipelineDeps {
  runner: StepRunner;
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
  // Keyed reliability | resilience | parity | refuter.
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
  '"corroborated|refuted|inconclusive","proof_refs":["..."]}]} with exactly',
  "one verdict per submitted finding id — never implied, never extra.",
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

function refuterPrompt(batchJson: string): string {
  return [
    "Refute or corroborate each finding in this batch:",
    "",
    batchJson,
    "",
    "For every finding decide `corroborated`, `refuted`, or `inconclusive`",
    "against the code in this worktree.",
    "",
    REFUTER_OUTPUT_CONTRACT,
  ].join("\n");
}

// Always reliability + resilience (prose Step 4: "regardless of diff
// content"); parity joins only when Step 3 fired.
const FIXED_HUNTERS: Array<{ key: Hunter; agent: string }> = [
  { key: "reliability", agent: "deep-review-reliability" },
  { key: "resilience", agent: "deep-review-resilience" },
];
const PARITY_HUNTER: { key: Hunter; agent: string } = {
  key: "parity",
  agent: "deep-review-parity",
};
const REFUTER_AGENT = "review-refuter";

// pipeline.json row: the resolved plan sans prompts (frozen-plan provenance —
// which steps ran, with which model and tool surface, writing where).
interface StepMeta {
  name: string;
  model: string;
  tools: string[];
  systemPromptPath: string;
  outPath: string;
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

  // Step 3 — deterministic parity trigger. This decision is the driver's
  // alone; the parity hunter never self-triggers.
  const patch = await Bun.file(input.diffPath).text();
  state.parityFired = parityTriggered(
    changedPathsFromDiff(patch),
    input.parityTriggerPaths,
  );

  // Step 4 — hunter fan-out.
  const stepsDir = path.join(input.runDir, "steps");
  const stepTimeoutMs = input.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const hunters = state.parityFired
    ? [...FIXED_HUNTERS, PARITY_HUNTER]
    : FIXED_HUNTERS;
  const hunterSpecs: Array<{ key: Hunter; spec: StepSpec }> = [];
  for (const hunter of hunters) {
    const agent = await parseAgentFile(
      path.join(input.agentsDir, `${hunter.agent}.md`),
    );
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
      model: resolveModel(input, agent.model, hunter.agent),
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
    };
    hunterSpecs.push({ key: hunter.key, spec });
    state.steps.push(stepMeta(spec));
  }
  state.hunterCount = hunterSpecs.length;
  const settled = await Promise.allSettled(
    hunterSpecs.map(({ spec }) => deps.runner.run(spec)),
  );
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

  // Step 6 — one refuter batch: inferential BLOCKER/CRITICAL survivors only.
  // Empty batch → no step runs, every finding stays not_submitted.
  const batch = survivors.filter(
    (s) =>
      s.evidence_class === "inferential" &&
      (s.severity === "BLOCKER" || s.severity === "CRITICAL"),
  );
  if (batch.length > 0) {
    await runRefuter(input, deps, state, batch, { stepsDir, stepTimeoutMs });
  }

  // Steps 7 + 8 live in finish(), shared with the ceiling path.
  return finish(input, state);
}

async function runRefuter(
  input: PipelineInput,
  deps: PipelineDeps,
  state: RunState,
  batch: DedupedSurvivor[],
  options: { stepsDir: string; stepTimeoutMs: number },
): Promise<void> {
  const submittedIds = batch.map((s) => s.id);
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
    path.join(input.agentsDir, `${REFUTER_AGENT}.md`),
  );
  const systemPromptPath = path.join(options.stepsDir, "refuter.system.md");
  // The refuter body carries no {{PRIORS}}/{{GOTCHAS}} anchors — written
  // as-is, same audit-artifact role as the hunter system prompts.
  await Bun.write(systemPromptPath, agent.body);
  const spec: StepSpec = {
    name: "refuter",
    systemPromptPath,
    // Batch CONTENT inline, not a path: the refuter's tool surface is
    // read-only over the worktree; its work order must arrive in the prompt.
    prompt: refuterPrompt(batchJson),
    tools: agent.tools,
    mcpConfigPath: input.mcpConfigPath,
    model: resolveModel(input, agent.model, REFUTER_AGENT),
    cwd: input.worktree,
    outPath: path.join(options.stepsDir, "refuter.result.json"),
    timeoutMs: options.stepTimeoutMs,
    maxAttempts: DEFAULT_STEP_MAX_ATTEMPTS,
    parse: (finalText) => {
      const extracted = extractJsonObject(finalText);
      if (extracted === undefined) {
        throw new Error("refuter final message has no JSON object");
      }
      return validateRefuterResult(extracted, submittedIds);
    },
  };
  state.steps.push(stepMeta(spec));
  let result: StepResult | undefined;
  try {
    result = await deps.runner.run(spec);
  } catch {
    result = undefined;
  }
  if (result) {
    state.perAgent.refuter = perAgentEntry(result);
    state.usageTotal = sumUsage(state.usageTotal, result.usage);
  } else {
    state.perAgent.refuter = failedAgentEntry();
  }
  if (result?.status === "ok") {
    for (const entry of (result.output as RefuterResult).results) {
      state.verdicts.set(entry.finding_id, entry.outcome);
    }
    return;
  }
  // Conservative default: a dead refuter must not delete findings (they were
  // never refuted) nor grant blocking tier (they were never corroborated) —
  // every submitted finding becomes "inconclusive", and the run is partial.
  for (const id of submittedIds) {
    state.verdicts.set(id, "inconclusive");
  }
  state.partial = true;
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
  const skillOutput: SkillOutput = {
    findings,
    debug: {
      refuted,
      ...(deduped.length > 0 ? { deduped } : {}),
    },
    parity_hunter_fired: state.parityFired,
    run_status: state.partial ? "partial" : "complete",
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
  frontmatterModel: string | undefined,
  agentName: string,
): string {
  // Override wins over frontmatter (JD decision) — see PipelineInput.model.
  const model = input.model ?? frontmatterModel;
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
