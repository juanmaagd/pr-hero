# Specification: Distribution, Packaged Assets & Bundled Prompts

Rev 4 (2026-08-24, post Codex review + empirical verification).

## 1. Bundled Production Prompt Set

### 1.1 Requirements

- `prompts/default/` **MUST** contain the frozen 5-agent production set under the **original
  filenames** (`deep-review-lifecycle.md`, `deep-review-parity.md`, `deep-review-reliability.md`,
  `deep-review-resilience.md`, `review-refuter.md`) so `AGENT_NAMES` (`src/prompt-set.ts:14-19`),
  `localReviewSpec()` (`src/preflight.ts:1540-1559`), and `AGENT_FILE_PATTERNS`
  (`src/preflight.ts:1502`) remain unchanged.
- The bundled files **MUST** be productized (branding-only, no behavioral intent): frontmatter
  `name:` rebranded `pr-hero-*`; headings rebranded; references to `deep-review.config.json` and
  `deep-review/intel/gotchas.md` replaced with `.prhero/config.json` and `.prhero/gotchas.md`;
  `hunting-map.md` citations resolved (inlined or removed); "golden" vocabulary removed.
- `prompts/default/PROVENANCE.md` **MUST** record the source set (`slice3b-lifecycle-v6-clean`),
  the freeze date, and that edits were branding-only.
- **Scan scope for the zero-`deep-review` requirement (O-15): frontmatter `name:` fields and
  prompt BODY content only. Filenames and `PROVENANCE.md` are exempt** — the filenames are kept
  by design (previous bullet) and provenance must name the source set; a scan that includes them
  is unsatisfiable. The roadmap launch gate (`ROADMAP.md:239`) stays about CLI output, not repo
  internals.
- Because `review-refuter.md` content changes, `bun run refuter-probe` **MUST** pass before the
  set freezes (repo `CLAUDE.md`: the probe is THE first gate for any refuter prompt change), and
  one `bun run fixture-eval` **MUST** pass against the bundled set.
- `prompts/default/` **MUST NOT** contain any additional file matching `deep-review-*.md` or
  `review-*.md` — `agentsDirProblems` (`src/preflight.ts:1510-1533`) is bidirectional and a stray
  match is a hard `CliError`.
- `resolveAgentsDirSetting` **MUST** follow: `--agents` flag → `<repo>/.prhero/config.json`
  (`agents_dir`) → `~/.prhero/config.json` (`agents_dir`) → `PRHERO_AGENTS_DIR` → bundled default
  with `source: "default"`. It **MUST NOT** throw when all sources are unset, and no error text
  or runtime code may reference `/Users/juanma` or `deep-review`.
- **The bundled default MUST load via the asset manifest in every mode** (§2): embedded filenames
  are content-hashed, so the dir + fixed-filenames loader (`agentFilesIn`) and
  `preflightAgentsDir`'s glob cannot serve the compiled default. Custom `--agents`/config/env
  sets stay FS-based with the existing directory validation. Bundled-set validation — spec match
  against `localReviewSpec()`, the bidirectional check, and manifest ↔ `prompts/default/` parity
  — runs as **build-time tests in dev**, not at runtime.
- `SUGGESTED_AGENTS_DIR` **MUST** be removed from all four sites: `src/preflight.ts:47` and
  `:1269`, `src/cli.ts:148` and `:3605`, `scripts/martian-cal.ts:27,168` (the script pins its lab
  path locally). Because `scripts/` is outside `bun run typecheck` and `bun run check`, the
  migrated script **MUST** be verified with `./node_modules/.bin/biome check` and reconstructed
  project tsc flags (never `bunx`).
- `pr-hero init` **MUST** seed agents as `--agents` → `PRHERO_AGENTS_DIR` → omit the key entirely
  (the bundled default requires no configuration).

### 1.2 Scenarios

#### Scenario 1.1: Default resolution on a fresh machine
- **Given** no flag, no repo or global config, and no `PRHERO_AGENTS_DIR`
- **When** `resolveAgentsDirSetting` is invoked
- **Then** it returns the bundled default with `source: "default"` and does not throw, and the
  set loads through the manifest map.

#### Scenario 1.2: Explicit sources still win
- **Given** `--agents /tmp/custom-prompts` (or a config layer, or the env var)
- **When** resolution runs
- **Then** the explicit source wins with its existing `source` label — precedence unchanged — and
  loads from the filesystem with the existing directory validation.

#### Scenario 1.3: Bundled set passes spec validation at build time
- **Given** the bundled `prompts/default/` and the asset manifest
- **When** the dev-side build-time test runs
- **Then** all five files parse (frontmatter `name` present), the set matches
  `localReviewSpec()` bidirectionally, and the manifest's logical names are exactly the files
  present in `prompts/default/`.

#### Scenario 1.4: No lab branding remains where users read
- **Given** the five bundled prompt files
- **When** their frontmatter `name:` fields and body content are scanned for `deep-review`,
  `hunting-map`, `golden`, `/Users/` — with filenames and `PROVENANCE.md` exempt
