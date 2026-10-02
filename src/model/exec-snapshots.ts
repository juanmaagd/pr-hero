// Lifecycle of verified execution snapshots (#303).
//
// `verifyExecutableAuthority` copies every verified binary into a private
// `<base>/<digest16>-<pid>-<uuid>/` directory so the bytes that execute are
// the bytes that were hashed (the TOCTOU defense in provider-capabilities.ts).
// Nothing ever removed those copies: one per step, one per route at binding
// resolution, one per test — a real claude binary is >100 MB, and a benchmark
// machine reached 153 GB across 23,153 directories with its disk at 98%.
//
// Three layers, each covering what the previous one cannot:
//   1. `releaseExecutionSnapshot` — the owner releases its snapshot as soon as
//      the last attempt that spawns from it settles (the harness `finally`).
//   2. the `process.on("exit")` hook — `process.exit()` (the SIGINT/SIGTERM
//      handlers in cli.ts and mcp.ts end in it) skips every pending `finally`,
//      but it does run exit listeners, synchronously.
//   3. `sweepStaleExecutionSnapshots` — SIGKILL, a crash, or default-signal
//      death run nothing at all, so the next snapshot-creating process (and
//      `pr-hero gc`) removes directories whose owner pid is dead or that are
//      older than any step can live.
//
// Deletion is gated on a process-local registry of the directories THIS
// process created, never on `VerifiedExecutable.kind` or on
// `verifiedExecutionPath !== absolutePath`: test fakes and
// production-runtime.ts's `toVerifiedExecutable` leave `kind` unset, and a
// path-shape heuristic is one refactor away from unlinking an operator's real
// binary. A path this process never registered is never deleted by layer 1 or
// 2, whatever it looks like.

import { rmSync, type Stats } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const EXEC_SNAPSHOT_DIRNAME = "prhero-exec-snapshots";

// WHY 6 h: a step attempt defaults to 30 min with 2 attempts and a pipeline
// caps at 75 min; the in-flight TTL precedent (IN_FLIGHT_TTL_MS) is 90 min.
// Six hours is several times the longest legitimate lifetime, so an entry
// this old is garbage even when its pid has been recycled by a live process.
export const STALE_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// WHY once per hour per base: the watcher is a long-lived process that
// creates a snapshot per step; sweeping before every one of them would re-scan
// the base for nothing. Stale entries only appear when a process dies, so an
// hourly pass bounds the directory without measurable cost.
export const SNAPSHOT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export function defaultExecSnapshotBase(): string {
  return path.join(tmpdir(), EXEC_SNAPSHOT_DIRNAME);
}

export function executionSnapshotDirName(
  digest: string,
  pid: number,
  uuid: string,
): string {
  return `${digest.slice(0, 16)}-${pid}-${uuid}`;
}

const registeredSnapshotDirs = new Set<string>();
let exitHookInstalled = false;

// Registers a snapshot directory this process just created. Call it right
// after the directory exists and BEFORE the binary is written, so an exit in
// between still removes the partial copy.
export function registerExecutionSnapshot(snapshotDir: string): void {
  registeredSnapshotDirs.add(path.resolve(snapshotDir));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // Installed lazily so a process that never snapshots adds no listener.
    // Covers `process.exit()` from every entrypoint, including the signal
    // handlers in cli.ts and mcp.ts, which skip pending `finally` blocks.
    // Does NOT cover SIGKILL or death by a signal with no handler: no
    // JavaScript runs then, and `sweepStaleExecutionSnapshots` is the
    // backstop for exactly that.
    process.on("exit", releaseAllExecutionSnapshots);
  }
}

function registeredDirFor(target: string): string | undefined {
  const resolved = path.resolve(target);
  if (registeredSnapshotDirs.has(resolved)) return resolved;
  const parent = path.dirname(resolved);
  if (registeredSnapshotDirs.has(parent)) return parent;
  return undefined;
}

