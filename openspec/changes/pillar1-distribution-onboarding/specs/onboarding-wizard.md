# Specification: Onboarding Wizard, System Tool Checkers & Doctor

Rev 4 (2026-08-24, post Codex review + empirical verification).

## 1. System Tool Checkers

### 1.1 Requirements

- `src/system-tools.ts` **MUST** define `SystemTool` with `check(cwd)` returning
  `SystemToolStatus { installed, version?, authOk?, repoIndexed?, hint? }` and an optional
  `install()`.
- Checkers:
  1. **`git`** — `required: true`; missing git is fatal with installation instructions.
  2. **`claude`** — `required: true`; **the EXECUTION runtime**, not an IDE preference:
     `StepRunner` spawns `claude -p` for every hunter/refuter step, so a user on any agent
     environment (Cursor included) still needs the binary and working auth to run a paid review.
     Reports binary presence AND auth status, with the exact actionable command when
     unauthenticated. This is a different axis from step 2's environment detection (D2) — the two
     are never merged.
  3. **`gh`** — optional (PR mode only); reports binary presence AND `gh auth status`.
  4. **`codegraph`** — optional; **MUST** report TWO facts: `installed` (binary) and
     `repoIndexed` (`existsSync(<repo>/.codegraph)`), because the engine's real gate is the
     per-repo index (`src/cli.ts:876`, `:1723`), not the binary. A status that only checks
     `codegraph --version` is non-compliant.
- When codegraph is unavailable (either fact false), reviews **MUST** proceed with
  `EMPTY_MCP_CONFIG` (`src/cli.ts:337`) — never a hard failure. PR-mode worktrees start unindexed
  and degrade silently; the wizard **MUST NOT** promise codegraph coverage in PR mode.
- `install()` actions run **only** on explicit interactive selection, never automatically. On
  Linux without Homebrew, the checker prints the manual installation command and continues —
  `brew` is never assumed universal.

### 1.2 Scenarios

#### Scenario 1.1: Binary present, repo unindexed
- **Given** `codegraph` on PATH and no `<repo>/.codegraph/`
- **When** `checkSystemTools()` runs in that repo
- **Then** codegraph reports `installed: true, repoIndexed: false` with a hint offering
  `codegraph init` (surfaced in the workspace step).

#### Scenario 1.2: Missing codegraph never blocks
- **Given** no codegraph binary
- **When** a review runs
- **Then** preflight writes `EMPTY_MCP_CONFIG` and the review proceeds.

#### Scenario 1.3: Claude unauthenticated is required-and-actionable
- **Given** the `claude` binary on PATH but no working auth
- **When** `checkSystemTools()` runs
- **Then** claude reports `installed: true, authOk: false` with the actionable auth command, and
  the wizard cannot report the machine review-ready while a required tool is unhealthy.

---

## 2. Wizard State Machine — steps as data, applies instead of recording

### 2.1 Requirements

- `src/wizard.ts` **MUST** define the wizard as an ordered array of step descriptors
  (`WIZARD_STEPS: readonly WizardStepDescriptor[]` with `id`, `title`, `probe`, **`apply`**,
  `render`), not a hardcoded step union — adding a future step is adding an entry. **Side effects
  live on the descriptor's `apply`**, never in the runner: a runner that switches on step ids is
  non-compliant. `WizardState` **MUST** be a fully defined interface (not only `Partial`
  references).
- The pure reducer and every render **MUST** be offline-testable; renderers return `string[]`,
  take `{ styles, width }`, never sniff the TTY, and emit zero `\x1b` bytes with styles off
  (asserted in tests) — the house renderer contract.
- **Idempotency:** machine-level steps (system tools, claude auth, the setup state, skills, MCP)
  **MUST** skip when already healthy; the workspace step always evaluates the CURRENT repo;
  re-running `init` in a configured repo **MUST** preserve the existing never-overwrite behavior.
  A second repo's wizard run performs real work only in the workspace and verification steps.
- Steps consult adapter **capabilities** (`agent-env.md §1`) before invoking optional
  sync/registration methods.
