// Pillar 3 Phase 4 (ROADMAP THE LAUNCH LINE): CI workflow scaffolding.
//
// generateCiWorkflowTemplate is PURE — a string builder with zero filesystem
// access, so its exact bytes are testable without touching disk (the "pure
// decisions pure, I/O in the shell" rule from CLAUDE.md). runCiSetup is the
// one impure edge in this module: it resolves the target path under the
// caller's repo, refuses to clobber a user's customized workflow without
// --force (a safety property, not a nicety — see spec.md §4.1), and writes
// the template.
//
// This module writes `.github/workflows/pr-hero.yml` into WHATEVER repo the
// caller points it at (via `pr-hero setup --ci` / `pr-hero ci init`). Pillar
// 3 Phase 5 (tasks.md 5.2) reuses this SAME function to produce this repo's
// own canonical example workflow at the identical relative path, rather than
// hand-authoring a second copy that could silently drift from what every
// caller of `setup --ci` actually gets — test/packaging.test.ts asserts the
// committed file's bytes equal generateCiWorkflowTemplate()'s output exactly.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const CI_WORKFLOW_RELATIVE_PATH = path.join(
  ".github",
  "workflows",
  "pr-hero.yml",
);

// The action reference the generated workflow resolves. A consumer repo has
// no copy of this action, so it must go through the published tag — that is
// the default. This repo generates its OWN workflow with `./`, because the
// source is right there in the tree and pointing at a tag that is not
// published yet would paint every PR here permanently red. A red check that
// can never go green is strictly worse than no check: it teaches the team to
// stop reading CI, which is the exact failure this pillar exists to prevent.
// `./` is also the only form that tests the action being changed by the very
// PR that changes it.
export interface CiWorkflowTemplateOptions {
  actionRef?: string;
  // Repo-local override for the action's own `budget-usd` default. Omitted
  // means "say nothing and inherit the action's default", which is what every
  // scaffolded repo gets: raising a stranger's spend ceiling from a template
  // they did not choose is not ours to do.
  //
  // Since issue #156 that inherited default is a POLICY, not a number:
  // action.yml's `budget-usd` default is empty, and the CLI resolves the
  // ceiling from the route's billing mode (ci-gates.ts's
  // `resolveCiBudgetCeiling`) — no ceiling on a Claude subscription, a default
  // ceiling on a metered ANTHROPIC_API_KEY route. Inheriting is therefore
  // strictly better than it was: a scaffolded repo now gets a ceiling exactly
  // when a ceiling means something.
  //
  // NOTHING sets this today, this repo included — see OWN_CI_WORKFLOW_OPTIONS
  // for why the one override that existed went away. The knob stays because a
  // repo that genuinely wants a fixed ceiling on a subscription route needs a
  // way to say so, and that is the only thing an explicit value now means.
  budgetUsd?: string;
  // Repo-local override for the action's own `max-changed-lines` default, and
  // omitted for the same reason as `budgetUsd`: a scaffolded repo inherits
  // action.yml's 1000 and decides for itself. THIS repo raises it because its
  // own slices routinely land near the line — D1-10c was skipped at 1023,
  // twenty-three lines over, and a skipped review is indistinguishable from a
  // clean one to anyone reading the checks.
  //
  // Raising it costs little and risks little HERE. It is a COST gate, never a
  // quality one — the size<->quality question is unmeasured in this project
  // (`scripts/scope-probe.ts`), so this number is not a claim that pr-hero
  // reviews a 1500-line diff as well as a 300-line one.
  //
  // Since issue #156 it is also the ONLY gate bounding a self-review's scope
  // here, which is what the number has to be read against: this comment used
  // to lean on `budget-usd` as "the real spend ceiling, which still refuses
  // the work outright". On this repo's subscription route it never was — it
  // gated `estimate.high`, a token-derived figure, against $0.00 of real
  // cash.
  maxChangedLines?: string;
}

export const DEFAULT_CI_ACTION_REF = "juanmaagd/pr-hero@v1";

