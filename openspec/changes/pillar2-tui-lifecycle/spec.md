# Specification: Pillar 2 — Interactive TUI & Lifecycle Operations

## 1. TUI Menu & Context Resolution

### 1.1 Requirements
- When `pr-hero` is invoked with 0 arguments in an interactive TTY (and the machine is onboarded), it **MUST** display the root interactive TUI menu, provided stderr is also a TTY; if stderr is not a TTY it **MUST** print help and exit 2 (a menu on a redirected stderr would be an invisible keyboard trap).
- The CLI **MUST NOT** implicitly run `review` on a zero-argument invocation; the previous implicit default is removed and **MUST** be documented in `README.md` and the CLI help.
- When invoked in a non-TTY (stdin) without arguments, it **MUST** print help text and exit with code 2 (unchanged).
- When invoked with 0 arguments in a TTY on a machine that is not onboarded, it **MUST** run the wizard (unchanged; the wizard is non-interactive and is gated on stdin only).
- When `PRHERO_NO_TUI` is set (any value, including the empty string), a zero-argument invocation in a TTY **MUST** print help and exit 0; neither the wizard nor the menu opens.
- `pr-hero menu` **MUST** open the root menu; it **MUST** require the TTY pair (stdin and stderr both TTYs), otherwise it **MUST** error with help text and exit 2.
- When the terminal is narrower than 24 columns, the TUI **MUST** refuse to start ("terminal too narrow", help text, exit 2); `box()` in `src/ui.ts` clamps at its `MIN_BOX_WIDTH` floor of 24.
- The menu **MUST** render to stderr via the existing `log()` channel (stdout stays pipeable), style via `styleEnabled(process.stderr)` (honoring `NO_COLOR`), and size via `terminalWidth()`.
- The CLI **MUST** determine `RepoContext` (`not-a-repo`, `unconfigured-repo`, or `configured-repo`).
- Actions requiring a configured repo (`Review`, `Ledger`) **MUST NOT** appear in the menu outside of one; every rendered item **MUST** dispatch, per the dispatch matrix, to a command that runs in that context.
- `pr-hero doctor`, `pr-hero config`, and `pr-hero setup` **MUST** become repo-optional (system checks only / global layers only / machine-level steps only, respectively) so the matrix holds outside a repository; today all three throw via `resolveRepoRoot` in `src/cli.ts`.
- The Watcher item **MUST** open the watcher submenu (`watch status`/`install`/`uninstall`/`remove` in every context; `watch add` and the on-push toggle in-repo only); bare `pr-hero watch` **MUST NOT** be dispatched.
- A `Lifecycle` submenu **MUST** group `Upgrade & sync`, `Sync skills & MCP registrations` (which dispatches the existing `setup` verb), and `Managed uninstall`; the cached upgrade state **MUST** surface on the group label.
- If context is `unconfigured-repo`, the first menu option **MUST** be `Initialize pr-hero in this repo`.
- Header **MUST** render solid block ASCII font for `PR-HERO` at width >= 60 and **MUST** fall back to a plain one-line title for 24 <= width < 60; no output may overflow horizontally at width >= 24.
- Menu cards **MUST** be drawn with double-border box characters via the extended `box()` border-style option (`"round" | "double"`, default `"round"`).
- Menu items **MUST** display dynamic status badges (e.g., `Active & recent reviews (● 1 running)`, `Watcher & background daemons (3 enrolled)`, `Lifecycle (up to date)`) derived from local reads only.
- Every TUI screen's footer **MUST** show the key hints and the headless CLI equivalent of the currently selected item (derived from the dispatch matrix); items that open a submenu show the submenu hint instead.
- Externally-sourced strings rendered into the TUI (repo names, branches, paths, PR titles) **MUST** pass through the control-byte sanitizer in `src/ui.ts` (strip `0x00-0x1F`, `0x7F`, ESC sequences).
- All renderers **MUST** receive `styles: boolean` and `width: number` as parameters and return `string[]`.
- Navigation **MUST** support `j`/`k` and `↑`/`↓` (wrapping); digits `1-9` **MUST** select without executing; `Enter` **MUST** be the only execute key; `q`/`Esc` **MUST** exit 0 at the root and mean "back" inside sub-surfaces; `Ctrl-C` **MUST** exit 130 everywhere; raw mode **MUST** always be restored.
- The input loop **MUST** reuse `splitKeys`/`parseKey` and the `KeyReader` + injected-io pattern from `src/ui-select.ts`, and `parseKey` **MUST** be extended to distinguish `Esc` from `Ctrl-C` (today both collapse into one cancel key); existing consumers keep treating both as cancel.
- Exactly one live raw-mode reader **MUST** exist at any time: the root closes its reader before dispatching, sub-surfaces own theirs, the root re-creates and re-renders on return, and every surface closes its reader in `finally`.
- Actions marked Returns in the dispatch matrix **MUST** come back to the root menu after a "press any key" pause; Terminal actions (review once the spend confirm accepts, upgrade once applying, uninstall, quit) **MUST** follow the command's normal exit path.
- The `SIGWINCH` listener **MUST** be registered when the root loop starts, removed in the same `finally` that closes the reader, and on `SIGWINCH` the menu **MUST** re-render with a fresh `terminalWidth()`.
- The review submenu **MUST** collect launch configuration only (target: branch or PR; toggles: post — only when the target is a PR —, scout, force, summary on/off, model) and hand off to the existing review flow (size gate, then the cost-band confirm), which remains the single spend gate.

