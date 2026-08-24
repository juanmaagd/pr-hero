# Tasks: Pillar 1 — Install, Configure & Onboarding in One Flow

Rev 4 (2026-08-24, post Codex review + empirical verification). Delivery follows the
`canonical-store` precedent: **one OpenSpec change, five slices (S1–S5), one PR per slice**,
strict TDD (RED → GREEN → REFACTOR) inside each slice, each PR closing with the full verification
tail (`bun test`, `bun run typecheck`, `bun run check`). D0 is decided (2026-08-24: full open
source, Apache-2.0), so no slice is blocked. **Slice order is dependency-driven** (rev 3 swapped
the wizard behind the adapters): S1 unbreaker → S2 checkers+doctor → S3 agent-env → S4 wizard
(consumes S2 AND S3 — no step ships hollow) → S5 packaging. Rev 4 replaces `compile.assets`
(empirically a silent no-op on Bun 1.3.14) with the import manifest, flips the onboarding marker
to `~/.prhero/setup.json`, and adds `selfInvocation()`, gotchas-skip truncation, the tri-state
doctor, digest sync, capabilities, the D6 warning, and the published-artifact smokes (O-16).

---

## Slice S1 — The Unbreaker: bundled productized prompts + manifest assets authority (O-1, O-2, O-15)

After merge: `pr-hero review` works on any machine via clone or npm-link, with zero prompt config.

- [x] **S1.1 (RED) Asset + resolution tests**
  - Create `test/assets.test.ts`: `resolveEngineAssets()` returns existing paths for dev mode
    (every manifest entry resolves to a real file); scout/summarizer/bundled-agent/version fields
    populated; **manifest ↔ `prompts/default/` parity** — a file added or removed on either side
    fails the test naming the drifted entry; the manifest-loaded set passes the
    `localReviewSpec()` spec match (all five logical names, nothing extra — the build-time home
    of the bidirectional check for the bundled default).
  - Create `test/preflight-bundled-prompts.test.ts`: `resolveAgentsDirSetting` with no flag, no
    config, no `PRHERO_AGENTS_DIR` returns the bundled default with `source: "default"` and does
    not throw; explicit flag/config/env still win with their existing `source` labels
    (precedence unchanged) and stay FS-loaded; error-path text nowhere references `/Users/juanma`
    or `deep-review`.
  - Add a repo-hygiene test: no runtime source file matches `SUGGESTED_AGENTS_DIR` or
    `/Users/juanma`; and the O-15 scan over `prompts/default/` — frontmatter `name:` + body only,
    **filenames and `PROVENANCE.md` exempt** — finds zero `deep-review` / `hunting-map` /
    `golden` / `/Users/` matches.
- [x] **S1.2 (GREEN) Productize and bundle the 5 prompt files**
  - Copy the five files from the clean set into `prompts/default/` under their **original
    filenames** (`deep-review-lifecycle.md`, `deep-review-parity.md`,
    `deep-review-reliability.md`, `deep-review-resilience.md`, `review-refuter.md`).
  - Branding-only content pass: frontmatter `name:` → `pr-hero-*`; headings rebranded;
    `deep-review.config.json` → `.prhero/config.json`; `deep-review/intel/gotchas.md` →
    `.prhero/gotchas.md`; `hunting-map.md` category citations inlined or removed; "golden"
    vocabulary removed. No other `deep-review-*.md` / `review-*.md` file may be added
    (bidirectional `agentsDirProblems`, `src/preflight.ts:1510-1533`, hard-errors on strays).
  - Write `prompts/default/PROVENANCE.md`: source set `slice3b-lifecycle-v6-clean`, freeze date,
    branding-only edits, no behavioral intent.
- [x] **S1.3 (GATE — live, mandatory) Prompt-change gates**
  - `bun run refuter-probe` passes on the bundled `review-refuter.md` — the repo `CLAUDE.md` names
    the probe as THE first gate for any refuter prompt change (all four verdict outcomes).
  - One `bun run fixture-eval` passes against `prompts/default/`.
  - Record both results (cost + outcome) in the S1 PR description per house ledger rule.
