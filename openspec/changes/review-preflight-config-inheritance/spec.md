# Specification: Review Preflight Config Inheritance & Flags Alignment

Refer to the complete formal specification under [review-preflight-config-inheritance.spec.md](file:///Users/juanma/Desktop/pr-hero/openspec/changes/review-preflight-config-inheritance/specs/review-preflight-config-inheritance.spec.md).

## Summary of Requirements

1. **Schema & Direction (`src/preflight.ts`):**
   - Add `scout?: boolean` and `post?: boolean` to `LocalConfig` and `ConfigLayer`.
   - Register `scout: "capped"` and `post: "capped"` in `CONFIG_DIRECTION` using `(a, b) => a && b` conjunction narrowing.
   - Parse and validate `scout` and `post` in `parseConfigLayer` for both `parseLocalConfig` and `parseGlobalConfig`.
   - Fold `scout` and `post` in `mergeConfig` with provenance tracking (`global`, `repo`, `capped`, `default`).

2. **UI Config Card & Inspection (`src/ui-config.ts`, `src/ui-config-edit.ts`):**
   - Map `scout` and `post` to table rows in `configRows`.
   - Expose `scout` and `post` boolean toggles in `getEditableLayerEntries` for Team and Person layers.
   - Implement `setConfigValue` and `unsetConfigValue` with cap annotations.

3. **Review Menu State Resolution (`src/ui-review-menu.ts`):**
   - Extend `runReviewMenu` to accept `effectiveConfig?: LocalConfig`, `defaultBase?: string`, `defaultScout?: boolean`, `defaultPost?: boolean`.
   - Compute initial state:
     - `base = deps.defaultBase ?? deps.effectiveConfig?.default_base ?? "main"`
     - `scout = deps.defaultScout ?? deps.effectiveConfig?.scout ?? false`
     - `post = deps.defaultPost ?? deps.effectiveConfig?.post ?? false`
     - `target = post ? "pr" : "branch"` (auto-promotion when `post === true`).
   - Preserve target/post invariants during toggling.

4. **CLI Flags & Menu Loop Integration (`src/cli.ts`):**
   - Parse `--scout`, `--no-scout`, `--post`, `--no-post` into tri-state `CliOptions`.
   - Preflight resolution precedence: `CLI Flag > Merged Config > Default (false)`.
   - `menuCommand` loads effective config and forwards it to `runReviewMenu`.
