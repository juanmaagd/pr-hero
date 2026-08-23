// Integration & round-trip tests for the Canonical Product Store (prhero.db, Fundamentals #6).
// Asserts schema creation, migrations, transactional save, idempotency, cascade deletes,
// and exact deterministic round-trip reconstruction of FindingsDocument and StoredComparison.
//
// 100% offline, fresh tmp database per test run.

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Finding, FindingsDocument } from "../src/findings";
import type { StoredComparison } from "../src/ledger";
import type { PerAgentUsage } from "../src/pipeline";
import {
  exportComparison,
  exportFindingsDocument,
  getRunById,
  openProductStore,
  queryRuns,
  saveRunTransaction,
} from "../src/store";
import {
  CURRENT_PRODUCT_SCHEMA_VERSION,
  projectCompleteRun,
} from "../src/store-preflight";

async function tmpDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-store-"));
  return path.join(dir, "prhero.db");
}

function sampleFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F001",
    category: 2,
    path: "src/engine.ts",
    line: 42,
    symbol: "startEngine",
    severity: "CRITICAL",
    evidence_class: "deterministic",
    refuter_verdict: "corroborated",
    causal_disposition: "introduced",
    claim: "Resource leak in timeout handler without cleanup",
    proof_refs: [
      "src/engine.ts:42-45 (timer created here)",
      "src/engine.ts:80-82 (early return without clearing timer)",
    ],
    hunter: "lifecycle",
    tier: "blocking",
    hops_used: 2,
    hop_trail: [
      {
        step: 1,
        kind: "symbol_search",
        query: "startEngine",
        reached: "src/engine.ts:40",
      },
      {
        step: 2,
        kind: "callees",
        query: "clearTimeout",
        reached: "none",
      },
    ],
    dedupe_key: "src/engine.ts:42:lifecycle",
    root_cause_id: "RC001",
    ...overrides,
  };
}

function sampleDoc(
  overrides: Partial<FindingsDocument> = {},
): FindingsDocument {
  return {
    schema_version: "1.0.0",
    pr: 42,
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    model: "claude-3-7-sonnet",
    iteration: 3,
    prompt_set: {
      name: "arm-lifecycle-v7",
      sha256: "c".repeat(64),
    },
    driver_sha: "d".repeat(40),
    engine: {
      name: "pr-hero",
      version: "0.2.0",
    },
    parity_hunter_fired: true,
    run_status: "complete",
    sessionFailed: false,
    summary: {
      prose: "Found 1 critical lifecycle defect in timeout management.",
      score: 4,
      score_reason: "High quality findings with deterministic evidence.",
    },
    telemetry: {
      index_ms: 120,
      index_mode: "sync",
      sync_ms: 45,
      index_disk_mb: 12.5,
      wall_ms: 4500,
      tokens_in: 12000,
      tokens_out: 850,
      tokens_total: 12850,
      cost_usd_est: 0.38,
      per_agent: {
        lifecycle: { tokens_total: 8000, duration_ms: 3200 },
        reliability: { tokens_total: 4850, duration_ms: 1300 },
      },
    },
    findings: [
      sampleFinding(),
      sampleFinding({
        id: "F002",
        category: 1,
        path: "src/client.ts",
        line: 15,
        severity: "WARNING",
        evidence_class: "inferential",
        refuter_verdict: "inconclusive",
        causal_disposition: "pre-existing",
        claim: "Unchecked error return value",
        proof_refs: ["src/client.ts:15"],
        hunter: "reliability",
        tier: "advisory",
        hops_used: 1,
        hop_trail: [
          { step: 1, kind: "read", query: "client.ts", reached: "line 15" },
        ],
        dedupe_key: "src/client.ts:15:reliability",
        root_cause_id: "RC002",
      }),
    ],
    debug: {
      refuted: [
        {
          id: "F003",
          category: 3,
          path: "src/guard.ts",
          line: 88,
          symbol: "validate",
          severity: "BLOCKER",
          evidence_class: "inferential",
          refuter_verdict: "refuted",
          causal_disposition: "introduced",
          claim: "Claim refuted by existing fallback check",
          proof_refs: ["src/guard.ts:88"],
          hunter: "resilience",
          hops_used: 1,
          hop_trail: [],
          dedupe_key: "src/guard.ts:88",
        },
      ],
      deduped: [
        {
          id: "F004",
          category: 2,
          path: "src/engine.ts",
          line: 43,
          symbol: "startEngine",
          severity: "CRITICAL",
          evidence_class: "deterministic",
          refuter_verdict: "corroborated",
          causal_disposition: "introduced",
          claim: "Duplicate timer leak claim",
          proof_refs: ["src/engine.ts:43"],
          hunter: "reliability",
          hops_used: 1,
          hop_trail: [],
          dedupe_key: "src/engine.ts:43:duplicate",
          merged_into: "F001",
        },
      ],
      root_causes: {
        clusters: [
          { id: "RC001", anchor: "src/engine.ts:42-45", finding_ids: ["F001"] },
          { id: "RC002", anchor: "src/client.ts:15", finding_ids: ["F002"] },
        ],
        distinct_root_causes: 2,
      },
    },
    ...overrides,
  };
}

