# Specification: TUI Menu & Context Resolution

## Requirements

1. **Root Dispatch:**
   - When `pr-hero` is invoked with 0 arguments in an interactive TTY (and the machine is onboarded), it MUST display the root interactive TUI menu, provided stderr is also a TTY. If stderr is not a TTY, it MUST print help text and exit 2. Rationale: the menu renders to stderr and reads the keyboard — with stderr redirected it would be an invisible keyboard trap.
   - The CLI MUST NOT implicitly run `review` on a zero-argument invocation; the previous implicit default is removed. This removal MUST be documented in `README.md` and the CLI help as a breaking change.
   - When invoked in a non-TTY (stdin) without arguments, it MUST print help text and exit with code 2 (unchanged behavior).
   - When invoked with 0 arguments in a TTY on a machine that is not onboarded, it MUST run the onboarding wizard (unchanged behavior; the wizard is non-interactive and takes no keyboard input, so it is gated on stdin only).
   - When the environment variable `PRHERO_NO_TUI` is set (any value, including the empty string), a zero-argument invocation in a TTY MUST print help and exit 0; neither the wizard nor the menu opens. This is the automation/accessibility escape hatch. The explicit `pr-hero menu` verb is unaffected by it.
   - `pr-hero menu` MUST open the root menu explicitly. It MUST require the TTY pair — stdin and stderr must both be TTYs; otherwise it MUST error with the help text and exit code 2.
   - When the terminal is narrower than 24 columns, the TUI MUST refuse to start: print "terminal too narrow" plus the help text and exit 2 (see the width tiers in requirement 3).
   - The menu MUST render to stderr via the existing `log()` channel so stdout stays pipeable. Styling MUST be decided by `styleEnabled(process.stderr)` (honoring `NO_COLOR`); width MUST come from `terminalWidth()`.

2. **Context Resolution (`RepoContext`) & Executable Options:**
   - The CLI MUST determine if the current working directory is:
     - `not-a-repo`: outside any git repository.
     - `unconfigured-repo`: inside a git repository without a `.prhero/` directory.
     - `configured-repo`: inside a git repository with `.prhero/`.
   - Actions requiring a configured repo (such as `Review` and `Ledger`) MUST NOT appear in the menu if the context is `not-a-repo` or `unconfigured-repo`.
   - Every rendered menu item MUST dispatch to a command that actually runs in the context where the item is shown (see the Dispatch Matrix below).
   - `pr-hero doctor`, `pr-hero config`, and `pr-hero setup` MUST become repo-optional: outside a repository, `doctor` runs system checks only, `config` operates on the global layers only, and `setup` runs its machine-level steps only (tools probe, skills sync, MCP registration, `setup.json`) with repo steps skipped. Today all three fail outside a git repository because they call `resolveRepoRoot` in `src/cli.ts`, which throws; these are small in-scope CLI changes with their own failing-tests-first tasks.
   - If the context is `unconfigured-repo`, the first menu option MUST be `Initialize pr-hero in this repo`.
   - The `Active & recent reviews` item MUST be available in every context (the registry and store are machine-wide; see `specs/activity-monitor.md`).
   - A `Lifecycle` submenu MUST group `Upgrade & sync`, `Sync skills & MCP registrations`, and `Managed uninstall`. The `Sync skills & MCP registrations` entry MUST dispatch the existing `setup` verb (the non-interactive `runWizard` reconciliation pass); no new synchronization code is introduced for it. The cached upgrade-check state MUST surface on the group label.
   - The Watcher item MUST open the watcher submenu: `watch status`, `watch install`, `watch uninstall`, and `watch remove` are available in every context; `watch add` (enrolling the current repository) and the on-push toggle are available in-repo only. Each entry dispatches `pr-hero watch <sub>`; bare `pr-hero watch` is invalid and MUST never be dispatched.
   - A "Reset / Vacuum review store" item MUST NOT appear; store maintenance is deferred (`pr-hero gc` already covers run-tree pruning).

