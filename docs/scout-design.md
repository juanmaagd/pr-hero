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

## 3. The design (M3) — NOT WRITTEN

To be filled in the M3 session, answering ROADMAP C7's four open questions plus the six items listed in
`ROADMAP-DOORDASH.md` M3, with the real code in view. Nothing in M4–M6 starts before Juanma ratifies it.

Two constraints this M0 section hands the design, on top of that list:

- Score against the adjudicated `true-positive` subset (§2.3), never against `greptile_only` volume (§2.2).
- Size the replicates against the measured variance (§1.3), not against the roadmap's provisional
  `N=8, R=2`.
