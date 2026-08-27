// §8 (docs/multi-runtime-model-diversity-design.md lines 426-463): usage
// normalization and inclusion semantics. Pure by design — no transport, no
// harness, no I/O; zero consumers yet (PR1a). Transports (PR2) will call the
// builders below to turn a provider's raw usage shape into the disjoint §8
// leaves; the harness will accumulate across attempts with
// `sumNormalizedUsage` and project the legacy flat shape at the
// `runPipeline` return boundary with `projectLegacyUsage`.

import type { SessionUsage } from "../usage";

export type UsageCompleteness = "complete" | "partial" | "unavailable";
export type UsageBillingMode = "subscription" | "metered" | "unknown";
export type UsageCostSource =
  | "provider"
  | "versioned_rate_table"
  | "subscription"
  | "unknown";

// §8 lines 429-450, verbatim field names (camelCase — the legacy flat shape
// keeps its own snake_case names; `projectLegacyUsage` below is the ONLY
// bridge between the two, per the "coexistence, not rename" design decision).
export interface NormalizedTokens {
  readonly inputUncached?: number;
  readonly inputCacheRead?: number;
  readonly inputCacheWrite?: number;
  readonly inputOther?: number;
  readonly outputVisible?: number;
  readonly outputReasoning?: number;
  readonly outputOther?: number;
  readonly inputKnown?: number;
  readonly outputKnown?: number;
  readonly totalKnown?: number;
  readonly providerReportedTotal?: number;
}

export interface NormalizedUsage {
  readonly wallMs: number;
  readonly tokens: NormalizedTokens;
  readonly completeness: UsageCompleteness;
  readonly billingMode: UsageBillingMode;
  readonly cashCostUsd?: number;
  readonly notionalCostUsd?: number;
  readonly costSource: UsageCostSource;
  readonly redactedRaw?: unknown;
}

interface UsageCostInput {
  readonly billingMode: UsageBillingMode;
  readonly costSource: UsageCostSource;
  readonly cashCostUsd?: number;
  readonly notionalCostUsd?: number;
}

function sumOrZero(...values: ReadonlyArray<number | undefined>): number {
  return values.reduce<number>((total, v) => total + (v ?? 0), 0);
}

function sumIfAnyDefined(
  ...values: ReadonlyArray<number | undefined>
): number | undefined {
  return values.every((v) => v === undefined)
    ? undefined
    : sumOrZero(...values);
}

// §8 line 455: "If a provider total includes detailed cache/reasoning
// values, split the total into leaves and store only the non-negative
// residual in inputOther/outputOther; never add the detail to the inclusive
// total." OpenAI's `prompt_tokens`/`completion_tokens` are this shape — the
// detail fields are a SUBSET of the total, never additional to it.
export interface InclusiveUsageInput extends UsageCostInput {
  readonly wallMs: number;
  readonly inputTotal: number;
  readonly inputCacheRead?: number;
  readonly inputCacheWrite?: number;
  readonly outputTotal: number;
  readonly outputReasoning?: number;
}

export function normalizeInclusiveUsage(
  input: InclusiveUsageInput,
): NormalizedUsage {
  const inputOther = Math.max(
    0,
    input.inputTotal - sumOrZero(input.inputCacheRead, input.inputCacheWrite),
  );
  const outputOther = Math.max(
    0,
    input.outputTotal - sumOrZero(input.outputReasoning),
  );
  return {
    wallMs: input.wallMs,
    tokens: {
      inputCacheRead: input.inputCacheRead,
      inputCacheWrite: input.inputCacheWrite,
      inputOther,
      outputReasoning: input.outputReasoning,
      outputOther,
      inputKnown: input.inputTotal,
      outputKnown: input.outputTotal,
      totalKnown: input.inputTotal + input.outputTotal,
      providerReportedTotal: input.inputTotal + input.outputTotal,
    },
    completeness: "complete",
    billingMode: input.billingMode,
    costSource: input.costSource,
    cashCostUsd: input.cashCostUsd,
    notionalCostUsd: input.notionalCostUsd,
  };
}

// §8 line 457: "If inclusion cannot be proven, keep providerReportedTotal,
// mark partial, and do not invent a split." No leaf field is populated here
// — inventing one would resurrect the exact "$0 on parse failure" collapse
// this slice exists to kill, just with a fabricated split instead of a
// fabricated zero.
export interface PartialUsageInput extends UsageCostInput {
  readonly wallMs: number;
  readonly providerReportedTotal: number;
}

export function normalizePartialUsage(
  input: PartialUsageInput,
): NormalizedUsage {
  return {
    wallMs: input.wallMs,
    tokens: { providerReportedTotal: input.providerReportedTotal },
    completeness: "partial",
    billingMode: input.billingMode,
    costSource: input.costSource,
    cashCostUsd: input.cashCostUsd,
    notionalCostUsd: input.notionalCostUsd,
  };
}

// spec: "Parse Failure Yields Unavailable Completeness, Never Zero Cost" —
// used when nothing about an attempt's usage can be trusted (corrupted
// stdout, a dropped final usage chunk, a safety-blocked response with no
// usage block at all). No leaf, cost, or total field is ever populated as a
// fabricated zero; billingMode/costSource fall back to "unknown" rather
// than guessing which one applied.
export interface UnavailableUsageInput {
  readonly wallMs: number;
}

export function normalizeUnavailableUsage(
  input: UnavailableUsageInput,
): NormalizedUsage {
  return {
    wallMs: input.wallMs,
    tokens: {},
    completeness: "unavailable",
    billingMode: "unknown",
    costSource: "unknown",
  };
}

const COMPLETENESS_RANK: Record<UsageCompleteness, number> = {
  complete: 0,
  partial: 1,
  unavailable: 2,
};

