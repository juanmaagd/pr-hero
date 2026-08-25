# Specification: Pillar 3 — GitHub Actions CI & Headless CI Integration

## 1. GitHub Action Composite Definition (`action.yml`)

### 1.1 Requirements
- The repository **MUST** provide an official `action.yml` at its root conforming to GitHub Actions Composite Action format.
- The action **MUST** support the following inputs:
  - `github-token`: GitHub personal access token or installation token (default: `${{ github.token }}`).
  - `anthropic-api-key`: API key for Anthropic models (optional if `claude-token` or `CLAUDE_CODE_OAUTH_TOKEN` is supplied).
  - `claude-token`: Claude Code OAuth token for authentication (optional if API key is supplied).
  - `pr-number`: Target pull request number. If omitted, it **MUST** automatically resolve from `${{ github.event.pull_request.number }}` or `${{ github.event.issue.number }}`.
  - `model`: Optional model override (e.g. `claude-3-5-sonnet-20241022`, `claude-3-7-sonnet-20250219`).
  - `scout`: Boolean flag (default `false`) controlling exploratory lead-scout stage.
  - `max-changed-lines`: Integer diff line ceiling (default from config, fallback `1000`).
  - `max-changed-files`: Integer changed files ceiling (default from config, fallback `50`).
  - `budget-usd`: Float estimated cost ceiling in USD per review (default `10.00`).
  - `post`: Boolean flag (default `true`) determining whether inline comments and review state are posted to GitHub.
  - `step-summary`: Boolean flag (default `true`) controlling generation of `$GITHUB_STEP_SUMMARY`.
- The action **MUST** set the following outputs:
  - `status`: One of `reviewed`, `skipped-size`, `skipped-budget`, `skipped-clean`, `error`.
  - `findings-count`: Total number of verified findings (integer).
  - `blocking-count`: Total number of blocking tier findings (integer).
  - `advisory-count`: Total number of advisory tier findings (integer).
  - `cost-usd-est`: Estimated cost of the review in USD (float string, e.g. `"2.45"`).
  - `run-dir`: Relative or absolute path to the generated review run directory containing `findings.json` and `report.md`.
- The action **MUST** support running on `ubuntu-latest` and `macos-latest` runners.
- The action **MUST** automatically configure required environment variables (`GITHUB_ACTIONS=true`, `CI=true`, `NO_COLOR=1` or ANSI styling).

### 1.2 Scenarios
- **GIVEN** a workflow triggering on `pull_request`, **WHEN** `uses: juanmaagd/pr-hero@v1` executes, **THEN** it resolves the PR number automatically and runs the review in CI headless mode.
- **GIVEN** a PR exceeding `max-changed-lines`, **WHEN** the action runs, **THEN** it outputs `status=skipped-size`, leaves a skip summary on GitHub, and finishes with exit code 0.

## 2. CI Headless Mode & Step Summary Reporter

### 2.1 Requirements
- When `GITHUB_ACTIONS=true` or `--ci` is provided:
  - The CLI **MUST** run headlessly without prompting for interactive input or TTY keyboard confirmations (equivalent to `--yes`).
  - Progress updates **MUST** use GitHub Actions log workflow groups (`::group::` / `::endgroup::`) to structure runner logs cleanly.
  - Informative events (such as skip decisions or completed reviews) **MUST** emit `::notice::` workflow annotations.
  - Non-fatal warnings **MUST** emit `::warning::` workflow annotations.
  - The CLI **MUST NOT** exit with a non-zero code merely because findings (even `blocking` ones) were discovered. Findings are published via PR comments and step summaries; the exit code remains `0` (assistant posture).
  - The CLI **MUST** exit non-zero (`1` or `2`) ONLY on fatal execution failures (e.g. missing credentials, missing git binary, malformed arguments).
- When `step-summary` is enabled and `$GITHUB_STEP_SUMMARY` is present:
  - The CLI **MUST** append a formatted Markdown summary to the file referenced by `$GITHUB_STEP_SUMMARY`.
  - The summary **MUST** include:
    - Overall review status header (e.g. `### 🔍 pr-hero Review — PR #123`).
    - Metric chips: Findings count (Blocking vs Advisory), Estimated Cost, Duration, Model.
    - Findings list grouped by file and severity tier with markdown links to code.
    - Re-review / delta breakdown when previous review findings exist (Item 7 compatibility).
    - Footer attributing pr-hero as an AI code review assistant.

### 2.2 Scenarios
- **GIVEN** `GITHUB_ACTIONS=true` and `$GITHUB_STEP_SUMMARY` pointing to a writable file, **WHEN** `pr-hero review --pr 42 --post --yes` completes with 2 blocking findings, **THEN** it appends the Markdown review table to the summary file and exits with code 0.
- **GIVEN** invalid authentication credentials in CI, **WHEN** `pr-hero review --pr 42` runs, **THEN** it emits `::error::Authentication failed` and exits with code 1.

## 3. Unattended Spend & Gate Protection

### 3.1 Requirements
- The CI execution flow **MUST** compute diff statistics and cost estimates before launching agent subprocesses.
- If changed lines exceed `max_changed_lines` or changed files exceed `max_changed_files`:
  - Review **MUST** halt immediately before any Claude/LLM calls.
  - If `post` is enabled, a single PR comment **MUST** be posted: `<!-- pr-hero:skip-size --> ⚠️ PR diff is too large for automated review...`.
  - The step summary **MUST** record the size skip reason.
  - The process **MUST** exit with code 0.
- If estimated cost exceeds `--budget-usd`:
  - Review **MUST** halt before agent spawning.
  - If `post` is enabled, a single PR comment **MUST** note the budget limit skip.
  - The step summary **MUST** record the budget skip reason.
  - The process **MUST** exit with code 0.

### 3.2 Scenarios
- **GIVEN** `--budget-usd 5.00` and an estimated cost of `$7.50`, **WHEN** the CI review preflights, **THEN** agents are not spawned, a skip notice is generated, and the job succeeds with exit code 0.

## 4. CI Workflow Scaffolding & Setup

### 4.1 Requirements
- `pr-hero setup --ci` (and `pr-hero ci init`) **MUST** generate a standard `.github/workflows/pr-hero.yml` in the current repository.
- If `.github/workflows/pr-hero.yml` already exists:
  - Without `--force`, it **MUST** refuse to overwrite and inform the user.
  - With `--force`, it **MUST** overwrite with the canonical workflow template.
- The template **MUST** configure:
  - Permissions: `contents: read`, `pull-requests: write`, `issues: write`.
  - Triggers: `pull_request: [opened, synchronize, reopened]`.
  - Step checkout with `fetch-depth: 0` (required for accurate diffs and git blame/ancestry).
  - Invocation of `uses: juanmaagd/pr-hero@v1` with standard secrets.
- `pr-hero doctor` **MUST** report CI readiness:
  - When run inside GitHub Actions, checks presence of `GITHUB_TOKEN` and Anthropic/Claude tokens.
  - In local environments, checks whether `.github/workflows/pr-hero.yml` is present and committed.

### 4.2 Scenarios
- **GIVEN** a configured repo without CI, **WHEN** user runs `pr-hero setup --ci`, **THEN** `.github/workflows/pr-hero.yml` is created with valid YAML syntax and permissions.