### 1.2 Scenarios
- **GIVEN** cwd is not a git repo, **WHEN** user runs `pr-hero` in TTY, **THEN** context shows Global and `Review` is omitted.
- **GIVEN** cwd is a configured repo, **WHEN** user runs `pr-hero` in TTY, **THEN** `Start Review` is the first option.
- **GIVEN** an onboarded machine, **WHEN** user runs `pr-hero` with zero arguments in a TTY, **THEN** the menu is shown and no review starts implicitly.
- **GIVEN** stderr is redirected to a file, **WHEN** user runs `pr-hero` or `pr-hero menu` with stdin a TTY, **THEN** help is printed and the process exits 2.
- **GIVEN** the menu is open, **WHEN** the user presses `Ctrl-C`, **THEN** the process exits 130 with the terminal restored.
- **GIVEN** a terminal between 24 and 59 columns, **WHEN** the menu renders, **THEN** the plain one-line title is used and nothing overflows.
- **GIVEN** a terminal narrower than 24 columns, **WHEN** the user opens the menu, **THEN** it refuses with "terminal too narrow", prints help, and exits 2.
- **GIVEN** `PRHERO_NO_TUI` is set, **WHEN** user runs `pr-hero` with zero arguments in a TTY, **THEN** help is printed and the process exits 0.

## 2. Activity & Active Runs Monitor

### 2.1 Requirements
- The CLI **MUST** track currently executing reviews locally via ephemeral state (`~/.prhero/active_runs/<pid>.json`).
- When a review starts, the review shell **MUST** register `{ pid, repo, pr?, runDir, startedAt }` and remove the record on exit.
- The review driver **MUST** install a SIGTERM handler that tears down its own live agent subprocesses (it already holds a `StepHandle` with `kill()` for each, per `src/step-runner.ts`), removes its registry entry, and exits non-zero.
- Dead / orphan PID files **MUST** be pruned automatically upon inspection, using the same liveness probe as `lockHolder` (`kill(pid, 0)`, `EPERM` counts as alive), without reporting phantom runs.
- The kill action **MUST** check identity first — read the target's command line via `ps -o command= -p <pid>` and require a pr-hero review invocation; on mismatch (PID reuse) it **MUST** prune the stale entry and refuse without signalling. On match it **MUST** send SIGTERM to the PID only, and if the process has not exited after 10 seconds it **MUST** escalate to SIGKILL and report honestly that agent subprocesses may survive, with guidance for listing them.
- The interactive kill **MUST** confirm first and **MUST** be triggered by selecting a run and pressing Enter (never a single letter key).
- The Activity Monitor **MUST** display:
  - All currently executing reviews with PID, repository, target, and elapsed time (derived from `startedAt`).
  - Today's watcher spend as launches-used over the daily cap (`countLaunchedToday` over the watch log + `dailyCap` in `watch.json` — existing reads in `src/watch.ts`).
  - Recent review history queried directly from the canonical SQLite product store (`~/.prhero/prhero.db` `runs` table) showing status (`run_status`), findings counts (`blocking`/`advisory`), duration (`wall_ms`), and cost (`cost_usd_est`), capped at the most recent 10 rows.
