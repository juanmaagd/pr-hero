# Pillar 1 — Install, Configure & Onboarding in One Flow. Design.

Status: **PROPOSED — rev 4 (2026-08-24, post Codex review + empirical verification), awaiting Juanma ratification.**

Rev 1 (2026-08-24) was audited the same day against the tree at `c53011e`: two independent terrain
sweeps plus spot-checks, and the publication decisions (D0) taken by Juanma. Rev 2 folded every
audit finding in. Rev 3 folded in the adjudicated cross-model review — four confirmed blockers
(the configured-marker write, the clean-tree gate vs step 5, O-15's satisfiability, `claude` as a
required system tool) plus the wizard `apply` hook, idempotency rules, the wizard config matrix,
and the S3↔S4 slice swap. Rev 4 folds in the adjudicated Codex review — Codex audited rev 2, and
its effect-model, slice-order, and filename-exemption points were already resolved in rev 3; what
rev 4 adds is the **empirically verified** assets rework (`compile.assets` is a silent no-op on
Bun 1.3.14 — the design now embeds via an explicit import manifest), the onboarding-state flip
(`~/.prhero/setup.json` replaces rev 3's `{}` config marker), the `selfInvocation()` abstraction,
the gotchas-skip truncation, the tri-state doctor, digest-based skills sync, adapter capabilities,
MCP write hardening, the D6 warning task, and published-artifact verification (O-16). Nothing
below cites a line that was not read this cycle.

Roadmap seat: THE LAUNCH LINE → Three Distribution Pillars → **Pillar 1 (Install + configure in one flow)**.
Roadmap entry: `ROADMAP.md:143-150` and `ROADMAP.md:236-245`.

House pattern: same shape as `docs/c5-global-config-design.md`, `docs/c4-preamble-design.md`, and
`docs/item7-rereview-design.md` — terrain verified first, architectural decisions second, extensible
contracts third, delivery slices and named test obligations at the end.

---

## 0. The terrain, verified 2026-08-24 (rev 2 audited; rev 4 adds the empirical packaging facts)

### 0.1 The agents-dir seat and every consumer of the hardcoded path

`src/preflight.ts:47-48` hardcodes:
```ts
export const SUGGESTED_AGENTS_DIR =
  "/Users/juanma/Desktop/deep-review/agents/slice3b-lifecycle-v6-clean";
```
`resolveAgentsDirSetting` (`src/preflight.ts:1247-1271`) resolves `flag` → `config` (`agents_dir`,
resolved against the winning layer's config-file dir, source `"repo" | "global"`) → env
`PRHERO_AGENTS_DIR` → **throw** (`CliUsageError` naming the machine path, `:1265-1270`). The impure
half `resolveAgentsDir` (`src/cli.ts:3564-3584`) adds a second failure: `agents dir does not exist`
(`:3581`).

**All consumers of `SUGGESTED_AGENTS_DIR`** (every one must change when it dies):
- `src/preflight.ts:47` (definition) and `:1269` (error text).
- `src/cli.ts:148` (import) and `:3605` (`init`'s agents seed, source `"the suggested clean set"`).
- `scripts/martian-cal.ts:27,168` — **and `scripts/` is covered by neither `bun run typecheck` nor
  `bun run check`**, so deleting the constant breaks that script silently. It must be migrated
  explicitly and verified with the real toolchain (`./node_modules/.bin/biome`, reconstructed tsc
  flags — never `bunx`, per the repo `CLAUDE.md` warning).

### 0.2 The real spec seat is `localReviewSpec()`, not `defaultReviewSpec()`

The CLI validates `localReviewSpec()` at `src/cli.ts:762` and `:1180` — five agents, defined at
`src/preflight.ts:1540-1559` (adds `{ key: "lifecycle", file: "deep-review-lifecycle.md" }` at
`:1549`). `spec.ts:125-143`'s `defaultReviewSpec()` omits the lifecycle hunter and is only
`runPipeline`'s fallback (`pipeline.ts:701`). Prompt-set loading uses **fixed filenames** — the
frozen `AGENT_NAMES` tuple (`src/prompt-set.ts:14-19`, order is fingerprint-load-bearing for the
lab) — plus one directory enumeration for validation: `preflightAgentsDir` (`src/cli.ts:3884-3901`)
runs `Bun.Glob.scan` over `AGENT_FILE_PATTERNS = ["deep-review-*.md", "review-*.md"]`
(`preflight.ts:1502`), and `agentsDirProblems` (`preflight.ts:1510-1533`) is **bidirectional**: any
stray matching `.md` in the agents dir is a hard `CliError`.

**Neither spec carries a `model` field.** Models resolve at runtime
(`pipeline.ts:1789-1791`): `--model` > `AgentSpec.model` > agent frontmatter. The five clean-set
files all carry `model: sonnet` in frontmatter; scout defaults to sonnet
(`DEFAULT_SCOUT_MODEL`, `pipeline.ts:1458`); summarizer is `model: haiku`
(`prompts/summarizer.md:4`, mirrored by `DEFAULT_SUMMARY_MODEL`, `preflight.ts:43`).

### 0.3 The config surface is six keys, and the global layer is unexercised

`CONFIG_DIRECTION` (`src/preflight.ts:1574-1594`): `agents_dir` (person), `default_base` (repo,
default remote head → `"main"`), `parity_trigger_paths` (repo), `suspicion_priors` (repo),
`summary` (`enabled` capped / `model` person, `:1600-1603`), `max_verification_steps` (capped,
default 8, `:1818`). Files: `<repo>/.prhero/config.json` (`cli.ts:667`, `--config` override) and
`~/.prhero/config.json` (`home-preflight.ts:54`, loaded at `cli.ts:648-658`). This matches
`docs/c5-global-config-design.md` exactly (its line references have drifted; the key list has not).

Machine reality check: on the origin machine `~/.prhero/` holds `watch.json`, `prhero.db`,
`metrics.db`, logs, `repos/` — and **no `config.json`**. The global config layer exists in code and
has never been exercised in production. Consequence recorded in D4: any onboarding-completion
detection must test a specific FILE, not the directory — and rev 4 gives that detection its own
file (`~/.prhero/setup.json`), because a config file's existence cannot represent onboarding
completion (a user who hand-creates `~/.prhero/config.json` has configured something, not
onboarded).

The global parser facts stay load-bearing for what the wizard must NOT do: `parseGlobalConfig`
(`preflight.ts:1696-1698`) admits every non-`repo` key via `GLOBAL_CONFIG_KEYS` (`:1656-1660`),
rejects the three repo-direction keys by name, and its comment states "an absent config is a
legal, complete configuration". `init` reads the global file and deliberately never writes it (C5
O-9, `cli.ts:3611-3617`) — **that stance stays fully intact in rev 4**: the wizard never writes
`~/.prhero/config.json` either; onboarding state lives in `setup.json` (D4).

What `initConfigTemplate` (`preflight.ts:2108-2129`) actually seeds (verified this rev):
`default_base` **always** — from `resolveBaseRef({ flag, remoteHead })`, i.e. the remote head with
`--base` winning ("Always written, whatever the global file says", `:2117-2118`);
`parity_trigger_paths: []` and `suspicion_priors: []` always; `summary` unless the global layer
already supplies it (`initTemplateOmissions`, `:2081-2098`); `agents_dir` from flag → env →
`SUGGESTED_AGENTS_DIR`. Post-S1 the template **omits `agents_dir` when the source is the bundled
default** — a baked machine path committed to the TEAM file would be strictly worse than the
npm-prefix bug.

### 0.4 CLI surface facts the wizard must build on

- **Zero-arg is a parser throw, not a routing choice.** `parseArgs` throws at
  `preflight.ts:695-699` (`no command given`); `main()` catches at `cli.ts:483-488` → `HELP_TEXT` +
  exit 2. A wizard hook is a **parser change**, not a dispatch change.
- **`init` (`cli.ts:3590-3678`)** is non-interactive: `mkdir` (`:3593`), writes `config.json` +
  `gotchas.md` (`:3632-3646`), never overwrites (`:3640-3643`), reads but never writes the global
  file (`:3611-3617`), omits keys the global supplies (`:3624`). Its agents seed (`:3595-3605`) is
  `--agents` → `PRHERO_AGENTS_DIR` → `SUGGESTED_AGENTS_DIR`.
- **`--dry-run` exists and is not offline.** Default false (`preflight.ts:486`); local mode returns
  at `cli.ts:937-943` — after ref resolution, config, preflight, size gate, plan — spending $0 but
  requiring a git repo. It returns **before** the pipeline, so it never exercises the pipeline's
  gotchas gate, auth, or spawn.
- **The CLI pre-checks empty gotchas before the dry-run exit.** Local mode step 7
  (`cli.ts:800-807`) throws `gotchasErrorMessage` on a missing-or-empty `gotchas.md` — before the
  `--dry-run` return at `:937` (PR mode mirrors it at `:1206-1212`). An empty gotchas file
  therefore blocks even the wizard's own verification dry-run, at $0, with the friendly message —
  the mechanism the rev 4 gotchas-skip design leans on (D4).
- **`--yes`** skips the cost-band confirm (`preflight.ts:487`; used `cli.ts:957`, `:1654`); the
  confirm menu is `confirmReview` (`ui-select.ts:370`) with a non-TTY `[y/N]` fallback.
- Command surface: 13 commands (`preflight.ts:198-211`): `review, init, ledger, watch, post,
  triage, gc, usage, reverts, corpus, config, mcp, help` — `pr-hero config` already exists, so the
  completion screen may point deferred knobs at it.
- **The clean-tree gate runs before the dry-run exit.** Local review runs `git status --porcelain`
  at `cli.ts:735-748` and throws `CliError("the working tree is dirty…")` on ANY output —
  untracked `??` included — then a HEAD-match gate; the `--dry-run` return sits later at
  `:937-943`. A freshly scaffolded, uncommitted `.prhero/` therefore FAILS the dry-run.
  `INIT_GIT_REMINDER` (`preflight.ts:2131-2138`) documents exactly this connection ("an untracked
  .prhero/ is exactly that").
- `AGENTS.md` exists at the repo root beside `CLAUDE.md` — S5's architecture-doc updates must
  touch both.

### 0.5 The codegraph gate is a per-repo INDEX check, not a binary check

`const codegraphAvailable = existsSync(path.join(repoRoot, ".codegraph"))` — local mode
`cli.ts:876`, PR mode against the worktree `cli.ts:1723-1725`. The swap is a ternary into the run's
`mcp.json` (`:880`, `:1729`): `CODEGRAPH_ONLY_MCP_CONFIG` (`cli.ts:254-262`) or `EMPTY_MCP_CONFIG`
(`cli.ts:337`). Review still runs; the plan card prints `codegraph NOT FOUND` (`cli.ts:4498`).
Installing the codegraph **binary** flips nothing — only an indexed repo does. PR-mode worktrees
start unindexed, so PR mode silently degrades to `EMPTY_MCP_CONFIG` today; that stays the
documented behavior (see D3).

### 0.6 The engine already reads packaged assets and re-spawns itself — the second-runtime blast radius

- `prompts/summarizer.md` and `prompts/scout.md` are read via `import.meta.dir`
  (`cli.ts:265-290`); they are deliberately outside the agents dir (`cli.ts:293-298`).
- `src/watch.ts:130` and `src/gc.ts:278` re-spawn the CLI by resolving `cli.ts` beside
  `import.meta.dir`. The launchd-PATH lesson is written verbatim at `watch.ts:125-128`, and the
  WORKING mechanism is already in the house: `watch.ts:547-548` spawns
  `[process.execPath, cliEntryPath(), …]` (absolute bun + absolute `cli.ts`) and the launchd plist
  renders `runtimePath`/`entryPath` from the same pair (`watch.ts:746-747`; `gc.ts:277,294`
  likewise). A compiled binary contains neither `cli.ts` nor `bun` on disk. And the npm shim runs
  `src/cli.ts` behind `#!/usr/bin/env bun` (`cli.ts:1`) — so even an **absolute path to the shim**
  dies under launchd/GUI: `env` resolves `bun` through a PATH launchd never provides. One shared
  abstraction must own this (D5: `selfInvocation()`).
- Provenance reads `package.json` + `git` of the engine directory (`cli.ts:5179-5188`) — absent in
  an npm global install and in a compiled binary.
- **Bun packaging facts — verified empirically 2026-08-24 on Bun 1.3.14** (scratchpad
  micro-binaries, not docs):
  - **`compile.assets` is a SILENT NO-OP.** `Bun.build({ compile: { assets: ["prompts"] } })`
    reports `success: true` and the binary ships WITHOUT the assets (`ENOENT` under
    `/$bunfs/root/prompts/`). `--asset` does not exist in `bun build --help` (only
    `--asset-naming` does). The main-branch Bun docs describe an unreleased feature — rev 2/3
    were designed against them. This is exactly the failure class O-11 exists for.
  - **The mechanism that works, proven in BOTH modes with the same code:** a TS manifest module
    using `import ... with { type: "file" }` per asset, exporting a logical-name → path map. Dev
    resolves the real filesystem path; the compiled binary resolves the embedded path — which is
    **content-hashed** (`/$bunfs/root/a-yq4ycqmf.md`), so nothing may rely on embedded basenames.
  - The compile autoload knobs exist and BOTH default true: `--no-compile-autoload-dotenv` and
    `--no-compile-autoload-bunfig` (verified in the CLI help).

### 0.7 MCP server and store

`pr-hero mcp` (`cli.ts:3876-3882`) → `runMcpServer({ socketPath: options.socket, dbPath:
options.db })` — flags are `--socket`/`--db` (`preflight.ts:192-194`). Transport is stdio
line-delimited JSON-RPC (`mcp.ts:93-97`), server `pr-hero-store` v0.1.0, protocol `2024-11-05`
(`mcp-preflight.ts:10-12`). The store is homedir-anchored and cwd-independent:
`~/.prhero/prhero.db` (`mcp.ts:78-89`, `home-preflight.ts:48-60`); per-repo run artifacts live under
`~/.prhero/repos/<host>/<org>/<repo>/runs` keyed by canonical origin URL (`home-preflight.ts:72-98`).

**Eight tools, not five** (`mcp-preflight.ts:24-166`): `prhero_health`, `prhero_list_runs`,
`prhero_get_run`, `prhero_get_findings`, `prhero_search_findings`, `prhero_get_usage`,
`prhero_get_comparison`, `prhero_get_triage`. There is no `prhero_get_stats` (rev 1 named one).

**"Read-only" is route-level only:** `store.ts:37-56` `mkdir`s `~/.prhero/`, creates `prhero.db`,
and runs schema migrations on first open (`CURRENT_PRODUCT_SCHEMA_VERSION = 3`,
`store-preflight.ts:24`). A globally registered server's first query on a fresh machine silently
scaffolds an empty store and answers with zero rows.

**`claude mcp add` defaults to `--scope local`** (verified against the installed CLI, 2026-08-24) —
a registration that omits the scope lands in one project's config, not the user's. D7 pins
`--scope user`.

### 0.8 Skills

`skills/pr-hero-triage/` = `SKILL.md` (14K) + `adjudicator.md` (5.3K). Portability scan clean: no
absolute paths, no lab/client references; commands are the public CLI; store reference is
`~/.prhero/prhero.db`. Frontmatter declares `license: MIT`, `version: "1.2"` — the license field
must move to Apache-2.0 under D0. `skills/martian-bench/` is confirmed **private** (machine paths,
sealed-lab pointers, vendor head-to-head data) and must never ship.

### 0.9 The production prompt set, skimmed for productization

`../deep-review/agents/slice3b-lifecycle-v6-clean/` — the five files (30K/11K/8.6K/11K/10K). No
absolute paths, no client names, no credentials. But:
- Branding is `deep-review-*` in `name:` frontmatter and headings — and `ROADMAP.md:239` gates
  launch on nothing mentioning `deep-review`.
- Stale config references: `deep-review.config.json` (`deep-review-resilience.md:62`,
  `deep-review-parity.md:65`) and `deep-review/intel/gotchas.md` (`:70`, `:73`) — the real paths are
  `.prhero/config.json` and `.prhero/gotchas.md`.
- All four hunters cite `hunting-map.md` category numbers (e.g. `deep-review-resilience.md:14`) — a
  document that does not ship.
- One "golden" vocabulary mention (`deep-review-lifecycle.md:16`).
- Hard tools frontmatter includes `mcp__codegraph__codegraph_explore` — an inert no-op under
  `EMPTY_MCP_CONFIG` (verified), so it may stay.
- Frontmatter `name:` is display-safe to rebrand: consumers are step logging/artifacts
  (`step-runner.ts:281-438`) and provenance (`pipeline.ts:1824`); routing is spec key + filename.

### 0.10 Packaging state

`package.json`: `private: true` (line 4), `bin: { "pr-hero": "./src/cli.ts" }` behind
`#!/usr/bin/env bun` (`cli.ts:1`), `version: 0.1.0`, **zero `dependencies`**, no `engines`, no
`files`. The runtime is Bun-specific throughout (`Bun.file`, `Bun.Glob`, `Bun.which`, `Bun.spawn`) —
plain Node can never run the npm package. Repo: single `origin git@github.com:juanmaagd/pr-hero.git`;
**no `.github/`**, **no `install.sh`**, **no release/build/publish tooling anywhere**, **no LICENSE
file**. `README.md:19` documents clone-based install (`bun install && bun link`) — the exact model
Juanma retired ("installed, never cloned", 2026-08-23). A publish without a `files` whitelist would
ship `docs/`, `scripts/`, `fixtures/`, `test/`, `openspec/`, and `skills/martian-bench/`. The npm
name `pr-hero` returned 404 on the registry on 2026-08-24 — free.

### 0.11 The gotchas template passes the fail-loud gate

The pipeline aborts on missing-or-empty gotchas (`pipeline.ts:665-672`, trim check).
`GOTCHAS_TEMPLATE` (`preflight.ts:2140-2148`) is **not** empty — placeholder bullets
(`<subsystem>: <...>`) pass the check and are injected verbatim into every hunter's system prompt.
A wizard that scaffolds the template and dry-runs green has proven nothing about gotchas: the first
paid review runs with placeholder noise. The CLI's own pre-check (§0.4, `cli.ts:800-807`) fires
only on missing-or-EMPTY files — which is what makes emptiness the safe skip state (D4).
`ROADMAP.md:146-147` anticipated this: "walk gotchas (empty still fails loud — a starter is not a
skip)".

---

## 1. The Core Problem

1. **Broken on any other machine:** without a bundled prompt set, `pr-hero review` on a fresh
   machine throws an error naming `/Users/juanma/...`.
2. **High initial setup friction:** installing `pr-hero`, verifying `git`, installing and
   authenticating `gh`, provisioning codegraph (binary AND per-repo index), verifying `claude`
   auth, and wiring skills/MCP are disconnected manual steps.
3. **Two integration axes were conflated:** the *execution* axis (who runs the hunters — the
   `StepRunner`, Claude-only in v1, Stage-2 obligations documented at `step-runner.ts:67-82`) and
   the *agent-environment* axis (which coding assistants get the triage skill + MCP server so their
   user can consume findings). Rev 1's `ProviderAdapter` mixed them; Phase D would have landed on an
   interface meaning two things.
4. **The compiled standalone binary is a second runtime, not a packaging detail.** Assets, self
   re-spawn, and provenance all resolve differently inside `bun build --compile` output — and the
   packaging API rev 2/3 leaned on (`compile.assets`) is a silent no-op on the pinned Bun (§0.6). A
   design that ignores this ships a binary without prompts and a watcher that cannot re-spawn, with
   a green build.
5. **Model calibration protection:** the pipeline is measured with `sonnet` hunters/refuter; the
   design must protect defaults without pretending a lock that `--model` (by design) overrides.
6. **Publication was undecided:** license, repo visibility, and what each channel ships gate the
   packaging slice. Now decided — see D0.

---

## 2. Architectural Decisions (D0 – D9)

### D0: Publication Model — DECIDED by Juanma, 2026-08-24
- **Full open source.** The repo goes public; npm ships readable TypeScript and the calibrated
  prompt set. This is the roadmap's own posture ("npm is the launch registry", `ROADMAP.md:1872-1875`).
- **License: Apache-2.0.** New `LICENSE` file at repo root; `"license": "Apache-2.0"` in
  `package.json`; `skills/pr-hero-triage/SKILL.md`'s declared `license: MIT` is aligned to
  Apache-2.0 (implementation task, S3).
- **npm `files` whitelist** ships `src`, `prompts`, `skills/pr-hero-triage`, `README.md`,
  `LICENSE`, `package.json` — and explicitly excludes `skills/martian-bench`, `docs/`, `scripts/`,
  `fixtures/`, `test/`, `openspec/`, `ROADMAP*`.
- **Claim the free `pr-hero` npm name early** (verified free 2026-08-24) with the first honest
  publish.
- **Homebrew tap stays post-launch** (`ROADMAP.md:247-253` already says so).

### D1: Bundled Production Prompt Set — frozen, productized, package-relative
- The 5-agent set derived from `v6-clean` lands in `prompts/default/` with the **file names
  unchanged** (`deep-review-lifecycle.md`, `deep-review-parity.md`, `deep-review-reliability.md`,
  `deep-review-resilience.md`, `review-refuter.md`) so `AGENT_NAMES`, `localReviewSpec()`, and
  `AGENT_FILE_PATTERNS` stay intact.
- **Content productization pass** (branding only, no behavioral intent): frontmatter `name:` →
  `pr-hero-*` (display-safe, §0.9); headings rebranded; stale refs fixed to `.prhero/config.json`
  and `.prhero/gotchas.md`; `hunting-map.md` citations resolved (inline the category descriptions
  or drop the numbers — no citations to unshipped documents); the "golden" vocabulary removed.
- `prompts/default/PROVENANCE.md` records: derived from `slice3b-lifecycle-v6-clean`, date,
  branding-only edits, no behavioral intent.
- **Mandatory gates before freezing** — editing `review-refuter.md` is a refuter prompt change, and
  the repo `CLAUDE.md` names `bun run refuter-probe` as THE first gate for any refuter prompt
  change: `refuter-probe` (all four verdict outcomes) plus one `bun run fixture-eval`.
- Resolution: the bundled default is provided by `src/assets.ts` (D5) and **loads via the asset
  manifest in every mode** (§0.6 — embedded names are hashed, so the dir + fixed-filenames loader
  cannot serve the compiled default); custom `--agents`/config/env sets stay FS-based with the
  existing validation. `resolveAgentsDirSetting` returns the bundled default with
  `source: "default"` instead of throwing; `SUGGESTED_AGENTS_DIR` is deleted from all four
  consumer sites (§0.1). `init` seeds `--agents` → `PRHERO_AGENTS_DIR` → omit (bundled default
  needs no key).
- Precedence unchanged: `--agents` > repo config > global config > `PRHERO_AGENTS_DIR` > bundled
  default.
- *Rejected:* downloading prompts at runtime (offline determinism), renaming the files
  (fingerprint/spec/pattern blast radius for zero user value).

### D2: Agent-Environment Adapters — the axis this pillar actually owns
- Interface renamed honestly: **`AgentEnvAdapter`** in `src/agent-env.ts` (rev 1: `ProviderAdapter`
  in `src/provider.ts`). Scope: detection, auth status, skills sync, MCP registration for the
  **consumer's coding assistant**. Execution stays Claude-only via `StepRunner`
  (`step-runner.ts:67-82`; `backend` field already typed) and is explicitly out of this pillar.
- Environments: `claude` (active), `antigravity` / `opencode` / `codex` / **`cursor`** (stubs,
  `"detected_inactive" | "coming_soon"`). Cursor is stubbed because the MCP data-layer design's
  consumer surface named Claude Code / Cursor; an active Cursor adapter (skills + `mcp.json`) is a
  fast-follow, not a Pillar 1 blocker — the stub keeps the registry honest. **`groq` is dropped**
  — it is a model provider, not an agent environment with a skills dir; it was the conflation
  artifact. It may return in Phase D on the execution axis.
- **Adapters declare capabilities** — `{ skills: boolean; mcp: boolean }`. Sync/registration
  methods exist only where the capability is true; stubs stop implementing fictitious methods, and
  the registry, wizard, and doctor consult capabilities before calling anything.
- *Rejected:* one interface for both axes (Phase D would refactor onboarding), hardcoding Claude
  paths across the CLI (same as rev 1).

### D3: System Tools Preflight — codegraph is two facts, claude is required
- **`claude` (required)** — the EXECUTION runtime, not only an IDE integration: `StepRunner`
  spawns `claude -p` for every hunter/refuter step, so a user on any agent environment (Cursor
  included) still needs the binary and working auth to run a paid review. Reported as binary +
  auth status with the actionable command when unauthenticated. Step 2 stays the *environment*
  axis (D2); the two are never merged.
- `git` (required), `gh` (optional; binary + `gh auth status`), `codegraph` reported as
  **`binaryInstalled`** and **`repoIndexed`** — because the engine's gate is the per-repo
  `.codegraph/` index (§0.5), not the binary.
- The workspace step offers `codegraph init` for the current repo when the binary exists and the
  index does not. Auto-install actions (e.g. Homebrew) run only on explicit interactive selection.
- PR-mode worktrees start unindexed and silently degrade to `EMPTY_MCP_CONFIG`; this stays the
  documented behavior — the wizard must not promise codegraph coverage in PR mode.
- Missing codegraph never blocks a review (`EMPTY_MCP_CONFIG` fallback verified, §0.5).

### D4: Interactive TUI Onboarding Wizard — steps as data, applies instead of recording
- Pure state machine in `src/wizard.ts`; **steps are data** (an ordered array of step descriptors
  with `id`, `title`, `probe`, **`apply`**, and a pure `render`), not a hardcoded union — adding a
  step later (Pillar 2 will) is adding an entry. Side effects live on the descriptor's `apply`,
  never in the runner: a runner switching on step ids is the hardcoding this decision deletes.
  Renderers follow the house contract: return `string[]`, take `{ styles, width }`, never sniff
  the TTY.
- Steps (v1): 1 system tools → 2 AI environment (claude auth surfaced with actionable commands and
  re-probe) → 3 skills + MCP registration → 4 workspace → 5 verification.
- **Step 4 (workspace) APPLIES, it does not merely record:**
  1. **The onboarding state — an explicit FLIP from rev 3.** Step 4's `apply` writes
     **`~/.prhero/setup.json`** (`{ "onboarding_version": 1, "completed_at": "<ISO>" }`) — the
     `watch.json` precedent: its own file, its own schema, OUTSIDE the C5 config parsers. The
     wizard **never writes `~/.prhero/config.json`** — rev 3's `{}` marker is REMOVED, because a
     config file's existence conflates "has global config" with "completed onboarding": a
     hand-created config would silently hide the wizard, and a wizard-created `{}` would
     misrepresent a hand-rolled machine as onboarded. C5 O-9 ("init never writes the global
     file") stays fully intact. machineReady = `setup.json` present with the current
     `onboarding_version` (versioning lets a future onboarding revision re-prompt);
     workspaceReady = repo `.prhero/` scaffolded + real gotchas. `init --yes` writes the same
     state file. Written **at apply-time**: cancelling before step 4 leaves it absent and
     zero-arg re-enters the wizard; `pr-hero init` always re-enters regardless.
  2. Repo scaffold via the existing `init` path (never overwrites), the **gotchas walk** (below),
     the `codegraph init` offer, and **commit-vs-ignore, APPLIED**: default is commit (`.prhero/`
     is the team layer); ignore is the explicit opt-out. **Both branches leave the tree dirty**
     (§0.4): writing or appending `.gitignore` is itself an uncommitted change, and `git add`
     alone still shows staged entries in porcelain. So both branches end in **one explicitly
     consented, path-scoped commit** — `git add .prhero/` (or the `.gitignore` edit) committed
     with an explicit pathspec, **never `commit -a`**, never touching unrelated files. Declined
     consent → step 5 honest-skips with the exact commands.
  3. **Pre-existing dirt.** If the tree already carries unrelated uncommitted work, step 5
     honest-skips regardless of consent — the wizard never commits or stashes user changes. The
     skip message distinguishes "your `.prhero/` needs committing (the wizard can do that)" from
     "you have unrelated uncommitted work (commit or stash it, then run `pr-hero review --dry-run`
     yourself)".
  4. **Load-bearing order: apply → consented commit → dry-run.** Never the reverse — the
     clean-tree gate (§0.4) sits before the dry-run exit.
- **Idempotency.** Machine-level steps (system tools, claude auth, the setup state, skills, MCP)
  skip when already healthy; the workspace step always evaluates the CURRENT repo; re-running
  `init` in a configured repo preserves the existing never-overwrite behavior. A second repo's run
  does real work only in workspace + verification.
- **Gotchas walk is mandatory content, not polish:** the template passes the fail-loud trim check
  (§0.11), so the wizard collects at least one real gotcha; writes REPLACE the placeholders. An
  **informed skip TRUNCATES to empty the `gotchas.md` the wizard scaffolded THIS RUN** — never a
  pre-existing user file (explicit guard) — so no placeholder can ever reach a paid prompt: the
  existing CLI gate (§0.4, `cli.ts:800-807`) then blocks the first review at $0 with
  `gotchasErrorMessage`. Step 5 after a skip **expects that outcome and frames it as designed**
  ("blocked on gotchas — you chose to skip; write real ones and re-run"), never as a confusing
  failure; workspaceReady stays false and doctor reports gotchas pending.
- **What the wizard configures — the v1 matrix** (six existing keys, no new ones; unknown keys are
  fatal by design):

  | Surface | Wizard v1 | Why |
  |---|---|---|
  | `~/.prhero/setup.json` | Write at step-4 apply | The onboarding state, versioned; cancel-before leaves it absent |
  | `~/.prhero/config.json` | **Never written by the wizard** | Pure config; C5 O-9 intact; person/capped keys via `pr-hero config` later |
  | `summary.*`, `max_verification_steps` | Omit (code defaults: haiku, on, 8) | Capped keys are Pillar 2 |
  | `<repo>/.prhero/config.json` | Existing `initConfigTemplate` | Seeds `default_base` (remote head), empty arrays, summary-unless-global; omits `agents_dir` on the bundled default (§0.3) |
  | `default_base` | Show + allow override | The ONE extra question — wrong branch = wrong range |
  | `parity_trigger_paths` / `suspicion_priors` | Seed `[]`, do not collect | Repo-specific; completion screen points at `pr-hero config` |
  | `.prhero/gotchas.md` | Walk; REPLACE placeholders; skip TRUNCATES own scaffold | §0.11 + the `cli.ts:800-807` gate |
  | Commit vs ignore | **Apply**; default commit | The clean-tree gate (§0.4) |
  | `codegraph init` | Offer when binary-yes/index-no | D3 |
  | `~/.prhero/watch.json` | Never touched | The only unattended-spend opt-in; completion prints `pr-hero watch add` |
  | Size gate / scout / hop-budget / `--model` / `--post` | Not collected | Flags or Pillar 2; scout has no config key on purpose |
  | MCP `--socket` / `--db` | Not collected | Power-user; homedir defaults suffice |

  New config keys remain a C5 change, never a wizard change — Pillar 2 menus bind to
  `CONFIG_DIRECTION`, and nothing may teach the wizard a parallel key list.
- **Step 5 states exactly what it proves:** `--dry-run` proves config + prompt resolution + plan +
  cost band **inside a git repo with a clean tree**; it does NOT prove gotchas quality, claude
  auth, or spawn. Outside a git repo, or on a tree the wizard was not allowed to clean, the step
  reports an honest skip naming the cause; after a gotchas skip it reports the expected
  blocked-on-gotchas state. Optional extra: a ~$0.04 live auth ping (the
  `scripts/live-micro-eval.ts` pattern) offered, never default.
- **Zero-arg is a parser change**: `parseArgs` (`preflight.ts:695-699`) stops throwing only when
  stdin+stdout are TTYs; then: un-onboarded → wizard, onboarded → `HELP_TEXT`. "Onboarded" means
  **`~/.prhero/setup.json` present with the current `onboarding_version`** — never the config file
  (a hand-created `~/.prhero/config.json` with no `setup.json` still counts as un-onboarded and
  the wizard is offered), and never the directory (§0.3). Non-TTY keeps today's error + exit 2
  verbatim. The full menu (review/watch/init/config) stays Pillar 2 (`ROADMAP.md:151-155`).
- **Completion screen** prints the next commands: `pr-hero review --dry-run`, `pr-hero review`,
  `pr-hero review --pr <n> --post`, `pr-hero watch add`, `pr-hero doctor`, `pr-hero config`.
- `pr-hero init` / `pr-hero setup` open the wizard in a TTY; `--non-interactive` / `--yes` keep the
  static scaffold for scripts (plus the setup state, above).

### D5: Packaging — the compiled binary is a second runtime
- **`src/assets.ts` is the single authority for packaged-asset resolution** — the bundled prompt
  set, `prompts/scout.md`, `prompts/summarizer.md`, `skills/pr-hero-triage/`, and the engine
  version. Three modes: dev checkout, npm install, compiled. No other module computes asset paths.
- **Embedding is manifest-based — permanently.** `src/asset-manifest.ts` imports every packaged
  asset with `import ... with { type: "file" }` and exports a logical-name → path map; it is the
  assets module's only data source for packaged files. Verified empirically (§0.6): the same code
  resolves real FS paths in dev/npm and embedded paths in the compiled binary. `compile.assets` is
  a silent no-op on the pinned Bun and is used NOWHERE; the manifest is the permanent,
  version-robust approach, not a stopgap until `compile.assets` ships.
- **Named contract change — embedded names are hashed** (§0.6), so the compiled bundled default
  cannot pass through the dir + fixed-filenames loader (`agentFilesIn` would build nonexistent
  paths; `preflightAgentsDir`'s glob would see nothing). The bundled default therefore **loads via
  the manifest map in every mode**; custom `--agents`/config/env sets stay FS-based with the
  existing validation; bundled-set validation (spec match, the bidirectional check, manifest ↔
  `prompts/default/` parity) moves to **build-time tests in dev**. The
  `Bun.Glob.scan`-over-embedded-FS unknown is thereby eliminated.
- **`selfInvocation()` — one seat for "how do I run myself again"** (exported from
  `src/assets.ts`, which already owns mode detection): dev/npm →
  `{ command: process.execPath (absolute bun), args: [absolute cli.ts] }` — the exact pair
  `watch.ts:547-548` already uses; compiled → `{ command: process.execPath (the binary), args: [] }`.
  Reused by MCP registration (D7), the watch spawn, the gc spawn, and launchd plist rendering. An
  absolute path to the npm SHIM is explicitly non-compliant — its shebang re-introduces the PATH
  lookup (§0.6).
- **Release workflow** (`.github/workflows/release.yml`): matrix `darwin-arm64`, `darwin-x64`,
  `linux-x64`, `linux-arm64`; version from the git tag baked in via `define`;
  `--no-compile-autoload-dotenv` AND `--no-compile-autoload-bunfig` (both default true — an
  installed CLI must not read a stranger's cwd `.env` or `bunfig.toml`); the **exact Bun build
  version pinned in CI** and aligned with `engines`; `SHA256SUMS` published beside the binaries.
- **Release invariant:** the npm package and the binaries are built and published from the SAME
  commit and version in one workflow, versions matching the tag; `npm publish --provenance` from
  GitHub Actions.
- **Platform matrix decisions (recorded):** glibc via ubuntu-LTS runners for v1, musl deferred and
  documented; x64 ships the non-`-baseline` variant, with the `-baseline` (pre-AVX2) decision
  deferred and documented. macOS: Bun's compiled output carries an ad-hoc signature; notarization
  is deferred and documented (the curl channel does not quarantine; browser downloads would).
- **Release-gate smokes:** **O-11** — each published binary runs on its platform's runner
  (`--help` + `review --dry-run` on a fixture repo + bundled prompt/skill resolution); it exists
  precisely because packaging features can silently no-op — proven this session. **O-16** — the
  npm-pack smoke: pack → install into an isolated temp prefix → `pr-hero --help` → fixture
  dry-run OUTSIDE the checkout. Unit tests cannot see the embedded FS or the packed tarball; only
  the artifacts prove the artifacts.
- `install.sh`: OS/arch detection, download from GitHub release assets, **checksum verification
  against `SHA256SUMS`**, install to `~/.prhero/bin/pr-hero`, idempotent PATH block in
  `.zshrc`/`.bashrc`/fish config.
- **Compiled-mode fixes in the engine:** `watch.ts` / `gc.ts` spawns and plist rendering move onto
  `selfInvocation()`; provenance (`cli.ts:5179-5188`) prefers the baked version and degrades
  gracefully with no git.
- **npm channel requires Bun** — zero `dependencies`, Bun-only APIs, `.ts` bin. `engines` pins the
  real minimum (the CI build version); README and the npm page state it plainly; the curl
  installer is the no-Bun path.

### D6: Calibrated Model Defaults — no fake lock
- The calibrated defaults (`sonnet` hunters/refuter, `haiku` summarizer) travel in the bundled
  frontmatter; the wizard and scaffolding never offer model picking.
- `--model` remains an explicit escape hatch with unchanged precedence (`pipeline.ts:1789-1791`),
  documented as **uncalibrated**, and the plan card prints a warning line when it is set — tasked
  and tested in S4 (rev 3 promised the warning without a task).
- *Rejected:* a hard lock — it would break the lab's replay scripts and lie about what the code
  does; rev 1's "locked" wording described no mechanism.

### D7: MCP Registration — SelfInvocation-derived, provider-owned writes
- The registered command is **derived from `selfInvocation()` (D5)** — never a bare `pr-hero`,
  and never the npm shim path (its shebang dies under launchd, §0.6): compiled →
  `{ command: <binary>, args: ["mcp"] }`; npm/dev →
  `{ command: <absolute bun>, args: [<absolute cli.ts>, "mcp"] }`.
- Prefer the provider's own CLI — **`claude mcp add --scope user`** (the installed CLI's default
  scope is `local`, verified 2026-08-24, which would scope the server to one project); the
  remaining invocation details are verified at implementation time.
- The hand-edit fallback is **hardened**: atomic temp-file + rename in the SAME directory; refuse
  a symlinked config target (lstat before write); preserve the existing file mode; back up before
  the first modification; preserve third-party `mcpServers` entries; idempotent re-runs. v1
  assumes a single writer (no cross-process lock) — stated explicitly.
- Accepted behavior, stated: the server's first query on a fresh machine creates `~/.prhero/` and
  an empty schema-v3 store (§0.7) and answers with zero rows.

### D8: `pr-hero doctor` — tri-state, read-only
- Every check reports **`healthy | degraded | blocking`**; the overall status is the worst check.
  **Blocking** (exit 1) = a paid review cannot run: `git` missing; `claude` missing or
  unauthenticated; a config `agents_dir` pointing at a missing path (`cli.ts:3581`); empty
  gotchas in the current repo (the `cli.ts:800-807` gate will refuse). **Degraded** (exit 0, with
  actionable hints) = optional facts: `gh` missing/unauthenticated (PR mode only), codegraph
  facts false, skills not yet synced or stale, MCP not registered, `setup.json` absent
  (informational: run `pr-hero init`). **Healthy** = exit 0. A boolean doctor would lie: gh,
  codegraph, and the setup state are optional and cannot mean exit 1.
- Skills and MCP checks are **read-only** — doctor never repairs; it prints the command that
  would.
- **The roster grows by slice, by design:** S2 ships doctor with system-tools + config/setup
  checks only; S3 (agent-env) extends it with environment/skills/MCP checks. Each slice's doctor
  is complete for that slice, and both slices' tasks say so.
- **Stale `agents_dir` migration hint (blocking):** when a config layer's `agents_dir` resolves to
  a missing path (`resolveAgentsDir` throws `agents dir does not exist`, `cli.ts:3581` — the
  post-S1 state of any machine whose config still points at `../deep-review`), doctor hints to
  delete the key and fall through to the bundled default. Without this, existing C5 configs stay
  broken after S1 ships.

### D9: Uninstall — footprint documented now, command later
- A full uninstall touches: `~/.prhero/bin/pr-hero`, the watch and gc launchd plists, the skills
  copy under the agent environment, the `mcpServers.pr-hero` entry, and `~/.prhero/` (user data —
  listed, never auto-deleted; `setup.json` included). Documented in README from S5; a
  `pr-hero uninstall` command is post-v1.

### Skills sync strategy (closing rev 1's "copy or symlink")
- **Copy, with a content-digest marker and idempotent re-sync.** The sync marker records a
  **digest of the deployed files**; re-sync triggers on digest mismatch — which catches local
  edits and partial copies that an engine-version marker would miss. The engine version is
  recorded as informational metadata only. A compiled binary cannot symlink out of its embedded
  FS, and copies survive package moves/upgrades.

---

## 3. Detailed Specifications

### 3.1 `src/assets.ts` (+ `src/asset-manifest.ts`)

```ts
export type AssetMode = "dev" | "npm" | "compiled";

export interface EngineAssets {
  mode: AssetMode;
  bundledAgentFiles: Record<string, string>; // logical filename → path, from the manifest (every mode)
  defaultAgentsDir?: string;                 // the real prompts/default dir in dev/npm; absent when compiled
  scoutPromptPath: string;
  summarizerPromptPath: string;
  triageSkillFiles: Record<string, string>;  // logical filename → path, from the manifest
  version: string;                           // baked at compile; package.json otherwise
}

export function resolveEngineAssets(): EngineAssets;

export interface SelfInvocation {
  command: string; // absolute: the bun binary (dev/npm) or the compiled binary itself
  args: string[];  // [absolute cli.ts] in dev/npm; [] when compiled
}
export function selfInvocation(): SelfInvocation;
```
`src/asset-manifest.ts` is the only file with `import ... with { type: "file" }` statements and is
consumed only by `src/assets.ts`. A dev-side build-time test asserts manifest ↔ `prompts/default/`
parity and that the manifest-loaded set passes the spec match. Pure resolution logic is testable
offline; the compiled branch is proven by the release smoke (O-11).

### 3.2 `src/agent-env.ts`

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
  command: string; // SelfInvocation-derived; absolute; never the npm shim, never a bare name (D7)
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
`AgentEnvRegistry` enumerates adapters; lookups of unknown ids return `undefined`, never throw.
Callers (wizard, doctor) consult `capabilities` before calling `syncSkills`/`registerMcpServer` —
stubs declare `{ skills: false, mcp: false }` and omit the methods. `ClaudeAgentEnvAdapter`
detects via `Bun.which("claude")`, auth via `CLAUDE_CODE_OAUTH_TOKEN` / session files / probe;
skills sync per the digest-copy contract; MCP registration per D7.

### 3.3 `src/system-tools.ts`

```ts
export interface SystemToolStatus {
  installed: boolean;
  version?: string;
  authOk?: boolean;      // gh, claude
  repoIndexed?: boolean; // codegraph: the fact the engine actually gates on
  hint?: string;
}
```
`git` and `claude` required; `gh` optional (binary + `gh auth status`); `codegraph` optional with
the two-fact status and an indexing action, never only a binary check.

### 3.4 `src/wizard.ts` — steps as data

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
consented commit, sync/registration) belong to the step, not to a runner switching on ids; that is
what keeps "adding a step" one entry. Machine-level applies are idempotent (skip-if-healthy).
Navigation: arrows / space / enter / esc-q-ctrl+C, raw mode via the `ui-select.ts` pattern; non-TTY
falls back to the static scaffold. All transitions, selections, and renders offline-testable (O-8);
renderers assert zero `\x1b` bytes with styles off, per the house acceptance criteria.

### 3.5 Verification step contract (step 5)
Runs only after step 4's apply → consented commit — the clean-tree gate (§0.4) sits before the
dry-run exit. Proves: config resolution, bundled prompt resolution, plan construction, cost band —
inside a git repo with a clean tree, $0. Does not prove: gotchas quality, claude auth, spawn.
Outside a repo, or when the tree could not be cleaned (declined consent, or pre-existing unrelated
dirt the wizard must never touch): honest skip naming which cause applies, with the exact
commands. After a gotchas skip, the dry-run is EXPECTED to stop at the gotchas gate
(`cli.ts:800-807`) — the step frames that as the designed "blocked on gotchas — you chose to skip;
write real ones and re-run" outcome, never as a failure. Optional paid ping (~$0.04) on explicit
selection only.

### 3.6 `~/.prhero/setup.json`

```json
{ "onboarding_version": 1, "completed_at": "2026-08-24T00:00:00Z" }
```
Its own file with its own schema, outside the C5 config parsers — the `watch.json` precedent.
Written only by step-4 `apply` and `init --yes`; read by the zero-arg gate and doctor. A version
bump in a future onboarding revision makes older state count as un-onboarded, re-offering the
wizard without touching any config.

---

## 4. Tradeoffs & Rejected Alternatives

1. **Model picking in onboarding** — rejected (D6): accuracy is benchmarked on sonnet; the escape
   hatch stays but is labeled uncalibrated.
2. **One provider interface for execution + environment** — rejected (D2): the axes change at
   different speeds; Phase D owns execution.
3. **Symlinking skills** — rejected: impossible from a compiled binary, brittle across upgrades;
   copy + content-digest marker wins.
4. **Runtime prompt download** — rejected: offline determinism is a product property.
5. **Five OpenSpec changes (one per slice)** — rejected: `canonical-store` shipped as one change
   with task-unit slices and per-slice PRs; same here. Ceremony is per-PR, not per-change.
6. **Hiding the prompts (binary-only distribution)** — rejected by D0: full open source; npm is the
   launch registry, and readable prompts are the cost of that posture, accepted explicitly.
7. **Moving doctor next to the wizard (Codex)** — rejected: nothing ships publicly before S5, and
   the per-slice-complete roster is declared in both slices' tasks; a tools-only doctor in S2 is an
   honest dev-facing diagnostic, not an exposed incomplete product.
8. **`compile.assets` for embedding (rev 2/3)** — rejected on empirical evidence (§0.6): a silent
   no-op on the pinned Bun. The import manifest is not a workaround but the permanent mechanism —
   it is version-robust and gives dev and compiled modes one code path.
9. **A `{}` config file as the configured marker (rev 3)** — rejected (D4): a config file's
   existence cannot represent onboarding completion; `setup.json` separates the two states and is
   versionable.

---

## 5. Delivery Plan — five slices, one PR each (canonical-store precedent)

- **S1 — The unbreaker** (no external dependencies): productized `prompts/default/` + PROVENANCE +
  gates (`refuter-probe`, `fixture-eval`); `src/asset-manifest.ts` + `src/assets.ts` (manifest
  loading, dev/npm modes; build-time parity + spec-match tests); default resolution in
  `resolveAgentsDirSetting` (bundled default loads via the manifest); delete `SUGGESTED_AGENTS_DIR`
  from all four sites incl. `scripts/martian-cal.ts` (verified with the real toolchain); `init`
  seed change; doc erratas. After merge: pr-hero works on any machine via clone or npm-link.
- **S2 — Checkers + doctor**: `src/system-tools.ts` (claude required, two-fact codegraph, gh
  auth) + `pr-hero doctor` with the **tri-state model** (healthy/degraded/blocking) over the
  system-tools + config/setup roster; env/skills checks arrive with S3, and both slices' tasks
  say so. No TUI yet.
- **S3 — Environment integration**: `src/agent-env.ts` (capabilities-declaring adapters: claude
  active + antigravity/opencode/codex/cursor stubs, groq dropped); skills sync (copy +
  content-digest marker, idempotent); `selfInvocation()` in `src/assets.ts` and MCP registration
  derived from it (`claude mcp add --scope user` preferred, hardened atomic fallback); doctor's
  env/skills/MCP checks go live; SKILL.md license → Apache-2.0.
- **S4 — Wizard TUI**: steps-as-data reducer with `apply` hooks + renderers + raw-mode runner;
  the zero-arg parser change (TTY gate, `setup.json` detection incl. the hand-created-config
  scenario); the setup-state write (apply-time, cancel semantics); gotchas walk with skip
  truncation + step-5 blocked-on-gotchas framing; commit-vs-ignore APPLIED (consented path-scoped
  commit, pre-existing-dirt honest skip); the D6 plan-card warning; `init`/`setup` integration
  with `--non-interactive` parity. **Ordered after S3 on purpose**: the wizard consumes real
  checkers (S2) and real adapters (S3), so no step ships hollow.
- **S5 — Packaging** (D0-dependent, D0 now decided): `LICENSE` (Apache-2.0); `package.json`
  publish fields (`private: false`, `files`, `engines` pinning the CI Bun version, `license`);
  README rewrite off the clone-based install; `.github/workflows/release.yml` (matrix, manifest
  embedding, autoload-off flags, checksums, **per-platform real-binary smokes**, the **npm-pack
  smoke (O-16)**, same-commit/same-version publish with `--provenance`, signing stance
  documented); `install.sh`; watch/gc/plist onto `selfInvocation()`; version bake + provenance
  fallback; claim the npm name; roadmap ticks + architecture-list updates in `CLAUDE.md` AND
  `AGENTS.md` (both exist at repo root).

---

## 6. The Done Checklist & Named Test Obligations

- [ ] **O-1 (Bundled Prompts):** `prompts/default/` contains the 5 production agent files (original
      filenames), productized per D1, plus `PROVENANCE.md`.
- [ ] **O-2 (Relative Resolution):** the bundled default resolves via `src/assets.ts` and **loads
      through the asset manifest in every mode**; `SUGGESTED_AGENTS_DIR` is gone from
      `preflight.ts:47`/`:1269`, `cli.ts:148`/`:3605`, and `scripts/martian-cal.ts:27,168`;
      `localReviewSpec()` validates the bundled set (build-time); no `/Users/juanma` path remains
      in runtime code or error text.
- [ ] **O-3 (Environment Interface):** `AgentEnvAdapter` defined with declared capabilities;
      `ClaudeAgentEnvAdapter` implements detect/auth/skills/MCP.
- [ ] **O-4 (Registry):** `AgentEnvRegistry` enumerates claude + stubs (no groq) without throwing;
      unknown ids return `undefined`; callers consult capabilities before invoking optional
      methods.
- [ ] **O-5 (System Tools):** `checkSystemTools()` classifies `git`, **`claude` (required:
      binary + auth)**, `gh` (auth), `codegraph` (**binaryInstalled AND repoIndexed**) correctly,
      offline-mocked.
- [ ] **O-6 (Skills Sync):** copy-based sync deploys `pr-hero-triage` idempotently with a
      **content-digest marker**; re-sync detects digest mismatch (local edits, partial copies).
- [ ] **O-7 (MCP Registration):** registers the **SelfInvocation-derived command** idempotently
      (`--scope user` on the provider CLI path), preserves third-party servers, hardened atomic
      fallback tested (same-dir temp+rename, symlink refusal, mode preservation, backup).
- [ ] **O-8 (Wizard Purity):** every step transition, selection, `apply` outcome (as state), and
      render is offline-tested — including the setup-state timing (cancel before step 4 leaves the
      machine un-onboarded; hand-created config.json without setup.json still counts
      un-onboarded), the gotchas matrix (collected / informed skip with truncation, never touching
      a pre-existing file), the commit-flow matrix (consent given/declined × pre-existing dirt),
      and the descriptor-array extension test; renderers return `string[]`, take `{styles,width}`,
      zero `\x1b` with styles off.
- [ ] **O-9 (Installer):** `install.sh` detects OS/arch, verifies SHA256, installs to
      `~/.prhero/bin`, idempotent PATH block; unsupported platforms fail loudly.
- [ ] **O-10 (npm Readiness):** `package.json` **adds** `files` (with the D0 exclusions),
      `engines` (pinned to the CI Bun version), `license: "Apache-2.0"`, sets `private: false`;
      no local-path dependencies.
- [ ] **O-11 (Compiled Smoke):** the release pipeline runs **each published binary on its
      platform's runner** — `--help` + `review --dry-run` on a fixture repo + bundled
      prompt/skill resolution. Exists precisely because packaging features can silently no-op
      (`compile.assets`, proven 2026-08-24).
- [ ] **O-12 (Doctor):** `pr-hero doctor` classifies **healthy / degraded / blocking** correctly
      offline; blocking → exit 1, healthy/degraded → exit 0; checks are read-only.
- [ ] **O-13 (Release Workflow):** tag-triggered workflow produces the 4-target matrix +
      `SHA256SUMS` consumed by `install.sh`; npm package and binaries publish from the SAME commit
      and version (`npm publish --provenance`); autoload-off flags set; the Bun build version is
      pinned and matches `engines`.
- [ ] **O-14 (License Coherence):** `LICENSE`, `package.json.license`, and
      `skills/pr-hero-triage/SKILL.md` all say Apache-2.0.
- [ ] **O-15 (Prompt Productization Gates):** `refuter-probe` and `fixture-eval` pass on the
      bundled set; `PROVENANCE.md` present; zero `deep-review` in frontmatter `name:` fields and
      prompt BODY content, zero stale config paths, `hunting-map.md` citations, or "golden"
      vocabulary. **Filenames and `PROVENANCE.md` are exempt** — D1 keeps the filenames, and
      provenance must name the source set; the roadmap launch gate (`ROADMAP.md:239`) stays about
      CLI output, not repo internals.
- [ ] **O-16 (npm-pack Smoke):** `npm pack` → install into an isolated temp prefix →
      `pr-hero --help` → fixture `review --dry-run` **outside the checkout** — distribution is
      validated by executing the published artifacts, not by inspecting configuration files.
