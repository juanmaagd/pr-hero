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

## The state this track starts from

> **Corrected 2026-08-16 by M0.** The figures first written here were taken from `musive-s3` alone and
> were wrong on every count they stated. What follows is what M0 verified against disk. The full frozen
> control set — every run dir, both bucket views, the variance pairs — lives in `docs/scout-design.md` §1
> and that file, not this one, is the reference M6 reads against.

- The watcher is LIVE on musive-s3: `io.prhero.watch` + `io.prhero.gc` in launchd, `post: true`,
  `daily_cap: 5`. **12 auto-launched reviews** so far; the last on 2026-08-14. PR 1722 already had a
  push-triggered second run — item 7's problem is real but rare (1 in 12).
- The corpus is **three runs roots, not one**: `musive-s1-prhero-runs` (3 runs), `musive-s2-prhero-runs`
  (8 runs) and `musive-s3-prhero-runs` (19 runs) — **30 complete runs over 19 distinct PRs**, all on
  `model: sonnet`. s1 and s2 carry PRs 1710, 1719, 1720 and 1721 that appear nowhere in s3. Summed
  buckets: **18 `greptile_only`, 17 `both`, 39 `prhero_only`** over 74 rows (the earlier 11/13/28 was
  neither the summed nor the one-vote-per-PR view of any root).
- **Every `greptile_only` row is now adjudicated (18 of 18)** — and only **5 are real misses**
  (`true-positive`); 10 are `out-of-scope`, 2 `latent`, 1 `false-positive`. See M0 below.
- **Eight PRs were reviewed twice at the same head with the same configuration, and six moved their
  buckets.** That is M6's variance control, already paid for, and it says `R ≥ 2` replicates is very
  likely too few. Numbers in `docs/scout-design.md` §1.3.
- Production prompt set: `deep-review/agents/slice3b-lifecycle-v6-clean` (immutable — scored).
- `bun test`: 1026 offline tests, of which 1 fails before this track touched anything
  (`test/panel-renderer.test.ts`, ANSI bytes in a styles assertion). The gate before every milestone
  below is that count, with no NEW failure.

## Amendment 2026-08-16 — Greptile stops being the score

Juanma's call, taken on M0's evidence: **stop measuring this engine against Greptile.** The head-to-head
fails as an instrument on three independent counts, all three measured above — 61% of the `greptile_only`
bucket is not a defect, the buckets move on replay alone in 6 of 8 same-head pairs, and they are
structurally blind to what both reviewers missed (C10's note, now the method's ceiling rather than a
footnote).

What this changes, and what it does not:

- **Greptile dies as the SCORE, not as a SOURCE.** The watcher stays live, `comparison.json` keeps being
  produced for free, and it keeps surfacing real defects — 5 of them here, one a data-loss regression in
  PR 1722. It becomes one input among several instead of the marker.
- **M6's success criterion as written below is dead.** "The scout arm should shrink `greptile_only`, grow
  `both`/`prhero_only`" would reward a scout that learned to imitate a house style. M6 must score the
  adjudicated `true-positive` subset. The replacement metric is not chosen yet.
- **#41 is promoted out of M7 and runs BEFORE M3**, because M3's design says "the scout is scored against
  X" and M4's probe thresholds come from that X. Designing the instrument before knowing what it measures
  is the wrong order.
- **M0 and M4 survive untouched.** The 5 `true-positive` rows are adjudicated defects with `file:line`
  evidence; they remain valid probe targets whether or not Greptile exists tomorrow. The control set
  remains the control arm — what changes is what it is read against.

## Milestones

### M0 — Pin the ground before moving anything — **DONE 2026-08-16**

The two things every later milestone leans on, done first so nobody rediscovers them mid-build:

1. **Triage the `greptile_only` rows.** Done: **18 of 18** adjudicated (16 written, 2 pre-existing),
   covering 16 distinct findings. Each judged by an isolated agent reading musive at that exact head,
   never from the claim's prose, with `file:line` evidence in the row's own `reasoning`. Result: 5
   `true-positive`, 10 `out-of-scope`, 2 `latent`, 1 `false-positive`.
   **The path had to change:** `pr-hero triage` cannot reach these rows — `applyTriageReplies` binds only
   rows with a non-null `prhero` side (`src/triage-write.ts:78-83`) and resolves the parent from a posted
   `<!-- pr-hero-finding` marker, and a `greptile_only` row has neither. The verdicts are direct writes to
   `comparison.json`, which is how PRs 1700 and 1705 were already triaged. A `pr-hero triage row` write
   path is a candidate M7 fill-in, not a blocker.
