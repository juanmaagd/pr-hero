// Summary-comment state block for item 7 (`docs/item7-rereview-design.md` §3.6).
// Pure. Second marker family on the summary, disjoint from `pr-hero-report`
// and `pr-hero-finding`. Recovers cross-run identity (including Outside Diff)
// from the PR alone — no ~/.prhero, no run directory (O-4).
//
// Placement is load-bearing (R2-S9): AFTER the report marker and visible
// body. `findMarkedCommentId` requires `body.startsWith(pr-hero-report)`,
// so a leading state block would orphan the summary every run.
//
// `R###` ids are stable and never reused (R2-S1). `claim` is required
// because a `channel:"outside"` finding's only copy lives in this block;
// the next PATCH would otherwise erase it (R2-S3).

import type { Severity, Tier } from "./findings";
import { claimFingerprint } from "./pr-preflight";
import { isFullCommitId } from "./preflight";
import type {
  FindingChannel,
  GateStatus,
  PhaseBResult,
  PriorRecord,
} from "./rereview-classify";

export const PR_STATE_MARKER_PREFIX = "<!-- pr-hero-state ";
export const GITHUB_ISSUE_COMMENT_MAX = 65536;

export type LiveStatus = "carried" | "unconfirmed" | "suppressed" | "deferred";

export interface StateFinding {
  id: string;
  sev: Severity;
  tier: Tier;
  channel: FindingChannel;
  locs: string[];
  c: string;
  claim: string;
}

export interface LiveFinding extends StateFinding {
  status: LiveStatus;
}

export interface ParsedStateBlock {
  headSha: string;
  findings: StateFinding[];
  reviews?: number;
}

const STATE_HEADER = /^<!-- pr-hero-state v=1 head=([0-9a-f]{40}) -->/;
const HTML_COMMENT = /<!--([\s\S]*?)-->/;
const R_ID = /^R(\d{3,})$/;

export function stateMarker(headSha: string): string {
  return `${PR_STATE_MARKER_PREFIX}v=1 head=${headSha} -->`;
}

export function parseStateBlock(body: string): ParsedStateBlock | null {
  const start = body.indexOf(PR_STATE_MARKER_PREFIX);
  if (start === -1) return null;
  const fromMarker = body.slice(start);
  const headerLine = fromMarker.split("\n", 1)[0] ?? "";
  const header = STATE_HEADER.exec(headerLine);
  if (header?.[1] === undefined) return null;
  const headSha = header[1];
  if (!isFullCommitId(headSha)) return null;
  const afterHeader = fromMarker.slice(headerLine.length);
  const jsonComment = HTML_COMMENT.exec(afterHeader);
  if (jsonComment?.[1] === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(jsonComment[1].trim());
    const findings = asStateFindings(parsed);
    if (findings === null) return null;
    const reviews = asStateReviews(parsed);
    if (reviews === null) return null;
    return { headSha, findings, ...(reviews === undefined ? {} : { reviews }) };
  } catch {
    return null;
  }
}

export function renderStateBlock(
  headSha: string,
  findings: readonly StateFinding[],
  reviews?: number,
): string {
  const payload: Record<string, unknown> = {
    findings: findings.map((f) => ({
      id: f.id,
      sev: f.sev,
      tier: f.tier,
      channel: f.channel,
      locs: f.locs,
      c: f.c,
      claim: f.claim,
    })),
  };
  if (reviews !== undefined && Number.isInteger(reviews) && reviews >= 1) {
    payload.reviews = reviews;
  }
  return `${stateMarker(headSha)}\n<!-- ${encodeStateJson(payload)} -->`;
}

export function stateFinding(input: {
  id: string;
  sev: Severity;
  tier: Tier;
  channel: FindingChannel;
  locs: readonly string[];
  claim: string;
}): StateFinding {
  return {
    id: input.id,
    sev: input.sev,
    tier: input.tier,
    channel: input.channel,
    locs: [...input.locs],
    c: claimFingerprint(input.claim),
    claim: input.claim,
  };
}

export function nextStableId(existingIds: readonly string[]): string {
  let max = 0;
  for (const id of existingIds) {
    const match = R_ID.exec(id);
    if (match?.[1] === undefined) continue;
    const n = Number(match[1]);
    if (n > max) max = n;
  }
  return formatR(max + 1);
}

export function assignFreshIds(
  previousIds: readonly string[],
  fresh: readonly Omit<StateFinding, "id">[],
): StateFinding[] {
  const ids = [...previousIds];
  return fresh.map((f) => {
    const id = nextStableId(ids);
    ids.push(id);
    return { ...f, id };
  });
}

// Previous ids — including retired verified-gone — feed nextStableId so an
// id is never reused (R2-S1). Survivors keep their stored rows; fresh
// findings take the next R###.
export function rewriteStateFindings(input: {
  previous: readonly StateFinding[];
  survivingIds: ReadonlySet<string>;
  fresh: readonly Omit<StateFinding, "id">[];
}): StateFinding[] {
  const kept = input.previous.filter((f) => input.survivingIds.has(f.id));
  const previousIds = input.previous.map((f) => f.id);
  return [...kept, ...assignFreshIds(previousIds, input.fresh)];
}

