# Proposal: Review Preflight Config Inheritance & Flags Alignment

## Why

1. **Disconnected Review Preflight State:** When an operator launches `pr-hero menu` and selects `1. Review PR →`, `runReviewMenu` initializes with hardcoded fallback state (`target: "branch"`, `base: "main"`, `post: false`, `scout: false`). It fails to inherit the repository or user-level configuration (such as `default_base`, `scout`, or `post`), forcing operators to reconfigure parameters manually on every interactive run.
2. **Missing `scout` and `post` in Config Schema:** While `summary`, `max_changed_lines`, and `max_verification_steps` can be persisted in `.prhero/config.json` (Repo layer) and `~/.prhero/config.json` (Global/Person layer), `scout` (reconnaissance phase) and `post` (publish comments to PR) only exist as transient CLI flags. Teams cannot establish defaults for their repositories, and individuals cannot set personal preferences across repos.
3. **Invalid Invariant on `post: true` in Branch Mode:** Publishing review comments (`post: true`) requires a GitHub PR context (`target: "pr"`). If an operator or repository defaults `post: true`, the Review Menu initial state must automatically promote `target` from `"branch"` to `"pr"`.
4. **Asymmetric CLI Flag Ergonomics:** `pr-hero review` supports `--scout` and `--post`, but lacks explicit negation flags (`--no-scout` and `--no-post`). Once config persistence is introduced, callers have no way to override a config-defaulted `true` to `false` on the command line.

## What Changes

1. **Schema, Parser & Direction Extension (`src/preflight.ts`):**
   - Extend `LocalConfig` and `ConfigLayer` with `scout?: boolean` and `post?: boolean`.
   - Register `scout: "capped"` and `post: "capped"` in `CONFIG_DIRECTION`. For both boolean settings, `capped` uses logical conjunction narrowing (`(a, b) => a && b`), ensuring a personal ceiling of `false` prevents a committed repo file from forcing unapproved LLM token spend or public GitHub comments.
   - Update `parseConfigLayer` to parse and validate optional `scout` and `post` boolean fields.
   - Update `mergeConfig` to fold `scout` and `post` through `foldKey`, populating `ConfigSources.scout` and `ConfigSources.post`.
   - Update `parseArgs` to support `--scout`, `--no-scout`, `--post`, and `--no-post` with tri-state `scout?: boolean` and `post?: boolean` in `CliOptions`.
   - Add resolvers (`resolveScout`, `resolvePost`) applying the standard precedence: `CLI Flag > Merged Config > Built-in Default (false)`.

2. **Configuration Display & Editor (`src/ui-config.ts`, `src/ui-config-edit.ts`):**
   - Update `configRows` in `src/ui-config.ts` to output `scout` and `post` rows with layer provenance tags and cap markers.
   - Update `getEditableLayerEntries` in `src/ui-config-edit.ts` to expose `scout` and `post` in both Team (`.prhero/config.json`) and Person (`~/.prhero/config.json`) layers.
   - Update `setConfigValue` and `unsetConfigValue` in `src/ui-config-edit.ts` to support boolean toggles and cap annotations for `scout` and `post`.

3. **Interactive Review Menu State Resolution (`src/ui-review-menu.ts`):**
   - Extend `runReviewMenu` dependencies to accept `effectiveConfig?: LocalConfig`, `defaultBase?: string`, `defaultScout?: boolean`, and `defaultPost?: boolean`.
   - Compute initial `ReviewMenuState`:
     - `base`: `deps.defaultBase ?? deps.effectiveConfig?.default_base ?? "main"`
     - `scout`: `deps.defaultScout ?? deps.effectiveConfig?.scout ?? false`
     - `post`: `deps.defaultPost ?? deps.effectiveConfig?.post ?? false`
     - `target`: If initial resolved `post` is `true`, automatically set `target = "pr"`; otherwise default to `"branch"`.

4. **CLI Menu Loop Integration (`src/cli.ts`):**
   - In `menuCommand`, load the effective configuration via `loadEffectiveConfig({ root: repoRoot, home: os.homedir() })`.
   - In `dispatchAction("review")`, pass the loaded `effectiveConfig` and resolved defaults into `runReviewMenu`.

## Capabilities

### New Capabilities
- `review-preflight-config-inheritance`: Inherit base branch, scout stage, and PR comment posting preferences from `.prhero/config.json` and `~/.prhero/config.json` into the interactive review preflight menu and headless CLI execution.

### Modified Capabilities
- `pr-hero review`: Supports `--no-scout` and `--no-post` flags; resolves execution settings by layering CLI flags over merged configuration.
- `pr-hero config`: Displays `scout` and `post` configuration rows with layer provenance.
- `pr-hero config set/unset`: Supports mutating `scout` and `post` keys in repo and person layers.
- `pr-hero menu`: Option 1 ("Review PR") inherits repo/global configuration defaults and auto-promotes target to PR when posting is enabled.

## Impact & Risk Assessment

- **Backward Compatibility:** Completely backward compatible. Existing config files that do not specify `scout` or `post` evaluate to `undefined` and fall back to `false`. CLI flags continue to have highest precedence.
- **Blast Radius:** `src/preflight.ts`, `src/cli.ts`, `src/ui-review-menu.ts`, `src/ui-config.ts`, `src/ui-config-edit.ts`, and corresponding test suites.
- **Rollback Plan:** Revert the commits; configuration files without `scout`/`post` remain valid JSON.

## Verification Strategy

- Offline unit and integration tests executing under `bun test`.
- Assert zero ANSI escape sequences in UI renderers when `styles: false`.
- Full typecheck (`bun run typecheck`) and Biome linter pass (`./node_modules/.bin/biome check src test`).
