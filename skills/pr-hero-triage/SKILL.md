---
name: pr-hero-triage
description: "Triage pr-hero findings posted as PR comments — for each one, reply in its own thread with applied, dismissed, deferred, or misclassified plus reasoning. Trigger: pr-hero finding comments on a PR you authored, responding to automated code review, `<!-- pr-hero-finding` markers in a PR."
license: MIT
metadata:
  author: gentleman-programming
  version: "1.0"
---

## When to Use

Load this skill after pr-hero has posted findings on a PR you (the coding agent) authored, and
you need to answer each one so the review loop closes without a human in it by default.

Use it when you see comments whose FIRST line matches:

```
<!-- pr-hero-finding path=<url-encoded-path> line=<n> head=<40-hex-sha> c=<12-hex> -->
```

Do not use it for ordinary human review comments, or for pr-hero's own summary comment
(`<!-- pr-hero-report head=<sha> -->`) — that one is a status roll-up, not a per-finding thread.

## The strategic why

The bottleneck of coding with AI is the review. If an agent writes the code and only a human can
answer a review, the human is the queue. This skill exists so the default actor answering a
finding is an agent — **the human is the objector, never the gate**: free to weigh in with a
reaction or a reply whenever they have context or an opinion, never required for the loop to
close.

## The loop, end to end

For EVERY `<!-- pr-hero-finding ` comment on this PR that has not already been triaged for the
current head:

1. **Read the finding.** Fetch the comment body (the marker plus pr-hero's claim/severity/tier
   text) and its GitHub comment id and type (inline review comment vs. top-level issue comment).
2. **Read the marker's `head=`.** This IS the budget unit — see "One adjudication per finding per
   HEAD" below. If a triage reply already exists in this thread carrying the SAME head, skip it:
   it is already answered for this code.
3. **Decide exactly one tag**: `applied`, `dismissed`, `deferred`, or `misclassified` (table
   below).
4. **For `dismissed`, `deferred`, and `misclassified`**: spawn the isolated adjudicator (see
   "The adjudicator spawn" below) and include its verdict in your reply. `applied` never spawns
   one.
5. **Reply in that finding's own thread**, opening with the triage marker (see "The reply format"
   below).

## The four tags

| tag | what it claims | what it must supply |
|---|---|---|
| `applied` | Fixed in this PR. | Nothing else — the re-review verifies it independently, so it pays no adjudicator. |
| `dismissed` | The finding is wrong. | POSITIVE DISPROOF WITH CITED CODE. "I did it on purpose" is not evidence; "this line already covers it, here" is. |
| `deferred` | The finding is right, but fixing it is out of this PR's scope. | A REAL destination: create a GitHub issue and put its number in the reply and the marker. Without an issue, `deferred` is a `dismissed` with a better name, and the ledger counts it as agreement. |
| `misclassified` | The finding is real, but pr-hero typed it wrong (severity, tier, or `causal_disposition`). | Name which field is wrong and why. This is the highest-value signal the loop produces — it points at a hunter/refuter defect, not a repository one. |

Pick exactly one. If you are tempted to pick two, the finding is `misclassified` (the label is
wrong) rather than `dismissed` (the claim is wrong) — do not split the difference.

### `applied`

Fix the code, then reply. Do not restate the diff; a one-line pointer (commit sha or file) is
enough. No adjudicator.

### `dismissed`

You are claiming pr-hero is wrong. Cite the exact line(s) that already handle the case, or the
exact reason the claimed defect cannot occur. Then spawn the adjudicator — its burden of proof
rule is the same one you must meet, and it is the disinterested check on your own claim.

### `deferred`

Before replying, create the tracking issue (`gh issue create` or the platform equivalent) with
enough of the finding's substance that it stands alone. Put the issue number in the triage
marker's `issue=` field AND in the reply prose. A `deferred` finding is suppressed only inside the
PR that deferred it — it will surface again in a different PR's review, and citing the issue
there is a one-line answer, not a re-litigation.

### `misclassified`

Name the exact field (`severity`, `tier`, or `causal_disposition`) and what it should be instead,
with the evidence. The finding itself is not wrong — only its classification is.

## The adjudicator spawn — isolation is load-bearing

For `dismissed`, `deferred`, and `misclassified`, spawn a FRESH, ISOLATED sub-agent using the
system prompt in `adjudicator.md` (same directory as this file).

**The isolation requirement, stated plainly: the adjudicator receives ONLY**

- the finding (claim, path, line, severity/tier as pr-hero posted it),
- your argument (the case you are about to reply with), and
- read-only access to the repository at this PR's head.

**It must NEVER receive your own reasoning context** — not your conversation history, not your
scratch notes, not "why I believe this". Its entire value is having nothing to defend. An
adjudicator that inherited your context would simply agree with itself.

The adjudicator returns exactly one of `upheld`, `rejected`, or `inconclusive` — see
`adjudicator.md` for what each means and the burden-of-proof rule behind them. Include the exact
verdict word in your reply prose AND in the triage marker's `verdict=` field (see "The reply
format" below) — the marker is what makes the verdict machine-readable for the ledger and for the
escalation rule.

## One adjudication per finding per HEAD

