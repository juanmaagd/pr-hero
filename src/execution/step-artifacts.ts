// Where a step's per-attempt artifacts land, and the retry-reminder text
// appended to a re-prompt — part of the RUNNER CONTRACT, not a harness
// implementation detail, because several modules depend on the exact
// answer: the harness writes these files, review/pipeline.ts indexes them
// from `pipeline.json` (D1-10c), and execution/attempt-evidence.ts derives
// its own evidence path the same way. Deriving the names twice is how a
// pointer starts naming a file that was never written — the exact defect
// the harness's own comment records ("a hardcoded settlement.json in a
// cancellation message pointed at a file that never existed for as long as
// it shipped"), so every caller reads the shape from here.
//
// Split out of review/step-runner.ts (architecture guard C2): step-runner.ts
// itself depends on execution/harness.ts for StepExecutionHarness, so a
// harness.ts or execution/attempt-evidence.ts import of these helpers FROM
// step-runner.ts closed a value-import cycle back through it. This file has
// no imports of its own — a true leaf both sides can depend on one-way.

import path from "node:path";

// `attempt` is the 1-based attempt NUMBER, which for a settled step equals
// `StepResult.attempts`: the transient loop and the one format retry both
// increment the same counter, and the format retry always ends the loop.
export function attemptLogPath(
  outPath: string,
  stepName: string,
  attempt: number,
): string {
  return path.join(path.dirname(outPath), "logs", `${stepName}.${attempt}.log`);
}

export function settlementReceiptPath(
  outPath: string,
  stepName: string,
  attempt: number,
): string {
  return path.join(
    path.dirname(outPath),
    `settlement.${stepName}.attempt${attempt}.json`,
  );
}

export function attemptEvidencePath(
  outPath: string,
  stepName: string,
  attempt: number,
): string {
  return path.join(
    path.dirname(outPath),
    `evidence.${stepName}.attempt${attempt}.json`,
  );
}

export const FORMAT_RETRY_REMINDER =
  "\n\nREMINDER: your final message must be exactly one JSON object " +
  "matching the mandated shape — no prose, no fences.";
