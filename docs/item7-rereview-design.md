# Item 7 — the re-review, designed

Written 2026-08-20 with Juanma, immediately after M6 closed as `opt-in` and unblocked splice condition 3.
Governs `ROADMAP.md` Phase B item 7. Status: **DESIGN. No engine code has moved.**

The gate this design does NOT satisfy: splice condition 1 (M1 `#42`/`#39` seen live) is still open — §6.
Design is not implementation; the build waits.

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
3. **No word claims more than what was checked.** `resolved` requires a verdict; everything else is
   `unconfirmed`.

### What we take from whom, and what we refuse

| source | adopted | refused, and why |
|---|---|---|
| **Cloudflare** (`cloudflare-ai-code-review.md`) | the five re-review rules; prior findings and author replies as prompt input wrapped as untrusted text; re-open on worsening | *"won't fix"/"acknowledged" → resolved* (our `deferred` demands a real destination); the coordinator arguing back itself (6b keeps the adjudicator isolated); re-emitting unfixed findings (GitLab DiffNote mechanics — see below) |
| **DoorDash, May** (`doordash-ai-code-reviewer.md`) | the author sees current state, not the pile; reconcile when the PR moves during a review; never post a false-clean review; no duplicate comments across re-reviews | the literal collapse/minimize mechanism — we reach the same reader outcome another way (see below) |
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
   persisting finding with its status.** That is now part of O-2, not an optional nicety.
2. **"Collapse old comments" — we satisfy it by construction; we do not decline it.** On GitHub,
   resolving a thread *is* collapsing it, and §3.7 resolves every verified-fixed thread. And there are no
   superseded comments to hide, because we never repost — the pile never accumulates in the first place.
   §4 previously worded this as declining DoorDash's mechanism; that was wrong and is corrected there.
3. **The semantic judge enters with zero risk, because a judge-proposed match is not a match — it is a
   verification trigger.** DashBench uses deterministic matching plus an LLM judge where semantics are
   needed (`:248-249`), and §3.4 is deterministic-only. The fear was an over-matching judge hiding a live
   defect behind a `persist`. That can only happen if the judge's output *classifies*. It does not:
   a judge-proposed match feeds **§3.2 row 4** and forces a refuter step. **The judge can never retire a
   finding; the worst it can do is spend one step.** Deterministic identity remains the only thing that
   classifies, and rule 2 is preserved intact.

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

This is the exact shape item 7's verification half needs, and it is already built, isolated, tested and
priced. **Item 7 does not build a verifier. It builds a second caller of this one.**

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
hides a live defect behind a `persist`, which is the direction the rule forbids. What changes is that the
loss is now **named** rather than unnoticed. Open question: §6 #5.

#### 0.7.4 Four gaps the sources expose in the current design

**A worsening re-open path is missing.** `cloudflare-ai-code-review.md:381`:

> **User-resolved findings:** respected unless the issue has materially worsened.

§3.2 row 5 suppresses a `dismissed`+`upheld` identity "this run and every later one at this identity" —
permanently, with no escape hatch. Cloudflare's equivalent rule has one. Real gap, small, and it cannot
be built before *worsened* has a definition: §6 #6.

**An author's action is not ground truth.** `docs/doordash-dashbench-trust.md:60-62`:

> **Authors accept and reject comments for product and workflow reasons: timing, PR urgency, ownership
> context, how invasive the fix is, or whether the issue was already handled another way.**

Row 5's permanent suppression rests on exactly such a decision. 6b's adjudicator mitigates it — the
suppression needs `upheld`, not the author's word alone — but the caution was nowhere in this design's
text, and a reader would have taken `dismissed` for a verdict about the code.

**RADAR is a witness that GATING is a legitimate alternative to reconciling.** `docs/2605.md:123`:

> It must be the latest published version, and CI signals must be in an allowed state.

Meta's answer to "the tree moved under us" is to refuse to act on a diff that is not current. §3.9 takes
the other road — reconcile and demote, stale-tree findings to the bucket instead of inline. Recorded as
an option that exists and was not taken; **no design change.**

**Two mechanism divergences, named as divergences rather than derivations.** Both were carried as though
they followed from a source, and neither does:

1. **Collapse. RESOLVED the same day — it was never a divergence, and this paragraph's first draft got it
   wrong.** `doordash-ai-code-reviewer.md:284-285` says they "collapse old comments during re-review so
   the author sees the current state". The draft read that as us *declining* their mechanism. On GitHub,
   **resolving a thread IS collapsing it** — §3.7 resolves every verified-fixed thread and GitHub folds
   it away — and there are no superseded comments to hide because we never repost, so the accumulating
   pile their criterion describes cannot form. We satisfy the criterion by construction; the only thing
   declined is the minimize/hide *API call*, which is a far smaller statement (§4). What survives from
   the original worry, and it is the useful part: **O-2 still has no test**, so the claim is untested,
   not unsupported. `O-2b` in §5 is that test.
