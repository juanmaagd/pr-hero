# Architecture & Design: Pillar 3 — GitHub Actions CI & Headless CI Integration

**Target:** Distribution Pillar 3 (ROADMAP.md THE LAUNCH LINE)  
**Authors:** Senior Architect & Juanma  
**Date:** 2026-08-24  

## 1. System Architecture & Component Interactions

```
GitHub Actions Workflow (.github/workflows/pr-hero.yml)
  │
  ▼
Composite Action (action.yml)
  │  ├── 1. Setup Bun / Runtime
  │  ├── 2. Configure Auth (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY, GITHUB_TOKEN)
  │  └── 3. Execute `pr-hero review --pr <n> --ci --post --yes`
  │
  ▼
pr-hero Review Engine (src/pr.ts & src/pipeline.ts)
  │  ├── Preflight & Spend Gates:
  │  │     ├── Size Gate (lines & files limits)
  │  │     └── Budget Gate (--budget-usd ceiling)
  │  │     └── If Exceeded: Emit Skip Summary -> Post Skip Comment -> Exit 0
  │  │
  │  ├── Multi-Agent Parallel Hunt & Adversarial Refutation
  │  │     ├── Workflow Logs Grouping (`::group::` / `::endgroup::`)
  │  │     └── Structured Output Capture
  │  │
  │  └── Reporting & Persistence:
  │        ├── Post Inline PR Comments (via gh CLI / GitHub REST API)
  │        ├── Write $GITHUB_STEP_SUMMARY Markdown
  │        ├── Write $GITHUB_OUTPUT Key-Values
  │        └── Persist to SQLite store & files (findings.json, report.md)
  │
  ▼
Exit 0 (Assistant Posture: never blocks CI on findings)
```

## 2. GitHub Actions Composite Specification (`action.yml`)

The composite action lives at the repository root so it can be consumed directly via `uses: juanmaagd/pr-hero@v1` (or `@main` during development).

```yaml
name: 'pr-hero'
description: 'Multi-agent AI code review engine with adversarial refutation and assistant posture'
author: 'juanmaagd'
branding:
  icon: 'eye'
  color: 'purple'

inputs:
  github-token:
    description: 'GitHub token for PR comments and API access'
    required: false
    default: ${{ github.token }}
  anthropic-api-key:
    description: 'Anthropic API key for Claude models'
    required: false
  claude-token:
    description: 'Claude Code OAuth token'
    required: false
  pr-number:
    description: 'Pull request number (defaults to current PR context)'
    required: false
  model:
    description: 'Optional Claude model override'
    required: false
  scout:
    description: 'Enable exploratory scout pass (default: false)'
    required: false
    default: 'false'
  max-changed-lines:
    description: 'Maximum changed lines before skipping review'
    required: false
    default: '1000'
  max-changed-files:
    description: 'Maximum changed files before skipping review'
    required: false
    default: '50'
  budget-usd:
    description: 'Maximum estimated cost in USD before skipping review'
    required: false
    default: '10.00'
  post:
    description: 'Post review findings as PR comments'
    required: false
    default: 'true'
  step-summary:
    description: 'Write summary to GitHub Actions Step Summary'
    required: false
    default: 'true'

outputs:
  status:
    description: 'Review status: reviewed, skipped-size, skipped-budget, skipped-clean, error'
    value: ${{ steps.run-pr-hero.outputs.status }}
  findings-count:
    description: 'Total number of findings'
    value: ${{ steps.run-pr-hero.outputs.findings_count }}
  blocking-count:
    description: 'Total number of blocking tier findings'
    value: ${{ steps.run-pr-hero.outputs.blocking_count }}
  advisory-count:
    description: 'Total number of advisory tier findings'
    value: ${{ steps.run-pr-hero.outputs.advisory_count }}
  cost-usd-est:
    description: 'Estimated cost of the review in USD'
    value: ${{ steps.run-pr-hero.outputs.cost_usd_est }}
  run-dir:
    description: 'Directory path containing review artifacts'
    value: ${{ steps.run-pr-hero.outputs.run_dir }}

runs:
  using: 'composite'
  steps:
    - name: Setup Bun
      uses: oven-sh/setup-bun@v2
      with:
        bun-version: latest
    - name: Install dependencies
      shell: bash
      run: |
        if [ -f "${{ github.action_path }}/package.json" ]; then
          cd "${{ github.action_path }}" && bun install --frozen-lockfile
        fi
    - name: Run pr-hero
      id: run-pr-hero
      shell: bash
      env:
        GITHUB_TOKEN: ${{ inputs.github-token }}
        ANTHROPIC_API_KEY: ${{ inputs.anthropic-api-key }}
        CLAUDE_CODE_OAUTH_TOKEN: ${{ inputs.claude-token }}
        GITHUB_ACTIONS: 'true'
        CI: 'true'
      run: |
        # Resolve PR number
        PR_NUM="${{ inputs.pr-number }}"
        if [ -z "$PR_NUM" ]; then
          if [ "${{ github.event_name }}" = "pull_request" ] || [ "${{ github.event_name }}" = "pull_request_target" ]; then
            PR_NUM="${{ github.event.pull_request.number }}"
          elif [ "${{ github.event_name }}" = "issue_comment" ]; then
            PR_NUM="${{ github.event.issue.number }}"
          fi
        fi

        if [ -z "$PR_NUM" ]; then
          echo "::error::Could not determine PR number from workflow context. Please specify 'pr-number' input."
          exit 1
        fi

        FLAGS="--pr $PR_NUM --ci --yes"
        if [ "${{ inputs.post }}" = "true" ]; then FLAGS="$FLAGS --post"; fi
        if [ "${{ inputs.scout }}" = "true" ]; then FLAGS="$FLAGS --scout"; fi
        if [ -n "${{ inputs.model }}" ]; then FLAGS="$FLAGS --model ${{ inputs.model }}"; fi
        if [ -n "${{ inputs.max-changed-lines }}" ]; then FLAGS="$FLAGS --max-changed-lines ${{ inputs.max-changed-lines }}"; fi
        if [ -n "${{ inputs.max-changed-files }}" ]; then FLAGS="$FLAGS --max-changed-files ${{ inputs.max-changed-files }}"; fi
        if [ -n "${{ inputs.budget-usd }}" ]; then FLAGS="$FLAGS --budget-usd ${{ inputs.budget-usd }}"; fi

        bun "${{ github.action_path }}/bin/pr-hero.js" review $FLAGS
```

