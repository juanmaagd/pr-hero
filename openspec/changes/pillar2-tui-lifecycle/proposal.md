# Change Proposal: Pillar 2 — Interactive TUI & Lifecycle Operations

**Target:** Distribution Pillar 2 (ROADMAP.md THE LAUNCH LINE)  
**Authors:** Senior Architect & Juanma  
**Date:** 2026-08-24  

## Why

Following the completion of Pillar 1 (unified installation, onboarding wizard, doctor, environment detection, and Apache-2.0 packaging), `pr-hero` requires:
1. **Interactive Entry & Discovery (TUI Menu):** Running `pr-hero` with zero arguments in a TTY should present an intuitive, keyboard-navigable control center. Today it implicitly runs `review`, which silently starts paid work; the menu replaces that default.
2. **Context-Aware Presentation:** Actions requiring a configured repository (`Review`, `Ledger`) must only appear when executed inside a valid repository with `.prhero/`. Outside of a repo, only machine-level / global actions should appear — and every rendered item must dispatch to a command that actually runs in that context.
3. **Live Activity & History:** Currently executing reviews (local or watcher-triggered) should be visible, safely killable, and backed by an instant read-only history of past runs from the canonical SQLite store.
4. **Interactive Configuration Surface:** Modifying settings in Person (`~/.prhero/config.json`), Team (`.prhero/config.json`), and Watcher (`~/.prhero/watch.json`) should be possible directly through an interactive editor — with headless `config set`/`config unset` twins — without manual JSON hand-editing.
5. **Symmetric Lifecycle Operations (`upgrade` and `uninstall`):** As a distributed tool, `pr-hero` must provide clean, transactional upgrading (binary update + skill/MCP sync + store migrations) and teardown (unloading daemons, removing MCPs and skills, optionally purging user state).

## What Changes

1. **Root TUI Menu (`src/ui-menu.ts`):**
   - Solid block ASCII font header (`PR-HERO`) with honest width tiers: full layout at width >= 60, a plain one-line title for 24-59, and a "terminal too narrow" refusal (help + exit 2) below 24 (`box()` clamps at its `MIN_BOX_WIDTH` floor of 24).
   - Double-bordered card layout with `RepoContext` status chips, rendered to stderr via the existing `log()` channel (stdout stays pipeable). The menu requires the TTY pair — stdin and stderr both TTYs — otherwise help + exit 2 (a menu on a redirected stderr would be an invisible keyboard trap).
   - Keyboard navigation: `j/k`, `↑/↓` move (wrapping); `1-9` select without executing; `Enter` is the only execute key; `q/Esc` exit 0 at the root (back, inside sub-surfaces); `Ctrl-C` exit 130 everywhere. Requires extending `parseKey` in `src/ui-select.ts` to distinguish `Esc` from `Ctrl-C` (today both collapse into one cancel key); existing consumers keep treating both as cancel.
   - Exactly one live raw-mode reader at any time: ownership passes by close-then-reopen at dispatch boundaries, every surface closes its reader in `finally`.
   - A persistent footer on every TUI screen shows the key hints plus the headless CLI equivalent of the selected item (e.g. `$ pr-hero doctor`), derived from the dispatch matrix.
   - Every externally-sourced string rendered into the TUI (repo names, branches, paths, PR titles) passes through a control-byte sanitizer in `src/ui.ts`.
   - A new explicit verb `pr-hero menu` opens the same menu (TTY pair required, otherwise help + exit 2).
2. **Removal of the implicit zero-argument `review` default (breaking change):**
   - Bare `pr-hero` (zero arguments, TTY, machine onboarded) opens the root menu; it no longer implicitly runs `review`. Documented in `README.md` and the CLI help.
   - Unchanged paths: non-TTY zero-argument invocations print help and exit 2; a TTY on a not-yet-onboarded machine still runs the wizard.
   - Escape hatch: when `PRHERO_NO_TUI` is set (any value, including empty), a zero-argument invocation in a TTY prints help and exits 0 (automation/accessibility).
