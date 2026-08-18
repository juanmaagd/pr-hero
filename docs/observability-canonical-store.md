# Proposal and Design: Unified Product Store and Local Query Server

This document proposes the full data-layer refactor: replace the metrics-only database with one product-level canonical store, move all database access behind a small local server with typed routes, and expose the same boundary to the CLI, dashboard, and read-only MCP agent. This is a design and proposal, not the implementation plan.

## Decision Summary

| Area | Decision |
|---|---|
| Canonical source | One global product database under `~/.prhero/prhero.db` |
| Database name | `prhero.db`; `metrics.db` is a misleading W4-era name |
| Full findings | Persist every finding, evidence reference, hop trail, and debug record in SQLite |
| JSON artifacts | Derived exports generated from SQLite; never an independent source of truth |
| Database boundary | Only the local store server opens SQLite in normal operation |
| Human access | CLI and dashboard call the local server's typed routes |
| Agent access | A read-only MCP agent calls the same query boundary |
| Transport | Local-only server; prefer a Unix socket, with localhost TCP as an explicit alternative |
| SQL access | No arbitrary SQL from callers or models; only parameterized domain queries |
| Persistence failure | A review is not complete until the canonical database transaction commits |
| Garbage collection | May remove worktrees and derived exports, but never database rows |

## Problem

The current W4 observability store is useful but incomplete:

```text
findings.json = complete artifact and current source of truth
SQLite        = run metrics, agent usage, counts, and comparison projection
```

This creates two representations with different authority. SQLite cannot currently answer detailed questions about finding evidence, refuter decisions, causal disposition, or hop trails. The system also uses fail-soft ingestion, so a future SQLite failure could leave a successful review represented only by JSON.

The target architecture must make the authority explicit and prevent data drift.

## Target Architecture

```text
                    +------------------------+
                    | Canonical product DB   |
                    | ~/.prhero/prhero.db    |
                    | runs + findings        |
                    | evidence + usage       |
                    +-----------+------------+
                                |
                    +-----------v------------+
                    | Store / domain service |
                    | schema, transactions,  |
                    | projections, queries   |
                    +-----------+------------+
                                |
                    +-----------v------------+
                    | Local query server    |
                    | typed routes, auth,   |
                    | limits, health        |
                    +-----+------------+-----+
                          |            |
               +----------v--+     +--v------------+
               | CLI / usage |     | MCP read-only |
               | dashboard   |     | query agent   |
               +-------------+     +---------------+

Database -> JSON/report export (derived, optional)
```

The local server is the persistence boundary. Normal callers do not open SQLite, construct SQL, or duplicate query rules. The MCP agent is an adapter, not a second store and not a database owner. All consumers must use the same route and domain contracts so the CLI, dashboard, and agent cannot disagree about filtering, identity, pagination, or field visibility.

## Data Model

### `runs`

One row per completed review:

- stable run identity and `run_dir`
- canonical `repo_id` and nullable PR number
- checkout path as diagnostic metadata only
- base and head SHAs
- run status and session failure state
- model and timestamps
- wall time and index time
- input, output, and total tokens
- estimated cost

### `findings`

One row per finding, including the complete finding contract:

- finding ID and run ID
- category, path, line, and optional symbol
- severity and tier
- evidence class
- refuter verdict
- causal disposition
- claim and dedupe key
- hunter
- hops used
- optional root-cause ID

The finding row must retain enough information to reconstruct the finding without reading a JSON file.

### `finding_proof_refs`

One row per finding evidence reference:

- finding ID
- stable order
- proof reference text

### `finding_hop_trail`

One row per hop in the investigation trail:

- finding ID
- stable step order
- step number
- hop kind
- query
- reached symbol or location

### `debug_findings`

Separate child tables, or an equivalent typed representation, for refuted and deduplicated findings. These records are part of the run evidence and must not disappear merely because they are excluded from the public `findings` list.

### `run_agents`

One row per agent execution:

- agent key
- tokens and duration
- cost
- attempt count
- status

### `comparison_rows`

One row per Greptile/pr-hero comparison entry:

- bucket
- referenced Greptile and pr-hero claims
- verdict, reasoning, and actor

Comparison data remains relational and queryable. It must not be the only place where a partial finding representation exists.

## Write Contract

The pipeline produces an in-memory completed run result. The review driver sends that result to the local store server. The server validates the request and persists the complete result in one SQLite transaction:

```text
run result in memory
        |
        v
POST /v1/runs (local server)
        |
        v
BEGIN TRANSACTION
  insert or update runs
  insert findings
  insert proof references
  insert hop trails
  insert debug findings
  insert agent usage
  insert comparison rows
COMMIT
        |
        v
generate derived findings.json/report/comparison exports
```

