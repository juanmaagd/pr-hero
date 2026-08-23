# Item 7 — the re-review, designed

Written 2026-08-20 with Juanma, immediately after M6 closed as `opt-in` and unblocked splice condition 3.
Governs `ROADMAP.md` Phase B item 7. Status: **DESIGN. No engine code has moved.**

> ## ⚠️ JUDGMENT: round 3 complete — fixes applied; ready for scoped re-judgment or APPROVED pending your call
>
> Read `docs/item7-judgment-ledger.md` — rounds 1–2 frozen; **round 3 appended below**. §§0-2 stand.
> §3 rewritten 2026-08-21; round 3 found 2 confirmed CRITICAL-class (R2-S5, R2-C3-A), 1 confirmed by
> judge A (deferred eviction), plus WARNINGs — **round 3 fix pass applied** (R3-F1..F8 in ledger).

The gate this design does NOT satisfy: splice condition 1 (M1 `#42`/`#39` seen live) is still open — §6.
Design is not implementation; the build waits.

**Judgment Day, round 1 — 2026-08-20.** Two blind judges read this document in parallel against the engine
source. Thirteen findings were confirmed by both independently; two single-judge suspects were authorised
on top. Fifteen corrections were applied in place, and every one of them is visible: this project does not
delete a wrong claim, it retracts it with its reason and leaves the retraction where the claim was.

This file follows the `docs/c4-preamble-design.md` layout because that one worked: terrain first and
verified, decisions second, mechanisms third, a done-checklist with one named test per obligation.

---

## THE STRATEGY, in one page — read this first

Added 2026-08-20, after Juanma: *"tenemos que tener claro cómo lo haremos, evitemos confusiones,
conflictos, contradicciones … podemos sacar un poco de todos lados."* This section is that statement.
Everything below it is evidence, mechanism and test for what is claimed here. **If a later section
appears to disagree with this one, this one is right and the later section is the bug** — fix it there,
never work around it.

### The whole thing in one sentence

A re-review is **two jobs over two different inputs**: *verify* what we already said (refuter-shaped,
over prior findings) and *discover* over what changed (hunter-shaped, over the delta). Everything else in
this document is how a thing gets routed into one, the other, or neither.

### The three rules that generate every case

Written as rules rather than as a case list on purpose: a case list runs out, a rule does not. When a
case appears that this document did not foresee — and one will — apply these in order and do **not**
reopen the design.

1. **Deterministic before model.** If git can answer, git answers; a model is spawned only where no
   mechanical answer exists. `code unchanged → defect unchanged` is stronger evidence than any single LLM
   sample, and §0.6 is the receipt.
2. **The direction of error is always visible noise over invisible loss.** In doubt, the finding stays on
   the PR.
3. **No word claims more than what was checked.** `resolved` is emitted only when the defect was
   **checked**: either a verification step returned `refuted`, or git deterministically shows the code is
   **gone** (the file was deleted by the delta). Everything else that merely failed to recur is
   `unconfirmed`. The deleted-file case qualifies because something *did* check — git did. That is rule 1
   and this rule agreeing, not conflicting, and it is the ONE rule; §§3.2/3.3/3.8, D7, O-1 and test O-1a
   all restate this sentence and none of them may narrow or widen it.
   *Corrected 2026-08-20 (judgment round 1, C1): four sites carried four different versions of this rule
   — "requires a verdict", "`refuted` is the only path to the word", "verdict or file deletion", and two
   gate rows that emitted it with neither. The version above is now the only one.*

### What we take from whom, and what we refuse

| source | adopted | refused, and why |
|---|---|---|
| **Cloudflare** (`cloudflare-ai-code-review.md`) | the five re-review rules; prior findings and author replies as prompt input wrapped as untrusted text; re-open on worsening | *"won't fix"/"acknowledged" → resolved* (our `deferred` demands a real destination); the coordinator arguing back itself (6b keeps the adjudicator isolated); re-emitting unfixed findings (GitLab DiffNote mechanics — see below) |
| **DoorDash, May** (`doordash-ai-code-reviewer.md`) | the author sees current state, not the pile; reconcile when the PR moves during a review (the `commit_id` pin does it — §3.9, and item 7 adds nothing there); never post a false-clean review (mechanised in §3.8.1); no duplicate comments across re-reviews | the literal collapse/minimize mechanism — we reach the same reader outcome another way (see below) |
| **DashBench, July** (`doordash-dashbench-trust.md`) | variance is structural, so absence is not evidence; deterministic matching **plus** a semantic tier; an author's action is not ground truth | acceptance rate as a success condition (their own July post demotes it) |
| **RADAR** (`2605.md`) | the posture of not acting on something that has not moved → case B (`L === H`) | the hard eligibility gate; refusing to review a moving PR would make an assistant useless |
| **ours, no precedent** | the deterministic change gate, the two deltas, identity as an unordered proof-ref set, one refuter step per finding | — |

### The three apparent conflicts, RESOLVED — not noted

A noted divergence is a future argument. These are decided.

1. **Re-emit vs don't-repost is GitLab vs GitHub, not a difference of judgement.** Cloudflare must
   re-emit an unfixed finding because its MCP server reads the re-emission as "keep the thread alive"
   (`:379-380`). On GitHub a thread stays open until someone resolves it, so **not posting already keeps
   it alive.** What their mechanism buys that silence does not: the author learns the finding was
   re-examined *this* round. **Resolution: we do not repost the comment, and the summary lists every
   `carried` finding with its status.** That is now part of O-2, not an optional nicety.
2. **"Collapse old comments" — we satisfy it by construction; we do not decline it.** On GitHub,
   resolving a thread *is* collapsing it, and §3.9 resolves every verified-fixed thread. And there are no
   superseded comments to hide, because we never repost — the pile never accumulates in the first place.
   §4 previously worded this as declining DoorDash's mechanism; that was wrong and is corrected there.
3. **The semantic judge enters with zero risk, because a judge-proposed match is not a match — it is a
   verification trigger.** DashBench uses deterministic matching plus an LLM judge where semantics are
   needed (`:248-249`), and §3.4 is deterministic-only. The fear was an over-matching judge hiding a live
   defect behind a `carried`. That can only happen if the judge's output *classifies*. It does not:
   a judge-proposed match feeds **phase E (§3.2)** and forces a verification step. **The judge can never
   retire a finding; the worst it can do is spend one step.** Deterministic identity remains the only
   thing that classifies, and rule 2 is preserved intact.

And the one real gap the sources exposed, now closed mechanically rather than left open: Cloudflare's
*"respected unless the issue has materially worsened"* (`:381`) — **worsened means a new finding at the
same identity carrying higher severity than the suppressed one.** No new judgement, no new model.

### What is ours, and must never be cited as anyone's practice

**Delta-scoped discovery (§3.1.1) and O-5's "cheaper than today" have no precedent in any archived
source** (§0.7.2). Cloudflare's "incremental" is findings-awareness, not diff-scoping, and its cost
tables never split initial from re-review. This is our bet. It gets proven with our own numbers or it
gets dropped; `--full` is the escape hatch and the default can flip if a measurement says so.

---

## 0. The terrain, verified 2026-08-20 — read this before disagreeing with §3

Every claim below was read out of the code or off an artifact this session. Two ROADMAP claims did not
survive the reading and are corrected in §0.5.

### 0.1 The matcher is three classifications, and one of them is an inference

`MatchResult` — `src/inline.ts:190-197`. Exactly three members, no others:

| member | meaning | source |
|---|---|---|
| `persist` | matched to a prior comment — nothing to post | `src/inline.ts:192` |
| `fresh` | no prior comment matched — posts as new | `src/inline.ts:194` |
| `resolved` | a prior comment with nothing matched to it this run | `src/inline.ts:196` |

`resolved` is computed at `src/inline.ts:321-322` as, literally:

```ts
const matched = new Set(persist.map((match) => match.posted));
const resolved = input.posted.filter((posted) => !matched.has(posted));
```

Set subtraction. Nothing reads the code. Nothing re-checks the defect. **`resolved` is repair deduced from
non-detection**, which is the defect this item exists to remove.

The matching key (`candidatesFor`, `src/inline.ts:220-270`) is three layers, not a fingerprint:

1. **path gate** — `posted.livePath ?? posted.marker.path` must equal `finding.path` (`:229`).
2. **same-head branch** (`:231`) — exact stored `line` **and** `marker.c === claimFingerprint(finding.claim)`
   (`:254-255`). A stored-line hit with a fingerprint mismatch is dropped entirely, never demoted into the
   windowed pool (`:258`). The trade is documented at `:232-253`: visible duplicate over invisible miss.
3. **different-head branch** — `|liveLine ?? marker.line − finding.line| ≤ FINDING_LINE_WINDOW` where the
   window is **5** (`src/inline.ts:166`), deliberately narrower than `compare.ts`'s 25.

Exact outranks windowed (`:269`); ties resolve to post-fresh unless exactly one tied candidate's
fingerprint matches (`resolveWinner`, `:286-297`).

Consumers of `resolved`: the delta counts (`src/inline.ts:379-384`) and two log lines
(`src/cli.ts:2258`, `:2261`). **Nothing else.** No thread close, no comment edit, no collapse.

