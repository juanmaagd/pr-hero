// PR mode (ROADMAP B1): one command from a PR number to a reviewed range, a
// detached worktree, a pipeline run, and a Greptile comparison. Moved out of
// src/cli.ts (cli-decomp Phase 2, odd/tasks/cli-decomposition.md) as a
// byte-for-byte relocation — no behaviour change.
//
// Two roots run through everything below, and confusing them is the failure
// this design exists to prevent:
//   - the OPERATOR root: --repo's toplevel. cwd for gh and for .prhero/
//     config+gotchas. Config is NEVER read from the worktree — the operator
//     checkout is the trust anchor, and a reviewed PR's tree must not
//     influence engine config. Dirtiness here is irrelevant.
//   - the GIT-DIR OWNER: the clone registered for this origin under
//     ~/.prhero/repos/<id>/registry.json. Fetch, worktree add/prune/remove
//     and the object-db git (rev-parse, diff) run against it, because
//     `git worktree add` is bound to one git dir (W3 / #24).
//   - the REVIEW root: the worktree, detached at the PR's head, living
//     under ~/.prhero/repos/<id>/worktrees/pr-<n>. The pipeline's cwd, the
//     tree the codegraph checks run against, and a root the run dir must
//     stay outside of.

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdmissionRecord } from "#ci/admission-ledger";
import {
  type AdmissionContext,
  budgetDisabledWarningMessage,
  budgetUnlimitedNoticeMessage,
  ciExitCode,
  deriveCiBillingMode,
  planCiBudgetSkip,
  planCiReview,
  planCiReviewManualRequired,
  planCiReviewSkip,
  planCiSizeSkip,
  resolveCiBudgetCeiling,
  shouldPublishCiReview,
  shouldWriteCiOutputs,
  shouldWriteStepSummary,
} from "#ci/gates";
import {
  appendCiOutputs,
  appendStepSummary,
  formatWorkflowCommand,
  withCiWorkflowGroup,
} from "#ci/reporter";
import {
  ciReviewManualRequiredDetail,
  ciReviewPolicyHash,
  ciReviewSkipDetail,
  deltaTouchesPriorFindings,
  evaluateCiReviewAdmission,
  formatCiAdmissionObserveNotice,
  parseCiAdmissionBlock,
  pathsFromPostedFindingMarkers,
  resolveCiAdmissionAttemptCount,
  resolveCiReviewPolicy,
  resolveCiTrustedActors,
  scanPostedFindingTiers,
  stateReviewCount,
  validateAdmissionAuthority,
} from "#ci/review-admission";
import {
  classifyChangedPaths,
  type DeltaRiskAssessment,
} from "#ci/review-risk";
import { parseComparisonJson, type StoredComparison } from "#compare/ledger";
import {
  ingestReviewMetrics,
  loadEffectiveConfig,
  notionalCostInput,
  persistCanonicalReview,
  pipelineConfigInput,
} from "#config/config";
import {
  exclusionLines,
  git,
  gitCommitExists,
  gitIsAncestor,
  gitNameOnly,
  gitNameStatus,
  gitRemoteWebUrl,
  readBaseRefIgnoreRules,
  resolveCommit,
  resolveDiffFrom,
  resolveRepoRoot,
} from "#git/git";
import { engineIdentity } from "#git/identity";
import {
  type CiAdmissionLedgerState,
  publishCiSkip,
  recordCiAdmissionGateSkip,
  reserveCiAdmissionLedger,
  settleCiAdmissionLedger,
} from "#pr/admission";
import { type InlinePostOutcome, postingExitCode } from "#pr/inline";
import {
  CommentsTruncatedError,
  type ComparisonOutcome,
  ensureWorktree,
  fetchCommitStatuses,
  fetchPostedFindingComments,
  fetchPrComments,
  fetchPrRefs,
  fetchPrReviewComments,
  ghCompareChangedFilesWithStatus,
  ghCurrentBranchPr,
  ghPrFiles,
  ghPrHeroWorkflowRunHeads,
  ghPrView,
  ghRepoWebUrl,
  initCodegraphIndex,
  listAdmissionCheckRuns,
  postInlineIfEligible,
  writeComparison,
  writePostReceipt,
} from "#pr/pr";
import {
  commitStatusCompletion,
  commitStatusRequest,
  createPrRunDir,
  findMarkedCommentId,
  isInFlightCommitStatus,
  predictPrRunDir,
  prHtmlUrl,
  resolveCurrentPrNumber,
  resolvePrDryRunSizeGate,
  resolvePrTarget,
} from "#pr/preflight";
import {
  holdCommitStatusLock,
  releaseCommitStatusLock,
  tryPublishCommitStatus,
} from "#pr/status";
import {
  buildPhaseBQueue,
  decideLastHeadDelta,
  enrichPriorsFromThreads,
  incompleteLastReviewMessage,
  parseNameStatus,
  prepareDiscovery,
  priorsFromPostedMarkers,
  priorsFromStateFindings,
  shouldAbortEmptyDiscovery,
  toRereviewProvenance,
  unreachableLastHeadMessage,
} from "#rereview/prepare";
import { parseStateBlock } from "#rereview/state";
import {
  mergeRunEnvelope,
  type Telemetry,
  writeFindings,
} from "#review/findings";
import {
  changedPathsFromDiff,
  type PipelineResult,
  parityTriggered,
  runPipeline,
} from "#review/pipeline";
import {
  allExcludedMessage,
  CliError,
  type CliOptions,
  emptyDiffMessage,
  isCiEnvironment,
  type NumstatFile,
  parseNumstatFiles,
  resolveMaxVerificationSteps,
  resolvePost,
  resolveScout,
  resolveSummary,
} from "#review/preflight";
import {
  type DiffStat,
  envelopeModel,
  estimateCost,
  renderReport,
} from "#review/report";
import {
  buildCliRoutePlan,
  enforceProviderCapabilityGate,
  pipelineScoutInput,
  pipelineSummarizerInput,
  resolveProductionRoutePlanAtConfirm,
} from "#review/route-preflight";
import {
  assertDistinctRange,
  buildTelemetry,
  prepareRunnerForRoute,
  resolveGotchasPath,
  resolvePromptSet,
  selectActiveHunters,
  validateGotchas,
  writeMcpConfig,
} from "#review/run";
import {
  type ExcludedPath,
  effectiveDiffStat,
  evaluateSizeGate,
  filterDiffByIgnoreRules,
  type SizeGateVerdict,
  sizeGateConfig,
  sizeGateLine,
} from "#review/size-gate";
import { registerActiveRun, unregisterActiveRun } from "#store/activity";
import { runGc } from "#store/gc";
import {
  configProvenanceOf,
  dryRunHunterCount,
  type PrPlanContext,
  prPlanDetails,
  renderPrPlan,
  reviewingLine,
} from "#ui/plan";
import { log, styleEnabled, terminalWidth } from "#ui/primitives";
import { applySizeGate, confirm, startProgressRenderer } from "#ui/progress";
import { type ResultLinks, renderResult } from "#ui/result";
import {
  markerCommentSeen,
  parsePrCommentMarker,
  parsePrFiles,
} from "#watch/preflight";
import {
  acquirePidLock,
  releasePidLock,
  resolveRepoHome,
  stampWorktree,
} from "../home";
import {
  legacyMigrationHint,
  legacyWorktreePath,
  prheroLayout,
  prWorktreePath,
  worktreeLockPath,
} from "../home-preflight";
import {
  type IgnoreFileReadResult,
  readLocalIgnoreRules,
} from "../ignore-read";
import type { ProductionRuntime } from "../production-runtime";
import { resolveRunnerAuthority } from "../runner-authority";
import { resolveOpenCodeAuthPath } from "../security/credential-broker";