3. **Visual Structure & Rendering:**
   - Width tiers, stated honestly:
     - `width >= 60`: the menu header MUST render the solid block ASCII font for `PR-HERO` (the art is 56 columns wide).
     - `24 <= width < 60`: the header MUST fall back to a plain one-line title; boxes render at their native minimum.
     - `width < 24`: the TUI MUST refuse to start (requirement 1). Rationale: `box()` in `src/ui.ts` clamps at its `MIN_BOX_WIDTH` floor of 24 columns, so a no-overflow guarantee below 24 is impossible.
   - No renderer output may overflow horizontally at `width >= 24`.
   - The context information box and menu card MUST be drawn using double-border box characters (`╔`, `═`, `╗`, `║`, `╚`, `╝`), produced by the existing `box()` primitive in `src/ui.ts` extended with an optional border style (`"round" | "double"`, default `"round"` so existing callers are untouched).
   - The menu card MUST render items with an active pointer (`▸`), shortcuts, and dynamic status badges derived from local reads only.
   - Every TUI screen's footer MUST show the key hints and the headless CLI equivalent of the currently selected item (e.g. `$ pr-hero doctor`), derived from the Dispatch Matrix; an item that opens a submenu shows the submenu hint instead, and inside the submenu each entry shows its own command.
   - Every externally-sourced string rendered into the TUI (repository names, branch names, paths, PR titles) MUST pass through the control-byte sanitizer in `src/ui.ts` (strip `0x00-0x1F`, `0x7F`, and ESC sequences). Rationale: a branch name carrying escape sequences must not inject into the terminal.
   - Status chips (`MenuStatusInfo`) MUST come from named sources: Repo (git root + current branch), MCP (`Registered (claude, …)` from agent-env's detected environments — the word is Registered, not Connected, because nothing measures a live connection), Store (`prhero.db` present + size), Watcher (enrolled repo count from `watch.json` + whether the launchd agent is installed), and Upgrade (the cached upgrade-check state, surfaced on the Lifecycle group label). One impure gatherer (`gatherMenuStatus`) lives in the shell and reuses `doctor` evaluators where applicable.
   - All renderers MUST receive `styles: boolean` and `width: number` as parameters and return `string[]`, and MUST have an offline test asserting zero `\x1b` bytes with styles off.

4. **Keyboard Navigation & Ownership:**
   - The interactive loop MUST reuse `splitKeys`/`parseKey` and the `KeyReader` + injected-io pattern from `src/ui-select.ts` so tests run offline. This is the product's first real navigation loop (the wizard is non-interactive); `runConfirm` is the only prior art.
   - `parseKey` MUST be extended to distinguish `Esc` from `Ctrl-C` (today it collapses both into one cancel key, making the exit-code split below impossible); existing consumers (`runConfirm`) keep treating both as cancel — a compatible extension with its tests updated.
   - `j`/`↓` and `k`/`↑` MUST move the selection down/up, wrapping around.
   - Direct numeric shortcuts (`1-9`) MUST select — move the cursor to that item — and MUST NOT execute. `Enter` MUST be the only execute key (the menu contains destructive actions).
   - At the root menu, pressing `q` or `Esc` MUST terminate cleanly with exit code 0; inside a sub-surface (activity screen, watcher submenu, Lifecycle submenu, review submenu, config editor), `q`/`Esc` MUST mean "back to the root menu". Pressing `Ctrl-C` MUST terminate with exit code 130 (128+SIGINT convention) everywhere.
   - Exactly one live raw-mode reader MUST exist at any time. The root menu MUST close its reader (restoring cooked mode) before dispatching any action or interactive sub-surface; the sub-surface creates and closes its own reader; on return the root re-creates its reader and re-renders. Every surface MUST close its reader in a `finally` block.
   - Actions marked Returns in the Dispatch Matrix MUST return to the root menu after a "press any key" pause (so the dispatched command's output stays readable); actions marked Terminal MUST follow the dispatched command's normal exit path and not return.

5. **Resize:**
   - The `SIGWINCH` listener MUST be registered when the root loop starts and removed in the same `finally` that closes the reader. On `SIGWINCH`, the menu MUST re-render the current frame with a fresh `terminalWidth()`.

6. **Review Submenu:**
   - The submenu MUST collect the launch configuration only: the target (current-branch local review or a PR) and the toggles `post` (enabled only when the target is a PR — `parseArgs` enforces that `--post` requires `--pr`), `scout`, `force`, summary on/off, and model (choice from presets or free-text entry).
   - It MUST then hand off to the existing review flow, which still runs the size gate and the cost-band `confirmReview`. That confirm remains the single spend gate; the submenu MUST NOT duplicate cost UI.
   - Once the spend confirm accepts, the review is terminal for the TUI: the process follows the review's normal exit path and does not return to the menu.

7. **Dispatch Matrix (authoritative wiring contract):**

   | Menu item | Dispatches | Shown in | After action |
   |---|---|---|---|
   | Start Review | review submenu → existing review flow (`pr-hero review [--pr <n>] [flags]`) | `configured-repo` | Terminal |
   | Initialize Repo | `pr-hero init` | `unconfigured-repo` | Returns (context re-resolved) |
   | Active & recent reviews | activity sub-surface (headless twin and footer hint: `pr-hero activity`) | all | Returns |
   | Watcher & daemons | watcher submenu → `pr-hero watch status`/`install`/`uninstall`/`remove` (all); `watch add`, on-push toggle (in-repo) | all | Returns |
   | Configure models & caps | `pr-hero config` / interactive editor | all (global layers only outside a repo) | Returns |
   | Doctor & diagnostics | `pr-hero doctor` | all (system checks only outside a repo) | Returns |
   | Review ledger & triage | `pr-hero ledger` | `configured-repo` | Returns |
   | Lifecycle → Upgrade & sync | `pr-hero upgrade` | all | Terminal |
   | Lifecycle → Sync skills & MCP | `pr-hero setup` | all (machine-level steps only outside a repo) | Returns |
   | Lifecycle → Managed uninstall | `pr-hero uninstall` | all | Terminal |
   | Quit | — | all | Terminal (exit 0) |

   The dispatch tests MUST assert this table: every item dispatches its matrix command in its matrix contexts, returning rows pause and re-render the root menu, terminal rows do not return, and bare `pr-hero watch` is never dispatched. The Activity row opens the interactive sub-surface in place; its command column names the headless read-only twin used for the footer hint, so the literal-dispatch assertion does not apply to that row.

## Scenarios

### Scenario: Running pr-hero outside a git repository
- **GIVEN** the current working directory is not a git repository
- **WHEN** the user runs `pr-hero` in a TTY
- **THEN** the context box displays `Context: ⚪ Global (outside git repository)`
- **AND** the menu displays global options (`Activity`, `Watcher`, `Config`, `Doctor`, `Lifecycle` — whose submenu contains `Upgrade & sync`, `Sync skills & MCP registrations`, and `Managed uninstall`)
- **AND** the `Review` option is omitted.

### Scenario: Running pr-hero inside a configured repository
- **GIVEN** the current working directory is a git repository with `.prhero/`
- **WHEN** the user runs `pr-hero` in a TTY
- **THEN** the context box displays the repository name, branch, MCP registration status, and store path
- **AND** the first menu option is `Start Review (current branch or PR)`
- **AND** pressing `Enter` on `Start Review` opens the review configuration submenu, which hands off to the existing size gate and cost-band confirm.

### Scenario: Zero-argument invocation no longer starts a review
- **GIVEN** an onboarded machine
- **WHEN** the user runs `pr-hero` with zero arguments in a TTY
- **THEN** the root menu is shown
- **AND** no review is started implicitly.

### Scenario: Redirected stderr refuses the menu
- **GIVEN** stdin is a TTY but stderr is redirected to a file
- **WHEN** the user runs `pr-hero` with zero arguments (onboarded) or `pr-hero menu`
- **THEN** help text is printed and the process exits with code 2
- **AND** no raw-mode reader is ever opened.

### Scenario: Ctrl-C during the menu
- **GIVEN** the root menu is open
- **WHEN** the user presses `Ctrl-C`
- **THEN** the process exits with code 130
- **AND** the terminal is restored (raw mode off).

### Scenario: Narrow terminal fallback
- **GIVEN** a terminal between 24 and 59 columns wide
- **WHEN** the menu renders
- **THEN** the header falls back to the plain one-line title
- **AND** no line overflows the terminal width.

### Scenario: Terminal too narrow
- **GIVEN** a terminal narrower than 24 columns
- **WHEN** the user opens the menu (zero-argument or `pr-hero menu`)
- **THEN** the TUI refuses with "terminal too narrow", prints the help text, and exits 2.

### Scenario: PRHERO_NO_TUI escape hatch
- **GIVEN** `PRHERO_NO_TUI` is set (to any value, including the empty string)
- **WHEN** the user runs `pr-hero` with zero arguments in a TTY
- **THEN** help text is printed and the process exits with code 0
- **AND** neither the wizard nor the menu opens.

### Scenario: Returning action pauses and re-renders
- **GIVEN** the root menu is open in any context
- **WHEN** the user executes `Doctor & diagnostics`
- **THEN** the root menu closes its reader, dispatches `pr-hero doctor`, and shows a "press any key" pause after the output
- **AND** on the keypress the root menu re-creates its reader and re-renders.
