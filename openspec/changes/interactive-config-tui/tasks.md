# Tasks: Interactive Config TUI & Configurable Size Gate

Ordering rule (openspec `strict_tdd`): every phase starts by writing that phase's failing offline tests, then implements until they pass.

## Phase 1: Config Schema Extension & Size Gate Integration

- [x] 1.1 Write failing tests in `test/preflight.test.ts` for `max_changed_lines` and `max_changed_files` in `LocalConfig`, `ConfigLayer`, `parseLocalConfig`, `parseGlobalConfig`, `CONFIG_DIRECTION.capped`, and `mergeConfig` (including capped annotation & narrower-wins resolution).
- [x] 1.2 Write failing tests in `test/size-gate.test.ts` and `test/cli.test.ts` for `resolveSizeGateConfig` picking up config layer values before falling back to `DEFAULT_SIZE_GATE`.
- [x] 1.3 Implement schema updates in `src/preflight.ts` and wire size gate resolution in `src/cli.ts` / `src/size-gate.ts`.
- [x] 1.4 Update `setConfigValue` and `unsetConfigValue` in `src/ui-config-edit.ts` to support `max_changed_lines` and `max_changed_files`; add tests in `test/ui-config-edit.test.ts`. Make all Phase 1 tests pass.

## Phase 2: Interactive Config TUI Renderers & Controls

- [x] 2.1 Write failing tests in `test/ui-config-edit.test.ts` for pure renderers (`renderConfigCard`, `renderConfigHeader`, `renderConfigFooter`), testing scalar filter (complex arrays omitted), layer tabs, annotations, and asserting zero ANSI `\x1b` bytes when `styles: false`.
- [x] 2.2 Write failing tests for pure mutation helpers (`stepNumericValue`, `toggleBooleanValue`, `cycleStringPreset`).
- [x] 2.3 Implement pure renderers and helper functions in `src/ui-config-edit.ts`. Make all Phase 2 tests pass.

## Phase 3: Interactive Config Submenu Event Loop & TUI Dispatch Integration

- [x] 3.1 Write failing tests in `test/ui-menu.test.ts` for `runConfigSubmenu` keyboard loop with fake `KeyReader` (navigation `j`/`k`, toggle `Space`, stepper `←`/`→`, unset `u`, layer switch `Tab`/`1-3`, exit `q`/`Esc`).
- [x] 3.2 Implement `runConfigSubmenu` in `src/ui-menu.ts` (or `src/ui-config-edit.ts`).
- [x] 3.3 Wire `dispatchAction("config")` in `src/cli.ts` to invoke `runConfigSubmenu` and return `"back"`. Make all Phase 3 tests pass.

## Phase 4: Quality, Types & Verification

- [x] 4.1 Run full offline test suite (`bun test`).
- [x] 4.2 Run typecheck (`bun run typecheck`) and Biome check (`./node_modules/.bin/biome check src test`).
