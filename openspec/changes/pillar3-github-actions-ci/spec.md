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
  - `status`: One of `reviewed`, `skipped-size`, `skipped-budget`, `error`. Every member of this enum **MUST** have a real emitter — see the Phase 5 amendment below.
  - `findings-count`: Total number of verified findings (integer).
  - `blocking-count`: Total number of blocking tier findings (integer).
  - `advisory-count`: Total number of advisory tier findings (integer).
  - `cost-usd-est`: Estimated cost of the review in USD (float string, e.g. `"2.45"`).
  - `run-dir`: Relative or absolute path to the generated review run directory containing `findings.json` and `report.md`.
- The action **MUST** support running on `ubuntu-latest` and `macos-latest` runners.
- The action **MUST** automatically configure required environment variables (`GITHUB_ACTIONS=true`, `CI=true`, `NO_COLOR=1` or ANSI styling).

> **Phase 5 amendment (status enum correction):** Phase 3 flagged that the original five-member enum
> (`reviewed`, `skipped-size`, `skipped-budget`, `skipped-clean`, `error`) had two members nothing ever
> emitted. Phase 5 resolved both, dropping the enum to four real members:
> - **`skipped-clean` dropped, not wired.** It duplicated an already-correct signal: a clean review
>   (zero findings) already emits `status=reviewed`, `findings_count=0` — Phase 3's own words. A second
>   status value meaning the identical thing would only invite two different `if:` branches in consumer
>   workflows to drift out of sync with each other. `reviewed` + `findings_count == 0` is the one true
>   "nothing to see here" signal.
> - **`error` wired.** `reportFatalCiError` (`src/cli.ts`) is `runCli()`'s last-resort catch: any error
>   that escapes `main()` uncaught, when `$GITHUB_OUTPUT` is present (GitHub sets it unconditionally for
>   every real job step — a stronger, simpler CI signal here than re-deriving `isCiEnvironment()`),
>   writes `status=error` with zeroed counters and emits a `::error::` workflow annotation before the
>   process exits 1. Outside a real job step (`$GITHUB_OUTPUT` absent — e.g. local development), the
>   error is rethrown unchanged so a local crash still prints its full stack trace.
>
> **Known limitation, not silently handled:** the pre-existing in-flight-review skip
> (`isInFlightCommitStatus(...) && options.yes` in `src/cli.ts`, predating this pillar) still returns 0
> **without** writing any `$GITHUB_OUTPUT` at all — the one path in the whole CI surface that leaves
> `status` empty rather than one of the four enum values above. Wiring a fifth `skipped-in-flight` member
> would need real production code (a new `CiSummaryData` variant, a new PR-comment marker, a new
> `ciGateSkipOutputs` status, and caller-level test harness at `reviewPr`'s in-flight branch — none of
> which currently exists) under strict TDD, which this documentation-and-verification phase's budget does
> not cover. `docs/github-actions.md` documents this exact gap for operators (an empty `status` means
> "a concurrent review already owned this head", not a failure). Tracked as an open follow-up, not a
> silent gap.

### 1.2 Scenarios
- **GIVEN** a workflow triggering on `pull_request`, **WHEN** `uses: juanmaagd/pr-hero@v1` executes, **THEN** it resolves the PR number automatically and runs the review in CI headless mode.
- **GIVEN** a PR exceeding `max-changed-lines`, **WHEN** the action runs, **THEN** it outputs `status=skipped-size`, leaves a skip summary on GitHub, and finishes with exit code 0.
- **GIVEN** a fatal, unhandled error inside a real GitHub Actions job step, **WHEN** the CLI exits, **THEN** it outputs `status=error` (findings/cost/run-dir all zeroed) and emits a `::error::` workflow annotation before exiting non-zero.
- **GIVEN** two reviews launched on the same PR head in quick succession, **WHEN** the second detects the first is still in-flight, **THEN** it exits 0 with `status` left unset (a documented, not-yet-wired gap — see the Phase 5 amendment above).

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
- A non-positive `--budget-usd` (`<= 0`) **MUST** disable the budget ceiling rather than reject every review, matching the documented convention for the sibling spend knobs (`size-gate.ts`: "`<= 0` disables the limit. Both knobs, independently."). All three knobs are configured together in `action.yml` and evaluated in the same preflight, so they **MUST NOT** carry opposite zero-semantics.
  - When the ceiling is disabled, no budget skip comment or summary is produced; the size gate still applies independently.
  - Because a silent disable is indistinguishable from a passing gate, the CI shell **MUST** emit a `::warning::` workflow command noting that the budget ceiling is disabled.

### 3.2 Scenarios
- **GIVEN** `--budget-usd 5.00` and an estimated cost of `$7.50`, **WHEN** the CI review preflights, **THEN** agents are not spawned, a skip notice is generated, and the job succeeds with exit code 0.
- **GIVEN** `--budget-usd 0` and any estimated cost, **WHEN** the CI review preflights, **THEN** the budget ceiling is treated as disabled, the review proceeds subject to the size gate alone, and a `::warning::` records the disabled ceiling.

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