function worseCompleteness(
  a: UsageCompleteness,
  b: UsageCompleteness,
): UsageCompleteness {
  return COMPLETENESS_RANK[a] >= COMPLETENESS_RANK[b] ? a : b;
}

// Accumulates two attempts' usage within one step. A failed attempt's tokens
// still cost money (ported rationale from `sumUsage` in `src/usage.ts`), so
// this sums, never replaces. Cash and notional accumulate independently
// (spec: "Cash And Notional Cost Stay Separate") — neither is ever read to
// derive the other. billingMode/costSource fall back to "unknown" on
// disagreement between attempts rather than guessing which one is right.
export function sumNormalizedUsage(
  a: NormalizedUsage,
  b: NormalizedUsage,
): NormalizedUsage {
  return {
    wallMs: a.wallMs + b.wallMs,
    tokens: {
      inputUncached: sumIfAnyDefined(
        a.tokens.inputUncached,
        b.tokens.inputUncached,
      ),
      inputCacheRead: sumIfAnyDefined(
        a.tokens.inputCacheRead,
        b.tokens.inputCacheRead,
      ),
      inputCacheWrite: sumIfAnyDefined(
        a.tokens.inputCacheWrite,
        b.tokens.inputCacheWrite,
      ),
      inputOther: sumIfAnyDefined(a.tokens.inputOther, b.tokens.inputOther),
      outputVisible: sumIfAnyDefined(
        a.tokens.outputVisible,
        b.tokens.outputVisible,
      ),
      outputReasoning: sumIfAnyDefined(
        a.tokens.outputReasoning,
        b.tokens.outputReasoning,
      ),
      outputOther: sumIfAnyDefined(a.tokens.outputOther, b.tokens.outputOther),
      inputKnown: sumIfAnyDefined(a.tokens.inputKnown, b.tokens.inputKnown),
      outputKnown: sumIfAnyDefined(a.tokens.outputKnown, b.tokens.outputKnown),
      totalKnown: sumIfAnyDefined(a.tokens.totalKnown, b.tokens.totalKnown),
      providerReportedTotal: sumIfAnyDefined(
        a.tokens.providerReportedTotal,
        b.tokens.providerReportedTotal,
      ),
    },
    completeness: worseCompleteness(a.completeness, b.completeness),
    billingMode: a.billingMode === b.billingMode ? a.billingMode : "unknown",
    costSource: a.costSource === b.costSource ? a.costSource : "unknown",
    cashCostUsd: sumIfAnyDefined(a.cashCostUsd, b.cashCostUsd),
    notionalCostUsd: sumIfAnyDefined(a.notionalCostUsd, b.notionalCostUsd),
  };
}

// §4.1 line 195: "The first usage event fixes the attempt's aggregation
// mode. snapshot replaces the current provider snapshot; delta adds disjoint
// increments. A later mode change is protocol_mismatch." This reducer is the
// pure state machine PR2's transports will fold provider usage events
// through — a mode change throws rather than silently mixing.
export type UsageUpdateMode = "snapshot" | "delta";

export class UsageModeMismatchError extends Error {
  readonly attemptMode: UsageUpdateMode;
  readonly incomingMode: UsageUpdateMode;

  constructor(attemptMode: UsageUpdateMode, incomingMode: UsageUpdateMode) {
    super(
      `usage event mode mismatch: attempt started as "${attemptMode}", received "${incomingMode}"`,
    );
    this.name = "UsageModeMismatchError";
    this.attemptMode = attemptMode;
    this.incomingMode = incomingMode;
  }
}

export interface UsageModeState {
  readonly mode: UsageUpdateMode;
  readonly tokens: Partial<NormalizedTokens>;
}

export function applyUsageUpdate(
  state: UsageModeState | undefined,
  mode: UsageUpdateMode,
  update: Partial<NormalizedTokens>,
): UsageModeState {
  if (state !== undefined && state.mode !== mode) {
    throw new UsageModeMismatchError(state.mode, mode);
  }
  if (mode === "snapshot") {
    return { mode, tokens: { ...update } };
  }
  const merged: Record<string, number> = { ...(state?.tokens ?? {}) };
  for (const [key, value] of Object.entries(update)) {
    if (typeof value === "number") {
      merged[key] = (merged[key] ?? 0) + value;
    }
  }
  return { mode, tokens: merged as Partial<NormalizedTokens> };
}

// spec: "Legacy Usage Projection At The Published Boundary" — the ONLY place
// NormalizedUsage becomes the legacy flat shape. Field names are copied
// verbatim from `SessionUsage` (src/usage.ts) because
// `../deep-review/runner/telemetry.ts` reads them by name off `runPipeline`'s
// returned `usage` object; a rename there would zero the bench ledger
// silently. When the input/output split is unknown (partial usage), the
// total is preserved but the split is honestly reported as 0 rather than
// invented.
export function projectLegacyUsage(usage: NormalizedUsage): SessionUsage {
  const t = usage.tokens;
  const tokens_in =
    t.inputKnown ??
    sumIfAnyDefined(
      t.inputUncached,
      t.inputCacheRead,
      t.inputCacheWrite,
      t.inputOther,
    ) ??
    0;
  const tokens_out =
    t.outputKnown ??
    sumIfAnyDefined(t.outputVisible, t.outputReasoning, t.outputOther) ??
    0;
  const tokens_total =
    t.totalKnown ?? t.providerReportedTotal ?? tokens_in + tokens_out;
  return {
    wall_ms: usage.wallMs,
    tokens_in,
    tokens_out,
    tokens_total,
    cost_usd_est: usage.cashCostUsd ?? 0,
  };
}
