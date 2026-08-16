# pr-hero vs. DoorDash — the audit

Written 2026-08-16. Closes the absorption of the two DoorDash engineering posts archived beside this file:

- `doordash-ai-code-reviewer.md` (2026-05-11) — product and architecture.
- `doordash-dashbench-trust.md` (2026-07-06) — DashBench, the measurement layer.

**Precedence rule (Juanma, 2026-08-16): where the two posts disagree, the later one wins.** They disagree
in one place — the May post's headline is a 60.2% acceptance rate; the July post demotes acceptance to
product telemetry because it fills two of four confusion-matrix cells. Every row below is read under that
rule.

## What "pivoting toward DoorDash" means, and what it does not

Juanma's call, 2026-08-16: *"vamos a pivotar hacia esa dirección"* — and, the day before, *"primero vamos
a estabilizar y resolver toda la bola que tenemos y aprendimos"*. Both hold. The pivot adopts their
**mechanisms and postures**. It does not adopt:

- **Their numbers as targets.** 53.6% weighted recall, $3.91/PR, 725s latency are read as reference points
  on a different corpus with a different metric. ROADMAP C7 records that comparing their weighted recall
  to this project's 0.33 is meaningless; that stays true for every number in this file.
- **Their scale.** DashBench is ~1,000 candidates narrowed to 105 adjudicated cases with per-PR author
  annotation — a team-months instrument. The shape is portable, the size is not, and the constraint that
  closed Phase A was time.
- **Their placement.** The scout stays Phase C (ratified 2026-08-16). Stabilise the built surface first,
  then build in this direction.

Every row that reads `deliberately-different` is a solo-operator-budget choice, not a deficiency. An audit
that reads every difference as a gap would cargo-cult a 10,000-PR/week organisation's tradeoffs into a
one-person tool.

## How to read the tables

| Status | Meaning |
|---|---|
| `built` | pr-hero has it; evidence cited |
| `partial` | the mechanism exists but a named half is missing |
| `missing` | not present; disposition names where it landed |
| `ahead` | pr-hero has something DoorDash lists as future work or lacks |
| `deliberately-different` | a conscious choice with a stated reason; no action |

**Disposition** is where the gap lives, if anywhere: an issue number, a ROADMAP entry, or `none` with the
reason. The reasoning behind each disposition is IN the issue or the roadmap entry — this file indexes, it
does not re-narrate. Two views of the same argument drift, and the one that drifts lies (ROADMAP item 6).

---

## 1. Architecture and attention

| DoorDash | pr-hero today | Status | Disposition |
|---|---|---|---|
| **Lead scout in front of deep reviewers** — noticing split from verifying; the scout emits leads and filters what needs no scrutiny | Every hunter receives the full patch as its prompt (`pipeline.ts:277-290`, `:456`) and scans the whole diff plus repo. No lead stage. This is their abandoned **v1** topology, and our zero-overlap measurement (ROADMAP, THE PIVOT) corroborates their diagnosis | `missing` | **C7** — with the measured tradeoff (+75% relative weighted recall, flat precision, ~5x cost, ~4x latency) and two design constraints recorded there |
| **Disprove-it pass** — every finding must survive an explicit falsification step before posting | The refuter: detached, read-only, one step per severe finding, `refuted` requires positive disproof with cited code (`pipeline.ts:536-702`; contract `:261-267`) | `built` | none — independently arrived at; C7 notes it is the verifier a recall-first scout needs |
| **Precision over recall** as the stated posture; "a reviewer that's muted catches nothing" | B0's assistant-not-gate framing; the not-a-merge-gate disclaimer on every posted summary (`report.ts:405-412`); measured profile "high precision, narrow coverage" | `built` | none |
| **Full codebase access, not just the diff** — trace callers, find siblings, read tests | Detached worktree per PR + its own codegraph index; hunters read the whole repo, so out-of-diff findings are not an edge case (ROADMAP item 6) | `built` | none |
| Runs on **remote VMs** | Runs on the operator's machine, worktrees under `~/.prhero/` | `deliberately-different` | Phase E's GitHub Action is the remote path; local is the product today |
| **Focused context beats more context** — AGENTS.md is written for authors, not reviewers | Gotchas are human-signed, required, fail-loud on empty (`cli.ts:465-479`); `suspicion_priors` in `.prhero/config.json`; both templated via `{{PRIORS}}`/`{{GOTCHAS}}` (`prompt-set.ts`). Curated, but not filtered by their three questions and not mined from PR history/incidents | `partial` | **C8**; the three-question curation filter over existing gotchas is a $0 first step |
| **Per-domain review profiles routed by touched path** — payment PR loads payment doctrine and nothing else | `parity_trigger_paths` routes ONE decision (spawn parity or not: `pipeline.ts:209-243`). No doctrine routing; every hunter gets the same gotchas | `partial` | **C8** — generalise "which agent runs" to "which doctrine each agent reads"; design together with C5/C6, they share the prompt slot |
| **Model-agnostic**; swap models per stage, evaluate on the same eval set | `AgentSpec.model` per agent exists (`spec.ts`); one runner, `ClaudeCodeRunner`; `StepRunner` interface documents the OpenCode obligations | `partial` | Phase D (D1 runner, D2 routing, D3 fan-out arm) |
| **Cost tunable by stage** — cheap models for simple steps, strong for verification, skip passes on low-risk PRs | Per-agent model knob exists; no per-stage skip on low risk (the size gate is a cost/predictability gate, not a risk gate: `size-gate.ts`); no measurement to decide tiering with | `partial` | **#23** (cost per successful review, retry-reason breakdown, model per agent) |
| Isolation of the reviewing agent | Read-only tool allow-list, `--strict-mcp-config`, `--setting-sources ""`, driver owns all writes; tests assert the flags (CLAUDE.md rule 4) | `built` | none — a threat model, not a preference |