const SAMPLE_PER_AGENT: Record<string, PerAgentUsage> = {
  lifecycle: {
    tokens_total: 8000,
    duration_ms: 3200,
    tokens_in: 7200,
    tokens_out: 800,
    cost_usd_est: 0.25,
    attempts: 1,
    status: "ok",
  },
  reliability: {
    tokens_total: 4850,
    duration_ms: 1300,
    tokens_in: 4800,
    tokens_out: 50,
    cost_usd_est: 0.13,
    attempts: 1,
    status: "ok",
  },
};

const SAMPLE_COMPARISON: StoredComparison = {
  pr: 42,
  head_sha: "b".repeat(40),
  diff_from_sha: "a".repeat(40),
  run_dir: "2026-08-23T18-00-00-000Z-pr-42",
  run_status: "complete",
  generated_at: "2026-08-23T18:00:00.000Z",
  greptile: { found: true },
  rows: [
    {
      bucket: "both",
      greptile: {
        index: 0,
        path: "src/engine.ts",
        start_line: 42,
        end_line: 45,
        title: "Missing timer cleanup",
        description: "Missing timer cleanup",
      },
      prhero: {
        id: "F001",
        path: "src/engine.ts",
        line: 42,
        claim: "Resource leak in timeout handler without cleanup",
        tier: "blocking",
      },
      verdict: "both-found-real-bug",
      reasoning: "Both reviewers flagged the timer leak",
      actor: "human",
    },
    {
      bucket: "prhero_only",
      greptile: null,
      prhero: {
        id: "F002",
        path: "src/client.ts",
        line: 15,
        claim: "Unchecked error return value",
        tier: "advisory",
      },
      verdict: null,
      reasoning: null,
      actor: null,
    },
  ],
};

const REPO_ID = "github.com/juanmaagd/pr-hero";
const RUN_DIR = "2026-08-23T18-00-00-000Z-pr-42";

describe("openProductStore", () => {
  test("creates the file, migrates to CURRENT_PRODUCT_SCHEMA_VERSION, and enables WAL + foreign keys", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const journalMode = (
        db.query("PRAGMA journal_mode;").get() as { journal_mode: string }
      ).journal_mode;
      expect(journalMode.toLowerCase()).toBe("wal");

      const version = (
        db.query("PRAGMA user_version;").get() as { user_version: number }
      ).user_version;
      expect(version).toBe(CURRENT_PRODUCT_SCHEMA_VERSION);

      const foreignKeys = (
        db.query("PRAGMA foreign_keys;").get() as { foreign_keys: number }
      ).foreign_keys;
      expect(foreignKeys).toBe(1);

      // Verify all tables exist
      const tables = (
        db
          .query("SELECT name FROM sqlite_master WHERE type='table';")
          .all() as {
          name: string;
        }[]
      ).map((t) => t.name);

      expect(tables).toContain("runs");
      expect(tables).toContain("findings");
      expect(tables).toContain("finding_proof_refs");
      expect(tables).toContain("finding_hop_trail");
      expect(tables).toContain("debug_findings");
      expect(tables).toContain("run_agents");
      expect(tables).toContain("comparison_rows");
    } finally {
      db.close();
    }
  });
});

