// Worktree GC decisions (W3 / GitHub #18), pure so the keep/collect table
// is testable offline. gc.ts is the I/O shell: it scans ~/.prhero/repos,
// asks gh for PR state, and runs `git worktree remove --force`.
//
// Unbounded accumulation is not allowed. Collect when the PR is merged or
// closed, OR when the tree has sat idle longer than 72h, whichever first.
// Skip an in-flight tree (a live pid on the sibling lock). Never rm -rf.

import { GC_TTL_HOURS } from "./home-preflight";

export type PrLifecycle = "open" | "merged" | "closed" | "unknown";
export type GcAction = "keep" | "collect";

export interface GcInput {
  prState: PrLifecycle;
  // Last successful review, from registry.json. Null means no stamp.
  lastReviewAtMs: number | null;
  // Directory mtime of the worktree itself, used only when the stamp is
  // missing. Null means we could not stat it either — treat as expired.
  dirMtimeMs: number | null;
  nowMs: number;
  ttlHours?: number;
  inFlight: boolean;
}

export interface GcDecision {
  action: GcAction;
  reason: string;
}

const HOUR_MS = 60 * 60 * 1000;

export function decideGc(input: GcInput): GcDecision {
  if (input.inFlight) {
    return { action: "keep", reason: "in-flight (live lock)" };
  }
  if (input.prState === "merged" || input.prState === "closed") {
    return {
      action: "collect",
      reason: `PR is ${input.prState}`,
    };
  }
  const ttlHours = input.ttlHours ?? GC_TTL_HOURS;
  const idleFrom = input.lastReviewAtMs ?? input.dirMtimeMs;
  if (idleFrom === null) {
    return {
      action: "collect",
      reason: `idle longer than ${ttlHours}h (no stamp, no mtime)`,
    };
  }
  const idleHours = (input.nowMs - idleFrom) / HOUR_MS;
  if (idleHours > ttlHours) {
    return {
      action: "collect",
      reason: `idle longer than ${ttlHours}h`,
    };
  }
  return { action: "keep", reason: "open and within TTL" };
}

// `pr-1724` → 1724. Anything else (including the sibling `.lock` file) is
// not a worktree we own.
export function parseWorktreePr(dirName: string): number | null {
  const match = /^pr-(\d+)$/.exec(dirName);
  if (match === null) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function parseGhPrState(raw: string): PrLifecycle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unknown";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "unknown";
  }
  const state = (parsed as Record<string, unknown>).state;
  if (typeof state !== "string") return "unknown";
  const upper = state.toUpperCase();
  if (upper === "OPEN") return "open";
  if (upper === "MERGED") return "merged";
  if (upper === "CLOSED") return "closed";
  return "unknown";
}

// The only argv `git -C <owner>` may receive for teardown. Tests pin
// `--force` and the absence of `rm`. The path is an argument, never
// interpolated into a shell string.
export function worktreeRemoveArgs(worktreePath: string): string[] {
  return ["worktree", "remove", "--force", worktreePath];
}
