import { describe, expect, test } from "bun:test";
import {
  CI_FORCE_WORKFLOW_FILE,
  ciForceReviewDispatch,
} from "#ci/force-comment";
import { planCiReviewManualRequired, planCiReviewSkip } from "#ci/gates";
import {
  generateCiForceWorkflowTemplate,
  CI_FORCE_WORKFLOW_FILE as setupFile,
} from "#ci/setup";

describe("ciForceReviewDispatch", () => {
  test("dispatches the force workflow on GitHub and names the PR", () => {
    expect(ciForceReviewDispatch(55)).toBe(
      "gh workflow run pr-hero-force.yml -f pr=55",
    );
    expect(CI_FORCE_WORKFLOW_FILE).toBe(setupFile);
  });

  test("refuses a PR number that is not a positive integer", () => {
    expect(() => ciForceReviewDispatch(0)).toThrow();
    expect(() => ciForceReviewDispatch(1.5)).toThrow();
  });
});

describe("pr-hero-force workflow", () => {
  test("is workflow_dispatch only and passes --force for that PR", () => {
    const template = generateCiForceWorkflowTemplate();
    const parsed = Bun.YAML.parse(template) as {
      on: { workflow_dispatch: { inputs: { pr: { required: boolean } } } };
      jobs: {
        review: { steps: Array<{ with?: Record<string, unknown> }> };
      };
    };
    expect(parsed.on.workflow_dispatch.inputs.pr.required).toBe(true);
    expect(template).not.toContain("pull_request:");
    expect(template).not.toContain("issue_comment:");
    const run = parsed.jobs.review.steps.find(
      (step) => step.with?.force !== undefined,
    );
    expect(run?.with?.force).toBe(true);
    expect(String(run?.with?.["pr-number"])).toContain("inputs.pr");
    expect(template).toContain("fetch-depth: 0");
  });
});

describe("skip comments name the Actions dispatch", () => {
  const prior = {
    blocking: 0,
    advisory: 0,
    score: 0,
    source: "none" as const,
  };

  test("an admission skip tells the reader to dispatch, not to review locally", () => {
    const plan = planCiReviewSkip({
      prNumber: 7,
      verdict: {
        action: "skip",
        reason: "once-per-pr",
        prior,
        reviewCount: 1,
        maxAttempts: 2,
        minScore: 4,
      },
    });
    expect(plan.comment).toContain(ciForceReviewDispatch(7));
    expect(plan.comment).not.toContain("locally");
  });

  test("manual-required names the same dispatch", () => {
    const plan = planCiReviewManualRequired({
      prNumber: 9,
      verdict: {
        action: "manual-required",
        reason: "max-attempts-exhausted",
        prior,
        reviewCount: 2,
        maxAttempts: 2,
        minScore: 4,
      },
    });
    expect(plan.comment).toContain(ciForceReviewDispatch(9));
    expect(plan.comment).not.toContain("pr-hero review --pr");
  });
});
