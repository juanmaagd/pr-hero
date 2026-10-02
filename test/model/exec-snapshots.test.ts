import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifySnapshotEntry,
  defaultExecSnapshotBase,
  OPPORTUNISTIC_SWEEP_BUDGET_MS,
  releaseExecutionSnapshot,
  type SnapshotEntryFacts,
  type SnapshotSweepPolicy,
  STALE_SNAPSHOT_MAX_AGE_MS,
  sweepExecutionSnapshotsOpportunistically,
  sweepStaleExecutionSnapshots,
} from "../../src/model/exec-snapshots";
import {
  verifyExecutableAuthority,
  verifyExecutableBinding,
} from "../../src/model/provider-capabilities";

const MACHO_PREFIX = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
const HOUR_MS = 60 * 60 * 1000;
const DIGEST16 = "0123456789abcdef";
const SELF_UID = 501;
const LIVE_PID = 4242;
const DEAD_PID = 9191;

function sha256Of(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

// A unique Mach-O-prefixed body, so the bytes are snapshotted (not treated as
// a `#!` launcher) and the digest prefix identifies this fixture alone.
async function writeMachOFixture(
  dir: string,
): Promise<{ canonicalPath: string; sha256: string }> {
  const binDir = path.join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const filePath = path.join(binDir, "claude");
  const bytes = Buffer.concat([MACHO_PREFIX, Buffer.from(randomUUID())]);
  await writeFile(filePath, bytes);
  await chmod(filePath, 0o755);
  return { canonicalPath: await realpath(filePath), sha256: sha256Of(bytes) };
}

async function verifyInto(
  fixture: { canonicalPath: string; sha256: string },
  snapshotDir: string,
): Promise<string> {
  const result = await verifyExecutableAuthority({
    candidatePath: fixture.canonicalPath,
    allowlist: [
      { absolutePath: fixture.canonicalPath, sha256: fixture.sha256 },
    ],
    snapshotDir,
  });
  if (!result.approved) throw new Error(result.reason);
  return result.executable.verifiedExecutionPath;
}

function snapshotName(pid: number | undefined): string {
  return pid === undefined
    ? `${DIGEST16}-${randomUUID()}`
    : `${DIGEST16}-${pid}-${randomUUID()}`;
}

async function makeEntry(
  base: string,
  name: string,
  options: { bytes?: number; mtimeMs?: number } = {},
): Promise<string> {
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  if (options.bytes !== undefined) {
    await writeFile(path.join(dir, "claude"), Buffer.alloc(options.bytes));
  }
  if (options.mtimeMs !== undefined) {
    const at = new Date(options.mtimeMs);
    await utimes(dir, at, at);
  }
  return dir;
}

// The real default base, filtered to one fixture's digest prefix: the only
// way to observe "wrote nothing" for a path that takes no snapshotDir.
async function defaultBaseEntriesFor(sha256: string): Promise<string[]> {
  const names = await readdir(defaultExecSnapshotBase()).catch(() => []);
  return names.filter((name) => name.startsWith(sha256.slice(0, 16)));
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "pr-hero-exec-snapshots-test-")),
  );
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("classifySnapshotEntry", () => {
  const nowMs = 1_000_000_000_000;
  const policy: SnapshotSweepPolicy = {
    nowMs,
    maxAgeMs: STALE_SNAPSHOT_MAX_AGE_MS,
    currentUid: SELF_UID,
    pidAlive: (pid) => pid !== DEAD_PID,
  };
  const fresh = nowMs - HOUR_MS;
  const stale = nowMs - STALE_SNAPSHOT_MAX_AGE_MS - 1;
  const entry = (
    overrides: Partial<SnapshotEntryFacts>,
  ): SnapshotEntryFacts => ({
    name: snapshotName(LIVE_PID),
    kind: "directory",
    ownerUid: SELF_UID,
    mtimeMs: fresh,
    registeredByThisProcess: false,
    ...overrides,
  });

  test.each([
    [
      "a dead owner's fresh dir is removed",
      entry({ name: snapshotName(DEAD_PID) }),
      policy,
      { action: "remove", reason: "owner-dead" },
    ],
    [
      "a live owner's fresh dir is kept",
      entry({}),
      policy,
      { action: "keep", reason: "fresh" },
    ],
    [
      "a live owner's dir past the age cap is removed (pid recycling)",
      entry({ mtimeMs: stale }),
      policy,
      { action: "remove", reason: "stale" },
    ],
    [
      "a fresh legacy dir is kept: no pid, age-only",
      entry({ name: snapshotName(undefined) }),
      { ...policy, pidAlive: () => false },
      { action: "keep", reason: "fresh" },
    ],
    [
      "a legacy dir past the age cap is removed",
      entry({ name: snapshotName(undefined), mtimeMs: stale }),
      policy,
      { action: "remove", reason: "stale" },
    ],
    [
      "a foreign name is kept whatever its age",
      entry({ name: "notes", mtimeMs: stale }),
      policy,
      { action: "keep", reason: "foreign-name" },
    ],
    [
      "the pre-hardening <digest16> layout is not a snapshot name",
      entry({ name: DIGEST16, mtimeMs: stale }),
      policy,
      { action: "keep", reason: "foreign-name" },
    ],
    [
      "a snapshot name with a leading prefix is foreign",
      entry({ name: `x${snapshotName(DEAD_PID)}`, mtimeMs: stale }),
      policy,
      { action: "keep", reason: "foreign-name" },
    ],
    [
      "a snapshot name with a trailing suffix is foreign",
      entry({ name: `${snapshotName(DEAD_PID)}.bak`, mtimeMs: stale }),
      policy,
      { action: "keep", reason: "foreign-name" },
    ],
    [
      "a symlink carrying a snapshot name is kept",
      entry({ name: snapshotName(DEAD_PID), kind: "symlink", mtimeMs: stale }),
      policy,
      { action: "keep", reason: "not-a-directory" },
    ],
    [
      "a regular file carrying a snapshot name is kept",
      entry({ name: snapshotName(DEAD_PID), kind: "other", mtimeMs: stale }),
      policy,
      { action: "keep", reason: "not-a-directory" },
    ],
    [
      "another user's dir is kept even when dead and stale",
      entry({
        name: snapshotName(DEAD_PID),
        ownerUid: SELF_UID + 1,
        mtimeMs: stale,
      }),
      policy,
      { action: "keep", reason: "foreign-owner" },
    ],
    [
      "a dir this process registered is kept even when dead and stale",
      entry({
        name: snapshotName(DEAD_PID),
        mtimeMs: stale,
        registeredByThisProcess: true,
      }),
      policy,
      { action: "keep", reason: "in-use" },
    ],
    [
      "without a uid, a dead owner's fresh dir is kept (age-only)",
      entry({ name: snapshotName(DEAD_PID), ownerUid: SELF_UID + 1 }),
      { ...policy, currentUid: undefined },
      { action: "keep", reason: "fresh" },
    ],
    [
      "without a uid, a dir past the age cap is still removed",
      entry({ name: snapshotName(DEAD_PID), mtimeMs: stale }),
      { ...policy, currentUid: undefined },
      { action: "remove", reason: "stale" },
    ],
    [
      "without a pid probe, a fresh dir is kept (age-only)",
      entry({ name: snapshotName(DEAD_PID) }),
      { ...policy, pidAlive: undefined },
      { action: "keep", reason: "fresh" },
    ],
  ] as const)("%s", (_label, facts, sweepPolicy, expected) => {
    expect(classifySnapshotEntry(facts, sweepPolicy)).toEqual(expected);
  });
});

