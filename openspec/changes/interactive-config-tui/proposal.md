# Proposal: Interactive Config TUI & Configurable Size Gate

## Why

1. **Broken Menu Action in TUI:** The TUI main menu exposes option `5. Configuration →` with a submenu hint and description "Inspect or edit global and repo settings", but selecting it executes a static read-only stdout dump (`configCommand`) and immediately pauses with "Press any key to return to menu...". The interactive configuration editor scaffolded in `ui-config-edit.ts` was never wired into an active TUI loop.
2. **Missing Persistent Size Gate Configuration:** The size-gate threshold defaults to 1500 lines (`DEFAULT_SIZE_GATE.maxChangedLines`). Users currently have to pass `--max-changed-lines` as a CLI flag or configure it exclusively in `watch.json` for daemon reviews. There is no way to set a repo-level or user-level default in `.prhero/config.json` or `~/.prhero/config.json`.
3. **Streamlined Terminal UX:** Complex nested configurations (such as array globs for `parity_trigger_paths` and rule arrays for `suspicion_priors`) clutter a terminal card; hiding them from the interactive scalar editor keeps the TUI focused on actionable scalar settings.

## What Changes

1. **Size Gate in Configuration Schema:**
   - Add `max_changed_lines` and `max_changed_files` to `LocalConfig`, `ConfigLayer`, and `CONFIG_DIRECTION` in `src/preflight.ts`.
   - Direction: `capped` (narrower number wins between repo and person layers to prevent repo files from expanding spend limits beyond user preferences).
   - Wire merged size gate configuration into `review`, `pr-preflight`, and `cli.ts`.
   - Update `config set` / `config unset` to support `max_changed_lines` and `max_changed_files`.

2. **Interactive Configuration Editor & Submenu (`src/ui-config-edit.ts`, `src/ui-menu.ts`):**
   - Implement `runConfigSubmenu` (and interactive `runConfigEditor` loop):
     - Layer switching: **[1] Repository** (`.prhero/config.json`), **[2] Global (Person)** (`~/.prhero/config.json`), **[3] Watcher** (`~/.prhero/watch.json`).
     - Display only scalar, actionable keys:
       - Repo: `default_base`, `max_changed_lines`, `max_verification_steps`, `summary.enabled`.
       - Person: `max_changed_lines`, `max_verification_steps`, `summary.enabled`.
       - Watcher: `daily_cap`, `window`.
     - Controls:
       - **Boolean Toggle (`Space` / `Enter`):** Instantly toggles boolean state (`[✓] true` / `[ ] false`).
       - **Numeric Stepper / Edit (`←`/`→` / `h`/`l` / `Enter`):** Steps values (e.g. ±1 for steps, ±250 for lines) or opens inline numeric input.
       - **Text / Presets (`Enter`):** Cycles presets or prompts for custom string.
       - **Unset / Reset (`u`):** Removes key from the active layer's JSON file to revert to `(default)`.
       - **Back (`q` / `Esc`):** Returns to layer selector or main menu.
   - Wire `dispatchAction("config")` in `src/cli.ts` to open `runConfigSubmenu`.

## Capabilities

### New Capabilities
- `config-schema-size-gate`: Define `max_changed_lines` and `max_changed_files` in `.prhero/config.json` and `~/.prhero/config.json`.
- `interactive-config-tui`: Interactive in-place editing of scalar settings in the pr-hero TUI.

### Modified Capabilities
- `pr-hero config set/unset`: Headless commands accept `max_changed_lines` and `max_changed_files`.
- `pr-hero menu`: Option 5 launches interactive configuration submenu instead of static dump.

## Impact & Risk Assessment

- **Backward Compatibility:** Fully backward compatible. Existing `config.json` files without `max_changed_lines` fall back to `DEFAULT_SIZE_GATE` (1500 lines / 150 files).
- **Blast Radius:** `src/preflight.ts`, `src/cli.ts`, `src/ui-config-edit.ts`, `src/ui-menu.ts`, `test/ui-config-edit.test.ts`, `test/preflight.test.ts`.
- **Rollback Plan:** Revert git commit; config files remain valid JSON.

## Verification Strategy

- Strict offline unit & integration tests (`bun test`).
- Assert zero ANSI escape sequences in all UI renderers when `styles: false`.
- Strict typecheck (`bun run typecheck`) and Biome linter (`./node_modules/.bin/biome check`).
