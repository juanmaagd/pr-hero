// Findings JSON schema v1.0.0 (design D2, reconciliation R1/R2).
// Ported verbatim from deep-review/runner/findings.ts — the lab and the engine
// must agree on these bytes' semantics or benchmark artifacts stop validating.
// Owned by the driver: hunter steps emit unvalidated drafts; this module
// validates the assembled output and merges in the driver-owned run envelope
// (schema_version, telemetry) before anything is written to a run dir.

export const SCHEMA_VERSION = "1.0.0";

export type EvidenceClass = "deterministic" | "inferential" | "insufficient";
export type CausalDisposition =
  | "introduced"
  | "behavior-activated"
  | "worsened"
  | "pre-existing"
  | "base-only"
  | "unknown";
export type Severity = "BLOCKER" | "CRITICAL" | "WARNING" | "SUGGESTION";
// Canonical "not sent to refuter" value per reconciliation R1 (spec's `n/a` maps to this).
export type RefuterVerdict =
  | "corroborated"
  | "refuted"
  | "inconclusive"
  | "not_submitted";
export type Tier = "blocking" | "advisory";
export type Hunter = "reliability" | "resilience" | "parity";
export type RunStatus = "complete" | "partial";
export type IndexMode = "fresh" | "sync";

export interface HopTrailStep {
  step: number;
  kind: string;
  query: string;
  reached: string;
}

export interface Finding {
  id: string;
  category: number; // hunting-map.md taxonomy, 1-14
  path: string;
  line: number;
  symbol?: string;
  severity: Severity;
  evidence_class: EvidenceClass;
  refuter_verdict: RefuterVerdict;
  causal_disposition: CausalDisposition;
  claim: string;
  proof_refs: string[];
  hunter: Hunter;
  tier: Tier;
  hops_used: number;
  hop_trail: HopTrailStep[];
  dedupe_key: string;
}

// Refuted findings are excluded from `findings[]` (scorer contract unchanged)
// but stay visible here in benchmark mode only, per reconciliation R2.
export type DebugRefutedFinding = Omit<Finding, "tier"> & {
  refuter_verdict: "refuted";
};

// Step 5 merge losers. Without these, a benchmark miss cannot be attributed:
// "no hunter saw it" and "a hunter saw it and dedupe collapsed it into a
// weaker sibling claim" look identical in `findings[]`.
export type DebugDedupedFinding = Omit<Finding, "tier"> & {
  merged_into: string;
};

export interface Telemetry {
  index_ms: number;
  index_mode: IndexMode;
  sync_ms?: number;
  index_disk_mb: number;
  wall_ms: number;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  cost_usd_est: number;
  // Engine v2 populates this per step (it runs one session per agent). The
  // original best-effort caveat (reconciliation R3) still applies to v1
  // documents: absence must never fail validation.
  per_agent?: Record<string, { tokens_total: number; duration_ms: number }>;
}

// Which prompt bytes produced this score. Optional because runs 1-3 predate
// repo-side prompt sets; every run from honest iteration 2 on must carry it,
// otherwise an A/B delta cannot be attributed to a prompt at all.
export interface PromptSet {
  name: string; // directory basename, e.g. "arm-a"
  sha256: string; // fingerprint over the concatenated agent files
}

export interface FindingsDocument {
  schema_version: string;
  pr: number;
  base_sha: string;
  head_sha: string;
  model: string;
  iteration: number;
  prompt_set?: PromptSet;
  // Fingerprint of the driver sources that produced this run. Iteration 2 was
  // smeared by a mid-flight driver edit that left no trace in the artifacts.
  driver_sha?: string;
  // Which engine produced this run. Absent on v1 (monolithic orchestrator)
  // documents; v2 (pr-hero) documents always carry it — without this field,
  // v1 and v2 rows in the metrics ledger are indistinguishable (same
  // prompt_set sha on both sides of the engine swap).
  engine?: { name: string; version: string };
  parity_hunter_fired: boolean;
  run_status: RunStatus;
  telemetry: Telemetry;
  findings: Finding[];
  debug: { refuted: DebugRefutedFinding[]; deduped?: DebugDedupedFinding[] };
}

// Draft the engine assembles before the driver merges in the run envelope.
export interface SkillOutput {
  findings: Finding[];
  debug: { refuted: DebugRefutedFinding[]; deduped?: DebugDedupedFinding[] };
  parity_hunter_fired: boolean;
  run_status: RunStatus;
}

const SEVERITIES: Severity[] = ["BLOCKER", "CRITICAL", "WARNING", "SUGGESTION"];
const EVIDENCE_CLASSES: EvidenceClass[] = [
  "deterministic",
  "inferential",
  "insufficient",
];
const REFUTER_VERDICTS: RefuterVerdict[] = [
  "corroborated",
  "refuted",
  "inconclusive",
  "not_submitted",
];
const CAUSAL_DISPOSITIONS: CausalDisposition[] = [
  "introduced",
  "behavior-activated",
  "worsened",
  "pre-existing",
  "base-only",
  "unknown",
];
const TIERS: Tier[] = ["blocking", "advisory"];
const HUNTERS: Hunter[] = ["reliability", "resilience", "parity"];

export class FindingsValidationError extends Error {}

function must(condition: boolean, message: string): void {
  if (!condition) throw new FindingsValidationError(message);
}