export interface CapResult {
  kept: LiveFinding[];
  droppedUnconfirmed: number;
  droppedCarried: number;
}

// On overflow, evict unconfirmed first, then carried. Never suppressed
// (would resurface as fresh) and never deferred (O-3). Round 3 C-R3-1.
export function capLiveFindings(
  entries: readonly LiveFinding[],
  bodyWithoutState: string,
  headSha: string,
  maxBody: number = GITHUB_ISSUE_COMMENT_MAX,
): CapResult {
  const kept = [...entries];
  let droppedUnconfirmed = 0;
  let droppedCarried = 0;
  while (kept.length > 0 && !fits(bodyWithoutState, headSha, kept, maxBody)) {
    const unconfirmed = lastIndexWith(kept, "unconfirmed");
    if (unconfirmed !== -1) {
      kept.splice(unconfirmed, 1);
      droppedUnconfirmed++;
      continue;
    }
    const carried = lastIndexWith(kept, "carried");
    if (carried !== -1) {
      kept.splice(carried, 1);
      droppedCarried++;
      continue;
    }
    break;
  }
  return { kept, droppedUnconfirmed, droppedCarried };
}

function fits(
  bodyWithoutState: string,
  headSha: string,
  entries: readonly LiveFinding[],
  maxBody: number,
): boolean {
  const stored = entries.map(stripStatus);
  const block = renderStateBlock(headSha, stored);
  return bodyWithoutState.length + block.length <= maxBody;
}

function stripStatus(entry: LiveFinding): StateFinding {
  const { status: _status, ...stored } = entry;
  return stored;
}

function lastIndexWith(
  entries: readonly LiveFinding[],
  status: LiveStatus,
): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.status === status) return i;
  }
  return -1;
}

function encodeStateJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
    .replaceAll("-->", "--\\u003e");
}

function asStateFindings(parsed: unknown): StateFinding[] | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return null;
  const out: StateFinding[] = [];
  for (const row of findings) {
    const finding = asStateFinding(row);
    if (finding === null) return null;
    out.push(finding);
  }
  return out;
}

function asStateReviews(parsed: unknown): number | undefined | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const reviews = (parsed as { reviews?: unknown }).reviews;
  if (reviews === undefined) return undefined;
  if (
    typeof reviews !== "number" ||
    !Number.isInteger(reviews) ||
    reviews < 1
  ) {
    return null;
  }
  return reviews;
}

function asStateFinding(row: unknown): StateFinding | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || !R_ID.test(r.id)) return null;
  if (!isSeverity(r.sev) || !isTier(r.tier)) return null;
  if (r.channel !== "inline" && r.channel !== "outside") return null;
  if (
    !Array.isArray(r.locs) ||
    !r.locs.every((loc) => typeof loc === "string")
  ) {
    return null;
  }
  if (typeof r.c !== "string" || !/^[0-9a-f]{12}$/.test(r.c)) return null;
  if (typeof r.claim !== "string") return null;
  return {
    id: r.id,
    sev: r.sev,
    tier: r.tier,
    channel: r.channel,
    locs: r.locs as string[],
    c: r.c,
    claim: r.claim,
  };
}

function isSeverity(value: unknown): value is Severity {
  return (
    value === "BLOCKER" ||
    value === "CRITICAL" ||
    value === "WARNING" ||
    value === "SUGGESTION"
  );
}

function isTier(value: unknown): value is Tier {
  return value === "blocking" || value === "advisory";
}

function formatR(n: number): string {
  return `R${String(n).padStart(3, "0")}`;
}

export function isLiveStatus(status: GateStatus): status is LiveStatus {
  return (
    status === "carried" ||
    status === "unconfirmed" ||
    status === "suppressed" ||
    status === "deferred"
  );
}

export function assembleLive(input: {
  settled: readonly PhaseBResult[];
  priors: readonly PriorRecord[];
  verifyVerdicts: ReadonlyMap<string, GateStatus>;
}): {
  live: LiveFinding[];
  verifiedGone: number;
  verifiedGoneIds: string[];
  returned: number;
  reTiered: number;
} {
  const priorById = new Map(input.priors.map((prior) => [prior.id, prior]));
  const live: LiveFinding[] = [];
  const verifiedGoneIds: string[] = [];
  let returned = 0;
  let reTiered = 0;
  for (const row of input.settled) {
    let status: GateStatus = row.status;
    if (status === "queued") {
      status = input.verifyVerdicts.get(row.id) ?? "unconfirmed";
    }
    if (status === "verified-gone") {
      verifiedGoneIds.push(row.id);
      continue;
    }
    if (status === "returned") {
      returned++;
      continue;
    }
    if (status === "re-tiered") {
      reTiered++;
      continue;
    }
    if (!isLiveStatus(status)) continue;
    const prior = priorById.get(row.id);
    if (prior === undefined) continue;
    live.push({
      id: prior.id,
      sev: prior.sev,
      tier: prior.tier,
      channel: prior.channel,
      locs: row.locs,
      c: claimFingerprint(prior.claim),
      claim: prior.claim,
      status,
    });
  }
  return {
    live,
    verifiedGone: verifiedGoneIds.length,
    verifiedGoneIds,
    returned,
    reTiered,
  };
}
