// How a person or a local agent asks GitHub to run the review again.
// `gh workflow run` only dispatches `.github/workflows/pr-hero-force.yml`.
// The review itself runs on the Actions runner, with --force. Running
// `pr-hero review --force` locally is a different path and is not this one.

export const CI_FORCE_WORKFLOW_FILE = "pr-hero-force.yml";

export function ciForceReviewDispatch(prNumber: number): string {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`pr number must be a positive integer, got ${prNumber}`);
  }
  return `gh workflow run ${CI_FORCE_WORKFLOW_FILE} -f pr=${prNumber}`;
}

export function ciForceReviewDispatchLine(prNumber: number): string {
  return (
    "Run it on GitHub Actions (this does not review on your machine): " +
    `\`${ciForceReviewDispatch(prNumber)}\``
  );
}