- [x] **S1.4 (GREEN) `src/asset-manifest.ts` + `src/assets.ts` + resolution wiring**
  - Implement `src/asset-manifest.ts`: one `import ... with { type: "file" }` per packaged asset
    (5 bundled agent files, `prompts/scout.md`, `prompts/summarizer.md`,
    `skills/pr-hero-triage/SKILL.md` + `adjudicator.md`), exporting the logical-name → path map.
    **`compile.assets` is used nowhere** (empirically a silent no-op — verified 2026-08-24 on
    Bun 1.3.14).
  - Implement `resolveEngineAssets()` (modes `dev` / `npm`; the compiled branch is the same code
    path — proven — and is exercised by S5's O-11 smoke); the bundled default loads via the
    manifest map in every mode; custom sets stay FS-based.
  - Migrate the scout/summarizer path constants (`src/cli.ts:265-290`) to the assets module.
  - Add the `source: "default"` branch to `resolveAgentsDirSetting`; delete
    `SUGGESTED_AGENTS_DIR` from `src/preflight.ts:47` and `:1269` and `src/cli.ts:148`.
  - `init` agents seed (`src/cli.ts:3595-3605`): `--agents` → `PRHERO_AGENTS_DIR` → omit the key
    entirely — `initConfigTemplate` **omits `agents_dir` when the source is the bundled default**
    (a machine path committed to the TEAM file is worse than the npm-prefix bug).
- [x] **S1.5 (GREEN) Migrate `scripts/martian-cal.ts` off the constant**
  - Pin the lab set path as a local constant inside the script (it is a lab instrument and
    machine-specific by nature); remove the `src/preflight` import (`:27`, `:168`).
  - **Verify with the real toolchain** — `scripts/` is covered by neither `bun run typecheck` nor
    `bun run check`: run `./node_modules/.bin/biome check scripts/martian-cal.ts` and the
    reconstructed project tsc flags, sanity-checking the recipe against an unchanged sibling
    script first (per repo `CLAUDE.md`; never `bunx`).
- [x] **S1.6 (REFACTOR) Doc erratas + suite**
  - Refresh the stale line references in `docs/c5-global-config-design.md` citations touched by
    this slice.
  - `bun test`, `bun run typecheck`, `bun run check` — zero regressions.

---

## Slice S2 — System tool checkers + doctor (O-5, O-12)

Doctor ships here with the **system-tools + config/setup-presence roster only**;
environment/skills/MCP checks arrive with S3 (the roster grows by slice, by design — each slice's
doctor is complete for that slice).

- [x] **S2.1 (RED) Checker tests**
  - Create `test/system-tools.test.ts`: git required/fatal-when-missing; **claude
    required** — binary + auth matrix (env token / session / probe / unauthenticated with the
    actionable command), required-tool-unhealthy blocks review-readiness; gh optional with
    `authOk` from `gh auth status`; codegraph **two facts** (`installed` via binary,
    `repoIndexed` via `existsSync(<repo>/.codegraph)`) across all four combinations; `install()`
    hooks fire only when invoked and surface errors; Linux-without-Homebrew prints the manual
    command and continues; all offline via injected spawn/fs fakes.
- [x] **S2.2 (GREEN) Implement `src/system-tools.ts`**
  - `SystemTool`, `SystemToolStatus { installed, version?, authOk?, repoIndexed?, hint? }`,
    `checkSystemTools(cwd)`; checkers for git/claude/gh/codegraph; interactive-only install
    actions.
- [x] **S2.3 (RED) Doctor tests — tri-state**
  - Create `test/doctor.test.ts` around `healthy | degraded | blocking` (overall = worst check;
    blocking → exit 1, healthy/degraded → exit 0):
    - **Blocking cases:** git missing; claude missing; claude unauthenticated; **stale
      `agents_dir`** — a config layer whose `agents_dir` resolves to a missing path reports
      "delete the key to fall through to the bundled default" (`resolveAgentsDir` throws
      `agents dir does not exist`, `src/cli.ts:3581`); empty `gotchas.md` in the current repo
      (the `src/cli.ts:800-807` gate will refuse a review).
    - **Degraded cases (exit 0 + actionable hints):** gh missing or unauthenticated; codegraph
      binary-missing or repo-unindexed; `~/.prhero/setup.json` absent (hint: run
      `pr-hero init`).
    - Checks are read-only (assert no writes); renderer returns `string[]`, takes
      `{styles,width}`, zero `\x1b` with styles off.
- [x] **S2.4 (GREEN) Implement `pr-hero doctor`**
  - New command in the parser union + dispatch; reuses the S2 checkers; tri-state aggregation and
    exit mapping; env/skills/MCP checks join in S3 (state the growth in the help text if listed).
- [x] **S2.5 (REFACTOR)** Full tail; help text updated.

---

## Slice S3 — Agent-environment integration (O-3, O-4, O-6, O-7)

- [x] **S3.1 (RED) Adapter + registry tests**
  - Create `test/agent-env.test.ts`: registry roster (claude active `{skills:true, mcp:true}` +
    antigravity/opencode/codex/**cursor** stubs `{skills:false, mcp:false}`, **no groq**),
    unknown id → `undefined`; **capabilities gate the calls** — stubs implement neither optional
    method and callers consult `capabilities` first; `ClaudeAgentEnvAdapter.detect()` auth matrix
    (env token / session file / probe / unauthenticated with actionable message); stub adapters
    resolve without throwing.
  - Skills sync tests over temp dirs: copy (assert **no symlink**), **content-digest marker**
    written; idempotent second run; **digest mismatch triggers re-sync** (edit a deployed file
    locally — engine version unchanged — and assert redeployment); partial copies detected.
  - MCP registration tests over temp configs: command is **SelfInvocation-derived** (absolute
    bun + absolute cli.ts in dev; never a bare name, never the shim path); provider-CLI path
    preferred with **`--scope user`** asserted in the spawned argv (spawn fake); hardened atomic
    fallback — same-dir temp+rename, **symlinked target refused** (lstat), file mode preserved,
    backup written; third-party `mcpServers` preserved; idempotent re-run.
- [x] **S3.2 (GREEN) Implement `src/agent-env.ts` + `selfInvocation()`**
  - Add `selfInvocation()` to `src/assets.ts` (dev/npm: `process.execPath` + absolute `cli.ts` —
    the `src/watch.ts:547-548` pair; compiled: the binary itself, `[]`).
  - Types (`AgentEnvId` incl. `cursor`, `AgentEnvCapabilities`), registry,
    `ClaudeAgentEnvAdapter`, stubs (detect-only); verify the exact `claude mcp add --scope user`
    invocation against the installed CLI during implementation and record it in a code comment
    stating both constraints (SelfInvocation-derived command — the launchd PATH lesson,
    `src/watch.ts:125-128`; and the `local` default scope that makes `--scope user` mandatory).
- [x] **S3.3 (GREEN) Doctor env checks go live**
  - Extend `pr-hero doctor` with environment detection + auth, skills **digest** state, MCP
    registration state, store health — all as degraded-tier checks; `test/doctor.test.ts` grows
    the matching cases (digest-stale skills, unregistered MCP → degraded, exit 0).
- [x] **S3.4 (GREEN) License alignment**
  - `skills/pr-hero-triage/SKILL.md` frontmatter `license: MIT` → `Apache-2.0` (D0/O-14 partial;
    the LICENSE file itself lands in S5).
- [x] **S3.5 (REFACTOR)** Full tail; temp-dir hygiene in every test.

---

## Slice S4 — Wizard TUI + zero-arg parser change (O-8)

Ordered after S3 on purpose: step 3 consumes the real S3 adapter and step 1 the real S2 checkers —
no step ships hollow.

- [x] **S4.1 (RED) Reducer + steps-as-data tests**
  - Create `test/wizard.test.ts`: initial state on `WIZARD_STEPS[0]`; deterministic transitions
    across the five descriptors; navigation actions (up/down/space/enter/prev/cancel); a
    synthetic extra descriptor advances with no reducer change (proves steps-as-data); **`apply`
    lives on the descriptor** — the runner never switches on step ids (assert via a fake
    descriptor whose `apply` records its invocation); **gotchas matrix** — collected (REPLACE:
    no `<subsystem>: <...>` survives) vs informed skip (**the wizard-scaffolded file is
    TRUNCATED to empty; a pre-existing user `gotchas.md` is never touched** — the guard has its
    own case); verification-step states (proven / not-proven lists, outside-a-repo honest skip,
    **blocked-on-gotchas framed as the expected outcome after a skip**); renderer contract
    assertions (zero `\x1b` with styles off).
  - **Setup-state tests:** step 4 `apply` writes `~/.prhero/setup.json` with the current
    `onboarding_version` (temp home) and **never touches `~/.prhero/config.json`**; **cancel
    before step 4 applies → no `setup.json`, machine still un-onboarded**; existing current
    `setup.json` → apply skips (idempotent); **hand-created `config.json` without `setup.json`
    still counts un-onboarded**.
  - **Commit-flow matrix tests** (pure decisions over injected git status): consent given ×
    clean-except-wizard-paths → one path-scoped commit plan (`git add .prhero/` or the
    `.gitignore` edit; **never `commit -a`**); consent declined → step 5 honest-skip with the
    exact commands; **pre-existing unrelated dirt → honest-skip regardless of consent**, message
    distinguishing "your `.prhero/` needs committing (the wizard can do that)" from "you have
    unrelated uncommitted work"; order apply → consented commit → dry-run enforced.
- [x] **S4.2 (GREEN) Implement `src/wizard.ts`**
  - Full `WizardState`; `WIZARD_STEPS` descriptors with `probe`/`apply`/`render`;
    `wizardReducer`; the `default_base` show+override question; per-step renders; completion
    screen with the next commands (`review --dry-run`, `review`, `review --pr <n> --post`,
    `watch add`, `doctor`, `config`).
- [x] **S4.3 (GREEN) Raw-mode runner + non-TTY fallback**
  - Interactive runner on the `src/ui-select.ts` raw-mode pattern; Esc/q/Ctrl+C restore terminal
    mode; non-TTY never enters raw mode.
- [x] **S4.4 (RED) CLI integration tests + D6 warning**
  - Create `test/cli-onboarding.test.ts` & `test/entry-zero-arg.test.ts`: `init`/`setup` open the wizard in a TTY;
    `--non-interactive`/`--yes` run the static scaffold (existing never-overwrite behavior
    preserved) **and write `setup.json`**; **zero-arg matrix**: TTY + no `setup.json` → wizard
    (including when a hand-created `config.json` exists); TTY + current `setup.json` →
    `HELP_TEXT`, exit 0; non-TTY → byte-identical usage error + help + exit 2.
- [x] **S4.5 (GREEN) Parser change + routing + warning**
  - Amend `parseArgs` (`src/preflight.ts:695-699`) with the TTY-gated zero-arg route
    ("onboarded" = current `~/.prhero/setup.json`); wire `init`/`setup` dispatch to the wizard;
    implement the plan-card `--model` warning line.
- [x] **S4.6 (REFACTOR)** Full tail; `bun test` green.

---

## Slice S5 — Packaging, release pipeline & distribution (O-9, O-10, O-11, O-13, O-14, O-16)

- [x] **S5.1 (RED) Packaging tests**
  - Create `test/packaging.test.ts`: `package.json` has `private: false`,
    `license: "Apache-2.0"`, an `engines` field **pinning the CI Bun version**, and a
    `files` whitelist containing `src`, `prompts`, `skills/pr-hero-triage`, `README.md`,
    `LICENSE` — and NOT `docs`, `scripts`, `fixtures`, `test`, `openspec`, or
    `skills/martian-bench`; `LICENSE` exists and is Apache-2.0; `install.sh` exists, is
    executable, contains OS/arch detection, SHA256 verification, and the idempotent PATH block;
    `.github/workflows/release.yml` names the four targets, the checksums file `install.sh`
    consumes, the `--no-compile-autoload-dotenv`/`--no-compile-autoload-bunfig` flags, the
    pinned Bun version (matching `engines`), and the same-commit npm+binaries publish with
    `--provenance`.
- [x] **S5.2 (GREEN) LICENSE + package.json + README**
  - Add `LICENSE` (Apache-2.0). Update `package.json` (`private: false`, `files`, `engines`
    pinned, `license`). Rewrite `README.md` install/onboarding sections off the clone-based flow
    (`README.md:19`): curl installer, `npm i -g pr-hero` (with the explicit Bun requirement for
    the npm channel), `pr-hero init`, doctor, the uninstall footprint (D9), and the recorded
    platform stances (musl deferred, x64 baseline deferred, macOS ad-hoc signature with
    notarization deferred).
- [x] **S5.3 (GREEN) Compiled-mode engine fixes**
  - Migrate `src/watch.ts` and `src/gc.ts` spawns AND launchd plist rendering
    (`watch.ts:547-548`, `:746-747`; `gc.ts:277,294`) onto `selfInvocation()` — compiled mode
    resolves to the binary itself — with offline tests over the pure invocation decision.
  - Version bake: build-time `define` consumed by `src/assets.ts`; provenance
    (`src/cli.ts:5179-5188`) prefers the baked version and degrades gracefully with no git.
- [x] **S5.4 (GREEN) Release workflow + installer**
  - `.github/workflows/release.yml`: tag-triggered; four targets (`darwin-arm64`, `darwin-x64`,
    `linux-x64`, `linux-arm64`) via `bun build --compile` (manifest-embedded assets — no
    `compile.assets` anywhere); `--no-compile-autoload-dotenv` + `--no-compile-autoload-bunfig`;
    the Bun build version pinned; version baked from the tag; `SHA256SUMS` published beside the
    binaries; **npm package and binaries built and published from the same commit and version in
    this one workflow, npm publish with `--provenance`**; glibc via ubuntu-LTS runners (musl
    deferred, documented).
  - `install.sh`: OS/arch detection with loud unsupported-platform failure, download, SHA256
    verification (abort on mismatch), `~/.prhero/bin` install, idempotent PATH block for
    zsh/bash/fish, non-interactive `curl | bash` support.
- [x] **S5.5 (GREEN) Publish + bookkeeping**
  - `ROADMAP.md`: tick the distribution checklist lines this slice satisfies; update the
    architecture list in `CLAUDE.md` **and `AGENTS.md`** (both exist at repo root) with
    `src/assets.ts` (+ manifest), `src/agent-env.ts`, `src/system-tools.ts`, `src/wizard.ts`
    one-liners.
- [x] **S5.6 (REFACTOR)** Full tail + verification suite.

---

## Cross-slice quality gates (every PR)

- [x] `bun test` — all offline suites green, zero regressions (1766 passing tests).
- [x] `bun run typecheck` — zero errors.
- [x] `bun run check` — zero lint/format issues.
- [x] Anything under `scripts/` or `fixtures/` touched by a slice is verified with
      `./node_modules/.bin/biome` + reconstructed tsc flags (never `bunx`).
- [x] Obligation audit at S5 close: O-1 … O-16 all fulfilled and named by a test or a recorded
      release-gate run.
