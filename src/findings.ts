// Findings JSON schema v1.0.0 (design D2, reconciliation R1/R2).
// Ported verbatim from deep-review/runner/findings.ts — the lab and the engine
// must agree on these bytes' semantics or benchmark artifacts stop validating.
// Owned by the driver: hunter steps emit unvalidated drafts; this module
// validates the assembled output and merges in the driver-owned run envelope
// (schema_version, telemetry) before anything is written to a run dir.

import type { RootCauseSummary } from "./root-cause";

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
// `downgraded-latent` (ROADMAP A2) is the "real, but unreachable today"
// verdict: the claim survives scrutiny as a genuine defect, yet nothing can
// execute it at this commit — a bug in newly-added code no caller wires up
// yet. It is deliberately NOT `refuted`, because refuting deletes the finding
// from findings[] and the G6 lesson was that a real defect must never be
// deleted for being latent. It lands advisory instead: recorded, visible, and
// unable to block a merge. Additive widening; validators only reject
// out-of-set values, so historical artifacts keep validating.
export type RefuterVerdict =
  | "corroborated"
  | "refuted"
  | "inconclusive"
  | "downgraded-latent"
  | "not_submitted";
export type Tier = "blocking" | "advisory";
export type Hunter = "reliability" | "resilience" | "parity" | "lifecycle";
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
  // Which derived root-cause cluster this finding belongs to (RC001, …).
  // ADDITIVE and OPTIONAL: both validators are pure allowlists that reject
  // only bad values of known keys, never unknown keys, so a document carrying
  // this field still validates against the unchanged 1.0.0 schema on the lab
  // side and a document without it still validates here. No version bump.
  root_cause_id?: string;
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
  // Juanma's decision (verify-report-pr3, #3305), over the verifier's cheaper
  // "make `post` as permissive as `--pr --post`" suggestion: `run_status:
  // "partial"` with zero findings covers at least THREE distinct situations
  // — every hunter failed (the true sessionFailed case, pipeline.ts:771),
  // no hunter ran at all because gotchas were missing (pipeline.ts:330-352,
  // sessionFailed: false), or one hunter died while the others found
  // nothing. `run_status` alone cannot tell these apart, so a permissive
  // `post` verb would publish a clean bill for a review that never ran.
  // ADDITIVE and OPTIONAL, same precedent as `root_cause_id` above: both
  // validators are allowlists that never reject unknown keys, so schema
  // stays 1.0.0 (project rule 5 — lab compatibility is sacred) and an
  // existing artifact without this field still validates. Absent MUST mean
  // "unknown", never "false" — see `runPostCommand`'s guard in cli.ts for
  // the back-compat fallback this enables.
  sessionFailed?: boolean;
  telemetry: Telemetry;
  findings: Finding[];
  debug: {
    refuted: DebugRefutedFinding[];
    deduped?: DebugDedupedFinding[];
    // The whole derived partition, kept next to the findings it describes.
    // Also additive/optional: a run that never computed it validates the same.
    root_causes?: RootCauseSummary;
  };
}

// Draft the engine assembles before the driver merges in the run envelope.
export interface SkillOutput {
  findings: Finding[];
  debug: {
    refuted: DebugRefutedFinding[];
    deduped?: DebugDedupedFinding[];
    root_causes?: RootCauseSummary;
  };
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
  "downgraded-latent",
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
const HUNTERS: Hunter[] = ["reliability", "resilience", "parity", "lifecycle"];

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
  // Additive/optional (root_cause_id precedent): absent is valid (older
  // artifacts), but a PRESENT value must be a boolean — same "reject only
  // bad values of known keys, never unknown keys" allowlist discipline as
  // every other optional field here.
  must(
    d.sessionFailed === undefined || typeof d.sessionFailed === "boolean",
    "sessionFailed must be a boolean when present",
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
// corroborated-or-deterministic BLOCKER/CRITICAL findings may block, and even
// a deterministic one is demoted to advisory when the refuter returns the
// positive `downgraded-latent` verdict.
export function deriveTier(
  finding: Pick<Finding, "severity" | "evidence_class" | "refuter_verdict">,
): Tier {
  const isBlockerClass =
    finding.severity === "BLOCKER" || finding.severity === "CRITICAL";
  if (!isBlockerClass) return "advisory";
  if (finding.evidence_class === "insufficient") return "advisory";
  // Ordered BEFORE the deterministic short-circuit on purpose. A verdict that
  // could not outrank `deterministic` would be inert exactly where it is
  // needed: the 2026-07-29 AudioTrimmer runs put 26 of 26 blocking findings in
  // that class, so the gate had nothing to act on. Only a POSITIVE downgrade
  // gets this power — `inconclusive` still blocks, mirroring the rule that
  // `refuted` requires positive disproof. Silence is not a demotion.
  if (finding.refuter_verdict === "downgraded-latent") return "advisory";
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
    sessionFailed: params.sessionFailed,
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
