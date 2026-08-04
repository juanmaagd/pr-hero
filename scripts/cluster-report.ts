// Retro root-cause report over already-written findings artifacts.
//
// READ-ONLY: it opens files, prints, and exits. It writes nothing, ever — the
// artifacts it reads are paid-for benchmark evidence.
//
// Clusters are recomputed from `proof_refs` rather than read from
// `root_cause_id`, so the report works unchanged on runs recorded BEFORE that
// field existed. That is the entire point: the fan-out question is asked about
// history, not only about the next run.
//
// Run: bun run scripts/cluster-report.ts <findings.json> [<findings.json> ...]
import { clusterByRootCause, type RootCauseInput } from "../src/root-cause";

interface Entry extends RootCauseInput {
  tier: string | undefined;
}

function fail(message: string): never {
  console.error(`cluster-report: ${message}`);
  process.exit(1);
}

// Fail fast rather than skip: a partial report over an unknown subset of the
// requested files is worse than no report, because the numbers still look
// complete.
async function readEntries(filePath: string): Promise<Entry[]> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) fail(`cannot read ${filePath}`);
  let doc: unknown;
  try {
    doc = await file.json();
  } catch (error) {
    fail(`${filePath} is not valid JSON: ${(error as Error).message}`);
  }
  const findings = (doc as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) fail(`${filePath} has no findings[] array`);
  return findings.map((raw, i) => {
    const f = (raw ?? {}) as Record<string, unknown>;
    return {
      id: typeof f.id === "string" && f.id.length > 0 ? f.id : `#${i}`,
      proof_refs: Array.isArray(f.proof_refs)
        ? f.proof_refs.filter((r): r is string => typeof r === "string")
        : [],
      tier: typeof f.tier === "string" ? f.tier : undefined,
    };
  });
}

function report(filePath: string, entries: Entry[]): void {
  const all = clusterByRootCause(entries);
  const blockingEntries = entries.filter((e) => e.tier === "blocking");
  const blocking = clusterByRootCause(blockingEntries);
  const multi = blocking.clusters
    .filter((c) => c.finding_ids.length > 1)
    .sort((a, b) => b.finding_ids.length - a.finding_ids.length);
  const largest = multi[0];

  console.log(filePath);
  console.log(
    `  all       ${entries.length} findings -> ${all.distinct_root_causes} root causes`,
  );
  console.log(
    `  blocking  ${blockingEntries.length} findings -> ${blocking.distinct_root_causes} root causes`,
  );
  console.log(
    largest
      ? `  largest blocking cluster: ${largest.finding_ids.length} x ${largest.anchor}`
      : "  largest blocking cluster: none (no blocking cluster above size 1)",
  );
  for (const cluster of multi) {
    console.log(`    ${cluster.finding_ids.length} x ${cluster.anchor}`);
  }
  console.log("");
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  fail("usage: bun run scripts/cluster-report.ts <findings.json> [...]");
}
for (const filePath of paths) {
  report(filePath, await readEntries(filePath));
}
