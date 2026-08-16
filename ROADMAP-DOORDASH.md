# pr-hero — the DoorDash track (roadmap 2: what runs before item 7)

Created 2026-08-16 by Juanma's decision: **absorb every DoorDash-derived change first, then splice back
into `ROADMAP.md` at Phase B item 7 (re-review).** This file is the SEQUENCE. The evidence and reasoning
per row live in `docs/doordash-audit.md`, the two archived posts beside it, and the issues; this file does
not restate them. When this track's splice conditions hold, `ROADMAP.md` item 7 resumes and this file is
history.

Everything in `ROADMAP.md`'s standing rules applies here unchanged: design before code, one variable per
experiment with replicates, prompt sets immutable once scored, offline gates before any spend, every live
run in a ledger, `--dry-run` first. Two of them are load-bearing enough for this track to repeat:

- **One variable per experiment.** The scout A/B is the track's only paid experiment. Nothing that changes
  what the engine FINDS — a prompt-set change, a #19 criteria change, a new hunter — may land between the
  control arm and the scout arm. Reporting/infra changes (#39, #42, #40, #23 columns) do not change what
  is found and may land at any time.
- **Time is the binding constraint, not money** (THE PIVOT). Milestones are sized in sessions. Where a
  choice trades money for sessions, spend the money.

## The state this track starts from (verified 2026-08-16)

- The watcher is LIVE on musive-s3: `io.prhero.watch` + `io.prhero.gc` in launchd, `post: true`,
  `daily_cap: 5`. **12 auto-launched reviews** so far; the last on 2026-08-14. PR 1722 already had a
  push-triggered second run — item 7's problem is real but rare (1 in 12).
- **15 distinct PRs carry a `comparison.json`** in `~/Desktop/musive/musive-s3-prhero-runs/` (19 runs:
  1682, 1698, 1700, 1703, 1705, 1707, 1708, 1711, 1714, 1715, 1716, 1717, 1718, 1722, 1724). Across
  them: **11 `greptile_only` rows, 13 `both`, 28 `prhero_only`, and only 12 of ~50 rows triaged.** The
  overlap is no longer zero — that changed since THE PIVOT's first eight PRs and it is worth knowing before
  designing anything. These 15 PRs are the free control arm for the scout A/B.
- Production prompt set: `deep-review/agents/slice3b-lifecycle-v6-clean` (immutable — scored).
- `bun test`: 883 offline tests. The gate before every milestone below is that number, green.

## Milestones

### M0 — Pin the ground before moving anything (½ session, $0)

The two things every later milestone leans on, done first so nobody rediscovers them mid-build:

1. **Triage the 11 `greptile_only` rows.** Human, `$0`, through the existing `pr-hero triage` path so the
   verdict and reasoning land in `comparison.json` and the ledger, not in a chat. The question per row is
   only "real defect, or style/convention/out of scope?" — because the scout-probe (M4) plants targets,
   and a target must be a real miss. Today we do not know which of the 11 are.
2. **Freeze the control set.** Write the 15 PR numbers, their run dirs and their bucket counts into
   `docs/scout-design.md` (created empty here, filled in M3). Those run dirs must survive until M6 — no
   runs TTL exists yet (#35 parked), so this is a note, not a mechanism; make it a loud one.

Exit: every `greptile_only` row has a verdict; the control set is written down.

### M1 — Public honesty: the tool is in production and must not lie (1 session)

Reporting-side defects, offline-testable, no experiment, no prompt touched. In this order — smallest
first, each its own commit/PR:

- **#42** — a `partial` run with zero findings must never print the ✅ line. Decision Juanma owns, with the
  recommendation recorded: post, stating the incompleteness and naming the hunters that did not run —
  visible noise beats invisible loss (the project's own direction-of-error rule). Same treatment on the
  terminal (`ui-result.ts`).
- **#39** — pin `commit_id: headSha` on the review POST. With the pin, GitHub anchors comments to the
  reviewed commit and marks them outdated itself when the lines move; the reconciliation POLICY collapses
  to one line in the summary ("reviewed `X`; head is now `Y`"). Recheck head before posting; loud on
  mismatch, never silent. The 422 recovery must keep working unchanged.
- **#40** — soft timeout, if the session has room; otherwise it rides M5, where the scout adds a stage and
  the soft-interrupt semantics per stage ("return verified findings only" / "return leads so far") are
  designed together. Not blocking.

Exit: tests pin both behaviours; the next auto-launched review on musive is checked by hand against them.
The watcher stays live throughout — it is producing the control arm's data.

### M2 — #19's shape, decided by the corpus not by taste (½ session, $0)

The postability rule (anchored file+line, concrete behaviour at risk, where to start; no action point →
not posted) is the cheapest lever the first post offers, and it is orthogonal to severity. Before building
anything: over the ~30 CRITICAL findings already on disk, count how many carry an action point and how
many are a well-argued concern with nowhere to start. That number decides:

- **Mostly missing an action point** → #19 is a *postability gate* in the renderer/tiering layer: engine
  code, offline tests, no prompt change. Build it in this milestone; it does not change what is FOUND, so
  it may land before the A/B.
- **Mostly present** → the "wall of 🔴" is genuinely a severity problem → #19 is a *criteria change*, i.e.
  a NEW prompt set plus `refuter-probe`. **Park it behind M6.** It would be a second variable inside the
  scout experiment.

Exit: the number is in #19; the shape is decided; if gate-shaped, it is built and merged.

### M3 — The scout, designed (1 session, $0) — `docs/scout-design.md`

Rule 1 in full: nothing spawns until this document answers ROADMAP C7's four open questions with the
real code in view. The design must settle, at minimum:

1. **Leads REPLACE or BIAS the hunters' own scan?** Recommendation to argue against: bias — leads are
   injected as a "look here first" block, the hunter still owns its recall. Replacing makes one stage a
   single point of failure for recall, the fragility the fan-out exists to avoid.
2. **What stops the scout from becoming DoorDash's v2** (one agent verifying everything)? Their answer is
   absolute: it verifies nothing. Lean to argue for: **diff-only, no repo access, no MCP** — it reads the
   patch and emits leads. That is cheaper, faster, and removes the isolation question entirely. If the
   design finds the scout needs codegraph to notice cross-file drift, say why and what it costs.
3. **Direction of error.** A missed lead is invisible; a spurious lead costs a hunter some attention.
   Recall-first scout, precision-first hunters and refuter unchanged — and "scouts improve breadth when the
   reviewer can verify aggressively" (DashBench) says that pairing is the safe one.
4. **Where the scout prompt lives** — a new agent file in a NEW prompt-set directory whose hunter files are
   byte-identical to `slice3b-lifecycle-v6-clean`, or engine-owned text like `HUNTER_OUTPUT_CONTRACT`
   (covered by engine version, not the set fingerprint). Either way the hunters do not change by one byte:
   that is what makes M6 a one-variable experiment.
5. **How leads reach hunters** — the `{{PRIORS}}` slot already renders per spawn; per-run dynamic leads
   beside static `suspicion_priors` is a templating detail, but a stated one, with a size ceiling.
6. **The scout-probe protocol (M4)** and **the A/B protocol (M6)**: which PRs, how many replicates, what
   "moved" means, in numbers, before any run. Cost forecast per arm.
7. **Provenance:** `pipeline.json` records the scout stage, its model, its cost, and the leads it emitted,
   so a finding can be traced to "led" or "found unled". Without that, M6 cannot attribute anything.

Juanma ratifies the design at the end of the session. Nothing in M4–M6 starts before that.

### M4 — The scout-probe: the prompt earns its A/B (1 session, ~$5–15)

`refuter-probe` is the pattern (CLAUDE.md: "a prompt edit that cannot pass it does not deserve a $10
replay"). `scripts/scout-probe.ts`, same discipline, two assertions:

- **Coverage:** on the diffs of the PRs whose `greptile_only` rows M0 triaged as REAL, at least one lead
  lands on the missed site (path + a line window — `compare.ts` precedent, ±25).
- **Restraint:** on the control set's clean PRs (`both` = 0, `greptile_only` = 0, triaged as clean), the
  lead count stays under a ceiling set in M3. A scout that is loud on clean code is DashBench's named
  failure mode.

Diff-only spawns are cheap enough (~$0.30) to iterate the prompt here, N times, in one session. This is
where the prompt gets written and rewritten. Exit: the probe passes at the thresholds M3 set, three
replicates each; results in the commit description.

### M5 — The scout wired, behind a flag, default OFF (1–2 sessions)

- `--scout` on `review` (and `.prhero/config.json` later; not on the watcher until M6 decides).
- The stage runs first, its leads render into the hunter prompts per M3, `pipeline.json` carries the
  provenance per M3 item 7, telemetry carries the stage's cost per agent (feeds #23).
- `#40` lands here if it did not in M1: the soft interrupt now has two stage semantics.
- Offline gates green; `fixture-eval` passes with the flag on and off (the planted bug still found, cost
  band still honest); one `live-micro-eval` with the flag on.

Exit: the flag exists, defaults off, is fully tested, and the watcher does not know it exists.

### M6 — The A/B on the control set (1 session of build-free work; ~$150–250; wall clock is the cost)

The only paid experiment in this track. Protocol fixed in M3; the shape it must have:

- **Both arms, same day, same engine build, same prompt set except the scout** — re-run the control arm
  too rather than reusing the on-disk baselines as the only control, because engine and models have moved
  since those ran. The on-disk baselines are the third point: they tell us how much run-to-run variance
  alone moves the buckets.
- **N PRs × R replicates × 2 arms.** N = every PR with a triaged-real `greptile_only` row plus an equal
  number of clean ones (from M0); R ≥ 2 (DashBench: a single run understates coverage — and rule 7). At
  ~$4/run plus the scout stage, N=8, R=2 is 32 runs, ~$150–200. Serial through the CLI at ~4 min/run is
  the actual constraint: budget the wall clock, not the dollars.
- **What "moved" means, in the buckets:** the scout arm should shrink `greptile_only` (found what Greptile
  found and we missed), grow `both`/`prhero_only`, and hold precision — measured as the refuter's
  refuted/downgraded rate and the triage's dismissed rate on the new findings, not as raw volume (C1's
  lesson: report distinct root causes, never counts). Latency and cost per arm recorded beside them.
- **Then decide — Juanma's call, three outcomes:** adopt (flag becomes default, watcher included), keep
  as opt-in flag (positive but not worth the cost/latency on every PR), or drop (record why in this file
  and in C7). Whatever the outcome, C10's honesty applies to the read: the buckets cannot see what both
  arms missed.

Exit: the decision, the numbers, and the ledger entry.

### M7 — Fill-ins that ride the track (no session of their own)

Land these when the code they touch is open; none blocks the splice, all should be done before item 7
starts consuming them:

- **#23 columns** — `trigger` (watch | manual), retry reason breakdown into `run_agents`, model per
  agent, PR-opened → posted latency, cost per real finding. All additive.
- **#41** — reverted/hotfixed PR mining, `gh` only, $0. Output goes beside the control set: it is the
  first corpus the head-to-head cannot produce.
- **C8's curation filter** over musive's existing `.prhero/gotchas.md` and priors, $0: *CI would catch it →
  drop; the model already knows it → drop; no file:line evidence → drop*. Do it AFTER M6, not before — it
  changes what hunters read.

## The splice — resuming `ROADMAP.md` at item 7

Item 7 resumes when ALL of these hold; none is negotiable, none is large:

1. **M1 merged and seen live** (#42, #39): item 7's re-review posts through the same surface, and it
   inherits the pin.
2. **M2 decided** (#19's shape) — and if criteria-shaped, still parked; item 7 does not depend on it.
3. **M6 decided**: item 7's *discovery* half runs "over what changed since the last review" — if the
   scout is adopted, that delta review has a scout stage too, and item 7 must be designed for the pipeline
   we actually have. This is the reason the scout comes before item 7 and not after.
4. **M0's control set and M6's numbers are in the ledger**, so item 7's own live runs are read against a
   known baseline.

What item 7 receives from this track, already written into its `ROADMAP.md` entry: the three amendments
(collapse-old-comments as an acceptance criterion; the pin/policy split; the variance update that narrows
verify-vs-infer to "verify" vs "state the delta as unconfirmed"), and the one decision it still needs from
Juanma at design time — whether `applied` pays a verification step per finding.

After the splice, `ROADMAP.md` continues in its own order: item 7, item 8's remainder, then Phase C in
its listed sequence — C7 is then either done (adopted) or closed (dropped) by M6, and C8/C9/C10 remain
Phase C work with their own designs.

## Estimate, stated so it can be wrong in the open

| Milestone | Sessions | Money | Juanma decides |
|---|---|---|---|
| M0 pin the ground | ½ | $0 | verdicts on 11 rows |
| M1 public honesty | 1 | $0 | post-or-not on partial+zero |
| M2 #19's shape | ½ | $0 | — (the number decides) |
| M3 scout design | 1 | $0 | ratify the design |
| M4 scout-probe | 1 | ~$5–15 | thresholds (in M3) |
| M5 scout behind flag | 1–2 | ~$0.10 | — |
| M6 the A/B | 1 (+ wall clock) | ~$150–250 | adopt / opt-in / drop |
| M7 fill-ins | ride along | $0 | — |
| **Total** | **~6–7 sessions** | **~$200–300** | |

Then item 7. If M6 says drop, the track still delivered M1, M2, #40, #23's columns, #41 and the first
real corpus — the pivot's principles land either way; only the flagship mechanism would not.