- v1 steps, in order:
  1. **System tools** — probe + optional interactive installs (git, claude, gh, codegraph).
  2. **Agent environment** — detect claude (+ stubs), surface auth status with the exact
     actionable commands, allow re-probe without restarting.
  3. **Skills & MCP** — copy-sync `pr-hero-triage` (content-digest marker), register the MCP
     server with the SelfInvocation-derived command.
  4. **Workspace** — APPLY: the onboarding state (`setup.json`), the repo scaffold, the **gotchas
     walk**, the **commit-vs-ignore decision**, and the `codegraph init` offer (see §2.1.1).
  5. **Verification** — the honest dry-run (see §3).

#### 2.1.1 Step 4 — workspace apply mechanics

- **The onboarding state:** step 4's `apply` **MUST** write **`~/.prhero/setup.json`** —
  `{ "onboarding_version": 1, "completed_at": "<ISO>" }` — its own file with its own schema,
  OUTSIDE the C5 config parsers (the `watch.json` precedent). The wizard **MUST NOT** write
  `~/.prhero/config.json` — a config file's existence conflates "has global config" with
  "completed onboarding" (a hand-created config would hide the wizard; a wizard-created `{}`
  would misrepresent a hand-rolled machine as onboarded). C5 O-9 ("init never writes the global
  file") stays fully intact. `init --yes` **MUST** write the same state file. The state is
  written **at apply-time**: cancelling before step 4 applies leaves the machine un-onboarded.
  machineReady = `setup.json` present with the current `onboarding_version`; a version bump in a
  future revision re-offers the wizard.
- **Repo scaffold:** the existing `init` path (`initConfigTemplate` — verified: it always seeds
  `default_base` from the remote-head resolution with `--base` winning, seeds
  `parity_trigger_paths: []` and `suspicion_priors: []`, seeds `summary` unless the global layer
  supplies it, and never overwrites existing files). Post-S1 the template **MUST** omit
  `agents_dir` when the source is the bundled default — a machine path committed to the TEAM file
  is worse than the npm-prefix bug.
- **`default_base` is the ONE extra question:** show the seeded value, allow override — a wrong
  base branch reviews the wrong range. No other config key is collected interactively in v1.
- **Gotchas walk (mandatory):** `GOTCHAS_TEMPLATE` (`src/preflight.ts:2140-2148`) PASSES the
  pipeline's fail-loud trim check (`src/pipeline.ts:665-672`), so placeholder bullets would be
  injected verbatim into every hunter's system prompt. The wizard **MUST** collect at least one
  real gotcha, or record an explicit informed skip. Scaffolding the template and moving on
  silently is non-compliant (`ROADMAP.md:146-147`: "a starter is not a skip").
- **Writing collected gotchas MUST REPLACE the template's placeholder bullets, never append
  after them** — appending would leave the `<subsystem>: <...>` placeholders alive in the file,
  re-creating the exact injection hazard the walk exists to prevent. After a write, `gotchas.md`
  contains the template header plus only real, user-authored bullets.
- **An informed skip MUST TRUNCATE to empty the `gotchas.md` the wizard scaffolded THIS RUN** —
  and **MUST NOT** touch a pre-existing user `gotchas.md` (explicit guard). Emptiness is the safe
  skip state: the CLI gate at `src/cli.ts:800-807` (which runs BEFORE the dry-run exit at `:937`;
  PR-mode mirror `:1206-1212`) then blocks the first review at $0 with `gotchasErrorMessage`, so
  no placeholder can ever reach a paid prompt. workspaceReady stays false and doctor reports
  gotchas pending.
- **Commit-vs-ignore is APPLIED, not recorded.** Default is **commit** (`.prhero/` is the team
  layer, meant to be in git); ignore is the explicit opt-out. **Both branches leave the tree
  dirty**: writing or appending `.gitignore` is itself an uncommitted change, and `git add` alone
  still shows staged entries in porcelain. Therefore both branches **MUST** end in **one
  explicitly consented, path-scoped commit** — `git add .prhero/` (or the `.gitignore` edit)
  committed with an explicit pathspec, **never `git commit -a`**, never touching unrelated files.
  Declined consent → step 5 honest-skips with the exact commands.
- **Pre-existing dirt:** if the tree already carries unrelated uncommitted work, step 5
  **MUST** honest-skip regardless of consent — the wizard never commits or stashes user changes.
  The skip message **MUST** distinguish "your `.prhero/` needs committing (the wizard can do
  that)" from "you have unrelated uncommitted work (commit or stash it, then run
  `pr-hero review --dry-run` yourself)".
