# Specification: Interactive Configuration Editor

## Requirements

1. **Interactive Config Editor (`pr-hero config --edit`):**
   - MUST allow inspecting and modifying configurations across three layers:
     - Person layer (`~/.prhero/config.json`).
     - Team layer (`<repo>/.prhero/config.json`).
     - Watcher layer (`~/.prhero/watch.json`).
   - If executed outside a repository, editing the Team layer MUST be disabled with a descriptive notice.

2. **Editable Keys (exact per layer):**
   - Person layer edits MUST cover, and validate types and shape for:
     - `agents_dir` (path or bundled default).
     - `summary.model` (string identifier; a person-direction key per `SUMMARY_DIRECTION`).
     - `summary.enabled` (boolean).
     - `max_verification_steps` (non-negative integer).
   - Team layer edits MUST cover:
     - `default_base`.
     - `parity_trigger_paths`.
     - `suspicion_priors`.
     - `summary.enabled` (capped).
     - `max_verification_steps` (capped).
   - Watcher layer edits MUST allow configuring `daily_cap`, `window`, and per-repo enrollments (`post`, `on_push`, `max_changed_lines`, `max_changed_files`).

3. **Capped Keys: Accept and Annotate (aligned with C5's `foldKey`):**
   - The editor and `config set` MUST accept any type-valid value for capped Team keys (`summary.enabled`, `max_verification_steps`), including values above the operator's Person ceiling — matching `foldKey` in `src/preflight.ts`, which accepts an over-ceiling repo value and narrows only the effective value, recording provenance `capped` when the ceiling actually binds.
   - After writing, the surface MUST display the effective-value annotation derived from the same merge (e.g. "written: 5 — your effective value remains 3, capped by your Person layer").
   - Rationale: the Team file is shared and committed; the local operator's ceiling is not their teammates' ceiling, so write-time rejection by the local ceiling would block valid team configuration.
   - The cap semantics are unchanged at merge time: the effective value can never exceed the Person-layer ceiling, and the direction stays spend-asymmetric — a team file must not raise the operator's bill; being more frugal is always allowed.
   - Write-time validation is types/shape only, through the existing parsers.

4. **Headless Parity (`pr-hero config set` / `pr-hero config unset`):**
   - `pr-hero config set <key> <value> [--person|--team|--watch]` MUST provide the non-interactive twin of the editor, with the v1 grammar limited to scalar keys, exactly:
     - `summary.enabled` (true/false), `summary.model` (string), `max_verification_steps` (non-negative integer), `agents_dir` (path string), `default_base` (string).
     - `--watch daily_cap <n>` (positive integer).
     - `--watch window <HH:MM-HH:MM>` (single documented string form; parsed to `{start, end}`).
   - `pr-hero config unset <key> [--person|--team|--watch]` MUST remove a key from a layer; unsetting `window` means "always".
   - Arrays and objects (`parity_trigger_paths`, `suspicion_priors`) are interactive-editor-only in v1; the documented headless path for them remains editing the JSON file directly. Per-repo watcher enrollments already have their headless surface in `pr-hero watch add` / `pr-hero watch remove` — that existing parity is the named headless path for them.
   - The layer flag defaults to `--person`; `--team` MUST require running inside a repository, otherwise it MUST fail with a descriptive error.

5. **Validation Machinery (shared, not reimplemented):**
   - Both the editor and `config set`/`unset` MUST reuse `CONFIG_DIRECTION`/`SUMMARY_DIRECTION` and the `mergeConfig` machinery — including for the effective-value annotation; reimplementing direction logic is forbidden.

6. **Writing & Non-Interactive Parity:**
   - Saved configurations MUST be formatted with 2-space indented JSON.
   - Non-interactive reading via `pr-hero config` MUST remain completely read-only and pipeable to stdout, and MUST operate on the global layers only outside a repository.

## Scenarios

### Scenario: Editing Person config interactively
- **GIVEN** a valid `~/.prhero/config.json`
- **WHEN** the user selects Person config in the interactive editor and toggles `summary.enabled`
- **THEN** it validates the input
- **AND** updates `~/.prhero/config.json` with the new value
- **AND** displays confirmation without corrupting other fields.

### Scenario: Over-ceiling Team value is accepted and annotated
- **GIVEN** a Person layer with `max_verification_steps` at 3
- **WHEN** the user runs `pr-hero config set max_verification_steps 5 --team` inside a repository
- **THEN** the Team file is written with 5 (a type-valid value)
- **AND** the surface reports "written: 5 — your effective value remains 3, capped by your Person layer", derived from the same `mergeConfig` merge.

### Scenario: Valid headless set
- **GIVEN** a valid key and value for the selected layer
- **WHEN** the user runs `pr-hero config set`
- **THEN** the value is validated (types/shape) through the existing parsers
- **AND** the target file is written with 2-space indented JSON.

### Scenario: Unsetting the watcher window
- **GIVEN** a configured `window` in `~/.prhero/watch.json`
- **WHEN** the user runs `pr-hero config unset window --watch`
- **THEN** the key is removed with 2-space indented JSON write-back
- **AND** the watcher window now means "always".
