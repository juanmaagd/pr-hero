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
pr-hero review --pr 123          # any PR by number, in an isolated worktree
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
| `pr-hero ledger` | Accumulate every run's `comparison.json` into one markdown ledger — the head-to-head buckets as a rate. One PR, one vote (only its latest run counts). |
| `pr-hero init` | Scaffold `.prhero/` in the current repo. |

Flags worth knowing: `--dry-run` (plan + cost band, creates nothing), `--yes`, `--model <m>`,
`--out <dir>` (run dir for `review`, output file for `ledger`), `--runs <dir>` (ledger's runs root).
`pr-hero --help` lists everything.

### PR mode, in one paragraph

`--pr` resolves the range from the PR itself: a merged PR diffs from its merge commit's first parent
(the base as it was when the PR landed — merge, squash and rebase all converge at the fork point),
an open one from the recorded base tip. The review runs in a worktree at
`<repo-parent>/<repo>-worktrees/pr-<n>` — your checkout, your index and your uncommitted work are
never touched, and reviews run while you keep working. Worktrees are kept and reused across re-runs;
each run prints the cleanup command (`git worktree remove --force …` — never `rm -rf`, a live
codegraph daemon holds a socket in there).

## When to run it

Today every review is launched **by hand** — nothing fires on its own. The two moments that make
sense:

1. **Before opening the PR** — `pr-hero review` on your branch. The cheapest moment to catch
   something: you are still in context and nothing is published yet.
2. **On an existing PR** — `pr-hero review --pr <n>`, whenever you want a second reviewer's pass;
   typically after Greptile has commented, so the head-to-head has both sides. Ran it too early?
   The comparison can be redone later for $0 without paying a new review:
   `bun run scripts/compare-pr.ts --pr <n> --findings <run-dir>/findings.json`.

### Automation and CI — status

| Stage | Status |
| --- | --- |
| Manual CLI (`review`, `--pr`, `--post`, `ledger`) | **Available now** — this README. |
| Auto-trigger on PR creation (local watcher / hook) | Roadmap (Phase B3). Deliberately opt-in: every review spends real money, so nothing will ever fire without an explicit subscription to that spend. |
| CI mode (GitHub Actions) | Roadmap (Phase E). Needs Claude auth in the runner and a per-PR budget decision. |
| Required status check that blocks merges | **Deliberately deferred.** At the engine's measured recall it has no business gating a merge — the disclaimer in every report is the contract. |

## What a run produces

Run artifacts land **outside** the repo, in `<repo-parent>/<repo>-prhero-runs/<run>/`:

| File | What it is |
| --- | --- |
| `report.md` | The human-readable review. |
| `findings.json` | The machine artifact (schema v1.0.0): findings, tiers, refuter verdicts, usage, provenance. |
| `comparison.md` / `comparison.json` | PR mode only — the head-to-head against Greptile, three buckets. The JSON rows carry `verdict`/`reasoning` columns for triage; `pr-hero ledger` accumulates them. |
| `diff.patch`, `pipeline.json`, `steps/` | The exact diff reviewed, pipeline provenance, per-agent drafts and logs. |

## Cost and expectations

- **$1–5 per review** of a typical PR-sized diff; wall time is minutes, not seconds — ~10 for a
  small diff, up to ~25 measured on a large tree. The printed band is an order-of-magnitude guide,
  not a quote — the same tree has billed 34% apart across runs.
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
