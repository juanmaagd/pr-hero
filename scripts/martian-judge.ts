// Martian's offline LLM judge, same prompt and TP/FP/FN arithmetic as
// withmartian/code-review-benchmark `step3_judge_comments.py`.
//
// One isolated Claude spawn per PR (tools: []), not a GitHub-App run and not
// their Martian gateway (we have no MARTIAN_API_KEY). The prompt is theirs;
// the model is the engine's `sonnet` alias. Report both.
//
//   bun run scripts/martian-judge.ts
//   bun run scripts/martian-judge.ts --runs ~/Desktop/martian-cal/runs
//
// Sibling duplicates (same path:line) are not counted as extra FPs — the
// mechanical analogue of their step 2.5, labelled as such.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Finding, FindingsDocument } from "../src/findings";
import { lookupGolden, type MartianGoldenPr } from "../src/martian-adapter";
import { resolveRunnerAuthority } from "../src/runner-authority";
import { ClaudeCodeRunner } from "../src/step-runner";

export type ResumeClassification = "complete" | "incomplete" | "inconclusive";

export interface ArtifactResumeCandidate {
  runStatus?: "complete" | "partial";
  sessionFailed?: boolean;
  protocolIntegrity?: "verified" | "unverified" | "malformed";
  terminalProof?: { providerStatus?: string } | null;
  abortRequested?: boolean;
  abortConfirmed?: boolean;
  finishStatus?: string | null;
  truncated?: boolean;
  findings?: unknown[];
}

export function evaluateResumeOutcome(
  artifact: ArtifactResumeCandidate,
): ResumeClassification {
  if (artifact.runStatus === "partial" || artifact.sessionFailed === true) {
    return "incomplete";
  }
  if (
    artifact.protocolIntegrity !== undefined &&
    artifact.protocolIntegrity !== "verified"
  ) {
    return "incomplete";
  }
  if (artifact.terminalProof === undefined || artifact.terminalProof === null) {
    return "incomplete";
  }
  if (artifact.terminalProof.providerStatus !== "completed") {
    return "incomplete";
  }
  if (artifact.truncated === true) {
    return "incomplete";
  }
  if (artifact.finishStatus !== undefined && artifact.finishStatus !== "stop") {
    return "incomplete";
  }
  if (artifact.abortRequested && !artifact.abortConfirmed) {
    return "incomplete";
  }
  return "complete";
}

export interface BenchmarkRunRecord {
  pr: number;
  status: "complete" | "partial";
  wallMs: number;
  costUsd: number;
  tp?: number;
  fp?: number;
  fn?: number;
  findings?: unknown[];
  quarantineReason?: string;
}

export interface QualifiedBenchmarkMetrics {
  attempted: number;
  completed: number;
  partial: number;
  completionRate: number;
  coverage: number;
  completedSpendUsd: number;
  partialSpendUsd: number;
  totalSpendUsd: number;
  costPerComplete: number;
  completedWallMs: number;
  wallMsPerComplete: number;
  quality: {
    tp: number;
    fp: number;
    fn: number;
    precision: number;
    recall: number;
    f1: number;
  };
  quarantinedRuns: Array<{ pr: number; reason?: string }>;
}

export function computeQualifiedBenchmarkMetrics(
  runs: BenchmarkRunRecord[],
): QualifiedBenchmarkMetrics {
  const attempted = runs.length;
  const completedRuns = runs.filter((r) => r.status === "complete");
  const partialRuns = runs.filter((r) => r.status === "partial");

  const completed = completedRuns.length;
  const partial = partialRuns.length;
  const completionRate = attempted > 0 ? completed / attempted : 0;
  const coverage = completionRate;

  const completedSpendUsd = completedRuns.reduce(
    (sum, r) => sum + r.costUsd,
    0,
  );
  const partialSpendUsd = partialRuns.reduce((sum, r) => sum + r.costUsd, 0);
  const totalSpendUsd = completedSpendUsd + partialSpendUsd;
  const costPerComplete = completed > 0 ? completedSpendUsd / completed : 0;

  const completedWallMs = completedRuns.reduce((sum, r) => sum + r.wallMs, 0);
  const wallMsPerComplete = completed > 0 ? completedWallMs / completed : 0;

  const tp = completedRuns.reduce((sum, r) => sum + (r.tp ?? 0), 0);
  const fp = completedRuns.reduce((sum, r) => sum + (r.fp ?? 0), 0);
  const fn = completedRuns.reduce((sum, r) => sum + (r.fn ?? 0), 0);

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 =
    precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : 0;

  const quarantinedRuns = partialRuns.map((r) => ({
    pr: r.pr,
    ...(r.quarantineReason !== undefined ? { reason: r.quarantineReason } : {}),
  }));

  return {
    attempted,
    completed,
    partial,
    completionRate,
    coverage,
    completedSpendUsd,
    partialSpendUsd,
    totalSpendUsd,
    costPerComplete,
    completedWallMs,
    wallMsPerComplete,
    quality: {
      tp,
      fp,
      fn,
      precision,
      recall,
      f1,
    },
    quarantinedRuns,
  };
}

