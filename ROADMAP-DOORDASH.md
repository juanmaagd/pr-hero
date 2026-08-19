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

> **The prerequisite ran the same day and came back negative — 2026-08-17.** There are no three revert
> cases. PRs 1276 and 819 were re-landed **byte-identically** (2m23s and 5 days later; `git diff` empty and
> `git patch-id --stable` equal, both re-verified by hand), which is positive proof no reviewer could have
> flagged a defect in either patch. PR 1160 was never re-landed and is the only survivor, unconfirmed —
> no recorded symptom, empty PR body, reverted 19 minutes into an afternoon of nine firefighting PRs.
> Full evidence in `docs/scout-design.md` §2.4bis; the missing deterministic check in `pr-hero reverts`
> is #45.
>
> **Consequence, and it lands on M6 rather than M4:** the floor test starts at **five cases over four PRs,
> not eight over seven**. That makes M6 (a) cheaper — 24 runs, ~$96 — and the saving is the bad news, since
> §3.11 already said 8 cases cannot rank two arms that both score well and 5 is strictly worse. So the
> corpus growth written above as an ambiguity FALLBACK is **promoted to the main path on Juanma's call the
> same day**: adjudicate §2.4ter candidates up to roughly 12–15 floor cases before M6 runs, ~$200 rather
> than ~$96. The reasoning that argued for waiting no longer applies — it rested on an 8-of-8 result
> making growth unnecessary, and a 5-case floor cannot produce that result.
>
> M4's own two gates are unaffected: assertion 1 targets the five adjudicated misses and assertion 2's
> restraint set is untouched. **This is the $0 gate doing exactly its job** — it ran before the money and
> caught a false premise inside an already-ratified design.

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

### The floor test, built — 2026-08-17, between M3 and M4

Not a milestone of its own; it is §3.11's corpus growth executed after the revert corpus turned out to be
zero. Recorded here because M6's input changed and the sequence must show it.

**The floor test has 13 cases over 12 PRs — the canonical list is `docs/scout-design.md` §2.4septies, and
that table is the only one M6 reads.** Five are the adjudicated `greptile_only` misses; eight came from
adjudicating 20 corpus candidates, of which 8 survived (40%). Every verdict was re-verified by the
orchestrator against git rather than taken from the agent that produced it.

**M6's cost moves from ~$96 to ~$224** — 12 known-bad PRs + 2 clean, both arms, R=2 = 56 runs. That buys an
instrument that can distinguish *adopt* from *opt-in*; the five-case floor could only have shouted *drop*.

Three defects in our own tooling were found and two were fixed on the way:

- **Fixed (`c6a4d6e`)**: `blameResolve` passed no `-w -M -C`, so every mass reformat became the "introducer";
  and `ghCommitPulls` conflated a 404 with an empty response, so a degraded run read as a complete one.
  Re-mining moved 34 of 466 candidates, 14 off a known churn PR and **zero onto one**.
