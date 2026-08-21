# Judgment Day — frozen ledger, round 1

```
target_identity  5ccbb0cf85bcb4679370b9f022707211ffce1ef10f9620cb50fcba06b83f78c8
target           docs/item7-rereview-design.md @ e3558b91f87b5507b1ed3b75a147348d73f410d9 (956 lines)
round            1
judges           jd-judge-a, jd-judge-b — blind, parallel, read-only, identical scope
judge A          19 findings (5 CRITICAL, 12 WARNING, 2 SUGGESTION)
judge B          19 findings (8 CRITICAL, 11 WARNING, 0 SUGGESTION)
confirmed        13   (7 CRITICAL-class, 6 WARNING-class)
suspect          12   (single-judge, no auto-fix)
contradictions   0    — the judges never disagree; they overlap or complement
skill_resolution none — no project skill governs this target
round 1 fixes    C1-C13 + S1, S2 — status: fixed 2026-08-20, in docs/item7-rereview-design.md
                 S3-S12 remain open and untouched; no rows added
```

## CONFIRMED — both judges, independently

### C1 · CRITICAL · `resolved` has three mutually exclusive definitions, and rows 9/11 emit it with no verification  ·  status: fixed (round 1)
A(:520-527) + B(:407-410) + B(:522). Strategy rule 3 (:39-40), D7 (:396) and O-1 (:407-409) say `resolved`
requires a verdict. §3.3's table (:602) says `refuted` is "the only path to the word". §3.8 (:725) says
verdict **or** deterministic file deletion. §3.2 rows 9 and 11 emit it at cost 0 with no verdict. Test
O-1a (:868) fails by construction against rows 9/11. The strategy page's own precedence rule makes rows
9/11 "the bug".

Two independent kill-shots on row 11 specifically:
- **B:** a finding OUTSIDE the PR's diff (§3.1.2 explicitly permits blast-radius findings; the engine has
  a bucket for them, `src/report.ts:604-610`) has locations identical to base **by construction** → row 11
  fires on the first re-review and reports a repair in code never modified.
- **A:** `causal_disposition: "pre-existing"` is a valid value (`src/pipeline.ts:365-366`); a pre-existing
  defect whose file the author reverts satisfies row 11 verbatim → still-present defect marked `resolved`.

### C2 · CRITICAL · §3.7 auto-closes live threads, because gate-`persist` lands in `MatchResult.resolved`  ·  status: fixed (round 1)
A(:520-527 second half) + B(:699-715). The word `persist` names two incompatible things: §3.2 row 1's gate
output, and `MatchResult.persist` (`src/inline.ts:190-197`), which requires a **current-run finding** to
have matched. A row-1 prior has no current-run finding by construction — delta-scoped discovery never
visits its untouched site — so it falls into `MatchResult.resolved` via the set subtraction at
`src/inline.ts:321-322`. §3.7 then adds a ✅ reply and GraphQL `resolveReviewThread` (`src/pr.ts:1413`).
**As specified, every ordinary case-C re-review auto-closes every still-live thread on the PR.** No
mechanism in §3 severs `matchPostedFindings`'s `resolved` computation; §3.6 only widens its inputs.

### C3 · CRITICAL · `runRefuter` is not re-entrant, and the id collision deletes a live finding  ·  status: fixed (round 1)
A(:589-596) + B(:589-592). §3.10.2 runs the verify leg and the ordinary refute leg in the same run. Ids are
per-run positional — `src/dedupe.ts:205` renumbers to `F001`, `F002`… — and the state block stores priors
under the previous run's ids, also `F001`. Collisions on five shared names: `state.verdicts`
(`src/pipeline.ts:1084`), `steps/refuter-<id>.result.json` (`:1009-1012`), `refuter-batch.json` and
`refuter.system.md` (`:948-961`), `state.perAgent.refuter` (`:1111-1121`). Concretely: the verify leg sets
`verdicts['F001'] = 'refuted'` for a prior; `finish()` (`:1334-1341`) reads it for **this run's** fresh
`F001` and deletes it into `debug.refuted[]` — invisible loss of a live finding never submitted to any
refuter. `runRefuter` also takes `DedupedSurvivor[]`, a shape a PR-recovered prior does not have.

