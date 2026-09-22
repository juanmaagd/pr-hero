// Offline behavior tests for pr/comparison.ts's computeGreptileComparison —
// zero direct tests existed before this file (rg over test/ for the name
// returned nothing).
//
// writeComparison (#pr/pr) calls fetchPrComments with no spawnFn of its
// own, and pr.ts is out of scope for this slice, so computeGreptileComparison
// gained a `write` seam (default: the real writeComparison). The fake below
// writes a REAL comparison.json to a temp runDir using the same
// buildComparisonJson the production writer uses, so the read-back half
// (parseComparisonJson over Bun.file(...).text()) still runs for real —
// only the gh-backed write is replaced.

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComparisonResult } from "#compare/compare";
import { computeGreptileComparison } from "#pr/comparison";
import type { ComparisonOutcome } from "#pr/pr";
import { buildComparisonJson } from "#pr/preflight";

const PR = 42;
const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);

const EMPTY_RESULT: ComparisonResult = {
  greptileOnly: [],
  both: [],
  prheroOnly: [],
};

async function tmpRunDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pr-hero-comparison-"));
}

// Writes a real comparison.json (via the same pure buildComparisonJson the
// production writeComparison uses) and returns a matching ComparisonOutcome
// — a fake writer that never touches gh, but leaves a real artifact for
// parseComparisonJson to read back.
function fakeWriter(
  result: ComparisonResult,
  greptileFound: boolean,
): typeof import("#pr/pr").writeComparison {
  return async (input) => {
    const jsonPath = path.join(input.runDir, "comparison.json");
    const markdownPath = path.join(input.runDir, "comparison.md");
    const json = buildComparisonJson({
      pr: input.pr,
      headSha: input.headSha,
      diffFromSha: input.diffFromSha,
      runDir: input.runDir,
      generatedAt: input.generatedAt,
      runStatus: input.runStatus,
      greptileFound,
      result,
    });
    await writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
    const outcome: ComparisonOutcome = {
      greptileFound,
      greptileOnly: result.greptileOnly.length,
      both: result.both.length,
      prheroOnly: result.prheroOnly.length,
      markdownPath,
      jsonPath,
      result,
    };
    return outcome;
  };
}

describe("computeGreptileComparison — sessionFailed guard", () => {
  test("a failed session compares nothing and never calls the writer", async () => {
    let writeCalls = 0;
    const result = await computeGreptileComparison({
      sessionFailed: true,
      operatorRoot: "/repo",
      pr: PR,
      headSha: HEAD,
      diffFromSha: BASE,
      runDir: "/runs/1",
      runStatus: "complete",
      findings: [],
      write: async () => {
        writeCalls++;
        throw new Error("should never be called");
      },
    });
    expect(result).toEqual({ comparison: null, storedComparison: null });
    expect(writeCalls).toBe(0);
  });
});

describe("computeGreptileComparison — a successful comparison", () => {
  test("reads the just-written comparison.json back into storedComparison", async () => {
    const runDir = await tmpRunDir();
    const result = await computeGreptileComparison({
      sessionFailed: false,
      operatorRoot: "/repo",
      pr: PR,
      headSha: HEAD,
      diffFromSha: BASE,
      runDir,
      runStatus: "complete",
      findings: [],
      write: fakeWriter(EMPTY_RESULT, true),
    });
    expect(result.comparison).not.toBeNull();
    expect(result.comparison?.greptileFound).toBe(true);
    expect(result.storedComparison).not.toBeNull();
    expect(result.storedComparison?.pr).toBe(PR);
    expect(result.storedComparison?.head_sha).toBe(HEAD);
    expect(result.storedComparison?.diff_from_sha).toBe(BASE);
    expect(result.storedComparison?.run_status).toBe("complete");
    expect(result.storedComparison?.greptile).toEqual({ found: true });
    expect(result.storedComparison?.rows).toEqual([]);
  });
});

describe("computeGreptileComparison — the writer fails", () => {
  test("degrades to no comparison at all, without throwing", async () => {
    const result = await computeGreptileComparison({
      sessionFailed: false,
      operatorRoot: "/repo",
      pr: PR,
      headSha: HEAD,
      diffFromSha: BASE,
      runDir: "/runs/1",
      runStatus: "complete",
      findings: [],
      write: async () => {
        throw new Error("gh api compare failed");
      },
    });
    expect(result).toEqual({ comparison: null, storedComparison: null });
  });
});

describe("computeGreptileComparison — the read-back fails", () => {
  test("keeps the comparison outcome even when its json cannot be read back", async () => {
    const runDir = await tmpRunDir();
    // The writer reports a jsonPath that was never actually written.
    const missingPath = path.join(runDir, "never-written.json");
    const result = await computeGreptileComparison({
      sessionFailed: false,
      operatorRoot: "/repo",
      pr: PR,
      headSha: HEAD,
      diffFromSha: BASE,
      runDir,
      runStatus: "complete",
      findings: [],
      write: async () => ({
        greptileFound: false,
        greptileOnly: 0,
        both: 0,
        prheroOnly: 0,
        markdownPath: path.join(runDir, "comparison.md"),
        jsonPath: missingPath,
        result: EMPTY_RESULT,
      }),
    });
    expect(result.comparison).not.toBeNull();
    expect(result.comparison?.jsonPath).toBe(missingPath);
    expect(result.storedComparison).toBeNull();
  });

  test("keeps the comparison outcome even when its json is malformed", async () => {
    const runDir = await tmpRunDir();
    const jsonPath = path.join(runDir, "comparison.json");
    await writeFile(jsonPath, "not json");
    const result = await computeGreptileComparison({
      sessionFailed: false,
      operatorRoot: "/repo",
      pr: PR,
      headSha: HEAD,
      diffFromSha: BASE,
      runDir,
      runStatus: "complete",
      findings: [],
      write: async () => ({
        greptileFound: false,
        greptileOnly: 0,
        both: 0,
        prheroOnly: 0,
        markdownPath: path.join(runDir, "comparison.md"),
        jsonPath,
        result: EMPTY_RESULT,
      }),
    });
    expect(result.comparison).not.toBeNull();
    expect(result.storedComparison).toBeNull();
  });
});
