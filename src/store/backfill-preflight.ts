// Canonical product store (Fundamentals #6 / observability-canonical-store.md),
// backfill pure half: path matchers, stats accumulators, and report renderers.
//
// Pure and testable offline: no filesystem, no database handles.

export interface BackfillStats {
  discovered: number;
  ingested: number;
  skipped: number;
  errors: number;
  total_tokens: number;
  total_cost_usd: number;
}

export function createEmptyBackfillStats(): BackfillStats {
  return {
    discovered: 0,
    ingested: 0,
    skipped: 0,
    errors: 0,
    total_tokens: 0,
    total_cost_usd: 0,
  };
}

export function parseRepoIdFromRelPath(relPath: string): string | null {
  // e.g. "github.com/owner/repo/runs/pr-42-abc-1/findings.json"
  // or "github.com/owner/repo/runs/local-abc-1/findings.json"
  const parts = relPath.split("/");
  const runsIndex = parts.indexOf("runs");
  if (runsIndex > 0) {
    return parts.slice(0, runsIndex).join("/");
  }
  return null;
}

export function renderBackfillReport(stats: BackfillStats): string {
  const lines = [
    "Canonical Product Store Backfill Report",
    "=======================================",
    `Discovered runs: ${stats.discovered}`,
    `Ingested runs:   ${stats.ingested}`,
    `Skipped runs:    ${stats.skipped}`,
    `Errors:          ${stats.errors}`,
    `Total tokens:    ${stats.total_tokens.toLocaleString()}`,
    `Total cost USD:  $${stats.total_cost_usd.toFixed(2)}`,
  ];
  return lines.join("\n");
}
