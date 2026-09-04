# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-09-04

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

## [1.0.0] - 2026-08-25

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
- **Official Composite Action (`action.yml`)**: Reusable GitHub Action referenced via `@v1` for automated pull request code reviews on `ubuntu-latest` and `macos-latest`.
- **CI Step Summary & Outputs**: Markdown summary output formatted for `$GITHUB_STEP_SUMMARY` and machine-readable Action step outputs (`status`, `findings-count`, `blocking-count`, `advisory-count`, `cost-usd-est`, `run-dir`).
- **Spend & Size Safety Gates**: Automated budget guards (`max-changed-lines`, `max-changed-files`, `budget-usd`) skipping oversized or cost-prohibitive PRs cleanly with explicit skip status annotations.
- **CI Automated Scaffolding**: `pr-hero setup --ci` and `pr-hero ci init` commands generating byte-accurate `.github/workflows/pr-hero.yml` configurations, complemented by the `pr-hero-ci-setup` agent skill.

[Unreleased]: https://github.com/juanmaagd/pr-hero/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/juanmaagd/pr-hero/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/juanmaagd/pr-hero/releases/tag/v1.0.0
