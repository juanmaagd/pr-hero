# Pillar 2 — Interactive TUI & Lifecycle Operations Design

**Document ID:** `docs/pillar2-tui-lifecycle-design.md`  
**Status:** Rev 3 — ratified 2026-08-24, ready for implementation (Phase 1)  
**Target:** Distribution Pillar 2 (ROADMAP.md THE LAUNCH LINE)  
**Authors:** Senior Architect & Juanma  
**Date:** 2026-08-24  

---

## 1. Executive Summary & Core Invariants

Pillar 1 delivered unified installation, global/team configuration foundation (C5), onboarding wizard (`pr-hero init`), and environment detection (`pr-hero doctor`).

**Pillar 2 delivers the complete interactive terminal user interface (TUI) for the happy path and existing knobs, live review activity monitoring, and symmetric lifecycle management (`upgrade` and `uninstall`).**

### Core Invariants & Architectural Rules
1. **Zero External Runtime Dependencies:** Built entirely on Node/Bun built-ins and pure ANSI/raw-mode readers in `src/ui*.ts`. No heavy external TUI dependencies.
2. **Strict Headless vs. Interactive Separation:** Every feature is fully addressable via non-interactive CLI flags and subcommands (`--yes`, `--dry-run`, `--purge`, `config set`/`config unset`, `activity --kill`) for CI and scripts. The TUI launches only for a zero-argument invocation with the interactive TTY pair (stdin and stderr), or via the explicit `pr-hero menu` verb; the `PRHERO_NO_TUI` environment variable suppresses it.
3. **Contextual Menu Rendering:** Evaluates `RepoContext` (`not-a-repo`, `unconfigured-repo`, `configured-repo`) and dynamically renders only valid actions. Actions requiring a configured repo are omitted outside of one, and every rendered item dispatches to a command that actually runs in that context (§3 dispatch matrix).
4. **Unified Upgrade & Sync:** One unified command `pr-hero upgrade` (and the menu's `Lifecycle → Upgrade & sync` action) bundles the binary update with full reconciliation — skills resync (`syncSkills`), MCP registration verification across detected agent environments, store migrations (which auto-run when the store opens), daemon reload on macOS, and a doctor pass. This is implemented by the two-phase upgrader in §4.6: Phase B runs that sync bundle in the new binary. Sync remains available without a binary download through the separate `Sync skills & MCP registrations` entry in the Lifecycle submenu, which dispatches the existing `setup` verb.
5. **Live Process Tracking & SQLite History:** Ephemeral PID tracking for currently executing reviews (`~/.prhero/active_runs/`) combined with instant querying of past completed reviews from the canonical SQLite product store (`~/.prhero/prhero.db`).
6. **Total Function Renderers:** All visual components receive `styles` flag and `width` as parameters and return `string[]`. No terminal sniffing inside renderers; 100% testable offline without a TTY.
7. **Symmetric Lifecycle Operations:** `install` (Pillar 1), `upgrade` (Pillar 2), and `uninstall` (Pillar 2) form an idempotent, closed lifecycle.
8. **Implicit Review Default Removed:** The implicit zero-argument default of running `review` is removed. A bare `pr-hero` (zero arguments, TTY, machine onboarded) opens the root menu instead of implicitly starting a review. This is a breaking change and is documented in `README.md` and the CLI help. Rationale: a zero-argument invocation must never silently start paid work; explicit intent (`pr-hero review`, or Enter on the menu item) is the only way to launch a review.
9. **Platform Conditioning:** Every launchd-touching operation is scoped to macOS. On other platforms those steps are skipped with a notice (cron guidance for the watcher, matching the existing `watchInstall` error message). Rationale: the release ships Linux binaries, so unconditioned launchd requirements would be spec bugs.
10. **Single Spend Gate Preserved:** The review submenu collects launch configuration only. The existing review flow — the size gate followed by the cost-band `confirmReview` — remains the single place where spend is authorized. No menu surface duplicates cost UI. Rationale: two cost surfaces would inevitably drift; one gate means one authoritative authorization point.
11. **Single Keyboard Owner:** Exactly one live raw-mode reader exists at any time. Ownership passes by close-then-reopen at dispatch boundaries: the root menu closes its reader (restoring cooked mode) before dispatching any action or interactive sub-surface, the sub-surface creates and closes its own reader, and the root re-creates its reader and re-renders on return. Every surface closes its reader in a `finally` block. Rationale: two concurrent raw-mode readers race for the same input bytes, and an unclosed reader leaves the terminal in raw mode on any crash path.
12. **Sanitized External Strings:** Every externally-sourced string rendered into the TUI (repository names, branch names, paths, PR titles) passes through a control-byte sanitizer (strip `0x00-0x1F`, `0x7F`, and ESC sequences) — one pure helper in `src/ui.ts` with its own tests. Rationale: a branch name carrying escape sequences must not inject into the terminal.

---

## 2. Visual Layout & Terminal Surface

### 2.1 Solid Block Header & Main Menu Mockup

```text
██████╗ ██████╗       ██╗  ██╗███████╗██████╗  ██████╗ 
██╔══██╗██╔══██╗      ██║  ██║██╔════╝██╔══██╗██╔═══██╗
██████╔╝██████╔╝█████╗███████║█████╗  ██████╔╝██║   ██║
██╔═══╝ ██╔══██╗╚════╝██╔══██║██╔══╝  ██╔══██╗██║   ██║
██║     ██║  ██║      ██║  ██║███████╗██║  ██║╚██████╔╝
╚═╝     ╚═╝  ╚═╝      ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝ 

╔══════════════════════════════════════════════════════════════════════════════╗
║  pr-hero v0.2.0 • Multi-Agent PR Review Engine                               ║
║  Context: 🟢 juanmaagd/pr-hero (branch: main)                                ║
║  MCP: 🟢 Registered (claude) • Store: 🟢 ~/.prhero/prhero.db                 ║
╚══════════════════════════════════════════════════════════════════════════════╝

╔═ Menu ═══════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║  ▸ Start Review (current branch or PR)                                       ║
║    Active & recent reviews (● 1 running)                                     ║
║    Watcher & background daemons (3 enrolled)                                 ║
║    Configure models & spend caps                                             ║
║    Doctor & diagnostics (all healthy)                                        ║
║    Review ledger & triage history                                            ║
║    Lifecycle (up to date)                                                    ║
║    Quit                                                                      ║
║                                                                              ║
║  j/k or ↑/↓: move • 1-9: select • enter: run • q/esc: quit                   ║
║  $ pr-hero review                                                            ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

Notes on the mockup:

- The version string (`v0.2.0`) is illustrative. At runtime it is rendered from `resolveVersion()` in `src/assets.ts` (compile-time `__PRHERO_VERSION__` define, `dev` fallback in source checkouts).
- The repository identity (`juanmaagd/pr-hero`) is rendered from the canonical repo constant (§4.6), never a second hardcoded string.
- The MCP chip says **Registered**, not "Connected": registration in the detected agent environments is what pr-hero verifies; nothing measures a live connection.
- **Lifecycle** groups `Upgrade & sync`, `Sync skills & MCP registrations`, and `Managed uninstall` into one submenu. Its badge surfaces the cached upgrade-check state (`(up to date)` / `(v0.3.0 available)` / `(unknown)`), read from the cache only (§4.6): the menu never blocks on the network and works fully offline.
- The `Active & recent reviews (● 1 running)` badge is derived from the `~/.prhero/active_runs/` registry (§4.5), a cheap local read.
- The second footer line is the persistent CLI-equivalent hint: it shows the headless command of the currently selected item, derived from the dispatch matrix (§3). Items that open a submenu show the submenu hint instead.
- External strings in the mockup (repo name, branch) pass through the sanitizer (invariant 12) before rendering.

### 2.2 Active Reviews & Activity Monitor Screen

```text
╔═ Active Reviews & Activity ══════════════════════════════════════════════════╗
║                                                                              ║
║  ▸ ● RUNNING (PID 84219) · Elapsed: 01m 45s                                  ║
║    Repo:   juanmaagd/pr-hero                                                 ║
║    Target: PR #56 (branch: feat/pillar2-tui)                                 ║
║    Status: Running hunters (3/4 complete)                                    ║
║    Origin: Local watcher (launchd)                                           ║
║                                                                              ║
║  Watcher today: 2/8 launches (daily cap)                                     ║
║  ──────────────────────────────────────────────────────────────────────────  ║
║  Recent Completed Reviews (last 10, from ~/.prhero/prhero.db):               ║
║  ✓ PR #55 · 3 findings (1 blocking) · Duration: 02m 14s · Cost: $0.85        ║
║  ✓ PR #54 · 0 findings (clean)      · Duration: 01m 40s · Cost: $0.52        ║
║                                                                              ║
║  j/k: move • enter: kill selected (confirms) • r: refresh • q/esc: back      ║
║  $ pr-hero activity --kill 84219                                             ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

Notes on the activity mockup:

- The `Status:` and `Origin:` lines are illustrative aspirations. The v1 registry entry carries `{ pid, repo, pr?, runDir, startedAt }` (§4.5), so v1 renders PID, repository, target, run dir, and elapsed time (derived from `startedAt`).
- The history columns map directly onto the `runs` table of the canonical store: findings counts come from `blocking`/`advisory`, duration from `wall_ms`, cost from `cost_usd_est`, status from `run_status`, and the timestamp from `generated_at`. The history view shows the most recent 10 rows (a v1 constant); scrolling is deferred (§6).
- `Watcher today: 2/8` is today's watcher spend — launches used over the daily cap — from `countLaunchedToday` over the watch log and `dailyCap` in `watch.json`, both existing reads in `src/watch.ts`.
- The kill action is triggered by selecting a run and pressing Enter — never a single letter key (`k` collides with `k` = move up). It always confirms first, then follows the safe-kill contract of §4.5: identity check, SIGTERM to the PID, bounded escalation.
- `q`/`Esc` return to the root menu (sub-surface semantics, §4.3); `Ctrl-C` exits 130 everywhere.

---

## 3. Context Detection & Dynamic Options

```ts
export type RepoContext =
  | { kind: "not-a-repo"; cwd: string }
  | { kind: "unconfigured-repo"; root: string; name: string }
  | { kind: "configured-repo"; root: string; name: string; defaultBase?: string };
```

### Contextual Actions Mapping

| Action | `not-a-repo` | `unconfigured-repo` | `configured-repo` |
|---|:---:|:---:|:---:|
| **Review branch / PR** | ❌ (Omitted) | ❌ (Omitted) | ✅ Active (Item 1) |
| **Initialize Repo (`init`)** | ❌ (Omitted) | ✅ Active (Item 1) | ❌ (Omitted) |
| **Active & recent reviews** | ✅ Active | ✅ Active | ✅ Active |
| **Watcher & daemons** (submenu) | ✅ Machine-level | ✅ Machine-level + add | ✅ Machine-level + add |
| **Configure models & caps** | ✅ Global only | ✅ Global only | ✅ Person + Team + Watch |
| **Doctor & diagnostics** | ✅ System checks | ✅ System + Repo | ✅ System + Repo |
| **Review ledger & triage** | ❌ (Omitted) | ❌ (Omitted) | ✅ Active |
| **Lifecycle** (Upgrade & sync · Sync skills & MCP · Managed uninstall) | ✅ Active | ✅ Active | ✅ Active |
| **Quit** | ✅ Active | ✅ Active | ✅ Active |

Notes on the table:

- **Sync skills & MCP registrations** (inside the Lifecycle submenu) dispatches the existing `setup` verb, i.e. the non-interactive `runWizard` reconciliation pass (tools probe, skills sync, MCP registration, `~/.prhero/setup.json`). Zero new synchronization code is written for this item; the menu is only a dispatcher. It exists separately from `Upgrade & sync` because syncing without downloading a binary remains a distinct need (skills drift, a newly installed IDE).
- **Active & recent reviews** is available in every context: the active-runs registry and the store are machine-wide. Inside a repository, the view notes and allows filtering to the current repository.
- **Repo-optional commands:** today `pr-hero doctor`, `pr-hero config`, and `pr-hero setup` all fail outside a git repository because they call `resolveRepoRoot` in `src/cli.ts`, which throws "not a git repository". The menu offering them in `not-a-repo` would dispatch into a crash, so this change makes all three repo-optional as small in-scope CLI changes: `doctor` runs system checks only, `config` operates on the global layers only, and `setup` runs its machine-level steps only (tools probe, skills sync, MCP registration, `setup.json`) with repo steps skipped.
- The former "Reset / Vacuum review store" item is removed from the menu and this table; see §6 Deferred.

### Dispatch Matrix

Every menu item dispatches to a command that actually runs in the context where the item is shown. This table is the authoritative wiring contract; the dispatch tests assert it, and the persistent footer (§4.2) derives the CLI-equivalent hint from it.

| Menu item | Dispatches | Shown in | After action |
|---|---|---|---|
| Start Review | review submenu → existing review flow (`pr-hero review [--pr <n>] [flags]`) | `configured-repo` | Terminal |
| Initialize Repo | `pr-hero init` | `unconfigured-repo` | Returns (context re-resolved; the menu contents change) |
| Active & recent reviews | activity sub-surface (headless twin and footer hint: `pr-hero activity`) | all | Returns |
| Watcher & daemons | watcher submenu → `pr-hero watch status` / `watch install` / `watch uninstall` / `watch remove` (all contexts); `watch add` and the on-push toggle (in-repo only) | all | Returns |
| Configure models & caps | `pr-hero config` / interactive editor | all (global layers only outside a repo) | Returns |
| Doctor & diagnostics | `pr-hero doctor` | all (system checks only outside a repo) | Returns |
| Review ledger & triage | `pr-hero ledger` | `configured-repo` | Returns |
| Lifecycle → Upgrade & sync | `pr-hero upgrade` | all | Terminal |
| Lifecycle → Sync skills & MCP | `pr-hero setup` | all (machine-level steps only outside a repo) | Returns |
| Lifecycle → Managed uninstall | `pr-hero uninstall` | all | Terminal |
| Quit | — | all | Terminal (exit 0) |

Matrix rules:

- **Returns** rows come back to the root menu with a "press any key" pause first, so the dispatched command's output stays readable. The root menu then re-creates its reader and re-renders (invariant 11).
- **Terminal** rows follow the dispatched command's normal exit path and do not return to the menu: a review (once the spend confirm accepts), an upgrade (once it starts applying), and an uninstall.
- Bare `pr-hero watch` is invalid and is never dispatched; the watcher item always opens the submenu, whose entries dispatch `pr-hero watch <sub>`.
- The Activity item opens the interactive activity sub-surface in place; `pr-hero activity` is its headless read-only twin and the footer hint, not a literal dispatch.

---

## 4. Component Architecture

### 4.1 Root Dispatch & the `menu` Verb (`src/cli.ts`)

Zero-argument dispatch order (evaluated top to bottom):

1. stdin is not a TTY → print help text, exit 2 (unchanged from today).
2. TTY and `PRHERO_NO_TUI` is set (any value, including the empty string) → print help text, exit 0. Neither the wizard nor the menu opens. This is the automation/accessibility escape hatch; the explicit `pr-hero menu` verb is unaffected by it. Rationale: an escape hatch must be side-effect-free, and the wizard mutates machine state (writes `setup.json`, syncs skills, registers MCP), so the hatch suppresses both interactive paths.
3. TTY and the machine is not onboarded → `runWizard()` (unchanged from today; the wizard is non-interactive and takes no keyboard input, so it is gated on stdin only).
4. TTY and the machine is onboarded → open the root menu, provided stderr is also a TTY; if stderr is not a TTY, print help text and exit 2. Rationale: the menu renders to stderr and reads the keyboard — with stderr redirected it would be an invisible keyboard trap. This replaces today's implicit mapping of zero arguments to `review` (invariant 8).

The explicit verb `pr-hero menu` opens the root menu directly. It requires the TTY pair — stdin and stderr must both be TTYs; otherwise it errors with the help text and exit 2.

If the terminal is narrower than 24 columns, the TUI refuses to start: it prints "terminal too narrow" plus the help text and exits 2 (§4.2 width tiers).

Channel discipline: the menu renders to stderr through the existing `log()` channel so stdout stays pipeable (the repository's channel discipline). Styling is decided by `styleEnabled(process.stderr)` (which honors `NO_COLOR`); width comes from `terminalWidth()`.

### 4.2 Header, Status Chips, Footer & Menu Card Renderer (`src/ui-menu.ts`)

- Pure renderers returning `string[]`:
  - `renderSolidHeader(styles: boolean, width: number): string[]`
  - `renderContextBox(context: RepoContext, status: MenuStatusInfo, styles: boolean, width: number): string[]`
  - `renderMenuCard(items: MenuItem[], selectedIndex: number, styles: boolean, width: number): string[]`
- **Width tiers, stated honestly:**
  - `width >= 60`: full layout (the ASCII art is 56 columns wide).
  - `24 <= width < 60`: plain one-line title fallback; boxes render at their native minimum.
  - `width < 24`: the TUI refuses to start ("terminal too narrow", help text, exit 2). Rationale: `box()` in `src/ui.ts` clamps to its `MIN_BOX_WIDTH` floor of 24 columns, so a no-overflow guarantee below 24 is impossible; refusing is honest, overflowing is not.
  - The no-horizontal-overflow invariant therefore holds for `width >= 24`.
- Double borders (`╔`, `╗`, `╚`, `╝`, `═`, `║`) are drawn by extending the existing `box()` in `src/ui.ts` with an optional border style parameter (`"round" | "double"`, default `"round"`), not by writing a second box primitive. Rationale: existing callers stay untouched by the default, and one primitive cannot drift from itself.
- **Sanitizer:** one pure helper in `src/ui.ts` strips control bytes (`0x00-0x1F`, `0x7F`) and ESC sequences from externally-sourced strings (repo names, branch names, paths, PR titles) before they are rendered (invariant 12), with its own tests.
- **Persistent footer:** every TUI screen's footer shows the key hints and the headless CLI equivalent of the currently selected item (e.g. `$ pr-hero doctor`), derived from the dispatch matrix (§3). Items that open a submenu show the submenu hint instead; inside the submenu each entry shows its own command. Rationale: the TUI should teach the headless surface, not hide it.
- Status chips (`MenuStatusInfo`), each with a named source:
  - **Repo:** git root and current branch (git).
  - **MCP:** `Registered (claude, …)` from agent-env's detected environments. The word is Registered, not Connected — nothing measures a live connection.
  - **Store:** `prhero.db` present, plus its size.
  - **Watcher:** enrolled repo count from `watch.json`, plus whether the launchd agent is installed.
  - **Upgrade:** the cached upgrade-check state (§4.6): `up to date` / `vX.Y.Z available` / `unknown` — surfaced on the Lifecycle group label.
- Menu items carry dynamic status badges (e.g. `Active & recent reviews (● 1 running)`, `Watcher & background daemons (3 enrolled)`, `Lifecycle (up to date)`), all derived from local reads — never from the network.
- One impure gatherer (`gatherMenuStatus`) lives in the shell and reuses `doctor` evaluators where applicable. Every renderer stays pure (styles and width in, `string[]` out), per the house renderer rules, including the offline test asserting zero `\x1b` bytes with styles off.

### 4.3 Interactive Input Loop & Keyboard Ownership (`src/ui-menu.ts`)

- Reuses `splitKeys` and `parseKey` plus the `KeyReader` + injected-io pattern from `src/ui-select.ts`, so the loop is fully testable offline. This is the product's first real navigation loop — the wizard is non-interactive — and `runConfirm` is the only prior art.
- **Required `parseKey` extension:** today `parseKey` collapses both `Ctrl-C` and `Esc` into one `cancel` key, so the menu's exit-code split is impossible without extending it. `parseKey` is extended to distinguish the two (e.g. two distinct key types); existing consumers (`runConfirm`) keep treating both as cancel — a compatible extension with its tests updated.
- Key map (root menu):
  - `j` or `↓`: move selection down (wrapping around).
  - `k` or `↑`: move selection up (wrapping around).
  - `1-9`: select — move the cursor to that item. Digits do not execute. Rationale: the menu contains destructive actions (uninstall, purge, kill), so Enter is the only execute key; a stray digit must never launch one.
  - `Enter`: execute the selected item (the only execute key).
  - `q` or `Esc`: quit with exit 0.
  - `Ctrl-C`: quit with exit 130 (the 128+SIGINT convention).
- **Sub-surface key semantics:** inside a sub-surface (activity screen, watcher submenu, Lifecycle submenu, review submenu, config editor), `q`/`Esc` mean "back to the root menu", not process exit; `Ctrl-C` exits 130 everywhere.
- **Single keyboard owner (invariant 11):** the root menu closes its reader — restoring cooked mode — before dispatching any action or interactive sub-surface (review submenu, cost confirm, config editor, uninstall confirm); the sub-surface creates and closes its own reader; on return the root re-creates its reader and re-renders. Every surface closes its reader in a `finally` block.
- Resize: the `SIGWINCH` listener is registered when the root loop starts and removed in the same `finally` that closes the reader; on `SIGWINCH` the menu re-renders the current frame with a fresh `terminalWidth()`.

### 4.4 Review Submenu (`src/ui-review-menu.ts`)

- The submenu collects the launch configuration only:
  - Target: current-branch local review, or a PR.
  - Toggles: `post` (enabled only when the target is a PR — `parseArgs` enforces that `--post` requires `--pr`), `scout`, `force`, summary on/off, and model (choice from presets or free-text entry).
- It then hands off to the existing review flow, which still runs the size gate and then the cost-band `confirmReview`. That confirm remains the single spend gate; the submenu never duplicates cost UI (invariant 10).
- Once the spend confirm accepts, the review is terminal for the TUI: the process follows the review's normal exit path and does not return to the menu (§3 matrix).

### 4.5 Active Runs Tracker & Store Activity (`src/activity.ts` & `src/ui-activity.ts`)

- **Ephemeral registry:** each running review registers itself in `~/.prhero/active_runs/<pid>.json` with `{ pid, repo, pr?, runDir, startedAt }`. The file is created by the review shell at launch and removed on exit; this is a small, named touch on the review shell.
- **Driver SIGTERM handler (new named touch on the review shell):** the review driver installs a SIGTERM handler that tears down its own live agent subprocesses — it already holds a `StepHandle` with `kill()` for each (`src/step-runner.ts`) — removes its registry entry, and exits non-zero. This is what makes the kill below safe and complete.
- **Stale entry cleanup:** dead-PID entries are pruned automatically on read, using the same liveness probe as the existing `lockHolder` in `src/watch.ts` (`kill(pid, 0)`, where `EPERM` counts as alive). Phantom runs are never reported.
- **Safe kill, cooperative model:**
  1. **Identity check first:** read the target's command line via `ps -o command= -p <pid>` and require it to look like a pr-hero review invocation. A mismatch means PID reuse: prune the stale registry entry and refuse with a message — never signal.
  2. **On identity match:** send SIGTERM to the PID only. The driver's SIGTERM handler shuts down its agent subprocesses through its own child handles and cleans up its registry entry.
  3. **Bounded escalation:** if the process has not exited after 10 seconds, escalate to SIGKILL and report honestly that agent subprocesses may survive a SIGKILL, printing guidance for listing them.
  - Rationale: cooperative shutdown through the driver's own child handles is portable and uses machinery that already exists (`StepHandle.kill()`); process-group semantics are not portable from this runtime — the watcher spawns reviews via `Bun.spawn` in `src/watch.ts` with no detached/process-group option, so watcher-spawned reviews share the tick's process group and there is no group to signal safely; and PID liveness alone never authorizes a destructive signal (PID reuse).
  - The kill is triggered interactively by selecting a run and pressing Enter (never a single letter key — `k` collides with `k` = move up) and always confirms first.
- **Recent history:** a read-only query of the `runs` table in the canonical store (`~/.prhero/prhero.db`), rendering status (`run_status`), findings counts (`blocking`/`advisory`), duration (`wall_ms`), cost (`cost_usd_est`), and timestamp (`generated_at`), capped at the most recent 10 rows (a v1 constant; scrolling is deferred, §6). The view renders a sane empty state when the database is absent or has no rows.
- **Watcher spend:** the screen displays today's watcher spend as launches-used over the daily cap, from `countLaunchedToday` over the watch log and `dailyCap` in `watch.json` — both existing reads in `src/watch.ts`.
- **Headless parity:** `pr-hero activity` prints a read-only list of active runs plus recent history; `pr-hero activity --kill <pid>` is the non-interactive twin of the kill action. `--yes` skips only the confirmation — the identity check and the bounded escalation are never skipped.
- **Structure:** `src/activity.ts` holds the impure half (registry read/write, liveness probing, identity check, signalling, store query, spend read); `src/ui-activity.ts` holds the pure renderers (styles and width in, `string[]` out), per the house renderer rules.

### 4.6 Upgrader Module (`src/updater.ts` & `pr-hero upgrade`)

- Commands: `pr-hero upgrade [--yes] [--dry-run]` and `pr-hero upgrade --check`. There is no alias.
- Verb rationale: `update` is ambiguous across ecosystems — apt/brew users read it as "refresh the check only" while npm users read it as "install" — whereas `upgrade` unambiguously means "install the newer version". The closest single-binary relatives, `bun upgrade` and `deno upgrade`, use `upgrade`, and pr-hero is a bun-compiled binary, so that is our users' muscle memory. Nothing shipped references `update` (zero hits in README, src, test, install.sh), so the rename is free now and expensive after release.
- **Install-method detection keys off the running binary (`process.execPath`):**
  - Standalone iff the executable's real path is under `~/.prhero/bin/`.
  - Source checkout iff `resolveVersion()` reports `dev`.
  - npm/bun otherwise (a global package tree).
  - The upgrader operates only on the installation that is running. When it detects other installations (e.g. a standalone binary exists while the npm copy is running), it warns about the shadow install and touches nothing else. Rationale: upgrading a copy that is not running gives the user no observable change and can desynchronize two installs silently.
- **Phase A — runs in the current (old) process:**
  1. Query the GitHub Releases API on the canonical repo constant.
  2. For standalone: download `pr-hero-<target>` for the current platform/arch to a sibling temp file of the target (e.g. `~/.prhero/bin/.pr-hero.download-<pid>`), verify its SHA256 against `SHA256SUMS`, `chmod +x`, preserve the previous binary as `pr-hero.bak`, and atomically `renameSync` over `~/.prhero/bin/pr-hero`. Rationale for the sibling temp: `renameSync` is atomic only within one filesystem — a cross-filesystem rename fails with `EXDEV`, and `/tmp` is commonly a different filesystem.
  3. For npm/bun: run `npm install -g pr-hero@latest` / `bun add -g pr-hero@latest`.
  4. For a source checkout: informative no-op — print git-pull guidance and exit 0.
- **Phase B — post-upgrade reconciliation, runs in the new binary via re-exec** (an internal `pr-hero upgrade --reconcile` step). Rationale: reconciliation executed by the old process would run old code against the new binary's expectations (old skill payloads, old migration set); re-exec guarantees the new code reconciles its own state. This applies to the npm/bun path too. Reconciliation steps:
  - Resync bundled skills (`syncSkills({ force: true })`).
  - Verify MCP registrations in detected agent environments.
  - Open the canonical store once — migrations auto-run on open via `PRAGMA user_version`; no separate migration runner exists or is specified.
  - Reload launchd daemons only on macOS, and only if their plists are installed.
  - Run a quick `doctor` pass.
- **Transactional safety:**
  - The previous binary is preserved as `pr-hero.bak` until reconciliation succeeds, then removed. If the re-exec of the new binary fails to start, the upgrader restores `.bak` automatically.
  - Reconcile-step failures do not roll back the binary: the steps are idempotent — the upgrader prints the failing step and instructs re-running `pr-hero upgrade --reconcile`.
  - A later `upgrade` run detects leftover `.bak`/incomplete state and resumes or cleans it idempotently.
  - Reconciliation completion is recorded — the reconciled version is stored in `upgrade-check.json` — and `doctor` flags a version/reconciled mismatch as "reconciliation pending — run pr-hero upgrade --reconcile".
- `--yes` and `--dry-run` apply to everything above.
- **Upgrade check & cache (`pr-hero upgrade --check`):** a read-only current-vs-latest report with no mutation of the installation. `--check` always performs a fresh Releases query and rewrites the cache at `~/.prhero/upgrade-check.json` (a new `PrheroLayout` field, `upgradeCheckPath`). The 24h TTL governs only passive refresh: a plain `upgrade` run refreshes the cache opportunistically when it is older than 24h, and the menu never queries the network — it only reads the cache. The Lifecycle label renders instantly (`up to date` / `vX.Y.Z available` / `unknown`) and works offline.
- **Canonical identity:** one exported constant for the GitHub repo identity (`juanmaagd/pr-hero`, matching `README.md` and `install.sh`), used by the upgrader's Releases API and any surface rendering the repo identity, pinned by a test. Rationale: a single constant cannot drift from the published install source.

### 4.7 Uninstaller Module (`src/uninstaller.ts` & `pr-hero uninstall`)

- Command: `pr-hero uninstall [--yes] [--purge] [--dry-run]`
- Structure: a pure plan generator plus a side-effect runner, split into program removal (the default) and data removal (`--purge`). Rationale for the split: removing the program is reversible (reinstall); removing the operator's data (review history, configuration) is not, so it demands its own explicit flag or confirmation.
- **Default uninstall — removes the program:**
  1. On macOS: unload and remove both launchd plists — `io.prhero.watch` and `io.prhero.gc`. On other platforms these steps are skipped with a notice (cron guidance for the watcher, matching the existing `watchInstall` error message).
  2. Unregister the `pr-hero` MCP server and remove installed skills via new inverse functions in `src/agent-env.ts`, driven by the skills digest — never a hardcoded skill name list. Skills removal is digest-verified per file: only files whose content hash matches the recorded digest are removed; a user-modified file is left in place with a notice. Rationale: bundled skills are product-owned, but destruction of modified files is never acceptable from an uninstaller.
  3. Remove the PATH lines containing `.prhero/bin` that `install.sh` wrote into `~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, and the fish config, using exact-line matching. On any failure, print the manual removal instruction instead of failing the uninstall.
  4. When the install method is npm/bun: offer, and on confirmation execute, `npm rm -g pr-hero` / `bun remove -g pr-hero`.
  5. When the running install is standalone: remove the binary and `~/.prhero/bin/`.
- **`--purge` — additionally removes the data:** `prhero.db`, the metrics db, the store socket, `watch.json`, `config.json`, `setup.json`, `upgrade-check.json`, the `active_runs/` registry, logs, and the repos dir — i.e., the remainder of `~/.prhero/`.
- **Dual pre-purge gate:** before purging, check both the `active_runs` registry (live entries after stale pruning — covers local reviews) and `lockHolder` (the watcher tick); either being live produces the warning and requires explicit confirmation.
- **In-repo `.prhero/`:** when executed inside a repository, prompt to remove `.prhero/`. The prompt states that the directory is team property under version control; the default answer is No, and it is never removed non-interactively — `--yes` does not imply it.
- Interactive uninstall shows the plan by default before confirming — the dry-run plan is the confirmation screen. `--dry-run` prints the plan only. Rationale: the confirmation is only informed if it shows exactly what will be removed, and one plan renderer serves both surfaces.

### 4.8 Interactive Config Editor, `config set` & `config unset` (`src/ui-config-edit.ts`)

- Commands: `pr-hero config --edit` (or via the main menu), the headless `pr-hero config set <key> <value> [--person|--team|--watch]`, and `pr-hero config unset <key> [--person|--team|--watch]`.
- Editable keys, exactly:
  - **Person layer** (`~/.prhero/config.json`): `agents_dir`, `summary.model` (a person-direction key per `SUMMARY_DIRECTION`), `summary.enabled`, `max_verification_steps`.
  - **Team layer** (`<repo>/.prhero/config.json`): `default_base`, `parity_trigger_paths`, `suspicion_priors`, `summary.enabled` (capped), `max_verification_steps` (capped).
  - **Watch layer** (`~/.prhero/watch.json`): `daily_cap`, `window`, and per-repo enrollments `post`, `on_push`, `max_changed_lines`, `max_changed_files`.
- **Accept and annotate (aligned with C5's `foldKey`):** the editor and `config set` accept any type-valid value for capped Team keys, including values above the operator's Person ceiling — matching `foldKey` in `src/preflight.ts`, which accepts an over-ceiling repo value and narrows only the effective value, recording provenance `capped` when the ceiling actually binds. After writing, the surface displays the effective-value annotation derived from the same merge (e.g. "written: 5 — your effective value remains 3, capped by your Person layer"). Rationale: the Team file is shared and committed; the local operator's ceiling is not their teammates' ceiling, so write-time rejection by the local ceiling would block valid team configuration. The cap semantics survive unchanged where they always lived — the effective value can never exceed the Person-layer ceiling, and the direction stays spend-asymmetric (a team file must not raise the operator's bill; being more frugal is always allowed) — enforcement simply happens at merge time, not write time.
- Write-time validation is types/shape only, through the existing parsers.
- **`config set` v1 grammar, exactly (scalar keys only):**
  - `summary.enabled` (true/false), `summary.model` (string), `max_verification_steps` (non-negative integer), `agents_dir` (path string), `default_base` (string).
  - `--watch daily_cap <n>` (positive integer) and `--watch window <HH:MM-HH:MM>` (single documented string form; parsed to `{start, end}`).
  - `pr-hero config unset <key>` removes a key from a layer; unsetting `window` means "always".
  - Arrays and objects (`parity_trigger_paths`, `suspicion_priors`) are interactive-editor-only in v1; the documented headless path for them remains editing the JSON file directly. Per-repo watcher enrollments already have their headless surface in `pr-hero watch add` / `pr-hero watch remove` — that existing parity is the named headless path for them.
- `config set`/`unset` default to `--person`; `--team` requires running inside a repository, otherwise it errors with a descriptive message. Writes are 2-space-indented JSON. Bare `pr-hero config` stays read-only and pipeable. Rationale: this restores the proposal's strict headless parity invariant, which interactive-only editing violated.
- Both the editor and `config set`/`unset` reuse `CONFIG_DIRECTION`/`SUMMARY_DIRECTION` and the `mergeConfig` machinery for the effective-value annotation; reimplementing direction logic is forbidden.

---

## 5. Phase Breakdown (Implementation Plan)

Ordering rule (openspec `strict_tdd`): every phase starts by writing that phase's failing offline tests, then implements until they pass.

### Phase 1: Lifecycle Foundations (Upgrader & Uninstaller)
- Write failing tests first in `test/updater.test.ts` (execPath-based install-method detection incl. the shadow-install warning; Phase A sibling temp file → SHA256 verify → `chmod +x` → `.bak` preservation → atomic `renameSync`; automatic `.bak` restore when the re-exec fails to start; resume/clean of leftover `.bak`/incomplete state; source-checkout no-op; `--check` always-fresh semantics vs the passive 24h TTL; reconciled-version record in `upgrade-check.json` + the doctor "reconciliation pending" flag; re-exec `--reconcile` on both standalone and npm/bun paths; canonical-repo-constant pin) and `test/uninstaller.test.ts` (program/data plan split; both launchd labels macOS-scoped with skip notices elsewhere; digest-verified per-file skill removal with the modified-file notice; rc-file PATH-line cleanup across the four files with the manual fallback; npm/bun removal offer; standalone binary + `bin/` removal only for a running standalone install; dual pre-purge gate — `active_runs` after stale pruning and `lockHolder`; purge data coverage; in-repo `.prhero/` prompt — default No, never with `--yes`; plan-as-confirmation-screen).
- Implement `src/updater.ts` (Phase A, `--check`, `--reconcile`, `.bak` lifecycle, `upgradeCheckPath` layout field).
- Implement the new inverse functions in `src/agent-env.ts` (MCP unregistration, digest-verified skills removal).
- Implement `src/uninstaller.ts` (pure plan generator + side-effect runner, program/data split).
- Wire CLI subcommands `pr-hero uninstall` and `pr-hero upgrade` with `--yes`, `--dry-run`, `--purge`.

### Phase 2: Active Runs Tracker & Store Activity Monitor
- Write failing tests first in `test/activity.test.ts` (registry lifecycle: create at launch, remove on exit; the driver SIGTERM handler tearing down its `StepHandle` children, removing its registry entry, and exiting non-zero; stale dead-PID pruning with the `lockHolder` liveness semantics; identity-mismatch refusal — stale entry pruned, no signal sent; SIGTERM path with a fake signal sender; the 10s escalation to SIGKILL with the honest survivor report; the confirmation gate — `--yes` skips only the confirm, never the identity check; the history query incl. the empty state and the 10-row cap; the spend read — `countLaunchedToday` + `dailyCap`) and `test/ui-activity.test.ts` (renderer lines with styles on/off, including the zero-`\x1b`-bytes-with-styles-off assertion).
- Implement `src/activity.ts` and the driver SIGTERM handler + registry hooks in the review shell (`src/cli.ts`, `src/watch.ts`).
- Implement `src/ui-activity.ts` (active runs list with select+Enter kill, spend line, history table).
- Wire `pr-hero activity` and `pr-hero activity --kill <pid>` (with `--yes`).

### Phase 3: Menu Context & Pure UI Renderers
- Write failing tests first in `test/menu-context.test.ts` and `test/ui-menu.test.ts`: exact-line renderer output with styles on and off (including the house criterion — a test asserting zero `\x1b` bytes with styles off); the width tiers (full at >= 60, plain title for 24-59, refusal below 24) with no horizontal overflow at width >= 24; the `box()` border-style option (default `"round"` leaves existing callers' output unchanged); the control-byte sanitizer in `src/ui.ts`; the persistent footer with the CLI-equivalent hint; and the `resolveMenuContext`/`menuOptions` tables (Lifecycle group present in every context with the cached badge; Activity present in every context; no Reset/Vacuum item).
- Implement `src/menu-context.ts` (`resolveMenuContext` and dynamic `menuOptions` with live status badges and the Lifecycle group).
- Extend `src/ui.ts` (border-style option, sanitizer); implement `src/ui-menu.ts` (header with tiers, context box, menu card, footer).

### Phase 4: Keyboard Foundations & Repo-Optional Commands
- Write failing tests first: the `parseKey` extension distinguishing `Esc` from `Ctrl-C` with `runConfirm` still treating both as cancel (compatible extension, existing tests updated); repo-optional `pr-hero doctor` (system checks only outside a repo), `pr-hero config` (global layers only outside a repo), and `pr-hero setup` (machine-level steps only outside a repo, repo steps skipped) — all three currently throw via `resolveRepoRoot`.
- Extend `parseKey` in `src/ui-select.ts`; make `doctor`, `config`, and `setup` repo-optional in the CLI.

### Phase 5: Root Dispatch, Submenus & Review Submenu
- Write failing tests first: the input loop via injected `KeyReader`/io (digits select and do not execute; Enter executes; `q`/`Esc` exit 0 at the root and mean back in sub-surfaces; `Ctrl-C` exits 130 everywhere; raw mode restored in `finally`); the single-keyboard-owner handoff (root closes its reader before dispatch, re-creates and re-renders on return; the `SIGWINCH` listener is removed in the same `finally`); the TTY-pair gate (stdin and stderr) on the zero-arg path and the `menu` verb; zero-arg dispatch (menu shown and review not implicitly started; non-TTY help + exit 2; not-onboarded wizard; `PRHERO_NO_TUI` help + exit 0); the dispatch matrix assertions (every item dispatches its matrix command in its matrix contexts; returning rows pause and re-render; terminal rows do not return; bare `pr-hero watch` never dispatched); the watcher submenu (status/install/uninstall/remove everywhere, add + on-push in-repo only); the Lifecycle submenu; and the review submenu contract (post only for PR targets; hand-off into the existing size gate + `confirmReview`; no cost UI in the submenu; renderer tests include the zero-`\x1b` assertion).
- Wire bare `pr-hero` (zero args, TTY pair, onboarded) to the root menu, removing the implicit `review` mapping; wire `pr-hero menu`.
- Implement the keyboard loop, ownership handoff, `SIGWINCH` redraw + cleanup, and `gatherMenuStatus`.
- Implement `src/ui-review-menu.ts`, the watcher submenu, and the Lifecycle submenu; connect all menu actions per the dispatch matrix.

### Phase 6: Interactive Config Editor, `config set` & `config unset`
- Write failing tests first: per-layer key sets (exactly as §4.8); accept-and-annotate for capped Team keys — an over-ceiling type-valid value is written and the effective-value annotation from `mergeConfig` is displayed; write-time validation is types/shape only through the existing parsers; the v1 scalar grammar (incl. `--watch daily_cap <n>` and `--watch window <HH:MM-HH:MM>`); `config unset` (window unset = always); Team layer disabled outside a repo (editor) and `--team` failing with a descriptive error outside a repo (`set`/`unset`); 2-space JSON write-back; renderer tests include the zero-`\x1b` assertion.
- Implement `src/ui-config-edit.ts` and the `config set`/`config unset` CLI paths over `CONFIG_DIRECTION`/`SUMMARY_DIRECTION` + `mergeConfig`.

### Phase 7: End-to-End Verification & Documentation
- Run full test suite (`bun test`), typecheck (`bun run typecheck`), and biome linter (`bun run check`).
- Update `README.md` and the CLI help: document the removal of the implicit zero-argument `review` default as a breaking change, the new verbs (`menu`, `upgrade` including `--check`, `uninstall`, `activity`, `config set`/`config unset`), the repo-optional behavior of `doctor`/`config`/`setup`, and the `PRHERO_NO_TUI` escape hatch.

---

## 6. Deferred

- **Reset / Vacuum review store:** removed from the root menu and the contextual actions table. Store maintenance (VACUUM, integrity checks, reset) is future work and needs its own design; note that `pr-hero gc` already exists for run-tree pruning, so the immediate operational need is covered.
- **Doctor-actionable navigation:** jumping from a doctor finding straight to the surface that fixes it.
- **History scrolling:** the activity history view is capped at the most recent 10 rows in v1.
- **Advanced-command discovery screen:** a browsable catalog of every headless command beyond the footer hints.
- **Breadcrumbs:** a persistent trail of the submenu path.

---

## 7. Revision History

- **Rev 1 (2026-08-24):** initial plan.
- **Rev 2 (2026-08-24):** audit amendments applied:
  - The removal of the implicit zero-argument `review` default is stated explicitly as a breaking change (invariant 8), with the `PRHERO_NO_TUI` escape hatch.
  - Upgrader reconciliation now runs in the new binary via re-exec (`upgrade --reconcile`), on the npm/bun path too.
  - Headless `pr-hero config set` added, restoring strict headless parity.
  - Orphan menu items resolved: "Reset / Vacuum review store" deferred (§6); "Sync skills & MCP registrations" specified as dispatching the existing `setup` verb.
  - Platform conditioning: every launchd requirement is scoped to macOS with skip notices elsewhere (invariant 9).
  - The review submenu is chained into the existing size gate + cost-band confirm, preserved as the single spend gate (invariant 10).
  - Activity monitor integrated (invariant 5): `~/.prhero/active_runs/` registry with stale-PID cleanup, read-only `runs`-table history, and the headless `pr-hero activity` twin.
  - `upgrade` fixed as the lifecycle verb (no `update` alias), with the check cache renamed to `upgrade-check.json` so file, flag, and verb agree.
- **Rev 3 (2026-08-24):** Codex audit adjudicated; all seven confirmed blockers fixed:
  - The kill action moved to the safe cooperative model: identity check via `ps` before any signal, SIGTERM to the PID with the driver's own SIGTERM handler tearing down its agent subprocesses (`StepHandle.kill()`), bounded 10s escalation to SIGKILL with an honest survivor report. The rev 2 process-group kill was unimplementable portably (no group isolation at the `Bun.spawn` site in `src/watch.ts`).
  - Single keyboard owner (invariant 11) with close-then-reopen handoff, the required `parseKey` Esc/Ctrl-C split, sub-surface back semantics, and `SIGWINCH` cleanup.
  - Executable-options guarantee: the dispatch matrix (§3) as the wiring contract; `doctor`, `config`, and `setup` made repo-optional; the watcher item specified as a submenu (bare `pr-hero watch` is never dispatched).
  - Config surfaces aligned with C5's `foldKey`: accept-and-annotate replaces write-time rejection for capped Team keys; `config set` v1 scalar grammar pinned; `config unset` added.
  - Transactional upgrade: execPath-based detection with the shadow-install warning, sibling temp file for atomic rename, `.bak` preservation with automatic restore on failed re-exec, idempotent reconcile resume, reconciled-version record with the doctor "reconciliation pending" flag, and the `--check`/TTL contradiction fixed (`--check` always fresh; TTL governs passive refresh only).
  - Uninstall split into program (default) vs data (`--purge`), four rc files (`~/.bash_profile` added), digest-verified per-file skill removal, the dual pre-purge gate (`active_runs` + `lockHolder`), and the in-repo `.prhero/` prompt hardened (team property, default No, never with `--yes`).
  - TTY pair required for the menu (stdin + stderr), honest width tiers with the `MIN_BOX_WIDTH` floor (refusal below 24 columns), and the control-byte sanitizer for externally-sourced strings.
  - Product additions: Lifecycle submenu grouping with the cached badge on the group label, persistent footer with the CLI-equivalent hint, activity screen updates (select+Enter kill, 10-row history cap, today's watcher spend), and an expanded Deferred list.
- **Ratification (2026-08-24):** Rev 3 ratified by Juanma. Implementation begins in a follow-up session, starting at Phase 1 (updater & uninstaller, tests first).
