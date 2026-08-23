# Item 7 runbook — prove the re-review when you have PRs

Open this when a real PR exists. The engine is wired; this file is the proof
order so the cases do not have to be reconstructed from
`docs/item7-rereview-design.md` §5.

**Launch checkbox closes only after a live second push.** Offline green is not
that checkbox. Design: `docs/item7-rereview-design.md`. ROADMAP: “item 7 is live”.

## Quick path

1. Commit the uncommitted item-7 slice if `git status` is still dirty on
   `src/cli.ts` / `src/report.ts` / `src/rereview-*.ts`. A live run against
   `origin/main` will not include collapse / O-2b / S-B.
2. `bun test && bun run typecheck && bun run check`
3. `bun run fixture-eval` (~$0.08, ~1 min). Optional: `bun run fixture-eval --scout`.
4. On a musive (or any real) PR that **already has** a pr-hero summary:
   `pr-hero review --pr <n> --post` from the operator checkout. **No `--rereview`
   flag.** `--full` only if you mean “re-hunt B..H”.
5. Walk the surfaces below. Tick the case that PR actually is. One ordinary
   case-C second push is enough to close “item 7 is live” if the launch lies
   do not fire. The other cards wait for a PR that has that shape.

## Surfaces to read every live run

| Surface | Pass |
|---|---|
| Plan card | `re-review case X`. First review (A) must **not** say re-review. |
| Cost band | Verify steps are their **own** term. Small delta + few priors must look cheaper than that PR’s first review (O-5b). |
| Summary body | `Δ since <L8>:` uses gate words only. `resolved` only if something was **checked** (verify `refuted` or git file delete). Live list names `carried` / `unconfirmed` / `deferred`. Suppressed is a **count**, not a row. |
| Headline 🔴/🟡 | Includes live (status ≠ suppressed) severities. Zero new + live carried is **not** a clean bill. |
| Threads | ✅ reply + resolve **only** on `verified-gone`. `carried` / `unconfirmed` stay open. Matcher leftovers do not collapse anything. |
| `pipeline.json` → `rereview` | Case, both range ends, `last_head_source`, four trigger counts, `verification_capped`, `live[]`. **Absent** on a first review. |
| State block | HTML comment **after** the report marker. `R###` stable. `verified-gone` retired. |

**Launch fails if any of these fire**

- The word `resolved` from “hunters did not re-find it” (PR 1759 shape).
- A second push that re-hunts the whole PR with no prior (full re-hunt dressed as a delta).
- `✅ pr-hero reviewed this PR and found nothing to report` while `live[]` is non-empty.
- A thread collapsed on `carried` or `unconfirmed`.

## Which case is this PR?

`L` = last reviewed head (summary marker `head=`, else latest finding-marker `created_at`).
`H` = current PR head. `B` = `merge-base(base, H)`.

| You see | Case | Discovery | Verify |
|---|---|---|---|
| No prior pr-hero comment | **A** | full `B..H` | none |
| Same head, maybe a new triage reply | **B** | none (unless `--full`) | only **new** `applied` / new thread reply (`created_at` > summary `updated_at`) |
| New commits, L ancestor of H | **C** | restricted `files(B..H) ∩ files(L..H)` | classification + phase-E overlap |
| Force-push / rebase / amend (L not ancestor) | **D** | full `B..H` + banner | verify-all, capped |
| L not in this clone (shallow / GC) | **E** | as D | as D |

`--full` widens discovery for the **actual** case. It does not rewrite the case.
A `dismissed`+`upheld` finding stays suppressed under `--full`.

## Live case cards

Tick when you have a PR that fits. Do not invent a force-push just to fill D.

### Minimum — second push, ordinary C (closes launch)

- [ ] Prior summary exists. New commits. Plan says `case C` · restricted.
- [ ] Untouched prior that hunters did not re-find is **`carried`**, not `resolved`.
- [ ] Touched / overlapping prior is queued; outcome is `verified-gone` or `unconfirmed` or `carried` after a real check.
- [ ] New defects appear in `findings[]` only; old ones live in the live list / state block.
- [ ] `pipeline.json` has `rereview`; first-review artifacts on this repo never did.

