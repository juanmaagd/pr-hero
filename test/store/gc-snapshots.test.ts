// #303: `pr-hero gc` also collects the verified execution snapshots that
// crashed runs left behind, and says what it did (or would do).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXEC_SNAPSHOT_DIRNAME,
  STALE_SNAPSHOT_MAX_AGE_MS,
} from "#model/exec-snapshots";
import { gcExecutionSnapshots, renderSnapshotGcLine } from "#store/gc";

const STALE_BYTES = 2048;

let tempDir: string;
let base: string;
let staleDir: string;
let liveDir: string;

beforeEach(async () => {
  tempDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "pr-hero-gc-snapshots-")),
  );
  // Laid out as <TMPDIR>/prhero-exec-snapshots so the CLI test below can
  // reach it through TMPDIR alone.
  base = path.join(tempDir, "tmp", EXEC_SNAPSHOT_DIRNAME);
  // A legacy-format dir (no pid) past the age cap: removable on age alone.
  staleDir = path.join(base, `0123456789abcdef-${randomUUID()}`);
  await mkdir(staleDir, { recursive: true });
  await writeFile(path.join(staleDir, "claude"), Buffer.alloc(STALE_BYTES));
  const longAgo = new Date(Date.now() - STALE_SNAPSHOT_MAX_AGE_MS - 60_000);
  await utimes(staleDir, longAgo, longAgo);
  // Owned by this live process and fresh: must survive.
  liveDir = path.join(base, `0123456789abcdef-${process.pid}-${randomUUID()}`);
  await mkdir(liveDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("gcExecutionSnapshots", () => {
  test("a dry run reports the stale snapshot and its size and removes nothing", async () => {
    const line = await gcExecutionSnapshots({
      dryRun: true,
      snapshotBase: base,
    });

    expect(line).toBe(
      "dry run: exec snapshots would remove 1 (2.0 KB), keep 1",
    );
    expect(existsSync(staleDir)).toBe(true);
    expect(existsSync(liveDir)).toBe(true);
  });

  test("a real run removes the stale snapshot and keeps the live one", async () => {
    const line = await gcExecutionSnapshots({
      dryRun: false,
      snapshotBase: base,
    });

    expect(line).toBe("gc: exec snapshots removed 1 (2.0 KB), keep 1");
    expect(existsSync(staleDir)).toBe(false);
    expect(existsSync(liveDir)).toBe(true);
  });
});

describe("pr-hero gc", () => {
  // Through the real CLI in a child process: gcCommand reads os.homedir(),
  // which Bun fixes at startup, so only a child with its own HOME stays off
  // the operator's ~/.prhero (and off gh: an empty home has no worktrees).
  async function runGcCli(args: readonly string[]) {
    const home = path.join(tempDir, "home");
    await mkdir(home, { recursive: true });
    const cli = path.resolve(import.meta.dir, "../../src/cli.ts");
    return Bun.spawnSync([process.execPath, cli, "gc", ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        TMPDIR: path.join(tempDir, "tmp"),
      },
    });
  }

  test("a dry run prints the exec snapshot line and removes nothing", async () => {
    const child = await runGcCli(["--dry-run"]);

    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString().split("\n")).toContain(
      "dry run: exec snapshots would remove 1 (2.0 KB), keep 1",
    );
    expect(existsSync(staleDir)).toBe(true);
  });

  // The launchd backstop must not depend on the worktree half succeeding. A
  // scoped --repo with no origin throws from the worktree gc before it lists
  // a single tree; the snapshot sweep still runs, and the error still wins.
  test("the snapshot sweep still runs when the worktree gc throws", async () => {
    const missingRepo = path.join(tempDir, "no-such-repo");

    const child = await runGcCli(["--dry-run", "--repo", missingRepo]);
    const stderr = child.stderr.toString();

    expect(child.exitCode).toBe(1);
    expect(stderr).toContain(`no git remote named origin in ${missingRepo}`);
    expect(stderr.split("\n")).toContain(
      "dry run: exec snapshots would remove 1 (2.0 KB), keep 1",
    );
  });
});

describe("renderSnapshotGcLine", () => {
  const report = (overrides: { removedBytes: number; failed?: number }) => ({
    removed: 4,
    kept: 2,
    failed: 0,
    unprocessed: 0,
    ...overrides,
  });

  test.each([
    [0, false, "gc: exec snapshots removed 4 (0 B), keep 2"],
    [1023, false, "gc: exec snapshots removed 4 (1023 B), keep 2"],
    [1536, false, "gc: exec snapshots removed 4 (1.5 KB), keep 2"],
    [5 * 1024 ** 2, false, "gc: exec snapshots removed 4 (5.0 MB), keep 2"],
    [
      1.5 * 1024 ** 3,
      true,
      "dry run: exec snapshots would remove 4 (1.5 GB), keep 2",
    ],
    // Unit boundaries: the unit is chosen from the value as displayed, so a
    // count that rounds up to 1024 of one unit prints as 1.0 of the next.
    [1024, false, "gc: exec snapshots removed 4 (1.0 KB), keep 2"],
    [1024 ** 2 - 1, false, "gc: exec snapshots removed 4 (1.0 MB), keep 2"],
    [1024 ** 2, false, "gc: exec snapshots removed 4 (1.0 MB), keep 2"],
    [1024 ** 3 - 1, false, "gc: exec snapshots removed 4 (1.0 GB), keep 2"],
    [1024 ** 3, false, "gc: exec snapshots removed 4 (1.0 GB), keep 2"],
    [1024 ** 4, false, "gc: exec snapshots removed 4 (1.0 TB), keep 2"],
    // TB is the largest unit: nothing rolls past it.
    [1024 ** 5, false, "gc: exec snapshots removed 4 (1024.0 TB), keep 2"],
  ] as const)("%d bytes, dry run %p", (removedBytes, dryRun, expected) => {
    expect(renderSnapshotGcLine(report({ removedBytes }), dryRun)).toBe(
      expected,
    );
  });

  test("names the failures when some removals failed", () => {
    expect(
      renderSnapshotGcLine(report({ removedBytes: 0, failed: 3 }), false),
    ).toBe("gc: exec snapshots removed 4 (0 B), keep 2, 3 failed");
  });
});
