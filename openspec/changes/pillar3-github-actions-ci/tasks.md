# Tasks: Pillar 3 — GitHub Actions CI & Headless CI Integration

Ordering rule (openspec `strict_tdd`): every phase starts by writing that phase's failing offline tests, then implements until they pass.

## Phase 1: CI Reporter & Workflow Formatting

- [x] 1.1 Write failing unit tests in `test/ci-reporter.test.ts`:
  - `formatWorkflowCommand` emitter (`::group::`, `::endgroup::`, `::notice::`, `::warning::`, `::error::` with file/line/title options)
  - `renderStepSummary` for a normal completed review (status header, metrics table, findings grouped by file and severity tier, Markdown links, re-review delta)
  - `renderStepSummary` for a clean review (no findings detected)
  - `renderStepSummary` for a skipped review (size gate limit exceeded vs budget ceiling exceeded)
  - `formatCiOutputs` for writing key-value pairs (`status`, `findings_count`, `blocking_count`, `advisory_count`, `cost_usd_est`, `run_dir`) to `$GITHUB_OUTPUT`
- [x] 1.2 Implement pure module `src/ci-reporter.ts` (`formatWorkflowCommand`, `renderStepSummary`, `formatCiOutputs`, `appendStepSummary`, `appendCiOutputs`)
- [x] 1.3 Make all Phase 1 tests pass with `bun test test/ci-reporter.test.ts`

## Phase 2: CI Spend & Budget Gate Protection

- [x] 2.1 Write failing tests in `test/ci-gates.test.ts`:
  - Budget gate evaluation: `evaluateBudgetGate(estimatedCostUsd, budgetUsd)` returning `{ allowed: boolean, reason?: string }`
  - CI size-gate handling: when `isCi` is true and diff exceeds limits, format the skip PR comment markdown and summary payload without throwing fatal errors
  - CI budget-gate handling: when `isCi` is true and estimated cost exceeds budget, generate the budget skip PR comment and step summary payload
- [x] 2.2 Implement budget gate evaluation and CI skip payload builders in `src/ci-gates.ts`
- [x] 2.3 Make all Phase 2 tests pass with `bun test test/ci-gates.test.ts`

## Phase 3: Review CLI Integration & CI Headless Shell

- [x] 3.1 Write failing tests in `test/ci-review.test.ts`:
  - CLI argument parsing for `--ci`, `--budget-usd <num>`, `--step-summary`, `--no-step-summary`
  - Environment detection: auto-enabling CI mode when `GITHUB_ACTIONS=true`
  - Assistant posture verification: when review finds blocking findings in CI mode, the CLI publishes findings, writes summary, and exits with code 0 (never blocks CI)
  - Size gate and budget gate skips in CI mode: posting skip PR comment when `--post` is on, writing summary, and exiting 0 with output `status=skipped-size` / `status=skipped-budget`
  - Step summary file writing when `$GITHUB_STEP_SUMMARY` is provided
  - Output parameter writing when `$GITHUB_OUTPUT` is provided
- [x] 3.2 Wire `--ci`, `--budget-usd`, and CI runner hooks into `src/pr.ts` and `src/cli.ts`
- [x] 3.3 Make all Phase 3 tests pass with `bun test test/ci-review.test.ts`

## Phase 4: CI Scaffolding & Doctor Diagnostics

- [x] 4.1 Write failing tests in `test/ci-setup.test.ts`:
  - `generateCiWorkflowTemplate`: returns valid YAML string containing triggers, permissions (`pull-requests: write`, `contents: read`), checkout with `fetch-depth: 0`, and `uses: juanmaagd/pr-hero@v1`
  - `runCiSetup`: creates `.github/workflows/pr-hero.yml`; refuses to overwrite existing file unless `--force` is passed
  - `doctor` CI check: verifies CI configuration in repo context and presence of required secrets/tokens when running inside GitHub Actions
- [x] 4.2 Implement `src/ci-setup.ts` and wire `pr-hero setup --ci` (and `pr-hero ci init`)
- [x] 4.3 Update `src/doctor.ts` and `src/system-tools.ts` with CI diagnostics
- [x] 4.4 Make all Phase 4 tests pass with `bun test test/ci-setup.test.ts`

## Phase 5: Official Action Definition, Documentation & Verification

- [x] 5.1 Create official `action.yml` at repository root with complete inputs, outputs, Bun setup, and execution step
- [x] 5.2 Create canonical example workflow in `.github/workflows/pr-hero.yml`
- [x] 5.3 Author `docs/github-actions.md` detailing GitHub Action setup, authentication secrets, trigger configurations, and budget controls
- [x] 5.4 Update `README.md` and `ROADMAP.md` ticking the distribution pillar 3 requirements
- [x] 5.5 Run full verification: `bun test`, `bun run typecheck`, `./node_modules/.bin/biome check src test`
