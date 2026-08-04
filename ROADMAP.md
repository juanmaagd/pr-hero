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

## Phase B — Production wiring (cancels Greptile)

From the original design, unchanged: post findings as inline PR threads via `gh` (orchestrator-only I/O);
required status check per head SHA (fail-closed, no run = no merge); `branch-pr` hook + local watcher
(launchd/cron) for contributor/agent PRs; audited `skip-deep-review` label. Run both systems in parallel
until the bar holds in production; then cancel Greptile ($912–1,632/yr).

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