describe("sweepStaleExecutionSnapshots", () => {
  const nowMs = Date.now();
  const staleMs = nowMs - STALE_SNAPSHOT_MAX_AGE_MS - HOUR_MS;
  const currentUid = process.getuid?.() ?? 0;
  const pidAlive = (pid: number) => pid !== DEAD_PID;

  async function seedBase(base: string) {
    await mkdir(base, { recursive: true });
    const victim = await makeEntry(tempDir, "victim", { bytes: 7 });
    const linkName = snapshotName(DEAD_PID);
    await symlink(victim, path.join(base, linkName));
    return {
      deadOwner: path.basename(
        await makeEntry(base, snapshotName(DEAD_PID), { bytes: 1000 }),
      ),
      staleLegacy: path.basename(
        await makeEntry(base, snapshotName(undefined), {
          bytes: 500,
          mtimeMs: staleMs,
        }),
      ),
      liveFresh: path.basename(
        await makeEntry(base, snapshotName(LIVE_PID), { bytes: 3 }),
      ),
      freshLegacy: path.basename(
        await makeEntry(base, snapshotName(undefined), { bytes: 3 }),
      ),
      foreign: path.basename(
        await makeEntry(base, "keep-me", { bytes: 3, mtimeMs: staleMs }),
      ),
      symlinkName: linkName,
      victim,
    };
  }

  test("removes dead-owner and stale dirs, keeps live, fresh, foreign and symlinked entries", async () => {
    const base = path.join(tempDir, "snaps");
    const seeded = await seedBase(base);

    const report = await sweepStaleExecutionSnapshots({
      snapshotBase: base,
      nowMs,
      pidAlive,
      currentUid,
    });

    expect(report).toEqual({
      removed: 2,
      removedBytes: 1500,
      kept: 4,
      failed: 0,
      unprocessed: 0,
    });
    expect((await readdir(base)).sort()).toEqual(
      [
        seeded.liveFresh,
        seeded.freshLegacy,
        seeded.foreign,
        seeded.symlinkName,
      ].sort(),
    );
    // The symlink was never followed: its target is intact.
    expect(existsSync(path.join(seeded.victim, "claude"))).toBe(true);
  });

  test("a dry run reports what it would remove and removes nothing", async () => {
    const base = path.join(tempDir, "snaps");
    await seedBase(base);
    const before = (await readdir(base)).sort();

    const report = await sweepStaleExecutionSnapshots({
      snapshotBase: base,
      nowMs,
      pidAlive,
      currentUid,
      dryRun: true,
    });

    expect(report).toEqual({
      removed: 2,
      removedBytes: 1500,
      kept: 4,
      failed: 0,
      unprocessed: 0,
    });
    expect((await readdir(base)).sort()).toEqual(before);
  });

  test("entries owned by another uid are never removed", async () => {
    const base = path.join(tempDir, "snaps");
    await seedBase(base);
    const before = (await readdir(base)).sort();

    const report = await sweepStaleExecutionSnapshots({
      snapshotBase: base,
      nowMs,
      pidAlive: () => false,
      currentUid: currentUid + 1,
    });

    expect(report).toEqual({
      removed: 0,
      removedBytes: 0,
      kept: 6,
      failed: 0,
      unprocessed: 0,
    });
    expect((await readdir(base)).sort()).toEqual(before);
  });

  test("a dir this process registered survives a sweep that would remove it otherwise", async () => {
    const base = path.join(tempDir, "snaps");
    const fixture = await writeMachOFixture(tempDir);
    const snapshotPath = await verifyInto(fixture, base);

    const report = await sweepStaleExecutionSnapshots({
      snapshotBase: base,
      nowMs: nowMs + STALE_SNAPSHOT_MAX_AGE_MS * 10,
      pidAlive: () => false,
      currentUid,
    });

    expect(report.removed).toBe(0);
    expect(existsSync(snapshotPath)).toBe(true);
    releaseExecutionSnapshot(snapshotPath);
  });

  // pid 1 is root's: for any other user `kill(1, 0)` throws EPERM, which
  // the default probe must read as alive. Root gets no EPERM to exercise.
  test.skipIf(process.getuid?.() === 0)(
    "the default pid probe keeps an EPERM owner and removes an ESRCH one",
    async () => {
      const base = path.join(tempDir, "snaps");
      const rootOwned = await makeEntry(base, snapshotName(1));
      const exitedPid = Bun.spawnSync(["true"]).pid;
      const deadOwner = await makeEntry(base, snapshotName(exitedPid));

      const report = await sweepStaleExecutionSnapshots({ snapshotBase: base });

      expect(report).toEqual({
        removed: 1,
        removedBytes: 0,
        kept: 1,
        failed: 0,
        unprocessed: 0,
      });
      expect(existsSync(rootOwned)).toBe(true);
      expect(existsSync(deadOwner)).toBe(false);
    },
  );

  test("a spent budget stops the pass and reports the entries it never took", async () => {
    const base = path.join(tempDir, "snaps");
    const stale = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        makeEntry(base, snapshotName(undefined), { mtimeMs: staleMs }),
      ),
    );
    // Time advances one unit per removed entry, however often the sweep
    // reads the clock: a budget of 2 is spent after exactly two removals.
    const clock = () => stale.filter((dir) => !existsSync(dir)).length;

    const report = await sweepStaleExecutionSnapshots({
      snapshotBase: base,
      nowMs,
      budgetMs: 2,
      clock,
    });

    expect(report).toEqual({
      removed: 2,
      removedBytes: 0,
      kept: 0,
      failed: 0,
      unprocessed: 3,
    });
    expect(stale.filter((dir) => existsSync(dir))).toHaveLength(3);
  });

  test("a missing base is an empty sweep, not an error", async () => {
    expect(
      await sweepStaleExecutionSnapshots({
        snapshotBase: path.join(tempDir, "never-created"),
      }),
    ).toEqual({
      removed: 0,
      removedBytes: 0,
      kept: 0,
      failed: 0,
      unprocessed: 0,
    });
  });
});