The `Δ N resolved` line is `deltaLine`, `src/report.ts:596-601`.

### 0.2 "The last reviewed head" already exists on the PR, and has no consumer

- The summary comment's marker is `<!-- pr-hero-report head=<40hex> -->` — `src/pr-preflight.ts:302-304`,
  matched on bare prefix by `findMarkedCommentId` (`:313-323`).
- It is read back as `previousHeadSha` at `src/cli.ts:1738-1743`.
- Its **only** use today is decorating the Δ line (`src/cli.ts:1859`, `:1965`; `src/report.ts:596-601`),
  plus the watcher's "already paid for this head" guard (`src/watch-preflight.ts:514-546`).
- The registry does not hold it: `WorktreeStamp` is `{ last_review_at: string }` — a timestamp only
  (`src/home-preflight.ts:206-216`).
- The review range is unconditionally `merge-base(base, head)..head` —
  `resolveDiffFrom` at `src/cli.ts:2687-2712`, `git diff <diffFromSha>..<headSha>` at `src/cli.ts:1057`.
  **There is no `lastReviewedHead..head` path anywhere in the engine.**
  **Read the next four lines too** (corrected 2026-08-20, judgment round 1, C6): that diff is followed
  immediately by two hard aborts — `CliError(emptyDiffMessage(...))` when the diff is empty
  (`src/cli.ts:1059-1060`) and `CliError(allExcludedMessage(...))` when the exclude globs eat it
  (`:1070-1072`) — both **before** the run directory, the size gate and the pipeline exist. Citing
  `:1057` alone made an empty delta look survivable. It is not, today, and §3.1.1 has to say what a
  re-review does instead.

The consequence that shapes D2: item 7 needs **zero new persistent state**. The state exists, is durable,
travels with the PR, and already survives a different machine and a CI runner. It only lacks a reader.

### 0.3 The verification half's machinery already exists — as the refuter

`runRefuter`, `src/pipeline.ts:922-1123` (ROADMAP says `536-702`; drifted — §0.5).

- **One step per finding**, never a batch (`:910-921`, `:981-1027`). `refuter-batch.json` is an audit
  manifest only (`:937-951`).
- **What is inlined**: `refuterPrompt(oneJson, nonce)` (`:433-457`) over a **one-element array** of
  `{id, location: "path:line", severity, claim, proof_refs}` (`:982-994`). Content travels inline because
  the tool surface is read-only (`:1002-1003`), wrapped in the run's nonced boundary tags
  (`wrapBlock("finding", nonce, batchJson)`, `:437`). A finding whose content forges the nonce is never
  spawned and lands `inconclusive` (`:995-998`, `:1100-1103`) — C4 already covers this leg.
- **Isolation**: `buildStepArgv`, `src/step-runner.ts:152-201` — `--strict-mcp-config`,
  `--setting-sources ""`, no Write/Task, tools read off the agent file's frontmatter (`:1005`).
- **Output contract** — `REFUTER_OUTPUT_CONTRACT`, `src/pipeline.ts:373-379`:
  `{"results":[{"finding_id","outcome":"corroborated|refuted|downgraded-latent|inconclusive","proof_refs"}]}`.
  Verdict semantics are stated by the **engine**, not the prompt set (`:439-453`), and `inconclusive` is
  explicitly "not a polite `refuted`".
- **Verdict → tier**: `finish()`, `src/pipeline.ts:1331-1351` → `deriveTier`, `src/findings.ts:365-381`.
  Absent id defaults to `not_submitted`; `refuted` removes the finding into `debug.refuted[]`.

This is the exact **shape** item 7's verification half needs — one step per finding, nonced boundary tags,
read-only tools, engine-owned verdict vocabulary — and that machinery is already built, isolated, tested
and priced. **`runRefuter` is not re-entrant** (judgment round 1, C3): item 7 does **not** call it twice in
one run. Item 7 builds **`runVerify`** — a **new** namespaced caller that follows the refuter's step shape
and isolation posture, with its own ids, artifacts, verdict map and `per_agent.verifier` entry (§3.4).

### 0.4 Triage exists, and the matcher is blind to it

- `TriageTag` is four tags — `applied | dismissed | deferred | misclassified` (`src/triage.ts:26-33`),
  deliberately not the `refuter_verdict` enum (`:21-26`).
- Marker `<!-- pr-hero-triage tag=… head=… actor=…[ issue=…][ verdict=…] -->` (`src/triage.ts:136-168`).
  `applied` **forbids** `verdict`; the other three **require** it (`:66-70`, `:146-157`, `:217-237`).
- `applied` → `row.verdict = "applied"`, with no adjudicator and no verification
  (`composeVerdict`, `src/triage-write.ts:118-124`).
- **`src/inline.ts` does not import `parseTriageMarker`** — verified this session by search. A finding the
  author marked `dismissed` re-matches, persists, and keeps its blocking tier exactly like an untouched
  one. Cloudflare's *"user-resolved → respected"* does not happen at all today.

### 0.5 Two ROADMAP claims that did not survive the reading

1. **`ROADMAP.md:1099` says `postPrReview` "sends no `commit_id`". It does** — `src/pr.ts:1107`,
   `commit_id: input.headSha`, with the rationale at `:1087-1106`. Issue #39's *pinning* half is BUILT.
   Only the *policy* half is this slice's. Designing against the stale line would have rebuilt a fix
   that shipped.
2. **Line refs drifted.** `pipeline.ts:536-702` → `runRefuter` is `src/pipeline.ts:922-1123`.
   `pr.ts:735-801` / `781-800` → `postPrReview` is `src/pr.ts:1069-1156`, its 422 recovery `:1136-1155`.

### 0.6 THE PR 1759 PAIR — the evidence that decides D1, and it is ours

Two auto-launched runs on musive PR 1759, head `8da9fad5bc9f650df38fc8cb0237253d80ff3245`, **16 minutes
apart**, on disk at `~/.prhero/repos/github.com/musivetech/musive/runs/pr-1759-8da9fad5-{2,3}`.

Same tree. Prompt set byte-identical: `slice3b-lifecycle-v6-clean`, `sha256 5ac28df9bddbd4c8`, both runs.
Engine revision `bbd5277` vs `f9cd970` — and `f9cd970` is **docs-only** (`git show --stat`: one file,
`docs/c4-preamble-design.md`). **The executable engine is identical.** Both runs `status: complete`.

Both runs found the SAME two defects — a fail-open error branch that never disarms an `isLoading` gate.
Both emitted them as two findings. And the two runs cannot be paired by anything the engine currently has:

| | run -2 | run -3 | same defect? |
|---|---|---|---|
| defect A | `F001` @ `app/hooks/publicLinks/useRetrivePublicLinks.ts:36` | `F002` @ `app/pages/publicLinks/index.tsx:64` | **yes** |
| defect B | `F002` @ `web/src/views/PublicLinks/index.tsx:81` | `F001` @ `web/src/views/PublicLinks/index.tsx:99` | **yes** |

Why every existing key fails:

- **`finding.path:line`** — defect A moved file entirely (producer site → consumer site). Defect B stayed
  in one file but moved 81 → 99, and `|99−81| = 18 > FINDING_LINE_WINDOW = 5`.
- **`c=` claim fingerprint** — "resolves to an error" vs "resolves to a non-ok R…". Same defect, different
  `sha256(claim)`. The trade at `src/inline.ts:232-253` predicted exactly this.
- **`root_cause_id` (C1a)** — anchors on the **first** `proof_ref`. Run -2 emitted `(producer, consumer)`;
  run -3 emitted `(consumer, producer)`. **The order flipped**, so the anchors are different files.
  This falsifies C1a's stated assumption that "the hunter output contract already orders them
  `["producer path:line", "consumer path:line"]`" — not as a prompt-set defect, since the set is
  byte-identical across the pair, but as an ordering that is simply not stable run to run.

**What survives the flip: the unordered SET of `proof_ref` locations.**

```
run -2 F001 → { useRetrivePublicLinks.ts:36-41 , app/pages/publicLinks/index.tsx:64,78-90 }
run -3 F002 → { app/pages/publicLinks/index.tsx:64 , useRetrivePublicLinks.ts:36-44 }        ← same pair

run -2 F002 → { web/.../PublicLinks/index.tsx:81-84 , web/.../PublicLinks/index.tsx:99,122-125 }
run -3 F001 → { web/.../PublicLinks/index.tsx:99 , web/.../PublicLinks/index.tsx:81-86 }     ← same pair
```

And it does **not** over-merge: run -2's `F001` and run -3's `F001` share no path at all.

**The headline, and it is the whole argument for D1.** Had run -2 posted inline and run -3 run as a
re-review, the matcher would have emitted `Δ 2 resolved · 2 new` against a **byte-identical tree with zero
commits between them**. Two repairs reported that could not possibly have happened. This is no longer
DoorDash's structural-variance argument or a Phase A golden caught 3-of-6 — it is our engine, in
production, this week, with the receipt on disk.

### 0.7 What the archived sources actually say — read directly, 2026-08-20

Juanma asked whether the archived research documents say anything about re-review, and whether we were
taking it into account. That question is the forcing input for this section, and the answer changed the
record.