- **Load-bearing order: apply → consented commit → dry-run.** The clean-tree gate
  (`git status --porcelain`, `src/cli.ts:735-748`) runs BEFORE the dry-run exit (`:937-943`) and
  throws on any output, untracked `??` included — `INIT_GIT_REMINDER`
  (`src/preflight.ts:2131-2138`) documents exactly this connection.

#### 2.1.2 The v1 config matrix (six existing keys; unknown keys are fatal by design)

| Surface | Wizard v1 | Why |
|---|---|---|
| `~/.prhero/setup.json` | Write at step-4 apply | The onboarding state, versioned; cancel-before leaves it absent |
| `~/.prhero/config.json` | **Never written by the wizard** | Pure config; C5 O-9 intact; keys via `pr-hero config` later |
| `summary.*`, `max_verification_steps` | Omit (code defaults) | Capped keys are Pillar 2; `pr-hero config` later |
| `<repo>/.prhero/config.json` | Existing `initConfigTemplate` | Seeds `default_base` (remote head), `[]` arrays, summary-unless-global; omits `agents_dir` on the bundled default |
| `default_base` | Show + allow override | The one extra question — wrong branch = wrong range |
| `parity_trigger_paths` / `suspicion_priors` | Seed `[]`, do not collect | Repo-specific; completion screen points at `pr-hero config` |
| `.prhero/gotchas.md` | Walk; REPLACE placeholders; skip TRUNCATES own scaffold | §2.1.1 + the `cli.ts:800-807` gate |
| Commit vs ignore | Apply; default commit | The clean-tree gate |
| `codegraph init` | Offer when binary-yes/index-no | D3 |
| `~/.prhero/watch.json` | Never touched | The only unattended-spend opt-in; completion prints `pr-hero watch add` |
| Size gate / scout / hop-budget / `--model` / `--post` | Not collected | Flags or Pillar 2; scout has no config key on purpose |
| MCP `--socket` / `--db` | Not collected | Power-user; homedir defaults suffice |

New config keys remain a C5 change, never a wizard change — Pillar 2 menus bind to
`CONFIG_DIRECTION`, and nothing may teach the wizard a parallel key list.

- Keyboard model: Up/Down navigate, Space toggles, Enter confirms, Esc/q/Ctrl+C aborts cleanly
  restoring terminal mode (raw-mode handling per `src/ui-select.ts`).
- Non-TTY: the wizard is never entered; `init` falls back to the static scaffold (plus the setup
  state) without touching raw mode.

### 2.2 Scenarios

#### Scenario 2.1: Step progression is data-driven
- **Given** the initial state on `WIZARD_STEPS[0]`
- **When** each step confirms
- **Then** the reducer advances through the descriptor array in order to `completed`, and
  inserting a hypothetical extra descriptor in a test advances through it with no reducer change.

#### Scenario 2.2: Gotchas walk collects, or skip truncates
- **Given** the workspace step with the template-only `gotchas.md` the wizard scaffolded this run
- **When** the user chooses to skip writing real gotchas
- **Then** the state records an informed skip, the scaffolded file is TRUNCATED to empty (a
  pre-existing user `gotchas.md` would never be touched), and the rendered view explains that the
  first review will stop at the gotchas gate until real ones are written; choosing to write
  REPLACES the template's placeholder bullets with the collected ones, so no
  `<subsystem>: <...>` placeholder survives either path.

#### Scenario 2.3: Non-TTY fallback
- **Given** `process.stdin.isTTY` is false
- **When** `pr-hero init` runs
- **Then** static scaffolding executes (including writing `setup.json`) and no raw-mode call
  occurs.

#### Scenario 2.4: The onboarding state is written at apply-time
- **Given** a fresh machine with no `~/.prhero/setup.json`
- **When** step 4 applies
- **Then** `setup.json` exists with the current `onboarding_version` and a `completed_at`
  timestamp, and `~/.prhero/config.json` was NOT created or modified.

#### Scenario 2.5: Cancel before step 4 leaves the machine un-onboarded
- **Given** a fresh machine and a wizard cancelled at step 2
- **When** `pr-hero` runs again with no arguments in a TTY
- **Then** no `setup.json` was written, the machine still counts un-onboarded, and the wizard
  re-enters.