### B — same head, triage arrived after the last summary

- [ ] Plan: discovery skipped. Cost band is verify-only.
- [ ] Reply / `applied` with `created_at` **after** summary `updated_at` buys a verify step.
- [ ] A **predating** reply buys **no** step (S-B). Both timestamps visible in `gh api` fixtures if you dump comments.

### Empty restricted delta (still a re-review)

- [ ] Merge-of-main with no PR-file overlap, or only reverts to base, or case B.
- [ ] No `CliError`. Discovery skipped. Classification + verify + PATCH still run.
- [ ] `discovery_skipped_empty_delta` in provenance. Live list still posted.

### Merge of main (S-merge)

- [ ] Files only touched on main, not in the PR, are **absent** from the discovery plan.
- [ ] A file both sides touched is present.

### Revert to base (S-revert)

- [ ] File drops out of the restricted delta **and** still trips `touched()`.
- [ ] After verify: `refuted` → `verified-gone` + thread collapse. Inconclusive / cap → `unconfirmed`. Never `resolved` without a check.

### Rename (S-rename)

- [ ] Prior is re-anchored to the **new** path before `touched()`.
- [ ] Verify targets the post-rename path. No `refuted` against a path that no longer exists.

### Force-push / rebase (D4)

- [ ] Banner on **plan and summary**: last reviewed head is not an ancestor.
- [ ] Discovery is full `B..H`. Every prior is queued, then the cap binds.
- [ ] `--yes` / no TTY does **not** bypass the cap. Over-cap rows are `unconfirmed` and **loud** in the body.

### `--full` on a real re-review (W-cli)

- [ ] Case stays C (or B/D/E). Provenance: `discovery_restricted: false`.
- [ ] `dismissed`+`upheld` still suppressed. Only the hunt range widens.

### Collapse (O-1c / §3.9)

- [ ] `verified-gone` only: ✅ reply + resolved review thread.
- [ ] `carried` / `unconfirmed` threads stay open.
- [ ] `post --dry-run` on a PR that already has a summary does **not** print matcher “N resolved”.

### Clean bill and live list (C7 / O-2b)

- [ ] Zero new + ≥1 `carried`: no ✅ clean bill. Headline includes that severity.
- [ ] Zero new + all `unconfirmed`: still no clean bill.
- [ ] Body lists every non-suppressed live finding with status. Suppressed: count only.

### Worsening (W-worse)

- [ ] `dismissed`+`upheld` vs same-severity rediscovery: stays suppressed.
- [ ] Strictly **higher** severity at the same identity: `returned`; summary names **both** sevs.

### Triage later-run output (O-3)

