# Change Proposal: Pillar 1 — Install, Configure & Onboarding in One Flow

Rev 4 (2026-08-24): revised after the same-day terrain audit, Juanma's D0 publication decisions,
the adjudicated cross-model review (rev 3), and the adjudicated Codex review with empirical
packaging verification (rev 4). Authoritative design:
`docs/pillar1-distribution-onboarding-design.md` (rev 4).

## Why

`pr-hero` cannot currently be installed and run on a fresh developer machine:

1. **Hardcoded machine path:** `src/preflight.ts:47-48` hardcodes
   `/Users/juanma/Desktop/deep-review/agents/slice3b-lifecycle-v6-clean`; without `--agents`,
   config, or `PRHERO_AGENTS_DIR`, `resolveAgentsDirSetting` (`preflight.ts:1247-1271`) throws a
   `CliUsageError` naming that path. The constant has **four consumer sites** — `preflight.ts:47`
   + `:1269`, `cli.ts:148` + `:3605` (the `init` seed), and `scripts/martian-cal.ts:27,168`, the
   last of which is outside typecheck and lint coverage and would break silently.
2. **High setup friction:** `git`, `gh` (with auth), codegraph (binary **and** per-repo index —
   the engine's real gate is `existsSync(<repo>/.codegraph)`, `cli.ts:876`/`:1723`), `claude`
   (with auth — the execution runtime), skills, and MCP registration are disconnected manual
   steps.
3. **Conflated integration axes:** rev 1's `ProviderAdapter` mixed the *execution* axis (who runs
   the hunters — `StepRunner`, Claude-only in v1, Stage-2 obligations at `step-runner.ts:67-82`)
   with the *agent-environment* axis (which assistants receive the triage skill + MCP server).
4. **The compiled binary is a second runtime — and the packaging API rev 2/3 leaned on does not
   exist:** `compile.assets` is a **silent no-op** on Bun 1.3.14 (verified empirically
   2026-08-24: build `success: true`, binary ships WITHOUT the assets; `--asset` is absent from
   the CLI help — the main-branch docs describe an unreleased feature). Meanwhile
   `prompts/scout.md`/`summarizer.md` are already read via `import.meta.dir` (`cli.ts:265-290`);
   `watch.ts:130`/`gc.ts:278` re-spawn by resolving `cli.ts` + `bun`; the npm shim's
   `#!/usr/bin/env bun` shebang dies under launchd even via an absolute path; provenance reads
   `package.json` + git of the engine dir (`cli.ts:5179-5188`). None of these survive compilation
   unaddressed.
5. **npm blockers:** `package.json` is `private: true` with no `files`, no `engines`, no
   `license`, zero `dependencies`, and Bun-only APIs; there is no LICENSE file, no `.github/`, no
   release tooling, and README documents the retired clone-based install.
6. **Model calibration protection:** accuracy is measured with `sonnet` hunters/refuter; defaults
   must be protected without pretending a lock (`--model` overrides by design,
   `pipeline.ts:1789-1791`).

Resolving these delivers **Pillar 1** (`ROADMAP.md:143-150`, `ROADMAP.md:236-245`): any developer
on macOS or Linux installs via curl or npm, runs the onboarding wizard, and completes a verified
dry-run.

---

## What Changes

0. **D0 — Publication model (DECIDED 2026-08-24):** full open source; public repo; **Apache-2.0**
   (new `LICENSE`, `package.json.license`, `SKILL.md` license alignment); npm ships readable TS +
   prompts under a `files` whitelist that explicitly excludes `skills/martian-bench`, `docs/`,
   `scripts/`, `fixtures/`, `test/`, `openspec/`, `ROADMAP*`; claim the free `pr-hero` npm name;
   Homebrew tap stays post-launch.

1. **Bundled, productized prompt set (D1, O-1, O-2, O-15):** freeze the 5 files into
   `prompts/default/` with **original filenames** (spec/`AGENT_NAMES`/glob patterns intact) and a
   branding-only content pass (frontmatter `name:` → `pr-hero-*`, stale `deep-review.config.json`
   / `deep-review/intel/gotchas.md` refs → `.prhero/` paths, `hunting-map.md` citations resolved,
   "golden" vocabulary dropped) + `PROVENANCE.md`. Gates: `bun run refuter-probe` (mandatory — the
   refuter file is edited) and one `bun run fixture-eval`. `resolveAgentsDirSetting` returns the
   bundled default instead of throwing; `SUGGESTED_AGENTS_DIR` deleted from all four sites; `init`
   seeds `--agents` → `PRHERO_AGENTS_DIR` → omit.

