// The legacy v1 session-failure classification vocabulary
// (transient|terminal|format), ported verbatim from deep-review's
// runner/session.ts.
//
// Split out of review/step-runner.ts (architecture guard C2):
// execution/failure-policy.ts's `resolveFailureCause` falls back to this
// classifier (step 4: for any outcome a transport's own `classifyFailure`
// and the parse check both miss), and review/step-runner.ts itself depends
// on execution/harness.ts for StepExecutionHarness — so failure-policy.ts
// importing this classifier FROM step-runner.ts closed a value-import
// cycle back through harness.ts. This file has no imports of its own — a
// true leaf both sides can depend on one-way.

export type FailureClass = "transient" | "terminal" | "format";

export function isTransientSessionFailure(result: {
  stderrTail: string;
  resultText: string;
}): boolean {
  const witness = `${result.stderrTail}\n${result.resultText}`;
  return /API Error|Connection closed|ECONNRESET|socket hang up|timed out|502|503|529|overloaded/i.test(
    witness,
  );
}

export function isTerminalSessionFailure(result: {
  stderrTail: string;
  resultText: string;
}): boolean {
  const witness = `${result.stderrTail}\n${result.resultText}`;
  return /Not logged in\s*[·.]\s*Please run \/login/i.test(witness);
}

export function classifyFailure(outcome: {
  stderrTail: string;
  resultText: string;
  timedOut: boolean;
}): FailureClass {
  if (outcome.timedOut) return "transient";
  if (isTerminalSessionFailure(outcome)) return "terminal";
  return isTransientSessionFailure(outcome) ? "transient" : "format";
}
