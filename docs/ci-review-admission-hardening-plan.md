# CI Review Admission Hardening Plan

This plan hardens CI re-review admission so pr-hero can reduce provider spend without hiding regressions, trusting user-controlled state, or retrying indefinitely after cancelled or failed runs. It is an implementation handoff: each work unit should be implemented as a separate reviewable slice targeting `dev`.

## Quick path

1. Freeze the policy and state contract.
2. Make review authority durable and authenticated.
3. Count attempts before provider spend.
4. Classify the current-head delta, not only the previous score.
5. Remove duplicate finding counts and complete GitHub pagination.
6. Add shell, integration, and state-machine tests.
7. Roll out in observe-only mode before enforcing automatic skips.

## Current control boundaries

| Layer | Responsibility |
|---|---|
| GitHub workflow | Decides which events invoke the action, concurrency, permissions, and credentials. |
| `action.yml` | Passes action inputs to the CLI. It currently does not expose re-review policy inputs. |
| `src/ci-review-admission.ts` | Makes the pure run/skip decision. |
| `.prhero/config.json` | Supplies repository-level policy values currently supported by the CLI. |
| Durable admission ledger | Must become the authoritative record of reservations, attempts, and outcomes. |

The workflow must not encode business policy through event filters alone. The engine must retain a deterministic admission decision so the decision can be observed, tested, and explained.

## Non-goals

- Redesign the hunter/refuter pipeline.
- Change finding severity or tier semantics.
- Change provider routing.
- Change the public finding format.
- Treat a skipped review as a successful review.
- Add a silent fallback that bypasses admission safety.

## Required invariants

- A provider-started attempt is counted before the provider process starts.
- Cancelled, failed, and unknown attempts cannot create an infinite retry loop.
- A PR comment is never trusted solely because its body contains a marker.
- Review state is bound to the PR, exact head SHA, policy version/hash, and trusted producer identity.
- A later risky commit can trigger review after a low-score review.
- Outside-Diff findings are counted exactly once.
- Unknown or malformed state never becomes score `0`.
- Exhausted automatic budget produces `manual-required`, not a green-looking skip.
- GraphQL pagination is complete and bounded.
- Every decision is covered by pure tests and at least one end-to-end shell test.

## Policy modes

The policy must be explicit instead of forcing every team to express intent through a numeric threshold.

| Mode | Behavior |
|---|---|
| `once_per_pr` | One automatic review for the PR. Later pushes are reported as not reviewed. |
| `thresholded` | Re-review when the previous score reaches the configured threshold. |
| `risk_aware` | Re-review when the new delta touches risky files, or when the previous score reaches the threshold. |
| `every_push` | Review every push, explicitly opt-in and still protected by attempt/cost limits. |
| `manual_only` | No automatic re-review; only an explicit override can launch one. |

Recommended default: `risk_aware`.

Example configuration:

```json
{
  "ci_review_policy": "risk_aware",
  "ci_max_attempts": 2,
  "ci_rereview_min_score": 4,
  "ci_blocking_weight": 2,
  "ci_advisory_weight": 1
}
```

The policy must be loaded from trusted base/workflow configuration. A PR author must not be able to modify the policy and thereby suppress review of the same PR.

## Admission decision table

| Situation | Decision |
|---|---|
| No authoritative review or attempt exists | Run. |
| Same head already completed | Skip as duplicate. |
| Same head already running | Skip as already in flight. |
| Previous score below threshold and delta is documentation/tests only | Skip. |
| Previous score below threshold and delta contains production/config/workflow changes | Run. |
| Previous score reaches threshold | Run if automatic budget remains. |
| Provider failed after launch | Count the attempt. |
| Provider was cancelled after launch | Count the attempt. |
| Attempt state is unknown | Manual required. |
| Automatic attempt budget is exhausted | Manual required. |
| Risk classification is unknown | Run if budget remains; otherwise manual required. |
| Marker author is not trusted | Ignore the marker as authority. |

## Work units

### WU-00 — Freeze the policy contract

**Primary scope:** policy types, defaults, documentation, pure tests.

Tasks:

- [x] 00.1 Define `ci_review_policy` values and defaults.
- [x] 00.2 Define whether limits apply per PR, per head, or both.
- [x] 00.3 Define `ci_max_attempts`, reservation TTL, and policy version/hash.
- [x] 00.4 Define every admission reason and user-facing message.
- [x] 00.5 Define `manual-required` as distinct from `skip`.
- [x] 00.6 Decide whether `every_push` is allowed to bypass only score admission or also the automatic attempt budget. It must not bypass the budget.

Acceptance criteria:

- No undocumented magic numbers remain.
- Every decision has a typed reason.
- Policy changes produce a different policy hash.

### WU-01 — Canonical score calculation

**Files:** `src/ci-review-admission.ts`, `src/cli.ts`, `test/ci-review-admission.test.ts`.

Tasks:

