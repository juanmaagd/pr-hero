# Jev (TypeSafe) — what it is, everything we measured, and when to reach for it

Evaluated 2026-09-17. Verdict: **not adopted.** Jev is fast, cheap, and calibrated, and it does locate the
neighbourhood of a defect better than chance — but on this pipeline it never converted that into findings a
hunter would not have produced anyway. This document exists so the next person does not re-run the same
eleven experiments to learn that.

Model observed: `jev-1.13.0` (requested as `jev-latest`). Docs: <https://docs.typesafe.ai>.

## 1. What Jev is (and is not)

A **System One model**: it understands natural-language input like an LLM, but it does not generate text. You
POST a `state` (string, object, or array) plus a map of typed *questions*; it returns one typed answer per
question, evaluated in parallel and in isolation against the same state.

| Question type | Answer |
|---|---|
| `noul` | one probability 0–1 ("is this statement true?") |
| `choice` | the chosen option, the full probability distribution, a `confidence` |
| `score` | a probability-weighted position across levels you define, plus distribution and `confidence` |

Training objective is what matters here: TypeSafe calls it RLCD, reinforcement learning for calibrated
decisions. Probabilities are optimised against outcomes, so across many predictions a 0.8 should be right
about 80% of the time. That is a property of *groups* of predictions; it says nothing about one answer.

Consequences for a code-review engine:

- **It cannot write a finding.** No claim text, no evidence, no explanation. Anything it produces must be
  consumed by code or by an LLM.
- **It has no tools.** It sees only the `state` you assemble. It cannot open a file, follow a caller, or read
  a symbol two hops away.
- **It is not a reasoner.** The vendor's own guidance is to decompose: "jev works better with smaller
  decomposed questions that compose into harder tasks". Our measurements agree — see §4.

### API shape (verbatim, as used)

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
{"model":"jev-latest","state":{...},"questions":{"my_id":{"type":"noul","instructions":"..."}}}
→ {"model":"jev-1.13.0","answers":{"my_id":{"type":"noul","noul":0.94}},
   "usage":{"input_tokens":314,"output_tokens":37}}