- [ ] `dismissed`+`upheld`: identity absent from later output at every tier (unless W-worse).
- [ ] `deferred`: in the deferred list (issue # if present; reasoning-only still listed), **not** in the blocking count.

### Summary comment deleted (S-A)

- [ ] `L` recovered from finding-marker `created_at`. Not treated as first review.
- [ ] State block is gone with the summary: identity/sev for worsening may be missing. Visible noise (possible duplicate threads) is OK; silent first-review is not.

### Head moved mid-run (O-6)

- [ ] Inlines stay pinned to the **reviewed** commit. Both surfaces disclose. Item 7 adds no demotion to Outside Diff.

## Desk work that does not need a PR

Named §5 tests that are still thin or missing as **named** tests. Do these when sitting at the engine, not on GitHub.

| Id | Assert |
|---|---|
| **O-1b** | Replay PR 1759 pair from `~/.prhero/repos/github.com/musivetech/musive/runs/pr-1759-8da9fad5-{2,3}`: untouched + not re-found → `carried`, never `resolved`. Must fail against the old matcher. |
| **O-2** | Three-push simulated summary: current-state only, no superseded round in the body. |
| **O-5b** | Same PR, ordinary small delta: planned $ **strictly below** that PR’s first-review band. Plan only. |
| **S-base-moved** | `merge-base(base, H)` moving between runs does not change the discovery delta. |
| **D5b body** | State-block cap already evicts `unconfirmed` then `carried`; the **visible body** must say so. |
| **W-worse renderer** | Classify is covered; the summary must name both severities. |

Already covered offline (do not re-prove unless a live run contradicts): O-1a, O-1c, O-2b, O-5a, W-cli / W-order / W-cap / W-prov, D4 banner, S-A/B/merge/revert/empty, C7, J-trigger, D5a–e, V-ns, C4, S-rename classify, W-worse classify.

## Commands

```bash
# engine
bun test && bun run typecheck && bun run check

# planted bug, disposable repo
bun run fixture-eval
# bun run fixture-eval --scout

# live — operator checkout of the target repo, prior summary already on the PR
pr-hero review --pr <n> --post
# same head, want a re-hunt:  pr-hero review --pr <n> --full --post

# after the run
#   ~/.prhero/repos/<host>/<owner>/<repo>/runs/pr-<n>-<head>-<k>/pipeline.json
#   gh api repos/{owner}/{repo}/issues/<n>/comments --jq '.[] | {id, updated_at, body: .body[0:80]}'
```

Ledger the live spend in the commit or PR description (project rule 6).

## Do not

- Do not wait for a triage handshake. Git and GitHub comments are the only shared state.
- Do not treat `applied` as ground truth. It is a **trigger**; `refuted` is the only path to `resolved`.
- Do not rewrite ROADMAP splice `#42` / `#39`. Waived for this build, still open.
- Do not start a full smoke or a musive matrix. One fixture eval, then one live re-review.
- Do not mix `findings.json` with `live[]`. Lab schema stays v1.0.0.

## After it passes

- [x] Fixture eval noted (cost + outcome). **2026-08-23 — pass, $0.22, 3m07s, hit `src/volume.ts:4`.**
      Note the drift: this command is documented at ~$0.08 and billed $0.11 that morning and $0.22
      that afternoon on the same fixture. Re-measure before quoting it.
- [x] One live re-review noted: PR, heads L/H, case, what was checked. **2026-08-23 — and the
      target was not musive.** No musive PR was open, so the proof ran on **pr-hero's own PR #49**
      (`juanmaagd/pr-hero`), which is strictly better evidence: a real PR, a real second push, and
      the reviewed code is the re-review engine itself.
      - **L** `f6492170` → **H** `3f32def4`, base `886bf1d4`. **Case C**, discovery restricted.
      - Restriction shrank the delta from 4986 lines to **877 in 7 files**, which is what let the
        size gate *pass* on a PR that `--force` was needed to review the first time.
      - 4 priors verified: 1 `refuted` → `verified-gone` (thread collapsed with ✅), 3
        `inconclusive` → `unconfirmed`. **Zero inferred from absence.**
      - Summary: `Δ since f6492170: 1 resolved (verified) · 3 unconfirmed · 0 carried · 0 deferred · 1 new`.
      - First `pr-hero-state` block ever written by this engine.
      - Ledger of all four runs: PR #49's description ($14.35 total).
- [ ] ROADMAP “item 7 is live” may be ticked. Distribution “second push on a stranger’s repo” is a later machine.
      **Left unticked deliberately — that promotion is Juanma's call, not a session's.** The three
      clauses are demonstrated; the evidence is above.

### What the live pass caught that offline never could

Recorded because it is the argument for this runbook existing. The second run posted through
`post --from` and published `Δ since e23d8063: 3 resolved · 0 new · 1 persist` — three resolved
where two were checked, the PR 1759 shape named at the top of this file as a launch failure.
`postCommand` called `postInlineFindings` without `rereview`, so the delta fell back to the
absence matcher and no state block was written; a comment in that file claimed the two post paths
were equivalent, and every offline test exercised only the other one. **A green suite cannot find
that.** Fixed in `3f32def`, with the guard's own mirror direction fixed in `838c147` after the
third run caught *that* as half a gate.

## Out of scope (do not block the live pass)

Splice `#42`/`#39` seen live. Identity window still 5. Comment 65536-byte vs live-list length. Semantic judge tier (J-trigger already says a judge may only enqueue). Outside Diff has identity, not triage.
