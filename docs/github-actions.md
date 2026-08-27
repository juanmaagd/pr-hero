# GitHub Actions Integration

pr-hero reviews every pull request automatically: a multi-agent hunt with adversarial refutation runs
inside a GitHub Actions job, posts findings as PR comments, writes a step summary, and never blocks the
merge on its own findings.

## Quick path

1. **Add one auth secret** (Settings → Secrets and variables → Actions → New repository secret):
   `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. Pick one — never both blank.
2. **Add the workflow file.** Either run `pr-hero setup --ci` (or `pr-hero ci init`) in a clone of your
   repo, or copy this repository's own `.github/workflows/pr-hero.yml` verbatim — the two are guaranteed
   byte-identical (`test/packaging.test.ts` asserts it).
3. **Open a pull request.** pr-hero comments inline, posts a summary review, and writes a
   `$GITHUB_STEP_SUMMARY` block within a few minutes.
4. **Verify readiness any time** with `pr-hero doctor` — it checks for the required secrets when run
   inside Actions, and for the workflow file's presence locally.

## What the workflow does

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]

concurrency:
  group: pr-hero-${{ github.workflow }}-${{ github.head_ref || github.ref }}
  cancel-in-progress: true

permissions:
  contents: read # actions/checkout
  pull-requests: write # inline comments + review + step summary
  issues: write # resolving/replying on review threads (GitHub models PR conversations as issues)
  statuses: write # commit status updates

jobs:
  review:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # see "Why fetch-depth: 0" below
      - name: Run pr-hero
        id: pr-hero
        uses: juanmaagd/pr-hero@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      - name: Upload pr-hero run directory # see "Triaging a CI review" below
        if: always() && steps.pr-hero.outputs.run-dir != ''
        uses: actions/upload-artifact@v4
        with:
          name: pr-hero-run-${{ github.event.pull_request.number }}-${{ github.event.pull_request.head.sha }}
          path: ${{ steps.pr-hero.outputs.run-dir }}
          include-hidden-files: true
          if-no-files-found: warn
          overwrite: true
          retention-days: 7
```

