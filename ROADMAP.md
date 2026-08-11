# pr-hero — Roadmap

Defined 2026-07-29 with Juanma, right after the engine flip (deep-review's v1 monolith retired,
pr-hero@0.1.0 is the engine). Ordering principle: **the benchmark bar funds everything** — recall work
first (it is what cancels Greptile), production wiring second, platform/multi-model third (each lever
enters as a measured arm, never as faith), OSS productization last. One variable per experiment, always.

Working agreement on validation speed: full smokes are SLOW and are reserved for milestone validation.
Day-to-day iteration runs on offline gates (tests/typecheck/biome), the fixture eval, and surgical
single-tree replays against the specific goldens a change targets.

## Phase A — Graduate Phase 0 (the bar: ≥80% catch, ≤20% FP)

The two known capability gaps, in attack order:

- **A1. Lifecycle-contract pass** — the missing hunter class. Enumerate-then-contradict applied to state:
  for every effect/latch/ref/timer/subscription the diff touches, a mandatory arm/re-arm/cleanup table
  crossed against resource-change modes (switch, error, early return, stall); report empty cells.
  Targets the stable misses G2/G4/G5 (0-for-history — any repeated catch is pure signal). New prompt set
  (scored sets are immutable); surgical replays of the G2/G4/G5 trees with replicates + N-of-M reading;
  watch advisory volume and blocking precision for regressions.
