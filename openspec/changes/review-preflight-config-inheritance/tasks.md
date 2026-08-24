# Tasks: Review Preflight Config Inheritance & Flags Alignment

Ordering rule (OpenSpec `strict_tdd`): every phase starts by writing that phase's failing offline tests, then implements until all tests pass without regressions.

## Phase 1: Config Schema, Direction, Parser & Merge

- [x] 1.1 Write failing tests in `test/preflight.test.ts` for:
  - `LocalConfig` and `ConfigLayer` schema supporting optional `scout` and `post` booleans.
  - `CONFIG_DIRECTION` containing `scout: "capped"` and `post: "capped"`.
  - `parseLocalConfig` and `parseGlobalConfig` admitting boolean `scout` and `post`, and throwing `CliUsageError` on non-boolean values.
  - `mergeConfig` folding `scout` and `post` using `(a, b) => a && b` conjunction narrowing (including `"capped"` provenance when global is `false` and repo is `true`, `"repo"` when both agree or repo alone specifies, `"global"` when global alone specifies, and `"default"` when unset).
- [x] 1.2 Implement schema updates, direction entries, parser validators, and merge folds in `src/preflight.ts`. Verify all Phase 1 tests pass.

## Phase 2: CLI Flags Parsing & Tri-State Resolvers

- [x] 2.1 Write failing tests in `test/preflight.test.ts` and `test/cli.test.ts` for:
  - `parseArgs` recognizing `--scout`, `--no-scout`, `--post`, and `--no-post`.
  - Tri-state `CliOptions.scout` and `CliOptions.post` (`boolean | undefined`).
  - Preflight resolver functions (`resolveScout`, `resolvePost`) respecting precedence: `CLI flag > Merged Config > Default (false)`.
  - Validation maintaining `--post` requiring `--pr` in CLI execution mode.
- [x] 2.2 Implement `--no-scout` and `--no-post` flags in `parseArgs` and resolver functions in `src/preflight.ts` / `src/cli.ts`. Verify all Phase 2 tests pass.

## Phase 3: UI Config Inspection & Interactive Card Editor

- [x] 3.1 Write failing tests in `test/ui-config.test.ts` for:
  - `configRows` including `scout` and `post` rows with correct layer provenance tags and values (`true`, `false`, `(unset)`).
  - `renderConfig` outputting cap marker (`← narrowed by the global ceiling`) when `scout` or `post` provenance is `"capped"`.
  - Zero ANSI `\x1b` bytes generated when `styles: false`.
- [x] 3.2 Write failing tests in `test/ui-config-edit.test.ts` for:
  - `getEditableLayerEntries` exposing `scout` and `post` boolean items in both `"team"` and `"person"` layers.
  - `setConfigValue` modifying `scout` and `post` in `.prhero/config.json` and `~/.prhero/config.json`.
  - Cap annotation generated when setting `"team"` to `true` while `"person"` is `false`.
  - `unsetConfigValue` removing `scout` and `post` keys.
- [x] 3.3 Implement inspection rows in `src/ui-config.ts` and interactive editor support in `src/ui-config-edit.ts`. Verify all Phase 3 tests pass.

## Phase 4: Review Menu State Resolution & Target Auto-Promotion

- [x] 4.1 Write failing tests in `test/ui-review-menu.test.ts` for:
  - `runReviewMenu` accepting `effectiveConfig?: LocalConfig`, `defaultBase?: string`, `defaultScout?: boolean`, and `defaultPost?: boolean`.
  - Initial `ReviewMenuState` resolution resolving `base`, `scout`, and `post` from `effectiveConfig`.
  - Auto-promotion: `state.target` initializes to `"pr"` when initial `post === true`, otherwise `"branch"`.
  - Invariant preservation: toggling target to `"branch"` resets `post` to `false`; toggling `post` to `true` auto-promotes target to `"pr"`.
  - Launch outcome forwarding resolved `CliOptions` matching configured/modified state.
  - Zero ANSI `\x1b` escape sequences when `styles: false`.
- [x] 4.2 Implement dependency extensions, initial state resolution, and target auto-promotion in `runReviewMenu` (`src/ui-review-menu.ts`). Verify all Phase 4 tests pass.

## Phase 5: CLI Menu Loop Dispatch Integration

- [x] 5.1 Write failing tests in `test/cli.test.ts` for `menuCommand` / `runMenuLoop` loading effective configuration with `loadEffectiveConfig` and forwarding `effectiveConfig` and defaults to `runReviewMenu`.
- [x] 5.2 Wire `loadEffectiveConfig` and `runReviewMenu` invocation in `src/cli.ts`. Verify all Phase 5 tests pass.

## Phase 6: Quality Gate & Full Verification

- [x] 6.1 Run full offline test suite (`bun test`).
- [x] 6.2 Run TypeScript typecheck (`bun run typecheck`).
- [x] 6.3 Run Biome linter check (`./node_modules/.bin/biome check src test`).