// The options THIS repo generates its OWN workflow with. One exported source
// of truth rather than three hand-copied literals: the byte-equality drift
// tests and every regeneration read the same object, so a change here cannot
// leave the committed workflow and the tests disagreeing about what "ours"
// means. Nothing a scaffolded repo receives passes through here.
//
// `budgetUsd` is deliberately absent (issue #156). It used to be "15.00", set
// because a self-review's diff grows against the base every time a finding is
// answered, so an iterating PR walked toward the ceiling exactly when the
// check mattered most. The route's billing mode now solves that: this repo
// reviews itself on a Claude subscription, where `resolveCiBudgetCeiling`
// applies no ceiling at all. Restoring the line would not restore a safety
// net — it would IMPOSE a ceiling the policy would otherwise not apply, on an
// `estimate.high` that is not this route's cash cost. `maxChangedLines` stays:
// that gate is real on any route.
export const OWN_CI_WORKFLOW_OPTIONS: CiWorkflowTemplateOptions = {
  actionRef: "./",
  maxChangedLines: "1500",
};

export function generateCiWorkflowTemplate(
  options: CiWorkflowTemplateOptions = {},
): string {
  const actionRef = options.actionRef ?? DEFAULT_CI_ACTION_REF;
  const budgetLine =
    options.budgetUsd === undefined
      ? ""
      : `\n          budget-usd: ${options.budgetUsd}`;
  // Emitted before `budget-usd` to mirror action.yml's own declaration order,
  // so the generated file reads in the same sequence as the inputs it sets.
  const sizeGateLine =
    options.maxChangedLines === undefined
      ? ""
      : `\n          max-changed-lines: ${options.maxChangedLines}`;
  return `# Generated by \`pr-hero setup --ci\` (or \`pr-hero ci init\`).
# Customize freely — re-running setup will not overwrite this file again
# unless you pass --force.
name: pr-hero Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

# Avoid redundant spend on rapid pushes — cancel in-flight reviews when a newer commit arrives.
concurrency:
  group: pr-hero-\${{ github.workflow }}-\${{ github.head_ref || github.ref }}
  cancel-in-progress: true

# The secrets AND env contexts are both unreadable in a job-level \`if\`
# (only github/inputs/needs/vars are), so credential presence is detected in
# one tiny job and consumed through \`needs\`, which IS allowed there.
#
# pull-requests: write lets pr-hero post inline comments and a step summary.
# contents: read is enough for actions/checkout. issues: write lets it
# resolve/reply on review threads (GitHub models PR conversations as issues).
# checks: write persists the durable CI admission attempt ledger (WU-02).
permissions:
  contents: read
  pull-requests: write
  issues: write
  statuses: write
  checks: write

jobs:
  credentials:
    runs-on: ubuntu-latest
    # Bounded like every other job. This one only echoes two strings, so it
    # can never legitimately take minutes — but it runs FIRST and gates
    # \`review\` through \`needs:\`, on the same shared ephemeral runners. Left
    # unbounded, a runner that hangs here inherits GitHub's 360-minute default
    # and stalls the whole workflow for six hours while \`review\` never starts.
    # Bounding only the job that spends money protects the budget, not the
    # pipeline.
    timeout-minutes: 5
    outputs:
      has_creds: \${{ steps.detect.outputs.has_creds }}
    steps:
      - id: detect
        env:
          HAS_CREDS: \${{ secrets.ANTHROPIC_API_KEY != '' || secrets.CLAUDE_CODE_OAUTH_TOKEN != '' }}
        run: echo "has_creds=\${HAS_CREDS}" >> "$GITHUB_OUTPUT"

      # This notice lives HERE, not in the review job, because the review job
      # is exactly the thing that does not run in this case. It is gated on
      # same-repo too: fork PRs never receive secrets by design, so warning on
      # every fork PR would be noise rather than signal.
      - id: notice
        if: >-
          github.event.pull_request.head.repo.full_name == github.repository &&
          steps.detect.outputs.has_creds == 'false'
        run: |
          MSG="pr-hero review SKIPPED: no ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN secret is set, so this PR was not reviewed."
          echo "::notice title=pr-hero review skipped::\${MSG}"
          {
            echo "### :warning: pr-hero did not review this PR"
            echo ""
            echo "\${MSG}"
            echo ""
            echo "Wire ONE secret to turn reviews on:"
            echo ""
            echo '\`\`\`bash'
            echo "claude setup-token   # prints a long-lived token; paste it below"
            echo "gh secret set CLAUDE_CODE_OAUTH_TOKEN"
            echo "# ...or, for pay-as-you-go billing:"
            echo "gh secret set ANTHROPIC_API_KEY"
            echo '\`\`\`'
            echo ""
            echo 'Adding a secret does not re-run past workflows — use \`gh run rerun\` on this run.'
          } >> "$GITHUB_STEP_SUMMARY"

  review:
    # Fork PRs do not have access to repository secrets in GitHub Actions.
    # Restricting to same-repo PRs prevents false-negative authentication failures.
    # Secretless same-repo PRs SKIP instead of failing: the provider capability
    # gate would abort the run in seconds (correctly — zero spend), but a
    # permanent red X on every PR before credentials are wired is noise, not
    # signal.
    #
    # The skip is NOT its own notice, and believing it was cost this project
    # five unreviewed PRs: a skipped job does not fail its workflow, so the run
    # reports "success" and the absence of a review looks exactly like a clean
    # review. The \`notice\` step above is what breaks that silence.
    needs: credentials
    if: >-
      github.event.pull_request.head.repo.full_name == github.repository &&
      needs.credentials.outputs.has_creds == 'true'
    runs-on: ubuntu-latest
    # Backstop for a HUNG runner, not a second review budget. pr-hero already
    # enforces its own 75-minute whole-pipeline ceiling, which closes
    # artifacts and reports before exiting; a CI bound at or below that would
    # kill the job first and throw away the salvage. Above it, this only ever
    # fires when the process is genuinely stuck.
    timeout-minutes: 90
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          # fetch-depth: 0 is load-bearing, not cosmetic: pr-hero computes
          # the pull request's diff range and commit ancestry from full git
          # history. actions/checkout's default is a SHALLOW clone, which
          # cannot produce an accurate diff or blame — trimming this line
          # does not fail loudly, it makes reviews silently miss context.
          fetch-depth: 0

      - name: Run pr-hero
        # The id is load-bearing, not decorative: it is the only way to read
        # this step's \`run-dir\` output from the upload step below.
        id: pr-hero
        uses: ${actionRef}
        with:
          github-token: \${{ secrets.GITHUB_TOKEN }}
          # Provide ONE of the two secrets below (never leave both blank).
          # BOTH inputs are wired unconditionally: an unset secret expands to
          # the empty string, which the action treats as absent, so leaving
          # the one you do not use in place costs nothing. Deleting the line
          # for the secret you DID set is what breaks — the credential never
          # reaches the action, and it fails to authenticate silently.
          #   ANTHROPIC_API_KEY       — pay-as-you-go key (billed per token via Anthropic Console), or
          #   CLAUDE_CODE_OAUTH_TOKEN — from \`claude setup-token\`: a long-lived
          #     (~1 year) token that draws on your Claude subscription at no
          #     extra API cost. It must come from that command. The session
          #     token \`/login\` leaves in the keychain expires in HOURS and is
          #     kept alive by a refresh token CI does not have, so pasting that
          #     one here yields a secret that works for a day and then breaks
          #     reviews with no signal.
          anthropic-api-key: \${{ secrets.ANTHROPIC_API_KEY }}
          claude-token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}${sizeGateLine}${budgetLine}

      # Without this step the triage half of the review loop has no input.
      # \`pr-hero triage reply --pr <n> --from <run-dir> --finding F00N\` is the
      # ONLY supported way to answer a posted finding, and \`--from\` REQUIRES a
      # completed run directory on disk (comparison.json to open the run,
      # findings.json to map F00N onto the posted \`<!-- pr-hero-finding\`
      # marker). In CI that directory lives at
      # \`~/.prhero/repos/<host>/<owner>/<repo>/runs/pr-<n>-<sha>-1\` on an
      # EPHEMERAL runner and dies with the job — so a PR reviewed in Actions
      # used to carry findings that literally could not be answered.
      #
      # \`always()\` is the load-bearing part. A review that FAILED is exactly
      # when this directory matters most: every hunter once died with
      # "Not logged in · Please run /login", and the per-attempt logs naming
      # that cause were only on the runner — recovering them took pushing a
      # throwaway debug commit to cat them off.
      #
      # KNOWN GAP, stated here so this comment does not overclaim: THREE
      # outcomes publish no usable \`run-dir\` and therefore skip this upload.
      # Every hunter died and a fatal error both leave it empty, and a
      # CANCELLED job never writes it at all — the SIGTERM/SIGINT handlers
      # kill the children and exit straight out, never reaching the only code
      # path that touches the job's output file. So the emptiness check below
      # suppresses the upload for exactly the cases \`always()\` was reached
      # for. Closing it needs the action to publish \`run-dir\` on those paths.
      # Until then \`always()\` earns its place on the narrower set: a review
      # that RAN but could not post, and a later step in this job failing.
      #
      # WHAT IT CONTAINS: the reviewed diff (diff.patch), the rendered agent
      # prompts, every hunter draft, and findings.json. On a PUBLIC repository
      # workflow artifacts are downloadable by anyone, which is why retention
      # is deliberately short.
      #
      # Download it with:
      #   gh run download <run-id> -n pr-hero-run-<pr>-<head-sha>
      # then point \`pr-hero triage reply --from\` at the download directory.
      - name: Upload pr-hero run directory
        # A size-gated, budget-gated or concurrent review writes no run
        # directory and publishes no outputs; the emptiness check keeps
        # upload-artifact from being handed an empty \`path:\` in that case.
        if: always() && steps.pr-hero.outputs.run-dir != ''
        uses: actions/upload-artifact@v4
        with:
          # Both the PR number and the head sha, so a download is unambiguous
          # when a PR is reviewed more than once — the run directory itself is
          # named \`pr-<n>-<sha>-1\` for the same reason.
          name: pr-hero-run-\${{ github.event.pull_request.number }}-\${{ github.event.pull_request.head.sha }}
          path: \${{ steps.pr-hero.outputs.run-dir }}
          # upload-artifact excludes hidden files by default since v4.4, and
          # this directory lives under a hidden \`~/.prhero\` ancestor. Paired
          # with \`if-no-files-found: warn\` below, an exclusion here would
          # produce an EMPTY artifact plus a warning nobody reads.
          include-hidden-files: true
          # NEVER \`error\`: a skipped review is working as designed and must
          # not turn the job red.
          if-no-files-found: warn
          # Artifact names are unique per workflow RUN, and \`gh run rerun\` —
          # which the credentials job's own notice tells people to use —
          # reuses the run id. Without this, the second attempt's upload
          # conflicts and \`always()\` turns an otherwise green re-run red.
          overwrite: true
          # Long enough to triage, short enough to limit exposure of the diff
          # and prompts above on a public repository.
          retention-days: 7
`;
}

export interface RunCiSetupOptions {
  cwd?: string;
  force?: boolean;
  exists?: (p: string) => boolean;
}

export type CiSetupResult =
  | { status: "created"; path: string }
  | { status: "overwritten"; path: string }
  | { status: "skipped-existing"; path: string; hint: string };

export async function runCiSetup(
  options: RunCiSetupOptions = {},
): Promise<CiSetupResult> {
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? existsSync;
  const targetPath = path.join(cwd, CI_WORKFLOW_RELATIVE_PATH);
  const alreadyExisted = exists(targetPath);

  if (alreadyExisted && !options.force) {
    return {
      status: "skipped-existing",
      path: targetPath,
      hint: `${CI_WORKFLOW_RELATIVE_PATH} already exists; pass --force to overwrite it`,
    };
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, generateCiWorkflowTemplate());

  return {
    status: alreadyExisted ? "overwritten" : "created",
    path: targetPath,
  };
}
