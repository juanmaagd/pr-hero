# Robust Testing: Patterns and Anti-Patterns

Examples use stack-neutral pseudocode (`test`, `expect`). Translate to your framework's equivalents.

## 1. Interactions vs. outcomes

```
// BAD: asserts HOW, breaks on any refactor, passes even if the order is never confirmed.
test "checkout calls payment.process"
  payment = mock(PaymentGateway)
  checkout(cart, payment)
  expect(payment.process).calledWith(cart.total)

// GOOD: asserts WHAT the caller can observe; the gateway is a fake of our own port.
test "confirms the order when the payment is accepted"
  payment = FakePaymentGateway(accepts: true)
  order = checkout(cartWithTotal(50), payment)
  expect(order.status).equals("confirmed")
  expect(payment.charges).equals([50])   // the charge IS the boundary effect
```

## 2. Pinning source text vs. extracting a seam

```
// BAD: reads the production file as a string. Breaks on formatting, proves nothing runs.
test "dry run degrades when the file list fetch fails"
  source = readFile("src/review.ts")
  expect(source).contains("} catch {\n  perFile = null;\n}")

// GOOD: the decision is extracted into a function and tested by behavior.
test "a failed file list fetch yields no per-file data, not an empty list"
  failingFetch = () => reject(Timeout)
  perFile = await perFileOrUnknown(failingFetch)
  expect(perFile).equals(null)

test "the size gate falls back to the aggregate estimate when per-file data is unknown"
  verdict = sizeGate(perFile: null, aggregateLines: 5000, limit: 1000)
  expect(verdict).equals({ pass: false, basis: "aggregate" })
```

Mutation check: change `null` to `[]` in `perFileOrUnknown` — the first test goes red; the second proves why it matters.

## 3. Constant text vs. derived text

```
// BAD: the label equals itself.
test "renders the title"
  expect(render(Header())).contains("Dashboard")

// GOOD: output depends on input.
test "the error names the file that failed to parse"
  error = expectThrows(() => parseConfig(path: "team.yaml", text: "::"))
  expect(error.message).contains("team.yaml")

test "no escape codes are emitted when styling is disabled"
  lines = renderReport(findings: [aFinding()], styles: off)
  expect(lines.join("")).notContains("\x1b")
```

## 4. Logic in tests vs. parametrized cases

```
// BAD: the branch hides a case that never runs.
test "processes orders"
  orders = getOrders()
  if orders.length > 0
    expect(orders[0].processed).equals(true)

// GOOD: flat, one behavior, variants as data.
test.each [
  ["pending",   "processed"],
  ["cancelled", "cancelled"],
] "order in <from> ends as <to>" (from, to)
  expect(process(order(status: from)).status).equals(to)
```

## 5. Magic values vs. smoking gun

```
// BAD: where does 42 come from?
test "computes total"
  expect(total(defaultCart())).equals(42)

// GOOD: every expected value is visible in arrange.
test "total sums line prices times quantity"
  cart = cart(lines: [line(price: 10, qty: 2), line(price: 5, qty: 1)])
  expect(total(cart)).equals(10 * 2 + 5 * 1)
```

## 6. Builders with defaults

```
// Arrange only what the test is about; the override documents the case.
test "rejects a refund older than the window"
  purchase = aPurchase(daysAgo: REFUND_WINDOW_DAYS + 1)
  expect(refund(purchase, clock: fixedClock())).equals(Rejected("window expired"))
```

## 7. Time and async

```
// BAD: slow and still flaky.
startJob(); sleep(2000); expect(job.done).equals(true)

// GOOD: control the clock, or await the actual signal.
clock = FakeClock(at: t0)
scheduler = Scheduler(clock)
scheduler.schedule(task, after: minutes(5))
clock.advance(minutes(5))
expect(task.ran).equals(true)
```

## 8. Keeping fakes honest (contract tests)

```
// One set of expectations, run against every implementation of the port.
contract "VersionControl"(makeImpl)
  test "reads a file at a given commit"
    vcs = makeImpl(withCommit("abc", files: { "a.txt": "hi" }))
    expect(vcs.readFile("abc", "a.txt")).equals("hi")
  test "reports a missing file as absent, not as empty"
    vcs = makeImpl(withCommit("abc", files: {}))
    expect(vcs.readFile("abc", "a.txt")).equals(null)

runContract("VersionControl", FakeVersionControl)
runContract("VersionControl", RealVersionControlInTempRepo)
```

## 9. Legitimate structural tests

```
// GOOD: an architectural rule, stated over the whole tree, no hardcoded paths or code literals.
test "the domain layer imports nothing from the infrastructure layer"
  violations = importsFrom(all files under "src/domain", matching "src/infrastructure")
  expect(violations).equals([])
```

A structural test guards an architectural rule. It is never a substitute for testing behavior that a seam could expose.

## 10. Proving a test is real

```
1. Write the test.
2. Run it against missing or broken behavior -> red, and the failure is the ASSERTION
   (not a compile error, missing import, or changed signature).
3. Implement / restore -> green.
4. Mutate the critical branch (invert condition, return empty, drop guard) -> red.
5. Restore.
```

A test that stays green under step 4 is deleted or rewritten.

## Anti-pattern catalog (quick scan)

| Smell | Why it is wrong | Fix |
|---|---|---|
| `expect(mock).calledWith(...)` with an observable result available | Tests implementation | Assert the result |
| Mocking your own pure helper | Tests the mock | Use the real helper |
| Reading source files as text | Pins formatting, not behavior | Extract a seam |
| `toBeTruthy()` / `length > 0` | Passes on wrong values | Exact equality |
| `sleep(n)` | Slow and flaky | Fake clock / await signal |
| Shared fixture mutated across tests | Order-dependent | Build per test |
| `try/catch` around the act | Swallows a missing throw | "expects to throw" |
| Snapshot updated without reading | Rubber stamp | Assert the meaningful part |
| Retry on flake | Hides nondeterminism | Remove the cause |
| Test named after the method | Says nothing on failure | Name the behavior |