#### Scenario 2.6: Hand-created config does not hide the wizard
- **Given** a user who hand-created `~/.prhero/config.json` (e.g. to set `summary.model`) and has
  no `setup.json`
- **When** `pr-hero` runs with no arguments in a TTY
- **Then** the machine counts un-onboarded and the wizard is offered — and completing it writes
  `setup.json` without touching the user's config file.

#### Scenario 2.7: Consented commit is path-scoped
- **Given** step 4 applied the scaffold and the user consents to the default commit
- **When** the commit runs
- **Then** exactly the wizard-created paths (`.prhero/` or the `.gitignore` edit) are staged and
  committed with an explicit pathspec — never `commit -a` — and step 5 then finds a clean tree.

#### Scenario 2.8: Pre-existing dirt is never touched
- **Given** the tree has unrelated uncommitted changes before the wizard runs
- **When** step 4 completes (with or without consent) and step 5 is reached
- **Then** the wizard commits nothing beyond its own paths (and nothing at all if consent was
  declined), and step 5 reports an honest skip whose message distinguishes the wizard-committable
  `.prhero/` case from the user's unrelated work.

---

## 3. Verification Step (honest scope)

### 3.1 Requirements

- Step 5 **MUST** run only after step 4's apply → consented commit (order is load-bearing —
  §2.1.1). It runs `pr-hero review --dry-run` semantics and reports **exactly what was proven**:
  config resolution, bundled prompt resolution, plan construction, and the cost band — at $0.
  `--dry-run` returns before the pipeline (`src/cli.ts:937-943`), so the step **MUST** state it
  does NOT prove gotchas quality, claude authentication, or agent spawn.
- Preconditions: a git repository AND a clean tree. Outside a repo, or when the tree could not be
  cleaned (declined consent, or pre-existing unrelated dirt), the step **MUST** skip honestly,
  naming which cause applies and printing the exact commands — never a fake pass, never a crash.
- **After a gotchas skip, the dry-run is EXPECTED to stop at the gotchas gate**
  (`src/cli.ts:800-807`, before the dry-run exit). The step **MUST** frame that outcome as
  designed — "blocked on gotchas: you chose to skip; write real ones and re-run" — never as a
  confusing failure; the wizard still completes, with workspaceReady false.
- An optional live auth ping (~$0.04, the `scripts/live-micro-eval.ts` pattern) **MAY** be
  offered; it runs only on explicit selection, never by default.
- The completion screen **MUST** print the next commands: `pr-hero review --dry-run`,
  `pr-hero review`, `pr-hero review --pr <n> --post`, `pr-hero watch add`, `pr-hero doctor`, and
  `pr-hero config` (the deferred-knobs surface until Pillar 2).

### 3.2 Scenarios

#### Scenario 3.1: Verification inside a repo
- **Given** a configured repo with the wizard's commit completed and real gotchas written
- **When** step 5 runs
- **Then** it reports resolution+plan+cost proven, names the three things not proven, and the
  wizard completes with the next-commands screen.

#### Scenario 3.2: Verification outside a repo
- **Given** the wizard runs in a directory with no git repository
- **When** step 5 is reached
- **Then** it reports an honest skip with the command to run inside a repo, and the wizard still
  completes.

#### Scenario 3.3: Verification after a gotchas skip
- **Given** the user informed-skipped the gotchas walk (scaffold truncated to empty)
- **When** step 5 runs the dry-run
- **Then** it stops at the gotchas gate as EXPECTED, the step renders the designed
  "blocked on gotchas" framing with the exact next action, and the wizard completes with
  workspaceReady false.

---

## 4. CLI Integration, Zero-Arg Routing & Doctor

### 4.1 Requirements

- **Zero-arg is a parser change:** today `parseArgs` throws `no command given`
  (`src/preflight.ts:695-699`) and `main()` prints help + exit 2 (`src/cli.ts:483-488`). The new
  behavior gates at the parser: **only when stdin AND stdout are TTYs** — un-onboarded →
  onboarding wizard; onboarded → `HELP_TEXT`. Non-TTY zero-arg keeps today's error + exit 2
  byte-identically.
