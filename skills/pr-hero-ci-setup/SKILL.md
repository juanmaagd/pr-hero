---
name: pr-hero-ci-setup
description: "Trigger: setup CI, add pr-hero to CI, GitHub Actions review, admission policy, configure CI workflow. Scaffolds workflow, secrets, and .prhero admission config."
license: Apache-2.0
metadata:
  author: juanmaagd
  version: "2.0"
---

## Activation Contract

Load when the user asks to:
- Add `pr-hero` to GitHub Actions CI.
- Scaffold `.github/workflows/pr-hero.yml` or configure secrets.
- Set up automated PR reviews **or** tune CI spend / re-review policy.

## Hard Rules

- **Zero secret leakage:** NEVER print or commit API keys/tokens. Reference `${{ secrets.* }}` names only.
- **Deterministic scaffolding:** Run `pr-hero setup --ci` (or `pr-hero ci init`). Do not fabricate the workflow from memory. Fallback: copy `assets/workflow.yml`.
- **`fetch-depth: 0` is mandatory** on `actions/checkout@v4`.
- **Assistant posture:** pr-hero is a reviewer, not a merge gate (`exit 0` on findings).
- **Required permissions:** `contents: read`, `pull-requests: write`, `issues: write`, `statuses: write`, **`checks: write`** (admission ledger). Template in `assets/workflow.yml` includes all five.
- **Admission config is repo-level:** Write `.prhero/config.json` on the default branch, not in a PR branch. Authors must not use it to suppress their own reviews.

## Decision Gates

| Condition | Action |
|---|---|
| `gh auth status` succeeds | Offer `gh secret set` |
| `gh` missing/unauthenticated | Link to `https://github.com/<owner>/<repo>/settings/secrets/actions` |
| Credential choice | **`CLAUDE_CODE_OAUTH_TOKEN`** — subscription, no per-token API bill (`claude setup-token` only, NOT keychain session token). **`ANTHROPIC_API_KEY`** — pay-as-you-go Console key. |
| Spend gates (workflow inputs) | Defaults: `budget-usd: 10.00`, `max-changed-lines: 1000`, `max-changed-files: 50` |
| Existing workflow | `setup --ci` skips; ask before `--force` |
| First-time admission rollout | Recommend `ci_admission_observe_only: true` — see `references/ci-admission.md` |
| User wants max CI spend | Lower `ci_max_attempts` and/or raise `ci_rereview_min_score`; explain skip vs manual-required |
| Custom bot posts findings | Add login to `ci_trusted_actors` (always includes `GITHUB_ACTOR` in Actions) |
| Budget exhausted on PR | Guide `pr-hero review --pr <n> --post --force` |

## Admission Interview (ask before writing config)

Ask these in plain language; map answers to `.prhero/config.json`:

1. **Attempts per PR?** Default `2` (`ci_max_attempts`). Same commit never double-reviews.
2. **When should a push trigger re-review?**
   - *Balanced (recommended)* → `risk_aware`
   - *Score only* → `thresholded`
   - *Once then stop* → `once_per_pr`
   - *Every push* → `every_push` (still attempt-capped)
   - *Manual only* → `manual_only`
3. **Score floor?** Default `4` with weights 2/1. Example: two advisory findings (score 2) skip; one blocking + two advisory (score 4) re-review.
4. **Observe first?** If unsure, set `ci_admission_observe_only: true` for one PR cycle.
5. **Non-default bot actor?** Collect GitHub logins for `ci_trusted_actors`.

Use `assets/admission-config.example.json` as a starting point. Details: `references/ci-admission.md`.

## Execution Steps

1. **Inspect repo:** `git rev-parse --is-inside-work-tree`, `git remote get-url origin`, `gh auth status`.
2. **Credential:** Guide `claude setup-token` OR Anthropic Console key (see Decision Gates).
3. **Secret:** `gh secret set CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (secure input).
4. **Workflow:** `pr-hero setup --ci`. Confirm `checks: write` is present (re-scaffold with `--force` if an old template lacks it).
5. **Admission config:** Run the interview above. Create or merge `.prhero/config.json` on the default branch. Run `pr-hero config` to verify.
6. **Verify:** `pr-hero doctor`. `git status` for workflow + config.
7. **Deploy:** Offer commit (`chore: add pr-hero CI workflow and admission config`). Open a test PR; if observe-only, read job notices before disabling it.

## Output Contract

Report:
- Secret status (set or manual link).
- Workflow path and whether `checks: write` is present.
- Admission policy chosen (mode, attempts, observe-only on/off).
- `pr-hero doctor` / `pr-hero config` outcome.
- Next steps: push, test PR, when to turn off observe-only, override command if manual-required.

## References

- `assets/workflow.yml` — canonical workflow template.
- `assets/admission-config.example.json` — starter `.prhero/config.json`.
- `references/ci-admission.md` — admission keys, modes, rollout, ledger.
- `docs/github-actions.md` — full CI integration docs.