2. **Freeze the control set.** Done in `docs/scout-design.md` §1 — 30 runs, 19 PRs, three roots, both
   bucket views, the eight same-head variance pairs, and the loud survive-until-M6 warning. Verified while
   writing it: `pr-hero gc` collects worktrees only and never touches a runs root, so nothing deletes
   these — and nothing protects them either. They are not under version control.

Two defects in our own tooling surfaced and are recorded (not fixed) in `docs/scout-design.md` §2.6:
writing a `comparison.json` bumps its mtime and can flip the ledger's latest-run pick for artifacts that
predate `generated_at` (observed live, mtimes restored); and `pipeline.json` records no engine version or
prompt-set identity, so **M3 item 7 has to build the provenance record rather than extend one.**

Exit met: every `greptile_only` row has a verdict; the control set is written down.

### M1 — Public honesty: the tool is in production and must not lie — **#42 and #39 DONE 2026-08-16**

Both merged. `#42`: a `partial` run no longer prints the ✅ — it states the incompleteness above the
counts and names which agents completed and which did not, on the comment and the terminal alike. It
posts, per the direction-of-error argument below, now written at the branch point itself. One thing the
issue asked for that the code could not honestly give: `telemetry.per_agent` records no role, so the
notice names AGENTS, not hunters — filtering the refuter out by name would print "all hunters completed"
on a run that went partial precisely because the refuter died.
`#39`: the review submission carries `commit_id: headSha`, the head is re-read before the anchoring call,
and a moved head is loud on both surfaces. The 422 recovery is unchanged and better pinned.

**`#40` is now orphaned** — it was to ride M5, and M5 is parked (see the scout-parked note below). It
remains open and unblocking; pick it up on its own merits, not as part of a milestone.

The original entry, kept for its reasoning:

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

### M2 — #19's shape, decided by the corpus not by taste — **DONE 2026-08-16**

