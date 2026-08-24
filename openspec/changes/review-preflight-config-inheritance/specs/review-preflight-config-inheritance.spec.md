# Specification: Review Preflight Config Inheritance & Flags Alignment

## Requirements

### 1. Schema & Configuration Direction
1. **Schema Definition:**
   - `LocalConfig` and `ConfigLayer` (in `src/preflight.ts`) MUST include optional boolean fields:
     - `scout?: boolean`
     - `post?: boolean`
2. **Direction Table & Admittance:**
   - `CONFIG_DIRECTION` MUST register:
     - `scout: "capped"`
     - `post: "capped"`
   - `parseLocalConfig` and `parseGlobalConfig` MUST admit `scout` and `post`.
   - `parseConfigLayer` MUST validate that `scout` and `post` (if present) are boolean values (`typeof val === "boolean"`). Non-boolean values MUST cause `CliUsageError` naming the offending file (e.g. `.prhero/config.json scout must be a boolean`).
3. **Merge & Provenance Resolution (`mergeConfig`):**
   - For `scout` and `post`, folding MUST use logical conjunction `(a: boolean, b: boolean) => a && b` as the narrowing function:
     - If both layers specify `true`, effective value is `true` with `source: "repo"`.
     - If both layers specify `false`, effective value is `false` with `source: "repo"`.
     - If Global specifies `false` and Repo specifies `true`, effective value is `false` with `source: "capped"`.
     - If Global specifies `true` and Repo specifies `false`, effective value is `false` with `source: "repo"`.
     - If only one layer specifies the key, effective value matches that layer with `source: "global"` or `source: "repo"`.
     - If neither layer specifies the key, effective value is `undefined` with `source: "default"`.

### 2. Configuration Inspection & Interactive Editing
1. **Inspection Rows (`src/ui-config.ts`):**
   - `configRows(effective, sources)` MUST include rows for `scout` and `post`:
     - Key `scout`: value `effective.scout?.toString()` (or `"(unset)"` if undefined), with `sources.scout`.
     - Key `post`: value `effective.post?.toString()` (or `"(unset)"` if undefined), with `sources.post`.
   - When rendered via `renderConfig`, capped boolean values MUST display the cap marker (`← narrowed by the global ceiling`).
2. **Interactive Editor (`src/ui-config-edit.ts`):**
   - `getEditableLayerEntries` MUST include `scout` and `post` entries of `type: "boolean"` for both `"team"` (Repo) and `"person"` (Global) layers.
   - `setConfigValue` MUST support `scout` and `post` with string values `"true"` / `"false"`:
     - When writing to `"team"` layer while `"person"` layer has the key set to `false`, it MUST return an annotation warning: `"written: true — your effective value remains false, capped by your Person layer"`.
   - `unsetConfigValue` MUST remove `scout` or `post` from the respective layer file.

### 3. Review Menu Preflight State Resolution (`src/ui-review-menu.ts`)
1. **Dependency Signature Extension:**
   - `runReviewMenu` options/deps MUST accept:
     - `effectiveConfig?: LocalConfig`
     - `defaultBase?: string`
     - `defaultScout?: boolean`
     - `defaultPost?: boolean`
2. **Initial State Computation:**
   - `base` MUST resolve in order: `deps.defaultBase ?? deps.effectiveConfig?.default_base ?? "main"`.
   - `scout` MUST resolve in order: `deps.defaultScout ?? deps.effectiveConfig?.scout ?? false`.
   - `post` MUST resolve in order: `deps.defaultPost ?? deps.effectiveConfig?.post ?? false`.
   - `target` MUST auto-promote to `"pr"` if the initial resolved `post` is `true`; otherwise default to `"branch"`.
3. **Interactive Menu Invariants:**
   - Toggling `target` from `"pr"` to `"branch"` MUST force `state.post = false`.
   - Toggling `post` from `false` to `true` while `target` is `"branch"` MUST auto-promote `target` to `"pr"`.
   - Activating `[ Start review ]` MUST forward the resolved `state.base`, `state.head`, `state.pr`, `state.post`, `state.scout`, `state.force`, `state.full`, and `state.dryRun` in `CliOptions`.

### 4. CLI Flags & Preflight Execution (`src/preflight.ts`, `src/cli.ts`)
1. **CLI Flags Support:**
   - `parseArgs` MUST parse:
     - `--scout` -> `options.scout = true`
     - `--no-scout` -> `options.scout = false`
     - `--post` -> `options.post = true`
     - `--no-post` -> `options.post = false`
   - `CliOptions.scout` and `CliOptions.post` MUST be tri-state (`boolean | undefined`).
