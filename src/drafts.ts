// Hunter/refuter output handling: extraction from a session's final message
// and structural validation BEFORE anything reaches the pipeline. A step whose
// final text does not survive these checks is "not delivered" — the same role
// v1's draftDelivered() played for the monolithic session, applied per step.

import type {
  CausalDisposition,
  EvidenceClass,
  Finding,
  Hunter,
  Severity,
} from "./findings";

// What a hunter emits: a Finding minus the two fields the pipeline assigns
// later (tier at Step 7, refuter_verdict at Step 6).
export type DraftFinding = Omit<Finding, "tier" | "refuter_verdict">;

export interface HunterDraft {
  findings: DraftFinding[];
}

// `downgraded-latent` (ROADMAP A2): the claim holds as a real defect, but
// nothing can execute it at this commit. Distinct from `refuted`, which
// deletes the finding — the G6 lesson is that a latent defect must stay
// visible. Maps to the same-named RefuterVerdict and lands advisory.
export type RefuterOutcome =
  | "corroborated"
  | "refuted"
  | "inconclusive"
  | "downgraded-latent";

export interface RefuterResult {
  results: Array<{
    finding_id: string;
    outcome: RefuterOutcome;
    proof_refs: string[];
  }>;
}

export class DraftValidationError extends Error {}

function must(condition: boolean, message: string): void {
  if (!condition) throw new DraftValidationError(message);
}

// Fence/prose-tolerant JSON extraction. Models occasionally wrap the mandated
// JSON-only final message in a code fence or a sentence of prose; both are
// recoverable without a retry. Anything not confidently readable returns
// undefined (never a guess) — the caller treats that as "not delivered".
export function extractJsonObject(finalText: string): unknown {
  const direct = tryParse(finalText.trim());
  if (direct !== undefined) return direct;

  const fenced = finalText.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  // Last resort: the outermost brace span. Covers "Here is the result: {...}".
  const first = finalText.indexOf("{");
  const last = finalText.lastIndexOf("}");
  if (first !== -1 && last > first) {
    return tryParse(finalText.slice(first, last + 1));
  }
  return undefined;
}

function tryParse(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const SEVERITIES: Severity[] = ["BLOCKER", "CRITICAL", "WARNING", "SUGGESTION"];
const EVIDENCE_CLASSES: EvidenceClass[] = [
  "deterministic",
  "inferential",
  "insufficient",
];
const CAUSAL_DISPOSITIONS: CausalDisposition[] = [
  "introduced",
  "behavior-activated",
  "worsened",
  "pre-existing",
  "base-only",
  "unknown",
];
const HUNTERS: Hunter[] = ["reliability", "resilience", "parity", "lifecycle"];
const REFUTER_OUTCOMES: RefuterOutcome[] = [
  "corroborated",
  "refuted",
  "inconclusive",
  "downgraded-latent",
];

export function validateDraftFinding(
  candidate: unknown,
  index: number,
): DraftFinding {
  must(
    typeof candidate === "object" && candidate !== null,
    `draft findings[${index}] must be an object`,
  );
  const f = candidate as Record<string, unknown>;
  must(
    typeof f.id === "string" && f.id.length > 0,
    `draft findings[${index}].id required`,
  );
  must(
    typeof f.category === "number" && f.category >= 1 && f.category <= 14,
    `draft findings[${index}].category must be 1-14`,
  );
  must(
    typeof f.path === "string" && f.path.length > 0,
    `draft findings[${index}].path required`,
  );
  must(
    typeof f.line === "number",
    `draft findings[${index}].line must be a number`,
  );
  must(
    SEVERITIES.includes(f.severity as Severity),
    `draft findings[${index}].severity invalid`,
  );
  must(
    EVIDENCE_CLASSES.includes(f.evidence_class as EvidenceClass),
    `draft findings[${index}].evidence_class invalid`,
  );
  must(
    CAUSAL_DISPOSITIONS.includes(f.causal_disposition as CausalDisposition),
    `draft findings[${index}].causal_disposition invalid`,
  );
  must(
    typeof f.claim === "string" && f.claim.length > 0,
    `draft findings[${index}].claim required`,
  );
  must(
    Array.isArray(f.proof_refs),
    `draft findings[${index}].proof_refs must be an array`,
  );
  must(
    HUNTERS.includes(f.hunter as Hunter),
    `draft findings[${index}].hunter invalid`,
  );
  must(
    typeof f.hops_used === "number",
    `draft findings[${index}].hops_used must be a number`,
  );
  must(
    Array.isArray(f.hop_trail),
    `draft findings[${index}].hop_trail must be an array`,
  );
  must(
    typeof f.dedupe_key === "string" && f.dedupe_key.length > 0,
    `draft findings[${index}].dedupe_key required`,
  );
  return f as unknown as DraftFinding;
}

export function validateHunterDraft(candidate: unknown): HunterDraft {
  must(
    typeof candidate === "object" && candidate !== null,
    "hunter draft must be an object",
  );
  const d = candidate as Record<string, unknown>;
  must(Array.isArray(d.findings), "hunter draft .findings must be an array");
  (d.findings as unknown[]).forEach((f, i) => {
    validateDraftFinding(f, i);
  });
  return d as unknown as HunterDraft;
}

// The prose contract is "one verdict per finding, never implied". Here that
// stops being an instruction and becomes an invariant: the id sets must match
// EXACTLY — a missing verdict, a duplicate, or a verdict for a finding never
// submitted each reject the whole result (→ step not delivered → retry path).
export function validateRefuterResult(
  candidate: unknown,
  submittedIds: string[],
): RefuterResult {
  must(
    typeof candidate === "object" && candidate !== null,
    "refuter result must be an object",
  );
  const d = candidate as Record<string, unknown>;
  must(Array.isArray(d.results), "refuter result .results must be an array");
  const seen = new Set<string>();
  for (const [i, entry] of (d.results as unknown[]).entries()) {
    must(
      typeof entry === "object" && entry !== null,
      `refuter results[${i}] must be an object`,
    );
    const r = entry as Record<string, unknown>;
    must(
      typeof r.finding_id === "string" && r.finding_id.length > 0,
      `refuter results[${i}].finding_id required`,
    );
    must(
      REFUTER_OUTCOMES.includes(r.outcome as RefuterOutcome),
      `refuter results[${i}].outcome invalid`,
    );
    must(
      Array.isArray(r.proof_refs),
      `refuter results[${i}].proof_refs must be an array`,
    );
    const id = r.finding_id as string;
    must(!seen.has(id), `refuter results duplicate verdict for ${id}`);
    must(
      submittedIds.includes(id),
      `refuter results verdict for never-submitted ${id}`,
    );
    seen.add(id);
  }
  for (const id of submittedIds) {
    must(seen.has(id), `refuter results missing verdict for ${id}`);
  }
  return d as unknown as RefuterResult;
}
