# The scout — design (ROADMAP-DOORDASH M3) and its frozen control set (M0)

Status: **M0 section filled 2026-08-16. The design itself (M3) is not written yet.** Nothing in M4–M6
starts before Juanma ratifies the design in the section left empty at the bottom of this file.

This file has two jobs. The first, done here, is to freeze what the paid A/B in M6 will be read against —
the runs already on disk, the buckets they produced, and the adjudicated verdict on every finding Greptile
caught that pr-hero missed. The second, M3's, is the scout design itself.

---

## 1. The control set (frozen 2026-08-16)

### 1.1 THESE RUN DIRS MUST SURVIVE UNTIL M6

**There is no TTL that deletes them, and there is no mechanism that protects them either.** Verified at
freeze time: `pr-hero gc` collects worktrees under `~/.prhero/repos/*/worktrees` only (`src/gc.ts:1-6`,
`src/gc-preflight.ts:5-7`) and never touches a runs root. So nothing will delete these — but nothing will
stop a hand from deleting them either, and they are **not under version control**. Re-creating them costs
a full control arm: ~30 live runs, real money, and models that have moved since.

The three roots, none of which may be pruned:

- `~/Desktop/musive/musive-s1-prhero-runs/`
- `~/Desktop/musive/musive-s2-prhero-runs/`
- `~/Desktop/musive/musive-s3-prhero-runs/`

**There are five runs roots on disk, and only these three are the control set.** Named here so the next
reader does not have to re-derive it — and because this file's first draft said "three roots" as though
that were all of them:

| root | runs | Greptile | in the control set |
| --- | --- | --- | --- |
| `musive/musive-s1-prhero-runs` | 3 | yes | **yes** |
| `musive/musive-s2-prhero-runs` | 8 | yes | **yes** |
| `musive/musive-s3-prhero-runs` | 19 | yes | **yes** |
| `supermarket-pro-prhero-runs` | 3 (PRs 107, 109, 110) | **no** — `greptile_found: false` | no |
| `pr-hero-prhero-runs` + `~/.prhero/repos/.../pr-hero/runs` | 8 + 2 | **no** — `greptile_found: false` | no |

The two excluded roots are excluded for one reason only: Greptile is not installed on those repositories,
so every run there is `greptile_found: false` with **zero `greptile_only` rows** and no head-to-head to
read. This is what keeps §2's claim exact — *all* 18 `greptile_only` rows that exist anywhere on disk are
adjudicated, not merely all of them in the three roots above. Their 15 `prhero_only` rows are untriaged
and are not part of any count in this file.

### 1.2 What is actually there

**30 runs over 19 distinct PRs**, every one `run_status: complete` with `greptile.found: true`. All 30
ran with `model: sonnet` on every step, so the corpus is one configuration, not a mix.

> Correction to `ROADMAP-DOORDASH.md`'s state section, which was written from `musive-s3` alone and
> miscounted even that: it says "15 distinct PRs / 19 runs / 11 `greptile_only`, 13 `both`, 28
> `prhero_only`". The verified figures are below. The s1 and s2 roots were missed entirely, and they carry
> PRs 1710, 1719, 1720 and 1721 that appear nowhere in s3.

