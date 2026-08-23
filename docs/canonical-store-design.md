# Canonical Product Store & Query Layer — Design

Status: **PROPOSED** (2026-08-23).
Roadmap seat: THE LAUNCH LINE → Fundamentals #6 (`ROADMAP.md:118-127`, `ROADMAP.md:231-232`).
Reference proposal: `docs/observability-canonical-store.md`.

House pattern: same shape as `docs/c4-preamble-design.md`, `docs/item7-rereview-design.md`, and `docs/c5-global-config-design.md` — terrain verified first (§0), architectural decisions (§1), schema DDL & data model (§2), pure projections & roundtrip serialization (§3), slicing strategy (§4), and test obligations (§5).

---

## 0. The terrain, verified 2026-08-23

Every line reference below was read this session, in this tree, at `60ccf7f`.

### 0.1 Artifacts vs SQLite split today (W4 heritage)

1. **`findings.json` is the current source of truth** (`src/findings.ts:116-159`):
   - Contains full findings array (`Finding`: `id`, `category`, `path`, `line`, `symbol`, `severity`, `evidence_class`, `refuter_verdict`, `causal_disposition`, `claim`, `proof_refs`, `hunter`, `tier`, `hops_used`, `hop_trail`, `dedupe_key`, `root_cause_id`).
   - Contains debug findings (`refuted`, `deduped`, `root_causes`).
   - Contains run metadata (`schema_version`, `pr`, `base_sha`, `head_sha`, `model`, `iteration`, `prompt_set`, `driver_sha`, `engine`, `parity_hunter_fired`, `run_status`, `sessionFailed`, `summary`, `telemetry`).
2. **`metrics.db` is an incomplete projection** (`src/metrics-preflight.ts:29-78`):
   - Stores only `runs` (scalar metrics + blocking/advisory counts), `run_agents` (per-agent token/cost/duration usage), and `comparison_rows` (Greptile H2H projection).
   - Findings, proof references, hop trails, and debug records **are not stored in SQLite at all**.
   - Direct `failSoftIngest` (`src/metrics.ts:251-270`): SQLite write failures print a warning and never fail the review.
3. **Paths and layout** (`src/home-preflight.ts:19-56`):
   - `prheroLayout(home).metricsDbPath` points to `~/.prhero/metrics.db`.
   - The canonical product database must live at `~/.prhero/prhero.db`.

---

## 1. Architectural Decisions

### D1. Single Canonical SQLite Database (`~/.prhero/prhero.db`)
* **Decision:** Replace `metrics.db` with `prhero.db`.
* **Rationale:** The database is not a metrics sidecar; it is the **product source of truth**.
* **Invariant:** Every fact present in `findings.json` and `comparison.json` must be stored transactionally in `prhero.db`.

### D2. Derived JSON & Markdown Exports
* **Decision:** JSON files (`findings.json`, `comparison.json`) and markdown reports (`report.md`) become **derived views** generated deterministically from SQLite records.
* **Invariant:** Deleting a run directory's `findings.json` or removing a worktree via GC must leave the canonical review data intact and queryable in `prhero.db`.

### D3. Local Store Repository Layer (`src/store/`)
* **Decision:** Encapsulate SQLite DDL, migrations, transactional insert/upsert, and domain queries in a dedicated `src/store/` module (pure projections in `src/store/store-preflight.ts`, SQLite execution in `src/store/store.ts`).
* **Invariant:** No domain business logic or raw SQL strings in consumers.

### D4. Deterministic Round-Trip Serialization
* **Decision:** `deserializeFindingsDocument(runId)` from SQLite must reconstruct a byte-identical `FindingsDocument` (conforming to Schema v1.0.0 in `src/findings.ts`).

---

## 2. Data Model & Schema DDL (Schema v1 for `prhero.db`)