- **A2. Refuter v2** — precision + completeness guard. **Built and measured 2026-08-01** (iterations
  541–543, `bench/METRICS.md`). Per-finding refuter steps via the declarative spec (kills the 27e85937
  large-batch failure by construction); eligibility is severity alone, because the triage found the gate
  was not weak but *structurally bypassed* — 26 of 26 blocking findings were `deterministic` and the batch
  filter admitted only `inferential`, so blocking tier had zero adversarial checking; verdict vocabulary
  gains `downgraded-latent` ("real but unreachable today" → advisory, never deleted — the G6 lesson);
  mandatory own-expansion per finding (visit proof_refs AND hunt the counterexample; external measurement:
  −88.6% FP for −3.1% recall); refuted requires positive disproof with cited code.

  **Calibration, restated — the original gate was the wrong instrument.** It read "G5 still reaches
  blocking tier, ≥2 of 3", which conflates refuter behaviour with hunter run-to-run variance and therefore
  cannot answer what A2 asks. G5 came back 1/3 (A1 was 2/3; pooled, the lifecycle hunter catches G5 in
  3 of 6 runs on that tree — squarely inside this benchmark's documented variance), while the refuter
  returned `corroborated` on all 15 findings it judged: it removed and downgraded nothing, so the misses
  are provably upstream of the gate. **A refuter gate must assert what the refuter DID to a finding
  (removed / downgraded / preserved), never an end-to-end catch rate.** Standing calibration for any
  refuter change, in this order:
  1. `bun run refuter-probe` — the verdict-vocabulary matrix on planted claims, cents per run. A prompt
     edit that cannot pass this does not reach a paid replay.
  2. On a golden tree: no finding the refuter judged may be removed or downgraded without a cited
     contradiction, and 27e85937's batch must complete.
  3. Blocking-tier precision reported only once the novel findings are triaged — never inferred from
     volume.

  **What remains unproven**: the −88.6% FP figure. A2 judged 15/15 `deterministic` findings where every
  pre-A2 verdict was on an `inferential` one, so prompt effect and population shift are perfectly
  collinear in the live data and no number of musive replicates can separate them. The probe falsified the
  "deferential refuter" reading (3/3 correct refutations of a planted false claim, $0.58) but only for an
  adjacent, obvious contradiction.
- **A3. Dataset decisions (Juanma) — CLOSED 2026-08-01.** All three decisions made; see below and the
  graduation/G6 entries that follow.

  **The 10 triage verdicts: ratified, with one overturned on new evidence.** The row
  *"trim range not reset on song switch"* — the only medium-confidence verdict — was marked FALSE
  POSITIVE on the same "the component remounts on song switch" defence that the G6 investigation
  disproved. Verified directly: `firstTrimValue`/`secondTrimValue` are component state
  (`AudioTrimmer/index.tsx:64-65`) cleared in exactly two places, the add-comment success path (`:483`)
  and the cancel button (`:553`); **no effect keyed on `song.song.id` resets them**. Since the component
  survives a song switch, song A's trim range persists into song B. The claim is mechanically correct —
  **latent, not false**. The other nine stand (five true positives, three of which the team independently
  fixed later; the rest high-confidence and none resting on the disproved defence).

  **Revised precision: false positives 2/15 (13%)**, down from 3/15 (20%). The ≤20% half of the bar is
  met with margin.

  **Process fix, learned the hard way**: that triage recorded verdicts WITHOUT their reasoning, so the
  disputed row could not be re-examined when new evidence arrived — the verification had to be redone from
  scratch. Record the reasoning with the verdict, always.

- **A5. Lift the lifecycle pass's reachability suppression** — the recall lever, and the one grounded in a
  provable inconsistency rather than a guess. `agents/slice3b-lifecycle-v2/deep-review-lifecycle.md`
  contradicts itself: line 74 says *"Not reportable: a mode that is unreachable by construction"*, while
  line 125 says *"You do not filter — a downstream refuter owns precision, and a finding you suppress is
  simply lost."* That suppression is **why G2 scores 0 of 4** — G2 lives in a component with zero live
  callers at its commit, so conditions (b) reachable-with-cited-path and (d) user-visible-consequence can
  never be satisfied. (The value-contract pass has no reachability criteria at all, which is exactly why
  G3 lands 4/4 in that same unwired file.)

  The suppression was correct prudence when the refuter had only two doors, delete or block: emitting an
  unreachable defect meant either a false positive or a blocked merge. **A2 built the third door**, and
  `downgraded-latent` was measured working 3 of 3 (`refuter-probe`, `latent-claim` arm). The hunter is now
  suppressing precisely the class the gate knows how to handle correctly.

  Experiment (one variable, new prompt set since scored sets are immutable): drop the reachability
  suppression, let the hunter emit unreachable-but-real defects at CRITICAL, and let the refuter demote
  them. Target G2 @ `4609456d` — a cheap tree (~$3/run, so 3 replicates ≈ $10). Report the mean per the
  graduation rule. Watch blocking volume and the `downgraded-latent` rate as the regression signals.

  **G6 ground truth — DECIDED 2026-08-01 (Juanma): G6 stays, denominator 7, and its correct verdict is
  `downgraded-latent`, not `blocking`.** The dispute was framed as real-vs-not-real and that was the wrong
  question. Verified in the code at `f961e23a`: `SongComments` renders from a single slot with **no `key`**
  and no per-song conditional, so switching songs is a same-type same-position reconciliation — React
  updates props and `AudioTrimmer` **stays mounted**, while only `<audio key={reproductionUrl}>` remounts.
  `reset()`, the only writer that arms `isWaveformLoading`, sits in a `useEffect` with `[]`. The mechanism
  is therefore real and unguarded. What could NOT be established is a live trigger: every traced path
  closes-then-reopens behind a full-viewport click-eating overlay.

  Real defect, unreachable today — which is the definition A2 wrote for `downgraded-latent`. G6 is the
  lesson it was named after: the old refuter had only two doors, delete or block, and chose delete. The
  engine's correct behaviour on G6 is to find it and demote it to advisory, which the v2 refuter was
  measured doing 3 of 3 (`refuter-probe`, `latent-claim` arm).

  Product follow-up surfaced by the same investigation, independent of the benchmark:
  `useTriggerCardSliders.tsx:32-52` opens the comments slider from an effect with **no `sliderBoxContent`
  guard**, while its three sibling effects all have one (`views/Project/index.tsx:229,:290`,
  `views/PublicProject/index.tsx:233`). That missing guard is the only thing keeping G6 latent rather than
  live.

  **Graduation semantics — DECIDED 2026-08-01 (Juanma): a golden's score is the MEAN over its replicates,
  not a threshold.** A golden caught 2 of 3 times contributes 0.67, never 1.0. The reason is production:
  the engine runs **once per PR**, so the mean is literally the expected catch rate a real PR experiences,
  and a threshold answers a continuous reality with a binary. The prior unratified "≥2 of 3" rule had
  already broken on its own terms — G5 on the same tree scored 2/3 under A1 and 1/3 under A2, flipping
  from "caught" to "missed" on noise alone, while 3/3 and 2/3 counted identically.

  Two consequences, both accepted deliberately:
  1. **The bar gets harder.** ≥80% catch now means near-deterministic catching, not "caught at least
     sometimes". A bar that flatters the engine cannot decide whether to cancel Greptile.
  2. **Most historical scores become UNKNOWN rather than known.** They were single runs, and a single run
     has no mean. Converting them requires replicates. Recording them as unknown is more truthful than
     promoting one sample to a verdict.

  **The scoreboard, measured clean (2026-08-04, set `slice3b-lifecycle-v6-clean` `8671784895536467`).** Every
  number before this line was produced by a prompt whose worked examples named the goldens' own anchors — see
  the contamination correction in `../deep-review/bench/METRICS.md`. These are the first scores that are not:

  | golden | clean | before | note |
  |---|---|---|---|
  | **G4** | **1.00** (3 of 3) | 0.33 under A7, 0.00 across six runs before | single-variable v5→v6; removing the leak **tripled** it |
  | **G3** | **0.33** (1 of 3) | 3 of 3 under A5 | its severity calibration WAS the leak; ~0.33 is the honest rate |
  | **G2** | **0.00** (0 of 3) | 1 of 3 under A5 | does not reproduce without the leak; A5's headline stays retired |
  | **G1** | **0.00** (0 of 3) | 0 of 3 | unchanged |

  Only G4's row is a clean single-variable comparison. The G2-tree rows span three changes (A6, A7, the
  decontamination) and show direction, not cause — isolating them needs an arm that does not exist, v3 with
  clean examples. **Stated plainly: the benchmark was reading higher than the engine deserved on at least two
  goldens, and the only number that went UP when the prompt was cleaned is the one A7 earned.**
- **A4. Held-out benchmark** — only after the smoke-level bar is met: full run over the lab's
  `dataset/test.jsonl` (first and only read), measure against the bar, F2/SNR reported alongside. This is
  one of the few places a full smoke-scale run is mandatory.

