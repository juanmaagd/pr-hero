---
name: pr-hero-ci-setup
description: "Trigger: setup CI, add pr-hero to CI, GitHub Actions review, OpenCode, OPENCODE_AUTH_JSON, PRHERO_ROUTING, DeepSeek, admission policy, configure CI workflow. Scaffolds workflow, secrets, routing, and admission config."
license: Apache-2.0
metadata:
  author: juanmaagd
  version: "2.1"
---

## Activation Contract

Load when the user asks to:
- Add `pr-hero` to GitHub Actions CI, scaffold `.github/workflows/pr-hero.yml`, or configure secrets.
- Configure **OpenCode** in CI (`OPENCODE_AUTH_JSON`, `PRHERO_ROUTING`, DeepSeek, mixed Claude+OpenCode).
- Tune CI spend / re-review / admission policy.

## Hard Rules

- **Zero secret leakage:** NEVER print, `cat`, commit, or log API keys, tokens, or `OPENCODE_AUTH_JSON`. Reference `${{ secrets.* }}` names only. Inspect `auth.json` **keys and `type` only**.
- **No per-provider GitHub secrets:** Do not create `OPENAI_API_KEY` or `DEEPSEEK_API_KEY`. One secret `OPENCODE_AUTH_JSON` (whole store or a CI-only subset) + public variable `PRHERO_ROUTING`. Cap 48 KB each.
- **Deterministic scaffolding:** Run `pr-hero setup --ci` (or `pr-hero ci init`). Do not fabricate the workflow from memory. Fallback: copy `assets/workflow.yml`.
- **`fetch-depth: 0` is mandatory** on `actions/checkout@v4`.
- **Assistant posture:** pr-hero is a reviewer, not a merge gate (`exit 0` on findings).
- **Required permissions:** `contents: read`, `pull-requests: write`, `issues: write`, `statuses: write`, **`checks: write`**. Template in `assets/workflow.yml` includes all five.
- **Admission config is repo-level:** Write `.prhero/config.json` on the default branch. That file **rejects** `routing`. Person-layer only (`$HOME/.prhero/config.json` on the runner, from `vars.PRHERO_ROUTING`).
- **`.prheroignore` is read from the base ref, not the PR branch, in CI.**
- **OpenCode is DATA:** quoted `routing: "${{ vars.PRHERO_ROUTING }}"` + `opencode-auth: ${{ secrets.OPENCODE_AUTH_JSON }}`. Unset both = Claude CI. Never a per-provider Action input. Never echo the auth blob.
- **OpenCode procedure:** when OpenCode or mixed backends are in scope, follow `references/opencode-ci.md` before setting GitHub DATA (strip personal OAuth, `modelSnapshot`, logical vs role).

## Decision Gates