describe("saveRunTransaction and round-trip fidelity", () => {
  test("persists full run and exports byte-compatible FindingsDocument", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const originalDoc = sampleDoc();
      const projected = projectCompleteRun({
        doc: originalDoc,
        perAgent: SAMPLE_PER_AGENT,
        comparison: SAMPLE_COMPARISON,
        repoId: REPO_ID,
        runDir: RUN_DIR,
        checkoutPath: "/Users/juanma/Desktop/pr-hero",
        generatedAt: "2026-08-23T18:00:00.000Z",
      });

      const runId = saveRunTransaction(db, projected);
      expect(runId).toBeGreaterThan(0);

      const runRow = getRunById(db, runId);
      expect(runRow).not.toBeNull();
      expect(runRow?.repo_id).toBe(REPO_ID);
      expect(runRow?.run_dir).toBe(RUN_DIR);
      expect(runRow?.pr).toBe(42);
      expect(runRow?.blocking).toBe(1);
      expect(runRow?.advisory).toBe(1);
      expect(runRow?.greptile_found).toBe(1);

      // Round-trip export
      const exportedDoc = exportFindingsDocument(db, runId);
      expect(exportedDoc).not.toBeNull();
      expect(exportedDoc).toEqual(originalDoc);

      // Comparison export
      const exportedComparison = exportComparison(db, runId);
      expect(exportedComparison).not.toBeNull();
      expect(exportedComparison).toEqual(SAMPLE_COMPARISON);
    } finally {
      db.close();
    }
  });

  test("handles local runs (pr === 0) mapped to null SQL and back to 0 on export", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const localDoc = sampleDoc({ pr: 0 });
      const localRunDir = "2026-08-23T18-00-00-000Z-local";
      const projected = projectCompleteRun({
        doc: localDoc,
        repoId: REPO_ID,
        runDir: localRunDir,
        checkoutPath: "/Users/juanma/Desktop/pr-hero",
        generatedAt: "2026-08-23T18:00:00.000Z",
      });

      const runId = saveRunTransaction(db, projected);
      const runRow = getRunById(db, runId);
      expect(runRow?.pr).toBeNull();

      const exportedDoc = exportFindingsDocument(db, runId);
      expect(exportedDoc?.pr).toBe(0);
      expect(exportedDoc).toEqual(localDoc);

      const exportedComp = exportComparison(db, runId);
      expect(exportedComp).toBeNull();
    } finally {
      db.close();
    }
  });

  test("idempotency: re-saving same run_dir updates parent and replaces children cleanly", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const docV1 = sampleDoc();
      const projectedV1 = projectCompleteRun({
        doc: docV1,
        perAgent: SAMPLE_PER_AGENT,
        comparison: SAMPLE_COMPARISON,
        repoId: REPO_ID,
        runDir: RUN_DIR,
        checkoutPath: "/Users/juanma/Desktop/pr-hero",
        generatedAt: "2026-08-23T18:00:00.000Z",
      });

      const id1 = saveRunTransaction(db, projectedV1);

      // Check count of findings
      const count1 = (
        db
          .query("SELECT COUNT(*) as c FROM findings WHERE run_id = ?")
          .get(id1) as {
          c: number;
        }
      ).c;
      expect(count1).toBe(2);

      // Re-save with updated doc (only 1 finding)
      const docV2 = sampleDoc({
        findings: [sampleFinding()],
      });
      const projectedV2 = projectCompleteRun({
        doc: docV2,
        perAgent: SAMPLE_PER_AGENT,
        comparison: null,
        repoId: REPO_ID,
        runDir: RUN_DIR,
        checkoutPath: "/Users/juanma/Desktop/pr-hero",
        generatedAt: "2026-08-23T18:05:00.000Z",
      });

      const id2 = saveRunTransaction(db, projectedV2);
      expect(id2).toBe(id1);

      const totalRuns = (
        db.query("SELECT COUNT(*) as c FROM runs").get() as { c: number }
      ).c;
      expect(totalRuns).toBe(1);

      const count2 = (
        db
          .query("SELECT COUNT(*) as c FROM findings WHERE run_id = ?")
          .get(id2) as {
          c: number;
        }
      ).c;
      expect(count2).toBe(1);

      const exportedDocV2 = exportFindingsDocument(db, id2);
      expect(exportedDocV2?.findings.length).toBe(1);
    } finally {
      db.close();
    }
  });

  test("cascade deletes remove all associated child rows", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const doc = sampleDoc();
      const projected = projectCompleteRun({
        doc,
        perAgent: SAMPLE_PER_AGENT,
        comparison: SAMPLE_COMPARISON,
        repoId: REPO_ID,
        runDir: RUN_DIR,
        checkoutPath: "/Users/juanma/Desktop/pr-hero",
        generatedAt: "2026-08-23T18:00:00.000Z",
      });

      const runId = saveRunTransaction(db, projected);
      expect(runId).toBeGreaterThan(0);

      // Delete the run
      db.query("DELETE FROM runs WHERE id = ?").run(runId);

      const findingsCount = (
        db
          .query("SELECT COUNT(*) as c FROM findings WHERE run_id = ?")
          .get(runId) as {
          c: number;
        }
      ).c;
      expect(findingsCount).toBe(0);

      const proofRefsCount = (
        db.query("SELECT COUNT(*) as c FROM finding_proof_refs").get() as {
          c: number;
        }
      ).c;
      expect(proofRefsCount).toBe(0);

      const hopTrailsCount = (
        db.query("SELECT COUNT(*) as c FROM finding_hop_trail").get() as {
          c: number;
        }
      ).c;
      expect(hopTrailsCount).toBe(0);

      const debugCount = (
        db
          .query("SELECT COUNT(*) as c FROM debug_findings WHERE run_id = ?")
          .get(runId) as {
          c: number;
        }
      ).c;
      expect(debugCount).toBe(0);

      const agentsCount = (
        db
          .query("SELECT COUNT(*) as c FROM run_agents WHERE run_id = ?")
          .get(runId) as {
          c: number;
        }
      ).c;
      expect(agentsCount).toBe(0);

      const compCount = (
        db
          .query("SELECT COUNT(*) as c FROM comparison_rows WHERE run_id = ?")
          .get(runId) as {
          c: number;
        }
      ).c;
      expect(compCount).toBe(0);
    } finally {
      db.close();
    }
  });

  test("queryRuns scopes by repo_id or returns all", async () => {
    const dbPath = await tmpDbPath();
    const db = openProductStore(dbPath);
    try {
      const docA = sampleDoc({ pr: 1 });
      const docB = sampleDoc({ pr: 2 });

      saveRunTransaction(
        db,
        projectCompleteRun({
          doc: docA,
          repoId: "github.com/org/repo-a",
          runDir: "run-a",
          checkoutPath: null,
          generatedAt: "2026-08-23T18:00:00.000Z",
        }),
      );

      saveRunTransaction(
        db,
        projectCompleteRun({
          doc: docB,
          repoId: "github.com/org/repo-b",
          runDir: "run-b",
          checkoutPath: null,
          generatedAt: "2026-08-23T18:01:00.000Z",
        }),
      );

      const all = queryRuns(db, { all: true });
      expect(all.length).toBe(2);

      const repoAOnly = queryRuns(db, { repoId: "github.com/org/repo-a" });
      expect(repoAOnly.length).toBe(1);
      expect(repoAOnly[0]?.repo_id).toBe("github.com/org/repo-a");
    } finally {
      db.close();
    }
  });
});