## 3. Core Engine Changes for CI

### 3.1 New CLI Options & Environment Detection (`src/ci.ts` & `src/pr.ts`)
- `--ci`: Forces CI headless mode, emits GitHub Actions workflow formatting when in CI, writes step summary and step outputs.
- `--budget-usd <number>`: Sets a strict ceiling on estimated run cost.
- Environment check `isCiEnvironment()`: Evaluates `Boolean(process.env.GITHUB_ACTIONS || process.env.CI || options.ci)`.

### 3.2 Step Summary & Output Generator (`src/ci-reporter.ts`)
Pure functions that construct:
1. `renderStepSummary(summaryData: CiSummaryData): string`:
   - Formatted Markdown containing summary banner, status badge, cost/duration metrics, grouped findings table, and re-review delta.
2. `writeCiOutputs(outputs: Record<string, string | number>): void`:
   - Appends `name=value` pairs to `$GITHUB_OUTPUT` if the environment variable points to a file.
3. `formatWorkflowCommand(command: 'group' | 'endgroup' | 'notice' | 'warning' | 'error', message?: string, options?: Record<string, string>): string`:
   - Pure emitter for `::group::Title`, `::endgroup::`, `::notice file=...,line=...::Message`.

### 3.3 Bounded Spend & Gate Enforcement
In `src/pr.ts` / `src/pr-preflight.ts`:
1. Size Gate check: If diff exceeds line/file limits and `--ci` is active:
   - Sets output `status=skipped-size`.
   - Appends skip notice to `$GITHUB_STEP_SUMMARY`.
   - If `--post` is on, posts a PR comment: `<!-- pr-hero:skip-size --> ⚠️ Diff of +X / -Y lines across Z files exceeds the maximum size gate limit...`.
   - Exits 0 cleanly.
2. Budget Gate check: If `estimatedCostUsd > budgetUsd` and `--ci` is active:
   - Sets output `status=skipped-budget`.
   - Appends budget notice to `$GITHUB_STEP_SUMMARY`.
   - If `--post` is on, posts a PR comment: `<!-- pr-hero:skip-budget --> ⚠️ Estimated review cost ($X) exceeds configured CI budget ceiling ($Y)...`.
   - Exits 0 cleanly.

### 3.4 Scaffolding & Setup (`src/ci-setup.ts`)
- `generateCiWorkflowTemplate()`: Returns canonical YAML content for `.github/workflows/pr-hero.yml`.
- `pr-hero setup --ci` / `pr-hero ci init`:
  - Ensures `.github/workflows` exists.
  - Checks if file already exists (refuses unless `--force`).
  - Writes the workflow template.
  - Displays instructions for configuring GitHub Secrets.

## 4. Testing & Verification Plan

1. **Unit Tests (`test/ci-reporter.test.ts`):**
   - Pure generation of Markdown step summaries (with findings, clean PRs, size-skipped PRs, budget-skipped PRs).
   - Workflow command formatting (`::group::`, `::notice::`, etc.).
   - `$GITHUB_OUTPUT` line formatting.
2. **Preflight & Gate Tests (`test/pr-preflight.test.ts` / `test/ci-gates.test.ts`):**
   - Size gate skip behavior in CI mode (exits 0, records skip status).
   - Budget gate calculation and skip behavior.
3. **Scaffolding Tests (`test/ci-setup.test.ts`):**
   - Workflow file generation, idempotency, `--force` overwrite.
   - Doctor CI diagnostics.
4. **Offline Integration Tests (`test/ci-review.test.ts`):**
   - Full mock execution of `pr-hero review --pr <n> --ci --post --yes` simulating GitHub Actions runner environment.