`pr-hero setup --ci` generates exactly this shape (see `src/ci-setup.ts`'s `generateCiWorkflowTemplate`).
It refuses to overwrite a customized workflow already at that path unless you pass `--force`.

### Why `fetch-depth: 0`

`actions/checkout`'s default is a **shallow** clone. pr-hero computes the pull request's diff range and
commit ancestry from full git history — a shallow clone does not fail loudly here, it makes the review
silently miss context (wrong merge-base, incomplete blame). This is load-bearing, not cosmetic: never
trim it.

## Authentication

| Secret | Required | Notes |
|---|---|---|
| `GITHUB_TOKEN` | Yes (auto-provided) | GitHub injects this automatically; the action's `github-token` input defaults to it — you rarely need to set it explicitly. |
| `CLAUDE_CODE_OAUTH_TOKEN` | One of these two | The long-lived token printed by `claude setup-token` (valid ~1 year). Consumes directly from your Claude subscription (Pro/Team/Enterprise) with **zero extra API billing/costs**. Must come from that command — see the warning under Option 1. |
| `ANTHROPIC_API_KEY` | One of these two | A standard Anthropic API key, billed per token via your Anthropic Console account. |

Reference every secret **by name** (`${{ secrets.ANTHROPIC_API_KEY }}`) — never paste a literal key into
the workflow file, a log line, or a PR comment. The action itself follows the same rule: it never echoes,
logs, or truncates a secret value anywhere in its output.

### How to obtain and configure credentials

#### Option 1: Claude Subscription OAuth Token (`CLAUDE_CODE_OAUTH_TOKEN`)
*Best for developers with Claude Pro, Team, or Enterprise subscriptions.*

1. In your local terminal where Claude Code CLI is installed, run:
   ```bash
   claude setup-token
   ```
2. Authorize via the browser login window.
3. Copy the resulting token string. The command prints it once and reports its
   validity period (~1 year); regenerate it the same way before it lapses.

> **Use only the token this command prints.** Two different credentials are both
> called a "Claude OAuth token", and only this one survives in CI. The session
> token that `/login` leaves in your keychain (or `~/.claude/.credentials.json`)
> expires in **hours** — the CLI hides that locally by silently rotating it with
> a refresh token, which CI does not have. Paste that one into the secret and
> reviews work for about a day, then stop with no error you will notice.

#### Option 2: Anthropic API Key (`ANTHROPIC_API_KEY`)
*Best for pay-as-you-go per-token billing on an Anthropic Console account.*

1. Go to [Anthropic Console Keys](https://console.anthropic.com/settings/keys).
2. Click **Create Key**, assign a name (e.g. `pr-hero-ci`), and copy the `sk-ant-...` key.

#### Setting the secret in GitHub

* **Via GitHub CLI (Fast):**
  ```bash
  gh secret set CLAUDE_CODE_OAUTH_TOKEN # or ANTHROPIC_API_KEY
  ```
  Paste the token when prompted.
* **Via GitHub Web UI:**
  1. Go to `https://github.com/<owner>/<repo>/settings/secrets/actions`.
  2. Click **New repository secret**.
  3. Enter Name (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`).
  4. Paste the token into Secret and click **Add secret**.


## Token permissions

The workflow's `permissions:` block needs four scopes, each for a specific reason:

- **`contents: read`** — `actions/checkout` needs to read repository contents.
- **`pull-requests: write`** — posting inline findings, the summary review, and the step summary.
- **`issues: write`** — resolving and replying on review threads. GitHub's API models every PR
  conversation as an issue thread, so this scope is required even though nothing here touches an issue.
- **`statuses: write`** — updating the PR commit status context (pending, success, error).

## Security considerations

### Fork pull requests
In GitHub Actions, pull requests originating from forks do not receive repository secrets (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`). This is GitHub's intentional security boundary to prevent untrusted pull requests from exfiltrating credentials or consuming API budget.

The generated workflow includes:
```yaml
if: github.event.pull_request.head.repo.full_name == github.repository
```
This ensures the review job only runs on internal branch PRs where credentials are present, skipping cleanly on fork PRs instead of failing with missing credential errors.

### Action version pinning
The default workflow targets the floating major tag `uses: juanmaagd/pr-hero@v1` to automatically receive backward-compatible bug fixes and optimizations. If your organization enforces strict immutable SHA pinning, you can pin the full commit SHA directly:
```yaml
- uses: juanmaagd/pr-hero@aff0324cd8c6a0c5fbf97ddbf3e6d234c9c612e4 # v1.0.0
```

## Spend controls

Two independent gates run **before** any agent is spawned, so an oversized or over-budget PR costs
nothing:

| Gate | Input | Default | Disable |
|---|---|---|---|
| Size | `max-changed-lines` / `max-changed-files` | `1000` / `50` | `0` |
| Budget | `budget-usd` | `10.00` | any value `<= 0` |

Both gates exit 0 and leave a courteous PR comment plus step-summary note when they trip — they are cost
gates, not quality gates, and never fail the job.

**A `budget-usd` of `0` or below does not mean "spend nothing" — it disables the ceiling.** This
matches the sibling size-gate knobs' documented convention (`<= 0` disables the limit). Reading it the
other way ("always skip") would make pr-hero silently stop reviewing every PR while the job still shows
green. Because a disabled ceiling is otherwise indistinguishable from a passing one, a disabled budget
emits a `::warning::` workflow annotation on every run — check your job logs if you did not mean to
disable it.

## Assistant posture: it never blocks your merge

pr-hero is a reviewer, not a merge gate. The job exits `0` even when it finds blocking-tier issues —
findings are published as comments and a summary, and the decision to act on them is yours. Nothing
about *what* a review found can turn the job red.

Three things can. Only the first sets `status=error`:

| Cause | Exit | `status` |
|---|---|---|
| A genuinely fatal failure — missing/invalid credentials, a crashed process, a malformed argument | `2` for a bad argument, `1` otherwise | `error`, plus an `::error::` annotation naming it |
| Every hunter died, so nothing was reviewed | `1` | **unset** — see the known gaps below |
| The review ran, but some findings could not be posted to the PR | `1` | `reviewed`, describing the findings that did land |

The middle case publishes no outputs and no step summary on purpose: a run where nothing was hunted has
no result to report, and emitting `reviewed` with `findings-count=0` for it would read to a human as a
PR that came back clean.

## Outputs

| Output | Meaning |
|---|---|
| `status` | `reviewed`, `skipped-size`, `skipped-budget`, or `error` — see the caveat below. |
| `findings-count` | Total verified findings. |
| `blocking-count` | Blocking-tier findings. |
| `advisory-count` | Advisory-tier findings. |
| `cost-usd-est` | Estimated review cost in USD, e.g. `"2.45"`. |
| `run-dir` | Path to the run directory containing `findings.json` and `report.md`. |

A **clean** review (nothing found) still reports `status=reviewed`, just with `findings-count=0` — there
is no separate "clean" status. If you need `if:` logic that reacts to a clean PR, branch on
`findings-count == 0`, not on `status`.

### Known gaps: two cases leave `status` empty

**A concurrent review.** If two runs land on the exact same commit in quick succession (e.g. two rapid
pushes), the second one detects the first is still in-flight and exits `0` **without setting any output
at all**. This is a pre-existing behavior, not new in this release, and is tracked as an open follow-up
rather than silently absorbed into the enum (see
`openspec/changes/pillar3-github-actions-ci/spec.md` §1.1's Phase 5 amendment for the full reasoning).

**A review where every hunter died.** The job exits `1` and writes nothing, for the reason given under
"Assistant posture" above: there is no outcome to report, and the alternative — a step summary reading
"No findings detected" over a review that never ran — is worse than silence. Giving this case a status
of its own is an open follow-up.

The two are told apart by the exit code: green with an empty `status` is the concurrent run, red with an
empty `status` is the dead one. If your workflow branches on `steps.<id>.outputs.status`, treat an
**empty** value on a green job as "no review outcome yet — a concurrent run owns this head", not as a
failure.

## Triaging a CI review

Answering a posted finding goes through the driver:

```bash
pr-hero triage reply --pr <n> --from <run-dir> --finding F001 \
  --tag applied --body-file reasoning.md
```

`--from` needs the **run directory that produced those findings** — the driver opens
`comparison.json` there and reads `findings.json` to map `F001` onto the posted
`<!-- pr-hero-finding` marker. Locally that directory is still on your disk. In Actions it lives on the
runner at `~/.prhero/repos/<host>/<owner>/<repo>/runs/pr-<n>-<sha>-1` and **dies with the job**, so the
workflow uploads it as an artifact.

### Downloading the run directory

```bash
# Find the review run for the PR (or read the run id off the checks tab)
gh run list --workflow "pr-hero Review" --branch <head-branch> --limit 5

# Download the artifact into ./pr-hero-run/
gh run download <run-id> \
  -n pr-hero-run-<pr-number>-<head-sha> \
  -D pr-hero-run

# Then triage against it
pr-hero triage reply --pr <n> --from pr-hero-run --finding F001 \
  --tag applied --body-file reasoning.md
```

The artifact name carries **both** the PR number and the full head sha (`<head-sha>` is
`github.event.pull_request.head.sha`, not the 8-character prefix in the directory name), so a PR reviewed
across several pushes has one unambiguous artifact per reviewed head. `gh run download` unpacks the run
directory's *contents*, not the directory itself — point `--from` at whatever directory you downloaded
into (`-D`), not at a `pr-<n>-<sha>-1` path inside it.

### What is in it, and how long it lives

The run directory holds the reviewed diff (`diff.patch`), the rendered agent prompts, every hunter draft,
`findings.json`, `pipeline.json`, `report.md`, and the per-attempt step logs. **On a public repository,
workflow artifacts are downloadable by anyone** — which is why `retention-days: 7` is deliberately short:
long enough to triage, short enough to bound exposure. Lengthen it only if you have weighed that.

Three properties of the upload step are load-bearing:

- **`if: always()`** — a *failed* review is when this directory matters most. When every hunter dies
  (e.g. bad credentials), the per-attempt logs under `steps/logs/` are the only record naming the cause.
- **`if-no-files-found: warn`** — a size-gated, budget-gated, or concurrent review writes no run
  directory. That is correct behavior and must never turn the job red.
- **`overwrite: true`** — artifact names are unique per workflow *run*, and `gh run rerun` reuses the run
  id, so a re-run's upload would otherwise conflict.

> **Known gap.** Four outcomes publish no usable `run-dir`, so the `steps.pr-hero.outputs.run-dir != ''`
> condition suppresses the upload for all of them:
>
> - a **concurrent review** and a run where **every hunter died** — the two cases that leave `status`
>   empty (see above), because no output is written at all;
> - a **fatal error**, which reports `status=error` but writes `run_dir=""` explicitly;
> - a **cancelled job**, where the signal handlers kill the child processes and exit without ever
>   reaching the code that writes the job's output file.
>
> The every-hunter-died and cancelled cases are exactly the failures `always()` exists to cover, so the
> gap bites hardest where the directory would help most. Closing it requires the action to publish
> `run-dir` on those paths — an open follow-up in the CLI, not something to work around in the workflow.
> `always()` still earns its place for a review that ran but could not post, and for a later step in the
> job failing.

## Optional inputs

| Input | Default | Purpose |
|---|---|---|
| `pr-number` | resolved from the triggering event | Override when triggering from a non-`pull_request` event. |
| `model` | engine default | Override every agent's model. |
| `scout` | `false` | Experimental diff-only pre-hunt stage; off by default. |
| `post` | `true` | Set `false` to run the review and write outputs/summary without posting to the PR. |
| `step-summary` | `true` | Set `false` to skip the `$GITHUB_STEP_SUMMARY` write. |

## Troubleshooting

- **`pr-hero doctor`** locally reports whether `.github/workflows/pr-hero.yml` exists; inside Actions it
  reports whether the required secrets are present (never their values).
- **No comment appears on the PR** — check `permissions: pull-requests: write` is present, and that at
  least one of the two auth secrets is set.
- **The review job is red** — never because of findings. Read `status` to tell the three causes apart:
  `error` is a fatal failure and the `::error::` annotation in the log names it; an **empty** `status`
  means every hunter died (the log shows their failures); `reviewed` means the review itself succeeded
  but some comments could not be posted. See "Assistant posture" above.
