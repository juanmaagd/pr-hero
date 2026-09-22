import { describe, expect, test } from "bun:test";
import { resolvePrDryRunSizeGate } from "#pr/preflight";
import { resolvePrDryRunNumstat } from "#pr/target";
import { DEFAULT_SIZE_GATE } from "#review/size-gate";

const MONSTER_FILE = {
  path: "a.ts",
  insertions: 5000,
  deletions: 0,
  binary: false,
};

describe("resolvePrDryRunNumstat — PR1b Addition 1 / #5557's degrade rule", () => {
  // The invariant test/cli.test.ts used to pin as literal source
  // ("perFile = null" inside a catch, never an empty array): a rejecting
  // fetch must degrade the dry-run size-gate estimate to the aggregate
  // GitHub counters, never manufacture a PASSING per-file verdict out of a
  // failed fetch. Proven through the real downstream consumer
  // (resolvePrDryRunSizeGate) rather than asserting the raw `null` alone, so
  // the test fails if the degrade path stops actually protecting the gate.
  test("a rejecting fetch degrades to the aggregate estimate rather than a passing empty list", async () => {
    const perFile = await resolvePrDryRunNumstat({
      fetchFiles: () => Promise.reject(new Error("gh timed out")),
      totalFiles: 1,
    });
    const { verdict } = resolvePrDryRunSizeGate({
      ghDiffStat: { files: 1, insertions: 5000, deletions: 0 },
      perFile,
      gateConfig: DEFAULT_SIZE_GATE,
    });
    expect(verdict.ok).toBe(false);
  });

  test("a truncated per-file list (fewer rows than GitHub's own file count) also degrades to the aggregate", async () => {
    const perFile = await resolvePrDryRunNumstat({
      fetchFiles: () => Promise.resolve([MONSTER_FILE]),
      totalFiles: 5,
    });
    expect(perFile).toBeNull();
  });

  test("a complete per-file list at or above the total is trusted and returned", async () => {
    const files = [MONSTER_FILE, { ...MONSTER_FILE, path: "b.ts" }];
    const perFile = await resolvePrDryRunNumstat({
      fetchFiles: () => Promise.resolve(files),
      totalFiles: 2,
    });
    expect(perFile).toEqual(files);
  });
});