- **A6. Make the stall row writable — BUILT, MEASURED, AND FALSIFIED 2026-08-02.** Diagnosed 2026-08-01 for
  $0 from artifacts on disk; the diagnosis was wrong, and the measurement that proved it is below. The reasoning
  is kept in full because it is the record of what was believed, why it was plausible, and exactly which claim
  the experiment killed.

  The lifecycle prompt names the mode explicitly (line 55: *"**Stall** — the op neither succeeds nor
  errors (an event never fires, the network hangs, media never reaches...)"*), so this is a compliance gap,
  not a design gap. Yet G4 — whose golden is exactly a missing stall backstop — scored **0 of 3**, and the
  hunter's own drafts from iterations 531–533 show what it produced instead: switch-mode findings, three
  runs running. The hunter works. The stall row is never generated.

  **Why, precisely.** Condition (c) demands *"no disarm or re-arm actually FIRES in this mode … Prove it by
  having read the whole owner plus every cleanup reachable via `codegraph_explore` — **not merely by not
  having found one yet**."* Switch, error and early-return are events that exist in the code: there is a
  line to cite. A stall is the absence of every event — there is nothing to point at, and (c) explicitly
  rejects "I did not find one" as proof. **Stall is the one mode whose burden of proof is unsatisfiable by
  construction**, so the row never gets written.

  How stark the miss is: at G4's tree (`27e85937`) the file contains **zero `setTimeout` occurrences** — the
  absence is total, not subtle. (Its sibling commit `f961e23a` has 3; the two are divergent, not
  parent/child.)

  Fix, following A5's template: turn *"I searched X, Y and Z and no disarm fires on a stall"* from an unmet
  burden into a **reportable statement**, exactly as A5 did for reachability. Built as
  `slice3b-lifecycle-v4-refuter` (`e5d9d0a10f3edbfe`): a **completed enumerated sweep** counts as positive proof
  (owner read in full with cited bounds → every ledger-named cleanup hop → backstop primitives searched by name
  with counts reported including zeros → the awaited operation followed into whatever performs it), plus a fourth
  absence-anchor form, both confined to mode 4.

  **Result — iterations 561–563, $33.65, G4 0.00 (0 of 3).** Not a single stall row was written. A grep over
  `claim` and `proof_refs` of every finding from every hunter in all three runs for
  `stall|backstop|timeout|never fires|swept|sweep|setTimeout` returns **zero hits**; the lifecycle hunter
  produced switch-mode findings again, the same shape as iterations 531–533. The prompt was clean before it ran
  — two rounds of blind dual review, five defects confirmed by both judges and corrected, plus one fix-caused
  defect caught in round two — so this is a falsified hypothesis, not a defective arm.

  **What it kills.** The diagnosis above says the stall column is empty *because* condition (c) demanded proof of
  a non-event and so could not be satisfied. A6 removed that impossibility and the row was still never written.
  **The proof standard was not the binding constraint.** A gate can be unsatisfiable and still not be the reason
  a thing does not happen — the hunter was never reaching the gate.

  **Cost lesson, recorded because it was a real error:** the ~$21 estimate was carried from this document
  without checking the tree. G4's tree is 45 files / +2775 −1237, so it bills ~$11/run, not ~$7. Estimate from
  the diff, never from a sibling golden.

- **A7. Force the cell to be generated — BUILT, MEASURED, AND IT WORKS. 2026-08-03.** Iterations 571–573,
  $48.30, set `slice3b-lifecycle-v5-refuter` (`fda1b839b067cb9d`). **G4 0.33 (1 of 3) — the first catch of G4 in
  the campaign's history**, against 0 of 6 before it. The lever A6's failure pointed at, and the first one
  grounded in a negative result rather than a reading of the prompt.

  **The mechanism is the result, and it is unambiguous.** All three runs emitted the `cells` array — 15, 20 and
  25 entries, i.e. 3, 4 and 5 resources × exactly five modes, so the completeness rule held — including **3, 4
  and 5 stall cells**, with verdicts spanning the whole vocabulary (`defect`, `clean`, `incoherent`,
  `unresolved`). A6 on this same tree produced zero stall anything. **Cell generation was the binding
  constraint.** A6 made the stall row permissible; A7 made it generated; they are complementary, which is why v5
  builds on v4 and the chain is measured at each step. The catch (iteration 572, F012, CRITICAL/blocking): the
  `<audio preload="metadata">` element has no timeout or deadline, and only `onLoadedMetadata`/`onError` can end
  `isWaveformLoading`.

  Cost lesson, again: $48.30 against a ~$34 estimate. The table costs output tokens and the estimate was taken
  from A6's per-run cost without adding them. **Two arms, two overruns, one root — estimating from the previous
  arm instead of from what the change does.**

  Step 2 tells the hunter to cross every ledger row against all five modes and says *"the unit of judgement is
  the **cell**, not the row"*. Three runs of evidence say it does not do that: it builds the ledger, finds a
  defect in an early mode (switch, every time), and reports that instead of completing the cross-product. The
  stall cell is never generated, so no proof standard — satisfiable or not — is ever reached. That also explains
  why A6's carefully-widened burden changed nothing.

  Experiment (one variable): make the cross-product an **output obligation**, not an internal instruction —
  require the mode table itself in the response, every row × every mode, each cell carrying one of
  `defect | clean (cited) | incoherent (why)`, emitted *before* any finding. A cell the hunter must fill is a
  cell it cannot skip. Target G4 @ `27e85937` again, since its golden is the one a completed table must surface,
  and it is now the only tree where a null result is informative. Budget ~$11/run × 3 ≈ **$34** — verify against
  the diff before committing to the number. Watch total findings and blocking volume: forcing a table is the
  lever most likely to produce a firehose, and that is the regression signal.

Gate to Phase B: bar met on the held-out set.

## THE PIVOT — 2026-08-10. The golden dataset is retired as the benchmark.

Decided by Juanma, and it reorders everything below: **stop improving the number, stabilize a version,
wire it up, and take the numbers from running in parallel with Greptile on live PRs.** His words:
*"dejemos de dar vueltas para mejorar el número"*, and — the constraint that reframed the method —
*"no me importa el gasto, me jode más el tiempo que está llevando esto."*

Cost was never the binding constraint; TIME WAS. The $0-diagnosis-first discipline and three rounds of
blind review over a six-line prompt edit saved money and spent sessions. That trade was mispriced.

**What replaced it.** Greptile already reviews every PR, so it is the oracle: nobody has to know in
advance whether a PR contains a bug. `pr-hero review` on the PR, `scripts/compare-pr.ts` against
Greptile's own comment, three buckets. **~$3 and ~4 minutes per PR**, on code from this week — against
a session and $12+ for one arm on July trees whose dataset turned out contaminated.

**First run, 8 PRs (1676-1684), $23.51, and the headline was not the one expected:**

| | Greptile | pr-hero | |
|---|---|---|---|
| 1677 | 1 (real bug: duplicate React keys) | 0 | **measured miss** |
| 1682 | 1 (style) | 3 blocking | pr-hero only |
| 1683 | 1 (convention) | 0 | out of scope |
| 1679 | 0 | 2 advisory | pr-hero only |
| 1684 | 0 | 1 blocking | pr-hero only |
| 1676, 1678, 1681 | 0 | 0 | agreement, clean |

**Greptile-only 3 · Both 0 · pr-hero-only 6. The overlap is ZERO.** In eight PRs they never once found
the same thing. These are not two reviewers on one scale — they have different biases. Greptile sweeps
wide and flags convention; pr-hero digs into lifecycle and state machines and says nothing elsewhere.

Two pr-hero findings verified by hand in the code:
- **1682** — `RenameSlider/index.tsx:65` passes `enabled={!isLoading}` to a `styled(TouchableOpacity)`
  whose `enabled` only drives `opacity` (`Styles.ts:8-16`). `TouchableOpacity` has `disabled`, not
  `enabled`. The button dims to 50% and stays pressable: **the UI lies**. Greptile reviewed that PR.
- **1679** — `LoadingSpinner.tsx:7-19` starts `Animated.loop` with `useNativeDriver` and returns no
  cleanup, in a component unmounted every time loading ends. Correctly tiered advisory, not blocking.

Zero false positives across the five PRs Greptile passed clean. The profile, now measured rather than
assumed: **high precision, narrow coverage.**

**What this does to the north star.** This document says the goal is to cancel Greptile ($912-1632/yr).
At zero overlap that question is malformed — each covers what the other does not. Cancelling Greptile
today loses 1677's duplicate keys; dropping pr-hero loses 1682's lying button. The decision is what each
is FOR, and the head-to-head answers it per PR for the price of a coffee.

**Phase A is closed.** A8 (`slice3b-lifecycle-v7-cellproof`, lab `4da15bd`) was its last arm and it
worked on both mechanism gates — `incoherent` cells fell 55%→37.5%, defect cells rose 2→5, and G2's own
cell went from 0-of-3 to 2-of-3 adjudicated `defect`. It was deliberately NOT scored against the
goldens: scoring it would have been the exact loop this pivot ends. A4 (held-out set) does not run;
`dataset/test.jsonl` stays sealed, now permanently unless the decision is revisited.

**Next session starts at Phase B.**

## Phase B0 — Local mode (usable NOW, deliberately not gated on the bar)

Added 2026-08-04, and it corrects a conflation this document was making. Phase B was gated on the
benchmark bar because it *cancels Greptile* — a fail-closed merge gate had better not have holes. But
"Juanma can run it on a PR and read what it found" needs none of that, and the roadmap was making him
wait on a research campaign to touch his own tool.

The bar has two halves and they are in very different places: **precision is already met** (2/15 false
positives, 13%, against a ≤20% target) while **recall sits at 0.33** over the four goldens measured
clean. A tool with good precision and mediocre recall is useless as a GATE and genuinely useful as an
ASSISTANT — what it tells you is mostly true, it just does not tell you everything. That is exactly the
profile B0 ships.

`pr-hero review [--repo --base --head --agents --out --model --hop-budget --dry-run --yes]`
(`src/cli.ts`, pure decisions in `src/preflight.ts`, renderer in `src/report.ts`). It resolves refs,
generates the diff, preflights, runs the existing pipeline unchanged, and writes `findings.json` plus a
markdown `report.md`. Explicitly OUT of scope: posting to GitHub, the required status check, anything
fail-closed. Those stay in Phase B behind the bar, where they belong.

Three things it fixes that were latent, each found while building it:

1. **`defaultReviewSpec()` omits the lifecycle hunter.** Running the 5-file clean set with the 4-agent
   default silently drops the hunter the entire 2026-08 campaign is about, and nothing downstream
   notices. Local mode ships an explicit 5-agent spec and a **bidirectional** agents-dir preflight —
   every spec file must exist, and every agent file present must be referenced.
2. **Nothing in either repo measured a diff's size.** Two recorded cost overruns (`~$21`→actual,
   `~$34`→`$48.30`) share one root: estimating from the previous arm instead of from the change.
   `estimateCost` now reads `git diff --numstat` and prints a BAND before anything spawns, with its two
   calibration points named in the output. It is a guide, not a quote — the same tree has billed 34%
   apart across runs.