- **Then** zero matches (O-15), while the filenames legitimately remain `deep-review-*.md` /
  `review-refuter.md` and `PROVENANCE.md` legitimately names `slice3b-lifecycle-v6-clean`.

---

## 2. Packaged-Asset Authority (`src/assets.ts` + `src/asset-manifest.ts`)

### 2.1 Requirements

- A single module `src/assets.ts` **MUST** resolve every packaged asset — the bundled agent
  files, `prompts/scout.md`, `prompts/summarizer.md`, `skills/pr-hero-triage/`, engine version —
  for three modes: `dev`, `npm`, `compiled`. No other module may compute packaged-asset paths.
- **Embedding MUST be manifest-based:** `src/asset-manifest.ts` imports every packaged asset with
  `import ... with { type: "file" }` and exports a logical-name → path map; it is the assets
  module's only data source for packaged files. **`compile.assets` / `--asset` MUST NOT be
  used** — verified empirically 2026-08-24 on Bun 1.3.14: `compile.assets` is a SILENT NO-OP
  (build `success: true`, binary ships without the assets, `ENOENT` under `/$bunfs/root/…`), and
  `--asset` does not exist in `bun build --help`. The manifest is the permanent, version-robust
  mechanism — the same code resolves real FS paths in dev/npm and embedded (content-hashed) paths
  when compiled — not a stopgap until `compile.assets` ships.
- No consumer may rely on embedded basenames (they are content-hashed); consumers address assets
  by logical name through the manifest map.
- Existing `import.meta.dir` asset reads (`src/cli.ts:265-290` scout/summarizer) **MUST** migrate
  to the assets module.
- **`selfInvocation()` MUST** be exported from `src/assets.ts` as the single answer to "how do I
  run myself again": dev/npm → `{ command: process.execPath (absolute bun), args: [absolute
  cli.ts] }` — the pair `src/watch.ts:547-548` already uses; compiled →
  `{ command: process.execPath (the binary itself), args: [] }`. Consumers: MCP registration
  (`agent-env.md §2`), the watch spawn, the gc spawn, launchd plist rendering. An absolute path
  to the npm SHIM is non-compliant — its `#!/usr/bin/env bun` shebang re-introduces the PATH
  lookup that kills launchd/GUI contexts.
- Version resolution **MUST** prefer a build-time baked value (compiled), then `package.json`
  (dev/npm), and provenance recording (`src/cli.ts:5179-5188`) **MUST** degrade gracefully when no
  git repository is present.

### 2.2 Scenarios

#### Scenario 2.1: Dev and npm modes resolve on the filesystem
- **Given** a checkout or npm-installed package
- **When** `resolveEngineAssets()` runs
- **Then** every manifest path exists on disk and `mode` is `"dev"`/`"npm"`.

#### Scenario 2.2: Compiled smoke proves embedded resolution (O-11)
- **Given** a release-built binary for the current platform
- **When** `pr-hero review --dry-run` runs on a fixture repo
- **Then** it exits 0, having resolved the bundled prompts, scout, and summarizer from the
  embedded manifest paths — with no `bun` and no repo checkout on the machine.

#### Scenario 2.3: Manifest ↔ directory parity is enforced in dev
- **Given** a file added to or removed from `prompts/default/` without updating the manifest
- **When** the build-time parity test runs
- **Then** it fails, naming the drifted entry — the manifest can never silently under- or
  over-ship.

---

## 3. npm Package Configuration

### 3.1 Requirements

- `package.json` **MUST** set `"private": false` and `"license": "Apache-2.0"`.
- `package.json` **MUST ADD** (both are absent today, not empty): a `"files"` whitelist —
  `"src"`, `"prompts"`, `"skills/pr-hero-triage"`, `"README.md"`, `"LICENSE"` — and an
  `"engines"` field **pinning the real minimum Bun version — the version CI builds with** (never
  the bare word "Bun"); the release workflow and `engines` **MUST** name the same version.
- The whitelist **MUST** exclude `skills/martian-bench`, `docs/`, `scripts/`, `fixtures/`,
  `test/`, `openspec/`, and `ROADMAP*` (D0 — the martian-bench skill contains machine paths and
  private benchmark data).
- The bin entry stays `"pr-hero": "./src/cli.ts"` behind `#!/usr/bin/env bun`; because the package
  has zero `dependencies` and Bun-only APIs, README and the npm page **MUST** state plainly that
  the npm channel requires Bun (the curl installer is the no-Bun path).
- The package **MUST NOT** declare local-path dependencies.
- The free `pr-hero` npm name (verified 404 on 2026-08-24) **SHOULD** be claimed with the first
  honest publish.

### 3.2 Scenarios