| Condition | Action |
|---|---|
| `gh auth status` succeeds | Offer `gh secret set` / `gh variable set` |
| `gh` missing/unauthenticated | Link to repo Settings → Secrets and variables → Actions (Variables tab for routing) |
| Credential: Claude | **`CLAUDE_CODE_OAUTH_TOKEN`** — subscription (`claude setup-token` only, NOT keychain). **`ANTHROPIC_API_KEY`** — pay-as-you-go. |
| Credential: OpenCode | Read `references/opencode-ci.md`. Secret + variable. Any one of the three secrets starts the review job. |
| openai API key in CI | **Refuse.** openai → ChatGPT OAuth mapping; `type:"api"` is refused. Use a non-openai API token (tested: deepseek). |
| Hunters OpenCode / refuter Claude | DATA cannot. Routing is `sonnet`/`haiku`, not role. Default hunters+refuter = `sonnet`. |
| Mixed OpenCode providers in one run | Out of scope (#195). One OpenCode provider per run. Mixed `claude-code` + one OpenCode provider is legal. |
| OpenCode CLI pin | Action installs **1.18.30** iff `opencode-auth != ''` OR routing contains `opencode`. Never `latest`. |
| Fork PRs | Skip unchanged. Credentials union is Anthropic **or** Claude OAuth **or** `OPENCODE_AUTH_JSON`. Review `if` never reads `secrets`. |
| Spend gates | Defaults: `budget-usd: 10.00` on metered routes (Anthropic key **or** OpenCode auth file), `max-changed-lines: 1000`, `max-changed-files: 50`. Claude-only OAuth stays unlimited-subscription unless OpenCode auth is also present. |
| Existing workflow | `setup --ci` skips; ask before `--force` |
| First-time admission | Recommend `ci_admission_observe_only: true` — `references/ci-admission.md` |
| User wants max CI spend | Lower `ci_max_attempts` and/or raise `ci_rereview_min_score` |
| Custom bot posts findings | Add login to `ci_trusted_actors` |
| Budget exhausted on PR | Guide `pr-hero review --pr <n> --post --force` |

## Admission Interview (ask before writing config)

Ask these in plain language; map answers to `.prhero/config.json`:

1. **Attempts per PR?** Default `2` (`ci_max_attempts`). Same commit never double-reviews.
2. **When should a push trigger re-review?** Balanced → `risk_aware`; score only → `thresholded`; once then stop → `once_per_pr`; every push → `every_push`; manual only → `manual_only`.
3. **Score floor?** Default `4` with weights 2/1.
4. **Observe first?** If unsure, `ci_admission_observe_only: true` for one PR cycle.
5. **Non-default bot actor?** Collect GitHub logins for `ci_trusted_actors`.

Use `assets/admission-config.example.json`. Details: `references/ci-admission.md`.

## Execution Steps

1. **Inspect repo:** `git rev-parse --is-inside-work-tree`, `git remote get-url origin`, `gh auth status`.
2. **Credential path:** Claude-only → skip OpenCode. OpenCode or mix → **read `references/opencode-ci.md`** and execute it (metadata inspect, CI-only blob, secret, routing with `modelSnapshot`).
3. **Claude secret (if used):** `gh secret set CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (secure input, never print).
4. **Workflow:** `pr-hero setup --ci`. Confirm `checks: write`, credentials-job union includes `OPENCODE_AUTH_JSON`, quoted `routing` / `opencode-auth`. `--force` if an old template lacks them.
5. **Admission config:** Interview above. `.prhero/config.json` on the default branch. **No `routing` key.** `pr-hero config` to verify.
6. **Verify:** `pr-hero doctor`. `git status`. Confirm no openai `type:"api"` blob, no echoed auth, `modelSnapshot` matches `opencode models` when OpenCode is on.
7. **Deploy:** Offer commit. Open a **same-repo** test PR (forks skip).

## Output Contract

Report:
- Secret status (set or manual link). Names only: which of `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / `OPENCODE_AUTH_JSON` exist. Never values.
- OpenCode (if in scope): `OPENCODE_AUTH_JSON` set; blob providers **names + type only**; whether the blob was stripped to one CI provider; `PRHERO_ROUTING` JSON (no credentials); `modelSnapshot` vs `opencode models`.
- Workflow path and whether `checks: write`, credentials union, and quoted `routing` / `opencode-auth` are present.
- Admission policy (mode, attempts, observe-only). Confirm repo `.prhero/config.json` has no `routing` key.
- `pr-hero doctor` / `pr-hero config` outcome.
- Next steps: push, same-repo test PR, when to turn off observe-only, override command if manual-required.

## References

- `assets/workflow.yml` — canonical workflow template.
- `assets/admission-config.example.json` — starter `.prhero/config.json`.
- `references/ci-admission.md` — admission keys, modes, rollout, ledger.
- `references/opencode-ci.md` — OpenCode secret/variable procedure, routing, pin, openai vs deepseek.
- `docs/github-actions.md` — full CI integration docs.
