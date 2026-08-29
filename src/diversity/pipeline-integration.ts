import type { DraftFinding } from "../drafts";
import {
  type NormalizedUsage,
  normalizeInclusiveUsage,
} from "../execution/usage-normalized";
import { SCHEMA_VERSION_V1_1 } from "../findings";
import type { RoutingConfig } from "../model-routing";
import type { AgentSpec, ReviewSpec } from "../spec";
import { resolveSpecialty } from "../spec";
import type { StepResult } from "../step-runner";
import {
  appendAttempt,
  appendObservation,
  type DiversityAttemptRecord,
  type DiversityLedger,
  emptyDiversityLedger,
} from "./accounting";
import { assertDiversityCapabilityOrThrow } from "./admission";
import type { FindingObservation } from "./clustering";
import { DiversityAdmissionError } from "./errors";
import {
  type BenchmarkTarget,
  buildDiversityPlan,
  type DiversityLeg,
  type DiversityPlan,
  expandDiversityAgents,
} from "./identity";

export interface DiversityPipelineRecord {
  readonly enabled: boolean;
  readonly status: "ok" | "partial" | "skipped" | "failed";
  readonly armId?: string;
  readonly planFingerprint?: string;
  readonly legCount?: number;
  readonly attemptCount?: number;
  readonly observationCount?: number;
  readonly failureCount?: number;
  readonly cashCostUsd?: number;
  readonly notionalCostUsd?: number;
}

export interface DiversityExecutionContext {
  readonly enabled: boolean;
  readonly plan?: DiversityPlan;
  readonly ledger: DiversityLedger;
  readonly routeAgents: readonly AgentSpec[];
}

export interface PrepareDiversityInput {
  readonly reviewSpec: ReviewSpec;
  readonly cliModel?: string;
  readonly routingConfig?: RoutingConfig;
  readonly frontmatterModel?: (agentKey: string) => string | undefined;
  readonly target?: BenchmarkTarget;
  readonly promptFingerprint?: string;
  readonly buildFingerprint?: string;
}

export function prepareDiversityExecution(
  input: PrepareDiversityInput,
): DiversityExecutionContext {
  const diversity = input.reviewSpec.multiModelDiversity;
  if (!diversity?.enabled) {
    return {
      enabled: false,
      ledger: emptyDiversityLedger(),
      routeAgents: input.reviewSpec.agents,
    };
  }
  assertDiversityCapabilityOrThrow();
  const plan = buildDiversityPlan({
    spec: input.reviewSpec,
    c2SchemaVersion: SCHEMA_VERSION_V1_1,
    cliModel: input.cliModel,
    routingConfig: input.routingConfig,
    frontmatterModel: input.frontmatterModel,
    target: input.target,
    promptFingerprint: input.promptFingerprint,
    buildFingerprint: input.buildFingerprint,
  });
  const expanded = expandDiversityAgents(input.reviewSpec, plan);
  return {
    enabled: true,
    plan,
    ledger: emptyDiversityLedger(),
    routeAgents: expanded.map((agent) => ({
      key: agent.key,
      specialty: agent.specialty,
      file: agent.file,
      role: agent.role,
      trigger: agent.trigger,
      model: agent.model,
    })),
  };
}

export function executionHuntersForTriggered(
  reviewSpec: ReviewSpec,
  ctx: DiversityExecutionContext,
  triggeredBaseHunters: readonly AgentSpec[],
): readonly AgentSpec[] {
  if (!ctx.enabled || !ctx.plan) return triggeredBaseHunters;
  const expanded = expandDiversityAgents(reviewSpec, ctx.plan);
  const hunters: AgentSpec[] = [];
  for (const base of triggeredBaseHunters) {
    const legs = expanded.filter(
      (agent) =>
        agent.role === "hunter" &&
        (agent.key === base.key || agent.key.startsWith(`${base.key}--`)),
    );
    if (legs.length === 0) {
      hunters.push(base);
      continue;
    }
    for (const leg of legs) {
      hunters.push({
        key: leg.key,
        specialty: leg.specialty,
        file: leg.file,
        role: leg.role,
        trigger: leg.trigger,
        model: leg.model,
      });
    }
  }
  return hunters;
}

function legForAgent(
  plan: DiversityPlan,
  agent: AgentSpec,
): DiversityLeg | undefined {
  return plan.legs.find(
    (leg) => leg.agentKey === agent.key || leg.executionKey === agent.key,
  );
}