// Best-effort removal of one snapshot dir. Synchronous because it also runs
// from an exit listener, where nothing asynchronous completes. Never throws:
// a release failure must not replace a step's real outcome. `force` makes a
// directory already removed (by a sweep, or by hand) a success. Any other
// failure — EBUSY on Windows while a killed child still maps the binary —
// leaves the dir registered so the exit hook tries again.
function removeRegisteredDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
    registeredSnapshotDirs.delete(dir);
  } catch {
    // Kept registered; the exit hook retries.
  }
}

// Releases the snapshot that `verifiedExecutionPath` (or its directory)
// points at. A no-op for anything this process did not register: a canonical
// binary, a `#!` launcher executing in place, a test fake's path.
export function releaseExecutionSnapshot(target: string): void {
  const dir = registeredDirFor(target);
  if (dir === undefined) return;
  removeRegisteredDir(dir);
}

export function releaseAllExecutionSnapshots(): void {
  for (const dir of [...registeredSnapshotDirs]) {
    removeRegisteredDir(dir);
  }
}

// `<digest16>-<pid>-<uuid>` since #303; `<digest16>-<uuid>` before it. The
// optional pid group cannot swallow a legacy uuid's first segment: what would
// remain is not a whole uuid, so the regex backtracks to the legacy form.
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SNAPSHOT_NAME = new RegExp(
  `^[0-9a-f]{16}-(?:([0-9]+)-)?${UUID_PATTERN}$`,
);

export interface SnapshotEntryFacts {
  readonly name: string;
  // From lstat: a symlink is reported as "symlink" and never followed.
  readonly kind: "directory" | "symlink" | "other";
  readonly ownerUid: number;
  readonly mtimeMs: number;
  readonly registeredByThisProcess: boolean;
}

export interface SnapshotSweepPolicy {
  readonly nowMs: number;
  readonly maxAgeMs: number;
  // undefined when the platform has no `process.getuid` (Windows).
  readonly currentUid: number | undefined;
  // undefined when no pid-liveness probe is available.
  readonly pidAlive: ((pid: number) => boolean) | undefined;
}

export type SnapshotSweepDecision =
  | { readonly action: "remove"; readonly reason: "owner-dead" | "stale" }
  | {
      readonly action: "keep";
      readonly reason:
        | "foreign-name"
        | "not-a-directory"
        | "foreign-owner"
        | "in-use"
        | "fresh";
    };

export function classifySnapshotEntry(
  entry: SnapshotEntryFacts,
  policy: SnapshotSweepPolicy,
): SnapshotSweepDecision {
  const match = SNAPSHOT_NAME.exec(entry.name);
  if (match === null) return { action: "keep", reason: "foreign-name" };
  if (entry.kind !== "directory") {
    return { action: "keep", reason: "not-a-directory" };
  }
  // On Linux the base sits in a shared /tmp: another user's entry is never
  // ours to delete, whatever its age.
  if (policy.currentUid !== undefined && entry.ownerUid !== policy.currentUid) {
    return { action: "keep", reason: "foreign-owner" };
  }
  if (entry.registeredByThisProcess) {
    return { action: "keep", reason: "in-use" };
  }
  // Explicit degradation to age-only: without a uid there is no ownership
  // proof, and without a probe there is no liveness answer, so an entry is
  // only removed once it is older than any step can live. Platforms without
  // `getuid` (Windows) keep the temp dir per user, so age-only stays safe.
  // Legacy names carry no pid and are age-only on every platform.
  const pid = match[1] === undefined ? undefined : Number(match[1]);
  if (
    pid !== undefined &&
    Number.isSafeInteger(pid) &&
    policy.currentUid !== undefined &&
    policy.pidAlive !== undefined &&
    !policy.pidAlive(pid)
  ) {
    return { action: "remove", reason: "owner-dead" };
  }
  // Accepted trade-offs, both failing closed (the step that loses its binary
  // fails with ENOENT on its next spawn; nothing runs unverified bytes):
  // - The age cap applies to a LIVE pid too, deliberately, to bound pid
  //   recycling. A host asleep for more than 6 h mid-step can lose the
  //   snapshot; that step's watchdog would time it out on wake anyway.
  // - ESRCH is trusted as death. Same-uid containers sharing one /tmp across
  //   separate pid namespaces would see each other's live pids as dead; that
  //   deployment is out of scope.
  if (policy.nowMs - entry.mtimeMs > policy.maxAgeMs) {
    return { action: "remove", reason: "stale" };
  }
  return { action: "keep", reason: "fresh" };
}

