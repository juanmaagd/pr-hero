# Specification: Lifecycle Operations (Upgrade & Uninstall)

## Requirements

1. **Upgrader (`pr-hero upgrade`) — detection and Phase A (runs in the current process):**
   - MUST detect the installation method from the running binary (`process.execPath`):
     - Standalone iff the executable's real path is under `~/.prhero/bin/`.
     - Development source checkout iff `resolveVersion()` reports `dev`.
     - Global package manager (`npm` / `bun`) otherwise (a global package tree).
   - MUST operate only on the installation that is running. When other installations are detected (e.g. a standalone binary exists while the npm copy is running), it MUST warn about the shadow install and touch nothing else.
   - MUST query the GitHub Releases API using the canonical repo constant (`juanmaagd/pr-hero`, matching `README.md` and `install.sh`, pinned by a test).
   - For standalone binary installations, it MUST:
     - Download `pr-hero-<target>` matching the current platform and architecture to a sibling temp file of the target (e.g. `~/.prhero/bin/.pr-hero.download-<pid>`), so `renameSync` stays atomic on one filesystem (a cross-filesystem rename fails with `EXDEV`; `/tmp` is commonly a different filesystem).
     - Verify the SHA256 checksum against `SHA256SUMS`.
     - `chmod +x` the downloaded file.
     - Preserve the previous binary as `pr-hero.bak`.
     - Replace `~/.prhero/bin/pr-hero` atomically via `renameSync`.
   - For npm/bun installations, it MUST run `npm install -g pr-hero@latest` / `bun add -g pr-hero@latest`, then re-exec the new binary for reconciliation.
   - For a development source checkout, it MUST be an informative no-op: print git-pull guidance and exit 0.
   - There is no `update` alias; `upgrade` is the only spelling of the verb.

2. **Upgrader — Phase B (post-upgrade reconciliation, runs in the new binary):**
   - Reconciliation MUST run in the new binary via re-exec (an internal `pr-hero upgrade --reconcile` step), on the npm/bun path too. Rationale: reconciliation executed by the old process would run old code against the new binary's expectations.
   - Reconciliation MUST:
     - Resynchronize bundled skills (`syncSkills({ force: true })`).
     - Verify MCP server registrations in detected agent environments.
     - Open the canonical store once; migrations auto-run on open via `PRAGMA user_version` (no separate migration runner exists).
     - On macOS only, and only if their plists are installed, reload the `launchd` daemons (`watch` / `gc`); on other platforms this step is skipped with a notice.
     - Run a quick `runDoctor` pass to assert system health.
   - MUST support `--yes` (skip confirmation) and `--dry-run` (preview without mutation) across both phases.

3. **Transactional safety:**
   - The previous binary MUST be preserved as `pr-hero.bak` until reconciliation succeeds, then removed.
   - If the re-exec of the new binary fails to start, the upgrader MUST restore `.bak` automatically.
   - Reconcile-step failures MUST NOT roll back the binary: the steps are idempotent — print the failing step and instruct re-running `pr-hero upgrade --reconcile`.
   - A later `upgrade` run MUST detect leftover `.bak`/incomplete state and resume or clean it idempotently.
   - Reconciliation completion MUST be recorded: the reconciled version is stored in `upgrade-check.json`. `doctor` SHOULD flag a version/reconciled mismatch as "reconciliation pending — run pr-hero upgrade --reconcile".

4. **Upgrade check & cache (`pr-hero upgrade --check`):**
   - MUST produce a read-only current-vs-latest report without mutating the installation.
   - MUST always perform a fresh Releases query and rewrite the cache at `~/.prhero/upgrade-check.json` (a new `PrheroLayout` field, `upgradeCheckPath`).
   - The 24h TTL governs only passive refresh: a plain `pr-hero upgrade` run refreshes the cache opportunistically when it is older than 24 hours.
   - The menu's Lifecycle label MUST read only the cache and render instantly (`up to date` / `vX.Y.Z available` / `unknown`); the menu MUST NOT query the network and MUST work offline.