```sql
-- Parent runs table
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  run_dir TEXT NOT NULL UNIQUE,
  pr INTEGER NULL,
  checkout_path TEXT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  run_status TEXT NOT NULL,
  session_failed INTEGER NOT NULL,
  model TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  parity_hunter_fired INTEGER NOT NULL,
  prompt_set_name TEXT NULL,
  prompt_set_sha256 TEXT NULL,
  driver_sha TEXT NULL,
  engine_name TEXT NULL,
  engine_version TEXT NULL,
  summary_prose TEXT NULL,
  summary_score INTEGER NULL,
  summary_score_reason TEXT NULL,
  generated_at TEXT NOT NULL,
  wall_ms INTEGER NOT NULL,
  index_ms INTEGER NOT NULL,
  index_mode TEXT NULL,
  index_disk_mb REAL NULL,
  sync_ms INTEGER NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  tokens_total INTEGER NOT NULL,
  cost_usd_est REAL NOT NULL,
  blocking INTEGER NOT NULL,
  advisory INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_repo_id ON runs (repo_id);
CREATE INDEX IF NOT EXISTS idx_runs_generated_at ON runs (generated_at);

-- Public findings table
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL,
  category INTEGER NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  symbol TEXT NULL,
  severity TEXT NOT NULL,
  evidence_class TEXT NOT NULL,
  refuter_verdict TEXT NOT NULL,
  causal_disposition TEXT NOT NULL,
  claim TEXT NOT NULL,
  hunter TEXT NOT NULL,
  tier TEXT NOT NULL,
  hops_used INTEGER NOT NULL,
  dedupe_key TEXT NOT NULL,
  root_cause_id TEXT NULL,
  finding_order INTEGER NOT NULL,
  UNIQUE (run_id, finding_id)
);

CREATE INDEX IF NOT EXISTS idx_findings_run_id ON findings (run_id);
CREATE INDEX IF NOT EXISTS idx_findings_path ON findings (path);

-- Finding proof references
CREATE TABLE IF NOT EXISTS finding_proof_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id INTEGER NOT NULL REFERENCES findings (id) ON DELETE CASCADE,
  ref_order INTEGER NOT NULL,
  proof_ref TEXT NOT NULL,
  UNIQUE (finding_id, ref_order)
);

-- Finding hop trails
CREATE TABLE IF NOT EXISTS finding_hop_trail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id INTEGER NOT NULL REFERENCES findings (id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  step_num INTEGER NOT NULL,
  kind TEXT NOT NULL,
  query TEXT NOT NULL,
  reached TEXT NOT NULL,
  UNIQUE (finding_id, step_order)
);

-- Debug findings (refuted, deduped)
CREATE TABLE IF NOT EXISTS debug_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- 'refuted' | 'deduped'
  merged_into TEXT NULL,
  category INTEGER NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  symbol TEXT NULL,
  severity TEXT NOT NULL,
  evidence_class TEXT NOT NULL,
  refuter_verdict TEXT NOT NULL,
  causal_disposition TEXT NOT NULL,
  claim TEXT NOT NULL,
  proof_refs_json TEXT NOT NULL,
  hunter TEXT NOT NULL,
  hops_used INTEGER NOT NULL,
  hop_trail_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  root_cause_id TEXT NULL,
  debug_order INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_debug_findings_run_id ON debug_findings (run_id);

-- Run agent telemetry
CREATE TABLE IF NOT EXISTS run_agents (
  run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  agent_key TEXT NOT NULL,
  tokens_total INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost_usd_est REAL NOT NULL,
  attempts INTEGER NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (run_id, agent_key)
);

-- Comparison rows (H2H)
CREATE TABLE IF NOT EXISTS comparison_rows (
  run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  bucket TEXT NOT NULL,
  greptile_json TEXT NULL,
  prhero_json TEXT NULL,
  verdict TEXT NULL,
  reasoning TEXT NULL,
  actor TEXT NULL,
  PRIMARY KEY (run_id, row_index)
);
```

---

## 3. Slice 1 Scope & Interfaces

Slice 1 builds the complete, self-contained core data layer:
1. **Schema & Migration Runner**:
   - `openProductStore(dbPath)` with WAL, `busy_timeout = 5000`, and `PRAGMA user_version` migrations.
2. **Pure Projection (`src/store/store-preflight.ts`)**:
   - `projectCompleteRun(input)`: Takes `FindingsDocument`, `perAgent`, `StoredComparison`, `repoId`, `runDir`, `checkoutPath`, `generatedAt` and produces strongly-typed rows for all tables.
3. **Database Repository (`src/store/store.ts`)**:
   - `saveRunTransaction(db, projectedRun)`: Atomic single-transaction upsert.
   - `getRunById(db, runId)` / `getRunByDir(db, runDir)`.
   - `exportFindingsDocument(db, runId)`: Reconstructs a full `FindingsDocument` from SQLite rows.
   - `exportComparison(db, runId)`: Reconstructs `StoredComparison` from SQLite rows.
4. **Offline Test Suite (`test/store.test.ts`)**:
   - 100% offline, in-memory / temp SQLite database.
   - Asserts idempotency (double insert of same run).
   - Asserts cascade deletes.
   - Asserts exact deterministic round-trip: `doc -> project -> save -> export -> validateFindingsDocument(exported)` matches original `doc`.

---

## 4. Vertical Slices Breakdown

* **Slice 1 (This Slice):** Core Data Layer, Schema DDL, Repository CRUD, Deterministic Export Round-Trip.
* **Slice 2:** Local Query Server (Unix Socket HTTP server) & Typed Client.
* **Slice 3:** Review Driver Write Cutover (`POST /v1/runs` is success boundary) & Derived File Generation.
* **Slice 4:** Historical Backfill, `metrics.db` migration, & CLI Read Cutover (`pr-hero usage`, `ledger`).

---

## 5. Slice 1 Test Obligations

- [x] **O-1:** `openProductStore` creates tables, sets WAL, sets busy timeout, sets `user_version = 1`.
- [x] **O-2:** `projectCompleteRun` correctly extracts all fields from a complete `FindingsDocument` including telemetry, summary, debug findings, and root causes.
- [x] **O-3:** `saveRunTransaction` inserts all parent and child rows in one transaction.
- [x] **O-4:** Idempotency: Re-inserting the same `run_dir` updates parent and replaces children without duplicating child rows.
- [x] **O-5:** Round-trip fidelity: `exportFindingsDocument` matches the original `FindingsDocument` byte-for-byte in structure and passes `validateFindingsDocument`.
- [x] **O-6:** Comparison round-trip: `exportComparison` correctly recovers `StoredComparison`.
- [x] **O-7:** Cascade delete: Deleting a run row removes all associated findings, proof_refs, hop_trails, debug_findings, agent telemetry, and comparison rows.
