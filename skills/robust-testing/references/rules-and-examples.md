# Robust Testing: Patterns, Anti-Patterns, and Examples

## 1. Good vs. Bad Test Examples

### Anti-Pattern: Testing Implementation Details & Mock Calls
```typescript
// BAD: Coupled to internal structure. Breaking refactors break this test even if behavior is correct.
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, mockPayment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

### Pattern: Testing Observable Behavior
```typescript
// GOOD: Tests user-visible capability through the public seam.
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(sampleProduct);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
```

---

## 2. Anti-Pattern: Trivial String & Constant Assertions

### Bad: Asserting Hardcoded Copy
```typescript
// BAD: Fails if copywriter updates text; proves no business logic.
test("renders welcome header", () => {
  render(<WelcomeBanner />);
  expect(screen.getByText("Welcome to Dashboard")).toBeInTheDocument();
});
```

### Good: Asserting State Transitions & Dynamic Responses
```typescript
// GOOD: Proves system reacts to dynamic conditions.
test("displays error and keeps submit button disabled on invalid email", async () => {
  render(<LoginForm />);
  await userEvent.type(screen.getByLabelText(/email/i), "invalid-email");
  await userEvent.click(screen.getByRole("button", { name: /continue/i }));
  
  expect(screen.getByRole("alert")).toHaveTextContent(/invalid email format/i);
  expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
});
```

---

## 3. Mocking Boundaries

### What to Mock (External Boundaries Only):
- Third-party HTTP/RPC APIs (Stripe, Twilio, external OAuth).
- Non-deterministic sources: `Date.now()`, `Math.random()`, crypto salts.
- External system processes, message brokers across networks.

### What NEVER to Mock:
- Internal utility modules, helper functions, domain classes.
- Collaborators that reside inside the same repository/service.
- In-memory data structures (use real arrays, Maps, or SQLite in-memory).

---

## 4. Anti-Pattern: Logic Inside Tests

```typescript
// BAD: Hides branches that never execute.
test("processes orders", () => {
  const orders = getOrders();
  if (orders.length > 0) { // Never put if/else in tests!
    expect(orders[0].processed).toBe(true);
  }
});

// GOOD: Flat and deterministic.
test("marks active order as processed", () => {
  const order = createOrder({ status: "pending" });
  const processed = processOrder(order);
  expect(processed.status).toBe("processed");
});
```