3. **A dirty working tree used to be reviewable.** Every step runs with the repo as cwd, so uncommitted
   changes get reviewed but never reported. Local mode refuses to run on a dirty tree or a head that
   does not match `HEAD`.

`--dry-run` is the $0 gate and does everything except spawn: resolve, preflight, diff, plan, cost band.
Use it first, always. The plan also surfaces that steps run under `--permission-mode bypassPermissions`
bounded only by each agent's read-only tool allow-list — the user should see that before every run, not
find it in the source.

Gate to Phase B: unchanged — the bar, on the held-out set. B0 does not move it and does not pretend to.

## Phase B — Production wiring — THE NEXT SESSION STARTS HERE

Gate removed 2026-08-10: this no longer waits on the bar. See THE PIVOT above.

Where it already stands: `pr-hero review` runs with zero flags inside a configured repo, the diff comes
from the merge base, `.prhero/` carries gotchas/priors/agents_dir, `pr-hero` is a linked global command,
and `scripts/compare-pr.ts` does the head-to-head read-only through `gh`. Eight PRs have been through it
end to end.

What is still manual, in the order it should be closed:

1. **`pr-hero review --pr <n>`** — the one command. Resolve head and `mergeCommit^1` through `gh`, create
   the detached worktree, ensure its own codegraph index (never reuse another checkout's — different
   bytes), run, then compare against Greptile automatically. Today that is ~6 hand-run steps per PR and
   it is the single biggest friction left. Worktree teardown is `git worktree remove`, never `rm -rf`:
   a live index holds an open `.codegraph/daemon.sock`.

   **BUILT 2026-08-10** (`src/pr.ts` I/O + `src/pr-preflight.ts` pure decisions). The design's spine is
   two roots, deliberately assigned: the OPERATOR checkout (gh + git cwd, `.prhero/` trust anchor, run-dir
   anchor; its dirtiness is irrelevant and both local gates are skipped there on purpose) and the REVIEW
   worktree (`<repo-parent>/<basename>-worktrees/pr-<n>`, pipeline cwd, owns its codegraph index — the
   availability check runs against IT, or hunters would ride another checkout's index). MERGED resolves
   base to `mergeCommit^1` (base as it was when the PR landed — squash/rebase/merge all converge at the
   fork point via the existing merge-base default); OPEN/CLOSED use `baseRefOid`. The fetch rides
   `refs/pull/<n>/head` because a merged PR's branch is usually deleted. `--dry-run` is fetch-free and
   creates nothing: the cost band rides GitHub's own diff counters. Worktrees are KEPT AND REUSED
   (Juanma's call, 2026-08-10): reuse requires HEAD == PR head AND a clean porcelain ignoring the
   always-untracked `.codegraph/`; head-moved or dirtied trees are recreated via
   `git worktree remove --force` (verified: plain remove refuses on the untracked index). The Greptile
   comparison runs in-process and emits `comparison.md` + `comparison.json` — B4's seed, rows carrying
   `verdict: null, reasoning: null` (the A3 lesson) and the run's `run_status`; a run where every hunter
   died writes NO comparison at all, because "pr-hero 0" from a review that never happened would land in
   the ledger as a measured miss. Verified for $0 against real PR 1682: offline gates (289 tests), the
   fetch-free dry run, and a declined-confirm run that exercised fetch, `^1` resolution, merge-base and
   the real numstat (gh's counters matched exactly). Unexecuted until the first paid run: worktree
   creation, `codegraph init`, the pipeline itself, comparison writing. Known edge, loud by design: a
   CLOSED-unmerged PR whose base branch was deleted fails at the fetch. With musive-s3's `.prhero/`
   already populated, the whole command inside that checkout is literally `pr-hero review --pr <n>`.
2. **Post the report to the PR** via `gh` — orchestrator-only I/O; the spawned steps are sandboxed away
   from `gh` by `--strict-mcp-config` and `--setting-sources ""`, and that stays true.

   **BUILT 2026-08-10** (`--post`, explicit and never default; needs `--pr` by parseArgs rule).
   Idempotent by construction: the comment leads with `PR_COMMENT_MARKER` (`<!-- pr-hero-report -->`),
   and posting finds the NEWEST marked comment and PATCHes it in place — one comment per PR, re-runs
   refresh instead of stack. The body travels on stdin (`-F body=@-`), so no ARG_MAX and no shell. The
   public comment carries findings, the reviewed range, `run_status` and the engine identity — never
   cost or tokens, and always the not-a-merge-gate disclaimer, because at the measured recall this
   engine has no business implying it gates anything. A `sessionFailed` run never posts (a clean-bill
   comment from a review that never ran would be a public lie); a posting failure exits 1 because it
   was explicitly asked for. Verified boundary, stated plainly: the READ path (comments fetch now
   carrying ids) is live-verified against PR 1682 — where a `<!-- linear-linkback -->` bot comment
   confirmed in the wild why marker matching is exact-prefix; the WRITE path (POST create, PATCH
   update, stdin body, response-id parse) has never executed and stays that way until an authorized
   live post. The live protocol is TWO posts: the first proves create, an immediate second must report
   `updated` with the SAME comment id — one post alone leaves the idempotency untested.
3. **Trigger** — `branch-pr` hook or a local watcher (launchd/cron) so a review happens rather than being
   remembered. Note this spends money per PR without asking, so it needs an explicit opt-in.

   **BUILT 2026-08-11** (`src/watch.ts` I/O + `src/watch-preflight.ts` pure decisions; design ratified by
   Juanma the same day). Reframed during design: pr-hero is OSS, so the trigger is a PRODUCT feature —
   trigger adapters over the same `review --pr` command. The GitHub Action adapter stays in Phase E by
   Juanma's call; B3 is the local adapter. Tick model, never a daemon: launchd (or cron + the advisory
   lockfile) fires `pr-hero watch --once`; a workless tick costs one `gh pr list` per repo, and the gate
   (window/cap) runs before ANY call. Opt-in is structural — `~/.prhero/watch.json` lists exactly the
   repos the watcher may spend on, `post` per repo (ON for musive, OFF is the OSS default), global
   `daily_cap` (5) protecting the shared subscription-quota window, optional local-time window. The cap
   counter is watch.log itself, appended BEFORE each spawn: over-counting skips a review, under-counting
   is unbounded spend. Eligibility is per (pr, head) — a push re-arms the review so the posted comment
   tracks the live head: open non-draft, no comparison.json match (parsed fields via the ledger parser,
   never dir names), no marked comment declaring the head, and <2 artifact-counted attempts (poison-PR
   guard). The cross-machine guard rides the marker: it now carries `head=<sha>` and matching moved to
   the bare prefix `<!-- pr-hero-report ` so pre-B3 comments still PATCH instead of stacking (pinned by
   tests). Known debt, accepted ("no es perfecto pero está bien por ahora"): two watchers on one repo
   can duplicate one review inside a ~10-min race window (the PR still converges to one comment), and
   `post: false` has no shared state at all — exactly-once needs central event delivery, which is Phase
   E's Action; until then the operating model is one watcher per repo per team. Verified offline (428
   tests, marker back-compat pins, full eligibility matrix); the live tick, launchd install and first
   auto-spawned review are UNEXECUTED — `pr-hero watch --once --dry-run` is the $0 gate, always first.

   **Deferred by design (Juanma, 2026-08-11): parallel PR reviews per tick.** Today the tick is ONE
   review, FIFO by PR number, and the queue drains at ~4 PRs/hour — deliberate, because each review is
   already internally parallel (the hunter fan-out) and K simultaneous reviews would contend for the
   same subscription-quota window, CPU and rate limits while making the cap and the log illegible.
   Revisit when musive's PR volume outgrows the drain rate: the cheap knobs are a shorter interval or a
   `reviews_per_tick: K` config (needs per-PR locking and concurrent log-append discipline). True
   per-PR parallelism — one runner per PR, instantly — is what Phase E's GitHub Action gives for free,
   so measure whether the local knob is worth building before the Action makes it moot.
4. **Accumulate the head-to-head** into a ledger across PRs, so the three buckets become a rate rather
   than a snapshot. Six of the eight findings so far are unverified one by one; a verdict column with its
   reasoning is required — the A3 lesson was that verdicts recorded without reasoning cannot be
   re-examined when new evidence arrives.

   **BUILT 2026-08-10** (`pr-hero ledger [--repo --runs --out]`; pure half in `src/ledger.ts`).
   Sweeps `<runs-root>/*/comparison.json`, parses each back with loud per-field validation (a silently
   mis-read artifact becomes a silently wrong rate), and renders one markdown ledger to stdout. The
   denominator rule is the design: **one PR, one vote** — only each PR's latest run counts toward the
   totals (ordered by the new `generated_at` stamp, mtime as the fallback for files that predate it),
   because totals over all runs would let a re-reviewed PR vote twice. Verdicts are tallied AS-IS,
   whatever strings the triage wrote — the ledger reports the triage's own vocabulary and never defines
   a taxonomy; the A3 lesson lives in each row's reasoning, not in an enum invented before any triage
   happened. A **Pending triage** section names every verdict-null row of every latest run with an
   actionable identity (finding id or Greptile index + path:line), and the closing line routes verdicts
   INTO the run's own comparison.json. Verified against the real runs root: the 1682 row renders
   1/0/4 with 0/5 triaged and all five pending identities; counts stay counts ("N of M"), no
   percentage theater on small denominators. comparison.json gains `generated_at` (ISO 8601, stamped
   by the I/O shell — the pure builder owns no clock) going forward; no artifact carries it yet, since
   the stamping call site first executes on the next paid run.

5. **The size gate — "PR too large → skip"** — **BUILT 2026-08-11** (`src/size-gate.ts` pure;
   wired into local review, PR review, and the watcher). Defaults: **2500 effective changed lines,
   150 effective changed files**, with generated content (lockfiles, `*.min.js`/`*.min.css`, `*.snap`)
   excluded before the count. Escape hatches: `--force`, `--max-changed-lines`, `--max-changed-files`
   (0 disables a limit); per-repo thresholds ride `watch add`.

   The gate runs BEFORE the cost-band `confirm()`, never behind it — the watcher passes `--yes`, so a
   gate inside the prompt would never fire in the one place unattended spend actually happens. In
   watch mode the skip is `too-large`: it consumes no poison-PR attempt, writes no marker, and does
   not arm the on_push one-review-per-PR state, so a force-push that shrinks the PR re-qualifies it on
   the next tick. The watcher tiers its check — GitHub's aggregate counters ride free on the existing
   `gh pr list`, and only a PR that exceeds a limit costs a second call for per-file data.

   **The WHY is COST AND PREDICTABILITY, and only that**: small trees bill $1.9–$4.8, the 45-file
   bench tree billed $6.58–$17.92 across 18 iterations — ~3x the cost with ~2.7x the spread.
   **The size↔quality question remains UNMEASURED.** Attention dilution was tested and falsified in
   `fixtures/scale-probe.ts`, and the one measured Greptile-only miss was a 7-file PR — so there is no
   evidence a bigger diff reviews worse, and nothing in the code or the docs claims one. The
   experiment that would actually answer it is `scripts/scope-probe.ts`, still unreported: until it
   runs, these thresholds are a budget decision, not a quality boundary, and they should be argued
   about on cost grounds alone.

Deliberately still deferred: the required status check per head SHA (fail-closed, no run = no merge) and
the audited `skip-deep-review` label. Both are merge gates, and at 0.00 measured recall on 1677 this
engine has no business blocking a merge yet.

Cancelling Greptile is no longer the goal of this phase — see the north-star note in THE PIVOT.

## Phase C — Engine hardening (parallel-friendly, no benchmark coupling)

Convoy-inspired ops the engine still lacks, in value order:

- **C1. Fingerprint seeds — PROMOTE. A7's measurement turned this from a nice-to-have into a bar-blocker.**
  Hunters emit `specialty|path|symbol|root-cause` (convoy's dedup primitive); sharpens mechanical dedupe (the
  same-symbol over-merge case) and makes cross-run overlap measurable (the variance analysis pain).

  **Why it moved.** A7's blocking volume doubled (13/11/9 against A6's 4/4/9), which reads as a precision
  collapse. It is not one. **23 of those 33 blocking findings are a single root cause reported at ten different
  call sites** — 10 of 13, 7 of 11, 6 of 9. Strip the cluster and non-cluster blocking is 3/4/3, alongside A6's.
  The cluster is a **true positive**, verified end-to-end in the target repo at `27e85937`:
  `ProjectSongDuration.fromSeconds()` stores `Math.round(seconds * 1000)` and `ProjectSong.toDto()` emits that
  raw `.value`, while `Waveform/WaveformWithTime.tsx:13-14` documents `durationSec` as **SECONDS** and
  `computeProgress` divides bare. A milliseconds producer feeding a documented seconds consumer, across every
  host that renders a wave.

  It fans out because `dedupe_key` is `<path>:<symbol>:<category>` and each host has a different path. So the
  engine found a systemic defect and correctly named every site, and the benchmark counts that as ten precision
  failures. Until C1 lands, **report blocking volume as distinct root causes, never as a raw count** — and never
  infer precision from volume, which is the only reason this was caught at all.

  **C1 split in two on 2026-08-04, and the free half LANDED.** The entry above assumes the seed must be emitted
  by the hunter, which means a new prompt file → a new immutable set → a new paid arm. A7 proved output
  obligations move hunter behaviour hard, so that version perturbs the just-measured clean baseline in order to
  fix a problem that is purely one of MEASUREMENT. It did not need to.

  - **C1a — derived clustering. DONE, $0, no prompt change, no recall risk.** The signal already exists in
    current artifacts: findings in a fan-out all cite the same root-cause location as their FIRST proof_ref,
    because the hunter output contract already orders them `["producer path:line", "consumer path:line"]`.
    `src/root-cause.ts` partitions findings on that anchor, `pipeline.ts` stamps `root_cause_id` and puts the
    summary on `debug.root_causes`, and `scripts/cluster-report.ts` replays it over artifacts already on disk.
    Purely additive: both validators are allowlists, so no schema bump and C1 never depended on C2.
    **Non-destructive by construction** — the lab's scorer reads `findings[]` and ignores `debug.deduped[]`,
    so a collapse here would surface as a recall regression on a run whose recall did not change.

    Validated for $0 against A7's hand triage (the gate the standing rules ask for — plant it, observe it
    cheap, never discover on a paid run):

    | iter | blocking | root causes by hand | by the engine |
    |---|---|---|---|
    | 571 | 13 | 4 | 6 |
    | 572 | 11 | 5 | 7 |
    | 573 | 9 | 4 | **4** |

    Raw count 33 → hand 13 → engine 17: **80% of the distance from the dishonest number to the correct one**,
    mechanically. **Over-clustering: zero** (verified by hand — all 8 members of 571's cluster are the same
    ms/seconds defect at different hosts). The residual is real and it is the whole argument for C1b: one root
    cause has several citable sites (`ProjectSongDuration.ts:19-20` stores the ms, `ProjectSong.ts:454` emits
    the raw `.value`, `WaveformWithTime.tsx` is the shared consumer), and findings split by which one they
    cited first. No cheap normalization fixes that — they are different files.

    **Direction-of-error rule, now load-bearing:** the clusterer must err toward UNDER-clustering.
    Over-clustering deflates the apparent FP count, which is the direction that flatters the engine.
    Concretely paid for during review: a ref written `path.tsx: 12-14 (prose)` — a space after the colon —
    degenerates to a bare `path.tsx:` once the prose is cut, i.e. a FILE-level anchor, and in run 571 that was
    already welding F013 (blocking, a fetch-once lifecycle bug) to F014 (advisory, a memo bug) as one root
    cause. An anchor with no location component now yields no anchor at all. This is the SAME lesson
    `dedupe.ts:66-69` already carries from judgment day — pass 2 refuses to collapse symbol-less findings
    because keying on path alone over-merges distinct defects file-wide. New code did not inherit it; tests
    pin it now.

  - **C1b — hunter-emitted seed. DEFERRED, and now decided on evidence rather than faith.** What it buys is
    exactly the residual C1a leaves: 4 root causes across three runs. That is the number to weigh against a new
    prompt set, a new arm, and the risk of perturbing recall — not a guess.
