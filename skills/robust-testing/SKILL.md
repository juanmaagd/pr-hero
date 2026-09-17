---
name: robust-testing
description: "Trigger: write tests, unit tests, integration tests, test suite, test review, fix flaky test, mutation testing. Stack-agnostic rules for tests that verify behavior, fail when the behavior breaks, and survive refactoring — no vanity coverage."
license: Apache-2.0
metadata:
  author: "juanma"
  version: "2.0"
---

## Activation Contract

Load this skill when:
- Writing new unit, integration, contract, or architecture tests.
- Reviewing, refactoring, or fixing an existing test suite (including flaky tests).
- Replacing tests that pin implementation (source text, call counts, private state) with behavioral ones.
- A reviewer flags tautological, over-mocked, brittle, or non-deterministic tests.

Do NOT load for end-to-end automation against deployed environments (browser/device drivers); those have their own rules.

## The Three Questions

Every test must answer YES to all three, or it is deleted or rewritten:

1. **Does it fail when the behavior breaks?** (falsifiable)
2. **Does it keep passing when the behavior is preserved but the internals change?** (refactor-resistant)
3. **When it fails, does the failure message say what broke?** (diagnostic)

## Hard Rules

### Seams and behavior
1. **Test through a public seam.** Exercise exported functions, public methods, ports, CLI/HTTP entry points. Never read private fields, unexported functions, or source text to assert behavior.
2. **Assert outcomes, not interactions.** Assert return values, thrown/returned errors, resulting state, or the effect observable at a boundary. Asserting that a collaborator "was called with X" is allowed ONLY when that call IS the observable effect and nothing else exposes it (e.g., a message sent to an external system).
3. **If the only way to test it is to read its source, the design is missing a seam.** Extract the decision into a small function with inputs and outputs, test that, and have the shell call it. Do not pin wiring with string matching.

### Test doubles
4. **Double at boundaries you do not control or cannot make deterministic**: network and third-party APIs, processes, the clock, randomness, the filesystem when a real temp dir is impractical, unseeded external databases.
5. **Prefer fakes of your own ports over mocks of your own classes.** In a ports-and-adapters design, the port is the boundary: a working in-memory fake of a repository, a process runner, or a VCS adapter is correct. Never mock domain logic, pure helpers, or value objects — use the real ones.
6. **Keep fakes honest.** Every fake of a boundary needs a contract test that runs the same expectations against the real implementation (or recorded real output). A fake that drifted from reality makes the whole suite lie.

### Assertions
7. **Smoking gun.** Every expected value is built or named in the arrange phase. No unexplained magic numbers, no values that only exist inside the production code.
8. **Derived text is behavior; constant text is not.** Assert output that depends on input (a rendered report, an error message naming the failing file, "no ANSI codes when styles are off"). Do not assert that a hardcoded label equals itself.
9. **Assert the whole meaningful result, precisely.** Prefer exact equality on the relevant shape over `toBeTruthy`/`length > 0`. Distinguish `null`, `undefined`, and empty collections when the domain does.
10. **Snapshots only for large derived output that a human reviews on change.** Never snapshot to avoid thinking about what matters; never blindly update a failing snapshot.

### Structure
11. **No logic in test bodies.** No `if/else`, `try/catch`, or loops deciding what to assert. Use parametrized tests (table-driven cases) to cover variants; use the framework's "expects to throw/reject" instead of `try/catch`.
12. **One behavior per test, named as a behavior.** `rejects the purchase when credit is below the total`, not `testPurchase2`. Arrange / Act / Assert, with a single act.
13. **Keep tests short and flat.** If arrange is long, extract a builder with sensible defaults and override only what the test is about — the override IS the documentation.

### Determinism and isolation
14. **Every test runs alone, in any order, in parallel, and gives the same result.** No shared mutable state between tests; each creates and cleans up its own temp dirs, env vars, and globals.
15. **Control time and randomness.** Inject the clock and seed randomness. Never `sleep` to wait for async work: await the actual event, or poll a condition with a timeout.
16. **A flaky test is a failing test.** Find the nondeterminism (time, ordering, shared state, real network, races) and remove it. Retries are not a fix.

### Proving the test works
17. **Watch it fail for the right reason.** A new test must be seen red against broken or absent behavior, and the failure must be the assertion — not a compile error, a missing import, or a changed signature.
18. **Mutation-check critical branches for real, not mentally.** Invert the condition, return the empty value, drop the argument, remove the guard: the test must go red. Restore afterwards. If it stays green, the test is invalid.
19. **Coverage is a map of what is untested, never a goal.** A covered line with no assertion depending on it is uncovered.

## Decision Gates

| Situation | Decision |
|---|---|
| Pure function / domain logic | Real inputs, real collaborators, exact assertions. Parametrize edge cases. |
| Code orchestrating I/O with no testable seam | Extract the decision into a pure function (seam) and test it; keep the shell thin. |
| Your own port (repository, runner, VCS, clock) | In-memory fake of the port + a contract test for the real adapter. |
| Third-party API / network | Double at the client boundary using recorded or documented contract fixtures. |
| Database or filesystem | Prefer the real thing in isolation (in-memory DB, temp dir) over a mock. |
| Architectural invariant (layer boundaries, import cycles, forbidden dependencies) | Structural test is legitimate: scan the whole module tree for the rule, never hardcode file paths or multi-line code literals. |
| Rendered output / CLI text | Assert content derived from input and structural properties; avoid asserting static copy. |
| Bug fix | First a test that reproduces the bug (red for the right reason), then the fix. |
| Existing test pins implementation | Replace with a behavioral test on a seam; delete the pin once the new test is mutation-checked. |

## Edge Cases To Hunt (checklist, not ceremony)

Apply the ones relevant to the unit: empty / single / many; `null` vs empty vs missing; boundaries (0, 1, max, off-by-one); invalid input and the exact error; partial failure and timeouts of dependencies; duplicates and ordering; idempotency (running twice); concurrency where state is shared; encoding / unicode / whitespace when parsing text.

## Execution Steps

1. **Identify the seam** and its observable outputs. If none exists, create one (rule 3).
2. **List behaviors** as test names, including relevant edge cases from the checklist.
3. **Arrange** minimal data via builders; name the expected values.
4. **Act** once through the seam.
5. **Assert** the observable outcome exactly.
6. **Prove it**: run it red for the right reason (rule 17) and mutation-check the critical branch (rule 18).

## Output Contract

Deliver:
- Tests that satisfy the Three Questions and the Hard Rules.
- A short list of the behaviors and edge cases covered.
- The mutations run and confirmation each one turned the suite red.
- Any deliberate exception (a structural test, an interaction assertion) with its one-line justification.

## References

- `references/rules-and-examples.md` — good vs. bad patterns, in stack-neutral pseudocode.