**The method is itself the finding.** Everything external in §0-§4 arrived second-hand, through
`ROADMAP.md` item 7's *summary* of the sources rather than the sources. Six were then read directly —
`docs/cloudflare-ai-code-review.md`, `docs/doordash-ai-code-reviewer.md`,
`docs/doordash-dashbench-trust.md`, `docs/salesforce-prizm.md`, `docs/meta-radar.md`, `docs/2605.md`.
Three misattributions and four gaps came out. Nothing below changes D1-D9 or O-1..O-6; §6 grows by two.
For the record: `docs/2605.md` is the primary source behind `docs/meta-radar.md`, which points at it
(`meta-radar.md:4`).

#### 0.7.1 Cloudflare never says how it decides a finding is fixed

`docs/cloudflare-ai-code-review.md:369-384` is the entire re-review section. It states the INPUT
(`:371-373`):

> When a developer pushes new commits to an already-reviewed MR, the system runs an incremental
> re-review that is aware of its own previous findings. The coordinator receives the full text of its
> last review comment and a list of inline DiffNote comments it previously posted, along with their
> resolution status.

And the OUTPUT RULE (`:377-378`):

> **Fixed findings:** omit from the output, and the MCP server auto-resolves the corresponding DiffNote
> thread.

Between them, nothing. **The mechanism that decides fixedness is not described** — not verify, not
infer, not judge. ROADMAP item 7 read it as *"their 'fixed' is a judgment, not an inference — the
coordinator re-reads the previous findings alongside the new diff and decides"* and built a **third
option** on it, sitting between paying a refuter step per finding and trusting absence. That is a
reasonable architectural inference; it was written as what the source says. It is retracted there and
here.

The consequence is sharper than "unsupported". **"Omit fixed findings from the output" is equally
consistent with inference from non-detection** — a coordinator whose sub-reviewers simply did not
surface the issue on this run would also omit it. That is the exact failure §0.6 caught our own engine
committing. The source is compatible with Cloudflare having our bug.

**Conclusion: the one-pass-judge option has no external witness.** D1 and D8 rejected it on the PR 1759
pair, which is ours, and they stand unchanged.

#### 0.7.2 Cloudflare's "incremental" means findings-awareness, not diff-scoping

The `:371-373` quote above is the only definition of *incremental* the source offers, and what it makes
incremental is the coordinator's **knowledge** — its own previous findings and their resolution status.
**The diff scope of a re-review is never stated.** Nor do the numbers imply one: the cost tables split by
percentile (`:427-432`) and by risk tier (`:472-476`), and **never by initial-vs-re-review**. With 2.7
reviews per MR folded into one median, there is no evidence a Cloudflare re-review is even cheaper than a
first review, let alone scoped smaller.

Stated bluntly, because §3.1.1 is the most expensive mechanism in this design: **no source in the archive
describes delta-scoped discovery. §3.1.1 is ours.** Do not describe it as following anyone's practice,
and treat **O-5 as a claim we must prove ourselves** — on our own plan test, with nobody's production
numbers behind it.

#### 0.7.3 DashBench says deterministic matching alone is known-lossy, and they use both tiers

`docs/doordash-dashbench-trust.md:208-209`:

> deterministic matching is stable but misses semantic equivalence, while LLM judges reason more richly
> but need calibration, audit sets, and stable rubrics to stay trustworthy.

And `:248-249`, on what they actually run:

> Scoring then uses the same matching path for that comparison, with **deterministic matching where
> possible and agentic judging where semantic matching is needed**.

§3.4's identity is deterministic-only. And **PR 1759 IS a semantic-equivalence miss**: the same defect
produced different claim fingerprints across two runs on a byte-identical tree — "resolves to an error"
vs "resolves to a non-ok R…" (§0.6). The unordered location set recovers that pair, but it recovers it
because the locations happened to overlap, not because anything reasoned about meaning.

We keep deterministic-only, under §3.4's direction-of-error rule: an LLM identity tier that over-matches
hides a live defect behind a `carried`, which is the direction the rule forbids. What changes is that the
loss is now **named** rather than unnoticed. Open question: §6 #5.

#### 0.7.4 Four gaps the sources expose in the current design

**A worsening re-open path is missing.** `cloudflare-ai-code-review.md:381`:

> **User-resolved findings:** respected unless the issue has materially worsened.

§3.3 rule 3 suppresses a `dismissed`+`upheld` identity "this run and every later one at this identity" —
permanently, with no escape hatch. Cloudflare's equivalent rule has one. Real gap, small, and it cannot
be built before *worsened* has a definition: §6 #6.

**An author's action is not ground truth.** `docs/doordash-dashbench-trust.md:60-62`:

> **Authors accept and reject comments for product and workflow reasons: timing, PR urgency, ownership
> context, how invasive the fix is, or whether the issue was already handled another way.**

Step 2's permanent suppression rests on exactly such a decision. 6b's adjudicator mitigates it — the
suppression needs `upheld`, not the author's word alone — but the caution was nowhere in this design's
text, and a reader would have taken `dismissed` for a verdict about the code.

**RADAR is a witness that GATING is a legitimate alternative to reconciling.** `docs/2605.md:123`:

> It must be the latest published version, and CI signals must be in an allowed state.

Meta's answer to "the tree moved under us" is to refuse to act on a diff that is not current. We take
neither road. **Corrected 2026-08-20 (judgment round 1, C9):** this paragraph originally read "§3.9 takes
the other road — reconcile and demote, stale-tree findings to the bucket instead of inline", and that
policy is now deleted (§3.9). We post, pinned to the reviewed commit, and let GitHub mark the comment
outdated itself. Gating and demotion are both recorded as options that exist and were not taken;
**no design change.**

**Two mechanism divergences, named as divergences rather than derivations.** Both were carried as though
they followed from a source, and neither does:

1. **Collapse. RESOLVED the same day — it was never a divergence, and this paragraph's first draft got it
   wrong.** `doordash-ai-code-reviewer.md:284-285` says they "collapse old comments during re-review so
   the author sees the current state". The draft read that as us *declining* their mechanism. On GitHub,
   **resolving a thread IS collapsing it** — §3.9 resolves every verified-fixed thread and GitHub folds
   it away — and there are no superseded comments to hide because we never repost, so the accumulating
   pile their criterion describes cannot form. We satisfy the criterion by construction; the only thing
   declined is the minimize/hide *API call*, which is a far smaller statement (§4). What survives from
   the original worry, and it is the useful part: **O-2 still has no test**, so the claim is untested,
   not unsupported. `O-2b` in §5 is that test.
2. **Thread-alive.** `cloudflare-ai-code-review.md:379-380`:

   > **Unfixed findings:** must be re-emitted even if unchanged, so the MCP server knows to keep the
   > thread alive.

   §3.3 rule 9 (`carried`) reaches thread-alive by the **inverted** mechanism: by *not*
   posting. Equivalent outcome, opposite mechanism — and the author sees something different either way:
   theirs gets a fresh comment on every push, ours gets none. Preferring ours is a product judgement
   about noise, not a derivation from the source.

   **Resolved the same day, and the resolution takes their half rather than just declining it.** The
   reason their rule exists is not the comment — it is that the author learns the finding was
   re-examined *this* round. Silence does not carry that: it reads identically as "still live" and as
   "the bot forgot". So O-2 was amended to require the summary to **list every `carried` finding with
   its status** (§3.7 item 2, test `O-2b`). Their benefit, none of the per-push archaeology. This is the
   only place the design imports a Cloudflare mechanism's *purpose* while rejecting its *form*, and it is
   deliberate.

#### 0.7.5 What the sources are silent on, so nobody goes looking

- **`docs/salesforce-prizm.md` says nothing about re-review.** Its analysis runs once, at PR creation —
  "The system executes analysis asynchronously when a pull request is created. Results are persisted and
  served instantly." (`:71`). There is no second pass for it to have rules about.
- **`docs/meta-radar.md` is our own analysis of RADAR**, and never uses the terms *re-review*,
  *incremental review*, or *stale finding*.
- **`docs/2605.md` is the RADAR paper itself** — Meta's *"Automating Low-Risk Code Review at Meta: RADAR,
  Risk Calibration, and Review Efficiency"* (`:1`) — a per-revision accept/reject classifier with no
  concept of a previously reported finding. Its eligibility rules (§0.7.4) are the only part of it that
  touches this design.

---

## 1. Decisions