#### Scenario 3.1: Publish readiness
- **Given** `package.json` at repo root
- **When** evaluated for publish
- **Then** `private` is `false`, `license` is `"Apache-2.0"`, `files` includes `prompts` and
  `skills/pr-hero-triage`, and a dry-pack contains no `docs/`, `scripts/`, `fixtures/`, `test/`,
  `openspec/`, or `skills/martian-bench` entries.

#### Scenario 3.2: npm-pack smoke executes the published artifact (O-16)
- **Given** the packed tarball from `npm pack`
- **When** it is installed into an isolated temp prefix and `pr-hero --help` plus a fixture
  `review --dry-run` run **outside the checkout**
- **Then** both succeed — distribution is validated by executing the published artifact, not by
  inspecting configuration files.

---

## 4. Standalone Installer & Release Workflow

### 4.1 Requirements

- `.github/workflows/release.yml` **MUST** build, on tag push, the four targets
  `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` via `bun build --compile` with the
  version baked from the tag, `--no-compile-autoload-dotenv` **AND**
  `--no-compile-autoload-bunfig` (both verified present and defaulting to true — an installed CLI
  must not read a stranger's cwd `.env` or `bunfig.toml`), and the **Bun build version pinned**
  (matching `engines`).
- **Release invariant:** the npm package and the binaries **MUST** be built and published from
  the SAME commit and the SAME version in one workflow, versions matching the tag; npm publish
  runs with `--provenance` from GitHub Actions.
- **Platform matrix decisions (recorded):** glibc via ubuntu-LTS runners for v1 — musl support is
  deferred and documented; x64 ships the non-`-baseline` variant — the `-baseline` (pre-AVX2)
  decision is deferred and documented. macOS binaries carry Bun's ad-hoc signature; notarization
  is deferred and documented (the curl channel does not quarantine; browser downloads would).
- The workflow **MUST** publish a `SHA256SUMS` file beside the binaries and run the release-gate
  smokes before assets go live: **O-11** (each published binary executes `--help` +
  `review --dry-run` on a fixture repo + bundled asset resolution, on its platform's runner) and
  **O-16** (the npm-pack smoke, §3.2).
- `install.sh` **MUST**: detect OS (`darwin`/`linux`) and arch (`arm64`/`x64`), failing loudly
  with exit 1 on anything else; download the matching `pr-hero-<os>-<arch>` release asset;
  **verify its SHA256 against `SHA256SUMS`** and abort on mismatch; install to
  `~/.prhero/bin/pr-hero` with `chmod +x`; append an idempotent PATH block to `~/.zshrc`,
  `~/.bashrc`, or fish config only when `~/.prhero/bin` is not already on `$PATH`; and support
  non-interactive `curl -fsSL … | bash`.
- Re-running `install.sh` **MUST** overwrite the binary cleanly without duplicating PATH lines.

### 4.2 Scenarios

#### Scenario 4.1: macOS Apple Silicon install
- **Given** a darwin/arm64 machine
- **When** `install.sh` runs
- **Then** `pr-hero-darwin-arm64` is downloaded, checksum-verified, installed executable at
  `~/.prhero/bin/pr-hero`, and shell-reload instructions are printed.

#### Scenario 4.2: Checksum mismatch aborts
- **Given** a downloaded binary whose SHA256 does not match `SHA256SUMS`
- **When** verification runs
- **Then** the installer deletes the download, prints the mismatch, and exits non-zero without
  touching `~/.prhero/bin` or shell config.

#### Scenario 4.3: Same-commit, same-version release
- **Given** a tag-triggered release run
- **When** the npm package and the four binaries are published
- **Then** all artifacts carry the tag's version, were built from the tag's commit in the same
  workflow run, and the npm publish carries provenance.

---

## 5. Calibrated Model Defaults (reframed — no fake lock)

### 5.1 Requirements

- The bundled agent frontmatter **MUST** carry the calibrated defaults (`model: sonnet` on the
  four hunters and the refuter); the summarizer default stays `haiku`
  (`DEFAULT_SUMMARY_MODEL`, `src/preflight.ts:43`).
- The onboarding wizard and scaffolding **MUST NOT** offer model selection.
- The `--model` escape hatch keeps its existing precedence (`src/pipeline.ts:1789-1791`:
  CLI > `AgentSpec.model` > frontmatter) and **MUST** be documented as uncalibrated; when set, the
  plan card **MUST** print a warning line naming it an uncalibrated override — implemented and
  tested in S4 (rev 3 promised the warning without a task).
- No mechanism may claim to "lock" models: the design states the defaults and the hatch honestly.

### 5.2 Scenarios

#### Scenario 5.1: Defaults from a fresh init
- **Given** a fresh `pr-hero init` and no `--model`
- **When** a review plan is built
- **Then** hunters/refuter resolve to `sonnet` from bundled frontmatter and the plan shows
  calibrated tiers.

#### Scenario 5.2: Escape hatch warns
- **Given** `--model haiku`
- **When** the plan card renders
- **Then** it includes the uncalibrated-override warning line, and the run proceeds (no hard
  lock).