```

`instructions` and the `criteria` of every question type also accept objects/arrays, not just strings, so a
question can carry `question`/`focus`/`ignore` fields and `true`/`false` descriptions with examples.

Errors: 401, 422 (validation), 429, 529. Retry 429/529 with bounded exponential backoff.

## 2. Measured speed and cost (the part that is genuinely excellent)

| | measured |
|---|---|
| Latency per call | p50 ~220 ms, p90 ~280 ms (25-line window, 7–11 questions) |
| Latency with 5.6× more input | p50 245 ms — essentially flat |
| Throughput | 686 calls in 19.9 s at concurrency 8 (~29 calls/PR ≈ 1 s per PR) |
| Tokens | ~570–720 input, ~125–196 output per windowed call |
| Price (operator-reported) | $0.04 / M input tokens, output free |
| Cost of a whole diff-only pass | ~$0.0008 per PR |
| Determinism | near-deterministic across replicates (score ±0.03) |

For comparison, the sonnet scout stage this was meant to replace added **~3.3 min and ~+20% cost to every
review** — the latency finding that made the scout opt-in in the first place. Jev removes that cost entirely.
The problem was never speed.

## 3. How to run an offline probe (the cheap instrument)

Every experiment below was a scratch script that: built windows from a diff, asked Jev N questions per
window, ranked windows, and compared the rank of the window containing a **known** defect site against
chance. That is the whole instrument, and it costs cents.

Metric used throughout: **mean rank/N** — the site window's rank among all the PR's windows, divided by the
number of windows. Random ordering gives ≈0.5; lower is better. Secondary: how often the site lands in the
top-12 (the engine's `MAX_LEADS`), and whether it survives `capScoutLeads`.

Ground truth used: the 13 M6 floor sites (`docs/benchmarks/m6-floor-cases.json`) and the 24 in-diff Martian
Cal.com goldens located during miss attribution.

Practical notes:

- Windowing that worked: non-overlapping 25 new-side lines inside each hunk, kept only when the chunk
  contains ≥1 added line; 25 also matches `compare.ts`'s ±25 line window.
- Redact before sending (`src/security/redact.ts` + `evidence-redaction.ts`). Authorisation to send diffs is
  not authorisation to send secrets found inside them.
- Read the key from the environment only, never a flag or a file in the repo.
- No 422 was observed up to 15.5k chars / ~5k input tokens in one state; the vendor publishes no limit.

## 4. Every arm we ran, and what it said

Sites = the known defect windows. All numbers are mean rank/N unless stated.

| # | Arm (one variable changed) | Result |
|---|---|---|
| 1 | 11 generic "is there a bug of kind X here" nouls, score = mean of top-2 | **0.28–0.31**, site in top-12 on 6–7 of the 9 PRs with ≥17 windows (chance ≈2) |
| 2 | Add the diff's removed (`-`) lines to the state | 0.27–0.29 — no change |
| 3 | Add ±25 lines of surrounding hunk context | 0.30 — no change |
| 4 | Add the **whole new file** as context, judge only the window | **0.37, worse**; top-12 11/24 vs 16/24. Windows of one file converge |
| 5 | Structured questions (`question`/`focus`/`ignore` + true/false criteria with examples) | Helps weak bare questions (0.36 → 0.29 on a 4-question set), but **no gain** over our own 11 questions (0.29 vs 0.31) |
| 6 | A single generic question instead of many | 0.39 — clearly worse than a multi-question ensemble |
| 7 | `choice` over a file's windows with a `noMatch` option | 0.39 on average, **but** it ranked #1–2 on two sites every noul arm missed. Complementary, not better |
| 8 | Rank-fusion (RRF) of arms 1/5/7 | 0.25–0.31; no combination clearly beat arm 1 at n=12 |
| 9 | 56 atomic checks from public rule catalogs (ESLint/typescript-eslint/SonarJS/CWE), max noul | 0.39; with per-PR normalisation (lift / z-score) 0.30 / 0.27 — i.e. **level with arm 1** |
| 10 | Same, scored per file instead of per window (a pre-filter) | Site file lands at ~0.32 of the file list; a skip gate loses 1–2 of 12 site files at 8% skip, 45% skip if you accept losing one |
| 11 | Wired as the engine's scout stage, measured on Martian Cal.com 10 (10 PRs, luna hunters) | gold TP 14 → 18, H+C 12/19 → 13/19, FP 14 → 19, wall +30%, hunter tokens +36% |

### What the numbers mean

- **The ranking signal is real but modest and it plateaus at ~0.30.** Four context variants, three question
  styles, two aggregations and a fusion all land in the same 0.25–0.31 band, and the run-to-run noise of the
  same arm is ±0.03. The ceiling is the diff-window unit (or the model), not the prompt.
- **Absolute scores are not thresholdable.** Site windows scored 0.21–0.82 while clean windows reached 0.83.
  Only *within-PR rank* carried information. Any design that needs a fixed cutoff (e.g. "act above 0.7") will
  either fire everywhere or miss most defects.
- **Per-check, the mechanical patterns are sharp.** "Is an object compared with `===`?" scored 0.66 at the
  real site vs a 0.11 PR mean (rank 1/15); "is one side of the comparison normalised and the other not?"
  scored 0.53 vs 0.08 (rank 1/50). Those are cases a deterministic linter can also decide, and a linter is
  free and exact.
- **The mechanism label is not trustworthy.** With an ensemble of questions, the argmax question at the site
  was a plausible description of the actual defect in only ~3–4 of 24 cases. A lead that carries the wrong
  question is worse than a lead that carries none.
- **Scout-as-stage bought recall the same way extra effort does.** In the Martian arm, Jev's own stage cost
  ~1.5 s and cents, but hunters spent +36% tokens chasing the leads and produced +4 gold TPs — the same
  exchange rate as simply giving hunters more budget, and ~40% of the apparent gain was run-to-run variance
  rather than the scout (established by re-reading both arms' artifacts).
- **Conversion, not ranking, is where it failed.** Miss attribution on that arm showed 13 of 20 missed
  goldens *were* inside Jev's top-12, 12 of them were actually delivered to a hunter's prompt, and in 7 of
  those the hunter drafted a *different* real bug in the same hunk. Pointing at a region biases attention to
  the region, not to the defect inside it.

## 5. Traps we hit (and the fixes)

- **A cap silently dropped the best lead.** `capScoutLeads` allows `MAX_LEADS_PER_PATH = 3`; one file had six
  high-scored windows, so the window holding a Critical `&&`/`||` inversion (raw rank 10/40) never reached a
  hunter. If leads are ranked, the per-path cap has to be part of the design, and the raw ranking must be
  persisted so a dropped lead is still on record.
- **Aggregating many questions by `max` is dominated by the noisiest question.** One check ("is this literal
  duplicated?") reads ~0.7 on ordinary code and won almost every window. Normalising each question against
  its own per-PR base rate fixed that — but we chose that normalisation *after* seeing the failure, which
  makes it a post-hoc choice, not a validated one.
- **Contamination is the easy mistake.** Our first atomic catalog was written by a worker whose instructions
  contained *our* examples, and two of those examples matched known goldens; the single golden that only that
  arm found was one of them. Build any such catalog from an external source, via someone who has not seen the
  evaluation set, and never edit it after seeing results.
- **Whole-file context makes ranking worse, not better.** Counter-intuitive and worth remembering before
  someone "improves" a diff-only stage by feeding it more.

## 6. Where Jev would still be a reasonable bet

Not in the recall path of this engine. But the properties that failed there (no prose, calibrated numbers,
~200 ms, ~$0.0008 per PR) are exactly right for **bounded decisions code already makes by rule**:

- **Admission / risk routing.** `src/ci/review-risk.ts` classifies a push by path globs, so anything under
  `src/**` is "high" and nothing is ever skipped semantically. A file-level Jev screen ranks the defect-bearing
  file into the top ~third; as a *priority* signal that is usable. As a *skip* gate it is not: at zero
  known-defect misses it skipped only 8% of files.
- **Triage before an expensive step.** Each refuter step costs real money; a cheap "is this finding a nit /
  a duplicate / would a senior author accept it?" screen could be measured against the refuter verdicts and
  the triage replies we already store, offline and for free.
- **Anything with a fixed option set and a human fallback.** Choice + `confidence` + a threshold + escalation
  is the shape the vendor's own cookbooks use, and the shape our data supports.

Two rules if it is ever wired in: **rank within a request, never threshold on absolutes**, and **never let
Jev's label become user-visible text**.

## 7. Reproducing this

Nothing from these experiments ships in the engine. The wiring that existed (a `jev` scout backend plus a
`PRHERO_SCOUT_BACKEND` modifier, with an injected-fetch client and offline tests) was written, measured, and
then set aside rather than merged; the Martian arm directories for it are on disk under
`~/Desktop/martian-cal/runs/cal-*-jev-scout`.

To redo an offline probe from scratch you need: a diff, the windowing above, one question set, the known
sites, and ~$0.10. Start by re-deriving arm 1 as a control **on the same day** as any new arm — the engine,
the prompts, and the model all move, and an arm compared against a stale control measures the calendar.