2. **Manifest-based packaged assets (D5, O-2, O-11):** new `src/asset-manifest.ts` (one
   `import ... with { type: "file" }` per packaged asset — the empirically proven embedding
   mechanism; `compile.assets` used nowhere) feeding `src/assets.ts`, the single resolver for the
   bundled set, scout/summarizer prompts, triage skill files, and version across dev / npm /
   compiled. Embedded names are content-hashed, so the bundled default **loads via the manifest
   map in every mode**; custom sets stay FS-based; bundled-set validation moves to build-time
   tests. `selfInvocation()` (same module) is the one seat for "run myself again": absolute bun +
   absolute `cli.ts` in dev/npm (the `watch.ts:547-548` pair), the binary itself when compiled —
   reused by MCP registration, watch, gc, and plist rendering.

3. **Agent-environment adapters (D2, O-3, O-4):** `src/agent-env.ts` with `AgentEnvAdapter` +
   `AgentEnvRegistry`; **adapters declare capabilities** (`{ skills, mcp }`) and stubs implement
   no fictitious methods; `ClaudeAgentEnvAdapter` active; `antigravity`/`opencode`/`codex`/
   **`cursor`** stubs (cursor: the MCP data-layer's named consumer surface; active adapter is a
   fast-follow); **groq dropped** (model provider, not an agent environment). Execution axis
   explicitly out of scope (Phase D). Spec file renamed `specs/providers.md` →
   `specs/agent-env.md`.

4. **System tools preflight (D3, O-5):** `src/system-tools.ts` with **`claude` as a required
   tool** (binary + auth — the execution runtime; `StepRunner` spawns `claude -p`, so
   any-environment users still need it), codegraph as two facts (`binaryInstalled`,
   `repoIndexed`), `gh auth status`, interactive-only install actions, and the documented
   `EMPTY_MCP_CONFIG` fallback (including silent degradation in PR-mode worktrees).

5. **Onboarding wizard (D4, O-8):** steps-as-data pure state machine with **`apply` on the
   descriptor** (side effects never live in the runner); **step 4 applies**: writes the
   onboarding state **`~/.prhero/setup.json`** (`{ onboarding_version, completed_at }` — the
   `watch.json` precedent; **the wizard never writes `~/.prhero/config.json`**, so C5 O-9 stays
   fully intact; `init --yes` writes it too; apply-time write so cancelling earlier leaves the
   machine un-onboarded; a hand-created config without `setup.json` still counts un-onboarded),
   runs the **gotchas walk** (the template passes the fail-loud trim check —
   `preflight.ts:2140-2148` vs `pipeline.ts:665-672` — so real content is collected; writes
   REPLACE placeholders; an **informed skip TRUNCATES the wizard's own scaffold to empty**, never
   a pre-existing file, so the `cli.ts:800-807` gate blocks the first review at $0 and step 5
   frames that as the designed blocked-on-gotchas outcome), and **applies commit-vs-ignore**
   (default commit; both branches dirty the tree, so one consented path-scoped commit — never
   `commit -a`; pre-existing unrelated dirt → honest skip; order apply → commit → dry-run because
   the clean-tree gate at `cli.ts:735-748` precedes the dry-run exit). Machine-level steps are
   idempotent. Honest verification step (what `--dry-run` proves and does not, git-repo + clean-
   tree preconditions, optional ~$0.04 auth ping). Zero-arg becomes a **parser change**
   (`preflight.ts:695-699`) gated on TTY with "onboarded" = current `setup.json`; non-TTY
   behavior unchanged. The **D6 plan-card warning** for `--model` is implemented and tested here.

6. **Doctor (D8, O-12):** `pr-hero doctor` re-runs the wizard's checkers non-interactively with a
   **tri-state model** — `healthy | degraded | blocking` (blocking → exit 1: git/claude
   unhealthy, stale `agents_dir` → missing path, empty gotchas; degraded → exit 0 with hints:
   gh, codegraph, skills/MCP, `setup.json` absent); checks are read-only; the roster grows by
   slice (S2 tools+config/setup, S3 adds env/skills/MCP).

