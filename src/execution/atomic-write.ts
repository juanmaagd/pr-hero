import { mkdir, rename } from "node:fs/promises";
import path from "node:path";

// WHY its own module rather than a helper inside harness.ts, where this writer
// was born: TWO impure callers need the identical tmp+rename guarantee — the
// harness's per-step artifacts and the pipeline's partial snapshot (§5.3 step 7)
// — and `harness.ts` is a 1000-line impure module carrying transports, spawn,
// credential projection and settlement. `pipeline.ts` importing it wholesale to
// reach one four-line function would drag all of that into the pipeline's
// dependency graph. A plain `Bun.write` is not a substitute: a crash or a
// concurrent reader mid-write sees a TRUNCATED artifact, and every reader of
// these files (parsePipelineMeta, floor-test, the CLI, backfill) parses JSON and
// fails hard on one.

export async function writeJsonAtomically(
  outPath: string,
  value: unknown,
  // PR #228 review, F003: pretty-printing (the default, and every OTHER
  // caller's shape) is never appropriate for a size-capped diagnostic
  // capture — `JSON.stringify(value, null, 2)`'s per-level indentation and
  // newlines inflate a multi-thousand-record array well past the compact
  // size a caller already checked against a byte cap. `compact: true` opts
  // a single caller (the OpenCode capture file) into the exact bytes that
  // were measured, without changing the formatting of anything else this
  // function writes.
  options: { compact?: boolean } = {},
): Promise<void> {
  const tmpPath = `${outPath}.tmp`;
  await mkdir(path.dirname(outPath), { recursive: true });
  const text = options.compact
    ? JSON.stringify(value)
    : `${JSON.stringify(value, null, 2)}\n`;
  await Bun.write(tmpPath, text);
  await rename(tmpPath, outPath);
}
