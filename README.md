# pr-hero

A multi-agent PR-review engine. Specialty hunter agents fan out in parallel over a repo checkout and
its diff, a mechanical dedupe merges their drafts, an adversarial refuter challenges every severe
finding, and deterministic code — never a model — assigns blocking/advisory tiers.

Its measured profile, stated up front: **high precision, narrow coverage**. What it reports is
almost always real (13% false positives measured); it specializes in lifecycle and state-machine
defects — stuck loading latches, missing cleanups, re-entrancy, stalls — and says nothing about
style or convention. It is an **assistant, not a merge gate**: every report closes with that
disclaimer, and nothing in this tool blocks a merge.

## Quick start

```bash
# 1. Requirements on PATH: bun, git, claude (Claude Code CLI, authenticated).
#    Optional: gh (PR mode), codegraph (code-intelligence index).
git clone <this-repo> && cd pr-hero
bun install && bun link          # `pr-hero` becomes a global command

# 2. Configure the repo you want reviewed
cd /path/to/your-repo
pr-hero init                     # scaffolds .prhero/config.json + .prhero/gotchas.md

# 3. Edit the two files .prhero/ now contains (see Configuration below)

# 4. Always preview first — $0, spawns nothing
pr-hero review --dry-run

# 5. Review
pr-hero review                   # your checked-out branch vs the merge base
pr-hero review --pr              # the current branch's PR, in an isolated worktree
pr-hero review --pr 123          # any PR by number
```

Every paid run prints a plan and a cost band, then asks for confirmation (`--yes` skips the prompt).

## Configuration — `.prhero/`

`pr-hero init` creates both files and never overwrites existing ones. Commit `.prhero/` or add it to
`.gitignore` — an untracked one trips local mode's clean-tree gate.

### `config.json`

| Key | Required | What it does |
| --- | --- | --- |
| `agents_dir` | yes* | Directory holding the agent prompt files (`deep-review-*.md`, `review-*.md`). Relative paths resolve against the config file. |
| `default_base` | no | Base ref when `--base` is not given (e.g. `"dev"`). Without it: the remote head (`origin/HEAD`), then `main`. |
| `parity_trigger_paths` | no | Glob list. The parity hunter runs only when a changed path matches one — no globs, no parity hunter. |
| `suspicion_priors` | no | `[{path, weight, reason}]` hints injected into hunter prompts — point them at your known hotspots. |

\* `agents_dir` can also come from the `--agents` flag or the `PRHERO_AGENTS_DIR` env var; the flag
wins, then the config, then the env.

### `gotchas.md`

Repo-specific traps the hunters must know (fragile invariants, deliberate oddities, past incidents).
**Required and must be non-empty** — the engine refuses to review a repo it knows nothing about.
Reviewing a tree you cannot write to? Supply it from outside with `--gotchas <file>` (and
`--config <file>`).

## Commands