describe("opportunistic sweep", () => {
  test("verifyExecutableAuthority collects dead-owner and stale dirs before snapshotting", async () => {
    const base = path.join(tempDir, "snaps");
    // A pid that existed and has exited: the default probe answers ESRCH.
    const deadPid = Bun.spawnSync(["true"]).pid;
    const deadOwner = await makeEntry(base, snapshotName(deadPid));
    const staleLegacy = await makeEntry(base, snapshotName(undefined), {
      mtimeMs: Date.now() - STALE_SNAPSHOT_MAX_AGE_MS - HOUR_MS,
    });
    const foreign = await makeEntry(base, "keep-me");
    const fixture = await writeMachOFixture(tempDir);

    const snapshotPath = await verifyInto(fixture, base);

    expect(existsSync(deadOwner)).toBe(false);
    expect(existsSync(staleLegacy)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(snapshotPath)).toBe(true);
    releaseExecutionSnapshot(snapshotPath);
  });

  test("runs at most once per hour for a base", async () => {
    const base = path.join(tempDir, "snaps");
    const t0 = Date.now();
    await sweepExecutionSnapshotsOpportunistically(base, t0);
    const staleLegacy = await makeEntry(base, snapshotName(undefined), {
      mtimeMs: t0 - STALE_SNAPSHOT_MAX_AGE_MS - HOUR_MS,
    });

    await sweepExecutionSnapshotsOpportunistically(base, t0 + HOUR_MS / 2);
    const afterHalfHour = existsSync(staleLegacy);
    await sweepExecutionSnapshotsOpportunistically(base, t0 + HOUR_MS + 1);

    expect(afterHalfHour).toBe(true);
    expect(existsSync(staleLegacy)).toBe(false);
  });

  // Parallel hunters verify at the same moment. The entry below is fresh at
  // t0 and stale at t0 + 30 min, so it survives only if the second, concurrent
  // call skipped its sweep — i.e. the first call claimed the base before its
  // first await, and exactly one sweep ran.
  test("an exhausted pass hands the backlog to the next call instead of waiting an hour", async () => {
    const base = path.join(tempDir, "snaps");
    const t0 = Date.now();
    const stale = await Promise.all(
      [1, 2, 3].map(() =>
        makeEntry(base, snapshotName(undefined), {
          mtimeMs: t0 - STALE_SNAPSHOT_MAX_AGE_MS - HOUR_MS,
        }),
      ),
    );
    // Each removal costs a whole default budget, so the production budget
    // (no override) ends the first pass after exactly one entry.
    const clock = () =>
      stale.filter((dir) => !existsSync(dir)).length *
      OPPORTUNISTIC_SWEEP_BUDGET_MS;

    const first = await sweepExecutionSnapshotsOpportunistically(base, t0, {
      clock,
    });
    const next = await sweepExecutionSnapshotsOpportunistically(
      base,
      t0 + 60_000,
    );

    expect(first?.unprocessed).toBe(2);
    expect(next?.removed).toBe(2);
    expect(stale.filter((dir) => existsSync(dir))).toEqual([]);
  });

  test("never sizes what it removes", async () => {
    const base = path.join(tempDir, "snaps");
    const t0 = Date.now();
    await makeEntry(base, snapshotName(undefined), {
      bytes: 2048,
      mtimeMs: t0 - STALE_SNAPSHOT_MAX_AGE_MS - HOUR_MS,
    });

    const report = await sweepExecutionSnapshotsOpportunistically(base, t0);

    expect(report).toEqual({
      removed: 1,
      removedBytes: 0,
      kept: 0,
      failed: 0,
      unprocessed: 0,
    });
  });

  test("concurrent triggers on one base run exactly one sweep", async () => {
    const base = path.join(tempDir, "snaps");
    const t0 = Date.now();
    const halfHour = HOUR_MS / 2;
    const entry = await makeEntry(base, snapshotName(undefined), {
      mtimeMs: t0 - STALE_SNAPSHOT_MAX_AGE_MS + halfHour / 2,
    });

    await Promise.all([
      sweepExecutionSnapshotsOpportunistically(base, t0),
      sweepExecutionSnapshotsOpportunistically(base, t0 + halfHour),
    ]);

    expect(existsSync(entry)).toBe(true);
  });
});

