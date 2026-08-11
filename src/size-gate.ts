// The size gate: "this diff is too big — skip it". Pure, offline-testable,
// and deliberately dumb — it counts lines and files and compares them to two
// numbers.
//
// WHY this exists, stated exactly and no wider: it is a COST AND
// PREDICTABILITY gate, NOT a quality gate. Measured on our own runs, small
// trees bill $1.9–$4.8, while the 45-file / +2775 −1237 bench tree billed
// $6.58–$17.92 across 18 iterations — the cost roughly triples AND its spread
// widens to ~2.7x, so a big tree is both expensive and unbudgetable.
//
// What this gate does NOT claim, because we measured it and it is not true:
// that a bigger diff reviews WORSE. Attention dilution was tested and
// falsified in fixtures/scale-probe.ts, and the one measured Greptile-only
// miss came from a 7-file PR. Nothing here — comment, message or flag help —
// may imply otherwise.

import type { NumstatFile } from "./preflight";

export interface SizeGateConfig {
  // <= 0 disables the limit. Both knobs, independently.
  maxChangedLines: number;
  maxChangedFiles: number;
  excludeGlobs: string[];
}

// The shipped defaults. 1500 lines sits above the everyday PR and below the
// bench tree that produced the cost blow-up above; 150 files is the "this is
// a mechanical sweep, not a review" ceiling.
//
// The exclusion list is generated-content only: lockfiles, minified bundles
// and jest-style snapshots are enormous, mechanical, and nothing a hunter can
// usefully read. Excluding them keeps the gate from firing on a PR whose real
// change is ten lines beside a regenerated lockfile.
export const DEFAULT_SIZE_GATE: SizeGateConfig = {
  maxChangedLines: 1500,
  maxChangedFiles: 150,
  excludeGlobs: [
    "**/bun.lock",
    "**/package-lock.json",
    "**/yarn.lock",
    "**/pnpm-lock.yaml",
    "**/Cargo.lock",
    "**/go.sum",
    "**/*.min.js",
    "**/*.min.css",
    "**/*.snap",
  ],
};

export type SizeGateVerdict =
  | {
      ok: true;
      effectiveLines: number;
      effectiveFiles: number;
      excludedFiles: number;
      excludedLines: number;
    }
  | {
      ok: false;
      reason: "lines" | "files";
      effectiveLines: number;
      effectiveFiles: number;
      excludedFiles: number;
      excludedLines: number;
      limit: number;
      message: string;
    };

// Exclusions are applied FIRST and the REMAINDER is what gets compared: the
// whole point of the list is that a regenerated lockfile must not push a
// small change over the line. Lines are checked before files, because the
// line count is what actually drives the bill (files is the coarser
// backstop).
export function evaluateSizeGate(
  files: NumstatFile[],
  config: SizeGateConfig,
): SizeGateVerdict {
  const globs = config.excludeGlobs.map((pattern) => new Bun.Glob(pattern));
  let effectiveLines = 0;
  let effectiveFiles = 0;
  let excludedLines = 0;
  let excludedFiles = 0;
  for (const file of files) {
    const lines = file.insertions + file.deletions;
    if (globs.some((glob) => glob.match(file.path))) {
      excludedFiles++;
      excludedLines += lines;
      continue;
    }
    effectiveFiles++;
    effectiveLines += lines;
  }
  const counts = {
    effectiveLines,
    effectiveFiles,
    excludedFiles,
    excludedLines,
  };
  if (config.maxChangedLines > 0 && effectiveLines > config.maxChangedLines) {
    return {
      ok: false,
      reason: "lines",
      ...counts,
      limit: config.maxChangedLines,
      message: gateMessage(
        `${effectiveLines} effective changed line${plural(effectiveLines)} ` +
          `exceeds the ${config.maxChangedLines}-line limit`,
        counts,
        "--max-changed-lines",
      ),
    };
  }
  if (config.maxChangedFiles > 0 && effectiveFiles > config.maxChangedFiles) {
    return {
      ok: false,
      reason: "files",
      ...counts,
      limit: config.maxChangedFiles,
      message: gateMessage(
        `${effectiveFiles} effective changed file${plural(effectiveFiles)} ` +
          `exceeds the ${config.maxChangedFiles}-file limit`,
        counts,
        "--max-changed-files",
      ),
    };
  }
  return { ok: true, ...counts };
}