| Command | What it does |
| --- | --- |
| `pr-hero review` | Review the checked-out branch against the merge base with `--base`. Requires a clean tree sitting on `--head` (default `HEAD`). |
| `pr-hero review --pr [n]` | Review a GitHub PR: by number, or — bare, no number — the PR that belongs to the current branch (errors loudly if it has none). Resolves the range through `gh`, runs in a detached worktree with its own codegraph index, then compares the result against Greptile's comment on that PR. |
| `pr-hero review --pr <n> --post` | Same, then publish the report as **one** marked PR comment — re-runs update it in place, never stack. |
| `pr-hero post --pr <n> --from <run-dir>` | Replay-publish a previous run's findings onto the PR (same plan as `--pr --post`). `--dry-run` previews at $0. |
| `pr-hero triage --pr <n> --from <run-dir>` | Read reply threads and bind triage markers onto that run's `comparison.json` ledger rows. |
| `pr-hero triage reply --pr <n> --from <run-dir> --finding F00N --tag <tag> --body-file <path>` | Post one triage reply. The driver picks the parent from the posted `<!-- pr-hero-finding` marker (never path/line), renders the marker + badge, posts, and resolves the inline review thread. `--body-file` is reasoning only. |
| `pr-hero init` | Scaffold `.prhero/` in the current repo. |
| `pr-hero watch add` | Opt the current repo (or `--repo <path>`) into the watcher; `--post` makes its reviews publish to the PR. Idempotent — re-adding updates the post flag. See [Watching PRs automatically](#watching-prs-automatically--pr-hero-watch). |
| `pr-hero watch remove` | Take the current repo (or `--repo <path>`) back out. Idempotent — removing what is not listed just says so. |
| `pr-hero watch status` | Read-only, $0: config summary, today's launches vs the cap, launchd state, lock, last activity. |
| `pr-hero watch --once` | Run ONE watcher tick: scan the watched repos, pick the next unreviewed open PR, review it. `--dry-run` shows the whole decision for $0. |
| `pr-hero watch install` | Install the macOS launchd agent that runs a tick every `--interval` minutes (default 15). **This is the opt-in to automatic spend.** |
| `pr-hero watch uninstall` | Unload and remove that agent. |

Flags worth knowing: `--dry-run` (plan + cost band, creates nothing), `--yes`, `--model <m>`,
`--out <dir>` (run dir for `review`, output file for `ledger`), `--runs <dir>` (ledger's runs root).
`pr-hero --help` lists everything.

### PR mode, in one paragraph

`--pr` resolves the range from the PR itself: a merged PR diffs from its merge commit's first parent
(the base as it was when the PR landed — merge, squash and rebase all converge at the fork point),
an open one from the recorded base tip. The review runs in a worktree at
`~/.prhero/repos/<origin>/worktrees/pr-<n>` — your checkout, your index and your uncommitted work are
never touched, and reviews run while you keep working. Two checkouts of the same GitHub repo share
one worktree. Worktrees are kept and reused across re-runs; each run prints the cleanup command (`git worktree remove --force …` — never `rm -rf`, a live
codegraph daemon holds a socket in there).

## When to run it

Reviews launch two ways: **by hand**, or through the opt-in local watcher (`pr-hero watch`, below)
— nothing else ever fires on its own. The two moments where a manual run makes sense:

1. **Before opening the PR** — `pr-hero review` on your branch. The cheapest moment to catch
   something: you are still in context and nothing is published yet.
2. **On an existing PR** — the moment it opens, standing on its branch, the whole command is:

   ```bash
   pr-hero review --pr --post
   ```

   Bare `--pr` resolves the branch's own PR (loud error if there is none), the review runs in its
   worktree while you keep working, and `--post` publishes the one marked comment. A PR number works
   anywhere (`--pr <n>`), no matter what you have checked out. Launch timing is forgiving: the
   Greptile comparison happens at the END of the run, and if it still ran too early it can be redone
   later for $0 without paying a new review:
   `bun run scripts/compare-pr.ts --pr <n> --findings <run-dir>/findings.json`.

### Automation and CI — status

| Stage | Status |
| --- | --- |
| Manual CLI (`review`, `--pr`, `--post`, `ledger`) | **Available now** — this README. |
| Auto-trigger on new PRs / new pushes (local watcher) | **Available now** — `pr-hero watch`, below. Deliberately opt-in: every review spends real money, so nothing fires until you `watch add` a repo AND `watch install` the agent. |
| CI mode (GitHub Actions) | Roadmap (Phase E). Needs Claude auth in the runner and a per-PR budget decision. |
| Required status check that blocks merges | **Deliberately deferred.** At the engine's measured recall it has no business gating a merge — the disclaimer in every report is the contract. |

## Watching PRs automatically — `pr-hero watch`

The watcher is a **tick, not a daemon**: `pr-hero watch --once` makes one pass — list open PRs in
each configured repo, skip what is already covered, launch **at most one** review — and exits.
launchd (installed below) fires a tick every N minutes and is the supervisor. Drafts are skipped,
and each PR is reviewed **once** by default — see the `on_push` knob below.

### Opt in

```bash
cd /path/to/your-repo
pr-hero init             # once per repo, if .prhero/ does not exist yet
pr-hero watch add --post # opt THIS repo in; --post publishes each review to its PR
pr-hero watch install    # start ticking — this is the moment automatic spending starts
pr-hero watch status     # anytime: config, cap usage, launchd, lock, last activity
```

A repo is watched **only** if added (`--repo <path>` works from anywhere; `watch remove` takes it
back out; both are idempotent). Preview any tick for $0 first: `pr-hero watch --once --dry-run`
prints every candidate, every skip and its reason (draft / reviewed-local / reviewed-remote /
attempts / cap / window), and the one (pr, head) a real tick would launch. `install` accepts
`--interval <min>` (default 15) and captures your current `PATH` (launchd's own PATH knows nothing
of `bun`, `gh`, `claude` or `codegraph`) — re-run `install` after moving tools around;
`watch uninstall` stops the schedule.

### The underlying file — `~/.prhero/watch.json`

`watch add`/`watch remove` own the repo list — there is no need to edit the file by hand for
membership, and their rewrites preserve any keys they do not know. The two global knobs are still
plain JSON you may tune directly:

```json
{
  "repos": [{ "path": "~/Desktop/your-repo", "post": true }],
  "daily_cap": 5,
  "window": { "start": "09:00", "end": "19:00" }
}
```

| Key | Default | What it does |
| --- | --- | --- |
| `repos[].path` | — | Operator checkout of a repo to watch (its `.prhero/` config and gotchas are used, exactly like `review --pr`). Managed by `watch add`/`remove`. |
| `repos[].post` | `false` | Pass `--post` to the spawned review — publish each result as the PR's one marked comment. Managed by `watch add [--post]`. |
| `repos[].on_push` | `false` | Re-review the repo's PRs on every new push. Default: one review per PR — see below. Managed by `watch add [--on-push]`. |
| `daily_cap` | `5` | Global max reviews launched per local calendar day, across all repos. `0` pauses launching entirely. |
| `window` | `null` (always) | Local-time window outside which ticks do nothing, e.g. `{"start":"09:00","end":"19:00"}`. Overnight windows (`start` > `end`) work. |

### One review per PR — the `on_push` knob

By default a push to an already-reviewed PR does **not** re-trigger a review: an active PR takes
many pushes, and re-billing $2–5 for each would drain the cap on one PR's churn. The posted
comment names the exact sha it reviewed, so it never lies about coverage — a reader sees at a
glance that later pushes are unreviewed. When the new head deserves a fresh pass, run it by hand
(`pr-hero review --pr <n> --post`); `pr-hero watch add --on-push` restores per-push re-review for
a repo that wants it. Planned follow-up: a cheap independent judge that reacts to pushes by
checking whether the new head addressed the posted findings and replies in-thread, instead of
re-reviewing from scratch.

### What keeps the bill bounded

- **The cap and the window** exist because the watcher and your interactive Claude sessions share
  the same subscription quota — a runaway watcher would starve the work you are actually doing.
  The cap is counted from `~/.prhero/watch.log` (the `launched` lines ARE the counter), and a
  launch is logged *before* it starts, so even a crashed review counts.
- **Max 2 attempts per (pr, head)**: a PR that keeps killing the review is dropped until it gets
  a new push, instead of eating the cap every day.
- **Cross-machine guard**: a posted pr-hero comment declares which head it reviewed; any watcher
  that sees the current head already declared skips the PR (and under the one-review-per-PR
  default, any pr-hero comment at all is proof enough).

### Operating model and honest limits

Run **one watcher per repo per team**. The cross-machine guard only protects repos with
`post: true`, and only after the first comment lands — two watchers racing the same fresh PR is a
known gap (tech debt, accepted): the worst case is one duplicated review, and with `post: true`
the PR still converges to a single comment. Not macOS? `watch --once` from cron works the same —
the PID lockfile keeps overlapping ticks from doubling up. Logs: structured events in
`~/.prhero/watch.log`, raw tick/review output in `~/.prhero/launchd.log`.

## What a run produces

Run artifacts land **outside** the repo, in `~/.prhero/repos/<origin>/runs/<run>/`:

| File | What it is |
| --- | --- |
| `report.md` | The human-readable review. |
| `findings.json` | The machine artifact (schema v1.0.0): findings, tiers, refuter verdicts, usage, provenance. |
| `comparison.md` / `comparison.json` | PR mode only — the head-to-head against Greptile, three buckets. The JSON rows carry `verdict`/`reasoning` columns for triage; `pr-hero ledger` accumulates them. |
| `diff.patch`, `pipeline.json`, `steps/` | The exact diff reviewed — after exclusions, so it is byte-for-byte what the hunters read — plus pipeline provenance (including the excluded paths), per-agent drafts and logs. |
| `diff.raw.patch` | The unfiltered diff of the same range. Written **only** when exclusions actually dropped a file, since otherwise it would duplicate `diff.patch`. |

## Cost and expectations

- **$2–5 per review** of a typical PR-sized diff — the floor is real, because hunters read the tree,
  not just the diff — and larger trees cost more (a 45-file tree measured $11–15). Wall time is
  minutes, not seconds: ~10 for a small diff, up to ~25 measured on a large tree. The printed band
  is an order-of-magnitude guide, not a quote — the same tree has billed 34% apart across runs.
### The size gate — a cost gate, not a quality gate

Past a size threshold pr-hero **skips the review** instead of running it. Small trees bill $1.9–$4.8;
the 45-file / +2775 −1237 bench tree billed $6.58–$17.92 across 18 iterations — the cost roughly
triples *and* its spread widens to ~2.7x. The gate exists because that bill is unpredictable, and
because an unattended watcher must not be the thing that discovers it.

**It is not a claim about quality.** We have no evidence that a bigger diff reviews worse: attention
dilution was tested and falsified (`fixtures/scale-probe.ts`), and the one measured Greptile-only
miss came from a 7-file PR. If a large diff is worth its price, `--force` reviews it.

The gate counts **effective** changed lines (insertions + deletions) and files — generated content is
excluded first, so a regenerated lockfile beside a ten-line change does not trip it. Excluded by
default: `bun.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`,
`*.min.js`, `*.min.css`, `*.snap`.

Those exclusions come out of the **reviewed diff itself**: `diff.patch` is what the hunters are
handed, so the number the gate measures is the number that gets paid for. If every changed file is
excluded, there is nothing to review — pr-hero exits without spawning anything.

The count is also **whitespace-blind wherever git is reachable** (local mode and PR mode count from
`git diff -w --ignore-blank-lines --numstat`), so a formatter or linter sweep does not consume the
budget. Two paths cannot be: `--pr <n> --dry-run` and the watcher's per-tick checks read GitHub's own
counters, which carry no whitespace information — both label their verdict an estimate, and both can
only ever over-count, never under-count.

| Profile | Lines | Files | For |
| --- | --- | --- | --- |
| Conservative | `--max-changed-lines 800` | `--max-changed-files 150` | Tight budget; only small PRs auto-review. |
| **Default (shipped)** | **1500** | **150** | Everyday PRs pass; bench-sized trees are skipped. |
| Permissive | `--max-changed-lines 3000` | `--max-changed-files 150` | You would rather pay than skip. |

```bash
pr-hero review --pr 42 --dry-run          # prints the gate verdict, spends nothing
pr-hero review --pr 42 --force            # review it anyway (does NOT skip the cost prompt)
pr-hero review --pr 42 --max-changed-lines 0   # 0 disables that limit entirely
pr-hero watch add --max-changed-lines 800       # per-repo threshold for the watcher
```

A skipped review exits 1 with a one-line reason and no stack. In watch mode it logs
`skipped … reason=too-large` (or `reason=nothing-to-review`, when every changed file is excluded
generated content) and costs nothing further: it does **not** consume a poison-PR attempt,
writes no review marker, and does not arm the one-review-per-PR state — a force-push that shrinks the
PR makes it eligible again on the next tick, because the gate is recomputed every tick.

- Findings vary run to run on the same tree. That is the nature of the instrument: treat single
  runs as evidence, not verdicts, and triage before acting.
- Verify what it reports. Findings are claims with cited code, tiered by deterministic rules — the
  report says so itself: *assistant report, not a merge gate; every line is a claim to verify.*

## Isolation model

Spawned agents run with a read-only tool surface (Read/Grep/Glob plus the codegraph MCP server and
nothing else): no Write, no Bash, no network tools, `--strict-mcp-config`, no user settings. The
driver owns every file write and all `gh`/`git` I/O. In PR mode the reviewed tree is a detached
worktree containing only tracked bytes at the PR's head — agents never see your working copy.

## Development

```bash
bun test               # offline test suite — no network, no spawns, fake runners
bun run typecheck      # tsc --noEmit, strict
bun run check          # biome over src + test
```

The architecture in one line each lives in `CLAUDE.md`; the project's history, measurements and
phase plan live in `ROADMAP.md`. The short version: the flow is data (`ReviewSpec`), agents are
prompt files, orchestration is testable TypeScript — models judge, code governs.
