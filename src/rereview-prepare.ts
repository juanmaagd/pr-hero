// Impure-half orchestration for item 7 discovery (`docs/item7-rereview-design.md`
// §3.1). Git facts arrive through `RereviewGit` so the CLI owns `cat-file`,
// `merge-base --is-ancestor`, and `diff --name-only`, and tests inject fakes.
// The case machine itself stays in rereview-plan.ts.

import {
  classifyPrior,
  type PhaseBResult,
  type PriorRecord,
  type RereviewCase,
} from "./rereview-classify";
import type { FindingIdentity } from "./rereview-identity";
import {
  type DiscoveryPlan,
  decideRereviewCase,
  type LastHeadSource,
  type LastReviewedHead,
  type MarkerHead,
  planDiscovery,
  resolveLastReviewedHead,
  restrictedDiscoveryFiles,
} from "./rereview-plan";
import type { LiveFinding, StateFinding } from "./rereview-state";
import type { VerifyQueueEntry } from "./rereview-verify";

export interface RereviewGit {
  commitExists(sha: string): Promise<boolean>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  nameOnly(from: string, to: string): Promise<string[]>;
}

export interface PreparedDiscovery {
  last: LastReviewedHead;
  case: RereviewCase;
  plan: DiscoveryPlan;
  // Null: unrestricted B..H (hunters see the full PR range). Empty: skip
  // discovery — no files in the restricted intersection, or case B.
  discoveryPaths: string[] | null;
  discoveryFrom: string;
  discoveryTo: string;
  discoverySkippedEmptyDelta: boolean;
}

export interface RereviewProvenance {
  case: RereviewCase;
  last_reviewed_head: string | null;
  last_head_source: LastHeadSource;
  discovery_range: string;
  discovery_restricted: boolean;
  discovery_skipped_empty_delta: boolean;
  prior_findings: number;
  settled_deterministically: number;
  verified: number;
  verification_capped: number;
  verification_triggers: {
    applied: number;
    touched: number;
    overlap: number;
    verify_all: number;
  };
  live: LiveFinding[];
  resolved_verified?: number;
  returned?: number;
  re_tiered?: number;
}

export function parseNameOnly(stdout: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const path = line.trim();
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  out.sort();
  return out;
}

export function shouldAbortEmptyDiscovery(
  plan: DiscoveryPlan,
  patch: string,
): boolean {
  return plan.emptyDeltaIsError && patch.trim().length === 0;
}

export async function prepareDiscovery(input: {
  B: string;
  H: string;
  full: boolean;
  summaryHead: string | null;
  findingMarkers: readonly MarkerHead[];
  git: RereviewGit;
}): Promise<PreparedDiscovery> {
  const last = resolveLastReviewedHead({
    summaryHead: input.summaryHead,
    findingMarkers: input.findingMarkers,
  });
  let objectExists: boolean | null = null;
  let isAncestor: boolean | null = null;
  if (last.L !== null) {
    objectExists = await input.git.commitExists(last.L);
    if (objectExists) {
      isAncestor = await input.git.isAncestor(last.L, input.H);
    }
  }
  const rereviewCase = decideRereviewCase({
    L: last.L,
    H: input.H,
    objectExists,
    isAncestor,
  });
  const plan = planDiscovery({ case: rereviewCase, full: input.full });

  if (plan.skipDiscovery) {
    const from = last.L ?? input.B;
    return {
      last,
      case: rereviewCase,
      plan,
      discoveryPaths: [],
      discoveryFrom: from,
      discoveryTo: input.H,
      discoverySkippedEmptyDelta: true,
    };
  }

  if (plan.discovery !== "restricted" || last.L === null) {
    return {
      last,
      case: rereviewCase,
      plan,
      discoveryPaths: null,
      discoveryFrom: input.B,
      discoveryTo: input.H,
      discoverySkippedEmptyDelta: false,
    };
  }

  const [prFiles, deltaFiles] = await Promise.all([
    input.git.nameOnly(input.B, input.H),
    input.git.nameOnly(last.L, input.H),
  ]);
  const discoveryPaths = restrictedDiscoveryFiles(prFiles, deltaFiles);
  return {
    last,
    case: rereviewCase,
    plan,
    discoveryPaths,
    discoveryFrom: last.L,
    discoveryTo: input.H,
    discoverySkippedEmptyDelta: discoveryPaths.length === 0,
  };
}