- **Filed, not fixed (#46)**: the corpus writes the defect site in the FIX's coordinates while the consumer
  replays the INTRODUCER. **Three of the eight corpus cases were unmatchable by any reviewer** — drifts of
  60 and 104 lines, and one path that did not exist yet. §2.4septies carries the corrected coordinates.
- **Filed earlier (#45)**: `pr-hero reverts` never checks whether a reverted patch was re-landed.

What did NOT change: M3's four ratified decisions, M4's two gates, and the restraint set. The scout design
is untouched by all of this — only the corpus M6 scores against moved.

### M4 — The scout-probe: the prompt earns its A/B — **DONE 2026-08-18, $37.00**

> **Result: both assertions pass, one of them on an amended gate.** Coverage 5 of 5 at R=3 with semantic
> hits verified case by case; restraint 3.83 leads per PR against a ceiling of 6. The prompt is
> `prompts/scout.md` sha256 `68a81d26081e`, reached over six versions where every change was bought by a
> measurement. **`lead_coverage`'s two ratio gates were struck** — its denominator is hunk count, which
> ordered the restraint set close to backwards, and its single-run ceiling was unreachable by any scout on
> a 3-hunk/1011-line PR. Full record, evidence and the amendment's stated circularity:
> `docs/scout-design.md` §3.10bis. Zero exclusions used; zero failed runs in 60 measured spawns.

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

### M5 — The scout wired, behind a flag, default OFF — **DONE 2026-08-18 (`e1ed036`), one session**

**Exit: MET.** The flag exists, defaults off, is fully tested, and the watcher does not know it exists —
the last of those by construction rather than by promise: `watch.ts` spawns a literal
`review --pr <n> --yes` argv, `parseArgs` refuses `--scout` on any verb but `review`, and
`parseLocalConfig` still rejects a `scout` key, so the config seat stays closed until M6 decides.

- All nine of `docs/scout-design.md` §3.12's obligations, one named test each, plus four the design
  implied and did not list (model precedence, the parse seam, the config seat, the plan row).
- **Two deviations, both because M4 measured something the design had estimated**: the watchdog is 15
  minutes, not §3.5's 5 (M4 measured the stage at 86-600s), and the model's last seat is an engine
  constant `DEFAULT_SCOUT_MODEL = "sonnet"` rather than "the run's model", because there is no such
  thing when no `--model` is passed and `prompts/scout.md` deliberately carries no `model:` frontmatter.
  Adding one would have moved the sha256 M4 ratified for a prompt whose body nothing changed. Full
  argument in `docs/scout-design.md` §3.15.
- **One key beyond §3.9's list**: `scout.why_truncated`, because M5 inherits M4's `why`-truncation
  defect and a defect nothing counts in production is a defect nobody notices.
- **`#40` did NOT land here.** The M1 amendment orphaned it — "pick it up on its own merits, not as
  part of a milestone" — so the bullet below is superseded, not skipped.
- **Live gates, $0.353**: `live-micro-eval --scout` (new mode — it proves `--tools ""` is ACCEPTED by a
  live session, which no offline test can) $0.0539; `fixture-eval` PASS $0.1298 / 71.0s;
  `fixture-eval --scout` PASS $0.1695 / 128.7s, the scout landing 1 lead on the planted defect.
- **The number M6 must not ignore**: the scout added **38.9s to a 71s run**, on haiku, over a two-file
  diff. §3.9 warned it sits on the critical path; this is the first datum saying that cost is not small.

The original entry, kept for its reasoning:

- `--scout` on `review` (and `.prhero/config.json` later; not on the watcher until M6 decides).
- The stage runs first, its leads render into the hunter prompts per M3, `pipeline.json` carries the
  provenance per M3 item 7, telemetry carries the stage's cost per agent (feeds #23).
- `#40` lands here if it did not in M1: the soft interrupt now has two stage semantics.
- Offline gates green; `fixture-eval` passes with the flag on and off (the planted bug still found, cost
  band still honest); one `live-micro-eval` with the flag on.

### M6 — The A/B on the control set — **INSTRUMENTS BUILT 2026-08-18, the paid run is Juanma's call**

> **"build-free" was wrong, and the correction is the useful part.** M6's CASES were already done (13 over
> 12 PRs, `docs/scout-design.md` §2.4septies — do NOT re-run `pr-hero corpus`). What did not exist was any
> way to READ a run against them: `compare.ts` scores against Greptile, not against a case list, and
> nothing could even tell which arm a run belonged to. Built this session, all $0:
>
> - **`src/floor-test.ts`** — the gate (§3.11's exact wording: a refuter-CORROBORATED finding within
>   `compare.ts`'s ±25 of the site), with "found at the site but not corroborated" reported BESIDE it and
>   never folded in, because that gap is a statement about the refuter rather than about the scout. Arm
>   identity comes from `pipeline.json`'s `scout.enabled` — the field M5 built for this — and a run whose
>   artifact cannot name its arm is skipped, never counted as the arm it resembles. §3.6's exclusion rule
>   is a predicate the scorer enforces, not a manual step.
> - **`docs/m6-floor-cases.json`** — §2.4septies as data, drift-guarded by a test that re-derives the
>   markdown table and fails if the two disagree. **Cases 1-5's paths were repo-relative-ised in the same
>   pass**: they carried §2.3's display form (`m4aRemux.ts`), which `normalizePath` matches against
>   nothing, so all five would have scored as misses by BOTH arms — §2.4septies's own lesson arriving
>   through a second door.
> - **`scripts/m6.ts`** — `plan` (free), `run` (the paid serial loop, arms INTERLEAVED per PR so a
>   four-hour session's model drift cannot be confounded with the arm, and never `--post`), `score` (free,
>   re-runnable from artifacts forever). One runs root, which is how §1.2's cross-root ledger problem stops
>   applying to the new data.
>
> **M6 IS PAUSED — 2026-08-19, Juanma, after the pilot. Do NOT run the remaining 44 runs.** Not because
> the scout failed: because the pilot found a CALIBRATION defect that makes the rest of the matrix the
> wrong purchase today. Measured from `<run>/steps/scout.leads.json`, at $0, over the 6 scout-arm runs:
> **24 leads against a 12-per-run budget (mean 4), covering 13 of the 30 files the diffs touch (43%)**,
> and stacking against `MAX_LEADS_PER_PATH = 3` in the main file of 2 of the 3 PRs — 3x in
> `PaywallUpgrade/index.tsx` and 3x in `AudioPlayerContext.tsx`, both in BOTH replicates. Downstream,
> hunters from DIFFERENT agents (`RES` + `LC`, verified by the id prefix on every `debug.deduped[]`
> loser) converge on those sites: **40% of the scout arm's drafts collapse in the merge vs 7% for the
> control — +100% gross drafts for +15% net findings.** That is the signature of a stage that concentrates
> rather than broadens, and ~$163 / ~5h54m would buy a precise number about THAT calibration.
>
> Rule 7 ("attribute the miss before choosing the lever") is the one that governs here, and the miss is
> attributed: lead dispersion, not scout capability. **What this does NOT establish** is that 4 leads is
> too few — the pilot's diffs are small (3-7 files) and some files are trivial (`Styles.ts`). The measured
> claim is the DISTRIBUTION, not the absolute count. The cheapest next probe is still $0: read the 24
> leads against the diffs and check whether the un-led files held anything worth a lead.
>
> **Resuming has a precondition, not just a budget:** §3.11's invariant is same day, same engine build,
> same prompt set. Touching the scout prompt or the caps — which is what this finding points at — makes
> the 12 pilot runs a variance third point rather than arm data, and the price returns to the full 56.
> adopt / opt-in / drop remains OPEN and remains Juanma's.
>
> **THE PILOT RAN 2026-08-18/19 — 3 PRs, R=2, 12 runs, $44.32, and it is a HARNESS result, not a scout
> result.** Two defects caught in the first ten minutes (`--out` names the run dir not a root; a review
> can exit 0 without running, on a stale in-flight commit status) plus one side effect nobody had written
> down: every PR-mode review posts a `pr-hero` commit status on the head as the operator's account, which
> `--post` does not cover. Full record: `docs/scout-design.md` §3.16. **Three corrections to the numbers
> below:** cost per run measured $3.36 control / $4.03 scout (+20%), so the full 56 extrapolate to
> **~$207** — inside the band, mid-range, not at its floor; wall clock measured 6.34 / 9.76 min per run,
> so the full session is **~7h31m, not 4h44m**, the scout arm being the entire difference; and what a
> decision actually costs is the **REMAINING 44 runs — ~$163, ~5h54m** — because the floor test extends
> incrementally and `m6.ts run` resumes over the 12 on disk, valid only while this engine build and
> prompt set hold. Scout stage: 103-286s, mean 196s.
>
> **The latency is the pilot's real finding, and it is not about recall.** 38.9s (fixture) → 86-600s (M4
> probe) → 103-286s here. The scout adds ~3.3 min to every review against §3.9's "one short step"; for a
> PR-triggered reviewer that is a product number, and it plausibly caps the outcome at `opt-in` before the
> floor table says anything.
>
> **The priced go/no-go, measured not guessed** (`bun run scripts/m6.ts plan`, from GitHub's counters and
> musive's own `.prhero/config.json` — 3 hunters + refuter, summarizer OFF, parity never fires):
> **14 PRs × 2 arms × R=2 = 56 runs, $173.68–$374.22, ~4h44m serial.** The size gate refuses none of the
> 14, so the harness passes no `--force` and the live gate stays live. The old "~$150–250" was the band's
> LOW half only.

The original entry, kept for its protocol, which is unchanged:

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

**Amended 2026-08-18 (THE LAUNCH LINE):** item 7 is a launch fundamental, not a post-ship research
item. This file's sequence is unchanged — M5 → M6 → splice → item 7 — and that sequence now sits on
the ship path. Scout-as-default is still M6's call (adopt / opt-in / drop), not a launch checkbox.

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
| M4 scout-probe — **DONE 2026-08-18** | 1 | **$37.00** | restraint gate amended → (b); §3.10bis |
| M5 scout behind flag | 1–2 → **1, DONE** | ~$0.10 → **$0.353** | — |
| Adjudicate #43 candidates — **DONE**, 13 cases | 1 | $0 | 8 of 20 usable; §2.4septies |
| M6 the A/B | 1 (+ wall clock) | **~$224 — (a), floor at 13** | adopt / opt-in / drop |
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