export async function reviewPr(
  options: CliOptions,
  prArg: number | "current",
): Promise<number> {
  // 1 — the operator root, and everything .prhero/ decides — loaded exactly
  // as local mode loads it, all against the operator root.
  const operatorRoot = await resolveRepoRoot(options.repo);
  // Bare --pr: the PR is whichever one the operator checkout's current
  // branch belongs to. Resolved first and said out loud, so the user sees
  // WHICH PR is about to be reviewed before any plan prints.
  const prNumber =
    prArg === "current"
      ? resolveCurrentPrNumber(await ghCurrentBranchPr(operatorRoot))
      : prArg;
  if (prArg === "current") {
    log(`pr resolved from current branch: #${prNumber}`);
  }
  // The product home, hoisted above the config read: C5's global layer lives
  // under it, and step 2 below needs the same value for the repo registry.
  const home = os.homedir();
  // `operatorRoot`, NEVER worktreePath — the worktree does not even exist
  // yet at this point, and a `.prhero/config.json` committed by the PR author
  // must stay unread (O-8). Same loader as local mode, so the two modes
  // cannot drift on precedence.
  const loaded = await loadEffectiveConfig({
    root: operatorRoot,
    home,
    configFlag: options.config,
  });
  const config = loaded.effective;
  const summary = resolveSummary(options, config);
  const scout = resolveScout(options, config);
  const post = resolvePost(options, config);
  // ROADMAP Pillar 3 (GitHub Actions CI). isCi folds in HERE, alongside
  // scout/post, so `options.yes` carries the headless bypass (spec 2.1:
  // "MUST run headlessly ... equivalent to --yes") through every downstream
  // read of `options.yes` in one move — the confirm gate below, the in-flight
  // TOCTOU check (`if (options.yes) return 0` is the correct CI answer to a
  // stuck pending), and applySizeGate's own `opts.yes` read. A parallel
  // `effectiveYes` local would miss whichever of those reads came later.
  const isCi = isCiEnvironment(options, {
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    CI: process.env.CI,
  });
  options = { ...options, scout, post, yes: options.yes || isCi };
  // `.prheroignore`, read EAGERLY here for the non-CI case only: the
  // operator's working tree (`operatorRoot`, NEVER `worktreePath` — O-8) is
  // available with no fetch, so both the free dry-run exit below and the
  // real run can share this one read. Under CI the read instead needs to
  // come from the BASE REF — the PR author must never be able to choose
  // which `.prheroignore` governs their own review (design D1) — which
  // needs `baseSha` resolved AND the commit fetched, neither of which exists
  // yet here; that read happens later, after both (see readBaseRefIgnoreRules
  // below). `localIgnore` therefore stays `undefined` under CI on purpose —
  // there is nothing safe to read at this point in that branch.
  const localIgnore = isCi
    ? undefined
    : await readLocalIgnoreRules(operatorRoot);
  // Issue #156: resolve the ceiling ONCE, here, and use this same value at
  // the budget gate far below. Resolving twice invites the announcement and
  // the gate drifting apart. Deliberately NOT folded back into
  // `options.budgetUsd` — the metered default is a CI-gate policy, and
  // leaking a 10 that the operator never typed into every other read of
  // `options.budgetUsd` would make it look configured.
  const ciBudgetCeiling = resolveCiBudgetCeiling({
    configured: options.budgetUsd,
    billingMode: deriveCiBillingMode(process.env, {
      // File presence, not envBillsMetered: that predicate stamps Claude
      // usage and must stay Anthropic-env-only.
      openCodeAuthPresent: existsSync(resolveOpenCodeAuthPath()),
    }),
  });
  // Spec 3.1: a silent disable is indistinguishable from a passing gate, so
  // an EXPLICIT `--budget-usd <= 0` warns even though it never skips a run.
  // Emitted here (once, as soon as isCi/budgetUsd are both known) rather
  // than beside the budget-gate check below, which only runs at all when
  // there IS an estimate to compare against. The subscription notice rides
  // the same reasoning and the same placement, one register quieter: a
  // resolved no-ceiling is not an operator mistake, but it is still a gate
  // that did not run, and this repo does not ship those silently.
  if (isCi) {
    const disabledWarning = budgetDisabledWarningMessage(
      ciBudgetCeiling.budgetUsd,
    );
    if (disabledWarning !== null) {
      log(formatWorkflowCommand("warning", disabledWarning));
    }
    const unlimitedNotice = budgetUnlimitedNoticeMessage(ciBudgetCeiling);
    if (unlimitedNotice !== null) {
      log(formatWorkflowCommand("notice", unlimitedNotice));
    }
  }
  // The WHOLE resolution, not just its dir: under the compiled binary the
  // prompt set is a map of embedded paths and `dir` is only a display label.
  const { agents, spec, agentFiles, promptSet } = await resolvePromptSet(
    options,
    loaded,
  );
  const { dir: agentsDir, source: agentsDirSource } = agents;
  const gotchasPath = resolveGotchasPath(options.gotchas, operatorRoot);
  await validateGotchas(gotchasPath);
  // Local mode's dirty-tree and HEAD-match gates are both skipped here ON
  // PURPOSE: the hunters read the worktree and never this checkout, and the
  // worktree satisfies the HEAD gate by construction (created detached at
  // the PR's own head).

  // 2 — the global home (origin → repo-id → worktree/runs paths), then the
  // PR record. `home` is resolved in step 1 above, where C5's global config
  // layer needs it. persist is false on --dry-run so the free exit creates
  // nothing, including registry.json.
  const repoHome = await resolveRepoHome({
    home,
    operatorRoot,
    persist: !options.dryRun,
  });
  const gitDirOwner = repoHome.gitDirOwner;
  const target = resolvePrTarget(await ghPrView(operatorRoot, prNumber));
  const worktreePath = prWorktreePath(home, repoHome.repoId, prNumber);
  const leftover = legacyWorktreePath(operatorRoot, prNumber);
  if (existsSync(leftover)) {
    for (const line of legacyMigrationHint({
      operatorRoot,
      legacyWorktree: leftover,
      newWorktree: worktreePath,
    })) {
      log(line);
    }
  }

  const ciPolicy = resolveCiReviewPolicy(config);
  const ciPolicyHash = ciReviewPolicyHash(ciPolicy);
  let ledgerRecords: AdmissionRecord[] = [];
  let ciAdmissionLedger: CiAdmissionLedgerState | null = null;

  if (!options.dryRun && isCi) {
    ledgerRecords = await listAdmissionCheckRuns(operatorRoot, target.headSha);
  }

  if (!options.dryRun && !options.force && isCi) {
    let issueComments: Awaited<ReturnType<typeof fetchPrComments>>;
    let reviewComments: Awaited<ReturnType<typeof fetchPrReviewComments>>;
    let authorityFailOpen = false;
    try {
      [issueComments, reviewComments] = await Promise.all([
        fetchPrComments(operatorRoot, prNumber),
        fetchPrReviewComments(operatorRoot, prNumber),
      ]);
    } catch (error) {
      if (error instanceof CommentsTruncatedError) {
        authorityFailOpen = true;
        issueComments = [];
        reviewComments = [];
      } else {
        throw error;
      }
    }
    const existingSummaryId = findMarkedCommentId(issueComments);
    const summaryBody =
      existingSummaryId === null
        ? null
        : (issueComments.find((c) => c.id === existingSummaryId)?.body ?? null);
    const summaryMarker =
      summaryBody === null ? null : parsePrCommentMarker(summaryBody);
    const summaryHead = summaryMarker?.head ?? null;
    const summaryComplete = summaryMarker?.complete ?? true;
    const state = summaryBody === null ? null : parseStateBlock(summaryBody);
    const parsedAdmission =
      summaryBody === null ? null : parseCiAdmissionBlock(summaryBody);
    const authority = validateAdmissionAuthority({
      summaryHead,
      reportMarkerHead: summaryHead,
      state,
      admission: parsedAdmission,
    });
    if (!authority.ok) {
      authorityFailOpen = true;
    }
    const trustedActors = resolveCiTrustedActors({
      githubActor: process.env.GITHUB_ACTOR,
      extra: config.ci_trusted_actors,
    });
    const allComments = [...reviewComments, ...issueComments];
    const postedFindings =
      summaryHead === null
        ? null
        : scanPostedFindingTiers({
            summaryHead,
            comments: allComments,
            trustedActors,
          });
    const markerSeen = markerCommentSeen(issueComments);
    const stateCount = stateReviewCount(state, markerSeen, parsedAdmission);
    const headBranch = process.env.GITHUB_HEAD_REF;
    const workflowHeads =
      headBranch === undefined || headBranch.length === 0
        ? new Set<string>()
        : await ghPrHeroWorkflowRunHeads(operatorRoot, headBranch);
    const reviewCount = resolveCiAdmissionAttemptCount({
      stateCount,
      workflowHeads,
      ledgerRecords,
    });
    let deltaTouchesPriorFindingsFlag = false;
    let deltaRisk: DeltaRiskAssessment | null = null;
    if (summaryHead !== null && summaryHead !== target.headSha) {
      const compareFiles = await ghCompareChangedFilesWithStatus(
        operatorRoot,
        summaryHead,
        target.headSha,
      );
      const changedPaths = compareFiles.map((entry) => entry.path);
      deltaRisk = classifyChangedPaths(
        changedPaths,
        compareFiles.map((entry) => ({
          path: entry.path,
          status: entry.status,
        })),
      );
      const priorPaths = pathsFromPostedFindingMarkers(
        allComments,
        summaryHead,
        trustedActors,
      );
      if (priorPaths.length > 0) {
        deltaTouchesPriorFindingsFlag = deltaTouchesPriorFindings(
          changedPaths,
          priorPaths,
        );
      }
    }
    const admissionVerdict = evaluateCiReviewAdmission({
      currentHead: target.headSha,
      summaryHead,
      summaryComplete,
      markerSeen,
      reviewCount,
      state,
      admission: parsedAdmission,
      postedFindings,
      policy: ciPolicy,
      deltaTouchesPriorFindings: deltaTouchesPriorFindingsFlag,
      deltaRisk,
      authorityFailOpen,
    });
    const admissionContext: AdmissionContext = {
      currentHead: target.headSha,
      reviewedHead: summaryHead,
      policyMode: ciPolicy.mode,
      policyHash: ciPolicyHash,
      deltaRisk,
    };
    const observeOnly = config.ci_admission_observe_only === true;
    if (
      observeOnly &&
      (admissionVerdict.action === "skip" ||
        admissionVerdict.action === "manual-required")
    ) {
      log(
        formatWorkflowCommand(
          "notice",
          formatCiAdmissionObserveNotice({
            verdict: admissionVerdict,
            currentHead: target.headSha,
            reviewedHead: summaryHead,
            policyMode: ciPolicy.mode,
            policyHash: ciPolicyHash,
            deltaRisk,
          }),
        ),
      );
    }
    if (!observeOnly && admissionVerdict.action === "skip") {
      const skipReason = ciReviewSkipDetail(admissionVerdict);
      await recordCiAdmissionGateSkip({
        operatorRoot,
        prNumber,
        headSha: target.headSha,
        policy: ciPolicy,
        policyHash: ciPolicyHash,
        existing: ledgerRecords,
        reason: skipReason,
        priorScore: admissionVerdict.prior.score,
        blockingCount: admissionVerdict.prior.blocking,
        advisoryCount: admissionVerdict.prior.advisory,
      });
      const plan = planCiReviewSkip({
        prNumber,
        verdict: admissionVerdict,
        admission: admissionContext,
      });
      return await publishCiSkip({
        operatorRoot,
        prNumber,
        post: options.post === true,
        isCi,
        stepSummaryFlag: options.stepSummary,
        plan,
        noticeMessage: `pr-hero review skipped — ${skipReason}`,
      });
    }
    if (!observeOnly && admissionVerdict.action === "manual-required") {
      const manualReason = ciReviewManualRequiredDetail(admissionVerdict);
      await recordCiAdmissionGateSkip({
        operatorRoot,
        prNumber,
        headSha: target.headSha,
        policy: ciPolicy,
        policyHash: ciPolicyHash,
        existing: ledgerRecords,
        reason: manualReason,
        priorScore: admissionVerdict.prior.score,
        blockingCount: admissionVerdict.prior.blocking,
        advisoryCount: admissionVerdict.prior.advisory,
      });
      const plan = planCiReviewManualRequired({
        prNumber,
        verdict: admissionVerdict,
        admission: admissionContext,
      });
      return await publishCiSkip({
        operatorRoot,
        prNumber,
        post: options.post === true,
        isCi,
        stepSummaryFlag: options.stepSummary,
        plan,
        noticeMessage: `pr-hero review requires manual override — ${manualReason}`,
      });
    }
  }

  // 3 — the free exit, BEFORE the git fetch: a PR-mode dry run still creates
  // NOTHING — no `git fetch`, no worktree, no run dir — but it does now make
  // a SECOND read-only `gh` call, alongside the `ghPrView` one at step 1
  // above. That call was always there; "fetches nothing" never meant "talks
  // to GitHub zero times", only that nothing GIT-side happens. Overriding
  // the original all-aggregate estimate (PR1b Addition 1 / #5557): the
  // aggregate counters carry no per-file paths, so `.prheroignore`
  // exclusions were structurally impossible to apply here, and that gap
  // widens from "tens of lines" (lockfiles) to "potentially thousands" (a
  // whole ignored directory) the moment a user defines their own rules — a
  // dry run that says SKIP for a PR the real per-file run happily accepts
  // reads as a broken tool, not a conservative estimate.
  if (options.dryRun) {
    const hunterCount = dryRunHunterCount(spec, config);
    const estimate = estimateCost(
      target.ghDiffStat,
      hunterCount,
      summary.enabled,
      options.scout,
    );
    const dryRunGateConfig = sizeGateConfig(
      options,
      config,
      localIgnore?.rules,
    );
    // gh's `files` list can be TRUNCATED on a very large PR (same hazard as
    // watch/watch.ts:322-327's tier 2). A short list under-counts, and
    // under-counting here would falsely RESCUE exactly the monster this gate
    // exists to stop, so a count that disagrees with GitHub's own
    // `changedFiles` counter is never trusted to produce a passing verdict.
    // UNAVAILABLE is the same answer as TRUNCATED here, and the note
    // resolvePrDryRunSizeGate renders already says so in those words. A dry
    // run creates nothing and is a PLAN, so it must degrade to the aggregate
    // estimate rather than abort: `ghPrFiles` is bounded by
    // GH_PR_VIEW_TIMEOUT_MS, and without this catch a stalled GitHub would
    // turn `--dry-run` from "conservative estimate" into "command failed" —
    // trading a hang for a hard stop when the fallback was already built and
    // labelled.
    // `null` DIRECTLY on failure, never an empty list routed through the
    // length check below: `[].length >= 0` is true, so an empty list would
    // sail through as trustworthy and hand the per-file gate zero lines to
    // measure — a PASSING verdict produced by a failed fetch, which is the
    // one outcome a size gate must never invent.
    let perFile: NumstatFile[] | null;
    try {
      const rawFiles = parsePrFiles(await ghPrFiles(operatorRoot, prNumber));
      perFile = rawFiles.length >= target.ghDiffStat.files ? rawFiles : null;
    } catch {
      perFile = null;
    }
    const { verdict: estimated, note: baseSizeGateNote } =
      resolvePrDryRunSizeGate({
        ghDiffStat: target.ghDiffStat,
        perFile,
        gateConfig: dryRunGateConfig,
      });
    // Under CI, `localIgnore` is intentionally undefined (see its own
    // comment above) — the base-ref read needs a fetch a dry run does not
    // perform — so this estimate applies only the 9 BUILT-IN default
    // exclusions, never a repo's user-defined `.prheroignore` rules. Said
    // out loud rather than discovered: a CI dry run that quietly ignored
    // `.prheroignore` would look like the SAME bug Addition 1 exists to fix.
    const sizeGateNote = isCi
      ? `${baseSizeGateNote} User-defined \`.prheroignore\` rules are not ` +
        "applied to this estimate under --ci; only the built-in defaults " +
        "are (the base ref is not fetched until a real run)."
      : baseSizeGateNote;
    const dryRunPlan: PrPlanContext = {
      options,
      operatorRoot,
      target,
      worktreePath,
      runDir: predictPrRunDir(
        options,
        operatorRoot,
        worktreePath,
        repoHome.paths.runs,
        prNumber,
        target.headSha,
      ),
      diffStat: target.ghDiffStat,
      agentsDir,
      agentFiles,
      spec,
      config,
      summary,
      estimate,
      hunterCount,
      sizeGate: estimated,
      sizeGateNote,
      droppedPaths: [],
      // On the dry run too, and it is the case that matters most: this is the
      // free card an operator reads BEFORE deciding to spend, so a value
      // arriving from the global layer must be visible here or it is
      // discovered only in the bill.
      configProvenance: configProvenanceOf(loaded, agentsDirSource),
    };
    for (const line of renderPrPlan(dryRunPlan, styleEnabled())) log(line);
    log();
    if (!estimated.ok && !options.force) {
      log("dry run: this PR would likely be SKIPPED by the size gate.");
    }
    log("dry run: nothing was fetched, created, or spent.");
    return 0;
  }

  if (isCi) {
    try {
      ciAdmissionLedger = await reserveCiAdmissionLedger({
        operatorRoot,
        prNumber,
        headSha: target.headSha,
        policy: ciPolicy,
        policyHash: ciPolicyHash,
        existing: ledgerRecords,
        decisionReason: options.force
          ? "manual override (--force)"
          : "admission: run",
      });
    } catch (error) {
      throw new CliError(
        `CI admission reservation failed: ${(error as Error).message}`,
      );
    }
  }

  const lockPath = worktreeLockPath(home, repoHome.repoId, prNumber);
  await acquirePidLock(lockPath);
  try {
    // 4 — fetch, then canonicalize. See fetchPrRefs for why that refspec pair.
    // Object-db git runs against the git-dir OWNER, not the operator cwd: the
    // worktree is registered there (W3).
    await fetchPrRefs(gitDirOwner, prNumber, target.baseRefName);
    const headSha = await resolveCommit(gitDirOwner, target.headSha);
    // baseRef may be a `<sha>^1` expression (merged PR); rev-parse settles it.
    const baseSha = await resolveCommit(gitDirOwner, target.baseRef);
    assertDistinctRange(baseSha, headSha);

    // `.prheroignore` — CI reads the RESOLVED base sha (never `target.baseRef`
    // / `target.baseRefName` directly: a merged PR's baseRef is a `<sha>^1`
    // EXPRESSION, and only `baseSha` above is the canonical sha `ls-tree`
    // needs). `baseSource` — "base-branch" for an open/closed-unmerged PR,
    // "merge-commit-parent" for a merged one — decides WHICH historical
    // revision this is (see pr/preflight.ts's PrTarget.baseRef comment): a
    // merged-PR replay (exactly what the lab/bench does) therefore reads the
    // `.prheroignore` as of the MERGE, not today's tip. Neither revision is
    // author-controlled, so the security property design D1 wants
    // (the PR author cannot choose which `.prheroignore` governs their own
    // review) holds for both.
    //
    // Non-CI already read `operatorRoot` eagerly above (`localIgnore`), and
    // that read is reused here rather than re-read — the same value must
    // decide the dry-run estimate and the real run.
    //
    // NOTE (recorded, not fixed — see design's Open Questions): this read
    // cannot precede fetchPrRefs above, so a lookup failure here burns one CI
    // admission attempt already reserved (the ciAdmissionLedger reservation).
    // A persistent misconfig therefore exhausts `ci_max_attempts` into
    // manual-required — the correct outcome for a repo-level misconfig, not a
    // reason to reorder a settled CI mechanism.
    const prIgnore = isCi
      ? await readBaseRefIgnoreRules(git, gitDirOwner, baseSha)
      : // isCi is false on this branch, so `localIgnore` above is defined.
        (localIgnore as IgnoreFileReadResult);
    const headLabel = `PR #${prNumber} head`;
    const diffFromSha = await resolveDiffFrom(
      gitDirOwner,
      false,
      target.baseRef,
      headLabel,
      baseSha,
      headSha,
    );

    // 5 — last-reviewed head, then the TWO deltas (D9). Discovery is the
    // restricted L..H intersection (or full B..H); the size gate counts
    // that same discovery diff, never the whole PR, so a merge of main
    // cannot inflate the bill. Empty discovery is a re-review state, not
    // an error (C6) — first review (case A) still fails loud.
    const [issueComments, postedFindings, reviewComments] = await Promise.all([
      fetchPrComments(operatorRoot, prNumber),
      fetchPostedFindingComments(operatorRoot, prNumber),
      fetchPrReviewComments(operatorRoot, prNumber),
    ]);
    const existingSummaryId = findMarkedCommentId(issueComments);
    // parsePrCommentMarker, not parseMarkerHead: this is the ONE call site
    // that decides whether the L this run is about to trust actually
    // finished (rereview-coverage fix). A missing or unparseable
    // marker means "nothing to distrust" — summaryComplete defaults true and
    // is then ignored anyway, since resolveLastReviewedHead only consults it
    // when summaryHead itself is non-null.
    const summaryMarker =
      existingSummaryId === null
        ? null
        : parsePrCommentMarker(
            issueComments.find((c) => c.id === existingSummaryId)?.body ?? "",
          );
    const summaryHead = summaryMarker?.head ?? null;
    const summaryComplete = summaryMarker?.complete ?? true;
    const prepared = await prepareDiscovery({
      B: diffFromSha,
      H: headSha,
      full: options.full,
      summaryHead,
      summaryComplete,
      findingMarkers: postedFindings.map((p) => ({
        headSha: p.marker.headSha,
        createdAt: p.created_at ?? "",
      })),
      git: {
        commitExists: (sha) => gitCommitExists(gitDirOwner, sha),
        isAncestor: (ancestor, descendant) =>
          gitIsAncestor(gitDirOwner, ancestor, descendant),
        nameOnly: (from, to) => gitNameOnly(gitDirOwner, from, to),
      },
    });
    const discoveryRange = `${prepared.discoveryFrom}..${prepared.discoveryTo}`;
    const pathArgs =
      prepared.discoveryPaths !== null && prepared.discoveryPaths.length > 0
        ? ["--", ...prepared.discoveryPaths]
        : [];
    const skipPlannedDiscovery =
      prepared.plan.skipDiscovery || prepared.discoverySkippedEmptyDelta;

    let rawDiff = "";
    if (!skipPlannedDiscovery) {
      const diff = await git(gitDirOwner, [
        "diff",
        discoveryRange,
        ...pathArgs,
      ]);
      if (!diff.ok) throw new CliError(`git diff failed: ${diff.stderr}`);
      rawDiff = diff.stdout;
    }
    if (shouldAbortEmptyDiscovery(prepared.plan, rawDiff)) {
      throw new CliError(emptyDiffMessage(target.baseRef, headLabel, false));
    }
    const gateConfig = sizeGateConfig(options, config, prIgnore.rules);
    const effectiveDiff = skipPlannedDiscovery
      ? {
          patch: "",
          droppedPaths: [] as string[],
          exclusions: [] as ExcludedPath[],
        }
      : filterDiffByIgnoreRules(rawDiff, gateConfig.excludeRules);
    if (
      prepared.plan.emptyDeltaIsError &&
      effectiveDiff.patch.trim().length === 0
    ) {
      throw new CliError(
        effectiveDiff.droppedPaths.length > 0
          ? allExcludedMessage(effectiveDiff.droppedPaths)
          : emptyDiffMessage(target.baseRef, headLabel, false),
      );
    }
    const skipDiscovery =
      skipPlannedDiscovery || effectiveDiff.patch.trim().length === 0;
    const rereview = toRereviewProvenance(prepared, postedFindings.length);
    if (rereview !== undefined && skipDiscovery) {
      rereview.discovery_skipped_empty_delta = true;
    }

    let verifyQueue: ReturnType<typeof buildPhaseBQueue>["queued"] = [];
    let overlapCandidates: ReturnType<
      typeof buildPhaseBQueue
    >["overlapCandidates"] = [];
    let phaseB:
      | {
          settled: ReturnType<typeof buildPhaseBQueue>["settled"];
          priors: ReturnType<typeof priorsFromStateFindings>;
        }
      | undefined;
    const lastHeadDelta = decideLastHeadDelta({
      case: prepared.case,
      L: prepared.last.L,
    });
    if (lastHeadDelta.kind !== "none") {
      // A force-pushed L is gone from this clone, so there is no L..H delta to
      // read and asking git for one is the crash this branch exists to avoid.
      // Case E already planned a FULL review; an empty name-status keeps Phase
      // B running over it, and classifyPrior's D/E branch queues every prior
      // for verification before it would ever consult `touched`. Losing the
      // deletion/rename settling that a real name-status buys therefore costs
      // a verify spawn, never a dropped prior.
      if (lastHeadDelta.kind === "unreachable") {
        const degraded = unreachableLastHeadMessage(lastHeadDelta.sha);
        log(isCi ? formatWorkflowCommand("notice", degraded) : degraded);
      } else if (lastHeadDelta.kind === "diff" && !prepared.last.lastComplete) {
        // The incomplete-review notice, same mechanism and "said once, in CI and out"
        // rule as the unreachable one above — case E's unreachable message
        // already explains "full review, re-verify everything" for that
        // case, so this covers exactly the cases the unreachable branch
        // does not: a forced-full B/C re-review because the LAST review
        // (not this one) never finished.
        const incomplete = incompleteLastReviewMessage(lastHeadDelta.from);
        log(isCi ? formatWorkflowCommand("notice", incomplete) : incomplete);
      }
      const nameStatus = parseNameStatus(
        lastHeadDelta.kind === "diff"
          ? await gitNameStatus(gitDirOwner, lastHeadDelta.from, headSha)
          : "",
      );
      const summaryComment =
        existingSummaryId === null
          ? undefined
          : issueComments.find((c) => c.id === existingSummaryId);
      const summaryUpdatedAt = summaryComment?.updated_at ?? null;
      const state = parseStateBlock(summaryComment?.body ?? "");
      const rawPriors =
        state === null
          ? priorsFromPostedMarkers(
              postedFindings.map((p) => ({
                path: p.livePath ?? p.marker.path,
                line: p.liveLine ?? p.marker.line,
                channel: p.channel === "issue" ? "outside" : "inline",
              })),
            )
          : priorsFromStateFindings(state.findings);
      const priors = enrichPriorsFromThreads({
        priors: rawPriors,
        posted: postedFindings,
        replies: reviewComments,
        summaryUpdatedAt,
      });
      const classified = buildPhaseBQueue({
        case: prepared.case,
        priors,
        nameStatus,
        summaryUpdatedAt,
        // Rereview-coverage wiring fix: `plan.
        // verifyAll` was computed but never read anywhere in production —
        // classifyPrior only ever forced verify_all off `case === "D" ||
        // "E"`, and decideRereviewCase stays UNCHANGED by this fix (the
        // case stays B/C, only discovery widens, per R2-C5). Without this,
        // `verifyAll: true` on a forced-full case B/C would be a silent
        // no-op and the refuter-failed prior would never be re-verified.
        verifyAll: prepared.plan.verifyAll,
      });
      verifyQueue = classified.queued;
      overlapCandidates = classified.overlapCandidates;
      phaseB = { settled: classified.settled, priors };
      if (rereview !== undefined) {
        rereview.prior_findings = priors.length;
        rereview.settled_deterministically = classified.settled.filter(
          (s) => s.status !== "queued",
        ).length;
      }
    }

    let diffStat: DiffStat;
    let sizeGate: SizeGateVerdict;
    if (skipDiscovery) {
      diffStat = { files: 0, insertions: 0, deletions: 0 };
      sizeGate = evaluateSizeGate([], gateConfig);
    } else {
      const numstat = await git(gitDirOwner, [
        "diff",
        "--numstat",
        discoveryRange,
        ...pathArgs,
      ]);
      if (!numstat.ok) {
        throw new CliError(`git diff --numstat failed: ${numstat.stderr}`);
      }
      const gateNumstat = await git(gitDirOwner, [
        "diff",
        "-w",
        "--ignore-blank-lines",
        "--numstat",
        discoveryRange,
        ...pathArgs,
      ]);
      if (!gateNumstat.ok) {
        throw new CliError(
          `git diff -w --numstat failed: ${gateNumstat.stderr}`,
        );
      }
      diffStat = effectiveDiffStat(
        parseNumstatFiles(numstat.stdout),
        gateConfig.excludeRules,
      );
      sizeGate = evaluateSizeGate(
        parseNumstatFiles(gateNumstat.stdout),
        gateConfig,
      );
    }

    // 5b(CI) — the assistant-posture branch, BEFORE applySizeGate: outside
    // CI, a hard skip in non-interactive mode THROWS a CliError (see
    // applySizeGate below), which the top-level catch turns into exit 1 —
    // exactly the "blocks CI" behavior spec 2.1 forbids. `--force` bypasses
    // here too, same as the non-CI path just below, since it answers the
    // same question ("is this diff too big to be worth its cost") either
    // way. planCiSizeSkip (ci/gates.ts) is the ONE call: it is null unless
    // isCi && the gate actually failed, so no separate isCi guard is needed
    // around it beyond --force.
    if (!options.force) {
      const sizePlan = planCiSizeSkip({
        isCi,
        verdict: sizeGate,
        prNumber,
        maxChangedLines: gateConfig.maxChangedLines,
        maxChangedFiles: gateConfig.maxChangedFiles,
      });
      if (sizePlan !== null) {
        await settleCiAdmissionLedger(
          ciAdmissionLedger,
          "skipped",
          "diff exceeds the configured size gate",
        );
        return await publishCiSkip({
          operatorRoot,
          prNumber,
          post: options.post === true,
          isCi,
          stepSummaryFlag: options.stepSummary,
          plan: sizePlan,
          noticeMessage:
            "pr-hero review skipped — diff exceeds the configured size gate",
        });
      }
    }

    // 5b — the size gate, on the REAL per-file numstat and placed here on
    // purpose: before createPrRunDir, so a skipped PR leaves no run dir
    // behind. That matters beyond tidiness — the watcher counts attempts from
    // run artifacts, so a gate skip cannot consume a poison-PR attempt even
    // when the watcher was the one that launched this review. Unattended
    // (--yes) still skips with no prompt; an interactive TTY is asked first.
    // A hard skip (and the interactive prompt) never reach the plan, so the
    // verdict states itself here. --force falls through and the plan's
    // decision block prints the same line plus the override note.
    const sizeGateChoice = await applySizeGate(sizeGate, options, () => {
      log(sizeGateLine(sizeGate));
      // The shell owns BOTH impure decisions here (style flag and width), the
      // same way printDryRun does — this is the one exclusion line that is
      // printed outside a plan renderer, so it cannot inherit a resolved width
      // from one.
      for (const line of exclusionLines(
        effectiveDiff.droppedPaths,
        styleEnabled(),
        terminalWidth(),
      )) {
        log(line);
      }
    });
    if (sizeGateChoice === "abort") return 1;
    const sizeGateConfirmed = !sizeGate.ok && !options.force;

    // Cross-machine TOCTOU: the watcher already skipped fresh pendings at
    // gather, but a CLI and a watcher can still overlap between that fetch
    // and this process posting its own pending. --yes (the watcher child)
    // aborts before createPrRunDir so it consumes no poison-PR attempt.
    // Interactive continues: a stuck pending must not trap the operator
    // behind the 90-minute TTL.
    if (
      isInFlightCommitStatus(
        await fetchCommitStatuses(operatorRoot, headSha),
        Date.now(),
      )
    ) {
      if (options.yes) {
        log("skip: a pr-hero review is already in-flight on this head");
        return 0;
      }
      log(
        "warning: a pr-hero review is already in-flight on this head; " +
          "continuing",
      );
    }

    // 6 — run dir + diff artifact (PR naming; outside BOTH roots).
    const runDir = await createPrRunDir(
      options,
      operatorRoot,
      worktreePath,
      repoHome.paths.runs,
      prNumber,
      headSha,
    );
    // diff.patch is the EFFECTIVE diff — exactly what the hunters read (see
    // filterDiffByIgnoreRules); diff.raw.patch preserves the unfiltered
    // bytes, and only when the filter actually dropped something.
    const diffPath = path.join(runDir, "diff.patch");
    await Bun.write(diffPath, effectiveDiff.patch);
    if (effectiveDiff.droppedPaths.length > 0) {
      await Bun.write(path.join(runDir, "diff.raw.patch"), rawDiff);
    }

    // 7 — the plan and the paid gate, exactly like local mode but with the
    // real numstat replacing GitHub's counters.
    const changedPaths = changedPathsFromDiff(effectiveDiff.patch);
    const parityFires = parityTriggered(
      changedPaths,
      config.parity_trigger_paths,
    );
    const activeHunters = skipDiscovery
      ? []
      : selectActiveHunters(spec.agents, parityFires);
    const hunterCount = activeHunters.length;
    const maxVerificationSteps = resolveMaxVerificationSteps(config);
    const queuedVerification = Math.min(
      verifyQueue.length,
      maxVerificationSteps,
    );
    const estimate = estimateCost(
      diffStat,
      hunterCount,
      summary.enabled && !skipDiscovery,
      options.scout && !skipDiscovery,
      queuedVerification,
    );
    // 7b(CI) — the budget gate, immediately after the estimate it reads and
    // BEFORE the plan card/confirm/"committed to spending" commit-status
    // block below: spec 3.1 ("Review MUST halt before agent spawning") is
    // satisfied at any point before runPipeline, and this is the earliest
    // point the REAL (parity-narrowed) estimate exists — the same one the
    // plan card is about to show, so the skip comment's number and the
    // (unrendered) plan's number can never have disagreed. `estimate.high`,
    // not `.low`: report.ts's own doctrine (~97-98) is that every recorded
    // overrun was an UNDER-estimate, so the generous side is the cheap one
    // to be wrong on. Unlike the size gate above, this is NOT gated on
    // `--force` — `--force`'s own doc comment (preflight.ts CliOptions)
    // scopes it to the size gate's "is this diff too big" question, not
    // spend. Tradeoff accepted: unlike the size gate, this runs AFTER
    // createPrRunDir (step 6), so a budget skip can leave a near-empty run
    // dir behind — the tidiness rationale that placement protects against
    // (the watcher's attempt counter) does not apply to an ephemeral CI
    // runner, and restructuring the cost estimate earlier is out of Phase
    // 3's scope.
    // `ciBudgetCeiling.budgetUsd`, not `options.budgetUsd`: since issue #156
    // an unset `--budget-usd` is a POLICY, not an absent number. It resolves
    // to no ceiling on a subscription route (where `estimate.high` is a token
    // figure and the cash cost is $0.00, so gating on it refused work over an
    // overrun that cannot happen) and to the default ceiling on a metered one.
    // `undefined` here still means the gate does not run — the announcement
    // for that already fired at the resolution site above.
    if (isCi && ciBudgetCeiling.budgetUsd !== undefined) {
      const budgetPlan = planCiBudgetSkip({
        isCi,
        estimatedCostUsd: estimate.high,
        budgetUsd: ciBudgetCeiling.budgetUsd,
        prNumber,
      });
      if (budgetPlan !== null) {
        await settleCiAdmissionLedger(
          ciAdmissionLedger,
          "skipped",
          "estimated cost exceeds the configured CI budget ceiling",
        );
        return await publishCiSkip({
          operatorRoot,
          prNumber,
          post: options.post === true,
          isCi,
          stepSummaryFlag: options.stepSummary,
          plan: budgetPlan,
          noticeMessage:
            "pr-hero review skipped — estimated cost exceeds the configured CI budget ceiling",
        });
      }
    }
    const productionRoute = await resolveProductionRoutePlanAtConfirm({
      routingConfigured: config.routing !== undefined,
      workspaceRoot: worktreePath,
      buildRoutePlan: () =>
        buildCliRoutePlan({
          spec,
          options,
          agentFiles,
          routingConfig: config.routing,
          summary,
          summarizerEnabled: summary.enabled && !skipDiscovery,
          scoutEnabled: options.scout && !skipDiscovery,
        }),
    });
    const routePlan = productionRoute?.routePlan;
    const productionAdmission = productionRoute?.productionAdmission;
    const runnerAuthority = await resolveRunnerAuthority({
      workspaceRoot: worktreePath,
    });
    await enforceProviderCapabilityGate({
      routePlan,
      workspaceRoot: worktreePath,
      runnerAuthority,
      authorityOptions: productionAdmission?.authorityOptions,
      admissionRegistry: productionAdmission?.registry,
      productionEvidence: productionAdmission?.evidence,
    });
    // Same reason as local mode's planContext: the card and the confirm menu's
    // details view must describe one and the same planned run.
    const planContext: PrPlanContext = {
      options,
      operatorRoot,
      target,
      worktreePath,
      runDir,
      diffStat,
      agentsDir,
      agentFiles,
      spec,
      config,
      summary,
      estimate,
      hunterCount,
      sizeGate,
      droppedPaths: effectiveDiff.droppedPaths,
      configProvenance: configProvenanceOf(loaded, agentsDirSource),
      resolved: { baseSha, diffFromSha, diffPath, parityFires },
      ...(sizeGateConfirmed ? { sizeGateConfirmed: true } : {}),
      ...(queuedVerification > 0
        ? { verificationSteps: queuedVerification }
        : {}),
      ...(prepared.case === "A"
        ? {}
        : {
            rereview: {
              case: prepared.case,
              lastHead: prepared.last.L,
              discoveryRestricted: prepared.plan.discoveryRestricted,
              skipDiscovery,
            },
          }),
      ...(routePlan === undefined ? {} : { routePlan }),
    };
    for (const line of renderPrPlan(planContext, styleEnabled())) log(line);
    // What this run will actually publish. `options` is never mutated: the plan
    // card and the details view print what was ASKED FOR, and only the run
    // itself follows the answer given here.
    let postEnabled = options.post ?? false;
    if (!options.yes) {
      const choice = await confirm(
        estimate.low,
        estimate.high,
        options.post ?? false,
        () => prPlanDetails(planContext, styleEnabled()),
      );
      if (choice.kind === "cancel") {
        log("aborted; nothing was spent.");
        return 1;
      }
      postEnabled = choice.post;
      if (options.post && !postEnabled) {
        log("posting disabled for this run; the review still runs.");
      }
    }

    // Committed to spending: a pending commit status is the GitHub-visible
    // in-flight signal. Check Runs need a GitHub App; this CLI posts as the
    // operator via `gh`, so the write path is the Statuses API. Size-gate
    // abort and a declined confirm never reach here.
    const statusTargetUrl = prHtmlUrl(
      await ghRepoWebUrl(operatorRoot),
      prNumber,
    );
    await tryPublishCommitStatus(
      operatorRoot,
      headSha,
      commitStatusRequest({
        phase: "pending",
        posted: false,
        targetUrl: statusTargetUrl,
      }),
    );
    // From here the lock is HELD, and the only two ways out both clear it:
    // the finally below on the normal path, and the signal handlers in runCli
    // on the cancelled one. Held even if the publish above failed — a settle
    // for a status that was never posted is a harmless no-op write, whereas
    // skipping the hold on a publish that actually landed is the #162 bug.
    holdCommitStatusLock({
      operatorRoot,
      sha: headSha,
      targetUrl: statusTargetUrl,
    });

    let result: PipelineResult | undefined;
    let posted: InlinePostOutcome | null = null;
    try {
      // 8 — the review root.
      const worktree = await ensureWorktree(gitDirOwner, worktreePath, headSha);
      log();
      log(`worktree ${worktree.action}: ${worktreePath} (${worktree.reason})`);
      await stampWorktree(
        repoHome.paths.registry,
        prNumber,
        new Date().toISOString(),
      );

      // 9 — the worktree's own index. Never another checkout's: the ROADMAP
      // forbids riding a sibling's index, because its bytes may differ.
      let indexMs = 0;
      if (!existsSync(path.join(worktreePath, ".codegraph"))) {
        if (Bun.which("codegraph") === null) {
          log(
            "codegraph CLI not found — no index will be built; hunters run on " +
              "Read/Grep/Glob alone",
          );
        } else {
          indexMs = await initCodegraphIndex(worktreePath);
          log(`codegraph init: ${Math.round(indexMs / 1000)}s`);
        }
      }

      // 10 — MCP registry, checked against the WORKTREE. Local mode checks the
      // repo root because the repo root is what its hunters read; here the
      // hunters' tree is the worktree, and an index found in the operator
      // checkout would be exactly the other-checkout's index the step above
      // refuses to ride.
      const mcpConfigPath = path.join(runDir, "mcp.json");
      const codegraphAvailable = existsSync(
        path.join(worktreePath, ".codegraph"),
      );
      await writeMcpConfig(mcpConfigPath, codegraphAvailable);

      // 11 — run, with live progress (same shape as local mode's leg). The
      // pipeline is untouched beyond the observational tap: it gets the worktree
      // as its cwd and the PR's real number for the envelope.
      // Spec 2.1: "Progress updates MUST use GitHub Actions log workflow
      // groups (`::group::` / `::endgroup::`) to structure runner logs
      // cleanly." One group around the whole hunt+refute run is the minimum
      // that satisfies it. The arm and the close both live inside
      // withCiWorkflowGroup rather than at this call site, and EVERY
      // statement of the setup below sits inside its body: the progress
      // renderer and registerActiveRun (whose mkdirSync/writeFileSync are
      // unguarded) can throw on a read-only or full runner filesystem, and
      // anything armed-but-not-yet-guarded there folds the whole rest of the
      // job log — the `::error::` annotation naming the cause included —
      // into a group nothing ever closes.
      let started = 0;
      await withCiWorkflowGroup(isCi, "pr-hero review", log, async () => {
        log(reviewingLine(hunterCount, summary, options));
        // runnerAuthority resolved before confirm with the exact-binding gate.
        if (runnerAuthority.error !== undefined) {
          throw new CliError(
            `execution authority unavailable: ${runnerAuthority.error}`,
          );
        }
        // §5.3 D1-10b: one controller shared by the pipeline and the runner,
        // exactly as in local mode — the ceiling aborts it and the harness
        // reads the same signal.
        const ceilingController = new AbortController();
        let productionRuntime: ProductionRuntime | undefined;
        started = performance.now();
        const progress = startProgressRenderer(
          started,
          `PR #${prNumber}`,
          activeHunters.map((a) => a.key),
          spec.agents.some((a) => a.role === "refuter"),
          summary.enabled,
        );
        try {
          const prepared = await prepareRunnerForRoute({
            routePlan,
            productionAdmission,
            workspaceRoot: worktreePath,
            runnerAuthority,
            ceilingController,
            onProgress: progress.onProgress,
          });
          productionRuntime = prepared.productionRuntime;
          // registerActiveRun rides INSIDE this try, not before it: the
          // renderer is already ticking by now, and a throw here used to
          // leak its 250ms interval — which keeps the event loop alive and
          // hangs process exit, the exact failure the finally below exists
          // to prevent.
          await registerActiveRun({
            pid: process.pid,
            repo: repoHome.paths.repoId ?? path.basename(gitDirOwner),
            pr: prNumber,
            runDir,
            startedAt: new Date().toISOString(),
          });
          await settleCiAdmissionLedger(
            ciAdmissionLedger,
            "provider-started",
            "pipeline starting",
          );
          result = await runPipeline(
            {
              pr: prNumber,
              // Same rule as local mode: record the commit the diff was actually
              // computed against, or nothing downstream can reproduce the range.
              baseSha: diffFromSha,
              headSha,
              worktree: worktreePath,
              diffPath,
              excludedPaths: effectiveDiff.droppedPaths,
              exclusions: effectiveDiff.exclusions,
              ignoreFile: {
                readFrom: isCi ? "base-ref" : "working-tree",
                ...(isCi ? { ref: baseSha } : {}),
                found: prIgnore.found,
              },
              gotchasPath,
              agentsDir,
              ...(agents.files ? { agentFiles: agents.files } : {}),
              runDir,
              outPath: path.join(runDir, "findings.json"),
              mcpConfigPath,
              hopBudget: options.hopBudget,
              ...(options.model ? { model: options.model } : {}),
              parityTriggerPaths: config.parity_trigger_paths,
              suspicionPriors: config.suspicion_priors,
              ...(skipDiscovery ? {} : pipelineSummarizerInput(summary)),
              ...(skipDiscovery ? {} : pipelineScoutInput(options)),
              // NOT gated on skipDiscovery: an empty-delta re-review still
              // classifies and verifies against this config, and a run whose
              // artifact cannot name its config inputs is the unpoolable case
              // D7 exists to prevent — whether or not hunters fanned out.
              ...pipelineConfigInput(loaded),
              ...(routePlan === undefined ? {} : { routePlan }),
              engine: await engineIdentity(),
              promptSet,
              spec,
              ...(skipDiscovery ? { skipDiscovery: true } : {}),
              ...(rereview === undefined ? {} : { rereview }),
              ...(verifyQueue.length > 0 ? { verifyQueue } : {}),
              ...(overlapCandidates.length > 0 ? { overlapCandidates } : {}),
              maxVerificationSteps,
              ...(phaseB === undefined ? {} : { phaseB }),
            },
            prepared.deps,
          );
        } finally {
          // try/finally, never success-only: a leaked interval keeps the
          // event loop alive and hangs process exit on the error path.
          // `::endgroup::` is no longer emitted here — it rides
          // withCiWorkflowGroup's own finally, which wraps this whole block.
          progress.stop();
          await unregisterActiveRun(process.pid);
          if (productionRuntime !== undefined) {
            await productionRuntime.dispose();
          }
        }
      });
      if (result === undefined) {
        throw new CliError("internal: pipeline returned no result");
      }
      const wallMs = Math.round(performance.now() - started);

      // 12 — the artifact and the report, exactly as local mode writes them.
      // Unlike local mode's hardcoded 0, PR mode BUILDS the worktree's index
      // when it is missing, so the init cost is real and measured. Disk stays
      // unreported, and the mode is the same synchronous build.
      const telemetry: Telemetry = buildTelemetry(result, wallMs, indexMs);
      const doc = mergeRunEnvelope({
        skillOutput: result.skillOutput,
        pr: prNumber,
        base_sha: diffFromSha,
        head_sha: headSha,
        model: envelopeModel(options, agentFiles),
        iteration: 0,
        prompt_set: promptSet,
        engine: await engineIdentity(),
        sessionFailed: result.sessionFailed,
        telemetry,
      });
      const findingsPath = path.join(runDir, "findings.json");
      await writeFindings(findingsPath, doc);
      const reportPath = path.join(runDir, "report.md");
      await Bun.write(
        reportPath,
        renderReport(doc, {
          repo: path.basename(operatorRoot),
          base: target.baseRef,
          head: `PR #${prNumber}`,
          diffStat,
          excludedPaths: effectiveDiff.droppedPaths,
          costUsd: result.usage.cost_usd_est,
          ...notionalCostInput(result),
          wallMs,
        }),
      );

      // 13 — the head-to-head, in-process. A failure here must NOT fail the run:
      // the review artifacts above are already on disk and are the product, so a
      // gh hiccup degrades to a warning, never to an exit code. A run where
      // EVERY hunter died writes no comparison at all — "pr-hero 0" from a
      // review that never happened would land in B4's ledger as a measured
      // miss, and the ledger's honesty outranks the artifact's completeness.
      let comparison: ComparisonOutcome | null = null;
      if (result.sessionFailed) {
        log(
          "comparison skipped: every hunter failed, so there is no review to compare",
        );
      } else {
        try {
          comparison = await writeComparison({
            operatorRoot,
            pr: prNumber,
            headSha,
            diffFromSha,
            runDir,
            // The I/O shell owns the clock; the pure builder just records it.
            generatedAt: new Date().toISOString(),
            runStatus: doc.run_status,
            findings: doc.findings.map((f) => ({
              id: f.id,
              path: f.path,
              line: f.line,
              claim: f.claim,
              tier: f.tier,
            })),
          });
        } catch (error) {
          log(
            "warning: comparison against Greptile failed — the review itself is " +
              `intact: ${(error as Error).message}`,
          );
        }
      }

      // 13b — the observability store (W4 / #23). AFTER the comparison write,
      // BEFORE posting: reuses repoHome.repoId from step 2 (no second origin
      // lookup) and reads comparison.json back off disk — the artifact IS the
      // source of truth, so ingest never re-derives the bucketing itself.
      // Fail-soft, same contract as local mode: never turns a successful
      // review into a failed one.
      let storedComparison: StoredComparison | null = null;
      if (comparison) {
        try {
          storedComparison = parseComparisonJson(
            await Bun.file(comparison.jsonPath).text(),
          );
        } catch {
          // Degrades to a run row without comparison children; ingestRun
          // itself throwing is handled (and warned on) by failSoftIngest.
        }
      }
      // 13b — canonical product store & observability metrics.
      persistCanonicalReview({
        home,
        repoId: repoHome.repoId,
        runDir,
        checkoutPath: operatorRoot,
        doc,
        perAgent: result.perAgent,
        comparison: storedComparison,
        log,
      });
      ingestReviewMetrics({
        dbPath: prheroLayout(home).metricsDbPath,
        repoId: repoHome.repoId,
        runDir,
        checkoutPath: operatorRoot,
        doc,
        perAgent: result.perAgent,
        comparison: storedComparison,
        log,
      });

      // 14 — the posting, only when asked. AFTER the comparison on purpose: a
      // posting failure must never cost the comparison artifact. And unlike the
      // comparison, posting does NOT degrade to a warning — it was explicitly
      // requested. ROADMAP B6 rewire, W2 (issues #16/#17): posting now goes
      // through the inline surface — anchorability, cross-run matching, the one
      // review submission (with its 422 recovery into the summary Outside Diff
      // bucket), and the summary PATCHed LAST so its delta line and Outside Diff
      // section describe what this run actually posted, not what it planned to.
      // Un-anchorable findings never get a `POST .../issues/<n>/comments`.
      // `postInlineIfEligible` carries the
      // `sessionFailed` guard (design D6, spec "sessionFailed suppresses all
      // posting"): a clean-bill comment set from a review that never ran would
      // be a public lie, same reasoning as the comparison guard above.
      // Hoisted out of the branch below ONLY so step 15 can reuse it: when posting
      // ran, the terminal's links must be built from the SAME web url the comments
      // were published against, or a finding's comment fragment could hang off a
      // different host than the comment itself.
      let postedWebUrl: string | undefined;
      if (postEnabled) {
        postedWebUrl = await ghRepoWebUrl(operatorRoot);
        if (postedWebUrl === undefined) {
          log("repo web url unavailable: posting plain locations");
        }
        posted = await postInlineIfEligible({
          sessionFailed: result.sessionFailed,
          skippedReason:
            "post skipped: every hunter failed, so there is no review to publish",
          operatorRoot,
          pr: prNumber,
          headSha,
          doc,
          diffPatch: effectiveDiff.patch,
          webUrl: postedWebUrl,
          rereview,
          rereviewPriors: phaseB?.priors,
        });
        if (posted) {
          await writePostReceipt(runDir, prNumber, headSha, posted);
          log(
            `posted: review ${posted.reviewOutcome} (${posted.reviewFindingCount} ` +
              `finding(s)), ${posted.outsideDiffCount} outside diff, ` +
              `summary ${posted.summary.action} comment ${posted.summary.commentId}`,
          );
          // GitHub #39: said at the MOMENT it happened, not only in the result
          // block minutes of scrollback later — the same reason the 422
          // demotion below gets its own line here. The two can co-occur: a
          // force-push both moves the head and 422s the pinned submission.
          if (posted.movedHeadSha) {
            log(
              `warning: the PR head moved while the review ran — reviewed ` +
                `${headSha}, head is now ${posted.movedHeadSha}; the comments ` +
                "are pinned to the reviewed commit",
            );
          }
          if (posted.reviewOutcome === "demoted") {
            log(
              "warning: the review submission was rejected (422) and recovered " +
                "into the summary Outside Diff bucket — see the run's post.json " +
                "for detail",
            );
          }
        }
      }

      // 15 — the summary. One shared renderer with local mode; the mode-specific parts (comparison,
      // the worktree hint) ride in as optional inputs. The `posted:` line that
      // used to sit here is GONE on purpose: step 14 already printed a richer one
      // at the moment it happened, and two differently-worded reports of the same
      // POST read as two postings. What this block keeps is the durable trace —
      // post.json in the artifact list below.
      //
      // The links, in the order that keeps them honest: `gh`'s answer when posting
      // already paid for it, otherwise the free git-remote derivation — so a run
      // WITHOUT --post still prints a clickable url for every finding, which is
      // the whole reason repoWebUrlFromRemote exists. No pushed-ness check here
      // (unlike local mode): a PR head came out of `refs/pull/<n>/head`, so origin
      // has it by construction.
      const webUrl = postedWebUrl ?? (await gitRemoteWebUrl(operatorRoot));
      const links: ResultLinks | undefined =
        webUrl === undefined
          ? undefined
          : {
              webUrl,
              headSha,
              pr: prNumber,
              // Only when this run actually posted: a comment url for a comment
              // that does not exist is the dead link the whole degradation rule
              // exists to prevent. Absent ids fall through to a blob link.
              ...(posted ? { commentUrls: posted.commentUrls } : {}),
            };
      for (const line of renderResult({
        doc,
        costUsd: result.usage.cost_usd_est,
        ...notionalCostInput(result),
        wallMs,
        estimate: { low: estimate.low, high: estimate.high },
        runDir,
        artifacts: [
          path.basename(reportPath),
          path.basename(findingsPath),
          ...(comparison ? [path.basename(comparison.markdownPath)] : []),
          ...(posted ? ["post.json"] : []),
        ],
        ...(comparison
          ? {
              comparison: {
                greptileFound: comparison.greptileFound,
                // The buckets themselves, not their counts: writeComparison's
                // widened outcome is what lets the block name a recall miss.
                result: comparison.result,
              },
            }
          : {}),
        worktree: { gitDirOwner, worktreePath },
        ...(links === undefined ? {} : { links }),
        // GitHub #39. Only a run that actually POSTED can know this — the
        // re-read lives in the posting sequence — so a run without --post
        // never claims the head moved, which is correct: it published nothing
        // that could go stale.
        ...(posted?.movedHeadSha === undefined
          ? {}
          : { movedHeadSha: posted.movedHeadSha }),
        sessionFailed: result.sessionFailed,
        ...(result.unresolved.length > 0
          ? { unresolved: result.unresolved }
          : {}),
        styles: styleEnabled(),
      })) {
        log(line);
      }
      // 16 — CI headless publishing (ROADMAP Pillar 3): the "reviewed"
      // outcome's step summary + $GITHUB_OUTPUT, built from the SAME `doc`
      // renderResult just printed from above, so nothing here can disagree
      // with what the terminal (and the PR comments, via step 14's posted
      // outcome) already reported. `posted?.delta` reuses postInlineFindings'
      // own re-review delta — no separate computation.
      // The gate is shouldPublishCiReview, never a bare `isCi`: design D6's
      // "a failed session publishes nothing" binds this channel exactly as it
      // binds postInlineIfEligible above. See that predicate for why.
      if (shouldPublishCiReview(isCi, result.sessionFailed)) {
        const ciPlan = planCiReview({
          prNumber,
          headSha,
          findings: doc.findings,
          costUsdEst: result.usage.cost_usd_est,
          wallMs,
          model: envelopeModel(options, agentFiles),
          ...(webUrl === undefined ? {} : { repoWebUrl: webUrl }),
          ...(posted?.delta === undefined ? {} : { delta: posted.delta }),
          runDir,
        });
        const summaryPath = process.env.GITHUB_STEP_SUMMARY;
        if (shouldWriteStepSummary(isCi, options.stepSummary, summaryPath)) {
          await appendStepSummary(
            summaryPath as string,
            ciPlan.summaryMarkdown,
          );
        }
        const outputPath = process.env.GITHUB_OUTPUT;
        if (shouldWriteCiOutputs(isCi, outputPath)) {
          await appendCiOutputs(outputPath as string, ciPlan.outputs);
        }
        log(
          formatWorkflowCommand(
            "notice",
            `pr-hero review complete — ${ciPlan.outputs.findings_count} ` +
              `finding(s) (${ciPlan.outputs.blocking_count} blocking)`,
          ),
        );
      }
      if (result.sessionFailed) {
        await settleCiAdmissionLedger(
          ciAdmissionLedger,
          "failed",
          "every hunter failed",
        );
        return 1;
      }
      await settleCiAdmissionLedger(
        ciAdmissionLedger,
        "completed",
        "review complete",
      );
      // Assistant posture (spec 2.1): in CI mode, exit 0 even with blocking
      // findings — ciExitCode only fails on a fatal session failure (already
      // returned above) or a genuine posting drop (design D6). Outside CI,
      // postingExitCode keeps its existing behavior unchanged.
      return isCi
        ? ciExitCode({
            sessionFailed: result.sessionFailed,
            droppedFindingIds: posted?.droppedFindingIds.length ?? 0,
            blockingCount: doc.findings.filter((f) => f.tier === "blocking")
              .length,
          })
        : postingExitCode(posted);
    } finally {
      const phase = commitStatusCompletion({
        pipelineFinished: result !== undefined,
        sessionFailed: result?.sessionFailed === true,
      });
      await tryPublishCommitStatus(
        operatorRoot,
        headSha,
        commitStatusRequest({
          phase,
          posted: posted !== null,
          targetUrl: statusTargetUrl,
        }),
      );
      // Settled, so nothing is held: the signal handlers must never post a
      // second, contradicting status over the one just written. Released
      // immediately after the settle so no path through this finally — throw,
      // early return, or normal exit — can leave the lock standing.
      releaseCommitStatusLock();
      // Best-effort: the SIGTERM/SIGINT handlers settle the COMMIT STATUS
      // (holdCommitStatusLock above) but still cannot reach the ledger, which
      // has no equivalent hand-off. Any throw or early return that skipped
      // explicit settlement does land here.
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
  } finally {
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
    await releasePidLock(lockPath);
    await runGc({
      home,
      repoId: repoHome.repoId,
      dryRun: false,
      silent: true,
    });
  }
}