| PR | head | run dir | root | G-only | both | ph-only | rows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1682 | `e3ab386a` | `pr-1682-e3ab386a-1` | s3 | 1 | 0 | 4 | 5 |
| 1682 | `e3ab386a` | `pr-1682-e3ab386a-2` | s3 | 0 | 1 | 3 | 4 |
| 1698 | `4ca9628a` | `pr-1698-4ca9628a-2` | s3 | 0 | 0 | 2 | 2 |
| 1700 | `f3175dea` | `pr-1700-f3175dea-1` | s3 | 1 | 0 | 1 | 2 |
| 1703 | `91ddfee1` | `pr-1703-91ddfee1-1` | s3 | 0 | 0 | 2 | 2 |
| 1703 | `b7b5cf1c` | `pr-1703-b7b5cf1c-1` | s3 | 0 | 0 | 1 | 1 |
| 1703 | `b7c4ae5a` | `pr-1703-b7c4ae5a-1` | s1 | 0 | 0 | 1 | 1 |
| 1705 | `28142bef` | `pr-1705-28142bef-1` | s3 | 1 | 0 | 2 | 3 |
| 1705 | `bcbac026` | `pr-1705-bcbac026-1` | s3 | 1 | 0 | 3 | 4 |
| 1707 | `dc388c06` | `pr-1707-dc388c06-1` | s3 | 1 | 1 | 0 | 2 |
| 1708 | `d720e927` | `pr-1708-d720e927-1` | s3 | 0 | 0 | 1 | 1 |
| 1710 | `9a2eea8b` | `pr-1710-9a2eea8b-1` | s2 | 1 | 0 | 0 | 1 |
| 1711 | `c3e3838a` | `pr-1711-c3e3838a-1` | s3 | 0 | 2 | 0 | 2 |
| 1711 | `c3e3838a` | `pr-1711-c3e3838a-1` | s2 | 1 | 1 | 0 | 2 |
| 1714 | `c3235192` | `pr-1714-c3235192-1` | s3 | 1 | 0 | 3 | 4 |
| 1714 | `c3235192` | `pr-1714-c3235192-1` | s2 | 1 | 0 | 3 | 4 |
| 1715 | `dc086cd1` | `pr-1715-dc086cd1-1` | s2 | 0 | 0 | 2 | 2 |
| 1715 | `dc086cd1` | `pr-1715-dc086cd1-1` | s3 | 0 | 0 | 2 | 2 |
| 1716 | `13218672` | `pr-1716-13218672-1` | s3 | 0 | 1 | 0 | 1 |
| 1717 | `052f77cb` | `pr-1717-052f77cb-1` | s3 | 1 | 3 | 0 | 4 |
| 1717 | `052f77cb` | `pr-1717-052f77cb-1` | s1 | 2 | 0 | 0 | 2 |
| 1718 | `902cca91` | `pr-1718-902cca91-1` | s3 | 0 | 1 | 0 | 1 |
| 1718 | `902cca91` | `pr-1718-902cca91-1` | s2 | 1 | 0 | 0 | 1 |
| 1719 | `43f5098f` | `pr-1719-43f5098f-1` | s2 | 2 | 0 | 3 | 5 |
| 1720 | `8888a69e` | `pr-1720-8888a69e-1` | s2 | 0 | 0 | 0 | 0 |
| 1721 | `ea23c289` | `pr-1721-ea23c289-1` | s2 | 0 | 0 | 1 | 1 |
| 1722 | `24a27ba8` | `pr-1722-24a27ba8-1` | s3 | 1 | 1 | 2 | 4 |
| 1722 | `24a27ba8` | `pr-1722-24a27ba8-2` | s3 | 0 | 2 | 2 | 4 |
| 1724 | `bda807b3` | `pr-1724-bda807b3-1` | s3 | 2 | 0 | 0 | 2 |
| 1724 | `bda807b3` | `pr-1724-bda807b3-1` | s1 | 0 | 4 | 1 | 5 |

`musive-s3-prhero-runs/pr-1698-4ca9628a-1/` exists but carries no `comparison.json` and is not part of
the set.

**Two views of the same 74 rows, because they answer different questions:**

| view | `greptile_only` | `both` | `prhero_only` | rows |
| --- | --- | --- | --- | --- |
| summed over all 30 runs | 18 | 17 | 39 | 74 |
| one vote per PR, latest run only (what `pr-hero ledger` reports) | see below | | | |

`pr-hero ledger` takes a single `--runs` root, so the latest-run view exists only per root today: s1 gives
`2 / 4 / 2` over 3 PRs, s2 gives `6 / 1 / 9` over 8 PRs, s3 gives `8 / 10 / 18` over 15 PRs. **A
cross-root ledger does not exist.** M6 needs one number over the whole set, so either the ledger learns to
take several roots or M6 aggregates by hand and says so.

### 1.3 Run-to-run variance, measured for free

Eight PRs were reviewed twice at the **same head with the same configuration**. This is the third data
point M6's protocol asks for — how much the buckets move on replay alone — and it was already paid for:

| PR | head | run A (G/both/ph) | run B (G/both/ph) | moved |
| --- | --- | --- | --- | --- |
| 1682 | `e3ab386a` | s3 1/0/4 | s3 0/1/3 | yes |
| 1711 | `c3e3838a` | s3 0/2/0 | s2 1/1/0 | yes |
| 1714 | `c3235192` | s3 1/0/3 | s2 1/0/3 | no |
| 1715 | `dc086cd1` | s2 0/0/2 | s3 0/0/2 | no |
| 1717 | `052f77cb` | s3 1/3/0 | s1 2/0/0 | yes |
| 1718 | `902cca91` | s3 0/1/0 | s2 1/0/0 | yes |
| 1722 | `24a27ba8` | s3 0/2/2 | s3 1/1/2 | yes |
| 1724 | `bda807b3` | s3 2/0/0 | s1 0/4/1 | yes |

**Six of eight pairs moved.** The two extremes are the ones M3 must design around: at `1717@052f77cb` one
run matched three of Greptile's findings and the other found nothing at all; at `1724@bda807b3` one run
matched four and the other matched zero. Those are not small deltas — they are the whole effect size the
scout is expected to produce.

The consequence for M6 is direct and unwelcome: **`R ≥ 2` replicates is very likely not enough** to
separate a scout effect from this noise, and the A/B protocol must be sized against these numbers rather
than against the roadmap's provisional `N=8, R=2`. M3 owns that calculation.

---

## 2. The M0 triage — every `greptile_only` row now carries a verdict

All **18** `greptile_only` rows across the 30 runs are adjudicated (16 written in M0, 2 pre-existing).
They cover **16 distinct findings**; two findings appear twice because the same PR was reviewed in two
roots (`1717` Styles.ts:84 in s1+s3, `1714` AudioPlayerStore.ts:400 in s2+s3), and both copies carry the
same verdict.

### 2.1 The vocabulary

Deliberately NOT the four triage tags (`applied`/`dismissed`/`deferred`/`misclassified`, `src/triage.ts:26`):
those describe what a PR author did about a pr-hero finding. These rows are findings pr-hero never made,
so the question is different — was it a real miss? The four strings below are the ones already on disk
from the earlier hand-triage of PRs 1700, 1703, 1682, 1698 and 1705, and `pr-hero ledger` tallies them
as-is:

- **`true-positive`** — a real defect, reachable at that head, traced end to end in code. **A genuine miss.**
- **`latent`** — the mechanism is real but not reachable at that head, or defused elsewhere in the PR chain.
- **`out-of-scope`** — a real observation, but style, convention, naming, type hygiene or a refactor
  suggestion. No behaviour at risk.
- **`false-positive`** — the claim is wrong at that head, with cited disproof.

### 2.2 The result

| verdict | rows |
| --- | --- |
| `true-positive` | **5** |
| `out-of-scope` | 10 |
| `latent` | 2 |
| `false-positive` | 1 |

**Only 5 of 18 `greptile_only` rows are real misses.** Eleven of eighteen — 61% — are not defects at all.

This is the single most consequential number M0 produced, and it changes how M6 must be read: the
`greptile_only` bucket **cannot be used as a raw score**. A scout arm that shrinks the bucket by absorbing
Greptile's convention opinions has not improved recall, it has learned to imitate a house style. M6 must
score against the adjudicated `true-positive` subset, never against bucket volume.

### 2.3 The five real misses — M4's target list

These are the only rows a scout-probe may plant as targets, because a target that is not a real defect
poisons the probe from the first run:

| PR | head | site | what pr-hero missed |
| --- | --- | --- | --- |
| 1717 | `052f77cb` | `packages/app/components/PaywallUpgrade/index.tsx:119` | Autoplay writes the destination index before `scrollToIndex`; in-flight `onScroll` rounds back to the source index and overwrites it. |
| 1719 | `43f5098f` | `packages/backend/src/Infrastructure/Http/SongSourceResolver.ts:296` | Pin-freshness check has no lower bound, so a future-dated `verifiedAt` passes; Redis re-arms the sliding TTL on every read, making a skewed pin effectively immortal. |
| 1722 | `24a27ba8` | `packages/backend/src/Utils/m4aRemux.ts:181` | `readMdatSize` trusts the declared atom size without checking it reaches EOF, so a truncated remux passes verification and overwrites the original object. |
| 1724 | `bda807b3` | `docs/runbooks/mus-638-song-bucket-rollout.md:144` | `$url` is unset under `set -u` in the emergency-rollback block, aborting after every mutation but before the direct-delivery proof. |
| 1724 | `bda807b3` | `docs/runbooks/mus-638-song-bucket-rollout.md:140-142` | App Runner poll has no deadline and no default arm; `ROLLBACK_*` statuses and a `None` lookup both spin forever. |