## 2. Reporting and trust

| DoorDash | pr-hero today | Status | Disposition |
|---|---|---|---|
| **Correct findings can still be bad comments** — anchored to a changed file and line, concrete behaviour at risk, where to start; if no action point, keep it out or drop it | Findings carry `path`, `line`, `claim`, `proof_refs`; the comment renders an evidence block with permalinks (`report.ts:554`). The hunter output contract (`pipeline.ts:248-259`) requires none of: a behaviour-at-risk sentence, an action point, or non-hedged language | `partial` | **#19** — the postability rule, orthogonal to severity; corpus check first ($0) |
| Weak "consider checking" language erodes trust | No anti-hedge rule anywhere in the contract | `missing` | **#19** |
| **Never post a false-clean review** if the analysis found issues | Every-hunter-died → no post, no comparison (`cli.ts:1327`, `:1954`, `:1237-1243`); empty gotchas → refused before spawn. **But** a partial run with zero findings prints "✅ found nothing to report" with `partial` only in the `<sub>` footer (`report.ts:380-382`, `:410`) | `partial` | **#42** (new, found by this audit) |
| **Reconcile stale findings when a PR changes during review** | The review POST pins no `commit_id` (`pr.ts:752-777`); the 422 path (`:781-800`) recovers a vanished line, not a moved-meaning one | `missing` | **#39** (pinning) + **item 7** (reconciliation policy) |
| **Collapse old comments during re-review** — the author sees the current state | Cross-run identity via `<!-- pr-hero-finding -->` markers and a path+line-window matcher (`pr.ts:791`, item 6); a `persist` finding is never reposted. Not stated as an acceptance criterion and not tested from the reader's side | `partial` | **item 7** amendment 1 |
| No duplicate comments across re-reviews | Same matcher; direction of error is under-match (a duplicate is visible, a suppressed new finding is not) | `built` | none |
| Comments anchored with quoted evidence | `proof_refs` + evidence block + `head_sha`-pinned permalinks | `built` | none |
| One idempotent summary, refreshed not stacked | `<!-- pr-hero-report head=<sha> -->` marker, PATCH in place (ROADMAP item 2) | `built` | none |
| Trust preserved enough that teams enable it **without being mandated** | Opt-in is structural: `~/.prhero/watch.json` lists exactly the repos the watcher may spend on; `post` per repo, OFF by default | `built` | none |
| Findings tell the author what to do next | Tier (blocking/advisory) is the scan aid since `ef41f3a`; the triage loop (6b) makes every finding answerable | `built` | none |
| **"Broad summary notes … erode trust"** — one of the three named comment failure modes | A summarizer step is **on by default** (`preflight.ts:1228-1230`, `:1337`), spawned per review, producing "2-4 general sentences about the change" plus an advisory 1–5 score with a reason (`pipeline.ts:269-275`). The score is a Greptile-shaped element (item 6 measured Greptile's confidence score); the article argues against exactly this class of comment. Opt-out exists (`--no-summary`, `summary.enabled: false`) | **tension** — a product call, not a defect | Juanma decides: keep default-on, flip default-off, or keep the prose and drop the score. Whatever the call, it changes what is posted, not what is found — safe to land any time in `ROADMAP-DOORDASH.md`. Added by this audit's second pass 2026-08-16 |

## 3. Runtime lessons from production

| DoorDash | pr-hero today | Status | Disposition |
|---|---|---|---|
| **A turn counter is not a progress detector** — per-agent soft AND hard timeouts; the soft one asks for verified findings only | One tier: the hard watchdog kill (`step-runner.ts:361-367`). Everything a stuck step verified dies with it | `partial` | **#40** |
| **The cheapest model is not always the cheapest review** — count cost per successful review; weak models retry on complex schemas | Failure classification exists: `transient | terminal | format`, format-retry capped at one (`step-runner.ts:135-147`, `:290-317`), classification written to per-attempt logs (`:443`). `PerAgentUsage` and the metrics store carry only `attempts` + `status` — the reason is not aggregated | `partial` | **#23** — carry the breakdown into `run_agents` |
| Structured JSON output validated, retried on invalid shape | `drafts.ts` validation, truncated-draft guard, format-retry | `built` | none |
| Bounded result beats a discarded run | See #40; today a watchdog kill is a failed step | `missing` | **#40** |

## 4. Measurement — where the second post rewrote the first

| DoorDash (July post wins) | pr-hero today | Status | Disposition |
|---|---|---|---|
| **Acceptance is product telemetry, not ground truth** — it fills TP/FP only, never FN/TN; authors accept and reject for workflow reasons | Triage writes `applied/dismissed/deferred/misclassified` + reasoning + `actor` into `comparison.json` → `comparison_rows` (`metrics.ts:176-200`). Recorded as verdicts, not as TP/FP. The `misclassified` tag exists precisely because "author disagreed" ≠ "engine wrong" | `built` (as telemetry) | **#19/#23** carry the dated correction: never name a column `true_positive` |
| **The instrument cannot see what was missed** | The Greptile head-to-head buckets Greptile-only / pr-hero-only / both — the same two-cell shape. Five PRs both passed clean are five unobserved cells, not zero false negatives | `partial` | **C10** |
| **Reverted/hotfixed PRs as known-bad cases** | Not mined | `missing` | **#41** — free labels, `gh` only, corpus construction not experiment |
| **Benign PRs to measure restraint** — "loud on clean code is its own failure mode" | Five exist on disk from the first head-to-head; not curated as a set; zero FPs measured on them | `partial` | **C10** |
| **Triangulated labels** — author annotation, original findings, agentic judge; humans adjudicate disagreements; resolved cases calibrate the judge | Per finding: Greptile, pr-hero, the author's agent (argument), an isolated adjudicator (verdict), a human as objector (6b). Three-plus sources on what was FOUND; nothing on the FN cells. `misclassified` is the engine-defect signal but feeds no calibration loop | `partial` | **C10** (shape), **C6** (feeding lessons back with provenance) |
| **Small eval set from real misses and incidents, not synthetic puzzles** | The lab's goldens were real audited Greptile findings — retired (contaminated). `fixture-eval` is a planted synthetic bug; `refuter-probe` plants claims with known verdicts | `deliberately-different` for now | **C10** — the head-to-head accumulates the real-miss corpus (PR 1677 is specimen one); `refuter-probe` is a judge-calibration set in their sense |
| **The judge is a calibrated signal, not ground truth**; moving to an **agentic jury** | Refuter is a single adversarial judge; judgment-day (blind dual review) exists as a dev-workflow skill, not inside the engine's eval | `partial` | **C10** item 5 |
| **Variance is a feature** — aggregate over replicates or a single run understates coverage | The lab ran N-of-M replicates; production reads and the re-review delta read ONE run (item 7: "infer fixed from absence") | `partial` | **item 7** amendment 3, **C10** item 3 |
| **Multiple metrics, severity-weighted**; a single score is misleading by construction | Ledger reports counts, three buckets, verdicts tallied as-is, "no percentage theater on small denominators" (ROADMAP B4). No severity weighting, no cost per real finding, no latency | `partial` | **C10** item 4 (weighting after #19), **#23** (cost/real finding, latency) |
| **The harness is part of what is measured** — runner kind, tool surface, context mechanics, provider limits, cost, latency, timeouts, retries recorded per run | `pipeline.json` records steps, per-step model, engine identity, prompt-set fingerprint; telemetry per agent (tokens, cost, attempts, status, duration). Timeouts and retry reasons only in per-attempt logs | `partial` | **#23** |
| **Benchmark against external code-review solutions** — listed under "what's next" | The Greptile head-to-head runs in-process on every `review --pr` and has since THE PIVOT | `ahead` | none |
| An adversarial triage loop where the author's agent argues and an isolated adjudicator rules, human as objector | 6b — no DoorDash analog described | `ahead` | none |
| Continuous eval harness that measures every change against a growing corpus | Not built; the first post put it in the roadmap, the second says what shape it should have | `missing` | **C10** — the open decision (DashBench-shaped corpus or plain tally) is Juanma's |

## 5. Product loop

| DoorDash | pr-hero today | Status | Disposition |
|---|---|---|---|
| **Automatic trigger on PR open**; ~7 min to first comment, before a human looks | `pr-hero watch` (B3): tick model, opt-in per repo, daily cap, serial drain ~4 PRs/hour by design. Run ≈ 4 min; end-to-end PR-opened → posted latency is not recorded | `partial` | **#23** (latency column; also the missing input for the deferred `reviews_per_tick` decision) |
| **~$3 per review** | ~$3–4 per PR (THE PIVOT); cost band shown before every spawn, confirm required | reference only | none — the confirm and the band are `deliberately-different` (solo budget) |
| **The fixer loop** — tag the agent in the thread, it fixes in an isolated worktree and pushes | Not built. The nearest thing is 6b's `applied`: the consumer's own agent fixes and replies; pr-hero does not push code | `missing` | **Phase E** — must inherit 6b's consumer-side split so pr-hero stays a reviewer |
| Anyone can ask for a change in the PR thread | Triage replies bind to findings by `in_reply_to_id`; `pr-hero triage reply` posts and resolves the thread | `partial` | Phase E |
| Size / cost gate | 1500 lines / 150 files, generated content excluded, escape hatches | `deliberately-different` | none — a cost gate, explicitly not a quality one |

## 6. Hunt doctrine — the three classes humans skim

| DoorDash | pr-hero today | Status | Disposition |
|---|---|---|---|
| **Deletions** — every deletion is a prompt: who depended on this? | Not hunted as a class; no hunter owns it. `changedPathsFromDiff` even skips deleted files for parity triggering (`pipeline.ts:205-208`) | `missing` | **C9** item 1 — cheapest to try, no existing owner |
| **Cross-boundary drift** — one side of a boundary updated, the sibling not | `parity` hunter, conditional on `parity_trigger_paths` | `partial` | **C9** item 2 — is the trigger list the right gate? |
| **Silent behaviour changes** — same signature, different behaviour; swallowed errors; cache-miss/error inversions | Split across `lifecycle` and `reliability`; owned as a named class by neither | `partial` | **C9** item 3 |

Constraint on all three: scored prompt sets are immutable — a new set, `refuter-probe` first, one variable
per arm (CLAUDE.md rules 5 and 7).

---

## The numbers, for reference and not as targets

| | DoorDash production (scout + reviewer) | DoorDash no-scout baseline | pr-hero |
|---|---|---|---|
| Cost / PR | $3.91 | $0.65–0.75 | ~$3–4 |
| Latency / PR | 725s | 113–170s | ~4 min run; end-to-end unmeasured |
| Weighted precision / recall | 87.0% / 53.6% | 84–90% / 20–31% | not comparable — different metric, corpus, denominator |
| Cost / real finding | $0.82 | $0.48–0.60 | not computed (#23) |
| Acceptance (May post; telemetry only) | 60.2% settled high/critical, 59.0% webhook | — | `applied` rate is computable from `comparison_rows`; not a target |

pr-hero's cost and run time already sit inside their staged band **without a scout**. That is the
plainest statement of where the money would go if C7 lands: coverage, at roughly their price.

## Build order

**Superseded the same day by `ROADMAP-DOORDASH.md`** — roadmap 2, the authoritative sequence (M0–M7, then
the splice into `ROADMAP.md` item 7). Juanma's decision after this audit: all DoorDash-derived changes
first, as their own track, with the scout designed, probed and A/B-tested BEFORE item 7 — because item 7's
discovery half must be built for the pipeline we will actually have. This file stays the index of WHAT and
WHERE; that file owns WHEN. One view of the order, on purpose.

## Index of dispositions created or amended by this absorption

- Issues: **#39** commit_id pinning · **#40** soft timeout · **#41** reverted-PR corpus · **#42**
  partial-run false-clean · **#19** and **#23** enriched with dated, append-only corrections.
- ROADMAP: header (references + precedence rule) · Phase B item 7 (three amendments + the variance
  update) · Phase C **C7 scout**, **C8 review profiles**, **C9 hunt doctrine**, **C10 measurement layer**
  · Phase E fixer loop.
- Docs: the two archived posts, this audit.