3. **Context Resolver & Dispatch Matrix (`src/menu-context.ts`):**
   - Classifies cwd into `not-a-repo`, `unconfigured-repo`, or `configured-repo` and produces the filtered menu options dynamically.
   - A dispatch matrix (in the design docs, asserted by tests) maps every menu item to its headless command, the contexts where it is shown, and whether it returns to the menu or is terminal.
   - Three commands become repo-optional so the matrix holds outside a repository (today all three throw via `resolveRepoRoot` in `src/cli.ts`): `pr-hero doctor` (system checks only), `pr-hero config` (global layers only), `pr-hero setup` (machine-level steps only, repo steps skipped). Small in-scope CLI changes with their own failing-tests-first tasks.
   - The Watcher item opens a watcher submenu (`watch status`/`install`/`uninstall`/`remove` everywhere; `watch add` and the on-push toggle in-repo only); bare `pr-hero watch` is invalid and never dispatched.
4. **Activity Monitor (`src/activity.ts` & `src/ui-activity.ts`):**
   - Ephemeral active-run registry at `~/.prhero/active_runs/<pid>.json` (`{ pid, repo, pr?, runDir, startedAt }`), written by the review shell at launch and removed on exit; stale dead-PID entries pruned on read.
   - Read-only recent history from the `runs` table of `~/.prhero/prhero.db` (status, blocking/advisory findings counts, duration, cost), capped at the most recent 10 rows, with a sane empty state; the screen also shows today's watcher spend (launches used / daily cap, from existing reads in `src/watch.ts`).
   - Safe cooperative kill: the review driver installs a SIGTERM handler that tears down its own agent subprocesses (it already holds `StepHandle.kill()` for each) and removes its registry entry; the kill action verifies the target's identity via `ps` before any signal (PID reuse prunes and refuses), sends SIGTERM to the PID only, and escalates to SIGKILL after 10s with an honest survivor report. Triggered by selecting a run and pressing Enter, always confirmed first.
   - Headless parity: `pr-hero activity` (read-only list) and `pr-hero activity --kill <pid>` (`--yes` skips only the confirmation — never the identity check).
5. **Lifecycle Modules (`src/updater.ts` & `src/uninstaller.ts`):**
   - `pr-hero upgrade`: transactional and two-phase. Detection keys off `process.execPath` (the running binary) and warns about shadow installs without touching them. Phase A (old process) checks GitHub releases on the canonical repo constant, downloads to a sibling temp file (atomic same-filesystem `renameSync`), verifies SHA256, preserves the old binary as `pr-hero.bak`. Phase B (reconciliation — skills resync, MCP verification, store migrations on open, daemon reload on macOS, doctor pass) runs in the new binary via re-exec (`upgrade --reconcile`), on the npm/bun path too; a failed re-exec restores `.bak` automatically, reconcile-step failures are resumed idempotently, and the reconciled version is recorded so `doctor` can flag "reconciliation pending".
   - `pr-hero upgrade --check`: always performs a fresh current-vs-latest query and rewrites the cache at `~/.prhero/upgrade-check.json`; the 24h TTL governs only passive refresh, and the menu reads only the cache (never the network).
   - `pr-hero uninstall`: default removes the program — both launchd agents (`io.prhero.watch`, `io.prhero.gc`) on macOS (skipped with a notice elsewhere), MCP registrations, installed skills via digest-verified per-file inverse functions in `agent-env.ts` (modified files are left with a notice), the `.prhero/bin` PATH lines from the four rc files (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, fish config), and — for a running standalone install — the binary and `~/.prhero/bin/`. `--purge` additionally removes the data (the remainder of `~/.prhero/`), gated by a dual liveness check (`active_runs` registry + `lockHolder`). The in-repo `.prhero/` prompt names the directory team property; default No; never removed non-interactively.
