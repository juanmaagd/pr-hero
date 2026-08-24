# Design: Pillar 1 — Install, Configure & Onboarding in One Flow

Rev 4 (2026-08-24, post Codex review + empirical verification). Authoritative long-form design
with full terrain evidence: `docs/pillar1-distribution-onboarding-design.md`. This artifact
mirrors the decisions and contracts. Codex audited rev 2; its effect-model, slice-order, and
filename-exemption points were already resolved in rev 3 — rev 4 adds the manifest-based assets
rework (`compile.assets` is a silent no-op, verified empirically 2026-08-24 on Bun 1.3.14), the
`setup.json` onboarding state, `selfInvocation()`, gotchas-skip truncation, the tri-state doctor,
digest-based skills sync, adapter capabilities, MCP write hardening, the D6 warning task, and
published-artifact verification (O-16).

## 1. Overview & Architecture

Pillar 1 turns `pr-hero` from a developer-machine prototype into a self-contained, distributable
tool. Root architectural statement: **the compiled standalone binary is a second runtime, not a
packaging detail** — asset resolution, self re-spawn, and provenance all differ inside
`bun build --compile` output, and one module (`src/assets.ts`, fed by `src/asset-manifest.ts`)
owns that difference, including `selfInvocation()` for every "run myself again" site.

```
                  ┌─────────────────────────────────────────────────┐
                  │                pr-hero CLI Entry                │
                  │  (pr-hero / pr-hero init / setup / doctor)      │
                  └───────────────────────┬─────────────────────────┘
                                          │ zero-arg: parser-level TTY gate on ~/.prhero/setup.json
                                          ▼
                  ┌─────────────────────────────────────────────────┐
                  │        Onboarding Wizard (steps as data)        │
                  │                 src/wizard.ts                   │
                  └───┬──────────┬──────────┬──────────┬────────────┘
                      ▼          ▼          ▼          ▼
               ┌──────────┐ ┌─────────┐ ┌────────┐ ┌───────────┐   ┌──────────────┐
               │ System   │ │ Agent   │ │ Skills │ │ Workspace │──▶│ Verification │
               │ Tools    │ │ Env     │ │ & MCP  │ │ + gotchas │   │  (--dry-run) │
               │ (git/    │ │ (claude │ │ (copy+ │ │ + commit- │   │  honest scope│
               │ claude/gh│ │ +stubs, │ │ digest,│ │ vs-ignore │   └──────────────┘
               │ /cg×2)   │ │ caps)   │ │ selfInv│ │ +setup.json│
               └──────────┘ └─────────┘ └────────┘ └───────────┘
        All packaged assets resolve via src/assets.ts ← src/asset-manifest.ts (dev | npm | compiled)
```

## 2. Architectural Decisions (D0 – D9)

- **D0 — Publication (DECIDED 2026-08-24):** full open source; public repo; **Apache-2.0**
  (LICENSE + `package.json.license` + SKILL.md alignment); npm `files` whitelist excluding
  `skills/martian-bench`, `docs/`, `scripts/`, `fixtures/`, `test/`, `openspec/`, `ROADMAP*`;
  claim the free `pr-hero` npm name early; Homebrew post-launch.
- **D1 — Bundled productized prompt set:** original 5 filenames into `prompts/default/`
  (`AGENT_NAMES`/spec/glob patterns intact); branding-only content pass (frontmatter `name:` →
  `pr-hero-*`; stale refs → `.prhero/config.json` / `.prhero/gotchas.md`; `hunting-map.md`
  citations resolved; "golden" dropped); `PROVENANCE.md`; **gates**: `refuter-probe` (refuter file
  edited — repo CLAUDE.md rule) + `fixture-eval`. `resolveAgentsDirSetting` gains the
  `source: "default"` branch; the bundled default **loads via the asset manifest in every mode**;
  `SUGGESTED_AGENTS_DIR` deleted from `preflight.ts:47`/`:1269`, `cli.ts:148`/`:3605`,
  `scripts/martian-cal.ts:27,168`.