Two of these deserve a note in M3, because they shape what the scout must be able to see:

- **1722 is a regression the author confirmed.** The same PR's later commit `019547458` restores the guard
  as `if (offset + size > fileSize) return undefined;` under the comment *"The declared size is a claim,
  not a measurement"*, and its message names it *"a regression I introduced"*. It was findable from the
  diff: the diff itself replaces a whole-file-size comparison with an mdat-size one.
- **Two of the five live in a markdown runbook**, not in code. A diff-only scout reads them fine. A scout
  whose prompt implicitly assumes TypeScript will skip 40% of this target list.

Every verdict's full reasoning, with the `file:line` evidence it was read from, is in the row itself
(`reasoning` field of the matching `comparison.json`), never only here.

### 2.4bis The revert corpus, measured — it is small, and that is the finding

`pr-hero reverts` (#41) was built the same day and run over both repositories that have real history. The
numbers matter more than the tool:

| repository | window | commits scanned | candidates | body-linked | usable |
| --- | --- | --- | --- | --- | --- |
| `MusiveTech/musive` | 24 months | 4780 | 9 | 4 | **~3** |
| `JuanchiiGomezZ/supermarket-pro` | 24 months (whole history: Jan–Aug 2026) | 1624 | **0** | 0 | 0 |

The three usable musive cases are PRs **1160** (`fix: race condition restructure`, +25/−47 over 3 files,
reverted after 19 minutes), **1276** (`Fix/no ref/public project control slider`, +134/−56 over 4 files,
5 minutes) and **819** (`refactor: new uploading status card`, +569/−326 over 14 files, 4h25m). The fourth
body-linked pair, PR 478 (`feat: username cannot change`), is almost certainly a product decision rather
than a defect. The five pattern-only entries are hotfix merges whose reverted PR does not resolve.

supermarket-pro contributes **nothing** on this axis: 1624 commits and not one revert or hotfix merge.
Its history is seven months old, which is the likeliest explanation, and it will contribute later or
never — either way it is not a source of ground truth today.

**Three cases is not a benchmark.** That is the honest read, and it constrains the replacement metric
directly: revert mining can serve as a FLOOR ("the scout must catch these three") but cannot carry M6's
score on its own. Choosing what does is still open and is Juanma's call.

### 2.4 The restraint set for M4 — NOT yet established

M4's second assertion needs PRs that are genuinely clean, so a loud scout can be caught. The candidates by
bucket shape (`greptile_only` 0 and `both` 0) are PRs **1698, 1703, 1708, 1715, 1720, 1721**. But **that is
a bucket shape, not a triage**: several of them carry untriaged `prhero_only` rows, and a PR with a real
pr-hero-only defect is not clean. Triaging `prhero_only` rows was explicitly out of M0's scope. M3 must
either define restraint against a criterion these rows can satisfy as-is, or budget the triage.

### 2.5 How the verdicts were written, and by whom

`pr-hero triage` **cannot** reach these rows: `applyTriageReplies` binds only rows whose `prhero` side is
non-null (`src/triage-write.ts:78-83`) and resolves the parent from a posted `<!-- pr-hero-finding`
marker. A `greptile_only` row has `prhero: null` and no thread of its own. So the verdicts were written
directly into each `comparison.json`, which is also how PRs 1700 and 1705 were triaged before this
milestone. Building a `pr-hero triage row` write path is a candidate M7 fill-in, not a blocker.

Each verdict was adjudicated by an isolated agent reading the repository at that exact head (never the
claim's prose), and the rows carry **`actor: "agent"`** — the reasoning text is agent-authored, and
labelling it `human` would destroy the one distinction the field exists to make. Juanma's ratification is
recorded in this file and its commit, not by relabelling authorship. Any row he overrides becomes
`actor: "human"` at that point.

### 2.6 Two defects this milestone surfaced in our own tooling

Neither is fixed here; both are recorded so they are not rediscovered.

1. **Writing a `comparison.json` can silently change which run votes.** `aggregateLedger` orders runs by
   `generated_at`, falling back to file mtime for artifacts written before that stamp existed
   (`src/ledger.ts:37-40`). Writing a verdict bumps mtime, so triaging an *older* run can promote it over
   the newer one and flip the ledger's per-PR totals. Observed live during M0: writing s3's verdicts moved
   the totals from `8/10/18` over 36 rows to `9/9/19` over 37, because `pr-1682-e3ab386a-1` — the only
   file on disk with no `generated_at` — jumped ahead of `pr-1682-e3ab386a-2`. Original mtimes were
   restored and the totals returned. `pr-hero triage` writes through the same path (`src/cli.ts:2149`) and
   has the same exposure.
2. **`pipeline.json` records no provenance.** Its keys are `pr`, `base_sha`, `head_sha`, `out_path`,
   `excluded_paths`, `parity_hunter_fired`, `steps` — no engine version, no prompt-set identity, no
   fingerprint. The corpus above is *believed* to be one configuration because every step says
   `model: sonnet` and the production set is immutable, not because any artifact says so. **M3 item 7
   (scout provenance) is therefore not an addition to an existing provenance record — it has to build
   one**, or M6 cannot attribute a finding to "led" versus "found unled".

---

## 3. The design (M3) — PARTIAL, stopped deliberately 2026-08-16

The M3 session was started and stopped early by Juanma, on the correct observation that **the DoorDash
track does not have to be finished for the main roadmap to continue** — only `ROADMAP.md` item 7 gates on
it, and the rest of Phase C does not.

What follows is what M3 actually established before stopping. It is recorded because the measurements
below were the expensive part and would otherwise have to be re-derived. **The scout design proper — C7's
four open questions, and M3 items 1 through 5 and 7 — is NOT written.** Do not treat this section as a
ratified design; nothing in M4–M6 may start from it.

### 3.1 M3 item 6, the metric — this part IS answered, and the answer is uncomfortable

**Run-to-run variance, measured over the eight same-head replicate pairs in §1.3, counted in pr-hero
findings per run rather than in buckets:**

| measure | value |
|---|---|
| findings per run, mean | **1.87** |
| findings per run, standard deviation | **1.36** |
| mean absolute delta between same-head replicates | **1.38** |
| max delta | **5** — PR 1724 produced 5 findings in one run and **0** in the other, at the same commit |

**The noise is 74% of the signal.** Any scout effect smaller than roughly 1.4 findings per PR is
indistinguishable from re-running the engine unchanged.

**What that costs, paired by PR, at ~80% power and α=.05 (δ ≈ 2.8 × SE, SE = σ√(2/NR)):**

| N PRs | R replicates | runs total | detectable δ | as % of the 1.87 mean | ~cost at $4/run |
|---|---|---|---|---|---|
| 8 | 2 | 32 | 1.35 | **72%** | ~$128 |
| 8 | 3 | 48 | 1.10 | 59% | ~$192 |
| 15 | 2 | 60 | 0.98 | 53% | ~$240 |
| 15 | 3 | 90 | 0.80 | 43% | ~$360 |
| 19 | 3 | 114 | 0.71 | 38% | ~$456 |

So the roadmap's provisional `N=8, R=2` can detect **only a ~+72% effect** — that is, only if this scout
reproduces DoorDash's own +75% weighted-recall result almost exactly. **If the real effect here is +30%,
this corpus cannot see it at any affordable N.** That is the honest read, and it must be stated in the
forecast before any arm runs, not discovered afterwards.

**The metric shape that follows, two tiers, because one of them needs no statistics at all:**

1. **Floor test — deterministic, cheap, interpretable.** Eight known defects with known sites already
   exist: the 5 adjudicated `true-positive` misses (§2.3) and the 3 usable revert cases (§2.4bis). Does
   the scout arm catch what the control arm misses, case by case? Binary per case, no power calculation,
   and it fails loudly rather than ambiguously.
2. **Effect test — statistical, expensive, and honestly underpowered.** Paired per-PR count of
   **refuter-corroborated** findings (not raw volume — C1's lesson), with the refuted/downgraded rate as
   the precision guard. Sized from the table above with the detectable effect declared up front.

Counting corroborated findings rather than raw ones is safe here for a measured reason: precision is
already high and stable — 53/53 postable (§2.2 of the M2 write-up in #19) and 35 of 36 musive 🔴 findings
`corroborated` by the refuter. The refuter is doing its job, so surviving it is a usable proxy for "real".

**The caveat that does not go away:** neither tier sees what BOTH arms missed. That is C10's blind spot,
and no metric in this section closes it.

### 3.2 Engine facts the design must obey — mapped 2026-08-16, not yet turned into decisions

Recorded because they were read out of the real code and they constrain M3 items 1–5 and 7 hard:

- **`role` is `"hunter" | "refuter"` and nothing else** (`src/spec.ts:18-31`), hunter keys are sealed to
  the schema enum, and `agentsDirProblems` is **bidirectional** — a prompt file in the agents dir that no
  spec entry names is a hard `CliError`. A scout therefore cannot simply be dropped into a prompt set.
  **The precedent to copy is the summarizer**, which sits deliberately OUTSIDE `ReviewSpec` as an
  engine-owned stage (`src/pipeline.ts:85-87`). Keeping the scout there is also what keeps the prompt-set
  fingerprint untouched, which is what makes M6 one-variable.
- **The delivery channel for leads is the USER prompt, not a new `{{LEADS}}` anchor.** `hunterPrompt`
  (`src/pipeline.ts:277-290`) already assembles engine-owned text beside `HUNTER_OUTPUT_CONTRACT`, whose
  own comment says it is *"driver source: covered by the engine version, NOT by the prompt-set
  fingerprint"* (`pipeline.ts:246-247`). A `{{LEADS}}` anchor would instead require editing every agent
  file — a prompt-set change that kills the one-variable property — and templating has **no unknown-token
  check**: an unresolved `{{...}}` ships verbatim into the model with no error, no warning and no test.
- **A pre-hunter stage attaches between `pipeline.ts:427` and `pipeline.ts:443`**, after the diff and
  changed paths are known and strictly before the loop that composes hunter prompt bytes. There is no
  existing sequential pre-hunter precedent — the summarizer runs *concurrently* and feeds nothing.
- **"Diff-only, no tools" is only partly expressible today.** `tools: []` emits `--tools ""`, which **no
  test covers**; `mcpConfigPath` is required and `--mcp-config` is emitted unconditionally; and `cwd` is
  always the worktree, so "no repo access" is enforced by the tool allow-list, never by a sandbox.
- **Provenance is worse than assumed and cheaper to fix than assumed.** `pipeline.json` records no engine
  version, no prompt-set identity, not even a timestamp. But `findings.ts` already **declares**
  `prompt_set?: {name, sha256}` and `driver_sha?` and no CLI path ever populates them — the schema seat
  exists, unused.
- **Two wiring hazards for any new stage:** a stage that omits `sumUsage(state.usageTotal, …)` is
  invisible in the run's cost total; and `estimateCost(diffStat, hunterCount, summarizerEnabled)`
  (`report.ts:75-102`) counts hunters and a summarizer boolean only, so a scout needs its own explicit
  parameter, copying the summarizer's precedent.
- **DashBench constrains the model choice:** the cheap scout won — Kimi scouting for Fable beat Sonnet
  scouting for Opus on every quality axis at lower cost. Scout tier and hunter tier are independent knobs.

### 3.3 What is still unwritten

C7's four open questions and M3 items 1–5 and 7. Chiefly: whether leads bias or replace the hunters' own
scan, what structurally stops the scout from becoming DoorDash's failed v2, the recall-first/precision-first
split, the lead size ceiling, and how a finding is traced back to "led" or "found unled" without a schema
change. Juanma ratifies the completed design before M4 begins.