// The message names the COST reason and the escape hatch, in that order: an
// operator who hits this must be able to tell in one line that nothing is
// wrong with their PR and exactly which two levers move the gate.
//
// It quotes the MEASUREMENT rather than predicting THIS diff's bill. The
// limit is configurable, so "this costs $7-18" would be plainly false at a
// tightened threshold — and a gate that overstates its own evidence is the
// first step toward the quality claim we do not have.
function gateMessage(
  headline: string,
  counts: { excludedFiles: number; excludedLines: number },
  limitFlag: string,
): string {
  const exclusion =
    counts.excludedFiles > 0
      ? ` (${counts.excludedLines} line${plural(counts.excludedLines)} in ` +
        `${counts.excludedFiles} excluded file${plural(counts.excludedFiles)} ` +
        "were not counted)"
      : "";
  return (
    `${headline}${exclusion}. Cost scales with diff size and gets less ` +
    "predictable as it does (our 45-file bench tree billed $6.58-17.92, a " +
    "~2.7x spread), so pr-hero skips past the limit rather than guess at " +
    `the bill. Raise ${limitFlag}, or pass --force to review it anyway.`
  );
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

// The same gate against an AGGREGATE (files + insertions + deletions) with
// no per-file paths — so no exclusion can apply and the answer is an upper
// bound on the effective size. Used exactly where the per-file data costs a
// round-trip we have chosen not to pay: the PR dry run (which promises to
// fetch nothing) and the watcher's free first tier. It can only ever be
// wrong in the CONSERVATIVE direction — it may say "too large" for a diff
// whose lockfiles would have rescued it — so every caller must either label
// it an estimate or escalate to real per-file data before acting.
export function evaluateSizeGateAggregate(
  stat: { files: number; insertions: number; deletions: number },
  config: SizeGateConfig,
): SizeGateVerdict {
  const counts = {
    effectiveLines: stat.insertions + stat.deletions,
    effectiveFiles: stat.files,
    excludedFiles: 0,
    excludedLines: 0,
  };
  if (
    config.maxChangedLines > 0 &&
    counts.effectiveLines > config.maxChangedLines
  ) {
    return {
      ok: false,
      reason: "lines",
      ...counts,
      limit: config.maxChangedLines,
      message: gateMessage(
        `${counts.effectiveLines} changed line${plural(counts.effectiveLines)} ` +
          `exceeds the ${config.maxChangedLines}-line limit`,
        counts,
        "--max-changed-lines",
      ),
    };
  }
  if (
    config.maxChangedFiles > 0 &&
    counts.effectiveFiles > config.maxChangedFiles
  ) {
    return {
      ok: false,
      reason: "files",
      ...counts,
      limit: config.maxChangedFiles,
      message: gateMessage(
        `${counts.effectiveFiles} changed file${plural(counts.effectiveFiles)} ` +
          `exceeds the ${config.maxChangedFiles}-file limit`,
        counts,
        "--max-changed-files",
      ),
    };
  }
  return { ok: true, ...counts };
}

// The CLI's own knobs on top of the defaults. Undefined means "not asked
// for", never 0 — 0 is a real value here (it DISABLES the limit), so the
// two cannot be collapsed.
export function sizeGateConfig(overrides: {
  maxChangedLines?: number;
  maxChangedFiles?: number;
}): SizeGateConfig {
  return {
    maxChangedLines:
      overrides.maxChangedLines ?? DEFAULT_SIZE_GATE.maxChangedLines,
    maxChangedFiles:
      overrides.maxChangedFiles ?? DEFAULT_SIZE_GATE.maxChangedFiles,
    excludeGlobs: DEFAULT_SIZE_GATE.excludeGlobs,
  };
}

// A one-line projection for the plan/dry-run output. Kept here so the local
// and PR shells (and the watch dry run) cannot drift in how they phrase it.
export function sizeGateLine(verdict: SizeGateVerdict): string {
  const excluded =
    verdict.excludedFiles > 0
      ? `, ${verdict.excludedFiles} file(s)/${verdict.excludedLines} line(s) excluded`
      : "";
  return verdict.ok
    ? `size gate: pass — ${verdict.effectiveLines} effective line(s) in ` +
        `${verdict.effectiveFiles} file(s)${excluded}`
    : `size gate: SKIP — ${verdict.message}`;
}