function usageFromStep(result: StepResult): NormalizedUsage {
  if (result.usageV2) return result.usageV2;
  return normalizeInclusiveUsage({
    wallMs: result.usage.wall_ms,
    inputTotal: result.usage.tokens_in,
    outputTotal: result.usage.tokens_out,
    billingMode: "unknown",
    costSource: "unknown",
    cashCostUsd: result.usage.cost_usd_est,
    notionalCostUsd: result.usage.cost_usd_est,
  });
}

export function recordDiversityHunterResult(
  ledger: DiversityLedger,
  plan: DiversityPlan,
  agent: AgentSpec,
  result: StepResult,
  leg?: DiversityLeg,
): DiversityLedger {
  const resolvedLeg = leg ?? legForAgent(plan, agent);
  if (!resolvedLeg) {
    throw new DiversityAdmissionError(
      `no diversity leg for hunter ${agent.key}`,
    );
  }
  const attemptId = `${resolvedLeg.legId}-a${result.attempts}`;
  const attempt: DiversityAttemptRecord = {
    attemptId,
    legId: resolvedLeg.legId,
    armId: plan.armId,
    specialty: resolveSpecialty(agent),
    replicate: 1,
    attempt: result.attempts,
    status: result.status === "ok" ? "completed" : "failed",
    usage: usageFromStep(result),
  };
  let next = appendAttempt(ledger, attempt);
  if (result.status !== "ok") return next;
  const output = result.output as { findings?: DraftFinding[] } | undefined;
  const findings = output?.findings ?? [];
  for (const [index, finding] of findings.entries()) {
    const observation: FindingObservation = {
      observationId: `${attemptId}-o${index + 1}`,
      specialty: resolveSpecialty(agent),
      legId: resolvedLeg.legId,
      backend: "claude-code",
      provider: "anthropic",
      modelFamily: resolvedLeg.model.split("/")[0] ?? "unknown",
      modelSnapshot: resolvedLeg.model,
      replicate: 1,
      attempt: result.attempts,
      promptFingerprint: plan.promptFingerprint ?? "unknown",
      routeFingerprint: resolvedLeg.routeFingerprint,
      path: finding.path,
      line: finding.line,
      symbol: finding.symbol,
      category: finding.category,
      severity: finding.severity,
      claim: finding.claim,
      evidence: finding.proof_refs.join(";"),
      proofRefs: finding.proof_refs,
      causalHypothesis: finding.claim,
      artifactSha256: finding.dedupe_key,
      dedupeKey: finding.dedupe_key,
    };
    next = appendObservation(next, {
      observation,
      attemptId,
      legId: resolvedLeg.legId,
      armId: plan.armId,
    });
  }
  return next;
}

export function buildDiversityPipelineRecord(
  ctx: DiversityExecutionContext,
  partial: boolean,
): DiversityPipelineRecord | undefined {
  if (!ctx.enabled) {
    return { enabled: false, status: "skipped" };
  }
  if (!ctx.plan) {
    return { enabled: true, status: "failed" };
  }
  const totals = ctx.ledger.attempts.reduce(
    (acc, attempt) => ({
      cash: acc.cash + (attempt.usage.cashCostUsd ?? 0),
      notional: acc.notional + (attempt.usage.notionalCostUsd ?? 0),
    }),
    { cash: 0, notional: 0 },
  );
  return {
    enabled: true,
    status: partial ? "partial" : "ok",
    armId: ctx.plan.armId,
    planFingerprint: ctx.plan.planFingerprint,
    legCount: ctx.plan.legs.length,
    attemptCount: ctx.ledger.attempts.length,
    observationCount: ctx.ledger.observations.length,
    failureCount: ctx.ledger.failures.length,
    cashCostUsd: totals.cash,
    notionalCostUsd: totals.notional,
  };
}

export function diversityDebugFromLedger(
  ctx: DiversityExecutionContext,
): Record<string, unknown> | undefined {
  if (!ctx.enabled || !ctx.plan) return undefined;
  return {
    planFingerprint: ctx.plan.planFingerprint,
    attempts: ctx.ledger.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      legId: attempt.legId,
      armId: attempt.armId,
      specialty: attempt.specialty,
      replicate: attempt.replicate,
      attempt: attempt.attempt,
      status: attempt.status,
      cashCostUsd: attempt.usage.cashCostUsd ?? null,
      notionalCostUsd: attempt.usage.notionalCostUsd ?? null,
    })),
    observations: ctx.ledger.observations.map((record) => ({
      observationId: record.observation.observationId,
      attemptId: record.attemptId,
      legId: record.legId,
      armId: record.armId,
      specialty: record.observation.specialty,
      path: record.observation.path,
    })),
  };
}
