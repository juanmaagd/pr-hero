// Phase B prior classification for item 7 (`docs/item7-rereview-design.md` §3.3).
// Pure: git facts + recovered triage in, a status or a verify-queue entry out.
// No LLM, no I/O. Phase E (overlap / worsening) and phase F (verdicts) are
// separate — this module only settles what the design says settles before
// hunters run, and queues the rest.
//
// Precedence is ordered rules, not first-match-wins rows. Rename rewrites
// paths and re-enters at rule 1 (R2-C1); triage outranks touched (O-3);
// `resolved` is never inferred from absence (C1).

import type { Severity, Tier } from "./findings";
import {
  type FindingIdentity,
  formatLocs,
  identityFromLocs,
  mapIdentityPaths,
} from "./rereview-identity";
import type { TriageTag, TriageVerdict } from "./triage";

export type RereviewCase = "A" | "B" | "C" | "D" | "E";

export type GateStatus =
  | "carried"
  | "verified-gone"
  | "unconfirmed"
  | "suppressed"
  | "deferred"
  | "returned"
  | "re-tiered"
  | "queued";

export type VerifyTrigger =
  | "applied"
  | "touched"
  | "overlap"
  | "verify_all"
  | "case_b_reply";

export type FindingChannel = "inline" | "outside";

export interface PriorTriage {
  tag: TriageTag;
  // `applied` carries no adjudicator verdict (`src/triage.ts` ADJUDICATED_TAGS).
  verdict: TriageVerdict | null;
  // ISO-8601 from GitHub. Null means we cannot prove newness (R2-S9).
  createdAt: string | null;
}

export interface PriorRecord {
  id: string;
  sev: Severity;
  tier: Tier;
  channel: FindingChannel;
  locs: readonly string[];
  claim: string;
  triage: PriorTriage | null;
  // Case B rule 7b: any new reply on the prior thread, including tags
  // other than a newly-applied `applied` (that one is rule 7).
  newThreadReply: boolean;
}

export interface PhaseBContext {
  case: RereviewCase;
  deletedFiles: ReadonlySet<string>;
  renameMap: ReadonlyMap<string, string>;
  touched: (identity: FindingIdentity) => boolean;
  summaryUpdatedAt: string | null;
}

export interface PhaseBResult {
  id: string;
  status: GateStatus;
  locs: string[];
  renamed: boolean;
  trigger?: VerifyTrigger;
}

export function classifyPrior(
  prior: PriorRecord,
  ctx: PhaseBContext,
): PhaseBResult {
  const original = identityFromLocs(prior.locs);
  const rewritten = mapIdentityPaths(
    original,
    (path) => ctx.renameMap.get(path) ?? path,
  );
  const locs = formatLocs(rewritten);
  const renamed = formatLocs(original).join("\0") !== locs.join("\0");

  if (everyFileDeleted(rewritten, ctx.deletedFiles)) {
    return { id: prior.id, status: "verified-gone", locs, renamed };
  }

  const triage = prior.triage;
  if (triage?.tag === "dismissed" && triage.verdict === "upheld") {
    return { id: prior.id, status: "suppressed", locs, renamed };
  }
  if (triage?.tag === "dismissed" && triage.verdict === "rejected") {
    return { id: prior.id, status: "returned", locs, renamed };
  }
  if (triage?.tag === "deferred") {
    return { id: prior.id, status: "deferred", locs, renamed };
  }
  if (triage?.tag === "misclassified") {
    return { id: prior.id, status: "re-tiered", locs, renamed };
  }

  if (ctx.case === "D" || ctx.case === "E") {
    return {
      id: prior.id,
      status: "queued",
      locs,
      renamed,
      trigger: "verify_all",
    };
  }

  if (triage?.tag === "applied" && appliedBuysVerify(triage, ctx)) {
    return {
      id: prior.id,
      status: "queued",
      locs,
      renamed,
      trigger: "applied",
    };
  }

  if (ctx.case === "B" && prior.newThreadReply) {
    return {
      id: prior.id,
      status: "queued",
      locs,
      renamed,
      trigger: "case_b_reply",
    };
  }

  if (ctx.touched(rewritten)) {
    return {
      id: prior.id,
      status: "queued",
      locs,
      renamed,
      trigger: "touched",
    };
  }

  return { id: prior.id, status: "carried", locs, renamed };
}

function everyFileDeleted(
  identity: FindingIdentity,
  deletedFiles: ReadonlySet<string>,
): boolean {
  if (identity.size === 0) return false;
  for (const path of identity.keys()) {
    if (!deletedFiles.has(path)) return false;
  }
  return true;
}

function appliedBuysVerify(triage: PriorTriage, ctx: PhaseBContext): boolean {
  if (ctx.case !== "B") return true;
  return isNewReply(triage.createdAt, ctx.summaryUpdatedAt);
}

function isNewReply(
  createdAt: string | null,
  summaryUpdatedAt: string | null,
): boolean {
  if (createdAt === null || summaryUpdatedAt === null) return false;
  return createdAt > summaryUpdatedAt;
}
