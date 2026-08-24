# pr-hero vs. DoorDash — the audit

Written 2026-08-16. Closes the absorption of the two DoorDash engineering posts archived beside this file:

- `doordash-ai-code-reviewer.md` (2026-05-11) — product and architecture.
- `doordash-dashbench-trust.md` (2026-07-06) — DashBench, the measurement layer.

**Precedence rule (Juanma, 2026-08-16): where the two posts disagree, the later one wins.** They disagree
in one place — the May post's headline is a 60.2% acceptance rate; the July post demotes acceptance to
product telemetry because it fills two of four confusion-matrix cells. Every row below is read under that
rule.

**Second pass, same day — two more sources, and a different rule for them.** §7 absorbs
`cloudflare-ai-code-review.md` (Cloudflare, 2026-04-20) and `salesforce-prizm.md` (Salesforce Prizm,
2026-01-29). They are different organisations, so "later wins" does not apply across them: they
**triangulate**. Where three orgs agree, the claim hardens; where they differ, evidence is weighed, not
dated. Juanma's brief for this pass: *no sumar ruido* — extract what is useful to keep in mind. So §7 is
rows, and only three of them earned a roadmap amendment (item 5, item 7, C4).

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

## 7. Cloudflare and Salesforce — triangulation (added 2026-08-16, second pass)

Read with the header's rule: these are witnesses, not precedents. The state they were checked against is
the one after `ROADMAP-DOORDASH.md` M0–M2 (`git log` up to `b486a9b`), not the state §1–§6 describe.

**Where the topology sits, said once so it is not re-derived.** Cloudflare's system is pr-hero's shape —
specialist fan-out plus a judge pass — running at 131,246 reviews in 30 days, median $0.98 and 3m39s, 1.2
findings per review, 0.6% break-glass. Its "limitations we're honest about" (architectural awareness,
cross-system impact, subtle concurrency) are DoorDash's v1 diagnosis restated by a second, independent
team. So the fan-out has both a **floor** (it is a production-grade baseline, and ours is one) and a
**ceiling** (the class of miss both name), and the scout — `docs/scout-design.md`, awaiting ratification
— is aimed at the ceiling. **Nothing in either post contradicts the written M3 design**: bias-not-replace,
diff-only with `tools: []`, recall-first and fail-open, engine-owned prompt, 12-lead cap, led-vs-unled
computed — checked line by line, no conflict.