- **D2 — Agent-environment axis only:** `AgentEnvAdapter` in `src/agent-env.ts`; environments
  claude (active) + antigravity/opencode/codex/**cursor** (stubs); **groq dropped** (not an agent
  environment). **Adapters declare capabilities** (`{ skills, mcp }`); sync/registration methods
  exist only where the capability is true, and callers consult capabilities before invoking.
  Execution stays Claude-only via `StepRunner` (obligations `step-runner.ts:67-82`); Phase D owns
  new runners.
- **D3 — System tools:** **`claude` is a required tool** (binary + auth — it is the execution
  runtime; `StepRunner` spawns `claude -p`); codegraph reported as `binaryInstalled` **and**
  `repoIndexed` (the engine gates on `existsSync(<repo>/.codegraph)` — `cli.ts:876`/`:1723`);
  `codegraph init` offered in the workspace step; PR-mode worktrees degrade silently to
  `EMPTY_MCP_CONFIG` (documented); installs run only on explicit interactive selection.
- **D4 — Wizard:** steps as data (ordered descriptor array with `probe`/`apply`/`render`); **step
  4 applies**: writes the onboarding state **`~/.prhero/setup.json`**
  (`{ onboarding_version, completed_at }` — the `watch.json` precedent: own file, own schema,
  outside the C5 parsers; **the wizard never writes `~/.prhero/config.json`** — rev 3's `{}`
  marker is removed because a config file's existence conflates "has global config" with
  "completed onboarding"; C5 O-9 stays fully intact; `init --yes` writes the same state; written
  at apply-time so cancelling earlier leaves the machine un-onboarded), scaffolds via the existing
  `init` path, runs the gotchas walk (template passes the fail-loud trim check:
  `preflight.ts:2140-2148` vs `pipeline.ts:665-672`; writes REPLACE placeholders; an **informed
  skip TRUNCATES to empty the file the wizard scaffolded this run** — never a pre-existing file —
  so the CLI gate at `cli.ts:800-807` blocks the first review at $0), and **applies
  commit-vs-ignore** (default commit; both branches dirty the tree, so both end in one consented,
  path-scoped commit — never `commit -a`; pre-existing unrelated dirt → step 5 honest-skips with
  distinguished messages; order: apply → consented commit → dry-run, because the clean-tree gate
  at `cli.ts:735-748` precedes the dry-run exit at `:937`). Machine-level steps are idempotent
  (skip-if-healthy); workspace always evaluates the current repo. Zero-arg is a **parser change**
  (`preflight.ts:695-699`) gated on TTY; "onboarded" = **`setup.json` present with the current
  `onboarding_version`** — a hand-created `~/.prhero/config.json` without `setup.json` still
  counts un-onboarded; full menu deferred to Pillar 2. Completion screen adds `pr-hero doctor` +
  `pr-hero config`.
- **D5 — Packaging:** `src/assets.ts` as single asset authority (dev / npm / compiled).
  **Embedding is manifest-based, permanently**: `src/asset-manifest.ts` imports every packaged
  asset with `import ... with { type: "file" }` and exports a logical-name → path map —
  `compile.assets` is a **silent no-op** on Bun 1.3.14 (verified empirically: build
  `success: true`, binary ships without the assets; `--asset` absent from the CLI help) and is
  used nowhere. Embedded names are content-hashed, so the compiled bundled default cannot pass
  the dir + fixed-filenames loader — it loads via the manifest map in every mode; custom sets
  stay FS-based; bundled-set validation moves to build-time tests (the `Bun.Glob.scan` unknown is
  eliminated). **`selfInvocation()`** (in `src/assets.ts`): dev/npm →
  `{ command: process.execPath, args: [absolute cli.ts] }` (the pair `watch.ts:547-548` already
  uses; the npm shim's `#!/usr/bin/env bun` shebang means even an absolute shim path dies under
  launchd); compiled → `{ command: the binary, args: [] }`; reused by MCP registration, watch, gc,
  and plist rendering. Release workflow: 4-target matrix, tag-baked version, `SHA256SUMS`,
  `--no-compile-autoload-dotenv` **and** `--no-compile-autoload-bunfig` (both default true), the
  Bun build version pinned and aligned with `engines`; npm + binaries publish from the **same
  commit and version** with `npm publish --provenance`; platform decisions recorded (glibc via
  ubuntu-LTS, musl deferred; x64 non-baseline, `-baseline` deferred; macOS ad-hoc signature,
  notarization deferred+documented). **Release-gate smokes:** O-11 per-platform real-binary runs;
  O-16 npm-pack smoke (pack → isolated install → `--help` → fixture dry-run outside the
  checkout).
- **D6 — Model defaults, no fake lock:** calibrated defaults live in bundled frontmatter
  (`sonnet` ×5); `--model` precedence unchanged (`pipeline.ts:1789-1791`), documented
  uncalibrated, plan-card warning when set — **tasked and tested in S4**.
- **D7 — MCP registration:** command **derived from `selfInvocation()`** (never bare `pr-hero`,
  never the shim path); provider CLI preferred with **`claude mcp add --scope user`** (the
  installed CLI defaults to `local`, verified 2026-08-24; remaining details verified at
  implementation); hand-edit fallback **hardened**: atomic same-dir temp+rename, symlink target
  refused (lstat), file mode preserved, backup before first modification, third-party servers
  preserved, single-writer assumption stated; store auto-creation on first query
  (`store.ts:37-56`) is accepted, stated behavior.
- **D8 — Doctor (tri-state, read-only):** every check and the overall result are
  `healthy | degraded | blocking`; blocking (exit 1) = a paid review cannot run (git missing,
  claude missing/unauth, stale `agents_dir` → missing path per `cli.ts:3581`, empty gotchas in
  the current repo); degraded (exit 0 + hints) = gh, codegraph facts, skills/MCP unsynced,
  `setup.json` absent; checks are read-only. The roster grows by slice (S2: tools + config/setup;
  S3 adds env/skills/MCP — each slice complete for itself).
- **D9 — Uninstall:** full footprint documented (binary, watch+gc plists, skills copy,
  `mcpServers.pr-hero`, `~/.prhero/` incl. `setup.json`); command post-v1.
- **Skills sync:** **copy + content-digest marker**, idempotent re-sync on digest mismatch
  (catches local edits and partial copies); engine version is informational metadata only;
  symlink rejected (impossible from a compiled binary's embedded FS).

## 3. Sequence Diagrams

### 3.1 Onboarding Wizard Execution Flow

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant CLI as pr-hero CLI
    participant Wizard as Wizard (steps as data)
    participant Tools as System Tools Checker
    participant Env as ClaudeAgentEnvAdapter
    participant FS as ~/.prhero & <repo>/.prhero
    participant Engine as Review Engine (--dry-run)

    User->>CLI: pr-hero init (or zero-arg, TTY + no setup.json)
    CLI->>Wizard: run(WIZARD_STEPS)
    Wizard->>Tools: checkSystemTools()
    Tools-->>Wizard: git ok · claude ok+auth · gh ok+auth · codegraph binary:yes index:no
    Wizard->>User: Step 1 — offer install / codegraph init (workspace step)
    Wizard->>Env: detect()
    Env-->>Wizard: claude found, auth valid (env|file|session)
    Wizard->>User: Step 2 — environment status, re-probe on demand
    Wizard->>Env: syncSkills(assets) + registerMcpServer(selfInvocation + "mcp")
    Env->>FS: copy pr-hero-triage (digest marker) · claude mcp add --scope user
    Wizard->>User: Step 3 — synced & registered
    Wizard->>FS: APPLY: write setup.json · scaffold .prhero/ · gotchas WALK (skip ⇒ truncate own scaffold)
    Wizard->>FS: APPLY commit-vs-ignore → ONE consented path-scoped commit (never -a)
    Wizard->>User: Step 4 — workspace applied (real gotchas, or informed skip)
    Wizard->>Engine: review --dry-run (clean tree, inside a git repo; else honest skip / expected gotchas block)
    Engine-->>Wizard: config+prompts+plan+cost resolved ($0)
    Wizard->>User: Step 5 — verified; next commands incl. doctor + config printed
```

### 3.2 Environment Detection, Skills Sync & MCP Registration

```mermaid
sequenceDiagram
    autonumber
    participant App as Wizard / doctor
    participant Reg as AgentEnvRegistry
    participant Ad as ClaudeAgentEnvAdapter
    participant Skills as ~/.claude/skills/
    participant Cfg as claude mcp add --scope user → ~/.claude.json

    App->>Reg: get("claude")
    Reg-->>App: adapter (unknown ids → undefined; callers consult capabilities)
    App->>Ad: detect()
    Ad-->>App: { binaryFound, auth { authenticated, tokenSource } }
    App->>Ad: syncSkills(resolveEngineAssets())
    Ad->>Skills: COPY pr-hero-triage + content-digest marker (idempotent)
    App->>Ad: registerMcpServer({ command: <bun|binary>, args: [<cli.ts>?, "mcp"] })
    Ad->>Cfg: provider CLI preferred; fallback hardened atomic edit + backup
    Cfg-->>Ad: third-party mcpServers preserved
    Ad-->>App: { registered: true, configFile }
```

## 4. Component Details & Data Models

### 4.1 `src/assets.ts` (+ `src/asset-manifest.ts`)

```ts
export type AssetMode = "dev" | "npm" | "compiled";

export interface EngineAssets {
  mode: AssetMode;
  bundledAgentFiles: Record<string, string>; // logical filename → path, from the manifest (every mode)
  defaultAgentsDir?: string;                 // real dir in dev/npm; absent when compiled
  scoutPromptPath: string;
  summarizerPromptPath: string;
  triageSkillFiles: Record<string, string>;  // logical filename → path, from the manifest
  version: string;                           // baked at compile; package.json in dev/npm; graceful no-git fallback
}

export function resolveEngineAssets(): EngineAssets;

export interface SelfInvocation {
  command: string; // absolute: the bun binary (dev/npm) or the compiled binary itself
  args: string[];  // [absolute cli.ts] in dev/npm; [] when compiled
}
export function selfInvocation(): SelfInvocation;
```

`src/asset-manifest.ts` holds every `import ... with { type: "file" }` statement and is consumed
only by `src/assets.ts`; a dev-side test asserts manifest ↔ `prompts/default/` parity and that the
manifest-loaded set passes the spec match. Embedded paths are content-hashed — no consumer may
rely on embedded basenames.

### 4.2 `src/agent-env.ts`

```ts
export type AgentEnvId = "claude" | "antigravity" | "opencode" | "codex" | "cursor";
export type AgentEnvStatus = "active" | "detected_inactive" | "coming_soon";

export interface AgentEnvCapabilities {
  skills: boolean;
  mcp: boolean;
}

export interface AgentEnvAuthStatus {
  authenticated: boolean;
  message: string;
  tokenSource?: "env" | "file" | "session";
}

export interface AgentEnvDetection {
  id: AgentEnvId;
  displayName: string;
  status: AgentEnvStatus;
  binaryFound: boolean;
  binaryPath?: string;
  version?: string;
  auth: AgentEnvAuthStatus;
  skillsDir?: string;
  mcpConfigFile?: string;
}

export interface McpRegistration {
  command: string; // SelfInvocation-derived; absolute; never the npm shim, never a bare name
  args: string[];  // [..., "mcp"]
}

export interface AgentEnvAdapter {
  readonly id: AgentEnvId;
  readonly displayName: string;
  readonly capabilities: AgentEnvCapabilities;
  detect(): Promise<AgentEnvDetection>;
  syncSkills?(assets: EngineAssets): Promise<{ synced: string[]; errors: string[] }>;
  registerMcpServer?(reg: McpRegistration): Promise<{ registered: boolean; configFile: string; error?: string }>;
}
```

Stubs declare `{ skills: false, mcp: false }` and omit the optional methods; the wizard and doctor
consult `capabilities` before calling.

### 4.3 `src/system-tools.ts`

```ts
export interface SystemToolStatus {
  installed: boolean;
  version?: string;
  authOk?: boolean;      // gh, claude
  repoIndexed?: boolean; // codegraph — the fact the engine gates on
  hint?: string;
}

export interface SystemTool {
  readonly name: string;
  readonly command: string;
  readonly required: boolean;
  readonly description: string;
  check(cwd: string): Promise<SystemToolStatus>;
  install?(): Promise<{ success: boolean; error?: string }>;
}
```

### 4.4 `src/wizard.ts` — steps as data

```ts
export interface WizardState {
  stepIndex: number;
  selectedIndex: number;
  toolStatuses: Record<string, SystemToolStatus>;
  envDetections: AgentEnvDetection[];
  skillsSynced: boolean;
  mcpRegistered: boolean;
  setupStateWritten: boolean;        // ~/.prhero/setup.json written by step-4 apply
  repoScaffolded: boolean;
  gotchas: { collected: number; informedSkip: boolean; truncatedOnSkip: boolean };
  commitChoice: "commit" | "ignore" | undefined;
  workspaceCommitted: boolean;       // the one consented, path-scoped commit happened
  preexistingDirt: boolean;          // unrelated uncommitted work found in the tree
  dryRun: {
    outcome: "not-run" | "proven" | "honest-skip" | "blocked-on-gotchas";
    proven: string[];
    notProven: string[];
    skippedReason?: string;
  };
  errorMessage?: string;
}

export interface WizardStepDescriptor {
  id: string;   // "system_tools" | "agent_env" | "skills_mcp" | "workspace" | "verification"
  title: string;
  probe(deps: WizardDeps): Promise<Partial<WizardState>>;
  apply(state: WizardState, deps: WizardDeps): Promise<Partial<WizardState>>;
  render(state: WizardState, opts: { styles: boolean; width: number }): string[];
}

export const WIZARD_STEPS: readonly WizardStepDescriptor[];
export function wizardReducer(state: WizardState, action: WizardAction): WizardState;
```

**`apply` lives on the descriptor** — side effects (installs, the setup state, the scaffold, the
consented commit, sync/registration) belong to the step, not to a runner switching on ids.
Machine-level applies are idempotent (skip-if-healthy). House renderer contract applies:
`string[]` return, `{styles,width}` parameters, no TTY sniffing, zero `\x1b` bytes with styles
off (asserted in tests).

### 4.5 `~/.prhero/setup.json`

```json
{ "onboarding_version": 1, "completed_at": "2026-08-24T00:00:00Z" }
```

Own file, own schema, outside the C5 config parsers (the `watch.json` precedent). Written only by
step-4 `apply` and `init --yes`; read by the zero-arg gate and doctor; a version bump re-offers
the wizard.

## 5. Error Handling & Graceful Degradation

- **Non-TTY:** zero-arg keeps today's `CliUsageError` → help + exit 2; `init --non-interactive`/
  `--yes` scaffolds statically (and writes `setup.json`); raw mode is never entered without a TTY.
- **Cancel before step 4 applies:** no `setup.json` — the machine stays un-onboarded and zero-arg
  re-enters the wizard; `pr-hero init` always re-enters regardless.
- **Hand-created config:** `~/.prhero/config.json` existing without `setup.json` still counts
  un-onboarded — the wizard is offered; it never writes or edits the config file.
- **Dirty-tree honesty:** the clean-tree gate (`cli.ts:735-748`) precedes the dry-run exit. The
  wizard's own artifacts get ONE consented path-scoped commit; pre-existing unrelated dirt is
  never committed or stashed — step 5 skips with a message distinguishing the two causes.
- **Gotchas:** collect at least one real gotcha, or an explicit informed skip that TRUNCATES the
  wizard's own scaffold to empty (never a pre-existing file) — the `cli.ts:800-807` gate then
  blocks the first review at $0, and step 5 frames that as the designed blocked-on-gotchas
  outcome, not a failure.
- **Verification honesty:** step 5 reports exactly what `--dry-run` proved (config, prompts, plan,
  cost — $0, inside a git repo) and what it did not (gotchas quality, claude auth, spawn); outside
  a git repo it prints the command to run later. The optional ~$0.04 live auth ping runs only on
  explicit selection.
- **Codegraph:** missing binary or missing index never blocks a review (`EMPTY_MCP_CONFIG`);
  PR-mode worktrees degrade silently — documented, not promised away.
- **MCP/store:** first query on a fresh machine creates `~/.prhero/` + empty schema-v3 store and
  answers with zero rows — accepted behavior, stated in docs.
- **Every failed wizard step** leaves a copy-pasteable manual command.

## 6. Traceability to Named Test Obligations

| Obligation | Target | Description |
|---|---|---|
| **O-1** | `prompts/default/` | 5 productized files (original names) + `PROVENANCE.md`. |
| **O-2** | `src/assets.ts`, `src/preflight.ts`, `src/cli.ts`, `scripts/martian-cal.ts` | Bundled default loads via the asset manifest in every mode; `SUGGESTED_AGENTS_DIR` gone from all four sites; spec match proven at build time. |
| **O-3** | `src/agent-env.ts` | `AgentEnvAdapter` with declared capabilities; `ClaudeAgentEnvAdapter` (detect/auth/skills/MCP). |
| **O-4** | `src/agent-env.ts` | Registry enumerates claude + stubs (no groq); unknown ids → `undefined`; capabilities consulted. |
| **O-5** | `src/system-tools.ts` | git/**claude(required: binary+auth)**/gh(auth)/codegraph(two facts) classified correctly offline. |
| **O-6** | `src/agent-env.ts` | Copy-based skills sync with a content-digest marker; idempotent; digest mismatch triggers re-sync. |
| **O-7** | `src/agent-env.ts` | SelfInvocation-derived MCP registration (`--scope user`), idempotent, third-party servers preserved, hardened atomic fallback. |
| **O-8** | `src/wizard.ts` | All transitions/selections/`apply` outcomes/renders offline — incl. setup-state timing (cancel; hand-created config), the gotchas matrix (truncate-own-scaffold), and the commit-flow matrix; renderer contract upheld. |
| **O-9** | `install.sh` | OS/arch detection, SHA256 verification, `~/.prhero/bin`, idempotent PATH. |
| **O-10** | `package.json` | ADDS `files` (D0 exclusions), `engines` (pinned CI Bun version), `license: "Apache-2.0"`; `private: false`. |
| **O-11** | release pipeline | Each published binary runs `--help` + `review --dry-run` + asset resolution on its platform's runner — packaging features can silently no-op (proven 2026-08-24). |
| **O-12** | `src/cli.ts` doctor | Healthy/degraded/blocking classified offline; blocking → exit 1, otherwise 0; read-only checks. |
| **O-13** | `.github/workflows/release.yml` | Tag-triggered 4-target matrix + `SHA256SUMS`; same-commit/same-version npm + binaries with `--provenance`; autoload-off flags; pinned Bun. |
| **O-14** | `LICENSE`, `package.json`, `SKILL.md` | All say Apache-2.0. |
| **O-15** | `prompts/default/` | refuter-probe + fixture-eval pass; PROVENANCE present; zero deep-review in frontmatter `name:` + body (filenames and PROVENANCE.md exempt); zero stale paths/hunting-map citations/"golden". |
| **O-16** | npm tarball | `npm pack` → isolated-prefix install → `pr-hero --help` → fixture dry-run outside the checkout: the published artifact is executed, not inspected. |
