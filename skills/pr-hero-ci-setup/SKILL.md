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

- **Zero secret leakage:** NEVER print or commit API keys/tokens or `OPENCODE_AUTH_JSON`. Reference `${{ secrets.* }}` names only.
- **Deterministic scaffolding:** Run `pr-hero setup --ci` (or `pr-hero ci init`). Do not fabricate the workflow from memory. Fallback: copy `assets/workflow.yml`.
- **`fetch-depth: 0` is mandatory** on `actions/checkout@v4`.
- **Assistant posture:** pr-hero is a reviewer, not a merge gate (`exit 0` on findings).
- **Required permissions:** `contents: read`, `pull-requests: write`, `issues: write`, `statuses: write`, **`checks: write`** (admission ledger). Template in `assets/workflow.yml` includes all five.
- **Admission config is repo-level:** Write `.prhero/config.json` on the default branch, not in a PR branch. Authors must not use it to suppress their own reviews. That file **rejects** `routing` — person-layer only (`$HOME/.prhero/config.json` on the runner, from `vars.PRHERO_ROUTING`).
- **`.prheroignore` is read from the base ref, not the PR branch, in CI:** the same reasoning as the config line above — a PR author must not be able to widen their own review's exclusions from within the PR itself.
- **OpenCode is DATA:** `vars.PRHERO_ROUTING` (quoted `with.routing`) + `secrets.OPENCODE_AUTH_JSON`. Unset both = today's Claude CI. Never a per-provider Action input. Cap 48 KB each. Never echo the auth blob.

## Decision Gates

| Condition | Action |
|---|---|
| `gh auth status` succeeds | Offer `gh secret set` / `gh variable set` |
| `gh` missing/unauthenticated | Link to `https://github.com/<owner>/<repo>/settings/secrets/actions` (and Variables for routing) |
| Credential choice | **`CLAUDE_CODE_OAUTH_TOKEN`** — subscription, no per-token API bill (`claude setup-token` only, NOT keychain session token). **`ANTHROPIC_API_KEY`** — pay-as-you-go Console key. **OpenCode:** `OPENCODE_AUTH_JSON` (whole `auth.json`) **and** repo variable `PRHERO_ROUTING` (routing object JSON). Any one of the three secrets starts the review job. Unset OpenCode data = Claude CI. |
| OpenCode provider | Metered CI uses a **non-openai** API token. Tested example: **deepseek** `{ "type": "api", "key": "sk-test-fake" }`. openai `type:"api"` is **refused** (ChatGPT OAuth mapping — do not remap). Mixed OpenCode providers in one run = #195, out of scope. Mixed `claude-code` + one OpenCode provider already works. |
| OpenCode CLI pin | Action installs **1.18.23** in its own step iff `opencode-auth` is non-empty **or** routing contains `opencode`. Never `latest`. Claude-only CI skips the install and still starts. |
| Fork PRs | Unchanged skip: forks get no secrets. Credentials job union is Anthropic **or** Claude OAuth **or** `OPENCODE_AUTH_JSON`. Review job `if` never reads `secrets`. |
| Spend gates (workflow inputs) | Defaults: `budget-usd: 10.00` on metered routes (Anthropic key **or** OpenCode API-token file), `max-changed-lines: 1000`, `max-changed-files: 50`. Claude-only OAuth stays unlimited-subscription unless OpenCode auth is also present (then the ceiling applies). |
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
2. **Credential:** Guide `claude setup-token` OR Anthropic Console key OR OpenCode (see Decision Gates). Claude-only: skip the OpenCode steps.
3. **Secret / variable:** `gh secret set CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (secure input). For OpenCode:
   `gh secret set OPENCODE_AUTH_JSON` (whole `auth.json`, never print) and
   `gh variable set PRHERO_ROUTING --body '<routing-object-json>'` (quoted in the workflow; unset = empty string).
   Routing is the `config.routing` object, not the whole person-layer file. Cap 48 KB each.
4. **Workflow:** `pr-hero setup --ci`. Confirm `checks: write`, the credentials-job union (including
   `OPENCODE_AUTH_JSON`), and quoted `routing: "${{ vars.PRHERO_ROUTING }}"` / `opencode-auth: ${{ secrets.OPENCODE_AUTH_JSON }}`.
   Re-scaffold with `--force` if an old template lacks them.
5. **Admission config:** Run the interview above. Create or merge `.prhero/config.json` on the default branch. Do **not** put `routing` there. Run `pr-hero config` to verify.
6. **Verify:** `pr-hero doctor`. `git status` for workflow + config. Confirm the operator did not paste
   an openai `type:"api"` store (refused) and did not echo `OPENCODE_AUTH_JSON`.
7. **Deploy:** Offer commit (`chore: add pr-hero CI workflow and admission config`). Open a **same-repo**
   test PR (forks skip). If observe-only, read job notices before disabling it.

## Output Contract

Report:
- Secret status (set or manual link). For OpenCode: `OPENCODE_AUTH_JSON` set (never show the value) and `PRHERO_ROUTING` variable set (routing object, not wrapped).
- Workflow path and whether `checks: write`, credentials union, and quoted `routing` / `opencode-auth` are present.
- Admission policy chosen (mode, attempts, observe-only on/off). Confirm repo `.prhero/config.json` has no `routing` key.
- `pr-hero doctor` / `pr-hero config` outcome.
- Next steps: push, same-repo test PR, when to turn off observe-only, override command if manual-required.

## References

- `assets/workflow.yml` — canonical workflow template.
- `assets/admission-config.example.json` — starter `.prhero/config.json`.
- `references/ci-admission.md` — admission keys, modes, rollout, ledger.
- `docs/github-actions.md` — full CI integration docs.