| Source and claim | pr-hero today | Status | Disposition |
|---|---|---|---|
| **CF: "What NOT to flag" sections** — "telling an LLM what not to do is where the actual prompt engineering value resides"; 1.2 findings/review is credited to them | Already there: `## Out of scope for this slot — do NOT emit these` in `deep-review-reliability.md:81` and `deep-review-lifecycle.md:260` of the production set; the refuter's scope is bounded the same way (`review-refuter.md:14`) | `built` | none. For the **scout prompt** (engine-owned, `prompts/scout.md`) it is the lever M4 reaches for if the restraint gate fails — a "what NOT to lead on" block. Not a design change: the design is recall-first on purpose; this is M4's iteration tool |
| **CF: risk tiers** — trivial ≤10 lines/≤20 files → 2 agents and a cheaper coordinator; lite ≤100 → 4; full otherwise or any security-sensitive path; costs $0.20 / $0.67 / $1.68 | The size gate (`size-gate.ts`) has ONE direction — too big → skip. Every PR that passes gets all five hunters, the refuter leg and the summarizer at full price; a three-line PR costs what a 1,400-line one does. `parity_trigger_paths` is the only path→behaviour routing | `partial` | **item 5 amended** (one paragraph). It changes what runs, therefore what is found → measured, and it must not land inside M6's window. DoorDash said the same ("skip expensive passes on low-risk PRs") without a mechanism; Cloudflare supplies one |
| **CF: three-level timeouts + inactivity detection** — per-task 5 min (10 for the heaviest), overall 25, retry budget ≥2; **60s with no output → kill**; heartbeat "model is thinking (Ns)" every 30s | Hard watchdog only (`step-runner.ts:361-367`, 30 min per step, 75 overall). The TTY heartbeat exists (`cli.ts:640`, `progress.ts`). Inactivity detection does not | `partial` | **#40**, comment: an output-inactivity kill is the mechanical half of "a turn counter is not a progress detector" and needs no prompt; DoorDash's soft wrap-up is the other half. Design them as one |
| **CF: error classification** — only retryable API errors trigger failback; auth, context overflow, abort, structured-output errors do not; `reason: "length"` → retry | `classifyFailure` = `transient | terminal | format`, format-retry capped at 1, truncated-draft guard (`step-runner.ts:135-147`, `:290-317`) | `built` | none — arrived at independently, same shape |
| **CF: failback chains per model family, circuit breakers, remote routing config with a provider kill switch (5s)** | One runner, one model per agent, no failback | `missing` | Phase D (D2 model routing) — audit row only; the mechanism is exactly D2's scope |
| **CF: shared context on disk; per-file patches; sub-reviewers read only their files; 85.7% cache hit** | The full patch is inlined into every hunter's user prompt (`pipeline.ts:277-290`) — five copies per review; the summarizer gets a sixth. The runner already RECEIVES `cache_read_input_tokens` / `cache_creation_input_tokens` and folds them into `tokens_in` (`usage.ts:15-18`, `:43-45`) — so our cache rate is measurable today and unmeasured | `partial` | **#23**, comment: split cache tokens out before touching the prompt shape. Where the diff lives (prompt vs file) changes hunter input, so it is a measured change after M6 |
| **CF: coordinator judge pass** — dedupe, re-categorise, reasonableness filter, verify with tools when unsure | Mechanical dedupe (`dedupe.ts`) + one detached refuter step per severe finding. Ours is stricter (per-finding, adversarial, cited disproof) and does not spread one session's attention over everything — the v2 risk DoorDash named, in the judge seat. **What ours lacks is re-categorisation**: the refuter rules on truth, never on class (the F003 case in 6b — `pre-existing` filed as `introduced`, corroborated without questioning the class) | `built` / `partial` | none now — the class question is a refuter-prompt change (lab set, immutable → new set, after M6). Already tracked as 6b's `misclassified` tag |
| **CF: prompt-injection prevention** — user-controlled MR body/comments/previous findings are wrapped in XML boundary tags and the tags are stripped from user content | Hunter prompts carry the patch only; gotchas read from the operator root (`pr-preflight.ts:9-11`); the summarizer sees the patch. Nothing inlines PR body or comments yet — **item 7's re-review and 6b's adjudicator will** (previous findings, the author's replies) | `missing`, latent | **C4 amended** (one paragraph): the boundary-tag rule belongs in the runtime-safety preamble the day any user-authored text is inlined |
| **CF: re-review rules** — fixed → omitted and thread auto-resolved; unfixed → re-emitted; user-resolved respected unless materially worsened; "won't fix"/"acknowledged" → resolved; "I disagree" → read the justification, resolve or **argue back**; 2.7 reviews per MR | Item 7 (design pending) + 6b (built): matcher keeps `persist` alive without reposting; tags `applied/dismissed/deferred/misclassified`; isolated adjudicator instead of the same reviewer arguing back | `partial` | **item 7 amended**: their rules as a second external reference. **CORRECTED 2026-08-20** — this cell also claimed *"a THIRD option for the open verify-vs-infer question — the coordinator judges 'fixed' with the prior findings in context (between 'pay a step per finding' and 'trust absence')"*. **RETRACTED**: read directly, `cloudflare-ai-code-review.md:369-384` never says how fixedness is determined, and "omit fixed findings" is equally consistent with inference from non-detection. Full correction in ROADMAP item 7 and `docs/item7-rereview-design.md` §0.7.1 |
| **CF: approval rubric biased to approve; break glass 0.6%** | Not a gate by design (B0; the disclaimer on every summary) | `deliberately-different` | none — reference for Phase E if a gate is ever built |
| **CF: AGENTS.md reviewer** — materiality tiers; penalises filler, >200 lines, tools without runnable commands | No staleness check on `.prhero/gotchas.md` / CLAUDE.md after material changes | `missing` | C6/C8 row only — the anti-pattern list is one more witness for DoorDash's "AGENTS.md is written for authors, not reviewers" |
| **CF: local operation** — same agents and prompts on the laptop | `pr-hero review` (B0) is exactly that | `built` / `ahead` | none |
| **CF: fire-and-forget telemetry that never blocks the pipeline** | `failSoftIngest` (`metrics.ts:8-11`) — a sqlite write must never fail a paid review | `built` | none |
| **CF: diff filtering** — lockfiles, minified, maps, plus `// @generated` marker scan; **migrations exempted** | Glob list only (`size-gate.ts:62-70`): lockfiles, `*.min.*`, `*.snap`; no marker scan, so no exemption needed yet | `partial` | item 5 row only; if a marker scan is ever added, carry the migrations exemption with it |
| **CF: ARG_MAX via stdin, JSONL streaming, per-attempt logs** | stdin bodies for `gh` (item 2), atomic tmp+rename artifacts, per-attempt logs | `built` | none — same scars, same fixes |
| **SF: intent reconstruction** — token-aware chunking into logical units, semantic consolidation, graph-based merge over dependencies/file overlap; related changes across the codebase reviewed together; progressive disclosure | Large PRs are skipped, not chunked (item 5). Findings are clustered post hoc by root cause (C1a); changes are never grouped pre-review | `missing` | item 5 row (one line): the other answer to "too big" is regroup, not skip. Not a build; a note that the option exists |
| **SF: context from work items, previous PRs, historical defects, codebase patterns** | Gotchas + priors; C6/C8 not built | `partial` | none new — a third witness (with DoorDash) that historical defects are the review-context source worth mining; C8 already says so |
| **SF: production feedback loop** — monitor production defects and incidents, find the patterns that should have been caught, feed them back | #41 mines reverts and got 3 usable cases across two repos | `partial` | **#41**, comment: the corpus is production defects, of which reverts are the narrowest slice — widen the query (bugfix PRs linked to issues, hotfix branches, PRs citing incidents). This is the only thing in either post that touches the track's actual bottleneck: the M6 metric has no cheap recall source |
| **SF: async analysis at PR creation, persisted, served instantly (≤5 min); left-shift into the IDE** | The watcher is async at PR open (B3); no IDE surface | `partial` | Phase E row only |
| **SF: posts summaries and conceptual groupings in the PR description** | Our summarizer posts general prose + a score (§2's tension row) | reference | none — a data point on the summarizer question: Salesforce's summary is a *navigation aid* (groupings) for the human reviewer, DoorDash warns against *general* notes; ours is the general kind |

---

## The numbers, for reference and not as targets

| | DoorDash production (scout + reviewer) | DoorDash no-scout baseline | Cloudflare (fan-out + judge) | pr-hero |
|---|---|---|---|---|
| Cost / PR | $3.91 | $0.65–0.75 | median $0.98, avg $1.19; full tier $1.68, trivial $0.20 | ~$3–4 |
| Latency / PR | 725s | 113–170s | median 3m39s, P99 10m21s | ~4 min run; end-to-end unmeasured |
| Weighted precision / recall | 87.0% / 53.6% | 84–90% / 20–31% | not reported — 1.2 findings/review and 0.6% break-glass are its quality signals (both two-cell) | not comparable — different metric, corpus, denominator |
| Cost / real finding | $0.82 | $0.48–0.60 | not reported | not computed (#23) |
| Acceptance (May post; telemetry only) | 60.2% settled high/critical, 59.0% webhook | — | — | `applied` rate is computable from `comparison_rows`; not a target |

pr-hero's cost and run time already sit inside DoorDash's staged band **without a scout**. That is the
plainest statement of where the money would go if C7 lands: coverage, at roughly their price.

Two caveats on the Cloudflare column, so the 3–4× gap is not misread as inefficiency: their dollars are
API dollars at 85.7% cache hit across 5,169 repos, ours are subscription dollars with ~$0 marginal (Phase
D's economics note); and their sub-reviewers read per-domain patch files while ours hunt the whole repo
through codegraph and pay a refuter step per severe finding. Different dollar, different job. What the
column does say plainly: **risk tiering and shared context are the two levers behind their price**, and we
have neither.

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