- [x] 01.1 Use `doc.findings` as the canonical current-run source.
- [x] 01.2 Remove the `doc.findings + outside` double count at `src/cli.ts:3084`.
- [x] 01.3 Deduplicate historical posted findings by `headSha + path + line + claimFingerprint`.
- [x] 01.4 Ensure the same finding posted inline and as an issue comment counts once.
- [x] 01.5 Never use severity headline counts for admission.
- [x] 01.6 Represent unreadable historical data as unknown, not score zero.

Tests:

- [x] Two Outside-Diff findings produce two findings, not four.
- [x] Duplicate markers do not inflate score.
- [x] Tier and severity remain independent.
- [x] Malformed marker data cannot become a valid zero score.

### WU-02 — Durable attempt ledger

**Recommended authority:** GitHub Check Runs. Human-readable PR comments remain presentation only.

**Files:** new `src/ci-admission-ledger.ts`, `src/pr.ts`, `src/cli.ts`, `action.yml`, `.github/workflows/pr-hero.yml`.

Suggested record:

```ts
interface AdmissionRecord {
  schemaVersion: 1;
  prNumber: number;
  headSha: string;
  policyHash: string;
  reservationId: string;
  attemptNumber: number;
  status:
    | "reserved"
    | "provider-started"
    | "completed"
    | "skipped"
    | "failed"
    | "cancelled"
    | "unknown";
  decisionReason: string;
  priorScore: number | null;
  blockingCount: number | null;
  advisoryCount: number | null;
  workflowRunId: string | null;
  createdAt: string;
  settledAt: string | null;
}
```

Tasks:

- [x] 02.1 Implement `reserveAdmissionAttempt()`.
- [x] 02.2 Reserve immediately before provider launch.
- [x] 02.3 Increment the attempt number during reservation.
- [x] 02.4 Implement `settleAdmissionAttempt()` for every terminal path.
- [x] 02.5 Persist failed, cancelled, and unknown outcomes.
- [x] 02.6 Add reservation expiration and stale-reservation handling.
- [x] 02.7 Make reservation idempotent with `PR + head SHA + policy hash`.
- [x] 02.8 Store workflow run ID and provider-start timestamp.
- [x] 02.9 Add required GitHub permissions and verify them in CI setup tests.

Acceptance criteria:

- Provider-started work always consumes an attempt.
- Runner cancellation cannot reset a PR to first-review state.
- Duplicate workflow execution does not create duplicate reservations.

### WU-03 — Authenticated review authority

**Files:** `src/pr-preflight.ts`, `src/watch-preflight.ts`, `src/pr.ts`, `src/ci-review-admission.ts`.

Tasks:

- [ ] 03.1 Validate Check Run application/producer identity.
- [x] 03.2 Bind authority to exact PR number, head SHA, policy hash, and schema version.
- [x] 03.3 If historical comments are supported, require the trusted bot author.
- [x] 03.4 Ignore contributor-authored lookalike markers.
- [x] 03.5 Reject mismatched summary/state/admission heads.
- [x] 03.6 Define safe migration for legacy headless comments.
- [x] 03.7 Treat ambiguous or malformed historical authority as unknown.

Acceptance criteria:

- A contributor cannot suppress the first review with a forged marker.
- A stale marker cannot authorize a skip.
- A malformed marker cannot become a valid zero-score review.

### WU-04 — Current-head delta risk classification

**Files:** new `src/ci-review-risk.ts`, `src/pr.ts`, `src/cli.ts`, `test/ci-review-risk.test.ts`.

Tasks:

- [x] 04.1 Compute the delta from the last authoritative reviewed head to the current head.
- [x] 04.2 Retrieve changed paths through a cheap GitHub API call before provider spend.
- [x] 04.3 Classify high-risk and low-risk paths.
- [x] 04.4 Version the risk policy.
- [x] 04.5 Include `riskClass` and `riskReason` in the admission record.
- [x] 04.6 Treat failed or empty path metadata as unknown, never safe.

Suggested high-risk paths:

- `src/**`
- `scripts/**`
- `.github/**`
- `action.yml`
- dependency manifests and lockfiles
- authentication/security files
- deleted or renamed files
- unknown file types

Suggested low-risk paths, only when explicitly allowlisted:

- documentation;
- tests;
- comments-only changes;
- mechanically proven formatting-only changes.

Acceptance criteria:

- A new security-sensitive production change triggers review after a low-score review.
- Documentation-only changes can be skipped.
- Unknown file data never qualifies as safe.

### WU-05 — CLI lifecycle wiring

**Files:** `src/cli.ts`, `src/ci-review-admission.ts`.

Required order:

```text
resolve PR/head
read authoritative records
read cheap changed-file metadata
evaluate policy
publish skip/manual-required notice if applicable
reserve attempt
start provider
settle attempt on every outcome
publish review result
publish human-readable summary
```

Tasks:

- [x] 05.1 Keep admission before worktree creation and provider launch.
- [x] 05.2 Ensure no provider starts without a successful reservation.
- [x] 05.3 Settle records from success, error, timeout, signal, and cancellation paths.
- [x] 05.4 Keep `--force` as an explicit manual override.
- [x] 05.5 Ensure skip output says “not reviewed”, never “clean”.
- [x] 05.6 Ensure `manual-required` points to the exact override procedure.

Acceptance criteria:

- Every provider invocation has a durable terminal state.
- Every non-run decision is explainable from persisted evidence.

### WU-06 — Complete GitHub pagination

**Files:** `src/pr.ts`, parser tests.

Tasks:

- [x] 06.1 Add cursors to the GraphQL issue-comment query.
- [x] 06.2 Add cursors to the GraphQL review-thread query.
- [x] 06.3 Iterate until `hasNextPage` is false.
- [x] 06.4 Fail loudly when `hasNextPage` is true without `endCursor`.
- [x] 06.5 Add a hard maximum page bound.
- [x] 06.6 Represent truncation as unknown, not an empty comment set.

Acceptance criteria:

- A marker on page two or later is found.
- A busy PR cannot silently lose admission state.

### WU-07 — Integration and state-machine tests

**Files:** `test/ci-review-admission.test.ts`, `test/cli.test.ts`, new integration tests as needed.

Required scenarios:

- [x] First review runs.
- [x] Same head skips.
- [x] Documentation-only delta skips under `risk_aware`.
- [x] Production delta runs after a low-score review.
- [x] Threshold score triggers re-review.
- [x] Outside-Diff findings count once.
- [x] Untrusted marker is ignored.
- [x] Mismatched head becomes unknown/manual.
- [x] Failed provider consumes an attempt.
- [x] Cancelled provider consumes an attempt.
- [x] Unknown attempt does not restart forever.
- [x] Exhausted budget produces `manual-required`.
- [x] Concurrent reservation is idempotent.
- [x] GraphQL pagination finds older markers.
- [x] `--force` works only as an explicit override.

State-machine sequence:

```text
push A → cancel → push B → fail → push C → cancel → push D
```

Assert that automatic launches never exceed the configured budget, no launch occurs without a reservation, and no risky delta is skipped solely because the prior score was low.

### WU-08 — Observability and documentation

**Files:** `src/ci-reporter.ts`, `src/ci-gates.ts`, `src/cli.ts`, `docs/github-actions.md`, README/config documentation.

Tasks:

- [x] 08.1 Add decision, reason, current head, reviewed head, risk, score, attempt, and remaining budget to the step summary.
- [x] 08.2 Add distinct `manual-required` output.
- [x] 08.3 Document all policy configuration keys and modes.
- [x] 08.4 Document trusted configuration ownership.
- [x] 08.5 Document the manual override procedure.
- [ ] 08.6 Add metrics for avoided runs, risky deltas, manual-required outcomes, failed/cancelled attempts, unknown authority, and malformed state.

## Recommended implementation order

1. WU-00 — Policy contract.
2. WU-01 — Canonical counting.
3. WU-03 — Authority validation.
4. WU-06 — Pagination.
5. WU-04 — Risk classification.
6. WU-02 — Durable ledger.
7. WU-05 — Lifecycle wiring.
8. WU-07 — Integration/state-machine tests.
9. WU-08 — Documentation and rollout.

Use RED → GREEN → REFACTOR for each work unit. Keep slices small enough to remain reviewable and target `dev` through feature branches and pull requests.

## Rollout

### Phase 1 — Observe only

- Calculate the new decision without suppressing reviews.
- Publish what the new policy would have decided.
- Compare decisions with current behavior.

### Phase 2 — Enforce safe skips

Enable only:

- same-head deduplication;
- authenticated authority;
- documentation-only skips;
- canonical score calculation.

### Phase 3 — Enforce durable attempts

Enable:

- pre-spend reservations;
- failed/cancelled attempt accounting;
- explicit manual-required outcomes.

### Phase 4 — Enforce risk-aware admission

Enable:

- current-head delta classification;
- risky-delta re-reviews after low-score findings;
- policy and admission metrics.

## Final approval gate

- [x] Forged PR comments cannot suppress reviews.
- [x] Risky production commits are not skipped solely because the prior score was low.
- [x] Failed and cancelled provider runs consume attempts.
- [x] Repeated pushes cannot launch unlimited reviews.
- [x] Outside-Diff findings are not double-counted.
- [x] GraphQL pagination is complete.
- [x] Unknown state is visible and actionable.
- [x] Integration tests cover the full CLI path.
- [x] Full test suite passes.
- [x] Typecheck passes.
- [x] Biome passes without new warnings.
- [x] Documentation explains policies and overrides.
- [ ] A second adversarial audit approves the corrected branch.

Green CI is necessary but insufficient. Approval requires evidence for every safety invariant above.