2. **Thread-alive.** `cloudflare-ai-code-review.md:379-380`:

   > **Unfixed findings:** must be re-emitted even if unchanged, so the MCP server knows to keep the
   > thread alive.

   §3.2 row 1 reaches thread-alive by the **inverted** mechanism: by *not* posting. Equivalent outcome,
   opposite mechanism — and the author sees something different either way: theirs gets a fresh comment
   on every push, ours gets none. Preferring ours is a product judgement about noise, not a derivation
   from the source.

   **Resolved the same day, and the resolution takes their half rather than just declining it.** The
   reason their rule exists is not the comment — it is that the author learns the finding was
   re-examined *this* round. Silence does not carry that: it reads identically as "still live" and as
   "the bot forgot". So O-2 was amended to require the summary to **list every persisting finding with
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
| **D1** | A prior finding whose site **did not change** since the last reviewed head is `persist`, decided deterministically, at zero LLM cost. Absence is never evidence of repair. | design, from §0.6 |
| **D2** | "The last reviewed head" is the summary comment's existing `head=` marker. **No new persistent state.** | design, from §0.2 |
| **D3** | Verification pays a refuter-shaped step for exactly two populations: findings whose **site changed**, and findings the author tagged **`applied`**. | **Juanma, 2026-08-20** |
| **D4** | If the last reviewed head is not an ancestor of the current head (force-push / rebase), the delta range is void: fall back to a full review and say so on both surfaces. | design |
| **D5** | Cross-run identity is the **unordered set of `proof_ref` locations**, carried in a new state block on the summary comment — one block for every finding, inline and outside-diff alike. This closes the Outside-Diff identity hole in the same mechanism. | design, from §0.6 |
| **D6** | The matcher reads triage state. A `dismissed` finding does not return blocking; a `deferred` one does not return as new. | design, from §0.4 |
| **D7** | The report's vocabulary is constrained: `resolved` requires a verification verdict. Everything else is `unconfirmed`. | design, from §0.1 |
| **D8** | The re-review is a **five-case state machine over (L, H)** (§3.1), not a mode. Verify-everything is correct in exactly one of those cases — history rewritten — and nowhere else. | design, forced by Juanma's 2026-08-20 question |
| **D9** | **Two deltas, never one.** Discovery reads the PR's own moved surface; the touched gate reads unrestricted content change. Sharing one computation breaks the merge-from-main case or the revert case, depending which one you pick. | design, forced by the same question |

D3 in Juanma's words, so the build is checked against the intent and not the summary: *"ningún finding
previo sale del sistema sin que algo lo haya chequeado"* — the strong arm. `applied` stops being the tag
accepted on the weakest evidence in the loop.

---

## 2. Obligations — the acceptance criteria this must be checked against

- **O-1 — the word.** `resolved` never reaches a reader unless a verification step returned `refuted`
  for that finding. Every other non-recurrence is `unconfirmed`. (Retracts item 6b's claim that
  `applied` needs no adjudicator "because the re-review verifies it independently".)
- **O-2 — the reader.** After N pushes the author sees the **current state**, not an archaeology of every
  round. This is a reader-facing criterion, not a matcher-mechanics one, and nothing tests it today.
  **Amended 2026-08-20:** current state means the summary **lists every persisting finding with its
  status**, not merely that nothing was reposted. Silence is ambiguous — it reads identically as "still
  live" and as "the bot forgot". This is what stands in for Cloudflare's re-emission rule (§3.7).
- **O-3 — the author's decisions stick.** A finding the author `dismissed` does not come back blocking.
  A `deferred` one does not come back as `fresh`.
- **O-4 — no local state.** Everything item 7 needs to re-review is recoverable from the PR alone, so a
  GitHub Action, a second machine, and a stranger's clone all behave identically.
- **O-5 — the spend is visible before it happens.** A re-review's discovery half reads the delta, not the
  PR; its verification half spends only on the §3.2 populations. **Amended 2026-08-20 (§3.10.4):** the
  first draft said "cheaper than today", unconditionally, and that is a promise the design cannot keep —
  a PR carrying many prior findings whose sites all moved buys many verification steps. Cheaper in the
  ordinary case, dearer in the pathological one, and the obligation is that **the cost band shows the
  verification-step count as its own term before the confirm**, so the human can refuse. A band that
  estimates from the diff alone (`src/report.ts:57`) fails this obligation silently.
- **O-6 — the mid-run head move does not lie.** A finding computed on a tree that is no longer the head
  never posts inline as though it were current.

---

## 3. Mechanisms

### 3.1 The state machine over (L, H) — five cases, no sixth

Juanma, 2026-08-20, on reading the first draft: *"¿solo verificaremos sobre los cambios hechos a partir de
la última review? … hay muchos casos que hay que tener en cuenta y pensar en una solución que no se
rompa."* §3.1 and §3.2 are the answer, and two mechanisms below exist because he asked.

`L` = last reviewed head. `H` = current head. `B` = `merge-base(base, H)`.