- The view **MUST** render a sane empty state when the database is absent or has no rows.
- The menu item **MUST** be available in all `RepoContext` states; inside a repository the view **SHOULD** note and allow filtering to the current repository.
- Headless parity: `pr-hero activity` **MUST** print a read-only list of active runs and recent history; `pr-hero activity --kill <pid>` **MUST** be the non-interactive twin of the kill action — `--yes` skips only the confirmation, never the identity check or the escalation contract.

### 2.2 Scenarios
- **GIVEN** a background watcher review is in progress, **WHEN** the user opens the Activity Monitor, **THEN** it displays the running review with live elapsed time.
- **GIVEN** past completed reviews in `prhero.db`, **WHEN** viewing the Activity Monitor, **THEN** the recent runs table renders history (at most 10 rows) from the SQLite store.
- **GIVEN** a registry PID now belonging to another program, **WHEN** the user triggers the kill, **THEN** the stale entry is pruned, no signal is sent, and a refusal message is shown.
- **GIVEN** an identity-matched run that ignores SIGTERM for 10 seconds, **WHEN** the kill escalates, **THEN** SIGKILL is sent and the report warns that agent subprocesses may survive.

## 3. Lifecycle Operations (Upgrade & Uninstall)

### 3.1 Requirements
- `pr-hero upgrade` **MUST** detect the install method from `process.execPath` (standalone iff the real path is under `~/.prhero/bin/`; source checkout iff `resolveVersion()` reports `dev`; npm/bun otherwise); there is no alias. It **MUST** operate only on the running installation and **MUST** warn about detected shadow installs without touching them.
- Phase A **MUST** run in the current process: query the GitHub Releases API on the canonical repo constant (`Gentleman-Programming/pr-hero`, pinned by a test) and, for standalone installs, download `pr-hero-<target>` to a sibling temp file of the target (same filesystem, so `renameSync` stays atomic), verify SHA256 against `SHA256SUMS`, `chmod +x`, preserve the previous binary as `pr-hero.bak`, and replace the binary atomically via `renameSync`.
- Phase B reconciliation **MUST** run in the new binary via re-exec (`pr-hero upgrade --reconcile`), on the npm/bun path too: resync skills (`syncSkills({ force: true })`), verify MCP registrations, open the canonical store once (migrations auto-run on open via `PRAGMA user_version`), reload launchd daemons only on macOS when their plists are installed, and run a quick doctor pass.
- If the re-exec of the new binary fails to start, the upgrader **MUST** restore `.bak` automatically. Reconcile-step failures **MUST NOT** roll back the binary (steps are idempotent): print the failing step and instruct re-running `pr-hero upgrade --reconcile`. A later `upgrade` run **MUST** detect leftover `.bak`/incomplete state and resume or clean idempotently. `.bak` is removed once reconciliation succeeds.
- Reconciliation completion **MUST** be recorded (the reconciled version stored in `upgrade-check.json`); `doctor` **SHOULD** flag a version/reconciled mismatch as "reconciliation pending — run pr-hero upgrade --reconcile".
- For npm/bun installs it **MUST** run `npm install -g pr-hero@latest` / `bun add -g pr-hero@latest`, then re-exec the new binary for reconciliation; for source checkouts it **MUST** be an informative no-op (git-pull guidance, exit 0).
- `pr-hero upgrade --check` **MUST** be a read-only current-vs-latest report that always performs a fresh Releases query and rewrites the cache at `~/.prhero/upgrade-check.json` (`upgradeCheckPath`). The 24h TTL governs only passive refresh (a plain `upgrade` run refreshes opportunistically); the menu **MUST** read only the cache and never query the network.
- `pr-hero uninstall` **MUST** generate a plan (pure) and run it. The default **MUST** remove the program: on macOS unload and remove both launchd plists (`io.prhero.watch`, `io.prhero.gc`) — skipped with a notice on other platforms —, unregister MCP and remove skills via digest-driven inverse functions in `agent-env.ts` (digest-verified per file: only hash-matching files are removed, modified files are left with a notice), remove the `.prhero/bin` PATH lines from `~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, and the fish config (manual instruction printed on any failure), offer the npm/bun global removal when applicable, and — for a running standalone install — remove the binary and `~/.prhero/bin/`.
- `--purge` **MUST** additionally remove the data: `prhero.db`, the metrics db, the store socket, `watch.json`, `config.json`, `setup.json`, `upgrade-check.json`, the `active_runs/` registry, logs, and the repos dir — i.e., the remainder of `~/.prhero/`.
- Before purging, it **MUST** check both the `active_runs` registry (live entries after stale pruning) and `lockHolder` (the watcher tick); either being live produces a warning and requires explicit confirmation.
- Inside a repository it **MUST** prompt to remove `.prhero/`, stating the directory is team property under version control; the default answer is No, and it is never removed non-interactively (`--yes` does not imply it).
- Interactive uninstall **MUST** show the plan before confirming (the dry-run plan is the confirmation screen).
- Both commands **MUST** support `--yes` and `--dry-run`.

### 3.2 Scenarios
- **GIVEN** standalone installation, **WHEN** running `pr-hero upgrade --dry-run`, **THEN** it previews the upgrade and sync plan without mutating files.
- **GIVEN** a completed standalone binary replacement, **WHEN** reconciliation runs, **THEN** it executes in the new binary via re-exec, and `.bak` is removed only after it succeeds.
- **GIVEN** a new binary that fails to re-exec, **WHEN** the upgrader detects the failure, **THEN** it restores `pr-hero.bak` automatically.
- **GIVEN** the npm copy is running while a standalone binary exists, **WHEN** running `pr-hero upgrade`, **THEN** it upgrades only the npm install and warns about the shadow standalone binary.
- **GIVEN** a Linux machine, **WHEN** running `pr-hero uninstall`, **THEN** launchd steps are skipped with a notice.
- **GIVEN** a live entry in `active_runs/` or a live `lockHolder` PID, **WHEN** running `pr-hero uninstall --purge`, **THEN** it warns and requires explicit confirmation.
- **GIVEN** active daemons and MCPs, **WHEN** running `pr-hero uninstall --yes --purge`, **THEN** it unloads both launchd agents, unregisters MCP, removes digest-matching skills, cleans the PATH lines from the four rc files, and removes `~/.prhero/`.

## 4. Interactive Configuration Editor

### 4.1 Requirements
- `pr-hero config --edit` **MUST** support Person (`agents_dir`, `summary.model`, `summary.enabled`, `max_verification_steps`), Team (`default_base`, `parity_trigger_paths`, `suspicion_priors`, `summary.enabled`, `max_verification_steps`), and Watcher (`daily_cap`, `window`, per-repo `post`, `on_push`, `max_changed_lines`, `max_changed_files`) layers.
- Capped Team keys follow C5's `foldKey` semantics: the editor and `config set` **MUST** accept any type-valid value — including above the operator's Person ceiling — and **MUST** then display the effective-value annotation derived from the same merge (the effective value can never exceed the ceiling; enforcement is at merge time, not write time). Write-time validation is types/shape only, through the existing parsers.
- `pr-hero config set <key> <value> [--person|--team|--watch]` **MUST** provide headless parity with the v1 scalar grammar: `summary.enabled` (true/false), `summary.model` (string), `max_verification_steps` (non-negative integer), `agents_dir` (path string), `default_base` (string), `--watch daily_cap <n>` (positive integer), `--watch window <HH:MM-HH:MM>` (parsed to `{start, end}`). Default `--person`; `--team` requires a repository. Arrays/objects (`parity_trigger_paths`, `suspicion_priors`) are interactive-editor-only in v1 (headless path: edit the JSON file); per-repo watcher enrollments keep their existing headless surface in `pr-hero watch add`/`remove`.
- `pr-hero config unset <key> [--person|--team|--watch]` **MUST** remove a key from a layer; unsetting `window` means "always".
- Both surfaces **MUST** reuse `CONFIG_DIRECTION`/`SUMMARY_DIRECTION` and the `mergeConfig` machinery for the effective-value annotation; reimplementing direction logic is forbidden.
- Saved configs **MUST** be formatted with 2-space indented JSON; bare `pr-hero config` **MUST** remain read-only and pipeable, and **MUST** operate on the global layers only outside a repository.

### 4.2 Scenarios
- **GIVEN** valid `config.json`, **WHEN** user toggles `summary.enabled`, **THEN** it validates and saves atomically.
- **GIVEN** a Person-layer ceiling of 3, **WHEN** running `pr-hero config set max_verification_steps 5 --team` inside a repository, **THEN** the value is written and the surface reports "written: 5 — your effective value remains 3, capped by your Person layer".
- **GIVEN** a valid key and value, **WHEN** running `pr-hero config set`, **THEN** the target file is written with 2-space indented JSON.
- **GIVEN** a configured `window`, **WHEN** running `pr-hero config unset window --watch`, **THEN** the key is removed and the watcher window means "always".
