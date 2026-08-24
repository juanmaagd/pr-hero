# Specification: Activity & Active Runs Monitor

## Requirements

1. **Ephemeral Active-Run Registry (`~/.prhero/active_runs/`):**
   - The CLI MUST track currently executing reviews via one JSON file per running review at `~/.prhero/active_runs/<pid>.json`.
   - When a review starts, the review shell MUST register `{ pid, repo, pr?, runDir, startedAt }`; the record MUST be removed on exit.
   - Stale entries (dead PIDs) MUST be cleaned up on read, using the same liveness probe as the existing `lockHolder` in `src/watch.ts` (`kill(pid, 0)`, where `EPERM` counts as alive). Phantom runs MUST NOT be reported.

2. **Driver SIGTERM Handler (named touch on the review shell):**
   - The review driver MUST install a SIGTERM handler that tears down its own live agent subprocesses — it already holds a `StepHandle` with `kill()` for each (`src/step-runner.ts`) —, removes its registry entry, and exits non-zero.
   - Rationale: cooperative shutdown through the driver's own child handles is portable and uses machinery that already exists; it is what makes an external kill complete instead of orphaning paid agent subprocesses.

3. **Activity Monitor View:**
   - MUST display all currently executing reviews with PID, repository, target (PR when present), and elapsed time derived from `startedAt`.
   - MUST display today's watcher spend as launches-used over the daily cap, from `countLaunchedToday` over the watch log and `dailyCap` in `watch.json` — both existing reads in `src/watch.ts`.
   - MUST display recent review history queried read-only from the canonical SQLite product store (`~/.prhero/prhero.db` `runs` table), showing status (`run_status`), findings counts (`blocking`/`advisory`), duration (`wall_ms`), cost (`cost_usd_est`), and timestamp (`generated_at`), capped at the most recent 10 rows (a v1 constant; scrolling is deferred).
   - MUST render a sane empty state when the database is absent or contains no rows.
   - The menu item MUST be available in all `RepoContext` states (the registry and the store are machine-wide). Inside a repository, the view SHOULD note and allow filtering to the current repository.
   - Sub-surface keys: `q`/`Esc` return to the root menu; `Ctrl-C` exits 130; `r` refreshes the screen.
   - Renderers in `src/ui-activity.ts` MUST follow the house rules: styles and width as parameters, `string[]` out, offline tests including one asserting zero `\x1b` bytes with styles off; externally-sourced strings pass through the sanitizer in `src/ui.ts`. The impure half (registry read/write, liveness probing, identity check, signalling, store query, spend read) lives in `src/activity.ts`.

4. **Kill Action (safe, cooperative):**
   - The interactive kill MUST be triggered by selecting a run and pressing Enter — never a single letter key (`k` collides with `k` = move up) — and MUST confirm first (it is destructive).
   - The kill MUST check identity first: read the target's command line via `ps -o command= -p <pid>` and require it to look like a pr-hero review invocation. A mismatch means PID reuse: prune the stale registry entry and refuse with a message — a destructive signal MUST NOT be sent. Rationale: PID liveness alone never authorizes a destructive signal.
   - On identity match, the kill MUST send SIGTERM to the PID only; the driver's SIGTERM handler shuts down its agent subprocesses through its own child handles and cleans up its registry entry.
   - If the process has not exited after a bounded wait of 10 seconds, the kill MUST escalate to SIGKILL and report honestly that agent subprocesses may survive a SIGKILL, printing guidance for listing them.
   - Rationale for the cooperative model: process-group semantics are not portable from this runtime — the watcher spawns reviews via `Bun.spawn` in `src/watch.ts` with no detached/process-group option, so watcher-spawned reviews share the tick's process group and there is no isolated group to signal.

5. **Headless Parity:**
   - `pr-hero activity` MUST print a read-only list of active runs plus recent history.
   - `pr-hero activity --kill <pid>` MUST be the non-interactive twin of the kill action; `--yes` skips only the confirmation — the identity check and the bounded escalation contract are never skipped.

## Scenarios

### Scenario: Watching a running review
- **GIVEN** a background watcher review is in progress
- **WHEN** the user opens the Activity Monitor
- **THEN** it displays the running review with PID, repository, target, and live elapsed time
- **AND** today's watcher spend is shown as launches-used over the daily cap.

### Scenario: History from the store
- **GIVEN** past completed reviews recorded in `prhero.db`
- **WHEN** viewing the Activity Monitor
- **THEN** the recent runs table renders status, blocking/advisory counts, duration, and cost from the SQLite store
- **AND** at most the 10 most recent rows are shown.

### Scenario: Empty state
- **GIVEN** no `prhero.db` (or a `runs` table with no rows) and no active runs
- **WHEN** the user opens the Activity Monitor
- **THEN** it renders an explicit empty state without errors.

### Scenario: Killing an active run cooperatively
- **GIVEN** a running review registered in `~/.prhero/active_runs/` whose `ps` command line is a pr-hero review invocation
- **WHEN** the user selects the run, presses Enter, and confirms
- **THEN** SIGTERM is sent to the PID only
- **AND** the driver's SIGTERM handler tears down its agent subprocesses, removes the registry entry, and exits non-zero.

### Scenario: Identity mismatch refuses to signal
- **GIVEN** a registry entry whose PID now belongs to a different program (PID reuse)
- **WHEN** the user triggers the kill
- **THEN** the stale registry entry is pruned
- **AND** the kill refuses with a message and sends no signal.

### Scenario: Escalation after the bounded wait
- **GIVEN** an identity-matched run that has not exited 10 seconds after SIGTERM
- **WHEN** the kill escalates
- **THEN** SIGKILL is sent
- **AND** the report states honestly that agent subprocesses may survive a SIGKILL, with guidance for listing them.

### Scenario: Stale registry entry
- **GIVEN** a registry file whose PID is no longer alive
- **WHEN** the registry is read
- **THEN** the stale file is pruned
- **AND** no phantom run is displayed.
