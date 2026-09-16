// PR mode's teardown: the two `finally` blocks wrapping reviewPr()'s run.
// Relocated out of reviewPr() (src/pr/review-pr.ts): the ledger-settle check
// duplicated in both finally blocks factored into one shared
// `settleLedgerIfPending` helper (still called from both), identifiers moved
// onto explicit parameters, control flow otherwise unchanged. The WHY
// comments below move with the code they explain.

import type { CiAdmissionLedgerState } from "#pr/admission";
import { settleCiAdmissionLedger } from "#pr/admission";
import type { InlinePostOutcome } from "#pr/inline";
import { commitStatusCompletion, commitStatusRequest } from "#pr/preflight";
import { releaseCommitStatusLock, tryPublishCommitStatus } from "#pr/status";
import type { PipelineResult } from "#review/pipeline";
import { runGc } from "#store/gc";
import { releasePidLock } from "../home";

// The ledger has no equivalent hand-off to the SIGTERM/SIGINT handlers (which
// settle only the commit status, via holdCommitStatusLock). Any throw or
// early return that skipped explicit settlement lands here — checked in BOTH
// finally blocks below, because the outer one must also catch a throw from
// inside the inner finally itself (e.g. settleCiAdmissionLedger rejecting
// after the status publish).
async function settleLedgerIfPending(
  ciAdmissionLedger: CiAdmissionLedgerState | null,
): Promise<void> {
  if (
    ciAdmissionLedger !== null &&
    (ciAdmissionLedger.record.status === "reserved" ||
      ciAdmissionLedger.record.status === "provider-started")
  ) {
    await settleCiAdmissionLedger(
      ciAdmissionLedger,
      "failed",
      "review path exited without terminal settlement",
    );
  }
}

// The inner `finally`: the commit status must settle BEFORE the lock is
// released, and the release must happen no matter which path — throw, early
// return, or normal exit — got here. Do not wrap
// tryPublishCommitStatus/releaseCommitStatusLock in their own try/finally
// "for safety": today a throw from tryPublishCommitStatus skips the release,
// and preserving that (not "fixing" it) is this function's job.
export async function settleCommitStatusAndLedger(input: {
  result: PipelineResult | undefined;
  posted: InlinePostOutcome | null;
  operatorRoot: string;
  headSha: string;
  statusTargetUrl: string | undefined;
  ciAdmissionLedger: CiAdmissionLedgerState | null;
}): Promise<void> {
  const phase = commitStatusCompletion({
    pipelineFinished: input.result !== undefined,
    sessionFailed: input.result?.sessionFailed === true,
  });
  await tryPublishCommitStatus(
    input.operatorRoot,
    input.headSha,
    commitStatusRequest({
      phase,
      posted: input.posted !== null,
      targetUrl: input.statusTargetUrl,
    }),
  );
  // Settled, so nothing is held: the signal handlers must never post a
  // second, contradicting status over the one just written. Released
  // immediately after the settle so no path through this finally — throw,
  // early return, or normal exit — can leave the lock standing.
  releaseCommitStatusLock();
  await settleLedgerIfPending(input.ciAdmissionLedger);
}

// The outer `finally`: releases the pid lock and runs gc no matter how the
// whole review path exited, after a last ledger-settlement chance covering a
// throw from inside the inner finally above.
export async function finalizePrReviewRun(input: {
  ciAdmissionLedger: CiAdmissionLedgerState | null;
  lockPath: string;
  home: string;
  repoId: string;
}): Promise<void> {
  await settleLedgerIfPending(input.ciAdmissionLedger);
  await releasePidLock(input.lockPath);
  await runGc({
    home: input.home,
    repoId: input.repoId,
    dryRun: false,
    silent: true,
  });
}