// First review (case A) carries no block at all (W-prov). Counts that the
// verify spawn has not filled yet stay zero rather than omitted — an
// artifact that cannot name its case is unscorable; zeros are still a case.
export function toRereviewProvenance(
  prepared: PreparedDiscovery,
  priorFindings = 0,
): RereviewProvenance | undefined {
  if (prepared.case === "A") return undefined;
  return {
    case: prepared.case,
    last_reviewed_head: prepared.last.L,
    last_head_source: prepared.last.source,
    discovery_range: `${prepared.discoveryFrom}..${prepared.discoveryTo}`,
    discovery_restricted: prepared.plan.discoveryRestricted,
    discovery_skipped_empty_delta: prepared.discoverySkippedEmptyDelta,
    prior_findings: priorFindings,
    settled_deterministically: 0,
    verified: 0,
    verification_capped: 0,
    verification_triggers: {
      applied: 0,
      touched: 0,
      overlap: 0,
      verify_all: 0,
    },
    live: [],
    resolved_verified: 0,
    returned: 0,
    re_tiered: 0,
  };
}

export interface NameStatus {
  files: string[];
  deleted: string[];
  renameMap: Map<string, string>;
}

// `git diff --name-status` lines. Renames are `R100\told\tnew`. Every path
// mentioned — including deleted and the old side of a rename — is a touched
// path: S-revert needs the unrestricted L..H set, not the surviving dest.
export function parseNameStatus(stdout: string): NameStatus {
  const files = new Set<string>();
  const deleted: string[] = [];
  const renameMap = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const status = line[0];
    const rest = line.slice(1).replace(/^\d*/, "").replace(/^\t/, "");
    const parts = rest.split("\t").filter((p) => p.length > 0);
    if (status === "R" || status === "C") {
      const from = parts[0];
      const to = parts[1];
      if (from === undefined || to === undefined) continue;
      renameMap.set(from, to);
      files.add(from);
      files.add(to);
      continue;
    }
    const path = parts[0];
    if (path === undefined) continue;
    files.add(path);
    if (status === "D") deleted.push(path);
  }
  return {
    files: [...files].sort(),
    deleted: deleted.sort(),
    renameMap,
  };
}

export function buildPhaseBQueue(input: {
  case: RereviewCase;
  priors: readonly PriorRecord[];
  nameStatus: NameStatus;
  summaryUpdatedAt: string | null;
}): {
  queued: VerifyQueueEntry[];
  overlapCandidates: VerifyQueueEntry[];
  settled: PhaseBResult[];
} {
  const deltaFiles = new Set(input.nameStatus.files);
  const ctx = {
    case: input.case,
    deletedFiles: new Set(input.nameStatus.deleted),
    renameMap: input.nameStatus.renameMap,
    touched: (identity: FindingIdentity) =>
      [...identity.keys()].some((path) => deltaFiles.has(path)),
    summaryUpdatedAt: input.summaryUpdatedAt,
  };
  const queued: VerifyQueueEntry[] = [];
  const overlapCandidates: VerifyQueueEntry[] = [];
  const settled: PhaseBResult[] = [];
  for (const prior of input.priors) {
    const result = classifyPrior(prior, ctx);
    settled.push(result);
    const entry = {
      priorId: prior.id,
      sev: prior.sev,
      trigger: result.trigger ?? "touched",
      claim: prior.claim,
      locs: result.locs,
      authorReply: "",
      commentBody: "",
      triageTag: prior.triage?.tag ?? "",
      deltaHunks: "",
    };
    if (result.status === "queued" && result.trigger !== undefined) {
      queued.push({ ...entry, trigger: result.trigger });
    } else if (result.status === "carried") {
      overlapCandidates.push(entry);
    }
  }
  return { queued, overlapCandidates, settled };
}

export function priorsFromStateFindings(
  findings: readonly StateFinding[],
): PriorRecord[] {
  return findings.map((finding) => ({
    id: finding.id,
    sev: finding.sev,
    tier: finding.tier,
    channel: finding.channel,
    locs: finding.locs,
    claim: finding.claim,
    triage: null,
    newThreadReply: false,
  }));
}

export function priorsFromPostedMarkers(
  posted: readonly {
    path: string;
    line: number;
    channel: "inline" | "outside";
  }[],
): PriorRecord[] {
  return posted.map((item, i) => ({
    id: `R${String(i + 1).padStart(3, "0")}`,
    sev: "WARNING",
    tier: "advisory",
    channel: item.channel,
    locs: [`${item.path}:${item.line}`],
    claim: "",
    triage: null,
    newThreadReply: false,
  }));
}