describe("snapshot creation failure", () => {
  // The dir is registered before the bytes land, so a write that fails
  // mid-creation still has its partial dir removed. A basename past NAME_MAX
  // (255 bytes on macOS and Linux) makes the exclusive open fail with
  // ENAMETOOLONG after the snapshot dir already exists.
  test("removes the partial dir when the snapshot write fails", async () => {
    const base = path.join(tempDir, "snaps");
    const canonical = `/fake/bin/${"a".repeat(300)}`;
    const bytes = Buffer.concat([MACHO_PREFIX, Buffer.from(randomUUID())]);

    const result = await verifyExecutableAuthority(
      {
        candidatePath: canonical,
        allowlist: [{ absolutePath: canonical, sha256: sha256Of(bytes) }],
        snapshotDir: base,
      },
      {
        realpathFn: async (p) => p,
        readFileFn: async () => bytes,
        statFn: () => ({ mode: 0o755 }),
      },
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toContain(
      "Failed to create verified execution snapshot",
    );
    expect(await readdir(base)).toEqual([]);
  });
});

describe("releaseExecutionSnapshot", () => {
  test("removes the snapshot dir this process created", async () => {
    const fixture = await writeMachOFixture(tempDir);
    const snapshotPath = await verifyInto(fixture, path.join(tempDir, "snaps"));
    const existedBefore = existsSync(snapshotPath);

    releaseExecutionSnapshot(snapshotPath);

    expect(existedBefore).toBe(true);
    expect(existsSync(path.dirname(snapshotPath))).toBe(false);
  });

  test("leaves a canonical binary this process never registered untouched", async () => {
    const fixture = await writeMachOFixture(tempDir);

    releaseExecutionSnapshot(fixture.canonicalPath);

    expect(existsSync(fixture.canonicalPath)).toBe(true);
  });

  test("leaves an unregistered dir that merely looks like a snapshot untouched", async () => {
    const lookalike = await makeEntry(
      path.join(tempDir, "snaps"),
      snapshotName(process.pid),
      { bytes: 3 },
    );

    releaseExecutionSnapshot(path.join(lookalike, "claude"));

    expect(existsSync(path.join(lookalike, "claude"))).toBe(true);
  });

  test("leaves a #! launcher executing from its canonical path untouched", async () => {
    const launcher = path.join(tempDir, "launcher");
    const bytes = Buffer.from("#!/bin/sh\necho hi\n");
    await writeFile(launcher, bytes);
    await chmod(launcher, 0o755);
    const canonicalPath = await realpath(launcher);
    const result = await verifyExecutableAuthority({
      candidatePath: canonicalPath,
      allowlist: [{ absolutePath: canonicalPath, sha256: sha256Of(bytes) }],
      snapshotDir: path.join(tempDir, "snaps"),
    });
    if (!result.approved) throw new Error(result.reason);

    releaseExecutionSnapshot(result.executable.verifiedExecutionPath);

    expect(existsSync(canonicalPath)).toBe(true);
  });

  test("never throws when the dir is already gone", async () => {
    const fixture = await writeMachOFixture(tempDir);
    const snapshotPath = await verifyInto(fixture, path.join(tempDir, "snaps"));
    await rm(path.dirname(snapshotPath), { recursive: true, force: true });

    expect(() => releaseExecutionSnapshot(snapshotPath)).not.toThrow();
  });
});

// Both run in a child process. The exit hook needs a real process exit, and
// releaseAllExecutionSnapshots is process-global: called inside the shared
// `bun test` process it would also delete every snapshot other test files
// leaked, hiding exactly the leaks this suite exists to expose.
describe("process-wide release", () => {
  const capabilities = path.resolve(
    import.meta.dir,
    "../../src/model/provider-capabilities.ts",
  );
  const snapshots = path.resolve(
    import.meta.dir,
    "../../src/model/exec-snapshots.ts",
  );

  async function runChild(
    body: readonly string[],
  ): Promise<{ exitCode: number | null; report: Record<string, unknown> }> {
    const fixture = await writeMachOFixture(tempDir);
    const script = path.join(tempDir, "child.ts");
    await writeFile(
      script,
      [
        `import { existsSync } from "node:fs";`,
        `import path from "node:path";`,
        `import { verifyExecutableAuthority } from ${JSON.stringify(capabilities)};`,
        `import { releaseAllExecutionSnapshots } from ${JSON.stringify(snapshots)};`,
        "const [candidatePath, sha256, snapshotDir] = process.argv.slice(2);",
        "async function snapshot() {",
        "  const result = await verifyExecutableAuthority({",
        "    candidatePath,",
        "    allowlist: [{ absolutePath: candidatePath, sha256 }],",
        "    snapshotDir,",
        "  });",
        "  if (!result.approved) process.exit(2);",
        "  return path.dirname(result.executable.verifiedExecutionPath);",
        "}",
        ...body,
      ].join("\n"),
    );
    const child = Bun.spawnSync([
      process.execPath,
      script,
      fixture.canonicalPath,
      fixture.sha256,
      path.join(tempDir, "snaps"),
    ]);
    return {
      exitCode: child.exitCode,
      report: JSON.parse(child.stdout.toString()),
    };
  }

  test("process.exit() removes the snapshots the process created", async () => {
    const { exitCode, report } = await runChild([
      "const dir = await snapshot();",
      "console.log(JSON.stringify({ dir, existed: existsSync(dir) }));",
      // The SIGINT handler's own exit, which skips every pending `finally`.
      "process.exit(130);",
    ]);

    expect(exitCode).toBe(130);
    expect(report.existed).toBe(true);
    expect(path.dirname(String(report.dir))).toBe(path.join(tempDir, "snaps"));
    expect(existsSync(String(report.dir))).toBe(false);
  });

  test("releaseAllExecutionSnapshots removes every registered dir", async () => {
    const { exitCode, report } = await runChild([
      "const dirs = [await snapshot(), await snapshot()];",
      "const existed = dirs.map((dir) => existsSync(dir));",
      "releaseAllExecutionSnapshots();",
      "const remaining = dirs.filter((dir) => existsSync(dir));",
      "console.log(JSON.stringify({ existed, remaining }));",
    ]);

    expect(exitCode).toBe(0);
    expect(report).toEqual({ existed: [true, true], remaining: [] });
  });
});

describe("verifyExecutableBinding", () => {
  const canonical = "/fake/bin/opencode";
  const deps = (bytes: Uint8Array) => ({
    realpathFn: async (p: string) => p,
    readFileFn: async () => bytes,
    statFn: () => ({ mode: 0o755 }),
  });

  test("approves an allowlisted binary with no runnable path and writes no snapshot", async () => {
    const bytes = Buffer.concat([MACHO_PREFIX, Buffer.from(randomUUID())]);
    const sha256 = sha256Of(bytes);

    const result = await verifyExecutableBinding(
      {
        candidatePath: canonical,
        allowlist: [{ absolutePath: canonical, sha256 }],
      },
      deps(bytes),
    );

    expect(result).toEqual({ approved: true, absolutePath: canonical, sha256 });
    expect(await defaultBaseEntriesFor(sha256)).toEqual([]);
  });

  test("denies a binary whose hash is not allowlisted", async () => {
    const bytes = Buffer.concat([MACHO_PREFIX, Buffer.from(randomUUID())]);

    const result = await verifyExecutableBinding(
      {
        candidatePath: canonical,
        allowlist: [{ absolutePath: canonical, sha256: "0".repeat(64) }],
      },
      deps(bytes),
    );

    expect(result.approved).toBe(false);
    expect(result.code).toBe("executable_not_approved");
  });
});