This needs no new state. The finding's own marker already carries `head=<sha>`, so the bound is
read directly off the posted comments — do not invent a separate tracking file or counter.

- Same head, already triaged → skip. Nothing changed, nothing to re-judge.
- Head changed AND the new commits touched this finding's lines → re-triage is legitimate; this is
  the one case that pays for another adjudicator run.
- Head changed but did NOT touch those lines → the prior verdict stands; do not re-triage.

## The escalation stop

After **2 consecutive heads** land at `inconclusive` for the same finding, STOP triaging it and
say so in the reply: it escalates to a human. Do not spawn a third adjudicator round hoping for a
different answer — if two different heads with real code changes between them did not settle it,
a third will not, and by then the thread carries enough material for a person to rule in a minute.

**The count is read off the finding's PRIOR triage markers, not remembered or estimated.** Fetch
this finding's own reply thread, parse every `<!-- pr-hero-triage ` marker already posted in it in
order, and read their `verdict=` fields — the same field this round's reply will also carry. If
the most recent one is `verdict=inconclusive` AND the one before it is also `verdict=inconclusive`
(two markers, both `inconclusive`, both belonging to a head change that legitimately re-triaged —
see "One adjudication per finding per HEAD" above), this round is the escalation, not a third
adjudicator spawn. This is what makes the rule checkable: the markers ARE the state, there is
nothing else to consult.

## The reply format

The reply MUST open with this marker as its first line, exactly:

```
<!-- pr-hero-triage tag=<tag> head=<40-hex> actor=agent verdict=<verdict> -->
```

`verdict=` is the adjudicator's exact word (`upheld`, `rejected`, or `inconclusive`) and is
REQUIRED for `dismissed`, `deferred`, and `misclassified` — the three tags that spawn one — and
MUST NOT appear on `applied`, which spawns no adjudicator and therefore has no verdict to record.
`deferred` additionally carries `issue=<n>` on the same line. `head=` is this PR's CURRENT head
sha — the same one the finding's own marker was evaluated against for this triage round.

### Example reply — `applied`

No adjudicator; the fix speaks for itself. No `verdict=` field.

```
<!-- pr-hero-triage tag=applied head=e3ab386a63020c6f5c21d814d176ff33849eef8d actor=agent -->

Fixed in this PR — see 3f9a2c1: `parseConfig` now validates `retries` before use.
```

### Example reply — `dismissed`

```
<!-- pr-hero-triage tag=dismissed head=e3ab386a63020c6f5c21d814d176ff33849eef8d actor=agent verdict=upheld -->

Adjudicator verdict: upheld

The finding claims `parseConfig` can throw when `raw.retries` is undefined. It cannot:
`config.ts:42` already guards it — `const retries = raw.retries ?? 3;` — and that line predates
this PR. The isolated adjudicator confirmed the citation independently and returned `upheld`.
```

### Example reply — `deferred`

```
<!-- pr-hero-triage tag=deferred head=e3ab386a63020c6f5c21d814d176ff33849eef8d actor=agent issue=482 verdict=upheld -->

Adjudicator verdict: upheld

The finding is correct — `retryQueue.ts` has no backoff cap — but fixing it means redesigning the
retry policy, which is out of scope for this PR. Filed as #482 to track it. The adjudicator
confirmed the finding is real and that scope, not correctness, is the actual issue.
```

### Example reply — `misclassified`

```
<!-- pr-hero-triage tag=misclassified head=e3ab386a63020c6f5c21d814d176ff33849eef8d actor=agent verdict=upheld -->

Adjudicator verdict: upheld

The defect is real, but `causal_disposition` is wrong: this is filed `introduced` and it is
pre-existing — `ghPrList` (watch.ts:243) has carried this exact unbounded `gh` hang since before
this PR. The engine typed it wrong, not the code.
```

## Posting the reply — GitHub's native threading

Bind the reply to its finding using GitHub's own reply mechanism, never an id in the body or a
heuristic parse:

- **Inline review comment** (anchorable finding): create a new PR review comment with
  `in_reply_to` set to the original comment's id, e.g.
  `gh api repos/<owner>/<repo>/pulls/<pr>/comments -f body='<reply>' -F in_reply_to=<comment_id>`.
- **Top-level issue comment** (un-anchorable finding): GitHub issue comments have no native
  threading. Post a new issue comment on the PR that opens with the same triage marker and links
  the original comment's permalink, so the marker plus the link together make the binding
  unambiguous.

## Rules

- One tag per finding, no exceptions.
- `dismissed`, `deferred`, `misclassified` all require a spawned, isolated adjudicator; `applied`
  never does.
- The adjudicator never sees your reasoning context — only the finding, your argument, and the
  repo.
- `deferred` without a real issue number is malformed — do not post it.
- `dismissed`, `deferred`, and `misclassified` without a `verdict=` field are malformed — do not
  post them. `applied` WITH a `verdict=` field is equally malformed — it claims a ruling that
  never happened.
- Never re-triage a finding whose head is unchanged since its last triage on this PR.
- After 2 consecutive `inconclusive` heads — read off the finding's own prior triage markers, not
  memory — stop and hand the finding to a human.