The database commit is the completion boundary. If the transaction fails, the review must not be reported as successfully persisted. A retry mechanism may exist operationally, but it is a delivery mechanism, not another source of truth.

This replaces the current direct `failSoftIngest` contract. A warning-only path is incompatible with a database that is declared canonical. The server owns the transaction and returns success only after the commit completes.

## JSON and Report Contract

JSON remains useful for:

- portable exports;
- human inspection;
- debugging;
- compatibility with existing tooling;
- attaching a compact artifact to a run or PR.

However, JSON becomes a derived representation:

```text
SQLite -> serializeFindingsDocument() -> findings.json
SQLite -> renderReport()             -> report.md
SQLite -> serializeComparison()      -> comparison.json
```

The application must never read a derived JSON export to answer a canonical query when the same data exists in SQLite. If an export is deleted, it must be regenerable from the database.

## Local Query Server

The server is intentionally small, local-first, and route-oriented. It is not a remote application tier and it must not become a second business-logic layer.

### Responsibilities

The server owns:

- opening and closing the canonical database;
- schema migrations and version checks;
- write transactions and idempotency;
- request validation and bounded payloads;
- repository scoping and field-level redaction;
- typed success and error responses;
- health and readiness checks;
- graceful shutdown and lock/lifecycle handling.

The server does not own review orchestration, model selection, GitHub posting, or garbage-collection policy.

### Route shape

The initial route surface should remain small and domain-oriented:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Process, schema, and database readiness |
| `GET` | `/v1/runs` | List runs with scope, filters, and pagination |
| `GET` | `/v1/runs/:id` | Retrieve a run and its summary |
| `POST` | `/v1/runs` | Persist a complete run transactionally |
| `GET` | `/v1/findings` | Search findings with bounded filters |
| `GET` | `/v1/findings/:id` | Retrieve a finding with evidence and trail |
| `GET` | `/v1/usage` | Aggregate tokens, costs, durations, and counts |
| `GET` | `/v1/comparisons` | Query comparison and triage rows |

Routes are a transport contract over the domain service, not a place for SQL strings or duplicated projections.

### Local transport

The default should be local-only. A Unix domain socket is preferred because it avoids port collisions and naturally limits access to users with filesystem permission. Localhost TCP is an acceptable alternative when browser tooling or debugging needs it, but it requires explicit port ownership, lifecycle handling, and local authentication/authorization.

The server must never bind publicly by default.

### Client behavior

- The CLI uses a typed local client instead of opening SQLite directly.
- The dashboard uses the same routes.
- The MCP agent uses the same route contract and does not bypass the server.
- Database migrations and recovery commands are privileged maintenance paths, not ordinary client behavior.

## Query Service

The store/domain service sits below the local server and exposes domain operations rather than SQL:

| Operation | Purpose |
|---|---|
| `listRuns` | Paginated runs, scoped by canonical repository identity |
| `getRun` | Full run metadata and summary |
| `searchFindings` | Filter by repository, PR, path, tier, severity, verdict, or date |
| `getFinding` | Full finding, proof references, hop trail, and run context |
| `compareRuns` | Compare findings, cost, and outcomes across runs |
| `usageSummary` | Aggregate tokens, cost, durations, and finding counts |
| `health` | Schema version, database reachability, and migration state |

Every operation must enforce:

- canonical repository scoping by default;
- explicit `--all` or equivalent for operator-wide queries;
- pagination and bounded result sizes;
- deterministic ordering;
- parameterized values;
- field-level redaction for sensitive diagnostic paths where needed;
- no arbitrary SQL input.

## MCP Agent

The MCP agent is a thin read-only adapter over the local server's route contract:

```text
MCP tool call -> validate input -> local route -> domain query service -> SQLite -> typed result
```

Initial tools should map one-to-one to the query operations above. The agent must not:

- write or delete database rows;
- run arbitrary SQL;
- infer repository identity from an unsafe filesystem path;
- bypass pagination or scope limits;
- expose credentials or unnecessary local paths.

The MCP process may use stdio for its model-facing transport, but its data access must go through the local server. This keeps the MCP surface replaceable without creating a second database client or query implementation.

## Garbage Collection Interaction

GC owns disposable worktree storage. It must not own or enumerate the canonical database as review data.

Rules:

1. Removing a worktree must not remove `runs`, `findings`, or child rows.
2. Removing a derived JSON export must not remove canonical data.
3. The database must remain queryable after worktree collection.
4. Any database retention policy must be explicit and separate from worktree GC.

## Migration Design

### Schema

Introduce a new schema version with additive tables and foreign keys. Existing run-level rows remain valid. New full-finding tables are populated for every new review.

The product-level database is renamed from `~/.prhero/metrics.db` to `~/.prhero/prhero.db`. The migration must:

- acquire an exclusive maintenance lock;
- verify the old database before moving it;
- create a backup before replacement;
- migrate schema and data before serving requests;
- preserve an explicit rollback path;
- avoid running two independent writable databases after cutover.

### Existing artifacts and mandatory backfill

Backfill is part of this refactor, not an optional future enhancement. The migration must import valid historical `findings.json` artifacts into the canonical database, including artifacts created before W4's original no-backfill decision.

The backfill source is the run artifact tree, not reports or directory names alone:

```text
~/.prhero/repos/<repo_id>/runs/<run_dir>/findings.json
                                      ├── comparison.json (when present)
                                      └── pipeline.json    (when present)
```

For every candidate run, the migrator must:

1. discover the artifact through the registered canonical repository;
2. validate `findings.json` against the findings schema;
3. derive the complete run, finding, evidence, hop-trail, debug, usage, and comparison rows;
4. reconcile the artifact identity with `run_dir`, repository, PR, and SHAs;
5. insert or enrich the canonical database in one transaction;
6. record an explicit imported, skipped, or conflicted result.

The current machine gives the migration concrete cases to handle:

- 18 runs already exist in the current SQLite store and must be enriched with full finding rows;
- two valid JSON runs predate SQLite ingestion and must be inserted by backfill;
- one incomplete run has no valid findings/comparison/pipeline artifacts and must be reported as skipped, not silently invented.

Backfill is idempotent. Re-running it must not duplicate runs, findings, child rows, or comparison entries. Existing run-level metrics must be preserved when the database already contains them; the JSON artifact supplies the missing canonical finding data.

If an artifact has no trustworthy original timestamp, the migrator must record the fallback source (for example, file mtime) rather than presenting the migration time as the review time. The migration report must include counts and paths for imported, already-present, skipped, and conflicted artifacts.

### Compatibility

During migration, exports may preserve the existing `findings.json` schema. Consumers should move to the query service rather than reading files directly. Once migration is complete, JSON generation should be tested as a deterministic round-trip from SQLite.

### Conceptual transition

The design moves through these boundaries, while the implementation plan remains intentionally deferred:

1. The store becomes capable of representing complete runs and findings.
2. The current database is backed up and migrated/renamed to the product-level database.
3. The mandatory artifact backfill imports and reconciles all valid historical JSON runs.
4. The local server becomes the only normal database owner.
5. Review persistence moves behind the server's transactional write route.
6. CLI and dashboard reads move behind the server's query routes.
7. JSON and report files become regenerable exports.
8. The MCP agent consumes the same route contract.

The migration must not leave a period where two databases are both treated as authoritative.

## Verification Criteria

- [ ] A completed review cannot be marked persisted before the SQLite transaction commits.
- [ ] Every public finding can be reconstructed from SQLite without reading JSON.
- [ ] Proof references and hop trails survive JSON export deletion.
- [ ] Re-ingesting the same run is idempotent.
- [ ] Exporting SQLite to JSON twice produces identical bytes for the same database state.
- [ ] Deleting a worktree leaves all canonical rows queryable.
- [ ] CLI, dashboard, and MCP return the same result for the same query.
- [ ] No normal production client imports `bun:sqlite` or opens the database directly.
- [ ] The server refuses requests until schema migration and readiness checks pass.
- [ ] MCP rejects arbitrary SQL, unbounded queries, and writes.
- [ ] Migration reports every artifact it imported or skipped.
- [ ] Backfill imports every valid historical findings artifact, including pre-W4 runs.
- [ ] Backfill is idempotent and produces no duplicate parent or child rows.
- [ ] Existing SQLite run metrics are preserved while missing full finding data is added.
- [ ] Incomplete or invalid artifacts are reported with explicit reasons and never silently ignored.
- [ ] A failed transaction leaves no partial run visible.

## Deliberately Out of Scope

- Live review execution changes.
- A web dashboard implementation.
- Multi-model orchestration.
- Remote database hosting.
- Detailed implementation sequencing, ownership, and task decomposition.

## Current Implementation Baseline

The current code is the starting point, not the target:

- `src/metrics.ts` currently opens `metrics.db`, migrates schema v1, and ingests run-level metrics, agent usage, and comparisons directly.
- `src/metrics-preflight.ts` defines the current projection and schema.
- `src/cli.ts` currently writes JSON artifacts and then calls metrics ingestion directly in local and PR modes.
- `src/findings.ts` defines the complete finding document that must become representable in SQLite.
- `src/gc.ts` removes disposable worktrees and must remain independent from canonical review data.

The key architectural changes are boundaries: **SQLite becomes canonical; JSON becomes derived; the local server becomes the only normal database owner.**