### C4 · CRITICAL · §3.2's twelve rows are neither ordered nor disjoint, and §3.10.2 mis-partitions them  ·  status: fixed (round 1)
A(:765-780) + B(:510-523). Row 12 ("verification returned `inconclusive`") is an **outcome** of rows 2/3/4,
not an input state, yet §3.10.2:767 puts it in the zero-spend pre-token phase. Row 1 requires "no overlap",
and overlap is row 4, which §3.10.2 itself places **after dedupe** — so row 1 cannot settle in that phase
either. §3.2's own heading claims the gate runs "before a single token" while row 4 costs the entire hunter
fan-out. And no precedence is stated for realistic multi-row hits: `touched` (row 2, 1 step) + `dismissed`
+`upheld` (row 5, 0) prescribe opposite outcomes at opposite cost; same for row 3 vs rows 9/11. Row 10
re-enters the table instead of terminating. §3.2.2's hatch depends on row 5 being reached, so the missing
order changes whether it fires at all.

### C5 · CRITICAL · unattended verification spend has no bound  ·  status: fixed (round 1)
A(:827-838) + B(:809-838). §3.10.4 says outright the size gate "**cannot** see the verification queue, so
it is not the protection here — the cost band is" (:821-822). §3.10.5 then clears the watcher on the claim
that spend is bounded by "the delta-scoped size gate and the existing `daily_cap`". Neither bounds it: the
watcher spawns `review --pr <n> --yes` (`src/watch.ts:711-713`) and `--yes` short-circuits `confirm()`
(`src/cli.ts:698-706`), so the band prints to nobody; `daily_cap` counts **launches**, not dollars
(`src/watch-preflight.ts:740-741`). The engine already recorded this exact lesson — the size gate was moved
ahead of the confirm because "a gate that lived only inside that confirmation would never fire in the one
place — unattended spend — it exists to protect" (`src/cli.ts:687-691`). Queue size is externally driven:
case D verifies **every** prior finding, row 3 pays per `applied`, row 4 per overlap, case B per reply.
§3.10.5's stated precondition does not close the hole it names.

### C6 · CRITICAL · an empty restricted delta aborts the entire re-review, verification included  ·  status: fixed (round 1)
A(:442-447) + B(:471-473). `files(B..H) ∩ files(L..H)` is legitimately empty when the author's only new
commit reverts a PR change back to base (the design says so itself at :476-477), and when a merge of main
touches no PR file. Case B (`L === H`) prescribes "discovery: none". In all three, `src/cli.ts:1057-1061`
throws `CliError(emptyDiffMessage(...))` and `:1070-1072` throws `allExcludedMessage(...)` — **before** the
run dir, the size gate and the pipeline exist. So rows 2 and 3 never run, nothing is posted, and the PR is
left with a stale report. §0.2 cites `src/cli.ts:1057` without noting the guard on the next two lines.

### C7 · CRITICAL · persisting findings are absent from the run's document, and four surfaces depend on them  ·  status: fixed (round 1)
A(:699-715) + B(:657-680). Delta-scoped discovery plus row-1 `persist` (never re-hunted) means the
re-review's `findings[]` holds only the delta's new findings. Consequences with no named mechanism:
- `src/report.ts:550-561` prints "✅ pr-hero reviewed this PR and found nothing to report." when
  `findings.length === 0`, and `:541-544` computes the headline counts from the same array. A PR with 6
  unfixed persisting findings and one clean commit gets a **green false-clean bill** — the rule the design
  adopts from DoorDash at :47.
- O-2's amendment (:413-415) and its test O-2b (:907-909), §3.8's `N persist` term (:722), and §3.5's
  "identity for **every** finding" (:668) all have **no data source**.
- CLAUDE.md rule 5 (schema compatibility with the lab is sacred) blocks adding carried-forward findings to
  `findings.json`, and the design names no alternative.
- §3.5's population is ambiguous in exactly this way: written from this run's document the block shrinks
  every push and priors silently lose identity; carrying priors forward makes ":674-675 never accumulates"
  false and revives §6 #3's unbounded growth.

