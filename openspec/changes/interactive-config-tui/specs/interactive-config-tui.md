# Specification: Interactive Configuration TUI

## Requirements

1. **Two-Step Submenu Flow:**
   - **Step 1 (Layer Selection):**
     - When `5. Configuration` is selected, display `renderConfigLayerSelection`:
       - `1. Repository configuration (.prhero/config.json)` (disabled with notice when outside a git repository).
       - `2. Global configuration (~/.prhero/config.json)`.
       - `3. Watcher daemon configuration (~/.prhero/watch.json)`.
     - Selecting a layer opens its dedicated interactive editor card (Step 2).
     - Pressing `q` / `Esc` returns to the main menu.
   - **Step 2 (Layer Settings Editor):**
     - Displays only the scalar, actionable keys for the selected layer.
     - Pressing `q` / `Esc` returns to Step 1 (Layer Selection).

2. **Clean Item List (Scalar Focus):**
   - The interactive editor MUST ONLY display actionable scalar configurations:
     - **Repository Layer:** `default_base`, `max_changed_lines`, `max_changed_files`, `max_verification_steps`, `summary.enabled`.
     - **Person Layer:** `max_changed_lines`, `max_changed_files`, `max_verification_steps`, `summary.enabled`.
     - **Watcher Layer:** `daily_cap`, `window`.
   - Advanced or non-essential options (`summary.model`, `parity_trigger_paths`, `suspicion_priors`, `agents_dir`) MUST NOT be displayed in this editor list to keep the terminal layout minimalist and focused.

3. **In-Place Interactive Controls:**
   - **Boolean Toggles (`summary.enabled`):**
     - Pressing `Space` or `Enter` MUST toggle between `[✓] true` and `[ ] false`, immediately persisting the change.
   - **Numeric Steppers (`max_changed_lines`, `max_verification_steps`, `daily_cap`):**
     - Pressing `←` / `h` MUST decrement the value (e.g. -250 for lines down to 0, -1 for verification steps down to 0).
     - Pressing `→` / `l` MUST increment the value (e.g. +250 for lines, +1 for verification steps).
     - Pressing `Enter` MAY allow typing a numeric value directly.
     - New values MUST be persisted immediately.
   - **Text & Model Selectors (`default_base`, `summary.model`):**
     - Pressing `Enter` MUST cycle through common presets or allow entering a value.
   - **Unset / Revert to Default (`u`):**
     - Pressing `u` on an item MUST delete the key from the active configuration file (reverting to system default or lower layer).
   - **Layer Switch (`Tab` or `1-3`):**
     - MUST switch the active layer being viewed and edited.
   - **Navigation & Exit (`j`/`k`, `↑`/`↓`, `q`/`Esc`):**
     - `j`/`k` / `↑`/`↓` MUST move selection cursor with wrapping.
     - `q` / `Esc` MUST exit the configuration editor and return to the main menu without side effects.

4. **Visual Layout & Formatting:**
   - The configuration editor card MUST be rendered with `box(title, lines, { width, styles, borderStyle: "double" })`.
   - When `styles: false`, all renderers MUST produce zero ANSI escape sequences (`\x1b`).
   - Width tiers MUST adapt gracefully down to 40 columns.

5. **Root Menu Integration:**
   - Selecting `5. Configuration →` in `pr-hero menu` MUST invoke `runConfigSubmenu` with the active context.
   - Returning from `runConfigSubmenu` MUST return `"back"` to the main menu loop to smoothly repaint the root menu.

## Scenarios

### Scenario: Toggling `summary.enabled` in Repository layer
- **GIVEN** the interactive configuration editor open on the Repository layer
- **WHEN** the user navigates to `summary.enabled` and presses `Space`
- **THEN** `summary.enabled` value changes from `true` to `false`
- **AND** `.prhero/config.json` is updated with `"summary": { "enabled": false }`
- **AND** the screen refreshes to show `[ ] false`.

### Scenario: Stepping `max_changed_lines`
- **GIVEN** `max_changed_lines` is set to 1500
- **WHEN** the user presses `→` (or `l`)
- **THEN** the value updates to 1750
- **AND** `.prhero/config.json` is written with `"max_changed_lines": 1750`.

### Scenario: Unsetting a key with `u`
- **GIVEN** `default_base` is set to `"develop"` in `.prhero/config.json`
- **WHEN** the user presses `u` on `default_base`
- **THEN** `default_base` is removed from `.prhero/config.json`
- **AND** the display shows `(default)`.
