# Canonical Store — Judgment Day Ledger (Round 1)

**Target**: `feat/canonical-store` (4 slices / 4 commits @ `a172383`).
**Judges**: Two blind read-only judges (`jd-judge-a`, `jd-judge-b`), identical scope, launched in parallel 2026-08-23.
**Findings**: 20 raw findings → **11 unique** (3 confirmed severe, 3 high-impact).

---

## 1. Confirmed Severe — Both Judges CRITICAL

### JD-1 — `persistCanonicalReview` unhandled exception crashes review after LLM execution
- **Filing**: `JDA-1` (CRITICAL) & `JDB-2` (CRITICAL)
- **Target**: `src/cli.ts:547-575`, `src/cli.ts:1039-1057`, `src/cli.ts:1885-1903`
- **Claim**: Unlike `failSoftIngest`, `persistCanonicalReview` has no error boundary. Transient SQLite errors (`SQLITE_BUSY`, disk-full, permission errors) throw unhandled exceptions, terminating the CLI after spending LLM funds, aborting `report.md` generation and skipping GitHub PR comment posting.
- **Verification**: ✅ Confirmed in `src/cli.ts:1039` and `:1885`.
- **Fix**: Add try/catch error boundary in `persistCanonicalReview` (or caller) that logs a loud warning and returns 0 without crashing the post-review report generation and comment posting pipeline.

### JD-2 — Inconsistent `run_dir` representation (absolute path vs basename) breaks SQLite deduplication
- **Filing**: `JDA-2` (CRITICAL) & `JDB-3` (CRITICAL)
- **Target**: `src/cli.ts:1041, 1887`, `src/backfill.ts:47, 101`, `src/store-preflight.ts:35`, `src/store.ts:72`
- **Claim**: Live CLI reviews pass the full absolute path (`/Users/.../runs/pr-42-1`) while `backfillHistoricalRuns` passes the basename (`pr-42-1`). SQLite's `UNIQUE(run_dir)` treats them as distinct keys, creating duplicate database records when backfilling existing repositories, doubling usage metrics.
- **Verification**: ✅ Confirmed in `src/cli.ts` vs `src/backfill.ts`.
- **Fix**: Canonicalize `run_dir` to `path.basename(runDir)` in `projectCompleteRun` / `persistCanonicalReview`.

---

## 2. High-Impact Corroborated Findings

### JD-3 — `exportComparison` drops `diff_from_sha` in favor of `base_sha`
- **Filing**: `JDB-1` (CRITICAL)
- **Target**: `src/store-preflight.ts:335-378`, `src/store.ts:581-590`
- **Claim**: On PR 3-dot diffs, `diff_from_sha` is the common merge-base commit SHA, which differs from `base_sha`. `projectCompleteRun` and `runs` table omit `diff_from_sha`, causing `exportComparison` to reconstruct `StoredComparison` with `base_sha`, corrupting downstream diffing tools.
- **Verification**: ✅ Confirmed in `src/store.ts:583`.
- **Fix**: Add `diff_from_sha TEXT NULL` to `runs` schema and preserve `comparison.diff_from_sha` on ingest and export.

### JD-4 — Local runs (`pr = 0`) cannot be queried via `GET /v1/runs?pr=0`
- **Filing**: `JDA-3` (WARNING) & `JDB-6` (WARNING)
- **Target**: `src/server.ts:107-110`, `src/server-preflight.ts:167-174`
- **Claim**: Local runs are stored as `pr = NULL` in SQLite. When querying `GET /v1/runs?pr=0`, SQL `AND pr = ?` tests `NULL = 0` which is false, returning 0 rows.
- **Verification**: ✅ Confirmed in `src/server.ts:109`.
- **Fix**: When `query.pr === 0`, generate SQL `AND (pr = 0 OR pr IS NULL)`.

### JD-5 — `persistCanonicalReview` ignores custom `home` parameter
- **Filing**: `JDA-4` (WARNING)
- **Target**: `src/cli.ts:559`, `src/cli.ts:1885-1893`
- **Claim**: `PersistCanonicalReviewInput` lacks `home` property and falls back to `os.homedir()`, mutating real developer database during isolated test executions.
- **Verification**: ✅ Confirmed in `src/cli.ts:559`.
- **Fix**: Add `home?: string` to `PersistCanonicalReviewInput` and pass `home` in `reviewPr()`.

---

## 3. Informational & Optimization Suspects (Non-blocking)
- **JD-6 (JDB-4)**: Migration concurrency check-then-act.
- **JD-7 (JDA-6)**: `GET /v1/runs/:id/comparison` 404 vs 200 semantics.
- **JD-8 (JDA-7 & JDB-10)**: Backfill glob efficiency.
- **JD-9 (JDB-8)**: `search_findings` query optimization.
- **JD-10 (JDB-7)**: `GET /v1/usage` repo scoping fallback.
- **JD-11 (JDA-8 & JDB-11)**: `metrics.db` row migration.