### C8 · WARNING · case B's "new author reply" has no discriminator  ·  status: fixed (round 1)
A(:445) + B(:445). The triage marker carries `tag`, `head`, `actor`, optional `issue`/`verdict` and **no
timestamp** (`src/triage.ts:136-168`); in case B `L === H` by definition, so `head=` cannot separate a reply
written before the last review from one written after. The review path's fetch projects no timestamps
(`src/pr.ts:759-761`). D2 forbids new persistent state and O-4 requires PR-only recovery. Test S-B asserts
the behaviour without naming the input.

### C9 · WARNING · §3.9's premise is the case the shipped pin already covers, and its policy reverses the direction-of-error rule  ·  status: fixed (round 1)
A(:729-739) + B(:729-739). §3.9 says "what remains is the case the 422 does not cover — a line that still
exists and now means something else"; `src/pr.ts:1090-1097` says that is exactly what `commit_id` covers
("Pinned, GitHub anchors to the reviewed commit and marks the comment outdated ITSELF once the lines move
— the reconciliation the engine would otherwise have to invent"). §0.5 already verified that pin as built.
`movedHeadSha` is set whenever the live head differs **at all** (`src/cli.ts:1899-1903`), so the policy
demotes **every** inline finding on any concurrent push — and bucket findings lose their marker, which is
what binds a triage reply and what §3.7 acts on. O-6's test is also unsatisfiable as worded: the post plan
is built before the head re-read, which `src/cli.ts:1886-1891` deliberately keeps as late as possible.

### C10 · WARNING · the case-A fallback recovers `L` and loses everything else  ·  status: fixed (round 1)
A(:457-462) + B(:453-462). It fires precisely when the summary comment is gone — and D5/§3.5 put the state
block on that same comment. So it restores `L` while losing every finding's §3.4 identity, every severity
§3.2.2's hatch needs, and all identity for Outside Diff findings, which carry no marker at all
(`src/report.ts:604-610`). Per-finding markers carry only path/line/head/c (`src/pr-preflight.ts:386-393`).
And the design never says **which** marker's `head=` becomes `L` when several disagree — a row-1 `persist`
finding is never reposted, so its marker's head is frozen several pushes stale.

### C11 · WARNING · the `BoundaryTag` union is closed, and the code already names this item's obligation  ·  status: fixed (round 1)
A(:610-613) + B(:610-613). `src/boundary.ts:21-30`: "Item 7 will add `previous_finding`, `author_reply`,
`comment_body` and `triage_tag`; they are deliberately NOT declared here yet, so adding one is a visible
widening of this union at review." The design never mentions `src/boundary.ts` or the widening. Worse, the
forgery guard it cites (`src/pipeline.ts:995-998`) covers the finding JSON only; a reply added as a separate
block reaches `wrapBlock`, which **throws** (`src/boundary.ts:96-100`) — the "kill a paid run at its last
leg" outcome `src/pipeline.ts:968-978` exists to prevent. `runRefuter`'s payload is a fixed five-key object
with no slot for a reply or for hunks (`:982-994`), contradicting "unchanged in shape".

### C12 · WARNING · the Outside Diff population has no thread, so triage and collapse are inapplicable to it  ·  status: fixed (round 1)
A(:699-715) + B(:392). Bucket findings render inside the summary body with the marker deliberately stripped
and have no review thread; `decideThreadResolve` returns `skip-issue-channel` (`src/triage-reply.ts:96-103`)
and triage replies bind only through `in_reply_to_id` on review comments (`src/cli.ts:2413-2431`). So a
422-demoted or un-anchorable finding can never be tagged `applied`/`dismissed`/`deferred`, which voids
§3.2.1's third remedy and rows 3 and 5-8 for it, and §3.7's resolution has nothing to act on. §3.9's new
policy grows exactly this population. §4 declares DoorDash's criterion "satisfied by construction" on this
basis.

### C13 · WARNING · §3.6 cites the wrong producer  ·  status: fixed (round 1)
A(:683-685) + B(:683-684). `runTriageCommand` is a separate verb (`pr-hero triage --pr <n> --from <dir>`)
that requires an existing `comparison.json` and never runs during `review --pr`. The review path's fetch is
`fetchPostedFindingComments` (`src/pr.ts:793-820`), which discards every comment that does not parse as a
finding marker — including every triage reply. Substance salvageable at a different site; the citation does
not support "already fetched", in a document whose §0.5 exists to correct exactly this.

## SUSPECT — one judge only. Recorded, NOT auto-fixed.

| id | judge | severity | claim |
|---|---|---|---|
| S1 · **fixed (round 1)** | A | CRITICAL | §3.4's `match()` fires on **one shared citation anywhere**, which is the "shares any ref" rule `src/root-cause.ts:60-70` explicitly rejects in this codebase ("welds unrelated defects into one blob"). Two findings sharing an incidental util ref become one identity → a suppressed low-severity dismissal swallows an unrelated live defect, and §3.2.2 only lifts on strictly-higher severity. Directly contradicts §3.4's own "must err toward under-matching". |
| S2 · **fixed (round 1)** | B | CRITICAL | `--full` routes to case A, whose verification cell is "nothing to verify" — so it skips the §3.2 gate entirely, including rows 5 and 7. A `dismissed`+`upheld` finding re-posts blocking. Violates O-3 and fails its own test O-3a. Offered as the ordinary human escape hatch with no note that it discards triage state. |
| S3 | A | WARNING | `touched()` compares against locations stored at the head where the finding was first written; row 1 never recomputes them, and §3.5 gives no re-anchoring rule. Over pushes the spans drift off the real code — `persist` forever on an edited site, row 2 on an unrelated hunk. The existing matcher solves this with `livePath`/`liveLine` (`src/inline.ts:178-183`), an input the state block lacks. |
| S4 | A | WARNING | The summary race deferred to Phase E now destroys identity, not just a duplicate PATCH: D5 makes the state block the sole carrier. `postPrComment` is a read-modify-write with no ETag/`If-Match`/lock (`src/pr.ts:609-642`). Watcher tick + manual `post` overlap → later write discards the other run's identity set; those findings resurface as `fresh`. |
| S5 | A | WARNING | The state block embeds raw JSON in an HTML comment with no escaping rule, beside a marker that percent-encodes its path for exactly this reason (`src/pr-preflight.ts:336-346`), in a codebase that asserts summary strings must not contain HTML comment markers (`src/findings.ts:340-342`). A path containing `-->` terminates the comment early. |
| S6 | A | WARNING | Row 7, §3.6 and test O-3b all assume `deferred` carries an issue number. `src/triage.ts:243-247` makes it optional and `:76-81` records the decision: "a deferred finding is a TAG plus reasoning, not a mandate to create a GitHub issue". O-3b fails against a legitimate reasoning-only defer. |
| S7 | A | WARNING | Case E ("`L` is not a commit in this repo") is a property of the **local object store**, so the same PR takes different, differently-priced routes on different machines — contradicting O-4. `actions/checkout` defaults to `fetch-depth: 1`, so case C on a full clone becomes case E on a runner: full `B..H` plus verify-everything. §3.1's "every failure mode falls to the conservative side" is true for correctness, false for cost. |
| S8 | B | WARNING | §3.5's cap keeps "the highest-severity N", which evicts exactly the identities that must never be evicted: dismissals cluster at the low-severity end (`src/dedupe.ts:17-22`). Every evicted suppression returns as `fresh`, violating O-3. The adjacent sentence names this failure mode and then prescribes a loud version of it. |
| S9 | B | WARNING | §3.5 states no **placement** constraint, and both existing readers key on byte 0: `findMarkedCommentId` requires `body.startsWith(PR_COMMENT_MARKER_PREFIX)` (`src/pr-preflight.ts:313-323`) and `parseMarkerHead` anchors to the first line (`src/watch-preflight.ts:514-521`). A state block emitted first orphans the summary — a new comment every run, and `L` lost, forcing case A forever. Test D5a checks the wrong reader. |
| S10 | B | WARNING | `proof_refs` is unvalidated free text — `src/drafts.ts:184-187` asserts only `Array.isArray`, and `src/inline.ts:138-151` returns null for anything not `path:line`. A hunter citing prose yields an empty parsed set, so identity collapses to `{finding.path:finding.line}` — the key §0.6 proved insufficient — and `touched` degenerates, pinning the finding on row 1 forever. |
| S11 | B | WARNING | Author replies are attacker-controlled by the person whose code is under review, and under §3.3 a `refuted` verdict now additionally maps to `resolved` ✅ and auto-closes the thread. The nonce guard is a substring forgery check only (`src/boundary.ts:53-55`); it does not constrain instruction-shaped content inside a correctly tagged block. No obligation or test covers this direction. |
| S12 | A | SUGGESTION | §0.1 mislabels the third matcher layer as the "different-head branch". The windowed pool is reached in two situations: a different head, **and** a same-head comparison whose stored line differs (`src/inline.ts:254-263`). Matters because case B reasons about same-head behaviour. |

## CONTRADICTIONS

None. The two judges never disagree; where they overlap they corroborate, where they differ they cover
different sections.

---

# Round 2 — scoped re-judgment over the frozen ledger + fix delta

```
target      docs/item7-rereview-design.md, uncommitted, sha256 3a08c1c0…80fe7 (1450 lines)
baseline    e3558b91 (956 lines) — delta is round 1's fifteen corrections
judge A     9 findings (4 CRITICAL, 5 WARNING)     judge B  12 findings (4 CRITICAL, 8 WARNING)
confirmed   5   (3 CRITICAL-class, 2 WARNING-class)
suspect     11  (single-judge)
contradictions 0
```

## CONFIRMED — round 2

### R2-C1 · CRITICAL · fix-CAUSED · step 9 (rename) is unreachable, and the consequence is a false ✅
A(:616-622) + B(:583-622). `touched()` is defined three lines above the list as including "file-level
containment when the file is added/deleted/**renamed**". The list is first-match-wins. So every rename hits
step 7 (`touched` → verify) and step 9 (follow git's rename, re-evaluate) is dead code — including the
paragraph defending its termination. B's consequence is worse than A's: the verification subject then
points at a path that no longer exists at H, a `refuted` verdict maps to `verified-gone` → the reader sees
`resolved` ✅ and the thread auto-closes **on a defect that merely moved file**. Caused by C4's ordering;
the baseline's unordered table let the rename row apply independently.

### R2-C2 · CRITICAL · NOT CLOSED · the false-clean fix closed one of four populations
A(:1061-1072) + B(:1048-1074). §3.8.1 merges `findings[]` with `rereview.carried[]` and keys the clean bill
on both being empty. But §3.2's outcomes and §3.5's merged set both name **`unconfirmed`, `suppressed` and
`deferred`** as separate still-live populations, and §3.10.3's artifact defines an array for `carried[]`
only. A re-review with zero new findings whose live priors all landed `unconfirmed` — the routine outcome
on a capped run, per §3.10.4 — still prints "✅ pr-hero reviewed this PR and found nothing to report" with
zero counts. And §3.8's own `N unconfirmed · N deferred` delta terms have no data source under either
reading, because `carried[]` entries carry no status field.

### R2-C3 · CRITICAL · NOT CLOSED · the containment formula still over-matches, two ways
A(:828-844) + B(:828-829). Two distinct defects in the same rule:
- **A:** a **single-location** finding — the common case, since a one-ref finding yields one path — is
  contained in ANY finding citing that file with a nearby span. So a suppressed LOW at `{a.ts, util.ts:12}`
  still swallows an unrelated live finding at `{util.ts:14}`, and §3.2.2 lifts only on strictly-higher
  severity. That is S1's harm verbatim. The verification table only exhibits the symmetric two-path case.
- **B:** the formula is written without parentheses, so ordinary precedence reads it as
  `a ⊆ b OR (b ⊆ a AND spans overlap)` — dropping the span check in one direction entirely.

### R2-C4 · WARNING · fix-CAUSED · the C8 discriminator wires one of its two inputs
A(:957-966) + B(:957-966). §3.6.1 defines "new" as the comment's `created_at` against the summary's
`updated_at`, then names only `fetchPrReviewComments`'s projection as the required change. The summary is a
top-level issue comment read through `fetchPrComments`, whose `--jq` projects `{id, user, body}`
(`src/pr.ts:688`), and **`updated_at` occurs nowhere in `src/`**. Test S-B asserts on both values.

### R2-C5 · WARNING · fix-CAUSED · `--full` is specified twice, incompatibly, and misses case B
A(:1138-1141) + B(:491-494). §3.1 says it "widens the discovery range of whatever case the PR is actually
in"; §3.10.1 says "`--full` is case C or D". On an unpushed PR (`L === H`, case B, discovery "none") the two
readings disagree about whether it widens anything — and case B is exactly when a human types `--full`.
The retracted rule always produced a full review. Case E is unlisted. `W-cli` covers neither.

## SUSPECT — round 2, one judge only

| id | judge | sev | claim |
|---|---|---|---|
| R2-S1 | A | CRITICAL | The C7 merged-set state block **recreates C3's id collision**: entries are keyed `"id":"F001"`, this run's findings are per-run positional, surviving priors keep their old ids, and no uniqueness rule is stated. So C3's V-id "derived from the state block's stored id" cannot map back. Test `D5d` asserts only the entry count. |
| R2-S2 | B | CRITICAL | **§0.3 still says the verification half is "already built" and item 7 "builds a second caller"** — the exact claim C3 retracted in §3.3 — and §0 declares itself authoritative over §3. An implementer follows §0.3 and builds the non-re-entrant caller. |
| R2-S3 | B | CRITICAL | `carried[]` carries `{id, sev, tier, channel, locs}` and **no finding text**. For `channel:"outside"` the previous summary body is the only copy of that text, and the per-run PATCH replaces it wholesale — so a live Outside Diff finding's content is **erased on the first re-review** and O-2b has nothing renderable. |
| R2-S4 | B | WARNING | Step 8 (overlap) is also unreachable: step 10 (`carried`) settles at preflight and first-match-wins, so nothing survives to reach step 8. Step 2 got an explicit provisionality escape; step 10 did not. Kills §3.2.1's second remedy, `S-overlap`, and the §3.4.1 judge tier. |
| R2-S5 | B | WARNING | The four declared outcomes do not cover steps 3 and 5 ("returns with the disproof cited", "re-tiered"), and §3.5/§3.8 use `deferred` as a fifth. On the literal reading a step-3 or step-5 prior is absent from the merged set, loses identity, and returns as `fresh`. |
| R2-S6 | B | WARNING | The C2 severance covers **thread resolution only**; the delta counts still read `MatchResult.resolved` (`src/inline.ts:379-384` → `src/report.ts:596-601`) and §3.8 names no replacement source. Kept as-is, `N resolved` prints once per untouched prior — the exact number O-1a forbids. |
| R2-S7 | A | WARNING | C10's tie-break ("most recently created marker comment") has **no timestamp input**, and the same delta says so elsewhere. `fetchPostedFindingComments` also concatenates per channel, so the merged order is not creation order. |
| R2-S8 | A | WARNING | Test `S-revert` asserts "absent a verdict, land on `carried`", but §3.3 has no "absent" row, a dead step defaults to `inconclusive` → `unconfirmed`, and §3.10.4 sends over-cap findings to `unconfirmed`. Two corrections prescribe different outcomes for one state. |
| R2-S9 | A | WARNING | Step 6 (`applied`) carries **no newness qualifier**, so the same tag is re-bought on every push forever — and in case B it charges for exactly the replies §3.6.1's discriminator exists to exclude. |
| R2-S10 | B | WARNING | §6 #3 is marked CLOSED on "neither shrinks nor grows without bound", but `suppressed` and `deferred` identities **never reach `verified-gone`**, the only specified exit. The block grows monotonically against a fixed 65536-byte body. |
| R2-S11 | B | WARNING | **D3 still says "exactly two populations"** while the mechanism it governs now has three verify triggers plus a verify-everything case. Independently reported by the round-1 fix actor as well — a third source. |

---

# Round 3 — scoped re-judgment over rewritten §3

```
target      docs/item7-rereview-design.md @ uncommitted, sha256 8d1ea7e6…01c1d (1100 lines pre-fix)
baseline    docs/item7-judgment-ledger.md rounds 1-2 (26 findings = requirements)
judge A     8 findings (1 CRITICAL, 6 WARNING, 1 SUGGESTION)
judge B     13 findings (2 CRITICAL, 9 WARNING, 2 SUGGESTION)
confirmed   3 CRITICAL-class, 5 WARNING-class
suspect     8 single-judge
contradictions 0
round 3 fixes  R3-F1..R3-F8 — status: fixed 2026-08-21, in docs/item7-rereview-design.md
```

## CONFIRMED — round 3

### R3-C1 · CRITICAL · R2-S5 · rules 4/6 outcomes had no home in `live[]` or `findings[]`  ·  status: fixed (R3-F1)
A(:634-636) + B(:634). `dismissed`+`rejected` and `misclassified` named outcomes but the gate table and
`live[].status` enum stopped at four values. **Fix:** `returned` / `re-tiered` gate outcomes; rules 4/6
repost into this run's `findings[]`; `live[]` holds passive statuses only.

### R3-C2 · CRITICAL · R2-C3-A · equal single-path identity matched without span check  ·  status: fixed (R3-F2)
B(:735). `(pa = pb)` let `{util.ts:14}` match `{util.ts:50}`. **Fix:** both branches require span overlap
on every path in `pa`; table row added.

### R3-C3 · CRITICAL · deferred identities evicted on state-block cap — O-3 violation  ·  status: fixed (R3-F3)
A(:797-799). Cap evicted `deferred` after `carried`. **Fix:** never evict `deferred` or `suppressed`.

## CONFIRMED — WARNING

### R3-W1 · R2-S8 · `S-revert` test contradicted §3.3 touched→verify→`unconfirmed`  ·  status: fixed (R3-F4)
A + B. **Fix:** test expects `unconfirmed` or `verified-gone`, not `carried`.

### R3-W2 · R2-S7 · case-A tie-break needed `created_at` on finding markers  ·  status: fixed (R3-F5)
A(:528-529). **Fix:** `fetchPostedFindingComments` projection extended; `PostedFindingComment` grows field.

### R3-W3 · case B promised new replies but §3.3 had only `applied`  ·  status: fixed (R3-F6)
A(:505). **Fix:** rule 7b — new triage reply on prior thread queues verify in case B.

### R3-W4 · verify queue double-charge unspecified  ·  status: fixed (R3-F7)
B(:585). **Fix:** dedupe by `R###` before phase F spawn.

### R3-W5 · R2-S6 · legacy `MatchResult.resolved` log lines still named  ·  status: fixed (R3-F8)
B(:843). **Fix:** §3.8 gates off resolved log/count in re-review mode.

## SUSPECT — one judge only

| id | judge | sev | claim | disposition |
|---|---|---|---|---|
| R3-S1 | A | WARNING | S10 proof_refs validation still design-light | open — partial fix in §3.5 identity write rule |
| R3-S2 | A/B | WARNING | S4 summary race — Phase E, §4 | accepted deferral |
| R3-S3 | B | WARNING | all-suppressed clean bill ambiguous | fixed in §3.8.1 (R3-F9, same pass) |
| R3-S4 | B | WARNING | R2-S10 monotonic growth of suppressed/deferred | open — cap never evicts them; §6 #7 tracks live-list scaling |
| R3-S5 | B | WARNING | O-2 cross-ref §3.10 vs §3.8.1 | fixed |
| R3-S6 | B | WARNING | §4 §3.7 vs §3.9 ref | fixed |
| R3-S7 | B | SUGGESTION | O-5a §3.10.4 vs §3.10.3 | fixed |
| R3-S8 | B | SUGGESTION | §0.7.4 stale step numbers | fixed (strategy refs → §3.3 rules) |

## Round 3 terminal state

**Pending scoped re-judgment or Juanma APPROVED.** No CRITICAL-class confirmed findings remain unfixed.
Open suspects (S4 race, S10 validation depth, R2-S10 growth) are documented deferrals, not design blockers
for implementation start — same class as Phase E exactly-once.
