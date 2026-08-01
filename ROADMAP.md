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

  Measured under this rule so far (lifecycle class, its own trees): **G5 0.50** (3 of 6), **G4 0.00**
  (0 of 3), **G2 0.00** (0 of 4).
- **A4. Held-out benchmark** — only after the smoke-level bar is met: full run over the lab's
  `dataset/test.jsonl` (first and only read), measure against the bar, F2/SNR reported alongside. This is
  one of the few places a full smoke-scale run is mandatory.

Gate to Phase B: bar met on the held-out set.

## Phase B — Production wiring (cancels Greptile)

From the original design, unchanged: post findings as inline PR threads via `gh` (orchestrator-only I/O);
required status check per head SHA (fail-closed, no run = no merge); `branch-pr` hook + local watcher
(launchd/cron) for contributor/agent PRs; audited `skip-deep-review` label. Run both systems in parallel
until the bar holds in production; then cancel Greptile ($912–1,632/yr).

## Phase C — Engine hardening (parallel-friendly, no benchmark coupling)

Convoy-inspired ops the engine still lacks, in value order:

- **C1. Fingerprint seeds** — hunters emit `specialty|path|symbol|root-cause` (convoy's dedup primitive);
  sharpens mechanical dedupe (the same-symbol over-merge case) and makes cross-run overlap measurable
  (the variance analysis pain).
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