7. **MCP registration & skills sync (D7, O-6, O-7):** registration command **derived from
   `selfInvocation()`** (never a bare name, never the shim path — GUI/launchd PATH lesson,
   `watch.ts:125-128`, plus the shim's shebang); provider CLI preferred with **`claude mcp add
   --scope user`** (the installed CLI defaults to `local`, verified 2026-08-24); **hardened**
   atomic hand-edit fallback (same-dir temp+rename, symlink target refused, mode preserved,
   backup, single-writer stated); skills sync is **copy + content-digest marker**, idempotent,
   re-syncing on digest mismatch (catches local edits; engine version is informational only).
   Store auto-creation on first MCP query (`store.ts:37-56`) acknowledged as accepted behavior.

8. **Packaging & distribution (D5, O-9, O-10, O-11, O-13, O-14, O-16):** `LICENSE`;
   `package.json` (`private: false`, `files`, `engines` **pinning the CI Bun version**,
   `license`); README rewrite; tag-triggered `.github/workflows/release.yml` (4-target matrix,
   manifest-embedded assets, `SHA256SUMS`, `--no-compile-autoload-dotenv` +
   `--no-compile-autoload-bunfig`, **per-platform real-binary smokes**, the **npm-pack smoke
   (O-16)**, npm + binaries published from the **same commit and version** with
   `npm publish --provenance`, recorded platform stances: glibc/ubuntu-LTS with musl deferred,
   x64 non-baseline with `-baseline` deferred, macOS ad-hoc signature with notarization
   deferred); `install.sh` with checksum verification; `watch.ts`/`gc.ts`/plist rendering onto
   `selfInvocation()`; baked version + provenance fallback.

9. **Model defaults reframed (D6):** calibrated defaults in bundled frontmatter; `--model` stays
   as a documented-uncalibrated escape hatch with a plan-card warning — now tasked and tested
   (S4); no fake lock.

---

## Capabilities

### New Capabilities
- `distribution:bundled-prompts`: zero-config reviews from a productized, provenance-tracked
  bundled prompt set.
- `distribution:packaged-assets`: one authority (`src/assets.ts` fed by `src/asset-manifest.ts`)
  for asset resolution and self-invocation across dev, npm, and compiled runtimes.
- `distribution:agent-env-adapters`: capability-declaring detection, auth verification, skills
  deployment, and MCP registration for consumer coding assistants (execution axis excluded).
- `distribution:system-tool-checkers`: claude-required execution preflight, two-fact codegraph
  status, gh auth, interactive repair.
- `distribution:onboarding-wizard`: steps-as-data TUI wizard from raw environment to verified
  dry-run, including the onboarding state, the gotchas walk, and the applied commit-vs-ignore
  decision.
- `distribution:doctor`: non-interactive tri-state health check over the same checkers.
- `distribution:standalone-installer`: checksum-verified curl installer over release-built
  binaries.
- `distribution:npm-package`: public Apache-2.0 npm package with an explicit files whitelist and
  executed-artifact verification.

### Modified Capabilities
- `preflight:resolve-agents-dir`: falls back to the bundled default (source `"default"`, loaded
  via the asset manifest) instead of throwing a machine path.
- `cli:init`: interactive wizard in TTYs; `--non-interactive`/`--yes` keep deterministic
  scaffolding plus the onboarding state; agents seed no longer references a machine path.
- `cli:zero-arg`: parser-level TTY-gated routing on `setup.json` to wizard/help; non-TTY
  unchanged.

---

## Impact & Blast Radius

- **`src/preflight.ts`**: `SUGGESTED_AGENTS_DIR` removed; `resolveAgentsDirSetting` default
  branch; zero-arg parser change at `:695-699`; init template seed (omits `agents_dir` on the
  bundled default).
- **`src/cli.ts`**: `:148`/`:3605` constant removal; scout/summarizer reads (`:265-290`) migrate
  to assets; init/setup wizard routing; doctor command; plan-card `--model` warning.
- **`scripts/martian-cal.ts`**: pins its lab path locally (out of `src/`); verified with the real
  toolchain (never `bunx`).
- **New files**: `src/asset-manifest.ts`, `src/assets.ts`, `src/agent-env.ts`,
  `src/system-tools.ts`, `src/wizard.ts`, `prompts/default/` (5 files + `PROVENANCE.md`),
  `LICENSE`, `install.sh`, `.github/workflows/release.yml`, tests for each; `~/.prhero/setup.json`
  (runtime state, written by onboarding).
- **`src/watch.ts` / `src/gc.ts`**: spawns and plist rendering move onto `selfInvocation()`.
- **`package.json`**: `private: false`, `files`, `engines` (pinned), `license`.
- **`README.md`**: install/onboarding rewrite off the clone-based flow; uninstall footprint;
  platform stances.
- **`skills/pr-hero-triage/SKILL.md`**: license field → Apache-2.0.
- **`ROADMAP.md` / `CLAUDE.md` / `AGENTS.md`**: distribution ticks + architecture list updates at
  S5 (`CLAUDE.md` and `AGENTS.md` both exist at repo root).

---

## Rollback Plan & Safety

- **Backward compatibility:** flag/config/env precedence unchanged (`--agents` > repo config >
  global config > `PRHERO_AGENTS_DIR` > bundled default); existing configs keep winning over the
  bundled default; `--non-interactive` preserves scripted `init`; the wizard never writes or
  edits `~/.prhero/config.json`.
- **Non-TTY safety:** zero-arg and `init` never enter raw mode without a TTY; CI/launchd behavior
  is byte-identical to today where not explicitly changed.
- **Graceful degradation:** missing codegraph (binary or index) falls back to `EMPTY_MCP_CONFIG`;
  missing gh only disables PR mode; the wizard always prints the manual command for any step it
  cannot complete; a gotchas skip degrades to the designed $0 gate, never to placeholder
  injection.
- **Reversion:** each slice is one PR (canonical-store precedent); S1's resolution change reverts
  to the throwing behavior with no schema or store impact; `setup.json` is additive state whose
  absence simply re-offers onboarding; packaging (S5) is additive and revertible file-by-file.