export type CompletionDiscrimination =
  | "complete_empty"
  | "complete_with_findings"
  | "transport_blank"
  | "partial_failure";

export interface ReviewCompletionInput {
  hasFindingsDocument: boolean;
  runStatus?: "complete" | "partial";
  sessionFailed?: boolean;
  protocolIntegrity?: "verified" | "unverified" | "malformed";
  terminalProof?: { providerStatus?: string } | null;
  finishStatus?: string | null;
  findings?: unknown[];
  stdout?: string;
  stderrTail?: string;
}

export function discriminateReviewCompletion(input: ReviewCompletionInput): {
  classification: CompletionDiscrimination;
  isCompletedReview: boolean;
  isCompleteEmpty: boolean;
  isTransportBlank: boolean;
} {
  const isVerifiedFinish =
    input.protocolIntegrity === "verified" &&
    (input.terminalProof?.providerStatus === "completed" ||
      input.finishStatus === "stop");

  const isCompleteStatus =
    input.hasFindingsDocument &&
    input.runStatus === "complete" &&
    input.sessionFailed !== true &&
    isVerifiedFinish;

  if (isCompleteStatus) {
    if (Array.isArray(input.findings) && input.findings.length === 0) {
      return {
        classification: "complete_empty",
        isCompletedReview: true,
        isCompleteEmpty: true,
        isTransportBlank: false,
      };
    }
    return {
      classification: "complete_with_findings",
      isCompletedReview: true,
      isCompleteEmpty: false,
      isTransportBlank: false,
    };
  }

  const hasEmptyStdout =
    input.stdout !== undefined && input.stdout.trim().length === 0;
  if (
    (!input.hasFindingsDocument || hasEmptyStdout) &&
    (input.protocolIntegrity !== "verified" ||
      input.terminalProof === undefined ||
      input.finishStatus !== "stop")
  ) {
    return {
      classification: "transport_blank",
      isCompletedReview: false,
      isCompleteEmpty: false,
      isTransportBlank: true,
    };
  }

  return {
    classification: "partial_failure",
    isCompletedReview: false,
    isCompleteEmpty: false,
    isTransportBlank: false,
  };
}

const ROOT = path.join(import.meta.dir, "..");
const GOLDENS_PATH = path.join(
  ROOT,
  "docs",
  "benchmarks",
  "martian-cal-goldens.json",
);
const DEFAULT_RUNS = path.join(homedir(), "Desktop", "martian-cal", "runs");
const JUDGE_MODEL = "sonnet";

const JUDGE_SYSTEM = `You are evaluating AI code review tools.
Determine if the candidate issue matches the golden (expected) comment.

Instructions:
- Determine if the candidate identifies the SAME underlying issue as the golden comment
- Accept semantic matches - different wording is fine if it's the same problem
- Focus on whether they point to the same bug, concern, or code issue
- Do not use tools. Do not read files. Score only the texts in the user message.

Respond with ONLY a JSON object of the form:
{"pairs":[{"golden":0,"candidate":0,"match":true,"confidence":0.0,"reasoning":"brief"}]}
One entry per (golden, candidate) pair. golden and candidate are 0-based indices.`;

interface PairVerdict {
  golden: number;
  candidate: number;
  match: boolean;
  confidence: number;
  reasoning: string;
}

interface PrEval {
  pr: number;
  url: string;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  true_positives: {
    golden_comment: string;
    severity: string;
    category: string;
    matched_candidate: string;
    confidence: number;
    reasoning: string;
  }[];
  false_positives: string[];
  false_negatives: {
    golden_comment: string;
    severity: string;
    category: string;
  }[];
  cost_usd_est: number;
}

function fail(message: string): never {
  console.error(`martian-judge: ${message}`);
  process.exit(1);
}

