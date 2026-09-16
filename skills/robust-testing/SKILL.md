---
name: robust-testing
description: "Trigger: write tests, unit tests, integration tests, test suite, test review. Enforces robust, black-box behavioral testing rules without vanity coverage."
license: Apache-2.0
metadata:
  author: "juanma"
  version: "1.0"
---

## Activation Contract

Load this skill when:
- Creating or generating new unit, integration, or API tests.
- Refactoring, fixing, or reviewing existing test suites.
- User requests tests that actually verify functionality rather than vanity line coverage.
- Triage flags tautological, over-mocked, or brittle tests.

Do NOT load when running end-to-end browser automation workflows (Playwright, Cypress) across external deployed environments.

## Hard Rules

1. **Test behavior, not implementation details**: Interact only through the public API (seams). Never inspect private methods, internal state, or unexported variables. Tests MUST survive internal refactoring without changes.
2. **Never test mock behavior (Anti-Tautology)**: Mocks isolate; they are never the subject of assertions. Do not assert that a mock was called with specific internal parameters when the public outcome or return value is observable.
3. **Mock system boundaries only**: Mock external network calls, third-party services, unseeded databases, time/clocks, and system randomness. NEVER mock internal collaborators, domain services, utilities, or code you own.
4. **Prohibit trivial text and constant assertions**: Do NOT test that a static label, header text, or constant string equals its hardcoded value. Assert state transitions, business outcomes, error states, and side effects.
5. **No logic inside tests**: Tests MUST contain only flat statements. Never use `if/else`, loops, `try/catch`, or conditional assertions inside test bodies. Keep tests under 15 statements.
6. **Smoking gun principle**: Every piece of data asserted in `expect()` MUST originate explicitly from the `arrange` phase. Never assert against unexplained magic numbers or uninitialized global state.
7. **Falsifiability / Mutation check**: Every test MUST fail if the core business branch it tests is removed or inverted. If mutating the logic keeps the test green, the test is invalid.

## Decision Gates

| Situation | Decision |
|---|---|
| Testing a domain service or class | Use real instances of dependencies in memory; do NOT mock internal helpers |
| External API call (Stripe, GitHub, S3) | Mock at the client/adapter boundary using contract fixtures |
| Shared mutable state across tests | Disallow. Each test MUST be self-contained and independently executable |
| Multiple test scenarios for a function | Group by business behaviors (`should reject purchase when credit is low`), not function names (`testMethod()`) |

## Execution Steps

1. **Identify the seam**: Determine the public entry point and observable outputs (returned value, thrown domain error, or external boundary call).
2. **Arrange**: Set up minimal input data and declare expected output values explicitly.
3. **Act**: Invoke the public method under test once with flat statements.
4. **Assert**: Verify the observable outcome or boundary effect. Discard any assertion verifying internal call counts.
5. **Sanity Check (Falsifiability)**: Verify mentally or via mutation that inverting the production logic will cause this test to fail.

## Output Contract

Deliver:
- Test files adhering strictly to flat structure and black-box assertions.
- Summary of verified behaviors and tested edge cases.
- Explicit note confirming zero internal mocks and zero static constant assertions.

## References

- `references/rules-and-examples.md` — Concrete Good vs. Bad test patterns and anti-pattern catalog.
