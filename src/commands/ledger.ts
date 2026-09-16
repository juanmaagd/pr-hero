import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  aggregateLedger,
  parseComparisonJson,
  renderLedger,
  type StoredComparison,
} from "#compare/ledger";
import { resolveRepoRoot } from "#git/git";
import type { CliOptions } from "#review/preflight";
import { log } from "#ui/primitives";
import { CliError, CliUsageError } from "../errors";
import { resolveRepoHome } from "../home";

// `pr-hero ledger` (ROADMAP B4) — accumulate every run's comparison.json
// into one markdown ledger, so the three buckets become a rate instead of a
// per-run snapshot. Read-only over the runs root; every decision (parse,
// latest-run-per-PR, render) is pure in compare/ledger.ts.
export async function ledgerCommand(options: CliOptions): Promise<number> {
  const repoRoot = await resolveRepoRoot(options.repo);
  const runsRoot = options.runs
    ? path.resolve(options.runs)
    : (
        await resolveRepoHome({
          home: os.homedir(),
          operatorRoot: repoRoot,
          persist: false,
        })
      ).paths.runs;
  // One level deep on purpose: run dirs are flat children of the root, and
  // a recursive glob would pick up anything a run itself wrote deeper down.
  const files: string[] = [];
  if (existsSync(runsRoot)) {
    for await (const entry of new Bun.Glob("*/comparison.json").scan({
      cwd: runsRoot,
    })) {
      files.push(path.join(runsRoot, entry));
    }
  }
  // Sorted so aggregation sees a deterministic order — timestamp ties in
  // the latest-run pick resolve by input order.
  files.sort();
  // An empty ledger is a valid state of the world (no reviews have run
  // yet), not an error: note it on stderr, leave stdout clean, exit 0.
  if (files.length === 0) {
    log(
      `no comparison.json found under ${runsRoot} — run ` +
        "`pr-hero review --pr <n>` first, or point --runs at the runs root",
    );
    return 0;
  }
  const entries: { comparison: StoredComparison; mtimeMs: number }[] = [];
  for (const file of files) {
    const raw = await Bun.file(file).text();
    let comparison: StoredComparison;
    try {
      comparison = parseComparisonJson(raw);
    } catch (error) {
      // The pure parser names the field; only the shell knows the file.
      if (error instanceof CliUsageError) {
        throw new CliError(`${file}: ${error.message}`);
      }
      throw error;
    }
    // mtime is the ordering fallback for files that predate the
    // generated_at stamp (the first paid run's artifact is one of them).
    const { mtimeMs } = await stat(file);
    entries.push({ comparison, mtimeMs });
  }
  const markdown = renderLedger(aggregateLedger(entries));
  if (options.out) {
    const outPath = path.resolve(options.out);
    await Bun.write(outPath, markdown);
    log(`ledger: wrote ${outPath} (from ${files.length} run(s))`);
    return 0;
  }
  // The markdown IS this command's product, and stdout is the one clean
  // channel (everything human-facing goes to stderr), so it can be piped or
  // redirected without the notes riding along.
  process.stdout.write(markdown);
  return 0;
}
