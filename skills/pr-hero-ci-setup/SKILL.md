---
name: pr-hero-ci-setup
description: "Trigger: setup CI, add pr-hero to CI, GitHub Actions review, configure CI workflow. Scaffolds pr-hero workflow and configures repository secrets."
license: Apache-2.0
metadata:
  author: juanmaagd
  version: "1.0"
---

## Activation Contract

Load this skill when the user asks to:
- Add `pr-hero` to their repository's GitHub Actions CI pipeline.
- Scaffold or configure `.github/workflows/pr-hero.yml`.
- Configure repository secrets (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`).
- Set up automated, multi-agent AI PR reviews on pull requests.

## Hard Rules

- **Zero secret leakage:** NEVER print, echo, commit, or log literal API keys or tokens. Reference secrets solely by environment/secret name (`${{ secrets.ANTHROPIC_API_KEY }}`).
- **Deterministic scaffolding:** Never handcraft or fabricate `.github/workflows/pr-hero.yml` from memory. Run `pr-hero setup --ci` (or `pr-hero ci init`) to write the canonical template.
- **`fetch-depth: 0` is mandatory:** `actions/checkout@v4` MUST specify `fetch-depth: 0`. Shallow clones fail diff range and commit ancestry computations silently.
- **Assistant posture:** Inform the user that `pr-hero` acts as a reviewer, not a merge blocker (`exit 0` on detected findings). Findings are published as comments, reviews, and step summaries.
- **Required permissions:** Ensure the workflow carries `contents: read`, `pull-requests: write`, and `issues: write` (required for review thread replies/resolution).

## Decision Gates

| Condition | Action |
|---|---|
| `gh` CLI installed & authenticated (`gh auth status` succeeds) | Offer to set secret directly via `gh secret set` |
| `gh` CLI missing or unauthenticated | Guide user to web UI: `https://github.com/<owner>/<repo>/settings/secrets/actions` |
| Credential selection: Subscription vs API | **`CLAUDE_CODE_OAUTH_TOKEN`**: consumes directly from the user's Claude subscription (Pro/Team/Enterprise) with **zero extra API billing/costs**.<br>**`ANTHROPIC_API_KEY`**: standard pay-as-you-go key billed per token via Anthropic Console. |
| Spend controls customization | Default budget is `$10.00` per PR (`budget-usd: 10.00`), max changed lines is 1000 |
| Existing workflow file | `pr-hero setup --ci` skips if present; prompt user before passing `--force` |

## Execution Steps

1. **Inspect repository context:**
   - Confirm current directory is a git repository: `git rev-parse --is-inside-work-tree`.
   - Resolve origin remote URL and owner/repo: `git remote get-url origin`.
   - Check GitHub CLI authentication status: `gh auth status`.

2. **Select and obtain the credential:**
   - Explain the two authentication options and guide the user to obtain their token:
     * **Option A: `CLAUDE_CODE_OAUTH_TOKEN` (Claude Subscription - Zero API Costs):**
       1. Run `claude setup-token` in terminal (with Claude Code CLI installed).
       2. Follow the browser login prompt to authorize your Claude Pro/Team/Enterprise account.
       3. Copy the output OAuth token.
     * **Option B: `ANTHROPIC_API_KEY` (Pay-As-You-Go API Key):**
       1. Navigate to [Anthropic Console Settings](https://console.anthropic.com/settings/keys).
       2. Click **Create Key**, name it `pr-hero-ci`, and copy the `sk-ant-...` key.

3. **Configure the repository secret:**
   - **Via GitHub CLI (`gh` authenticated):**
     * Prompt the user for the value and run:
       ```bash
       gh secret set CLAUDE_CODE_OAUTH_TOKEN # or ANTHROPIC_API_KEY
       ```
     * Ensure the secret value is piped or entered securely without being echoed into transcripts or command logs.
   - **Via GitHub Web UI:**
     * Provide the direct link: `https://github.com/<owner>/<repo>/settings/secrets/actions`.
     * Instruct the user to click **New repository secret**, enter the exact name (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`), paste the value, and save.

4. **Scaffold workflow file:**
   - **Primary path:** Run `pr-hero setup --ci` (or `pr-hero ci init`).
   - **Fallback (if `pr-hero` CLI is not installed):** Copy the canonical template from `assets/workflow.yml` directly into `.github/workflows/pr-hero.yml`.
   - If the workflow already exists, ask the user before overwriting (via `--force` or replacing file).

5. **Verify configuration:**
   - If `pr-hero` is installed, run `pr-hero doctor` locally to verify `.github/workflows/pr-hero.yml` is detected.
   - Check `git status` to verify the new workflow file is tracked.

6. **Commit and deploy:**
   - Offer to commit `.github/workflows/pr-hero.yml` (`chore: add pr-hero GitHub Actions review workflow`).
   - Remind the user to push to their remote and open a test pull request to see the first automated review.

## Output Contract

Report to the user:
- Status of repository secret configuration (set via `gh` or manual link provided).
- Path of scaffolded workflow (`.github/workflows/pr-hero.yml`).
- Verification outcome from `pr-hero doctor`.
- Next steps (pushing branch and opening a PR).

## References
- `assets/workflow.yml` — canonical GitHub Actions review workflow template.
- `docs/github-actions.md` — full documentation on GitHub Actions CI integration, spend gates, and permissions.
