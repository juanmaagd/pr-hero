// Canonical product store (Fundamentals #6 / observability-canonical-store.md),
// historical backfill & metrics.db migration module.
//
// Ingests historical findings.json and comparison.json runs across ~/.prhero/repos
// into ~/.prhero/prhero.db idempotently.

import { copyFileSync, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  type BackfillStats,
  createEmptyBackfillStats,
  parseRepoIdFromRelPath,
} from "./backfill-preflight";
import { type FindingsDocument, validateFindingsDocument } from "./findings";
import { prheroLayout } from "./home-preflight";
import { parseComparisonJson, type StoredComparison } from "./ledger";
import { openProductStore, saveRunTransaction } from "./store";
import { projectCompleteRun } from "./store-preflight";

export interface BackfillOptions {
  home: string;
  reposDir?: string;
  dbPath?: string;
  log?: (msg: string) => void;
}

export async function backfillHistoricalRuns(
  options: BackfillOptions,
): Promise<BackfillStats> {
  const layout = prheroLayout(options.home);
  const reposDir = options.reposDir ?? layout.reposDir;
  const dbPath = options.dbPath ?? layout.prheroDbPath;
  const stats = createEmptyBackfillStats();

  if (!existsSync(reposDir)) {
    return stats;
  }

  const db = openProductStore(dbPath);
  try {
    const glob = new Bun.Glob("**/findings.json");
    for await (const rel of glob.scan({ cwd: reposDir })) {
      stats.discovered++;
      const findingsPath = path.join(reposDir, rel);
      const runDir = path.dirname(findingsPath);
      const runDirName = path.basename(runDir);

      try {
        const text = await Bun.file(findingsPath).text();
        const json = JSON.parse(text);
        let doc: FindingsDocument;
        try {
          doc = validateFindingsDocument(json);
        } catch (err) {
          stats.errors++;
          options.log?.(
            `warning: invalid findings.json in ${runDir}: ${(err as Error).message}`,
          );
          continue;
        }

        // Try reading comparison.json
        let comparison: StoredComparison | null = null;
        const comparisonPath = path.join(runDir, "comparison.json");
        if (existsSync(comparisonPath)) {
          try {
            const compText = await Bun.file(comparisonPath).text();
            comparison = parseComparisonJson(compText);
          } catch {}
        }

        // Try reading pipeline.json for provenance / repo_id
        let repoId = parseRepoIdFromRelPath(rel);
        const pipelinePath = path.join(runDir, "pipeline.json");
        if (existsSync(pipelinePath)) {
          try {
            const pipeJson = JSON.parse(await Bun.file(pipelinePath).text());
            if (pipeJson.repo_id && typeof pipeJson.repo_id === "string") {
              repoId = pipeJson.repo_id;
            }
          } catch {}
        }

        if (!repoId) {
          stats.skipped++;
          options.log?.(
            `warning: could not determine repo_id for ${runDir}; skipped`,
          );
          continue;
        }

        const { mtime } = await stat(findingsPath);
        const generatedAt = comparison?.generated_at ?? mtime.toISOString();

        const projected = projectCompleteRun({
          doc,
          perAgent: {},
          comparison,
          repoId,
          runDir: runDirName,
          checkoutPath: null,
          generatedAt,
        });

        saveRunTransaction(db, projected);
        stats.ingested++;
        stats.total_tokens += doc.telemetry.tokens_total;
        stats.total_cost_usd += doc.telemetry.cost_usd_est;
      } catch (err) {
        stats.errors++;
        options.log?.(
          `error: failed to backfill ${runDir}: ${(err as Error).message}`,
        );
      }
    }
  } finally {
    db.close();
  }

  return stats;
}

export interface MigrationResult {
  migrated: boolean;
  backupPath?: string;
}

export function migrateMetricsDb(home: string): MigrationResult {
  const layout = prheroLayout(home);
  if (!existsSync(layout.metricsDbPath)) {
    return { migrated: false };
  }

  const backupPath = `${layout.metricsDbPath}.bak`;
  if (!existsSync(backupPath)) {
    copyFileSync(layout.metricsDbPath, backupPath);
  }

  return {
    migrated: true,
    backupPath,
  };
}