2. **Execution Resolution Precedence:**
   - Scout resolution (`resolveScout`): `options.scout ?? config.scout ?? false`.
   - Post resolution (`resolvePost`): `options.post ?? config.post ?? false`.
   - If `--post` is explicitly passed without `--pr`, `parseArgs` MUST throw `CliUsageError("--post publishes the review as a PR comment, so it requires --pr")`.
3. **Menu Loop Integration (`src/cli.ts`):**
   - `menuCommand` MUST load effective configuration via `loadEffectiveConfig({ root: repoRoot, home: os.homedir() })`.
   - `dispatchAction("review")` MUST forward `effectiveConfig: loaded.effective` (and any contextual `defaultBase`) to `runReviewMenu`.

---

## Requirement Matrix & Resolution Rules

| Scenario / Setting | Global Layer | Repo Layer | CLI Flag | Effective Run Value | Menu Initial State | Provenance |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Scout: Unconfigured** | unset | unset | none | `false` | `scout: false` | `default` |
| **Scout: Repo enabled** | unset | `true` | none | `true` | `scout: true` | `repo` |
| **Scout: Capped by Global** | `false` | `true` | none | `false` | `scout: false` | `capped` |
| **Scout: CLI Flag Override** | `false` | `false` | `--scout` | `true` | N/A (CLI mode) | `global` (flag overrides run) |
| **Scout: CLI Negation** | `true` | `true` | `--no-scout` | `false` | N/A (CLI mode) | `repo` (flag overrides run) |
| **Post: Repo enabled** | unset | `true` | none | `true` | `target: "pr", post: true` | `repo` |
| **Post: Capped by Global** | `false` | `true` | none | `false` | `target: "branch", post: false` | `capped` |
| **Post: Global enabled** | `true` | unset | none | `true` | `target: "pr", post: true` | `global` |
| **Base: Config default** | N/A (repo-only) | `"develop"` | none | `"develop"` | `base: "develop"` | `repo` |

---

## Scenarios

### Scenario 1: Initializing Review Menu with inherited `default_base`, `scout`, and `post`
- **GIVEN** `.prhero/config.json` specifies:
  ```json
  {
    "default_base": "develop",
    "scout": true,
    "post": true
  }
  ```
- **AND** `~/.prhero/config.json` does not override `scout` or `post`
- **WHEN** the operator opens `pr-hero menu` and selects `1. Review PR →`
- **THEN** `runReviewMenu` initializes with:
  - `state.base === "develop"`
  - `state.scout === true`
  - `state.post === true`
  - `state.target === "pr"` (auto-promoted due to `post: true`)
- **AND** the rendered card displays `Target: Current PR`, `Base: develop`, `Post to PR: [✓] Yes`, and `Scout stage: [✓] Enabled`.

### Scenario 2: Capped boolean prevents unapproved posting or token spend
- **GIVEN** `~/.prhero/config.json` contains:
  ```json
  {
    "scout": false,
    "post": false
  }
  ```
- **AND** `.prhero/config.json` in current repo contains:
  ```json
  {
    "scout": true,
    "post": true
  }
  ```
- **WHEN** `mergeConfig` folds the two layers
- **THEN** `effective.scout === false` with `sources.scout === "capped"`
- **AND** `effective.post === false` with `sources.post === "capped"`
- **AND** `pr-hero config` displays:
  - `scout false  ← narrowed by the global ceiling`
  - `post  false  ← narrowed by the global ceiling`
- **AND** `runReviewMenu` initializes with `state.scout === false`, `state.post === false`, and `state.target === "branch"`.

### Scenario 3: Overriding config via CLI flags
- **GIVEN** `.prhero/config.json` contains `"scout": true` and `"post": true`
- **WHEN** the user executes `pr-hero review --pr 42 --no-scout --no-post`
- **THEN** the review preflight resolves `scout === false` and `post === false`
- **AND** discovery runs without the scout reconnaissance phase and findings are not posted as PR comments.

### Scenario 4: Switching targets in the Review Menu
- **GIVEN** the review menu initialized with `target: "pr"` and `post: true`
- **WHEN** the user navigates to `Target` (cursor 0) and presses `Space` to switch to `"branch"`
- **THEN** `state.target` becomes `"branch"`
- **AND** `state.post` automatically transitions to `false`.
- **WHEN** the user navigates to `Post to PR` (cursor 2) and presses `Space`
- **THEN** `state.post` becomes `true`
- **AND** `state.target` automatically transitions back to `"pr"`.