function argValue(flag: string): string | undefined {
  const i = Bun.argv.indexOf(flag);
  if (i < 0) return undefined;
  const value = Bun.argv[i + 1];
  if (value === undefined || value.startsWith("-"))
    fail(`${flag} needs a value`);
  return value;
}

function siblingGroups(findings: Finding[]): number[][] {
  const bySite = new Map<string, number[]>();
  for (const [i, f] of findings.entries()) {
    const key = `${f.path}:${f.line}`;
    const g = bySite.get(key) ?? [];
    g.push(i);
    bySite.set(key, g);
  }
  return [...bySite.values()];
}

function siblingMap(
  candidates: string[],
  groups: number[][],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const group of groups) {
    const texts = new Set(
      group.map((i) => candidates[i]).filter((t) => t !== undefined),
    );
    for (const i of group) {
      const t = candidates[i];
      if (t === undefined) continue;
      const sibs = new Set(texts);
      sibs.delete(t);
      map.set(t, sibs);
    }
  }
  return map;
}

function parsePairs(
  finalText: string,
  nGold: number,
  nCand: number,
): PairVerdict[] {
  const trimmed = finalText.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("judge returned no JSON object");
  const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null || !("pairs" in parsed)) {
    throw new Error("judge JSON missing pairs");
  }
  const pairs = (parsed as { pairs: unknown }).pairs;
  if (!Array.isArray(pairs)) throw new Error("pairs is not an array");
  const out: PairVerdict[] = [];
  for (const row of pairs) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const golden = Number(r.golden);
    const candidate = Number(r.candidate);
    if (
      !Number.isInteger(golden) ||
      !Number.isInteger(candidate) ||
      golden < 0 ||
      golden >= nGold ||
      candidate < 0 ||
      candidate >= nCand
    ) {
      continue;
    }
    out.push({
      golden,
      candidate,
      match: r.match === true,
      confidence: typeof r.confidence === "number" ? r.confidence : 0,
      reasoning: typeof r.reasoning === "string" ? r.reasoning : "",
    });
  }
  return out;
}

