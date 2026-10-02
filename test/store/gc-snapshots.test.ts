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
import { STALE_SNAPSHOT_MAX_AGE_MS } from "#model/exec-snapshots";
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
  base = path.join(tempDir, "snaps");
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

describe("renderSnapshotGcLine", () => {
  const report = (overrides: { removedBytes: number; failed?: number }) => ({
    removed: 4,
    kept: 2,
    failed: 0,
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