- **C2. Schema v1.1** — lift the closed `Hunter` enum (unblocks arbitrary spec keys), make `engine` a
  first-class field; lab migration + validator both sides.
- **C3. Resume + run metadata** — convoy-style debounced tmp+rename metadata, resumable interrupted
  runs, per-run SUMMARY; today a killed multi-tree run restarts from zero.
- **C4. Runtime-safety preamble** — a non-overridable engine-owned preamble (instruction hierarchy,
  read-only report contract "your final message IS the report") replacing per-prompt repetition.

## Phase D — Multi-runtime + multi-model (Stage 2)

The economics (verified 2026-07-29): Anthropic prohibits Claude Pro/Max on OpenCode (plugins removed in
1.3.0) → Claude legs stay on Claude Code CLI (subscription, $0 marginal). **ChatGPT Plus works on
OpenCode with zero setup** → a Codex/GPT leg rides Juanma's existing subscription, $0 marginal, exactly
like convoy uses its Codex quota. OpenRouter (paid per token) only for diversity legs (Kimi/GLM/Grok).

- **D1. OpenCodeRunner** — second `StepRunner` against `@opencode-ai/sdk`: driver-owned config dir (the
  `--setting-sources ""` analog), read-only tool config + bash-policy deny floor, event-stream + status
  polling completion (never one blocking HTTP call), verified terminal message, total-wins usage, per-
  backend transient classifier. The interface obligations are already documented on `StepRunner`.