export function validateFinding(candidate: unknown, index: number): Finding {
  must(
    typeof candidate === "object" && candidate !== null,
    `findings[${index}] must be an object`,
  );
  const f = candidate as Record<string, unknown>;
  must(
    typeof f.id === "string" && f.id.length > 0,
    `findings[${index}].id required`,
  );
  must(
    typeof f.category === "number" && f.category >= 1 && f.category <= 14,
    `findings[${index}].category must be 1-14`,
  );
  must(
    typeof f.path === "string" && f.path.length > 0,
    `findings[${index}].path required`,
  );
  must(typeof f.line === "number", `findings[${index}].line must be a number`);
  must(
    SEVERITIES.includes(f.severity as Severity),
    `findings[${index}].severity invalid`,
  );
  must(
    EVIDENCE_CLASSES.includes(f.evidence_class as EvidenceClass),
    `findings[${index}].evidence_class invalid`,
  );
  must(
    REFUTER_VERDICTS.includes(f.refuter_verdict as RefuterVerdict),
    `findings[${index}].refuter_verdict invalid`,
  );
  must(
    CAUSAL_DISPOSITIONS.includes(f.causal_disposition as CausalDisposition),
    `findings[${index}].causal_disposition invalid`,
  );
  must(
    typeof f.claim === "string" && f.claim.length > 0,
    `findings[${index}].claim required`,
  );
  must(
    Array.isArray(f.proof_refs),
    `findings[${index}].proof_refs must be an array`,
  );
  must(
    HUNTERS.includes(f.hunter as Hunter),
    `findings[${index}].hunter invalid`,
  );
  must(TIERS.includes(f.tier as Tier), `findings[${index}].tier invalid`);
  must(
    typeof f.hops_used === "number",
    `findings[${index}].hops_used must be a number`,
  );
  must(
    Array.isArray(f.hop_trail),
    `findings[${index}].hop_trail must be an array`,
  );
  must(
    typeof f.dedupe_key === "string" && f.dedupe_key.length > 0,
    `findings[${index}].dedupe_key required`,
  );
  return f as unknown as Finding;
}

export function validateFindingsDocument(candidate: unknown): FindingsDocument {
  must(
    typeof candidate === "object" && candidate !== null,
    "findings document must be an object",
  );
  const d = candidate as Record<string, unknown>;
  must(
    d.schema_version === SCHEMA_VERSION,
    `schema_version must be ${SCHEMA_VERSION}`,
  );
  must(typeof d.pr === "number", "pr must be a number");
  must(
    typeof d.base_sha === "string" && d.base_sha.length > 0,
    "base_sha required",
  );
  must(
    typeof d.head_sha === "string" && d.head_sha.length > 0,
    "head_sha required",
  );
  must(typeof d.model === "string" && d.model.length > 0, "model required");
  must(typeof d.iteration === "number", "iteration must be a number");
  must(
    typeof d.parity_hunter_fired === "boolean",
    "parity_hunter_fired must be a boolean",
  );
  must(
    d.run_status === "complete" || d.run_status === "partial",
    "run_status must be complete|partial",
  );
  must(
    typeof d.telemetry === "object" && d.telemetry !== null,
    "telemetry required",
  );
  must(Array.isArray(d.findings), "findings must be an array");
  (d.findings as unknown[]).forEach((f, i) => {
    validateFinding(f, i);
  });
  const debug = d.debug as Record<string, unknown> | undefined;
  must(
    !!debug && Array.isArray(debug.refuted),
    "debug.refuted must be an array",
  );
  return d as unknown as FindingsDocument;
}

// Full tier-assignment rule (spec BR "Full Tier-Assignment Rule"): only
// corroborated-or-deterministic BLOCKER/CRITICAL findings may block.
export function deriveTier(
  finding: Pick<Finding, "severity" | "evidence_class" | "refuter_verdict">,
): Tier {
  const isBlockerClass =
    finding.severity === "BLOCKER" || finding.severity === "CRITICAL";
  if (!isBlockerClass) return "advisory";
  if (finding.evidence_class === "insufficient") return "advisory";
  if (finding.evidence_class === "deterministic") return "blocking";
  return finding.refuter_verdict === "corroborated" ? "blocking" : "advisory";
}

export function mergeRunEnvelope(params: {
  skillOutput: SkillOutput;
  pr: number;
  base_sha: string;
  head_sha: string;
  model: string;
  iteration: number;
  prompt_set?: PromptSet;
  driver_sha?: string;
  engine?: { name: string; version: string };
  sessionFailed: boolean;
  telemetry: Telemetry;
}): FindingsDocument {
  const run_status: RunStatus =
    params.sessionFailed || params.skillOutput.run_status === "partial"
      ? "partial"
      : "complete";
  return {
    schema_version: SCHEMA_VERSION,
    pr: params.pr,
    base_sha: params.base_sha,
    head_sha: params.head_sha,
    model: params.model,
    iteration: params.iteration,
    ...(params.prompt_set ? { prompt_set: params.prompt_set } : {}),
    ...(params.driver_sha ? { driver_sha: params.driver_sha } : {}),
    ...(params.engine ? { engine: params.engine } : {}),
    parity_hunter_fired: params.skillOutput.parity_hunter_fired,
    run_status,
    telemetry: params.telemetry,
    findings: params.skillOutput.findings,
    debug: params.skillOutput.debug,
  };
}

export async function writeFindings(
  outPath: string,
  doc: FindingsDocument,
): Promise<void> {
  const validated = validateFindingsDocument(doc);
  await Bun.write(outPath, `${JSON.stringify(validated, null, 2)}\n`);
}
