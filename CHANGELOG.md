# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-26

### Added
- **OpenCode as an alternative execution runtime**: hunters, the refuter, and the scout can now run
  through the OpenCode SDK instead of only the Claude Code CLI — a route-keyed, provider-neutral
  runtime composition with exact-binding readiness checks feeding `doctor`/`init` and the review plan
  card, and a `provider_api_token` credential broker generic over every OpenCode provider (adding a new
  one is an `auth.json` entry, a route, and a pricing file — no code). Opt-in; Claude-only behavior is
  unchanged (#106, #107, #108, #112, #114, #115, #168).
- **OpenCode in GitHub Actions**: operators can select OpenCode in CI via a `PRHERO_ROUTING` variable
  and an `OPENCODE_AUTH_JSON` secret, with API-token CI correctly detected as metered rather than an
  unlimited subscription, documented end-to-end in `docs/github-actions.md` (#209, #210, #211).
- **Manual re-run from GitHub Actions**: a new `pr-hero-force.yml` `workflow_dispatch` workflow lets an
  operator dispatch `gh workflow run pr-hero-force.yml -f pr=<n>` to run a skipped review on Actions with
  `--force`, bypassing the size gate, CI admission, and the budget ceiling for that one run (#269).
- **Skip re-review when nothing justifies another run**: CI now skips re-reviewing a PR when the prior
  findings don't warrant another pass, instead of always re-running discovery (#109).
- **`.prheroignore`**: a repo-root file declaring which paths pr-hero excludes from a review. Excluded
  paths fall out of the reviewed diff and hunters/scout input, and stop counting toward the cost band,
  the size-gate threshold, and the watcher's pre-launch check, both locally and in CI (#202, #204, #205).
- **New `logic` hunter (category 15)**: a CWE-derived, language-agnostic local-logic-error sweep,
  promoted from a benchmark-only modifier into the bundled default prompt set (#261, #265).
- **Findings schema v1.1**: hunters may now report an open specialty slug instead of only the four
  built-in hunter names, and severity category `1-15` instead of `1-14`; a v1.0 reader/validator is kept
  for backward compatibility (#110).
- **Operator configuration guide**: `docs/configuration.md` documents the two-layer person/team
  configuration, routing, and credentials end-to-end, linked from the README (#283).

### Changed
- **Provider-reported cost replaces bundled pricing tables**: a metered route is now admitted on the
  provider transport's own reported cost instead of a rate table pr-hero has to keep updated. Per-provider
  pricing catalogues (including a real z.ai rate table) shipped first to unblock non-Anthropic providers,
  then were removed once transport-reported cost proved sufficient for all routes (#162, #167, #170,
  #172, #198).
- **No more hardcoded Claude model alias**: the CLI resolves `sonnet`/other Anthropic aliases itself and
  pr-hero records what actually ran, instead of pinning and asserting a version internally — an alias
  repoint from Anthropic no longer needs a pr-hero release (#176).
- **Raised the size gate's default line limit**: the engine default (`DEFAULT_SIZE_GATE.maxChangedLines`)
  and the GitHub Action's `max-changed-lines` input both move from `1500`/`1000` to `4000` — an owner
  decision, not a new measurement, because the old defaults were skipping too many real PRs outright.
  The files ceiling (150 engine / 50 action) is unchanged.
- **Renumbered releases to 0.x**: `1.0.0` is now `0.1.0` and `1.1.0` is now `0.1.1` — the public API
  (CLI surface, config schema, GitHub Actions contract) is not yet stable, and the `1.x` numbering
  overstated that. The floating Action tag moves from `@v1` to `@v0`. The `v1` tag itself stays
  **frozen** at the last 1.x release so existing `uses: juanmaagd/pr-hero@v1` workflows keep resolving
  exactly what they always have — they simply receive no further updates. New and existing repos should
  migrate to `@v0`.
- **Release guard**: `.github/workflows/release.yml` now fails fast, before building anything, when the
  pushed tag's version does not match `package.json`'s `version` — see `docs/release-runbook.md`.

### Fixed
- **OpenCode works from the standalone binary**: the compiled binary installed by `install.sh` could
  not use the OpenCode backend at all — admission reported the SDK as "not installed" even when it
  was. pr-hero now loads the SDK's client entry, which has no external dependencies, instead of the
  full index; a load failure now names its real cause; and the compiled-binary smoke that gates CI and
  every release asset exercises this load path (#289).
- **OpenCode free models work again**: OpenCode's free-tier gateway began refusing any turn whose tool
  list lacks `bash` or `read` (`403 … free tier can only be used from within OpenCode`), and pr-hero
  always denies `bash`. On free routes only, those tools now stay visible with OpenCode permission
  `ask`, and pr-hero rejects every permission request automatically, so a step still never executes a
  command; every other route keeps denying them outright. The server attests the posture it launched
  with, and pr-hero refuses to lift the deny when that attestation is missing (#290).
- **OpenCode SDK transport stabilization**: a long tail of correctness fixes surfaced while
  operationalizing the OpenCode runtime — tool-surface enumeration instead of trusting the provider's
  default, text-part harvesting instead of reasoning text, turn boundaries ending at the actual end of
  turn, MCP registry wiring so hunters reach codegraph, credential-projection ordering, a typed session
  wire format with canonical snapshots and fail-closed identity reconciliation, terminal-state
  arbitration and usage-identity dedup, stream-delta dedup by event id, provider SSE refusals filed as
  `runtime_unavailable` instead of a burned format retry, a hunter that never made a tool call now fails
  instead of posting a clean bill, an absent SDK degrading `doctor` instead of crashing it, and resolving
  the SDK correctly from standalone compiled binaries (#117, #123, #125, #129, #130, #140, #143, #144,
  #145, #151, #208, #215, #216, #217, #218, #219, #220, #221, #222, #223, #225, #226, #227, #228, #263,
  #270, #273, #281).
- **Billing and credential correctness**: a `claude-code` route on an API key is now billed as metered
  instead of silently admitted as subscription (#278); the harness no longer performs a per-step
  credential projection the OpenCode transport never reads, which could throw and print a false
  "operator environment" warning (#282); an attempt whose credential projection degrades onto a raw key
  now has its spend fenced instead of going unreserved (#284).
- **`.prheroignore` scoping**: pr-hero's own default exclusions are now scoped to prose files only, so
  executable code inside `docs/research/**` is no longer accidentally excluded from review (#262).
- **In-flight lock released on cancellation**: a cancelled review run no longer leaves the PR's in-flight
  lock held, which had blocked the very next push's review from starting (#163).
- **Re-review checks proof against the reviewed tree**: `proof_refs` are now verified against the tree
  that was actually reviewed (#165).
- **Deduplication no longer discards on similarity alone**: a later claim looking similar to an earlier
  one is no longer treated as permission to drop the earlier finding (#155).
- **CI budget ceiling defaults to unlimited on a subscription route**: a subscription route no longer
  gets silently capped by a budget ceiling meant for metered spend (#160).
- **Subscription cost marked as notional**: a subscription run's reported cost is now clearly labeled as
  a notional list-price figure, not actual cash spend (#177).
- **Install → ready path**: fixed four defects (three found by inspection, one more while fixing them)
  blocking the documented install-then-review path, so a fresh `install.sh` run actually reaches a
  working `pr-hero` (#179).
- **Empty separator row removed**: the report no longer prints an empty separator row for a claim-less
  live finding (#181).
- **Partial review forces full coverage next time**: a review where some hunters or the refuter failed
  (but not all) no longer causes the next review on the same head to skip discovery entirely (#224).
- **Pipeline records why a step failed before its first attempt**: a step that died before spawning now
  carries a redacted failure reason in `pipeline.json` instead of silently discarding it (#271).
- **Re-review recovers carried finding state**: severity, tier, and claim text now carry forward
  correctly on a second review instead of resetting to generic placeholder values (#285).
- **Re-review reports skipped discovery honestly**: a re-review that skips discovery now says explicitly
  that no hunter ran, instead of falsely reporting a clean bill (#286).

## [0.1.1] - 2026-09-04

_Originally published as tag `v1.1.0`; renumbered to `0.1.1` afterward (see "Renumbered releases to 0.x"
above). `0.1.0` below was originally published as `v1.0.0`._

### Added

#### Multi-Runtime Execution Harness (D1)
- **Decoupled StepExecutionHarness**: Extracted provider-agnostic harness (`src/execution/harness.ts`) managing process-group lifecycle (`PGID`), signal escalation (`TERM → KILL → reap`), and terminal proofs.
- **Concurrency & Spend Limiter**: Integrated `concurrency-limiter` and `spend-limiter` with transactional spend reservation ledgers, protecting operators from runaway API spend.
- **Cross-Provider Usage Normalization**: Standardized token usage and cost accounting across models and transports (`src/execution/usage-normalized.ts`).
- **OpenCode SDK Transport Foundations**: Initial client adapter, server launcher, and event-stream mapping for OpenCode runtime support.

#### Security & Isolation Architecture
- **WorkspaceReadBroker**: Canonical path resolution and boundary verification, preventing symlink traversal and reads outside the workspace.
- **CredentialBroker**: Ephemeral credential projection isolating sensitive tokens from agent child processes.
- **Diagnostic Redaction**: Automated scrubbing of sensitive environment variables and credentials from diagnostic error tails.
- **Security Policy**: Added `SECURITY.md` establishing coordinated vulnerability disclosure through GitHub Private Vulnerability Reporting.

#### Distribution, CI & Packaging (Pillar 3)
- **CI Run Directory Upload**: Automatic upload of run artifacts (`findings.json`, `diff.patch`, `report.md`) from GitHub Actions runs, enabling local triage via `pr-hero triage reply`.
- **Automated Floating Major Tag**: Release pipeline now automatically updates the floating `v1` tag upon publishing stable semantic releases.
- **Compiled Binary Smoke Verification**: Added `scripts/compiled-smoke.ts` exercising 18 integrity checks on standalone compiled binaries prior to release artifact distribution.

### Fixed
- **BunFS Asset Resolution**: Corrected asset path resolution inside compiled Bun executables so bundled prompts and skills resolve reliably without filesystem dependencies.
- **Install Script Shell PATH Guidance**: Updated `install.sh` to explicitly instruct operators on exporting `$HOME/.prhero/bin` in the current shell session, preventing `command not found` on fresh installs.
- **Floating Tag Prerelease Exclusion**: Restricted floating major tag updates to stable semantic releases (`^v[0-9]+\.[0-9]+\.[0-9]+$`), preventing `-beta` or `-rc` builds from moving production tags.

## [0.1.0] - 2026-08-25

### Added

#### Core Review Engine & Pipeline
- **Parallel Multi-Agent Hunter Architecture**: Orchestrated fanout of specialized review hunters (`reliability`, `resilience`, `parity`, and `lifecycle`) executing in parallel across repository checkouts and pull request diffs.
- **Specialized Hunter Classes**:
  - `lifecycle`: Specialized state-machine and lifecycle-contract hunter focusing on latches, effects, unmount/cleanup paths, re-entrancy, and resource leaks.
  - `reliability`: Hunter targeting crash bugs, unhandled null/undefined values, type-boundary violations, and exception escapes.
  - `resilience`: Hunter evaluating edge-case degradation, timeout handling, retries, and network/subsystem fault tolerance.
  - `parity`: Hunter ensuring consistency and contract parity across mirrored implementations and platform bridges (triggered via `parity_trigger_paths`).
- **Mechanical Deduplication Stage**: Deterministic deduplication engine (`src/dedupe.ts`) that merges hunter draft findings, normalizes line/symbol ranges, reconciles overlapping candidate claims, and generates unified finding candidates.
- **Adversarial Refuter v2**: High-precision refutation engine (`src/refuter.ts`) evaluating high-severity candidate findings with mandatory own-expansion, visiting referenced proof sites, and actively hunting counterexamples.
- **4-Outcome Refuter Vocabulary**: Refuter verdicts standardizing on a strict 4-outcome vocabulary:
  - `corroborated`: Defect positively verified and supported by adversarial analysis.
  - `refuted`: Finding disproven with explicit, cited code contradiction (dropped from final output).
  - `inconclusive`: Counterexample search yielded no definitive contradiction; finding preserved and assigned to advisory tier.
  - `downgraded-latent`: Real defect mechanism identified but verified to be dormant or unreachable in the current code path; preserved and assigned to advisory tier (never deleted).
  - *(Plus `not_submitted` for findings below the refutation severity threshold).*
- **Deterministic Tiering**: Clean separation of blocking vs. advisory tiers computed strictly in deterministic code (`src/findings.ts`) based on severity, evidence class, and refuter verdicts—never delegated to model discretion.
- **Assistant Posture**: Core design philosophy operating as an intelligent code-review assistant rather than an obstructing merge gate; every report includes an explicit non-blocking disclaimer and CI runs exit 0 on discovered findings.
- **Incremental Re-Review (Item 7)**: Smart verification of prior findings across subsequent pushes (`src/rereview.ts`), validating fixed claims without re-running redundant whole-repo sweeps, avoiding archaeology, and explicitly reporting `unconfirmed` when verification is inconclusive rather than falsely assuming resolution from absence.
- **Reconnaissance Scout Stage (`--scout`)**: Opt-in pre-hunt scout phase (`src/scout.ts`) performing lightweight diff analysis to identify suspicious hotspots and route hunter attention efficiently.

#### Storage & Observability
- **Canonical Product Store (`prhero.db`)**: SQLite-backed canonical database (`~/.prhero/prhero.db`) serving as the durable source of truth for all review runs, structured findings, proof references, hop trails, and debug telemetry.
- **Query Server Daemon**: Local query daemon (`src/server.ts`, `pr-hero server`) providing IPC interfaces and query endpoints for inspecting review history, findings, and telemetry.
- **Historical Migration & Backfill**: Automated migration framework (`src/store.ts`) backfilling legacy run directories and comparison ledgers into the canonical database schema with zero data loss.

#### Configuration System (C5)
- **Two-Layer Person vs. Team Configuration**: Clear hierarchy between operator machine defaults (`~/.prhero/config.json`) and repo-committed team configuration (`<repo>/.prhero/config.json`).
- **Capped Operator Spend Protections**: Non-bypassable protection invariant where team-level configuration can only narrow or lower spend-sensitive knobs (`max_verification_steps`, `max_changed_lines`, `max_changed_files`, disabling `summary.enabled`, `scout`, `post`), preventing repository configs from enlarging the operator's bill.
- **Interactive Configuration Manager**:
  - `pr-hero config`: Read-only inspection displaying every effective key, resolved value, source layer (`repo`, `global`, `capped`, `default`), and file paths.
  - `pr-hero config set` / `unset`: CLI mutations supporting `--person`, `--team`, and `--watch` layer targets.
  - `pr-hero config --edit`: Full-featured interactive terminal editor with buffered drafts, layer switching, Save/Discard actions, and capped ceiling annotations.

#### Distribution & Onboarding (Pillar 1)
- **Cross-Platform Standalone Binaries**: Self-contained compiled executables with zero external runtime dependencies targeting `darwin-arm64`, `darwin-x64`, `linux-x64`, and `linux-arm64`.
- **NPM Global Package**: Published `pr-hero` package on npm for Bun and Node environments.
- **Universal Install Script (`install.sh`)**: One-line curl installer featuring automated platform detection, SHA256 checksum verification, and idempotent shell PATH configuration.
- **Interactive Setup Wizards (`pr-hero init` & `pr-hero setup`)**: Guided onboarding initializing `.prhero/config.json`, scaffolding `gotchas.md`, registering MCP servers, and synchronizing agent skills.
- **Bundled Asset Architecture**: In-binary asset bundling for agent prompts (`prompts/*.md`) and skills via static import manifests, eliminating external path dependencies.
- **System Doctor (`pr-hero doctor`)**: Comprehensive preflight diagnostics verifying Git status, Claude authentication / OAuth tokens, GitHub CLI (`gh`), codegraph availability, and configuration validity across both terminal and CI environments.

#### Terminal User Interface (Pillar 2)
- **Zero-Argument TUI Dashboard**: Interactive root dashboard menu launched by `pr-hero` in interactive TTY sessions with context-aware navigation, doctor status badges, and quick-action shortcuts.
- **Review Confirmation Plan**: Upfront execution plan displaying target branch/PR, diff statistics, participating hunters, refuter settings, and estimated USD cost bands prior to review execution (bypassed with `--yes`).
- **Activity & Run Monitor (`pr-hero activity`)**: Live dashboard showing in-flight review processes, elapsed execution time, PID management, safe process termination (`--kill <pid>`), daily watcher spend tracking, and recent run history.

#### GitHub Actions CI Integration (Pillar 3)
- **Official Composite Action (`action.yml`)**: Reusable GitHub Action referenced via `@v0` for automated pull request code reviews on `ubuntu-latest` and `macos-latest`.
- **CI Step Summary & Outputs**: Markdown summary output formatted for `$GITHUB_STEP_SUMMARY` and machine-readable Action step outputs (`status`, `findings-count`, `blocking-count`, `advisory-count`, `cost-usd-est`, `run-dir`).
- **Spend & Size Safety Gates**: Automated budget guards (`max-changed-lines`, `max-changed-files`, `budget-usd`) skipping oversized or cost-prohibitive PRs cleanly with explicit skip status annotations.
- **CI Automated Scaffolding**: `pr-hero setup --ci` and `pr-hero ci init` commands generating byte-accurate `.github/workflows/pr-hero.yml` configurations, complemented by the `pr-hero-ci-setup` agent skill.

[Unreleased]: https://github.com/juanmaagd/pr-hero/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/juanmaagd/pr-hero/compare/v1.1.0...v0.2.0
[0.1.1]: https://github.com/juanmaagd/pr-hero/releases/tag/v1.1.0
[0.1.0]: https://github.com/juanmaagd/pr-hero/releases/tag/v1.0.0