- **D2. Model routing** — convoy's `model-routing.ts` pattern: logical model identity vs gateway
  (`configured|direct|openrouter`), `provider/model#variant` effort syntax, frozen plan shows
  Logical/Target per step. Spec already carries `backend`/`models[]`.
- **D3. Fan-out benchmark arm** — the honesty gate: same-hunter × N models (e.g. sonnet + GPT leg) vs
  baseline, same goldens, replicates. The Opus probe already showed tier doesn't move our misses;
  diversity must prove it buys recall (convoy's bet) before it costs a cent of routine spend.

## Phase E — OSS productization (pr-hero as a product)

From the productization vision + convoy's operational layer: `.prhero/` project config (pipelines as
YAML/TS data — the ReviewSpec already is), GitHub Actions runner mode (claude-code-action +
CLAUDE_CODE_OAUTH_TOKEN as the documented fallback), built-in provider bench, human gates in specs,
TUI/dashboard (live per-step status, cost, provider limits — convoy's strongest UX), `runs` browser.
Timing: only after Phase B proves the engine in anger on our own repo.

**Onboarding DX (added 2026-08-11 by Juanma, from the first real onboarding pass):** a guided
`pr-hero init` that collapses today's per-project ritual — scaffold, hand-write gotchas, decide
commit-vs-ignore for `.prhero/`, optionally `watch add` — into one complete, intuitive flow with
options. Concretely: walk the gotchas instead of leaving a template (refusing to run on empty is
right; writing them should be easier), make the ignore choice actionable (offer to append
`.git/info/exclude` — the polite variant for shared repos, and the reminder text already explains
why), offer watcher enrollment with its post flag, and keep every step flag-addressable so the
non-interactive path stays scriptable. The three-command onboarding is correct; it should also be
one obvious command.

## Standing rules (apply to every phase)

- Design before code: no step starts without certainty of what and how — verified against the real code
  and the convoy reference; when in doubt, ask Juanma (he is always available for decisions).
- Full smokes only at milestones; iterate on offline gates, the fixture eval, and surgical replays.
- Prompt sets immutable once scored; new behavior = new set, fingerprinted.
- One variable per experiment; replicates + N-of-M; misses attributed (hunter/merge/refuter) before
  choosing a lever.
- A gate asserts the mechanism it tests, never a downstream proxy. If a component's pass condition can be
  moved by something the component does not control, the gate measures that other thing — A2's original
  "G5 reaches blocking tier ≥2 of 3" tested the refuter through the hunter's variance and answered a
  question nobody asked. Where the mechanism can be planted and observed for cents, the cheap harness is
  the gate and the paid replay is confirmation, not discovery.
- The lab's `dataset/test.jsonl` stays sealed until A4.
- Cost is a first-class metric; every live run lands in the ledger with its engine identity.
- Convoy clone at `~/Desktop/convoy` + study notes at `../deep-review/intel/convoy.md` are the reference
  library.