Measured, not argued. Population: every 🔴 finding on disk (`severity` CRITICAL or BLOCKER) — 36 in musive
(reproducing #19's own table exactly) plus 17 from pr-hero's self-reviews, judged as a separate batch.
Three independent judges, identical rubric, over the finding TEXT and never the repository, because
postability is a property of how a claim is written.

**53 of 53 postable. Zero concern-only. Zero borderline.** All 53 carry populated `path`, `line`, `symbol`
and `proof_refs`. A 100% rate is a leniency smell, so the three shortest claims — the likeliest
counter-examples — were re-judged by hand and all three held.

The rate is 100% because postability is not an accident: the hunter output contract already requires
`proof_refs` and a traced mechanism, so anything reaching the artifact has been forced to name a site and
a consequence. **The DoorDash postability rule was never the lever on this engine — it is satisfied by
construction.**

So by M2's own rule, **#19 is criteria-shaped, and a postability gate would filter 0 of 53 — dead code.**
It stays parked with M3–M6.

A second number closes off the display option: over musive's 36 🔴 findings the refuter returned 35
`corroborated` and 1 `downgraded-latent`, so the resulting tier is 35 blocking / 1 advisory. `ef41f3a`
(post `tier` as the scan aid) is correct and stays, but it can only ever soften **1 of 36**. The wall is
not noise, not a refuter failure and not a display failure — every finding in it is anchored, actionable
and corroborated. The scale collapsed to one usable value because the rubric makes CRITICAL the only
honest label for a traced user-visible defect, which is what #19 section 1 argued from the prompt text and
this measures. Full write-up in the issue.

The original entry, kept for its reasoning:

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

### M3–M6 — parked and UNPARKED the same day, 2026-08-16

**Unparked.** The park was a mistake in routing, not in reasoning, and the reasoning below is kept because
every number in it still holds. The error: the measurement problem was treated as a blocker sitting
OUTSIDE the roadmap, when M3 item 6 already owns it by name — *"the A/B protocol (M6): which PRs, how many
replicates, what 'moved' means, in numbers, before any run."* Parking M3 to go solve M3's own deliverable
first is a loop, and worse, it deadlocked the main roadmap: `ROADMAP.md` item 7 gates on M6's numbers
being in the ledger, so parking M6 blocked item 7 on an experiment we had decided never to run.

The correct route is the one that was already written: **do M3.** It costs $0, Juanma ratifies it at the
end, and nothing is spent before that. What follows is the evidence M3 must design against.

The amendment above killed the bucket metric. The obvious replacement — adjudicating each arm's new
findings — was rejected for a good reason: **it is a toll, not a metric.** Every time you want to measure
you pay again, and that is a loop with no end. A corpus is adjudicated ONCE and replayed; a per-experiment
adjudication never amortises.

Then the corpus was measured and came up short. `pr-hero reverts` over both repositories with real history
returns **3 usable cases** — musive gives 9 candidates over 4780 commits (4 body-linked, one of which
reads as a product decision) and supermarket-pro gives **zero** over its entire 1624-commit history. Three
cases is a floor the scout must clear, not a score it can be ranked by.

So the decomposition, stated so the next session does not re-derive it:

- **Precision is cheap and the corpus is already on disk.** 39 `prhero_only` + 17 `both` rows sit
  untriaged. Adjudicating them once, with the machinery M0 proved works, measures how much of what we say
  is real — and then any future engine change is scored by replay against a fixed set, with no new
  judging.
- **Recall is expensive and has no cheap source.** Greptile is 61% noise, reverts are 3, the lab's golden
  dataset is retired. There is no oracle to buy, and inventing one is the loop.

**These four facts are M3's input, not a reason to stop:** the bucket metric is dead, per-experiment
adjudication is a toll rather than a metric, the revert corpus is 3 cases and can only be a floor, and
precision has a cheap one-time corpus (56 untriaged rows) while recall has no cheap source at all.
M3 item 6 must produce a metric that survives all four. If it cannot, THAT is the finding, and it is worth
a $0 session to reach it honestly rather than assuming it from outside.

> **Superseded in one clause, 2026-08-17 by #43.** "Recall has no cheap SOURCE" was a statement about
> reverts, not about the world. `pr-hero corpus` (`19b9f00`) mines four further sources and returns **513
> candidates on musive and 19 on supermarket-pro** — the repository that reverts said had nothing.
> Everything else in this section stands: they are candidates, not cases, and each still costs one
> adjudication at M0's price. **The supply changed, the price did not.** Numbers and their caveats in
> `docs/scout-design.md` §2.4ter; the defects that first live run exposed are recorded in #44 and fix
> nothing that is claimed above.

### M3 — The scout, designed (1 session, $0) — **RATIFIED 2026-08-17**

Juanma ratified all four of §3.14's decisions as recommended, including **§3.11's fork → (a), the floor
test alone (~$144)**. M4 may begin. The ratification and its one refinement — an ambiguous floor is grown
from #43's corpus before Tier 2 is bought — are recorded in `docs/scout-design.md` §3.11 and §3.14.

The design is `docs/scout-design.md` §3.3–§3.14: all four C7 questions and items 1–5 and 7 answered,
against verified file:line code (a verification pass re-checked §3.2's claims and confirmed 10 of 10, with
two refinements now recorded there). The shape, in one line each: leads **bias**, never replace, and
DoorDash's filter half is deliberately not taken; the scout is diff-only with `tools: []` and no MCP, which
is what structurally stops it from becoming their v2; it is recall-first and **fails open** (hunters run
unled, run stays `complete`, and M6 excludes that run from the scout arm); its prompt is engine-owned at
`prompts/scout.md` beside the summarizer's, so the prompt set is untouched by construction; leads reach
hunters through the user prompt with a hard 12-lead cap and an anti-anchoring paragraph; and led-vs-unled
is **computed** at analysis time (path + ±25, `compare.ts`'s window), never self-reported, so no schema
bumps. M4's gates and M6's protocol are in numbers.

**The one open decision is §3.11's fork**, and it is money-versus-power: the effect test cannot see an
effect smaller than ~72% at $128 or ~59% at $192, so the recommendation is the **floor test alone** — 8
known defects with known sites over 7 PRs, binary per case, plus 2 clean PRs so pipeline-level restraint is
not left unmeasured (~$144). §3.14 lists the four decisions Juanma ratifies.

**What #43 changes about that fork, 2026-08-17 — the fallback, not the recommendation.** §3.11 already
carries the contingency: *"if the floor test comes out ambiguous (say 4–5 of 8 in both arms), (b) becomes
worth its money, and the corpus is still there."* #43 gives that contingency a strictly better target.
The floor test is binary per case and paired per PR, so it **extends incrementally at no methodological
cost** — each case added later is its own self-contained pair, and nothing already run is invalidated.
So when the floor is ambiguous, growing it from the widened corpus (~$16 per known-bad case at R=2, plus
adjudication at M0's measured rate of ~18 rows per half session) buys deterministic cases instead of
Tier 2's underpowered statistic, at comparable money. Three caveats travel with any such growth and must
be read before, not after: `blame-linked` is the weakest of the tiers, and its self-blame defect is **fixed
in code but not in the artifact** — `234a1ef` closed #44 and did no live re-run, so the 452/11 counts on
disk are still the buggy version's and still overstate that tier by ~1%; musive's `issue-linked` count is
0 for a structural reason (Jira, not GitHub issues); and any supermarket-pro candidate puts a **second
repository inside M6's protocol** — no on-disk baselines, unconfirmed `.prhero` setup — so v1 stays
musive-only unless Juanma decides otherwise. THE PIVOT argues against paying that half session up front:
an 8-of-8 or 1-of-8 floor result makes it unnecessary, and sessions are the scarce thing.

**M4 is untouched by #43.** Its coverage gate targets the five adjudicated misses (§3.10), and its $0
prerequisite — extract the sites of the three revert cases — stands exactly as written. A wider candidate
pool is supply for a LATER decision; it is not an input to the probe.

The original entry, kept for its reasoning:

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
- **What "moved" means — SUPERSEDED, see the amendment above.** This bullet used to read "the scout arm
  should shrink `greptile_only`, grow `both`/`prhero_only`". M0 killed it: 61% of that bucket is not a
  defect, so shrinking it rewards style imitation. The replacement metric is not chosen yet and is
  #41's + M3's job. What survives from the original bullet: precision is held, measured as the refuter's
  refuted/downgraded rate and the triage's dismissed rate on the NEW findings, never as raw volume (C1's
  lesson: report distinct root causes, never counts); latency and cost per arm recorded beside them.
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
- **#41 — PROMOTED OUT OF M7 (2026-08-16), then DONE.** It ran before M3 as the replacement measurement
  track, for the reason in the amendment above. Still `gh` + `git log` and still $0; what changed was its
  position and its weight, not its scope — it built the candidate list and stopped, exactly as the issue
  said. Shipped as `pr-hero reverts` in `3e212f3`; result 3 usable cases (`docs/scout-design.md` §2.4bis).
- **#43 — DONE 2026-08-17, and it is #41's follow-up rather than a new milestone.** `pr-hero corpus`
  (`19b9f00`, measured in `139a2fd`) widens the known-bad corpus past reverts: bug-fix subjects,
  incident keywords, bug-labelled issues, same-day proximity, resolved review threads — 513 candidates on
  musive, 19 on supermarket-pro, tiered by confidence. It touches no engine path, no prompt set and no
  control set, so "one variable per experiment" is untouched and it was free to run at any time. **Its one
  interaction with a pending decision is §3.11's fork** — see the amendment below. The six defects its
  first live run exposed were recorded in #44 and **fixed the same day in `234a1ef`** (self-blame, null
  `pageInfo`, unpaginated commits/files, `--issues` as its own flag, rebase-merge blame, dead fields).
  That commit deliberately did no live re-run, so **the counts on disk are the pre-fix ones** — anything
  that consumes the corpus as ground truth re-runs `pr-hero corpus` first.
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
| M0 pin the ground — **DONE** | ½ | $0 | ~~verdicts on 11 rows~~ → 18 rows adjudicated |
| #41 revert mining — **DONE** (`3e212f3`) | ½ | $0 | 3 usable cases (§2.4bis) |
| #43 corpus past reverts — **DONE** (`19b9f00`) | ½ | $0 | 513 + 19 candidates (§2.4ter) |
| The replacement metric — **ANSWERED in §3.1** | 1 | $0 | two tiers; which one is bought = §3.11 |
| M1 public honesty | 1 | $0 | post-or-not on partial+zero |
| M2 #19's shape | ½ | $0 | — (the number decides) |
| M3 scout design — **RATIFIED 2026-08-17** | 1 | $0 | all four as recommended; fork → **(a)** |
| M4 scout-probe — **next** | 1 | ~$5–15 | thresholds — now set in §3.10 |
| M5 scout behind flag | 1–2 | ~$0.10 | — |
| M6 the A/B | 1 (+ wall clock) | **~$144 — (a) ratified** | adopt / opt-in / drop |
| M7 fill-ins | ride along | $0 | — |
| **Total** | **~7–9 sessions** | **~$200–300** | |

Those rows were the cost of the amendment. None of them spent money; all of them spent the scarce thing,
which is sessions — and as of 2026-08-17 all three are closed, one of them (the metric) by being answered
inside M3 rather than by a session of its own. The A/B's own estimate may move again once the variance in
`docs/scout-design.md` §1.3 is turned into a replicate count — `R ≥ 2` is very likely too few, and R
scales the dollars linearly. It may also move if the floor test comes out ambiguous and is grown from
#43's corpus rather than backed by Tier 2; that path is costed in the M3 entry above.

Then item 7. If M6 says drop, the track still delivered M1, M2, #40, #23's columns, #41, #43 and the first
real corpus — the pivot's principles land either way; only the flagship mechanism would not.