6. **Interactive Config Editor (`src/ui-config-edit.ts`):**
   - `pr-hero config --edit` allows interactive editing across Person, Team, and Watcher layers. Capped Team keys follow C5's `foldKey` semantics: any type-valid value is accepted — including above the operator's Person ceiling — and the surface then displays the effective-value annotation from the same merge ("written: 5 — your effective value remains 3, capped by your Person layer"). The effective value can never exceed the ceiling; enforcement lives at merge time, not write time.
   - Headless parity: `pr-hero config set <key> <value> [--person|--team|--watch]` (v1 scalar grammar) and `pr-hero config unset <key>`; both validate types/shape through the existing parsers and write 2-space-indented JSON. Arrays/objects stay interactive-editor-only in v1 (headless path: edit the JSON directly); per-repo watcher enrollments keep their existing headless surface, `pr-hero watch add`/`remove`.
7. **Review submenu chained into the existing spend gate:**
   - The submenu collects the launch configuration only (target, post, scout, force, summary on/off, model) and hands off to the existing review flow — size gate, then the cost-band confirm, which remains the single spend gate. Once the confirm accepts, the review is terminal for the TUI.
8. **Menu composition:**
   - A "Lifecycle" submenu groups `Upgrade & sync`, `Sync skills & MCP registrations` (dispatches the existing `setup` verb — zero new sync code; kept separate for sync-without-binary-download), and `Managed uninstall`; the upgrade badge surfaces on the group label from the cache only.
   - "Reset / Vacuum review store" is deferred out of scope (`pr-hero gc` already covers run-tree pruning).

## Invariants & Rules

- **Zero new external runtime dependencies:** Pure Node/Bun built-ins and raw-mode readers in `src/ui*.ts`.
- **Strict headless parity:** Every interactive action has an equivalent non-interactive path (`--yes`, `--dry-run`, `--purge`, subcommands) — explicitly including `config set`/`config unset` and `activity --kill`.
- **Total function renderers:** Renderers take styles and width as parameters and return `string[]`; no horizontal overflow at width >= 24.
- **Platform conditionality:** Every launchd-touching step is scoped to macOS; on other platforms it is skipped with a notice (cron guidance for the watcher).
- **Single spend gate:** The cost-band confirm in the existing review flow remains the only place spend is authorized; no menu surface duplicates cost UI.
- **Single keyboard owner:** Exactly one live raw-mode reader at any time; ownership passes by close-then-reopen; every surface closes its reader in `finally`.
- **Executable options only:** Every rendered menu item dispatches, per the dispatch matrix, to a command that runs in that context.
- **Sanitized external strings:** Externally-sourced strings are control-byte-sanitized before rendering.
- **Unified upgrade & sync:** `pr-hero upgrade` bundles binary update with full reconciliation; standalone sync remains available via the existing `setup` verb.

## Rollback & Risk Plan

- All operations support `--dry-run` to preview actions without mutation; interactive uninstall shows the plan as its confirmation screen.
- `upgrade` is transactional: sibling-temp download with SHA256 verification and atomic `renameSync`; the previous binary is kept as `pr-hero.bak` until reconciliation succeeds and is restored automatically if the new binary fails to re-exec; reconcile steps are idempotent and resumable (`upgrade --reconcile`), and a later run cleans leftover state.
- Reconciliation always runs in the new binary via re-exec, so the old process never reconciles state it does not understand; completion is recorded so `doctor` flags a pending reconciliation.
- The upgrader only touches the running installation (`process.execPath`) and warns about shadow installs instead of mutating them.
- `uninstall` splits program from data: the default is reversible by reinstalling; `--purge` is gated by a dual liveness check (`active_runs` + `lockHolder`) with warning and explicit confirmation. Digest verification means a user-modified skill file is never destroyed. rc-file PATH-line cleanup falls back to a printed manual instruction on any failure instead of failing the uninstall. The in-repo `.prhero/` is team property: default No, never removed non-interactively.
- The removal of the implicit zero-argument `review` default is a breaking change: automation keeps the explicit `pr-hero review`, gains `PRHERO_NO_TUI`, and the change is documented in `README.md`.
- Naming the lifecycle verb `upgrade` carries no migration risk: nothing shipped references `update` (zero hits in README, src, test, install.sh).
- Killing a review is cooperative and identity-checked: the driver's SIGTERM handler shuts down its own agent subprocesses via the handles it already owns, a `ps` identity check prevents signalling a reused PID, and the SIGKILL escalation reports honestly that agents may survive it.
