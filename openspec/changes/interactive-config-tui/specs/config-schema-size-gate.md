# Specification: Configurable Size Gate in Configuration Schema

## Requirements

1. **Schema Extension (`LocalConfig` & `ConfigLayer`):**
   - The configuration layer MUST support optional `max_changed_lines` (non-negative integer).
   - The configuration layer MUST support optional `max_changed_files` (non-negative integer).
   - Both keys MUST be allowed in repository configuration (`<repo>/.prhero/config.json`) and personal configuration (`~/.prhero/config.json`).

2. **Merge & Direction Semantics:**
   - `max_changed_lines` and `max_changed_files` MUST use `CONFIG_DIRECTION.capped` with `Math.min` as the narrowing function.
   - When a repository specifies a value greater than the user's personal configuration ceiling, `mergeConfig` MUST return the narrower (smaller) personal value and mark the provenance as `capped`.
   - When only one layer defines the key, that layer's value MUST be returned with the corresponding provenance (`repo` or `global`).
   - When neither layer defines the key, `mergeConfig` MUST return `undefined` with provenance `default`.

3. **Runtime Resolution:**
   - Review preflight and PR preflight MUST resolve `SizeGateConfig` by falling back in order:
     1. Explicit CLI flag (`--max-changed-lines`, `--max-changed-files`) if provided.
     2. Merged `effective.max_changed_lines` / `effective.max_changed_files` from loaded configuration if present.
     3. `DEFAULT_SIZE_GATE` (1500 lines / 150 files).

4. **Headless CLI Parity (`config set` / `config unset`):**
   - `pr-hero config set max_changed_lines <n> [--person|--team]` MUST parse non-negative integer `<n>` and write to the target configuration file.
   - `pr-hero config set max_changed_files <n> [--person|--team]` MUST parse non-negative integer `<n>` and write to the target configuration file.
   - `pr-hero config unset max_changed_lines [--person|--team]` MUST remove the key from the target configuration file.
   - Over-ceiling team writes for `max_changed_lines` and `max_changed_files` MUST follow the accept-and-annotate pattern.

## Scenarios

### Scenario: Repository defines custom line threshold below personal ceiling
- **GIVEN** a repo `.prhero/config.json` with `max_changed_lines: 2500`
- **AND** personal `~/.prhero/config.json` with `max_changed_lines: 5000`
- **WHEN** configuration is merged
- **THEN** `effective.max_changed_lines` MUST be 2500 with provenance `repo`.

### Scenario: Repository defines line threshold above personal ceiling
- **GIVEN** a repo `.prhero/config.json` with `max_changed_lines: 3000`
- **AND** personal `~/.prhero/config.json` with `max_changed_lines: 2000`
- **WHEN** configuration is merged
- **THEN** `effective.max_changed_lines` MUST be 2000 with provenance `capped`.

### Scenario: Setting `max_changed_lines` via CLI
- **GIVEN** a user running `pr-hero config set max_changed_lines 2000 --team`
- **WHEN** the command executes
- **THEN** `.prhero/config.json` MUST be updated with `"max_changed_lines": 2000`
- **AND** formatted with 2-space indentation JSON.