- **"Onboarded" MUST mean `~/.prhero/setup.json` exists with the current `onboarding_version`.**
  Never the config file — a hand-created `~/.prhero/config.json` without `setup.json` still
  counts un-onboarded (Scenario 2.6). Never the directory — the origin machine's `~/.prhero/`
  holds `watch.json`, databases, and logs with no onboarding ever run.
- The full interactive menu (review / watch / init / config) is **out of scope** — Pillar 2
  (`ROADMAP.md:151-155`).
- `pr-hero init` and `pr-hero setup` open the wizard in a TTY; `--non-interactive` / `--yes`
  perform the deterministic static scaffold (existing `init` behavior, `src/cli.ts:3590-3678`,
  including never overwriting existing files) **plus writing `setup.json`**.
- **`pr-hero doctor` MUST** re-run the wizard's checkers non-interactively with a **tri-state
  model**: every check and the overall result are `healthy | degraded | blocking` (overall = the
  worst check).
  - **Blocking** (exit 1) = a paid review cannot run: `git` missing; `claude` missing or
    unauthenticated; a config `agents_dir` resolving to a missing path (`resolveAgentsDir`
    throws `agents dir does not exist`, `src/cli.ts:3581`); empty gotchas in the current repo
    (the `src/cli.ts:800-807` gate will refuse).
  - **Degraded** (exit 0, actionable hints) = optional facts: `gh` missing/unauthenticated,
    codegraph facts false, skills not synced or digest-stale, MCP not registered, `setup.json`
    absent (hint: run `pr-hero init`).
  - **Healthy** = exit 0.
  Doctor's checks are **read-only** — it never repairs, it prints the command that would. **The
  roster grows by slice, by design:** S2 ships system tools (incl. claude required) +
  config/setup presence; S3 extends it with environment detection + auth, skills digest state,
  MCP registration state, and store health. Each slice's doctor is complete for that slice.
  Output follows the house renderer contract.
- **Stale `agents_dir` migration hint (blocking):** when a config layer's `agents_dir` resolves
  to a missing path — the post-S1 state of a machine still pointing at `../deep-review` — doctor
  **MUST** hint to delete the key and fall through to the bundled default.
- Uninstall footprint **MUST** be documented (README, S5): `~/.prhero/bin/pr-hero`, watch + gc
  launchd plists, the skills copy in the agent environment, the `mcpServers.pr-hero` entry, and
  `~/.prhero/` user data incl. `setup.json` (listed, never auto-deleted). The `uninstall` command
  itself is post-v1.

### 4.2 Scenarios

#### Scenario 4.1: Zero-arg, TTY, fresh machine
- **Given** a TTY session and no `~/.prhero/setup.json`
- **When** `pr-hero` runs with no arguments
- **Then** the onboarding wizard launches.

#### Scenario 4.2: Zero-arg, TTY, onboarded machine
- **Given** `~/.prhero/setup.json` exists with the current `onboarding_version`
- **When** `pr-hero` runs with no arguments
- **Then** `HELP_TEXT` prints and the process exits 0 — no wizard, no error.

#### Scenario 4.3: Zero-arg, non-TTY
- **Given** stdin or stdout is not a TTY
- **When** `pr-hero` runs with no arguments
- **Then** behavior is byte-identical to today: usage error, help text, exit 2.

#### Scenario 4.4: Doctor distinguishes degraded from blocking
- **Given** gh unauthenticated and a digest-stale skills copy (both optional facts) on an
  otherwise healthy machine
- **When** `pr-hero doctor` runs
- **Then** both issues are reported as **degraded** with actionable hints and the exit code is
  **0**.

#### Scenario 4.5: Doctor blocks on a stale agents_dir
- **Given** `~/.prhero/config.json` with `agents_dir` pointing at a path that no longer exists
- **When** `pr-hero doctor` runs
- **Then** it reports the stale key as **blocking** with the hint to delete it and fall through
  to the bundled default, and exits 1.

#### Scenario 4.6: Doctor blocks on unauthenticated claude
- **Given** the `claude` binary installed but unauthenticated
- **When** `pr-hero doctor` runs
- **Then** the claude check is **blocking** (a paid review cannot run), the actionable auth
  command is printed, and the exit code is 1.
