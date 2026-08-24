# Change Proposal: Pillar 3 — GitHub Actions CI & Headless CI Integration

**Target:** Distribution Pillar 3 (ROADMAP.md THE LAUNCH LINE)  
**Authors:** Senior Architect & Juanma  
**Date:** 2026-08-24  

## Why

With Pillar 1 (npm distribution, onboarding wizard, doctor, environment detection) and Pillar 2 (interactive TUI, active runs monitor, config editor, lifecycle) complete, `pr-hero` requires its automated cloud trigger: **GitHub Actions CI**.

Today, `pr-hero` operates either manually via CLI (`pr-hero review --pr <n>`) or locally via the macOS watcher (`pr-hero watch`). To complete distribution before launch:
1. **Automated PR Reviews in CI:** Teams must be able to run `pr-hero` on every pull request push or opening via a clean, official GitHub Action (`action.yml`).
2. **Assistant Posture (Non-Blocking):** Consistent with our core philosophy, `pr-hero` serves as an intelligent reviewer/assistant, **not** an inflexible merge gate. It posts comments and writes step summaries, but exits with code 0 on detected findings so normal CI workflows are not artificially blocked.
3. **Bounded Unattended Spend:** CI runs are unattended. The engine must enforce strict spend boundaries before launching agents: the deterministic diff size gate (`max_changed_lines`, `max_changed_files`) and per-run budget caps (`--budget-usd`), failing soft and gracefully with informative PR notices rather than burning tokens blindly.
4. **First-Class CI Telemetry & Formatting:** In GitHub Actions environments (`GITHUB_ACTIONS=true`), the CLI must produce native workflow grouping (`::group::`), workflow notices/warnings, and rich job summaries (`$GITHUB_STEP_SUMMARY`).
5. **Zero-Friction Setup:** A workflow template (`.github/workflows/pr-hero.yml`) and CLI helper (`pr-hero setup --ci` / `pr-hero ci init`) to scaffold the GitHub Action with clear secret guidance (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` and `GITHUB_TOKEN`).

## What Changes

1. **Official Composite Action (`action.yml`):**
   - Packaged at repository root for `@v1` consumption (`uses: juanmaagd/pr-hero@v1`).
   - Configurable inputs: `github-token`, `anthropic-api-key`, `claude-token`, `pr-number`, `model`, `scout`, `max-changed-lines`, `max-changed-files`, `budget-usd`, `post`, `step-summary`.
   - Structured outputs: `status`, `findings-count`, `blocking-count`, `advisory-count`, `cost-usd-est`, `run-dir`.
   - Automatic environment setup: installs/locates Bun or binary, provisions dependencies, and sets up authentication.

2. **CI Headless Mode & Reporter (`src/ci.ts` & `src/ci-reporter.ts`):**
   - Auto-detection of `GITHUB_ACTIONS=true` or explicit `--ci` flag.
   - Non-interactive TTY bypass with structured GitHub Actions log annotations (`::group::`, `::notice::`, `::warning::`, `::error::`).
   - Automated `$GITHUB_STEP_SUMMARY` markdown generation including run status, findings breakdown, proof references, and cost estimate.
   - Exit code contract:
     - `0`: Success (review complete, clean PR, or gracefully skipped due to size/budget gates).
     - `1` / `2`: Fatal configuration or runtime failures (auth missing, invalid parameters).

3. **CI Spend & Gate Protection:**
   - Evaluates size gate and `--budget-usd` before agent fanout.
   - On size/budget threshold exceedance, posts a courteous PR comment / step summary explaining the skip, and exits 0.

4. **CI Setup & Scaffolding:**
   - `pr-hero setup --ci` generates a standard `.github/workflows/pr-hero.yml` workflow file.
   - Verification in `pr-hero doctor` for CI environment variables and secrets.

5. **Documentation:**
   - Comprehensive guide in `docs/github-actions.md` detailing token permissions (`pull-requests: write`, `contents: read`), Claude authentication, and workflow triggers (`pull_request: [opened, synchronize]`).

## Invariants & Rules

- **Assistant Posture:** CI reviews comment on the PR and publish summaries; they do NOT fail the job on findings.
- **Strict Budget Ceilings:** Unattended runs must never exceed configured size or budget limits.
- **Fail-Safe Persistence:** Even in ephemeral CI runners, outputs (`findings.json`, `report.md`, `comparison.json`) are preserved in artifacts and summary.
- **Deterministic Pure Logic:** All CI reporting, summary formatting, and gate decisions remain pure functions tested offline with zero external network dependencies.