| case | condition | discovery | verification |
|---|---|---|---|
| **A** | `L` absent | full `B..H` (today's path) | nothing to verify |
| **B** | `L === H` | none | only findings carrying a new author reply |
| **C** | `L` is an ancestor of `H` | restricted Δ (§3.1.1) | per-finding gate (§3.2) |
| **D** | `L` is **not** an ancestor of `H` — force-push / rebase / amend | full `B..H`, banner on both surfaces | **every** prior finding, against the new tree |
| **E** | `L` is not a commit in this repo (branch deleted and recreated, or GC'd) | as **D** | as **D** |

One `git merge-base --is-ancestor` call decides C from D. Deterministic, and every failure mode falls to
the conservative side: a full review, never a silently truncated delta.

**Case D is where verify-everything belongs, and only there.** When history was rewritten, `touched` is
not computable — there is no meaningful diff between the old tree and the new one — so a refuter verdict
against the new tree is the best available evidence. Everywhere else it would be strictly worse than the
deterministic gate; §3.2 explains why in the terms that decide it.

**Case A has a free fallback that must be built, or every thread duplicates.** If the summary comment was
deleted or edited by a human, `parseMarkerHead` returns nothing and the run would fall to "first review",
re-posting every finding. But the per-finding markers carry `head=` too
(`src/pr-preflight.ts:390-392`). Recover `L` from those before declaring case A. Zero cost, and it turns
the worst human-caused failure into a non-event.

#### 3.1.1 Two deltas, because they answer different questions

A naive `Δ = L..H` breaks the moment the author merges `main` into the branch: the delta swallows every
upstream change and the re-review reviews someone else's work. Cost bomb and noise bomb at once. But the
obvious fix — restrict Δ to the PR's own file surface — breaks the gate in the *revert* case. So they are
two different computations and must not be shared:

- **Discovery reads the restricted delta:** files changed in `B..H` ∩ files changed in `L..H`, diffed
  between `L` and `H`. That is the PR's own surface, moved. Upstream churn the author merged in is
  excluded; a file the PR touches which the merge also changed is included, correctly — its content is
  now something nobody reviewed.
- **The touched gate reads unrestricted content change:** any change to a finding's locations between `L`
  and `H` counts, whether or not the file is still part of the PR's surface. If the author reverted a
  file back to base, it drops out of `files(B..H)` — and the gate must still see that its content moved,
  or it would report `persist` on a file the PR no longer modifies at all.

Base-branch movement is handled for free by this split: `merge-base(base, H)` moving under the PR changes
`B..H`, but `L..H` is untouched, so a re-review is *more* stable than a first review under a moving base.

`resolveDiffFrom` (`src/cli.ts:2687-2712`) grows a second caller rather than a second implementation. The
size gate (`src/size-gate.ts`) then runs on the **restricted delta**, which is the point: a re-review of
three commits stops being priced as a re-review of the whole PR.

#### 3.1.2 The delta is the entry point, not the boundary

Discovery scoped to Δ does **not** mean the hunters may only look at Δ. They get the full worktree at `H`
and codegraph, exactly as in a first review; the diff has always been the attention anchor, not a fence.
A change inside Δ that breaks code outside it is found by following the blast radius outward — the same
mechanism that finds it on a first review.

**The product promise this makes, stated so it can be held to:** *every line of the PR is looked at once,
when it arrives.* Not "every line is re-examined on every push". Re-hunting `B..L` on push 5 does not
reliably recover a first-review miss — §0.6 is the proof that a second pass over an identical tree
returns *different* findings, not *more* reliable ones — it only re-rolls, and every re-roll costs money
and adds noise the author already dismissed once. A deliberate `--full` covers the case where a human
wants the whole PR looked at again.

### 3.2 The change gate — deterministic triage of prior findings, before a single token

For each prior finding recovered from the PR, ask a question `git` can answer:

```
touched(finding) := any location in finding's proof-ref set falls inside a hunk of the delta diff L..H
                    (file-level containment when the file is added/deleted/renamed)
```

| # | state | route | cost |
|---|---|---|---|
| 1 | `!touched`, no author reply, no overlap | **`persist`** — the defect is still there by construction | **0** |
| 2 | `touched` by the unrestricted delta | **verify** (§3.3) | 1 step |
| 3 | author tagged `applied` | **verify** (§3.3) | 1 step |
| 4 | **a discovery finding's identity (§3.4) overlaps this one** | **verify** (§3.3) | 1 step |
| 5 | `dismissed` + adjudicator `upheld` | **suppressed** at this identity — **unless worsened** (§3.2.2) | 0 |
| 6 | `dismissed` + adjudicator `rejected` | **returns**, with the disproof cited | 0 |
| 7 | `deferred` (+ issue number) | out of the blocking count, listed as deferred | 0 |
| 8 | `misclassified` | **re-tiered** per the adjudicator, never re-hunted | 0 |
| 9 | every location's file deleted by the delta | **`resolved`**, deterministically | 0 |
| 10 | a location's file renamed | follow git's rename, then re-evaluate from row 1 | 0 |
| 11 | the locations at `H` are **identical to base** — the PR no longer modifies them | **`resolved`**, deterministically | 0 |
| 12 | verification returned `inconclusive` | **`unconfirmed`**, stays on the PR | — |

Row 1 is what makes the whole design cheaper than today and is the direct answer to §0.6: **you cannot
report a repair in code that did not change.** It also makes O-2 mechanical — a `persist` finding is not
reposted, so the thread stays alive without adding a comment (Cloudflare's *"unfixed → re-emitted …
thread stays alive"*, achieved by not posting rather than by posting again).

Row 11 exists because of the revert case §3.1.1 names: a file the author restored to base is no longer
part of the PR, so a finding against it is not `persist` and not `unconfirmed` — it is deterministically
gone, in the same class as a deleted file.

#### 3.2.1 The gate's one hole, and why it is not plugged by verifying everything

Raised by Juanma: *"¿qué pasa si lanzó más commits y resolvió más cosas además de lo que le marcamos?"*

Most of that case is already handled. He fixed something we flagged → row 2 or 3, verified. He fixed
something we never flagged → nothing to verify and hunters do not flag fixes; silent by design. He broke
something new while fixing → the fix is inside Δ, so discovery finds it. **The hole is narrower and
real: he fixed the finding from a site that is not in the finding's proof-ref set**, so the gate says
untouched and we report a defect that no longer exists.

Three remedies, none expensive, in the order they fire:

1. **The proof-ref set usually carries both ends.** §0.6 shows every finding in the PR 1759 pair citing
   producer *and* consumer, so a fix at either end lands inside the set and trips row 2. Not a guarantee
   — a three-hop causal chain can be cited with two refs — which is why there are two more.
2. **Row 4, the identity-overlap widening.** If discovery over Δ produces a finding whose §3.4 identity
   overlaps a prior finding's, the area is demonstrably live and the prior one is verified. This is free:
   it consumes work the discovery half already did, and the pipeline order already permits it.
3. **The `applied` tag is the author's own remedy**, and D3 already funds it — this is precisely the
   population Juanma chose to pay for.

#### 3.2.2 Worsening re-opens a suppressed finding — the one Cloudflare rule we were missing

`cloudflare-ai-code-review.md:381`: *"**User-resolved findings:** respected unless the issue has
materially worsened."* Row 5 as first drafted suppressed permanently, with no escape hatch — a real gap
(§0.7.4). Closed here, mechanically, because a judgement call would need a model and rule 1 says no:

> **Worsened** := discovery over the delta produces a finding at the same §3.4 identity whose severity is
> **strictly higher** than the suppressed finding's.

That finding is posted as `fresh`, the suppression is lifted for that identity, and the summary says the
finding returned because it worsened, naming both severities. No new step, no new prompt — the severity
is already on every finding and the identity is already computed for row 4.

The direction of error is the safe one: an author's `dismissed` at LOW is not overturned by another LOW,
so we do not re-litigate a decision they made; only a genuine escalation reopens it. And the DashBench
caution that an author's action is not ground truth (`:60-62`, §0.7.4) is precisely what this hatch
answers — a `dismissed` given for timing or scope reasons stops being permanent the moment the defect
gets worse.

**Why NOT "verify every prior finding by default and treat the gate as a cost cap".** It was drafted and
rejected, and the reasoning is recorded because the instinct is a good one pointed the wrong way.
`code unchanged → defect unchanged` is **deterministic evidence, strictly stronger than one refuter
sample.** Verifying an untouched site replaces a certainty with a die roll. The two failure modes are not
symmetric, and the project's standing direction-of-error rule decides it outright:

| | failure | class |
|---|---|---|
| the gate | fix landed outside the proof-ref set → a stale finding stays visible on the PR, and the author tags it `applied`, which pays verification | **visible noise**, self-healing |
| verify-all | refuter variance on byte-identical code returns `refuted` → §3.3 maps that to `resolved` ✅ and auto-closes the thread | **invisible loss**, and it re-rolls the dice on every push |

§0.6 is the proof that one sample on an identical tree is not a measurement. Verify-all would launder
that sample as one, on the one axis where a deterministic answer already exists. Case D (§3.1) is the
only place verify-everything is correct, because there `touched` is not computable at all.

### 3.3 The verification step — a second caller of `runRefuter`, not a new agent

Reuses `src/pipeline.ts:922-1123` unchanged in shape: one step per finding, one-element JSON array, nonced
boundary tags, read-only tools, engine-owned verdict vocabulary.

What differs, and it is only the framing of the question:

- The subject is a **prior** finding plus the delta hunks that touched its locations.
- The question is *"is this specific defect still present at these locations, at this head?"*
- The verdict maps to the reader's vocabulary:

| refuter outcome | re-review meaning | reader sees |
|---|---|---|
| `refuted` | the defect is demonstrably gone — the code positively contradicts it | **`resolved`** ✅ (the only path to the word) |
| `corroborated` | still present | `persist`, thread stays |
| `downgraded-latent` | real but unreachable at this commit | `persist`, advisory tier |
| `inconclusive` | could not tell — **and it is not a polite `refuted`** (`:439-453`) | **`unconfirmed`** |

The direction of error is deliberate and matches the project's standing rule: an unverifiable finding
stays on the PR. Visible noise beats invisible loss.

Prior findings and author replies enter this prompt as **user-authored text**, so C4's boundary-tag rule
applies from day one — `wrapBlock` with the run nonce, and a forged nonce lands `inconclusive` without
spawning (`src/pipeline.ts:995-998`). The mechanism is already there; item 7 must not open a new path
around it.

### 3.4 Identity — the unordered proof-ref location set

From §0.6, the only key that survived the real data:

```
identity(finding) := { normalize(path):lineSpan  for each proof_ref, plus finding.path:finding.line }
match(a, b)       := paths(a) ∩ paths(b) ≠ ∅
                     AND ∃ p ∈ paths(a) ∩ paths(b) with overlapping-or-near line spans (window)
```

Order-independent by construction, so the producer/consumer flip cannot break it. Verified against the
PR 1759 pair in both directions: it pairs both defects and over-merges neither (§0.6).

This does **not** replace the existing marker key — it layers above it. The per-finding
`<!-- pr-hero-finding -->` marker (`src/pr-preflight.ts:386-393`) stays exactly as-is, because it is what
binds a triage reply to its thread by exact identity (`src/triage-reply.ts:63-88`), and that binding must
stay strict. Identity for *re-review* is the looser, order-free key.

**Direction-of-error rule, inherited from C1a and non-negotiable:** this matcher must err toward
**under-matching**. Over-matching hides a live defect behind a `persist` and flatters the engine.

#### 3.4.1 The semantic tier, and why it costs nothing to add

DashBench pairs deterministic matching with an LLM judge "where semantic matching is needed"
(`doordash-dashbench-trust.md:248-249`), and names the cost of deterministic-only: it "misses semantic
equivalence" (`:208-209`). §0.6 is exactly such a miss — one defect, two claim fingerprints.

The rule above looks like it forbids a judge. It does not, once the judge's output is given the right
job: **a judge-proposed match is not a match. It is a verification trigger.** It feeds §3.2 row 4 and
forces a refuter step on that prior finding; it never writes `persist`, never retires an identity, never
suppresses anything. So:

- a judge **false positive** costs one refuter step and nothing else — the refuter corroborates, the
  finding stays;
- a judge **false negative** leaves us exactly where deterministic-only already was.

Neither direction can hide a live defect, so rule 2 of the strategy page survives intact and the
deterministic set remains the only thing that classifies. The tier is therefore additive and safely
deferrable: ship without it, add it when a second PR-1759-class pair shows deterministic-only losing a
real pairing.

### 3.5 The state block — one place, both holes closed

A second marker family on the **summary** comment, disjoint from both existing families
(`pr-hero-finding` and `pr-hero-report`), whose disjointness is already a tested property
(`src/pr-preflight.ts:354-359`):

```html
<!-- pr-hero-state v=1 head=<40hex> -->
<!-- {"findings":[{"id":"F001","sev":"CRITICAL","tier":"blocking","channel":"inline|outside",
     "locs":["path:line-line", ...],"c":"<12hex>"}, ...]} -->
```

It carries identity for **every** finding, inline and outside-diff alike. That is what closes F4: an
un-anchorable or 422-demoted finding gets cross-run identity without a `pr-hero-finding` marker on the
summary — which `src/report.ts:608-610` correctly refuses, since it would make
`fetchPostedFindingComments` treat the summary as a finding comment.

Constraints:
- The summary is already **PATCHed** in place when a marked comment exists (`src/pr.ts:615-642`), so the
  block is rewritten each run and never accumulates.
- GitHub's comment body cap is 65536 bytes. The block is capped and **degrades loudly**: over the cap it
  keeps the highest-severity N and states in the visible body that identity for the remainder was dropped.
  A silent truncation here would resurface findings as `fresh` — the exact bug being fixed.
- `parseFindingMarker` must remain unable to parse it (it requires the `pr-hero-finding ` prefix and all
  four fields — `src/pr-preflight.ts:411-447`), and a test must assert that.

### 3.6 Triage-aware matching (D6)

`matchPostedFindings` gains the triage markers already fetched by `runTriageCommand`
(`src/cli.ts:2410-2431`) as an input — not a new fetch, a wider read of the same comment set:

| tag on the thread | re-review behaviour |
|---|---|
| `applied` | verify (D3). `refuted` → `resolved`; anything else → back on the PR, and the author's claim was wrong |
| `dismissed` + adjudicator `upheld` | suppressed for this and every later run at this identity |
| `dismissed` + adjudicator `rejected` | returns, with the disproof cited |
| `deferred` (+ issue number) | suppressed from the blocking count, listed as deferred with its issue link |
| `misclassified` | severity/tier re-derived per the adjudicator, not re-hunted |
| `inconclusive` verdict (any tag) | **not** suppressed — `row.verdict = null` already routes to Pending triage (`src/triage-write.ts`) |

Suppression is scoped to the identity, not to the PR: the same defect appearing at a *different* location
is a different identity and returns.

### 3.7 Collapse (O-2)

Mechanically, `persist` already achieves it by not reposting. What is missing is anything acting on
`resolved` — today nothing does (§0.1). Item 7 adds, in order of confidence:

1. a `✅ resolved` reply on the thread **and** GraphQL `resolveReviewThread` — the call already exists
   (`src/pr.ts:1301-1309`), used today by `triage reply` via `decideThreadResolve`. **On GitHub this IS
   the collapse** DoorDash's criterion asks for: a resolved thread folds away on its own;
2. the summary rewritten to the current state each run (already PATCH, §3.5), and it **lists every
   persisting finding with its status** — this is what replaces Cloudflare's re-emission
   (`:379-380`) without adding a comment per push. Without it the author cannot tell "still live" from
   "the bot forgot about it", which is the one thing their mechanism buys that silence does not;
3. **no** minimize/hide API call — and that is not a refusal of DoorDash's criterion, see §4.

O-2 is a reader criterion, so its test is a rendered-output test over a simulated N-push sequence, not a
matcher unit test. That is the whole reason it is written down (the ROADMAP entry says as much: the
matcher satisfying it is a claim, not a guarantee).

### 3.8 The report's vocabulary (D7, O-1)

`deltaLine` (`src/report.ts:596-601`) becomes:

```
Δ since <sha8>:  N resolved (verified) · N unconfirmed · N new · N persist · N deferred
```

`resolved` is emitted **only** from a `refuted` verdict or from a deterministic file deletion. If nothing
verified, the count is `unconfirmed` and the word `resolved` does not appear. This is the one-line change
that makes the whole feature honest, and it is testable offline in isolation.

### 3.9 The mid-run head move (O-6, #39's policy half)

The pinning half is built (§0.5): `commit_id` is sent, the head is re-read before anchoring
(`src/cli.ts:1899-1903`), and a moved head is loud on both surfaces. The 422 path demotes survivors into
the Outside Diff bucket (`src/pr.ts:1136-1155`). What remains is the case the 422 does not cover — a line
that still exists and now means something else:

**Policy: when `movedHeadSha` is set, findings computed on the stale tree do not post inline.** They go to
the Outside Diff bucket, which §3.5 now gives identity to, so the next run re-verifies them against the
new head instead of re-discovering them. Conservative, and it costs nothing extra because the bucket and
its identity both exist by then.

---

### 3.10 The wiring — added 2026-08-20 after Juanma asked whether the design was complete

It was not. §§3.1–3.9 decide **what a re-review concludes**; this section decides **how it runs**, and the
audit that produced it found one defect that would have shipped.

#### 3.10.1 The command surface: automatic, with `--full` as the opt-out

`pr-hero review --pr <n>` **is** the re-review when a prior review exists on the PR. There is no
`--rereview` flag, and this is not a convenience choice:

- A flag nobody types is a feature nobody gets. The person this item exists for is a stranger's second
  push, and they will not pass a flag.
- **The bug being fixed is the default**, not a missing capability. Leaving the delta path behind a flag
  means the default stays "re-hunt the whole PR and infer repair from absence" — that is the thing item 7
  exists to remove.

`--full` forces case A (full `B..H`, everything reclassified) for the human who wants the whole PR looked
at again. It is the only new flag, and `parseArgs` must refuse it on every verb except `review`, exactly
as it refuses `--scout` today.

#### 3.10.2 Pipeline order, and the one sequencing constraint

```
preflight   read L (§3.1 case A fallback) → state machine → the two deltas (§3.1.1) → size gate on the delta
triage      deterministic rows 1, 5-12 settle with ZERO spend; rows 2 and 3 enter the verification queue
discovery   hunters over the restricted delta — unchanged, parallel, as today
dedupe      unchanged
row 4       every discovery finding whose §3.4 identity overlaps a prior finding APPENDS it to the queue
verify      the queue runs, one refuter-shaped step per finding (§3.3)
refute      the normal leg over fresh BLOCKER/CRITICAL survivors — unchanged
finish      deriveTier, vocabulary (§3.8), assemble
```

**The constraint is row 4: the verification queue cannot be closed until dedupe has run**, because that is
when a discovery finding's identity is final. So the whole verification leg runs after dedupe. Starting
rows 2 and 3 early, in parallel with the hunters, and appending row 4's later is a latency optimization
worth doing **second** — it buys wall-clock, not correctness, and it makes the queue mutable while steps
are in flight, which is exactly the kind of thing that breaks quietly.

#### 3.10.3 Provenance — the M6 lesson, applied before it costs anything

M6's instrument reads arm identity off `pipeline.json`'s `scout.enabled`, never off a directory name, and
a run whose artifact cannot name its arm is skipped rather than counted as the arm it resembles
(`src/floor-test.ts`). A re-review needs the same property or **no future measurement of this feature is
possible**, and `writePipelinePlan` (`src/pipeline.ts:1392-1420`) records nothing about one today.

A `rereview` block, absent on a first review, present on every other:

```jsonc
"rereview": {
  "case": "A|B|C|D|E",                         // §3.1
  "last_reviewed_head": "<40hex>",             // or null
  "last_head_source": "summary_marker|finding_markers|absent",
  "discovery_range": "<from>..<to>",
  "discovery_restricted": true,                // §3.1.1 — false means case A/D full range
  "prior_findings": 0,
  "settled_deterministically": 0,              // rows 1, 5-12
  "verified": 0,
  "verification_triggers": { "touched": 0, "applied": 0, "overlap": 0 }
}
```

`last_head_source` is there because the case-A fallback (§3.1) silently changes what the run did; an
artifact that cannot distinguish "the summary told us L" from "we reconstructed L from finding markers"
cannot debug the run where that fallback misfires.

#### 3.10.4 The cost band would have lied, and that is a defect this audit caught

`estimateCost` (`src/report.ts:75`) estimates **"from the diff, and only from the diff"** (`:57`), and the
comment above it records why it is skewed high: *"Every recorded overrun was an UNDER-estimate, never"*
the other way (`:47`). A re-review's spend is the delta **plus one step per verified finding**, and that
second term is invisible to a diff-only estimate. A PR carrying 40 prior findings whose sites all moved
is 40 extra steps the band would not have shown.

So: **`estimateCost` takes the verification-step count, and the plan card shows it as its own line before
the confirm.** Two consequences follow, and the second one amends an obligation:

- The size gate runs on the delta (§3.1.1) but **cannot** see the verification queue, so it is not the
  protection here — the cost band is.
- **O-5 as first written is an unconditional claim and it should not be.** A re-review is cheaper in the
  ordinary case (small delta, few prior findings) and can be dearer in the pathological one. The design's
  job is not to promise cheap; it is to make the number visible before the money is spent, and to let the
  confirm refuse.

#### 3.10.5 The watcher gets this, and the reason it is not M5's decision again

M5 deliberately kept `--scout` away from the watcher: unmeasured stage, added spend, and the watcher
spawns `review --pr <n> --yes` with no human at the confirm. None of those three apply here.

There is **nothing for the watcher to learn** — §3.10.1 makes re-review the behaviour of the command it
already spawns, not a flag. Its spend is bounded by the delta-scoped size gate and the existing
`daily_cap`, and in the ordinary case it goes down.

**One precondition, and it is not a follow-up:** §3.10.4's cost-band change ships **before** the watcher
runs a re-review unattended. An unattended run whose cost band cannot see the verification steps is
exactly the shape of an unbounded spend, and this project has already paid for that lesson once.

---

## 4. What item 7 does NOT do

- **No exactly-once on `--post`.** Two overlapping runs can still both PATCH the same summary
  (`runPostCommand`, `src/cli.ts:2194-2317`, takes no lock). That is Phase E and stays there.
- **No minimize/hide of old GitHub comments — and this is NOT declining DoorDash's "collapse old
  comments during re-review" (`doordash-ai-code-reviewer.md:284-285`).** Corrected 2026-08-20; the
  earlier wording here framed it as a divergence and it is not one. On GitHub, **resolving a thread IS
  collapsing it** — §3.7 resolves every verified-fixed thread and GitHub folds it away — and there are no
  superseded comments to hide because we never repost. The accumulating pile their criterion describes
  cannot form. We satisfy it by construction; the minimize/hide *API* is what we are not calling, which
  is a different and much smaller statement.
- **No re-run of the refuter over `fresh` findings** — the normal pipeline already does that leg.
- **No scout stage in the delta review.** M6 closed `opt-in` (2026-08-20), so the pipeline item 7 is
  designed against has no scout by default. `--scout` continues to work and is orthogonal: it would see
  the delta diff, which is strictly smaller, and needs no item-7-specific handling.
- **No change to the `pr-hero-finding` marker format.** §3.4 layers above it; changing it would break
  every thread already on every open PR.
- **No fix for the issue-channel triage blind spot.** `runTriageCommand` only walks review comments with
  `in_reply_to_id` (`src/cli.ts:2410-2431`), so issue-channel triage replies are invisible to the ledger
  write-back. Real, verified this session, and **out of scope** — it is a triage defect, not a re-review
  one. It needs its own issue.

---

## 5. Done-checklist — one named test per obligation

- [ ] **O-1a** `deltaLine` cannot print `resolved` without a verification verdict — a rendering test that
      feeds absence-only input and asserts the word does not appear.
- [ ] **O-1b** A finding whose site is untouched and which the hunters did not re-find is classified
      `persist`, never `resolved`. **Fixture: the PR 1759 pair (§0.6), replayed offline from the two
      artifact directories.** This test is the reason this design exists; it must fail against today's
      matcher.
- [ ] **O-2** A simulated three-push sequence renders a summary containing only current-state findings —
      no superseded round appears in the body.
- [ ] **O-3a** A `dismissed`+`upheld` identity does not appear in a later run's output at any tier.
- [ ] **O-3b** A `deferred` identity appears in the deferred list with its issue number and is absent from
      the blocking count.
- [ ] **O-4** Every input to the re-review decision is derived from PR data in the test's fixtures; the
      test runs with no `~/.prhero` and no run directory present.
- [ ] **O-5a** The cost band carries the verification-step count as its own term: two plans over the same
      delta but 2 vs 40 queued verifications produce different bands (§3.10.4). A band that does not move
      fails.
- [ ] **O-5b** In the ordinary case — small delta, few prior findings — the planned spend is strictly
      lower than the same PR's first review. Asserted on the plan, never on a live run.
- [ ] **W-cli** `parseArgs` accepts `--full` on `review` and refuses it on every other verb; a PR with a
      prior review takes the delta path with **no flag** (§3.10.1).
- [ ] **W-order** The verification queue is closed only after dedupe: a discovery finding whose identity
      overlaps a prior one is in the queue, and no verification step is spawned before dedupe (§3.10.2).
- [ ] **W-prov** `pipeline.json` carries the `rereview` block with the case, both range ends,
      `last_head_source`, and the three trigger counts; a first review carries no block at all. A run that
      cannot name its case from the artifact is unscorable, never assumed (§3.10.3).
- [ ] **O-6** With `movedHeadSha` set, no finding computed on the stale tree appears in the inline post
      plan; all appear in the bucket.
- [ ] **D4** `lastReviewedHead` not an ancestor of `head` → the plan is a full review, **every** prior
      finding is queued for verification, and both surfaces carry the banner.
- [ ] **S-A** With the summary comment absent, `L` is recovered from the per-finding markers' `head=` and
      the run does **not** fall to first-review semantics (§3.1, case A fallback).
- [ ] **S-B** `L === H` plans zero discovery steps and verifies only findings carrying a new reply.
- [ ] **S-merge** A delta containing a merge of the base branch produces a discovery diff restricted to
      `files(B..H) ∩ files(L..H)` — upstream-only files are absent from the plan.
- [ ] **S-revert** A file reverted to base drops out of the restricted delta **but still trips the
      touched gate**, and its findings land on row 11 (`resolved`), not row 1 (`persist`).
- [ ] **S-overlap** A discovery finding whose §3.4 identity overlaps a prior finding forces that prior
      finding into verification (row 4).
- [ ] **S-base-moved** `merge-base(base, H)` moving between runs does not change the discovery delta.
- [ ] **O-2b** The rendered summary lists every `persist` finding with its status — asserted on the
      rendered lines, and a `persist` finding missing from that list fails the test (§3.7, the stand-in
      for Cloudflare's re-emission).
- [ ] **W-worse** A `dismissed`+`upheld` identity stays suppressed against a same-severity discovery
      finding, and **returns** against a strictly-higher-severity one, with both severities named in the
      summary (§3.2.2).
- [ ] **J-trigger** A judge-proposed semantic match can only route a prior finding into verification —
      asserted by construction: no code path lets a judge output write `persist`, retire an identity, or
      suppress a finding (§3.4.1). This test must exist **before** any judge tier is wired, not with it.
- [ ] **D5a** `parseFindingMarker` returns `null` for the state block.
- [ ] **D5b** Over the size cap, the state block drops findings **and** the visible body says so.
- [ ] **D5c** Identity matching pairs both PR 1759 defects across runs -2/-3 and over-merges neither —
      the §3.4 mechanism asserted against the real artifacts, both directions.
- [ ] **C4** The verification prompt inlines prior findings and author replies inside nonced boundary
      tags; the artifact-level preamble test (`test/pipeline.test.ts`) still walks every `*.system.md`.

Offline in every case. `bun test` + `bun run typecheck` + `bun run check`, then one fixture eval, then a
single live re-review on a real musive PR before this is called done.

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
3. **Does a `refuted` verification also retire the identity from the state block?** If yes, a defect that
   returns later is `fresh` again (arguably correct — it is a regression). If no, the block grows without
   bound. Leaning yes, with the ledger keeping the history.
4. **C1a's ordering assumption is falsified (§0.6) and `root_cause_id` is affected, not only re-review.**
   Root-cause clustering anchors on the first `proof_ref`; that order is not stable. Out of scope here,
   but it wants its own entry — the cluster counts in every report inherit the same instability.
5. ~~**A semantic identity tier.**~~ **CLOSED same day, in §3.4.1.** The question was whether a judge
   could only ADD a match, never silently suppress a finding. It can: a judge-proposed match is not a
   match, it is a **verification trigger** feeding §3.2 row 4. A false positive costs one refuter step; a
   false negative leaves us where deterministic-only already was. Neither direction hides a live defect.
   Additive, and deferrable until a second PR-1759-class pair proves the loss recurs.
6. ~~**The worsening re-open path.**~~ **CLOSED same day, in §3.2.2.** *Worsened* := a discovery finding
   at the same §3.4 identity with **strictly higher** severity than the suppressed one. Mechanical, uses
   only fields that already exist, and it does not re-litigate a `dismissed` at equal severity.
7. **Does the summary's persisting list scale?** O-2 now requires listing every persisting finding with
   its status (§3.7). On a long-lived PR with many advisories that list grows while the state block
   (§3.5) is already competing for the same 65536-byte body. Open: does the visible list need its own
   cap and collapse-by-severity, and does that cap interact with the state block's?