if (import.meta.main) {
  const runsRoot = argValue("--runs") ?? DEFAULT_RUNS;
  const arm = argValue("--arm") ?? "hunters";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(arm)) {
    fail(`--arm must match [a-zA-Z0-9_-]+, got: ${arm}`);
  }
  const goldens = (await Bun.file(GOLDENS_PATH).json()) as MartianGoldenPr[];

  const dirs: string[] = [];
  for await (const entry of new Bun.Glob(`cal-*-${arm}`).scan({
    cwd: runsRoot,
    onlyFiles: false,
  })) {
    dirs.push(entry.replace(/\/$/, ""));
  }
  dirs.sort();
  if (dirs.length === 0) fail(`no cal-*-${arm} runs in ${runsRoot}`);

  const evals: PrEval[] = [];
  const runRecords: BenchmarkRunRecord[] = [];
  let judgeCost = 0;

  for (const dir of dirs) {
    const match = new RegExp(`^cal-(\\d+)-${arm}$`).exec(dir);
    if (match === null) continue;
    const pr = Number(match[1]);
    const findingsPath = path.join(runsRoot, dir, "findings.json");
    if (!(await Bun.file(findingsPath).exists())) {
      console.error(`skip ${dir}: no findings.json`);
      runRecords.push({
        pr,
        status: "partial",
        wallMs: 0,
        costUsd: 0,
        quarantineReason: "missing_findings_json",
      });
      continue;
    }
    const doc = (await Bun.file(findingsPath).json()) as FindingsDocument;
    const golden = lookupGolden(goldens, pr);
    const findings = (doc.findings ?? []) as Finding[];
    const candidates = findings.map((f) => f.claim);

    const completion = discriminateReviewCompletion({
      hasFindingsDocument: true,
      runStatus: doc.run_status,
      sessionFailed: doc.sessionFailed,
      protocolIntegrity: "verified",
      terminalProof: { providerStatus: "completed" },
      finishStatus: "stop",
      findings,
    });

    if (!completion.isCompletedReview) {
      console.error(`quarantine ${dir}: runStatus is ${doc.run_status}`);
      runRecords.push({
        pr,
        status: "partial",
        wallMs: doc.telemetry?.wall_ms ?? 0,
        costUsd: doc.telemetry?.cost_usd_est ?? 0,
        quarantineReason: `run_status_${doc.run_status}`,
      });
      continue;
    }

    console.error(
      `\n=== judge PR ${pr}  ${candidates.length} candidates × ${golden.comments.length} goldens`,
    );

    if (candidates.length === 0) {
      evals.push({
        pr,
        url: golden.url,
        tp: 0,
        fp: 0,
        fn: golden.comments.length,
        precision: 0,
        recall: 0,
        true_positives: [],
        false_positives: [],
        false_negatives: golden.comments.map((g) => ({
          golden_comment: g.comment,
          severity: g.severity,
          category: g.category,
        })),
        cost_usd_est: doc.telemetry?.cost_usd_est ?? 0,
      });
      runRecords.push({
        pr,
        status: "complete",
        wallMs: doc.telemetry?.wall_ms ?? 0,
        costUsd: doc.telemetry?.cost_usd_est ?? 0,
        tp: 0,
        fp: 0,
        fn: golden.comments.length,
        findings: [],
      });
      continue;
    }

    const numberedGold = golden.comments
      .map((g, i) => `[${i}] (${g.severity}/${g.category}) ${g.comment}`)
      .join("\n\n");
    const numberedCand = candidates
      .map((c, i) => `[${i}] ${findings[i]?.path}:${findings[i]?.line} ${c}`)
      .join("\n\n");
    const prompt = `Golden Comment(s):\n${numberedGold}\n\nCandidate Issue(s):\n${numberedCand}\n\nScore every (golden, candidate) pair.`;

    const tmp = mkdtempSync(path.join(tmpdir(), "martian-judge-"));
    const systemPromptPath = path.join(tmp, "system.md");
    const mcpConfigPath = path.join(tmp, "mcp.json");
    writeFileSync(systemPromptPath, JUDGE_SYSTEM);
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
    chmodSync(systemPromptPath, 0o600);
    // Re-resolved per PR: workspaceRoot must name the tmp dir this judge
    // actually runs in, and that dir is recreated every iteration.
    const runnerAuthority = await resolveRunnerAuthority({
      workspaceRoot: tmp,
    });
    if (runnerAuthority.error !== undefined) {
      fail(`execution authority unavailable: ${runnerAuthority.error}`);
    }
    const result = await new ClaudeCodeRunner(
      runnerAuthority.runnerOptions,
    ).run({
      name: `judge-${pr}`,
      systemPromptPath,
      prompt,
      tools: [],
      mcpConfigPath,
      model: JUDGE_MODEL,
      cwd: tmp,
      outPath: path.join(tmp, "out.json"),
      timeoutMs: 5 * 60 * 1000,
      maxAttempts: 2,
      parse: (finalText) =>
        parsePairs(finalText, golden.comments.length, candidates.length),
    });
    if (result.status !== "ok" || result.output === undefined) {
      fail(`judge spawn failed for PR ${pr}: ${result.stderrTail.slice(-400)}`);
    }
    judgeCost += result.usage.cost_usd_est;
    const pairs = result.output as PairVerdict[];

    const goldState = golden.comments.map((g) => ({
      comment: g.comment,
      severity: g.severity,
      category: g.category,
      matched: false,
      best: 0,
      candidate: null as string | null,
      reasoning: "",
    }));
    const candMatched = candidates.map(() => false);
    const sibs = siblingMap(candidates, siblingGroups(findings));

    for (const pair of pairs) {
      if (!pair.match) continue;
      const g = goldState[pair.golden];
      const c = candidates[pair.candidate];
      if (g === undefined || c === undefined) continue;
      if (pair.confidence > g.best) {
        g.matched = true;
        g.best = pair.confidence;
        g.candidate = c;
        g.reasoning = pair.reasoning;
      }
      candMatched[pair.candidate] = true;
      for (const sib of sibs.get(c) ?? []) {
        const idx = candidates.indexOf(sib);
        if (idx >= 0) candMatched[idx] = true;
      }
    }

    const tps = goldState.filter((g) => g.matched);
    const fns = goldState.filter((g) => !g.matched);
    const fps = candidates.filter((_, i) => !candMatched[i]);
    const tp = tps.length;
    const fp = fps.length;
    const fn = fns.length;
    evals.push({
      pr,
      url: golden.url,
      tp,
      fp,
      fn,
      precision: tp + fp > 0 ? tp / (tp + fp) : 0,
      recall: tp + fn > 0 ? tp / (tp + fn) : 0,
      true_positives: tps.map((g) => ({
        golden_comment: g.comment,
        severity: g.severity,
        category: g.category,
        matched_candidate: g.candidate ?? "",
        confidence: g.best,
        reasoning: g.reasoning,
      })),
      false_positives: fps,
      false_negatives: fns.map((g) => ({
        golden_comment: g.comment,
        severity: g.severity,
        category: g.category,
      })),
      cost_usd_est: result.usage.cost_usd_est,
    });
    runRecords.push({
      pr,
      status: "complete",
      wallMs: doc.telemetry?.wall_ms ?? 0,
      costUsd: doc.telemetry?.cost_usd_est ?? 0,
      tp,
      fp,
      fn,
      findings,
    });
    const last = evals.at(-1);
    if (last === undefined) continue;
    const f1 =
      last.precision + last.recall > 0
        ? (2 * last.precision * last.recall) / (last.precision + last.recall)
        : 0;
    console.error(
      `  P ${last.precision.toFixed(2)}  R ${last.recall.toFixed(2)}  F1 ${f1.toFixed(2)}  tp ${tp} fp ${fp} fn ${fn}  $${result.usage.cost_usd_est.toFixed(2)}`,
    );
  }

  const metrics = computeQualifiedBenchmarkMetrics(runRecords);

  const outPath = path.join(
    runsRoot,
    arm === "hunters" ? "martian-judge.json" : `martian-judge-${arm}.json`,
  );
  await Bun.write(
    outPath,
    `${JSON.stringify(
      {
        judge_prompt:
          "withmartian/code-review-benchmark step3_judge_comments.py JUDGE_PROMPT",
        judge_model: JUDGE_MODEL,
        gateway: "claude-code CLI (tools:[]), not MARTIAN_API_KEY",
        sibling_rule:
          "same path:line are not extra FPs (mechanical analogue of step 2.5)",
        prs: evals,
        aggregate: {
          tp: metrics.quality.tp,
          fp: metrics.quality.fp,
          fn: metrics.quality.fn,
          precision: metrics.quality.precision,
          recall: metrics.quality.recall,
          f1: metrics.quality.f1,
          judge_cost_usd: judgeCost,
          attempted: metrics.attempted,
          completed: metrics.completed,
          partial: metrics.partial,
          completion_rate: metrics.completionRate,
          coverage: metrics.coverage,
          completed_cost_usd: metrics.completedSpendUsd,
          partial_cost_usd: metrics.partialSpendUsd,
          total_cost_usd: metrics.totalSpendUsd,
          cost_per_complete: metrics.costPerComplete,
          completed_wall_ms: metrics.completedWallMs,
          wall_ms_per_complete: metrics.wallMsPerComplete,
          quarantined_runs: metrics.quarantinedRuns,
        },
      },
      null,
      2,
    )}\n`,
  );

  console.log("");
  console.log(
    `judge model: ${JUDGE_MODEL}  (Martian prompt, Claude Code CLI, tools:[])`,
  );
  console.log(`prs: ${evals.length}  judge cost: $${judgeCost.toFixed(2)}`);
  console.log(
    `completed: ${metrics.completed}/${metrics.attempted} (${(metrics.completionRate * 100).toFixed(1)}%)  cost/complete: $${metrics.costPerComplete.toFixed(2)}`,
  );
  console.log("");
  console.log("pr     P      R      F1     tp fp fn");
  console.log("-----  -----  -----  -----  -- -- --");
  for (const e of evals) {
    const pf1 =
      e.precision + e.recall > 0
        ? (2 * e.precision * e.recall) / (e.precision + e.recall)
        : 0;
    console.log(
      `${String(e.pr).padStart(5)}  ${e.precision.toFixed(2)}  ${e.recall.toFixed(2)}  ${pf1.toFixed(2)}  ${String(e.tp).padStart(2)} ${String(e.fp).padStart(2)} ${String(e.fn).padStart(2)}`,
    );
  }
  console.log("-----  -----  -----  -----  -- -- --");
  console.log(
    `  ALL  ${metrics.quality.precision.toFixed(2)}  ${metrics.quality.recall.toFixed(2)}  ${metrics.quality.f1.toFixed(2)}  ${String(metrics.quality.tp).padStart(2)} ${String(metrics.quality.fp).padStart(2)} ${String(metrics.quality.fn).padStart(2)}`,
  );
  console.log(`wrote ${outPath}`);
  console.log(
    "This is Cal.com only, 10 PRs max. Do not quote it as the 50-PR offline board.",
  );
}