| # | Decision | Owner / date |
|---|---|---|
| **D1** | A prior finding whose site **did not change** since the last reviewed head is `carried`, decided deterministically, at zero LLM cost. Absence is never evidence of repair. | design, from §0.6 |
| **D2** | "The last reviewed head" is the summary comment's existing `head=` marker. **No new persistent state.** | design, from §0.2 |
| **D3** | Verification pays a refuter-shaped step (`runVerify`, §3.4) for every population the gate cannot settle deterministically: findings whose **site changed** (`touched`); findings the author tagged **`applied`** (with case-B **newness**, §3.7.1); priors whose §3.5 identity **overlaps** a discovery finding (post-dedupe); and case **D/E**, where **every** prior finding enters the verify-all queue (capped by `max_verification_steps`). Triage outcomes (`suppressed`, `deferred`, file-deletion) and untouched `carried` priors do **not** buy a step unless one of those triggers fires. | **Juanma, 2026-08-20**; expanded 2026-08-21 (R2-S11) |
| **D4** | If the last reviewed head is not an ancestor of the current head (force-push / rebase), the delta range is void: fall back to a full review and say so on both surfaces. | design |
| **D5** | Cross-run identity is the **unordered set of `proof_ref` locations**, recorded in a new state block on the summary comment — one entry for every finding, inline and outside-diff alike. This closes the Outside-Diff **identity** hole in the same mechanism. It does not make that population **triageable**; §3.7.2 says so explicitly (corrected 2026-08-20, C12). | design, from §0.6 |
| **D6** | The matcher reads triage state. A `dismissed` finding does not return blocking; a `deferred` one does not return as new. | design, from §0.4 |
| **D7** | The report's vocabulary is constrained: `resolved` is emitted only when the defect was **checked** — a verification step returned `refuted`, or git shows the file was deleted by the delta. Everything that merely failed to recur is `unconfirmed`. | design, from §0.1 |
| **D8** | The re-review is a **five-case state machine over (L, H)** (§3.1), not a mode. Verify-everything is correct in exactly one of those cases — history rewritten — and nowhere else. | design, forced by Juanma's 2026-08-20 question |
| **D9** | **Two deltas, never one.** Discovery reads the PR's own moved surface; the touched gate reads unrestricted content change. Sharing one computation breaks the merge-from-main case or the revert case, depending which one you pick. | design, forced by the same question |

D3 in Juanma's words, so the build is checked against the intent and not the summary: *"ningún finding
previo sale del sistema sin que algo lo haya chequeado"* — the strong arm. `applied` stops being the tag
accepted on the weakest evidence in the loop.

---

## 2. Obligations — the acceptance criteria this must be checked against

