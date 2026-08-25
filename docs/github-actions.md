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

permissions:
  contents: read # actions/checkout
  pull-requests: write # inline comments + review + step summary
  issues: write # resolving/replying on review threads (GitHub models PR conversations as issues)

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # see "Why fetch-depth: 0" below
      - uses: juanmaagd/pr-hero@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
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
| `ANTHROPIC_API_KEY` | One of these two | A standard Anthropic API key. |
| `CLAUDE_CODE_OAUTH_TOKEN` | One of these two | A Claude Code OAuth token, if you use one instead of a raw API key. |

Reference every secret **by name** (`${{ secrets.ANTHROPIC_API_KEY }}`) — never paste a literal key into
the workflow file, a log line, or a PR comment. The action itself follows the same rule: it never echoes,
logs, or truncates a secret value anywhere in its output.

## Token permissions

The workflow's `permissions:` block needs exactly three scopes, each for a specific reason:

- **`contents: read`** — `actions/checkout` needs to read repository contents.
- **`pull-requests: write`** — posting inline findings, the summary review, and the step summary.
- **`issues: write`** — resolving and replying on review threads. GitHub's API models every PR
  conversation as an issue thread, so this scope is required even though nothing here touches an issue.

## Triggers

The canonical workflow fires on `pull_request: [opened, synchronize, reopened]`. `synchronize` is what
makes pr-hero re-review every new push to an open PR — omitting it means the review only ever runs once,
on open.

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