// ESRCH is the only proof of death. EPERM means the pid exists under another
// user; any other error is not a "dead" answer either, so it keeps the entry.
function pidAliveByKill(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function currentProcessUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

export interface SnapshotSweepOptions {
  readonly snapshotBase?: string;
  readonly nowMs?: number;
  readonly maxAgeMs?: number;
  readonly pidAlive?: (pid: number) => boolean;
  readonly currentUid?: number;
  // Classify and count only; remove nothing.
  readonly dryRun?: boolean;
}

export interface SnapshotSweepReport {
  // In a dry run: what would be removed, and its size.
  readonly removed: number;
  readonly removedBytes: number;
  readonly kept: number;
  readonly failed: number;
}

// Best-effort size of a snapshot dir: its regular files, one level, via lstat.
async function snapshotDirBytes(dir: string): Promise<number> {
  try {
    let total = 0;
    for (const name of await readdir(dir)) {
      const stats = await lstat(path.join(dir, name));
      if (stats.isFile()) total += stats.size;
    }
    return total;
  } catch {
    return 0;
  }
}

export async function sweepStaleExecutionSnapshots(
  options: SnapshotSweepOptions = {},
): Promise<SnapshotSweepReport> {
  const base = options.snapshotBase ?? defaultExecSnapshotBase();
  const policy: SnapshotSweepPolicy = {
    nowMs: options.nowMs ?? Date.now(),
    maxAgeMs: options.maxAgeMs ?? STALE_SNAPSHOT_MAX_AGE_MS,
    currentUid: options.currentUid ?? currentProcessUid(),
    pidAlive: options.pidAlive ?? pidAliveByKill,
  };
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    // No base yet (first run) or unreadable: nothing to sweep.
    return { removed: 0, removedBytes: 0, kept: 0, failed: 0 };
  }
  let removed = 0;
  let removedBytes = 0;
  let kept = 0;
  let failed = 0;
  for (const name of names) {
    const entryPath = path.join(base, name);
    let stats: Stats;
    try {
      stats = await lstat(entryPath);
    } catch {
      // Released by its owner between readdir and lstat: already gone.
      continue;
    }
    const decision = classifySnapshotEntry(
      {
        name,
        kind: stats.isSymbolicLink()
          ? "symlink"
          : stats.isDirectory()
            ? "directory"
            : "other",
        ownerUid: stats.uid,
        mtimeMs: stats.mtimeMs,
        registeredByThisProcess: registeredSnapshotDirs.has(
          path.resolve(entryPath),
        ),
      },
      policy,
    );
    if (decision.action === "keep") {
      kept++;
      continue;
    }
    const bytes = await snapshotDirBytes(entryPath);
    if (options.dryRun) {
      removed++;
      removedBytes += bytes;
      continue;
    }
    try {
      await rm(entryPath, { recursive: true, force: true });
      removed++;
      removedBytes += bytes;
    } catch {
      failed++;
    }
  }
  return { removed, removedBytes, kept, failed };
}

const lastSweepAtMsByBase = new Map<string, number>();

// The opportunistic trigger `verifyExecutableAuthority` runs before creating a
// snapshot. Rate-limited per resolved base (production has exactly one, so
// this is "once per hour per process"); the timestamp is taken BEFORE the
// sweep so concurrent verifications in the same process do not all sweep.
// Never throws: a sweep problem must not fail or delay-fail verification.
export async function sweepExecutionSnapshotsOpportunistically(
  snapshotBase: string,
  nowMs: number = Date.now(),
): Promise<void> {
  const key = path.resolve(snapshotBase);
  const last = lastSweepAtMsByBase.get(key);
  if (last !== undefined && nowMs - last < SNAPSHOT_SWEEP_INTERVAL_MS) return;
  lastSweepAtMsByBase.set(key, nowMs);
  try {
    await sweepStaleExecutionSnapshots({ snapshotBase: key, nowMs });
  } catch {
    // Best-effort by contract.
  }
}