- **O-1 — the word.** `resolved` is emitted only when the defect was **checked**: either a verification
  step returned `refuted` for that finding, or git deterministically shows the code is **gone** (the file
  was deleted by the delta). Everything else that merely failed to recur is `unconfirmed`. (Retracts item
  6b's claim that `applied` needs no adjudicator "because the re-review verifies it independently".)
  **Amended 2026-08-20 (judgment round 1, C1):** as first written this said "unless a verification step
  returned `refuted`", full stop, which contradicted §3.8's own deterministic-deletion clause and left the
  two gate rows that emitted `resolved` at cost 0 unaccounted for. One of those rows is legitimate (a
  deleted file *was* checked — by git) and is now inside the rule; the other, "the locations at `H` are
  identical to base", is deleted outright (§3.3).
- **O-2 — the reader.** After N pushes the author sees the **current state**, not an archaeology of every
  round. This is a reader-facing criterion, not a matcher-mechanics one, and nothing tests it today.
  **Amended 2026-08-20:** current state means the summary **lists every live finding with its status**,
  not merely that nothing was reposted. Silence is ambiguous — it reads identically as "still
  live" and as "the bot forgot". This is what stands in for Cloudflare's re-emission rule (§3.9).
  The list is rendered from `findings[]` **merged with** `rereview.live[]` (§3.8.1), because a prior
  finding is not in this run's `findings[]` at all — §3.8.1 explains why that merge is the whole
  difference between an honest summary and a green false-clean bill (C7).
- **O-3 — the author's decisions stick.** A finding the author `dismissed` does not come back blocking.
  A `deferred` one does not come back as `fresh`.
- **O-4 — no local state.** Everything item 7 needs to re-review is recoverable from the PR alone, so a
  GitHub Action, a second machine, and a stranger's clone all behave identically.
- **O-5 — the spend is visible before it happens, and bounded where nobody is looking.** A re-review's
  discovery half reads the delta, not the PR; its verification half spends only on the §3.3 queue populations.
  **Amended 2026-08-20 (§3.10.4):** the first draft said "cheaper than today", unconditionally, and that
  is a promise the design cannot keep — a PR carrying many prior findings whose sites all moved buys many
  verification steps. Cheaper in the ordinary case, dearer in the pathological one, and the obligation is
  that **the cost band shows the verification-step count as its own term before the confirm**, so the
  human can refuse. A band that estimates from the diff alone (`src/report.ts:57`) fails this obligation
  silently.
  **Amended again 2026-08-20 (judgment round 1, C5):** visibility is not a bound. The watcher spawns
  `review --pr <n> --yes` (`src/watch.ts:711-713`) and `--yes` short-circuits `confirm()`
  (`src/cli.ts:698-706`), so on the unattended path the band prints to nobody. The bound is
  **`max_verification_steps`**, enforced in the same position as the size gate — before the confirm and
  independent of it (§3.10.4). "The cost band is the protection" was the defect, not the design.
- **O-6 — the mid-run head move does not lie.** A finding computed on a tree that is no longer the head
  never claims to be about the current one. **Rewritten 2026-08-20 (judgment round 1, C9):** it used to
  read "never posts inline as though it were current", which the design then implemented as demoting
  every inline finding whenever the head moved at all. That policy is deleted (§3.9). The obligation is
  discharged by what already ships: `commit_id` pins each comment to the reviewed commit
  (`src/pr.ts:1090-1097`), GitHub marks it outdated itself once the lines move, and the move is disclosed
  loudly on both surfaces (`src/report.ts:498-506`, `src/cli.ts:2298-2304`). Item 7 adds nothing here.

---

## 3. Mechanisms

Rewritten 2026-08-21 from the judgment ledger's 26 findings. **§3 is pipeline phases plus explicit
classification precedence** — not a first-match-wins row table. Overlap and worsening settle **after dedupe**.
Rename is evaluated **before** `touched()`. Verification is **`runVerify`**, never a second leg on
`runRefuter`.

### 3.1 State machine (L, H)

Juanma, 2026-08-20: *"¿solo verificaremos sobre los cambios hechos a partir de la última review? … hay
muchos casos que hay que tener en cuenta."* §3.1–§3.3 are the answer.

`L` = last reviewed head. `H` = current head. `B` = `merge-base(base, H)`.

| case | condition | discovery | verification |
|---|---|---|---|
| **A** | `L` absent | full `B..H` (today's path) | nothing to verify |
| **B** | `L === H` | none | priors with **new** triage activity (§3.7.1): new `applied`, or any new reply on a prior thread |
| **C** | `L` is an ancestor of `H` | restricted Δ (§3.1.1) | per §3.3 classification + post-dedupe triggers |
| **D** | `L` is **not** an ancestor of `H` — force-push / rebase / amend | full `B..H`, banner on both surfaces | **every** prior finding — verify-all queue, capped (§3.10) |
| **E** | `L` is not a commit in this repo (branch deleted/recreated, GC'd, or **shallow clone**) | as **D** | as **D** |

One `git merge-base --is-ancestor` call decides C from D. Every failure mode falls to the conservative
side: a full review, never a silently truncated delta.

**Case D is verify-everything, and only there.** When history was rewritten, `touched()` is not
computable — a refuter verdict against the new tree is the best available evidence. Everywhere else the
deterministic gate (§3.3) is strictly stronger than one sample (§0.6).

**Case E and CI.** Case E is a property of the **local object store**, not the PR (`L` missing from
`git cat-file -e`). The same PR can route C on a full clone and D/E on `actions/checkout` with default
`fetch-depth: 1`. Recommend `fetch-depth: 0` (or at least fetch `L`) in Actions workflows that run
re-review — document in the skill, not silently assumed (S7).

**Case A fallback — recovers `L` only.** If the summary comment was deleted, recover `L` from per-finding
markers' `head=` (`src/pr-preflight.ts:390-392`) before declaring case A. **What it does not recover:**
the state block (it lived on the summary), §3.5 identity, severities for worsening, or Outside Diff
identity (no marker). Findings resurface as `fresh`; threads may duplicate — visible noise, not invisible
loss (C10).

**Which marker's `head=` wins when they disagree:** the **`created_at` of the marker comment**, not merge
order — `fetchPostedFindingComments` must project `created_at` after widening (R2-S7). A `carried`
finding's marker stays frozen at its original post; stale `L` widens the delta (safe direction).
`last_head_source` (§3.10) records whether `L` came from the summary or the fallback.

**`--full` (one rule, §3.10):** widens discovery for **whatever case the PR is actually in** — including
case B (`L === H`), where discovery is otherwise none. It never skips verification, triage, or
classification. Provenance records the real case with `discovery_restricted: false` (R2-C5, S2).

#### 3.1.1 Two deltas

A naive `Δ = L..H` breaks on merge-from-main; restricting to the PR surface breaks on revert. Two
computations, never shared (D9):

- **Discovery delta (restricted):** files in `B..H` ∩ files in `L..H`, diffed `L..H`. Upstream-only
  churn excluded; a file both PR and merge touched is included.
- **Touched gate (unrestricted):** any content change to a finding's locations between `L` and `H`, even
  if the file dropped out of `files(B..H)` after a revert-to-base.

`resolveDiffFrom` (`src/cli.ts:2687-2712`) grows a second caller; the size gate runs on the **restricted**
delta only.

#### 3.1.2 Empty discovery delta

**An empty restricted delta is a re-review state, not an error** (C6). Legitimate when: only commit reverts
PR changes to base; merge of `main` touches no PR file; case B (`L === H`).

Today all three abort at `src/cli.ts:1059-1060` / `:1070-1072` before the pipeline exists.

**Rule:** in a re-review, empty discovery delta → skip discovery, **still run** prior classification,
verification, summary PATCH, thread resolution. `CliError` on empty diff stays for **first** review only.
Test: `S-empty` (§5).

#### 3.1.3 Discovery scope

Discovery scoped to Δ does **not** fence the hunters. They get the full worktree at `H` and codegraph; the
diff is the attention anchor. Blast-radius findings outside Δ are allowed — and land in the Outside Diff
channel (`src/report.ts:604-610`), which has identity (§3.6) but **not** triage (§3.7.2).

**Product promise:** every line of the PR is looked at once when it arrives — not re-examined every push.
§0.6 proves re-hunting an identical tree re-rolls, not improves. `--full` is the deliberate re-look.

### 3.2 Pipeline phases

The orchestration is **seven phases**, A–G. Phases C and F are where prior findings get their status;
phase F is explicitly **after dedupe** (C4, R2-S4).

```
Phase A — Preflight
  read L (summary marker → case-A fallback) → five-case machine (§3.1)
  → compute both deltas (§3.1.1) → size gate on restricted delta
  → recover priors from state block + inline markers (§3.6)
  → fetch triage markers (§3.7) → build verification queue skeleton

Phase B — Prior classification (zero LLM)
  §3.3 rules on every recovered prior → provisional statuses + queue entries
  rename rewrite (rule 2) before touched() (R2-C1)
  case D/E: enqueue ALL priors for verify-all

Phase C — Discovery
  hunters over restricted delta — parallel, unchanged
  SKIPPED when restricted delta empty (§3.1.2); classification + verify still run

Phase D — Dedupe
  unchanged

Phase E — Post-dedupe reconciliation (zero LLM for queue wiring; may add verify steps)
  identity overlap: each discovery survivor overlapping a prior → append prior to verify queue
  worsening: suppressed + strictly-higher discovery at same identity → lift suppression, post fresh
  re-apply max_verification_steps cap on the enlarged queue

Phase F — Verify
  runVerify (§3.4) — one step per queued prior, V### ids, steps/verify/
  **queue is deduped by `R###` before spawn** — case D/E verify-all must not double-charge a prior
  already queued by rules 7–8 or phase E overlap (round 3)
  map verdicts → final statuses (§3.3 outcomes table)

Phase G — Refute + finish
  ordinary runRefuter over fresh BLOCKER/CRITICAL survivors — unchanged, F### ids only
  deriveTier, assemble report from findings[] + rereview.live[] (§3.8)
  rewrite state block (§3.6), PATCH summary, thread resolution (§3.9)
```

**Latency note:** queuing `applied`/`touched` priors during phase B while hunters run in phase C is a
valid optimization **second** — correctness requires phase E before the verify queue closes.

**Case B path:** phases C and D are no-ops; B → F → G still runs.

### 3.3 Prior classification rules

For each prior finding recovered from the PR, apply **precedence-ordered rules**. These are **not**
first-match-wins rows — several rules can queue verification; triage and git-deletion outrank inference.

**Definitions:**

```
touched(finding) := any location in finding's proof-ref set (re-anchored, §3.6) falls inside a hunk of
                    the unrestricted delta L..H, OR file-level add/delete/rename containment
renamed(finding) := git reports a rename mapping an old path in finding.locs to a new path at H
```

**Precedence (evaluate in order; later rules do not override earlier determinate outcomes):**

| order | condition | outcome | verify? | settles |
|---|---|---|---|---|
| 1 | every location's file **deleted** by unrestricted delta | `verified-gone` | no | phase B |
| 2 | **renamed** — rewrite locs via git rename map, **re-evaluate from rule 1** | (re-entry) | no | phase B |
| 3 | `dismissed` + adjudicator `upheld` | `suppressed` *(provisional until phase E)* | no | phase B/E |
| 4 | `dismissed` + adjudicator `rejected` | **`returned`** — reposts blocking this run, disproof cited | no | phase B |
| 5 | `deferred` | `deferred` — out of blocking count | no | phase B |
| 6 | `misclassified` | **`re-tiered`** — reposts at adjudicator tier, not re-hunted | no | phase B |
| 7 | author tagged `applied` **and** (case ≠ B **or** tag is **new**, §3.7.1) | queue verify | yes | phase B→F |
| 7b | case B + **new** triage reply on a prior thread (any tag except already-processed `applied`) | queue verify | yes | phase B→F |
| 8 | `touched()` | queue verify | yes | phase B→F |
| 9 | otherwise | `carried` | no | phase B |

**Rename before touched (R2-C1).** Rule 2 runs before rule 8. A file rename rewrites paths once; the
re-evaluation cannot hit rename again for the same file. Without this ordering, `touched()` fires on the
old path, verification targets a non-existent path, a spurious `refuted` → false `resolved` ✅.

**Triage outranks touched (O-3).** Rules 3–6 beat rule 8. An author who dismissed and then edited nearby
has not withdrawn the dismissal. Worsening (phase E) is the exception.

**`applied` newness (R2-S9).** In case B, an `applied` tag on a reply with `created_at ≤ summary.updated_at`
does **not** queue verification — it was already accounted for.

**Post-dedupe only (phase E):**

- **Identity overlap:** discovery finding overlaps prior (§3.5) → append prior to verify queue (`overlap`
  trigger). Free — consumes discovery work already done (§3.3.1 hole remedy 2).
- **Worsening:** `suppressed` prior + discovery finding at same identity with **strictly higher** severity
  → lift suppression, post discovery finding as `fresh`, summary names both severities (Cloudflare :381).

**Gate outcomes** (names disjoint from `MatchResult.persist` / `.resolved`, C2):

| outcome | meaning | reader | thread |
|---|---|---|---|
| `carried` | present, untouched site, not re-hunted | listed, status `carried` | open |
| `verified-gone` | **checked** gone — `refuted` or git file deletion | `resolved` ✅ | resolved (§3.9) |
| `unconfirmed` | verify inconclusive, capped, or never run | `unconfirmed` | open |
| `suppressed` | dismissed+upheld, not worsened | hidden at this identity | open |
| `deferred` | deferred triage | listed, status `deferred` | open |
| `returned` | dismissal rejected — **reposted blocking** this run | blocking in body + inline | open |
| `re-tiered` | misclassification upheld — **reposted** at new tier | listed at new tier | open |

Rules 4 and 6 do **not** stay in `live[]` as passive rows — they produce **this run's repost entries**
in `findings[]` (lab schema unchanged: a normal finding object sourced from the prior's stored
claim/locs). `live[]` holds only passive statuses (`carried`, `unconfirmed`, `suppressed`, `deferred`).
(R2-S5, judgment round 3.)

**`resolved` is never inferred from absence or "identical to base"** (C1). Deleted row: locations at `H`
identical to base → would fire on Outside Diff and pre-existing reverts. Revert + real fix goes through
`touched` → verify → `refuted`.

**Verification verdict mapping** (produced in phase F, §3.4):

| refuter outcome | gate outcome | reader |
|---|---|---|
| `refuted` | `verified-gone` | **`resolved`** ✅ |
| `corroborated` | `carried` (or prior status if suppressed/deferred unchanged) | listed |
| `downgraded-latent` | `carried`, advisory tier | listed |
| `inconclusive` | `unconfirmed` | stays on PR |

**Over-cap priors** (`max_verification_steps`, §3.10): not verified → `unconfirmed`, loud in body — never
silent (C5, R2-S8).

#### 3.3.1 The gate's hole — fix outside proof-ref set

Author fixes a defect from a site not in the proof-ref set → rules 7–8 miss → `carried` stale. Remedies:

1. Proof-ref sets usually span producer and consumer (§0.6) → `touched` catches most fixes.
2. Phase E identity overlap catches live-area fixes for free.
3. Author tags `applied` — funded by D3; **unavailable for Outside Diff** (no thread, §3.7.2).

Verify-all by default was rejected: replaces deterministic certainty with one die roll (§0.6).

### 3.4 Verification leg (`runVerify`)

Item 7 adds **`runVerify`** — a new pipeline function that **follows `runRefuter`'s step shape** (one step
per subject, nonced boundary tags, read-only tools, engine-owned verdict vocabulary) but **never shares
artifacts with `runRefuter` in the same run** (C3, R2-S1).

**Why not call `runRefuter` twice.** Per-run finding ids are positional (`F001`…, `src/dedupe.ts:205).
Prior ids stored as `F001` in an old state block collide with this run's `F001` on: `state.verdicts`,
`steps/refuter-*.result.json`, `refuter-batch.json`, `refuter.system.md`, `state.perAgent.refuter` —
`finish()` can delete a live finding never submitted to any refuter.

**Namespace (all required, none exists today):**

| artifact | refuter leg | verify leg |
|---|---|---|
| subject ids | `F###` (this run's findings) | `V001`, `V002`… (maps to prior `R###`) |
| prior stable ids | — | `R001`, `R002`… in state block + `live[]` |
| steps dir | `steps/refuter-<id>/` | `steps/verify/<id>/` |
| batch manifest | `refuter-batch.json` | `verify-batch.json` |
| verdict map | `state.verdicts` | `state.verifyVerdicts` (name TBD, **distinct**) |
| per_agent | `refuter` | `verifier` |
| subject type | `DedupedSurvivor` | `PriorFinding` — recovered from PR, no draft lineage |

**Question asked:** *"is this specific defect still present at these locations, at H?"* Payload includes
prior claim, proof_refs, re-anchored locs, delta hunks touching those locs, and **untrusted** author reply
text if present (§3.7.3).

**Boundary tags (C11).** Widen `BoundaryTag` at `src/boundary.ts:21-30` with `previous_finding`,
`author_reply`, `comment_body`, `triage_tag`. Extend driver-side forgery check to **every** new block
before `wrapBlock` — forged nonce → `inconclusive` without spawn (`src/pipeline.ts:968-978`). Test: `C4`
(§5).

### 3.5 Identity

Cross-run identity is the **unordered set of normalized proof-ref locations**, plus anchor:

```
identity(finding) := { normalize(path):lineSpan  for each valid proof_ref (path:line only) }
                     ∪ { finding.path : finding.line }
                     -- invalid/non-path:line proof_refs are dropped at state-block write (S10);
                        a finding with zero valid refs after drop uses anchor only

match(a, b) := LET pa = paths(a), pb = paths(b)
               IN (pa = pb AND ∀ p ∈ pa : spans(a,p) and spans(b,p) overlap-or-near)   -- equal sets incl. single-path; span required (R2-C3-A, round 3)
                  OR (|pa| > 1 AND |pb| > 1
                      AND (pa ⊆ pb OR pb ⊆ pa)
                      AND ∀ p ∈ pa ∩ pb : spans overlap-or-near)     -- window = FINDING_LINE_WINDOW
```

**Parentheses matter (R2-C3-B).** The span check applies in **both** branches. Equal single-path sets
`{util.ts:14}` and `{util.ts:50}` do **not** match — same path, spans outside the window.

Direction-of-error: **under-match**, never over-match (S1, `src/root-cause.ts:60-70`).

| pair | paths | containment | spans | match? |
|---|---|---|---|---|
| PR1759 defect A: -2 `F001` ↔ -3 `F002` | equal 2-set | equal | overlap | **yes** |
| PR1759 defect B: -2 `F002` ↔ -3 `F001` | equal 1-set | equal | overlap | **yes** |
| over-merge: -2 `F001` ↔ -3 `F001` | disjoint | — | — | **no** |
| incidental: `{a.ts, util.ts}` vs `{b.ts, util.ts}` | neither ⊆ other | — | — | **no** |
| single vs multi: `{util.ts:14}` vs `{a.ts, util.ts:12}` | unequal | — | — | **no** |
| same-file different span: `{util.ts:14}` vs `{util.ts:50}` | equal 1-set | equal | no overlap | **no** (R2-C3-A) |

Layers **above** the per-finding marker (`src/pr-preflight.ts:386-393`) — marker stays strict for triage
thread binding (`src/triage-reply.ts:63-88`).

#### 3.5.1 Semantic tier (optional, deferrable)

A judge-proposed match is **not** a match — it is a **verification trigger** (phase E overlap queue).
Judge cannot write `carried`, suppress, or retire. False positive costs one step; false negative leaves
deterministic-only result. Test: `J-trigger` (§5).

### 3.6 State block

Second marker family on the **summary** comment (`src/pr-preflight.ts:354-359`), disjoint from
`pr-hero-finding` and `pr-hero-report`.

**Placement (R2-S9):** the state block is emitted **after** the `<!-- pr-hero-report … -->` marker and
visible report body — never at byte 0. `findMarkedCommentId` requires `body.startsWith(PR_COMMENT_MARKER_PREFIX)`
(`:313-323`); a leading state block orphans the summary every run.

**Shape:**

```html
<!-- pr-hero-report head=<40hex> -->
… visible report …
<!-- pr-hero-state v=1 head=<40hex> -->
<!-- {"findings":[{"id":"R001","sev":"CRITICAL","tier":"blocking","channel":"inline|outside",
     "locs":["path:line-line"],"c":"<12hex>","claim":"<escaped>"}, …]} -->
```

- **`R###` ids** — stable across runs; assigned at first post, never reused (R2-S1). This run's hunters
  still emit ephemeral `F###` in `findings.json`; mapping is explicit in `live[]`.
- **`claim` text required** — especially `channel:"outside"`, where the summary body is the only copy;
  without it the PATCH erases content (R2-S3).
- **JSON escaped for HTML** — same reason path uses percent-encoding in markers (`src/pr-preflight.ts:336-346`).
  A raw `-->` in claim or path terminates the comment early (S5). Escape `"`, `\`, `-->`, and U+2028/U+2029.

**Written from the merged live set each run (C7):** this run's new `findings[]` (assigned new `R###` as
needed) plus every prior surviving as `carried`, `unconfirmed`, `suppressed`, or `deferred`. `verified-gone`
retires the entry. Neither shrinks silently nor accumulates dead ids.

**Re-anchor locs every run (S3):** before `touched()` and identity, rewrite each prior's stored locs from
inline marker `livePath`/`liveLine` when present (`src/inline.ts:178-183`), else fall back to stored locs.

**Cap (65536-byte body, S8/R2-S10):** on overflow, evict **`unconfirmed` first, then `carried`**, never
`suppressed` (upheld dismissals must not resurface as `fresh`) and never **`deferred`** (O-3 — deferral
must survive caps). Visible body states how many identities were dropped. (R2-S10, judgment round 3
C-R3-1.)

`parseFindingMarker` must return `null` for this block (`src/pr-preflight.ts:411-447`).

### 3.7 Triage integration

**Fetch changes (C8, C13, R2-C4):**

- `fetchPostedFindingComments` — **retain** triage-marker replies, not only finding markers
  (`src/pr.ts:793-820`); projection must include **`created_at`** per comment for case-A tie-break
  (§3.1) and case-B newness — extend `PostedFindingComment` accordingly (R2-S7, round 3).
- `fetchPrReviewComments` — add `created_at` to projection (`src/pr.ts:759-761`).
- `fetchPrComments` — add `updated_at` for the summary comment (`src/pr.ts:688` today omits it).

| tag | re-review behaviour |
|---|---|
| `applied` | queue verify (D3). `refuted` → `verified-gone`; else stays on PR |
| `dismissed` + `upheld` | `suppressed` at this identity |
| `dismissed` + `rejected` | returns with disproof |
| `deferred` | `deferred` — issue number **optional** (`src/triage.ts:243-247`, S6) |
| `misclassified` | re-tiered per adjudicator |
| adjudicator `inconclusive` | **not** suppressed — pending triage |

Suppression is identity-scoped; same defect at a different location is a different identity.

#### 3.7.1 Case B newness

**New reply:** triage comment `created_at > summary.updated_at` (both from GitHub, O-4/D2). Applies to
rule 7b, `applied` (rule 7), and any classification keyed off author replies in case B.

#### 3.7.2 Outside Diff — identity yes, triage no (C12)

Bucket findings render inside the summary with marker stripped (`src/report.ts:604-610`); no review thread;
`decideThreadResolve` → `skip-issue-channel` (`src/triage-reply.ts:98-105`). Triage tags unreachable.
Reach `carried`, git-deletion `verified-gone`, or `touched`/overlap verify only. Making the bucket
triageable is out of scope (§4).

#### 3.7.3 Author replies are untrusted (S11)

Replies are attacker-controlled input from the person under review. Wrap in boundary tags; never map reply
text alone to `verified-gone` or auto-close threads. A `refuted` verdict requires the **verification step**,
not the author's claim. Nonce guard is substring-only (`src/boundary.ts:53-55`) — instruction-shaped
content inside a valid block is a known threat; verification outcome is not auto-trusted from reply content.

#### 3.7.4 Multi-agent workflow — no handshake (Juanma, 2026-08-21)

The default production shape is **several actors on the same PR without coordination**: a coding agent
lands commits, a triage agent (or human) replies on threads, the watcher or CI fires `review --pr` on
push — **in any order**. Item 7 does **not** block waiting for a triage reply, an adjudicator, or a
"loop closed" signal from another agent. GitHub comments and git are the only shared state (O-4, D2).

| what happened | what re-review does | waits for triage? |
|---|---|---|
| Fix landed in a commit, **no** triage reply | `touched()` (rule 8) or phase-E overlap → verify | **No** — git is enough to queue verify |
| `applied` tag on thread, fix may or may not be real | rule 7 → verify; `refuted` only path to `resolved` | **No** — tag is a **trigger**, not ground truth (D3) |
| Review runs **before** any triage on this head | unchanged site → `carried`; changed site → `touched` | **No** — absence of reply is not evidence of repair |
| Same head, triage arrives **after** last summary (case B) | verify only if reply/`applied` is **new** (§3.7.1) | N/A — case B has no discovery |

**Do not infer from this table that `applied` is optional.** It is the author's explicit claim that a
check is warranted; the engine still **runs** that check rather than trusting the word. The point is only
that **ordering is not guaranteed** and must not be required.

What this section does **not** solve: two review runs PATCH-ing the same summary concurrently — that
remains Phase E (§4). This section names the **triage-vs-review ordering** gap so implementers do not
add a synchronisation barrier that would stall the watcher or CI on an agent that never replies.

### 3.8 Report vocabulary and live populations

**`MatchResult.resolved` is severed from reader-facing surfaces (C2, R2-S6).** Thread resolution reads
gate `verified-gone` only. `MatchResult.resolved` stays a legacy matcher counter for inline comment
pairing — **not** consumed for `deltaLine`, clean bill, or collapse. In re-review mode,
`buildPostPlan`/`matchPostedFindings` still run for **this run's fresh inline posts**, but the
driver **must not** log or render `MatchResult.resolved` counts as "N resolved" — those log lines
(`src/cli.ts:2258-2262`) are gated off when `rereview` is active; `deltaLine` reads gate outcomes only.

**`deltaLine`** (`src/report.ts:596-601`):

```
Δ since <sha8>:  N resolved (verified) · N unconfirmed · N carried · N deferred · N new
```

`resolved` appears only when **checked**: verification `refuted` or git file deletion (D7, O-1). Counts
come from **`rereview.live[]`**, not `MatchResult.resolved`.

#### 3.8.1 Live populations and the false-clean guard (C7, R2-C2)

Delta-scoped discovery means `findings[]` holds **only this run's new findings**. Priors live in
`rereview.live[]`:

```jsonc
{ "id": "R001", "sev": "CRITICAL", "tier": "blocking", "channel": "inline|outside",
  "status": "carried|unconfirmed|suppressed|deferred", "locs": [...], "claim": "..." }
```

**Clean bill:** `findings.length === 0` **and** `live[]` empty **and** no `returned`/`re-tiered` reposts
this run. Zero new findings + all priors `unconfirmed` is **not** clean (R2-C2). All priors
`suppressed` with empty `findings[]`: **not** clean — body states "N findings suppressed" so the author
sees decisions persisted (O-2); headline blocking count is zero.

Render layer merges `findings[]` with `live[]` (status ≠ `suppressed` for headline counts; full list
includes `carried`, `unconfirmed`, `deferred` per O-2). `findings.json` stays lab-compatible (CLAUDE.md
rule 5). Test: `C7-clean`, `C7-unconfirmed` (§5).

### 3.9 Collapse (thread resolution)

On GitHub, resolving a thread **is** collapse (DoorDash criterion satisfied by construction, §4).

Item 7 adds, in order:

1. **`verified-gone` only** — ✅ reply + `resolveReviewThreadForComment` (`src/pr.ts:1413`). Never on
   `carried`, `unconfirmed`, or `MatchResult.resolved`.
2. Summary PATCH lists **every non-suppressed live finding with status** (O-2) — Cloudflare re-emission
   purpose without per-push comments.
3. No minimize/hide API.

**Mid-run head move (O-6): item 7 adds nothing.** `commit_id` pins inline comments (`src/pr.ts:1090-1097`);
GitHub marks outdated lines; disclosure on summary (`src/report.ts:498-506`) and terminal
(`src/cli.ts:2298-2304`). The demotion policy that would have pushed every inline finding to Outside Diff
on any push is retracted (C9).

### 3.10 Wiring

#### 3.10.1 Command surface

`pr-hero review --pr <n>` **is** re-review when a prior review exists — no `--rereview` flag.

**`--full`:** one rule — widens discovery to full `B..H` for the **actual** case (A/B/C/D/E); verification,
triage, and §3.3 classification unchanged; records `discovery_restricted: false` and real `"case"`. Refused
on verbs other than `review` (mirror `--scout`).

#### 3.10.2 Provenance (`pipeline.json`)

```jsonc
"rereview": {
  "case": "A|B|C|D|E",
  "last_reviewed_head": "<40hex>|null",
  "last_head_source": "summary_marker|finding_markers|absent",
  "discovery_range": "<from>..<to>",
  "discovery_restricted": true,
  "discovery_skipped_empty_delta": false,
  "prior_findings": 0,
  "settled_deterministically": 0,
  "verified": 0,
  "verification_capped": 0,
  "verification_triggers": { "applied": 0, "touched": 0, "overlap": 0, "verify_all": 0 },
  "live": [
    { "id": "R001", "sev": "CRITICAL", "tier": "blocking", "channel": "inline|outside",
      "status": "carried|unconfirmed|suppressed|deferred", "locs": [...], "claim": "..." }
  ]
}
```

Arm identity for future measurement — same lesson as M6 `scout.enabled` (`src/floor-test.ts`).

#### 3.10.3 Cost band and `max_verification_steps` (C5)

`estimateCost` (`src/report.ts:75`) is diff-only today — verification queue invisible. Plan card adds
**verification-step count** as its own line before confirm (O-5a).

**Bound:** `max_verification_steps` — config key, conservative default, enforced **before confirm** in
the same position as the size gate, **not bypassed by `--yes`** (watcher path). Over cap → verify
highest-severity N, remainder `unconfirmed`, loud in body + `verification_capped`. Case D subject to same
cap. Test: `W-cap` (§5).

#### 3.10.4 Watcher

Re-review is default behaviour of `review --pr <n> --yes` — no new flag. Spend bounded by
`max_verification_steps` only (not size gate, not `daily_cap` launches). Cap + cost-band term ship
**before** unattended re-review runs.

---
## 4. What item 7 does NOT do

- **No exactly-once on `--post`.** Two overlapping runs can still both PATCH the same summary
  (`runPostCommand`, `src/cli.ts:2194-2317`, takes no lock). That is Phase E and stays there.
- **No minimize/hide of old GitHub comments — and this is NOT declining DoorDash's "collapse old
  comments during re-review" (`doordash-ai-code-reviewer.md:284-285`).** Corrected 2026-08-20; the
  earlier wording here framed it as a divergence and it is not one. On GitHub, **resolving a thread IS
  collapsing it** — §3.9 resolves every verified-fixed thread and GitHub folds it away — and there are no
  superseded comments to hide because we never repost. The accumulating pile their criterion describes
  cannot form. We satisfy it by construction; the minimize/hide *API* is what we are not calling, which
  is a different and much smaller statement.
- **No re-run of the refuter over `fresh` findings** — the normal pipeline already does that leg.
- **No scout stage in the delta review.** M6 closed `opt-in` (2026-08-20), so the pipeline item 7 is
  designed against has no scout by default. `--scout` continues to work and is orthogonal: it would see
  the delta diff, which is strictly smaller, and needs no item-7-specific handling.
- **No change to the `pr-hero-finding` marker format.** §3.5 layers above it; changing it would break
  every thread already on every open PR.
- **No fix for the issue-channel triage blind spot.** `runTriageCommand` only walks review comments with
  `in_reply_to_id` (`src/cli.ts:2410-2431`), so issue-channel triage replies are invisible to the ledger
  write-back. Real, verified this session, and **out of scope** — it is a triage defect, not a re-review
  one. It needs its own issue.
- **No triage-ability for the Outside Diff bucket** (added 2026-08-20, judgment round 1, C12). §3.6 gives
  that population cross-run **identity**; it does not give it a thread, and without a thread there is
  nothing to reply to, nothing for `in_reply_to_id` to bind (`src/cli.ts:2413-2431`) and nothing for
  `decideThreadResolve` to resolve (`src/triage-reply.ts:98-105`). So a 422-demoted or un-anchorable
  finding cannot be tagged `applied`, `dismissed`, `deferred` or `misclassified` — §3.7.2 states the
  consequence for the gate. Same class as the bullet above: a **channel** defect, not a re-review one, and
  it needs its own issue. Item 7 does not add a demotion policy that would grow this population (§3.9).

---

## 5. Done-checklist — one named test per obligation

- [ ] **O-1a** `deltaLine` cannot print `resolved` unless the defect was **checked** — a rendering test
      with three inputs: absence-only (the word must not appear), a `refuted` verdict (it must), and a
      file the delta deleted (it must). The second and third are the only two paths to the word.
- [ ] **O-1b** A finding whose site is untouched and which the hunters did not re-find is classified
      `carried`, never `resolved`. **Fixture: the PR 1759 pair (§0.6), replayed offline from the two
      artifact directories.** This test is the reason this design exists; it must fail against today's
      matcher.
- [ ] **O-1c** `MatchResult.resolved` does not drive thread resolution or `deltaLine`: a case-C run whose
      priors all land `carried` posts **no** ✅ reply and calls no thread resolution (§3.8, §3.9). Asserted
      on the post plan and rendered `deltaLine` — not on `MatchResult.resolved` count (R2-S6).
- [ ] **O-2** A simulated three-push sequence renders a summary containing only current-state findings —
      no superseded round appears in the body.
- [ ] **O-3a** A `dismissed`+`upheld` identity does not appear in a later run's output at any tier.
- [ ] **O-3b** A `deferred` identity appears in the deferred list (issue number when present) and is
      absent from the blocking count — including a reasoning-only defer with no issue (S6, §3.7).
- [ ] **O-4** Every input to the re-review decision is derived from PR data in the test's fixtures; the
      test runs with no `~/.prhero` and no run directory present.
- [ ] **O-5a** The cost band carries the verification-step count as its own term: two plans over the same
      delta but 2 vs 40 queued verifications produce different bands (§3.10.3). A band that does not move
      fails.
- [ ] **O-5b** In the ordinary case — small delta, few prior findings — the planned spend is strictly
      lower than the same PR's first review. Asserted on the plan, never on a live run.
- [ ] **W-cli** `parseArgs` accepts `--full` on `review` and refuses it on every other verb; a PR with a
      prior review takes the delta path with **no flag** (§3.10.1). And `--full` **is not case A**: a
      `dismissed`+`upheld` identity stays suppressed under `--full`, the run records its real case with
      `discovery_restricted: false`, and only the discovery range widens.
- [ ] **W-order** The verification queue closes only after dedupe: identity overlap appends a prior in
      phase E, and no verification step spawns before dedupe (§3.2).
- [ ] **W-cap** `max_verification_steps` bounds the queue **with `--yes` set and no TTY**: a run whose
      queue exceeds the cap verifies the highest-severity N, reports the rest as `unconfirmed` in the
      visible body, and records `verification_capped`. Asserted on the unattended path specifically —
      a cap that only fires inside `confirm()` fails this test (§3.10.3).
- [ ] **W-prov** `pipeline.json` carries the `rereview` block with the case, both range ends,
      `last_head_source`, the four trigger counts, `verification_capped` and `live[]`; a first review
      carries no block at all. A run that cannot name its case from the artifact is unscorable, never
      assumed (§3.10.2).
- [ ] **O-6** With `movedHeadSha` set, every finding still posts inline **pinned to the reviewed commit**,
      and both surfaces carry the disclosure (`src/report.ts:498-506`, `src/cli.ts:2298-2304`). Item 7
      adds no demotion policy (§3.9).
- [ ] **D4** `lastReviewedHead` not an ancestor of `head` → the plan is a full review, every prior finding
      is queued for verification **up to `max_verification_steps`**, and both surfaces carry the banner.
- [ ] **S-A** With the summary comment absent, `L` is recovered from per-finding markers — **latest
      `created_at`** when heads disagree — and the run does **not** fall to first-review semantics (§3.1).
- [ ] **S-B** `L === H` plans zero discovery steps and verifies only findings carrying a new reply or new
      `applied` tag, where **new** is `comment.created_at > summary.updated_at` (§3.7.1) — both timestamps
      named in fixtures; a predating reply must buy no step.
- [ ] **S-merge** A delta containing a merge of the base branch produces a discovery diff restricted to
      `files(B..H) ∩ files(L..H)` — upstream-only files are absent from the plan.
- [ ] **S-revert** A file reverted to base drops out of the restricted delta **but still trips `touched()`**,
      so its findings queue verification (§3.3 rule 8). Outcomes: `refuted` → `verified-gone`; `inconclusive`
      or cap → `unconfirmed` — never `resolved` without a check. (R2-S8: `carried` is wrong for a touched
      prior that was verified and could not tell.)
- [ ] **S-overlap** A discovery finding whose §3.5 identity overlaps a prior finding forces that prior into
      verification (phase E).
- [ ] **S-empty** A re-review whose restricted delta is **empty** still verifies and still posts: no
      `CliError`, discovery skipped, classification runs, live findings listed, and
      `discovery_skipped_empty_delta` is recorded (§3.1.2). A first review with an empty diff still
      errors — the same test asserts both halves, or it proves nothing.
- [ ] **S-base-moved** `merge-base(base, H)` moving between runs does not change the discovery delta.
- [ ] **O-2b** The rendered summary lists every live finding with its status (`carried`, `unconfirmed`,
      `deferred`, and a suppressed count when >0) — asserted on the rendered lines (§3.8.1, §3.9).
- [ ] **C7-clean** A run with **zero** new findings and ≥1 live `carried` finding does **not** print
      "✅ pr-hero reviewed this PR and found nothing to report", and its headline counts include those
      severities (§3.8.1).
- [ ] **C7-unconfirmed** A run with zero new findings and all priors `unconfirmed` (e.g. cap hit) also
      does **not** print the clean bill — `live[]` non-empty (R2-C2).
- [ ] **W-worse** A `dismissed`+`upheld` identity stays suppressed against a same-severity discovery
      finding, and **returns** against a strictly-higher-severity one, with both severities named in the
      summary (§3.3 post-dedupe worsening).
- [ ] **J-trigger** A judge-proposed semantic match can only route a prior finding into verification —
      asserted by construction: no code path lets a judge output write `carried`, retire an identity, or
      suppress a finding (§3.5.1). This test must exist **before** any judge tier is wired, not with it.
- [ ] **D5a** `parseFindingMarker` returns `null` for the state block.
- [ ] **D5b** Over the size cap, the state block drops **`unconfirmed` then `carried`**, never
      `suppressed`, and the visible body says so (S8).
- [ ] **D5c** Identity matching pairs both PR 1759 defects across runs -2/-3, over-merges neither, rejects
      incidental shared ref and single-path subset cases (§3.5).
- [ ] **D5d** The state block uses stable **`R###` ids**, includes **`claim`**, sits **after** the report
      marker, and is rewritten from the merged live set: one new, three carried, one verified-gone → four
      entries; verified-gone retired (§3.6).
- [ ] **D5e** State block JSON escapes `-->` and quotes so claim/path text cannot break the HTML comment
      (S5).
- [ ] **V-ns** `runVerify` is namespaced: prior `R001`, subject `V001`, `steps/verify/` artifacts, distinct
      verdict map, `verifier` in `per_agent`. Same run with fresh `F001` keeps verdicts apart; `finish()`
      deletes neither (§3.4).
- [ ] **C4** The verification prompt inlines prior findings and author replies inside nonced boundary
      tags, `BoundaryTag` is widened with the four tags `src/boundary.ts:21-30` names, and the driver-side
      forgery check covers **every** new block: a reply that forges the nonce lands the subject on
      `inconclusive` **without spawning** and never reaches `wrapBlock`'s throw (§3.4). The
      artifact-level preamble test (`test/pipeline.test.ts`) still walks every `*.system.md`.
- [ ] **S-rename** A prior whose file was git-renamed is re-evaluated on the new path before `touched()`;
      verification targets the post-rename path (R2-C1).

Offline in every case. `bun test` + `bun run typecheck` + `bun run check`, then one fixture eval, then a
single live re-review on a real musive PR before this is called done.
When the PRs exist, walk `docs/item7-runbook.md` — case cards and surfaces, not this checklist.

---

## 6. Open questions

1. **Splice condition 1 — M1 (`#42`, `#39`) seen live — is still OPEN, and it is the last gate on the
   BUILD.** Verified 2026-08-20: the watcher is live (`launchd` installed, 5-min tick) and auto-launched
   PR 1759 today, both runs `status: complete` and posted. So `#39`'s happy path is confirmed live. What
   is **not** confirmed live: `#42`'s `partial` path (no partial run exists to inspect) and `#39`'s
   moved-head path (no run has hit it). Closing this needs either a partial/moved-head run to occur
   naturally, or a deliberate one. Juanma's call whether to wait or to force it.
2. **The window in §3.4.** `FINDING_LINE_WINDOW = 5` was tuned for anchoring, not for identity. The
   PR 1759 pair matches on exact and near-exact spans, so it does not settle the number. Pick it against
   more pairs before hard-coding — and remember the direction-of-error rule says small.
3. ~~**Does a `refuted` verification also retire the identity from the state block?**~~ **CLOSED
   2026-08-20 (judgment round 1, C7), in §3.6.** Yes, it retires. The state block is rewritten each run
   **from the merged live set** — this run's `findings[]` plus every prior with status `carried`,
   `unconfirmed`, `suppressed` or `deferred` — so a `verified-gone` finding leaves. Suppressed entries
   persist until identity changes or cap evicts (never by default). A defect that returns later is
   `fresh` again. The ledger keeps the history.
4. **C1a's ordering assumption is falsified (§0.6) and `root_cause_id` is affected, not only re-review.**
   Root-cause clustering anchors on the first `proof_ref`; that order is not stable. Out of scope here,
   but it wants its own entry — the cluster counts in every report inherit the same instability.
5. ~~**A semantic identity tier.**~~ **CLOSED same day, in §3.5.1.** The question was whether a judge
   could only ADD a match, never silently suppress a finding. It can: a judge-proposed match is not a
   match, it is a **verification trigger** (phase E). A false positive costs one step; a false negative
   leaves us where deterministic-only already was. Neither direction hides a live defect.
6. ~~**The worsening re-open path.**~~ **CLOSED same day, in §3.3 (phase E).** *Worsened* := a discovery
   finding at the same §3.5 identity with **strictly higher** severity than the suppressed one.
7. **Does the summary's live list scale?** O-2 requires listing every non-suppressed live finding with
   status (§3.9). On a long-lived PR that list grows while the state block (§3.6) competes for the same
   65536-byte body. Open: visible list cap and interaction with state-block eviction order (R2-S10).