5. **Uninstaller (`pr-hero uninstall`):**
   - MUST be structured as a pure plan generator plus a side-effect runner, split into program removal (the default) and data removal (`--purge`).
   - The default uninstall MUST remove the program:
     - On macOS, unload and remove both `launchd` plists: `io.prhero.watch` and `io.prhero.gc`. On other platforms these steps MUST be skipped with a notice (cron guidance for the watcher, matching the existing `watchInstall` error message).
     - Unregister the `pr-hero` MCP server and remove installed skills via new inverse functions in `agent-env.ts`, driven by the skills digest — never a hardcoded skill name list. Skills removal MUST be digest-verified per file: remove only files whose content hash matches the recorded digest; a user-modified file is left in place with a notice. Rationale: bundled skills are product-owned, but destruction of modified files is never acceptable from an uninstaller.
     - Remove the PATH lines containing `.prhero/bin` that `install.sh` wrote into `~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, and the fish config, using exact-line matching; on any failure it MUST print the manual removal instruction instead of failing the uninstall.
     - When the install method is npm/bun, offer — and on confirmation execute — `npm rm -g pr-hero` / `bun remove -g pr-hero`.
     - When the running install is standalone, remove the binary and `~/.prhero/bin/`.
   - If `--purge` is provided or confirmed interactively, it MUST additionally delete the data: `prhero.db`, the metrics db, the store socket, `watch.json`, `config.json`, `setup.json`, `upgrade-check.json`, the `active_runs/` registry, logs, and the repos dir — i.e., the remainder of `~/.prhero/`.
   - Before purging, it MUST check both the `active_runs` registry (live entries after stale pruning — covers local reviews) and `lockHolder` (the watcher tick): either being live produces a warning and requires explicit confirmation.
   - If executed inside a repository, it MUST prompt to remove `.prhero/`. The prompt MUST state that the directory is team property under version control; the default answer is No, and it MUST never be removed non-interactively (`--yes` does not imply it).
   - Interactive uninstall MUST show the plan by default before confirming: the dry-run plan is the confirmation screen. `--dry-run` prints the plan only.
   - MUST support `--yes` and `--dry-run`.

## Scenarios

### Scenario: Dry-run upgrade of standalone binary
- **GIVEN** pr-hero is running from `~/.prhero/bin/pr-hero`
- **WHEN** the user runs `pr-hero upgrade --dry-run`
- **THEN** it checks the GitHub Releases API on the canonical repo constant for the latest version
- **AND** prints the upgrade and reconciliation plan without downloading or mutating any files
- **AND** exits with code 0.

### Scenario: Reconciliation runs in the new binary
- **GIVEN** a standalone upgrade has atomically replaced `~/.prhero/bin/pr-hero`, preserving `pr-hero.bak`
- **WHEN** post-upgrade reconciliation starts
- **THEN** the upgrader re-execs the new binary with the internal `--reconcile` step
- **AND** the new binary resyncs skills, verifies MCP registrations, opens the store (running pending migrations), reloads launchd daemons on macOS when installed, and runs a quick doctor pass
- **AND** `pr-hero.bak` is removed and the reconciled version recorded only after reconciliation succeeds.

### Scenario: Failed re-exec restores the previous binary
- **GIVEN** the newly installed binary fails to start when re-exec'd
- **WHEN** the upgrader detects the failure
- **THEN** it restores `pr-hero.bak` over `~/.prhero/bin/pr-hero` automatically
- **AND** reports the failure without leaving a broken install.

### Scenario: Shadow install warning
- **GIVEN** the npm-installed copy is the running binary and a standalone binary also exists under `~/.prhero/bin/`
- **WHEN** the user runs `pr-hero upgrade`
- **THEN** only the npm installation is upgraded
- **AND** a warning names the shadow standalone binary and leaves it untouched.

### Scenario: Uninstall on Linux skips launchd
- **GIVEN** pr-hero is installed on a Linux machine
- **WHEN** the user runs `pr-hero uninstall`
- **THEN** the launchd unload/remove steps are skipped with a notice
- **AND** the notice includes cron guidance for the watcher.

### Scenario: Purge with a live review or watcher tick
- **GIVEN** a live entry in `~/.prhero/active_runs/` (after stale pruning) or a live `lockHolder` PID
- **WHEN** the user runs `pr-hero uninstall --purge`
- **THEN** it warns that a review or watch tick is running
- **AND** requires explicit confirmation before purging.

### Scenario: Uninstallation with purge
- **GIVEN** pr-hero is installed with active launchd services and MCP registered
- **WHEN** the user runs `pr-hero uninstall --yes --purge`
- **THEN** it unloads both launchd agents (`io.prhero.watch` and `io.prhero.gc`)
- **AND** removes MCP registrations, and removes only skill files whose hashes match the recorded digest (leaving modified files with a notice)
- **AND** removes the `.prhero/bin` PATH lines from `~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, and the fish config (printing the manual instruction on any failure)
- **AND** removes the program and the data under `~/.prhero/`
- **AND** leaves any in-repo `.prhero/` in place (`--yes` never removes team property)
- **AND** prints a clean uninstallation summary.
