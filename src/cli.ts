#!/usr/bin/env bun
// Local mode (ROADMAP B0): point the engine at a real repo + branch and get a
// human-readable review back. The lab drives this engine to MEASURE it; this
// is the other consumer — a developer, on their own tree, before the PR.
//
// The shape here is deliberate: every pure decision lives in preflight.ts and
// report.ts, and this file is the I/O shell — git, filesystem, stdin, spawn.
// That split is why the whole preflight can be tested offline, which matters
// more than usual when the alternative is testing it live at ~$10 a run.
//
// Two hard rules run through the sequence below:
//   1. every failure is loud and lands BEFORE any spend, and
//   2. human-readable output goes to stderr so stdout stays clean.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type AdmissionAttemptStatus,
  type AdmissionRecord,
  reserveAdmissionAttempt,
  settleAdmissionAttempt,
} from "#ci/admission-ledger";
import {
  type AdmissionContext,
  budgetDisabledWarningMessage,
  budgetUnlimitedNoticeMessage,
  type CiGateSkipPlan,
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
  reportFatalCiError,
  withCiWorkflowGroup,
} from "#ci/reporter";
import {
  type CiReviewPolicy,
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
import { activityCommand } from "#commands/activity";
import { ciSetupCommand } from "#commands/ci-setup";
import { configCommand } from "#commands/config";
import { doctorCommand } from "#commands/doctor";
import { init } from "#commands/init";
import { ledgerCommand } from "#commands/ledger";
import { mcpCommand } from "#commands/mcp";
import { postCommand } from "#commands/post";
import { triageCommand } from "#commands/triage";
import { uninstallCommand } from "#commands/uninstall";
import { upgradeCommand } from "#commands/upgrade";
import { usageCommand } from "#commands/usage";
import { parseComparisonJson, type StoredComparison } from "#compare/ledger";
import {
  type EffectiveConfig,
  ingestReviewMetrics,
  loadEffectiveConfig,
  notionalCostInput,
  persistCanonicalReview,
  pipelineConfigInput,
  resolveOptionalRepoRoot,
} from "#config/config";
import { corpusCommand } from "#corpus/corpus";
import {
  exclusionLines,
  git,
  gitCommitExists,
  gitIsAncestor,
  gitNameOnly,
  gitNameStatus,
  gitRemoteWebUrl,
  localResultLinks,
  readBaseRefIgnoreRules,
  resolveBase,
  resolveCommit,
  resolveDiffFrom,
  resolveRepoRoot,
} from "#git/git";
import { engineIdentity } from "#git/identity";
import {
  capabilityGateDecision,
  produceClaudeCapabilityReport,
} from "#model/provider-capabilities";
import {
  buildResolvedRoutePlan,
  type ResolvedRoutePlan,
  type RoutingConfig,
} from "#model/routing";
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
  postCommitStatus,
  postInlineIfEligible,
  postPrComment,
  upsertAdmissionCheckRun,
  writeComparison,
  writePostReceipt,
} from "#pr/pr";
import {
  CANCELLATION_COMMIT_STATUS_TIMEOUT_MS,
  commitStatusCompletion,
  commitStatusRequest,
  findMarkedCommentId,
  type HeldCommitStatusLock,
  isInFlightCommitStatus,
  prHtmlUrl,
  prRunDirCandidate,
  resolveCurrentPrNumber,
  resolvePrTarget,
  settleRequestForCancellation,
} from "#pr/preflight";
import { revertsCommand } from "#pr/reverts";
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
  DEFAULT_SCOUT_MODEL,
  type PipelineProgressEvent,
  type PipelineResult,
  parityTriggered,
  runPipeline,
} from "#review/pipeline";
import {
  AGENT_FILE_PATTERNS,
  type AgentsDirResolution,
  agentFilePath,
  agentsDirProblems,
  agentsDirSeat,
  allExcludedMessage,
  assertBasenameOnly,
  assertOutsideRepo,
  CliError,
  type CliOptions,
  CliUsageError,
  DEFAULT_HEAD_REF,
  DEFAULT_HOP_BUDGET,
  emptyDiffMessage,
  gotchasErrorMessage,
  gotchasUnusableReason,
  HELP_TEXT,
  isCiEnvironment,
  type LocalConfig,
  localReviewSpec,
  type NumstatDiffStat,
  type NumstatFile,
  parseArgs,
  parseNumstatFiles,
  resolveAgentsDirSetting,
  resolveMaxVerificationSteps,
  resolvePost,
  resolveScout,
  resolveSummary,
  runDirCandidate,
  type SummarySettings,
} from "#review/preflight";
import {
  type ParsedAgent,
  parseAgentFile,
  promptSetIdentity,
} from "#review/prompt-set";
import {
  type DiffStat,
  estimateCost,
  formatElapsed,
  renderReport,
} from "#review/report";
import {
  type ExcludedPath,
  effectiveDiffStat,
  evaluateSizeGate,
  evaluateSizeGateAggregate,
  filterDiffByIgnoreRules,
  type SizeGateConfig,
  type SizeGateVerdict,
  sizeGateConfig,
  sizeGateDisposition,
  sizeGateLine,
} from "#review/size-gate";
import { type ReviewSpec, validateReviewSpec } from "#review/spec";
import { ClaudeCodeRunner, killAllChildProcesses } from "#review/step-runner";
import { registerActiveRun, unregisterActiveRun } from "#store/activity";
import { gcCommand, runGc } from "#store/gc";
import {
  runConfigSubmenu,
  runLifecycleSubmenu,
  runMenuLoop,
  runWatcherSubmenu,
} from "#ui/menu";
import {
  type ConfigProvenance,
  configProvenanceOf,
  dryRunHunterCount,
  type PlanContext,
  type PrPlanContext,
  planDetails,
  prPlanDetails,
  renderPlan,
  renderPrPlan,
  scoutLabel,
  summarizerLabel,
} from "#ui/plan";

export {
  type ConfigProvenance,
  configProvenanceOf,
  dryRunHunterCount,
  type PlanContext,
  type PrPlanContext,
  planDetails,
  prPlanDetails,
  renderPlan,
  renderPrPlan,
};

import { log, styleEnabled, terminalWidth } from "#ui/primitives";
import { type ResultLinks, renderResult } from "#ui/result";
import { runReviewMenu } from "#ui/review-menu";
import { type ConfirmResult, confirmReview, confirmSizeGate } from "#ui/select";
// Pure decision module, not a shell — same category as pr/preflight.ts (see
// its own header comment). Reads the ALREADY-POSTED summary marker's head=
// declaration so the delta line's "since <sha>" clause is free (report.ts's
// PrCommentDelta.previousHeadSha), the exact reuse watch/preflight.ts's own
// header describes for the cross-machine guard.
import {
  markerCommentSeen,
  parsePrCommentMarker,
  parsePrFiles,
} from "#watch/preflight";
import { watchCommand } from "#watch/watch";
import { type EngineAssets, resolveEngineAssets } from "./assets";
import type { RunnerBackend } from "./execution/contracts";
import {
  acquirePidLock,
  releasePidLock,
  resolveRepoHome,
  stampWorktree,
  tryOriginRepoId,
} from "./home";
import {
  legacyMigrationHint,
  legacyWorktreePath,
  prheroLayout,
  prWorktreePath,
  worktreeLockPath,
} from "./home-preflight";
import { type IgnoreFileReadResult, readLocalIgnoreRules } from "./ignore-read";
import { resolveMenuContext } from "./menu-context";
import {
  createProductionRuntime,
  type ProductionAdmissionContext,
  type ProductionRuntime,
  prepareProductionAdmissionContext,
  probeBindingsReadiness,
} from "./production-runtime";
import {
  applyProgressEvent,
  createPanelState,
  renderPanelLines,
} from "./progress";
import {
  type RunnerAuthorityOptions,
  type RunnerAuthorityResolution,
  resolveRunnerAuthority,
} from "./runner-authority";
import { resolveOpenCodeAuthPath } from "./security/credential-broker";
import {
  admitRoutePlan,
  createDefaultTransportRegistry,
  type D1_11ReadinessEvidence,
  type TransportRegistry,
} from "./transport-registry";
import { isMachineOnboarded, runWizard } from "./wizard";

// The codegraph server, and ONLY the codegraph server. Written per run and
// handed to every step together with the runner's --strict-mcp-config: an
// agent's tool surface is a threat model, not a preference, and a registry
// the driver did not write is a channel it does not control.
const CODEGRAPH_ONLY_MCP_CONFIG = {
  mcpServers: {
    codegraph: {
      type: "stdio" as const,
      command: "codegraph",
      args: ["serve", "--mcp"],
    },
  },
};

export function pipelineSummarizerInput(
  summary: SummarySettings,
):
  | { summarizer: { promptPath: string; model?: string } }
  | Record<string, never> {
  return summary.enabled
    ? {
        summarizer: {
          promptPath: resolveEngineAssets().summarizerPromptPath,
          ...(summary.model === undefined ? {} : { model: summary.model }),
        },
      }
    : {};
}

// The scout's prompt is ENGINE-owned and lives outside the agents dir, on
// purpose and twice over (§3.7): a `review-scout.md` dropped in the agents dir
// without a spec entry is a hard CliError, and a new prompt-set directory
// holding byte-identical hunter files would be a new fingerprint — which is
// exactly the one-variable property M6 needs to be true by construction rather
// than argued. `prompts/` is the door the summarizer already walked through.
export function pipelineScoutInput(
  options: Pick<CliOptions, "scout" | "scoutModel">,
): { scout: { promptPath: string; model?: string } } | Record<string, never> {
  return options.scout
    ? {
        scout: {
          promptPath: resolveEngineAssets().scoutPromptPath,
          ...(options.scoutModel === undefined
            ? {}
            : { model: options.scoutModel }),
        },
      }
    : {};
}

async function buildCliRoutePlan(params: {
  spec: ReviewSpec;
  options: CliOptions;
  agentFiles: Map<string, ParsedAgent>;
  routingConfig?: RoutingConfig;
  summary: SummarySettings;
  summarizerEnabled?: boolean;
  scoutEnabled?: boolean;
}): Promise<ResolvedRoutePlan> {
  const summarizerEnabled = params.summarizerEnabled ?? params.summary.enabled;
  const scoutEnabled = params.scoutEnabled ?? params.options.scout;
  let summarizerFrontmatter: string | undefined;
  if (summarizerEnabled) {
    try {
      const parsed = await parseAgentFile(
        resolveEngineAssets().summarizerPromptPath,
      );
      summarizerFrontmatter = parsed.model;
    } catch {
      // Engine-owned prompt may be unreadable in tests; route resolution still
      // falls through CLI > spec > frontmatter precedence without it.
    }
  }
  let scoutFrontmatter: string | undefined;
  if (scoutEnabled) {
    try {
      const parsed = await parseAgentFile(
        resolveEngineAssets().scoutPromptPath,
      );
      scoutFrontmatter = parsed.model;
    } catch {
      // Same contract as the summarizer branch above.
    }
  }
  return buildResolvedRoutePlan({
    agents: params.spec.agents,
    cliModel: params.options.model,
    routingConfig: params.routingConfig,
    frontmatterModel: (agentKey) => params.agentFiles.get(agentKey)?.model,
    ...(summarizerEnabled
      ? {
          summarizer: {
            model: params.summary.model,
            frontmatterModel: summarizerFrontmatter,
          },
        }
      : {}),
    ...(scoutEnabled
      ? {
          scout: {
            model: params.options.scoutModel,
            frontmatterModel: scoutFrontmatter,
            defaultModel: DEFAULT_SCOUT_MODEL,
          },
        }
      : {}),
  });
}

// Pre-confirm route resolution: legacy runs without operator routing may omit
// route provenance when the plan cannot be built, but admission failures must
// always surface before confirm — never be swallowed into routePlan = undefined.
export async function resolveRoutePlanAtConfirm(input: {
  routingConfigured: boolean;
  buildRoutePlan: () => Promise<ResolvedRoutePlan>;
  registry?: TransportRegistry;
}): Promise<ResolvedRoutePlan | undefined> {
  const registry =
    input.registry ?? createDefaultTransportRegistry({ mode: "production" });
  let routePlan: ResolvedRoutePlan;
  try {
    routePlan = await input.buildRoutePlan();
  } catch (error) {
    if (input.routingConfigured) throw error;
    return undefined;
  }
  await admitRoutePlan(routePlan, registry);
  return routePlan;
}

export interface ProductionRoutePlanResult {
  readonly routePlan: ResolvedRoutePlan;
  readonly productionAdmission: ProductionAdmissionContext;
}

// Production admission: discover per-backend executable authority, derive
// D1-11 evidence from exact-binding probes, and admit with one shared registry.
export async function resolveProductionRoutePlanAtConfirm(input: {
  routingConfigured: boolean;
  workspaceRoot: string;
  buildRoutePlan: () => Promise<ResolvedRoutePlan>;
  authorityDeps?: import("./runner-authority").ResolveRunnerAuthorityDeps;
  loadSdk?: () => Promise<
    import("./transports/opencode-client").OpenCodeSdkLike
  >;
  env?: import("./runner-authority").RunnerAuthorityOptions["env"];
}): Promise<ProductionRoutePlanResult | undefined> {
  let routePlan: ResolvedRoutePlan;
  try {
    routePlan = await input.buildRoutePlan();
  } catch (error) {
    if (input.routingConfigured) throw error;
    return undefined;
  }

  const productionAdmission = await prepareProductionAdmissionContext({
    workspaceRoot: input.workspaceRoot,
    plan: routePlan,
    authorityDeps: input.authorityDeps,
    loadSdk: input.loadSdk,
    env: input.env,
  });
  if ("error" in productionAdmission) {
    throw new CliError(
      `production admission failed: ${productionAdmission.error}`,
    );
  }
  await admitRoutePlan(routePlan, productionAdmission.registry, {
    mode: "production",
    evidence: productionAdmission.evidence,
  });
  return { routePlan, productionAdmission };
}

async function enforceProviderCapabilityGate(input: {
  routePlan: ResolvedRoutePlan | undefined;
  workspaceRoot: string;
  runnerAuthority?: RunnerAuthorityResolution;
  authorityOptions?: RunnerAuthorityOptions;
  admissionRegistry?: TransportRegistry;
  productionEvidence?: Map<RunnerBackend, D1_11ReadinessEvidence>;
}): Promise<void> {
  if (input.routePlan === undefined) {
    if (input.runnerAuthority?.error !== undefined) {
      throw new CliError(
        `execution authority unavailable: ${input.runnerAuthority.error}`,
      );
    }
    const capabilityReport = await produceClaudeCapabilityReport({});
    const capabilityGate = capabilityGateDecision(capabilityReport);
    if (!capabilityGate.ok) {
      throw new CliError(
        `provider capability gate failed: ${capabilityGate.reason}`,
      );
    }
    return;
  }
  const authorityOptions =
    input.authorityOptions ??
    (input.runnerAuthority?.error !== undefined
      ? undefined
      : {
          workspaceRoot: input.workspaceRoot,
          binaryPath: input.runnerAuthority?.runnerOptions.binaryPath,
          executableAllowlists: {
            "claude-code":
              input.runnerAuthority?.runnerOptions.executableAllowlist ?? [],
          },
        });
  if (authorityOptions === undefined) {
    throw new CliError(
      `execution authority unavailable: ${input.runnerAuthority?.error ?? "missing production authority options"}`,
    );
  }
  const probe = await probeBindingsReadiness({
    ...authorityOptions,
    plan: input.routePlan,
    workspaceRoot: input.workspaceRoot,
    registry: input.admissionRegistry,
    mode: "production",
    evidence: input.productionEvidence,
  });
  if (!probe.decision.ok) {
    await probe.dispose();
    throw new CliError(
      `provider capability gate failed: ${probe.decision.reason}`,
    );
  }
  await probe.dispose();
}

const EMPTY_MCP_CONFIG = { mcpServers: {} };

// bin/pr-hero.js and the `import.meta.main` guard both go through the exported
// runCli() below, which is this function's only production caller. It is
// exported all the same because cli.test.ts drives it directly — a test IS a
// real consumer (project rule 3), and it is the only way to prove the two
// internal catches below write `status=error` without spawning a subprocess
// and guessing at its exit code.
export async function main(argv: string[]): Promise<number> {
  // Bare zero-argument entry
  if (argv.length === 0) {
    if (process.env.PRHERO_NO_TUI !== undefined) {
      log(HELP_TEXT);
      return 0;
    }
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      log(HELP_TEXT);
      log();
      log("error: no command given (interactive TTY required for menu)");
      return 2;
    }
    if (terminalWidth() < 24) {
      log("terminal too narrow (width < 24 columns)");
      log();
      log(HELP_TEXT);
      return 2;
    }
    if (!isMachineOnboarded()) {
      return await runWizard();
    }
    return await menuCommand({
      repo: ".",
      head: DEFAULT_HEAD_REF,
      hopBudget: DEFAULT_HOP_BUDGET,
      scout: false,
      full: false,
      dryRun: false,
      yes: false,
      post: false,
      twoDot: false,
      onPush: false,
      force: false,
      all: false,
      fixes: false,
      incidents: false,
      issues: false,
      proximity: false,
      threads: false,
    });
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    log(HELP_TEXT);
    log();
    log(`error: ${(error as Error).message}`);
    await reportFatalCiErrorIfInJobStep(error);
    return 2;
  }
  if (parsed.command === "help") {
    log(HELP_TEXT);
    return 0;
  }
  if (parsed.command === "menu") {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      log(HELP_TEXT);
      log();
      log("error: interactive TTY required for menu");
      return 2;
    }
    if (terminalWidth() < 24) {
      log("terminal too narrow (width < 24 columns)");
      log();
      log(HELP_TEXT);
      return 2;
    }
    return await menuCommand(parsed.options);
  }
  try {
    return parsed.command === "init"
      ? await init(parsed.options)
      : parsed.command === "setup"
        ? parsed.options.ci
          ? await ciSetupCommand(parsed.options)
          : await runWizard({
              cwd:
                (await resolveOptionalRepoRoot(parsed.options)) ??
                process.cwd(),
            })
        : parsed.command === "ci"
          ? await ciSetupCommand(parsed.options)
          : parsed.command === "doctor"
            ? await doctorCommand(parsed.options)
            : parsed.command === "activity"
              ? await activityCommand(parsed.options)
              : parsed.command === "ledger"
                ? await ledgerCommand(parsed.options)
                : parsed.command === "watch"
                  ? await watchCommand(parsed.options)
                  : parsed.command === "post"
                    ? await postCommand(parsed.options)
                    : parsed.command === "triage"
                      ? await triageCommand(parsed.options)
                      : parsed.command === "gc"
                        ? await gcCommand(parsed.options)
                        : parsed.command === "usage"
                          ? await usageCommand(parsed.options)
                          : parsed.command === "reverts"
                            ? await revertsCommand(parsed.options)
                            : parsed.command === "corpus"
                              ? await corpusCommand(parsed.options)
                              : parsed.command === "config"
                                ? await configCommand(parsed.options)
                                : parsed.command === "mcp"
                                  ? await mcpCommand(parsed.options)
                                  : parsed.command === "upgrade"
                                    ? await upgradeCommand(parsed.options)
                                    : parsed.command === "uninstall"
                                      ? await uninstallCommand(parsed.options)
                                      : await review(parsed.options);
  } catch (error) {
    if (error instanceof CliError || error instanceof CliUsageError) {
      log(`error: ${error.message}`);
      await reportFatalCiErrorIfInJobStep(error);
      return 1;
    }
    throw error;
  }
}

async function review(options: CliOptions): Promise<number> {
  // PR mode is a different front half (gh-resolved range, detached worktree)
  // around the same pipeline; it branches here so the local flow below stays
  // byte-for-byte what B0 shipped.
  if (options.pr !== undefined) return reviewPr(options, options.pr);

  // 1 — the repo.
  const repoRoot = await resolveRepoRoot(options.repo);

  // 2 — the config, read BEFORE anything that consumes it. It now carries
  // agents_dir and default_base, so both the prompt set and the base ref
  // depend on it; loading it later would mean resolving them against a config
  // that had not been read yet.
  //
  // Two layers since C5, folded by loadEffectiveConfig into the one
  // LocalConfig everything below already expected. The --config missing-file
  // error and the boundary rules live there.
  const loaded = await loadEffectiveConfig({
    root: repoRoot,
    home: os.homedir(),
    configFlag: options.config,
  });
  const config = loaded.effective;
  const summary = resolveSummary(options, config);
  const scout = resolveScout(options, config);
  const post = resolvePost(options, config);
  options = { ...options, scout, post };

  // 3 — the base ref, then the canonical refs and the range.
  const baseRef = await resolveBase(repoRoot, options, config);
  const baseSha = await resolveCommit(repoRoot, baseRef.ref);
  const headSha = await resolveCommit(repoRoot, options.head);
  if (baseSha === headSha) {
    throw new CliError(
      `base and head resolve to the same commit (${headSha}); there is ` +
        "nothing to review",
    );
  }
  const diffFromSha = await resolveDiffFrom(
    repoRoot,
    options.twoDot,
    baseRef.ref,
    options.head,
    baseSha,
    headSha,
  );

  // 4 — the tree the hunters will actually read.
  // Every spawned step runs with repoRoot as its cwd, so the bytes under
  // review are the WORKING TREE, not the commit. A dirty tree, or a checkout
  // sitting on a different commit than --head, means the report describes one
  // thing and the hunters read another — and nothing downstream can detect it.
  const status = await git(repoRoot, ["status", "--porcelain"]);
  if (!status.ok) throw new CliError(`git status failed: ${status.stderr}`);
  if (status.stdout.trim().length > 0) {
    throw new CliError(
      "the working tree is dirty. Every review step reads this checkout " +
        "directly, so uncommitted changes would be reviewed but never " +
        "reported. Commit or stash them first:\n" +
        `${status.stdout.trimEnd()}`,
    );
  }
  const checkedOut = await resolveCommit(repoRoot, "HEAD");
  if (checkedOut !== headSha) {
    throw new CliError(
      `HEAD is ${checkedOut} but --head resolves to ${headSha}. The steps ` +
        "read the checkout, so review the commit that is checked out (or " +
        "check out the one you want reviewed).",
    );
  }

  // 5 + 6 — the prompt set and the wiring that consumes it.
  // The WHOLE resolution, not just its dir: under the compiled binary the
  // prompt set is a map of embedded paths and `dir` is only a display label.
  const agents = resolveAgentsDir(options, loaded);
  const { dir: agentsDir, source: agentsDirSource } = agents;
  const spec = validateReviewSpec(localReviewSpec());
  spec.agents.forEach((agent, i) => {
    assertBasenameOnly(agent.file, i);
  });
  await preflightAgentsDir(
    agents,
    spec.agents.map((a) => a.file),
  );
  const agentFiles = new Map<string, ParsedAgent>();
  for (const agent of spec.agents) {
    // Parsing every agent file now is a preflight too: a malformed
    // frontmatter block must fail here, not three spawned steps later.
    agentFiles.set(
      agent.key,
      await parseAgentFile(agentFilePath(agents, agent.file)),
    );
  }

  // The prompt set's identity (§3.9), computed from the spec's DECLARATION
  // order — the same order the lab's promptSetFingerprint hashes in, so the
  // two sides produce the same string for the same bytes. It is what turns
  // M6's central claim, "both arms ran the same prompt set", from something
  // believed into something recorded, and it fills the `prompt_set` seat
  // review/findings.ts has declared and never populated.
  const promptSet = await promptSetIdentity(
    agentsDir,
    // spec DECLARATION order, and it must stay that: promptSetFingerprint
    // hashes the concatenated texts in the order it is handed, and
    // `prompt_set.sha256` is compared across runs by an external consumer.
    // Reading the list off the bundled map's keys instead would move every
    // fingerprint ever recorded, silently — the digest still looks valid.
    spec.agents.map((a) => agentFilePath(agents, a.file)),
    // A bundled set has no directory basename to be named after. "default" is
    // what dev and npm derive from prompts/default, so the same prompt set
    // names itself identically in all three runtimes.
    agents.kind === "bundled" ? "default" : undefined,
  );

  // 7 — gotchas. Checked HERE rather than left to the pipeline's fail-loud
  // abort: the pipeline is right to refuse, but all it can return is a
  // zero-cost partial run, which reads like a clean review to a human.
  //
  // `--gotchas` exists because requiring the file INSIDE the reviewed tree
  // makes two legitimate cases impossible: reviewing a historical commit (the
  // file would be an untracked addition, and the clean-tree gate rightly
  // refuses), and reviewing a repo you do not control. The gotchas describe
  // the repo, not the commit, so they do not belong to the checkout.
  const gotchasPath = options.gotchas
    ? path.resolve(options.gotchas)
    : path.join(repoRoot, ".prhero", "gotchas.md");
  const gotchasFile = Bun.file(gotchasPath);
  const gotchas = (await gotchasFile.exists()) ? await gotchasFile.text() : "";
  const gotchasUnusable = gotchasUnusableReason(gotchas);
  if (gotchasUnusable !== undefined) {
    throw new CliError(gotchasErrorMessage(gotchasPath, gotchasUnusable));
  }

  // 7.5 — `.prheroignore`, read from the WORKING TREE. Local review has no
  // PR-author trust boundary to defend (there is no "someone else's commit"
  // here — repoRoot is the operator's own checkout), so it is read from
  // exactly the tree the diff below comes from, the same way gotchas.md just
  // was.
  const userIgnore = await readLocalIgnoreRules(repoRoot);

  // 8 — run dir + diff.
  const { runDir, repoId } = await createRunDir(options, repoRoot, headSha);
  const diffPath = path.join(runDir, "diff.patch");
  // diffFromSha, never baseSha: see resolveDiffFrom. The numstat below uses
  // the same endpoint on purpose — a cost estimate computed over a wider range
  // than the one being reviewed is a bill that arrives from nowhere.
  const diff = await git(repoRoot, ["diff", `${diffFromSha}..${headSha}`]);
  if (!diff.ok) throw new CliError(`git diff failed: ${diff.stderr}`);
  if (diff.stdout.trim().length === 0) {
    throw new CliError(
      emptyDiffMessage(baseRef.ref, options.head, options.twoDot),
    );
  }
  // The EFFECTIVE diff is what lands in diff.patch, because diff.patch is
  // what the pipeline hands to every hunter: excluded files must fall out of
  // the reviewed diff itself, or the gate discounts a lockfile the bill still
  // pays for in full (see filterDiffByIgnoreRules). diff.raw.patch keeps the
  // unfiltered bytes for audit, and only when there is a difference to audit.
  const gateConfig = sizeGateConfig(
    options,
    loaded.effective,
    userIgnore.rules,
  );
  const effectiveDiff = filterDiffByIgnoreRules(
    diff.stdout,
    gateConfig.excludeRules,
  );
  if (effectiveDiff.patch.trim().length === 0) {
    throw new CliError(allExcludedMessage(effectiveDiff.droppedPaths));
  }
  await Bun.write(diffPath, effectiveDiff.patch);
  if (effectiveDiff.droppedPaths.length > 0) {
    await Bun.write(path.join(runDir, "diff.raw.patch"), diff.stdout);
  }

  // 9 — diff stat, TWICE and on purpose.
  //
  // The GATE counts from `-w --ignore-blank-lines`: a pure formatter sweep
  // must not consume the budget, and a file whose every change is whitespace
  // drops out of that numstat entirely (verified: git emits no row for it).
  //
  // The COST BAND counts from the plain numstat, exclusions applied. The
  // hunters are handed diff.patch verbatim, whitespace hunks included, so
  // those bytes are genuinely billed — pricing them at zero would be the same
  // class of lie the exclusion bug was.
  const numstat = await git(repoRoot, [
    "diff",
    "--numstat",
    `${diffFromSha}..${headSha}`,
  ]);
  if (!numstat.ok) {
    throw new CliError(`git diff --numstat failed: ${numstat.stderr}`);
  }
  const gateNumstat = await git(repoRoot, [
    "diff",
    "-w",
    "--ignore-blank-lines",
    "--numstat",
    `${diffFromSha}..${headSha}`,
  ]);
  if (!gateNumstat.ok) {
    throw new CliError(`git diff -w --numstat failed: ${gateNumstat.stderr}`);
  }
  const diffStat: DiffStat = effectiveDiffStat(
    parseNumstatFiles(numstat.stdout),
    gateConfig.excludeRules,
  );
  const sizeGate = evaluateSizeGate(
    parseNumstatFiles(gateNumstat.stdout),
    gateConfig,
  );

  // 10 — MCP registry.
  const mcpConfigPath = path.join(runDir, "mcp.json");
  const codegraphAvailable = existsSync(path.join(repoRoot, ".codegraph"));
  await Bun.write(
    mcpConfigPath,
    `${JSON.stringify(
      codegraphAvailable ? CODEGRAPH_ONLY_MCP_CONFIG : EMPTY_MCP_CONFIG,
      null,
      2,
    )}\n`,
  );

  // 11 — the plan. Triggers read the EFFECTIVE diff, the same bytes the
  // pipeline will read back from diff.patch: a conditional hunter must never
  // fire on a path no hunter was given.
  const changedPaths = changedPathsFromDiff(effectiveDiff.patch);
  const parityFires = parityTriggered(
    changedPaths,
    config.parity_trigger_paths,
  );
  const activeHunters = spec.agents.filter(
    (a) => a.role === "hunter" && (a.trigger === undefined || parityFires),
  );
  const hunterCount = activeHunters.length;
  const estimate = estimateCost(
    diffStat,
    hunterCount,
    summary.enabled,
    options.scout,
  );
  const productionRoute = await resolveProductionRoutePlanAtConfirm({
    routingConfigured: config.routing !== undefined,
    workspaceRoot: repoRoot,
    buildRoutePlan: () =>
      buildCliRoutePlan({
        spec,
        options,
        agentFiles,
        routingConfig: config.routing,
        summary,
      }),
  });
  const routePlan = productionRoute?.routePlan;
  const productionAdmission = productionRoute?.productionAdmission;
  // Named rather than inlined into renderPlan: the same context is what the
  // confirm menu's "Show details" renders, and building it twice would risk
  // the card and the details view disagreeing about the run they describe.
  const planContext: PlanContext = {
    options,
    repoRoot,
    baseRef,
    baseSha,
    diffFromSha,
    headSha,
    diffStat,
    diffPath,
    agentsDir,
    agentFiles,
    spec,
    runDir,
    config,
    summary,
    parityFires,
    codegraphAvailable,
    estimate,
    hunterCount,
    // Evaluated above (step 9) and ENFORCED below at step 13, unchanged;
    // the plan only prints the verdict, last, where the decision is made.
    sizeGate,
    droppedPaths: effectiveDiff.droppedPaths,
    configProvenance: configProvenanceOf(loaded, agentsDirSource),
    ...(routePlan === undefined ? {} : { routePlan }),
  };
  for (const line of renderPlan(planContext, styleEnabled())) log(line);

  // 12 — the free exit. Dry run reports the gate verdict (including that it
  // WOULD skip) and still exits 0: its contract is "everything except
  // spawn", and a $0 report is never a failure.
  if (options.dryRun) {
    log();
    if (!sizeGate.ok && !options.force) {
      log("dry run: this diff would be SKIPPED by the size gate (exit 1).");
    }
    log("dry run: nothing was spawned and nothing was spent.");
    return 0;
  }

  // 12.5 — the capability gate (§11/D1-09): routed runs gate exact-binding
  // readiness for the bindings that would execute; legacy runs keep the
  // claude-code ProviderCapabilityReport path byte-compatible.
  const runnerAuthority = await resolveRunnerAuthority({
    workspaceRoot: repoRoot,
  });
  await enforceProviderCapabilityGate({
    routePlan,
    workspaceRoot: repoRoot,
    runnerAuthority,
    authorityOptions: productionAdmission?.authorityOptions,
    admissionRegistry: productionAdmission?.registry,
    productionEvidence: productionAdmission?.evidence,
  });

  // 13 — the size gate, BEFORE the cost band's confirm() for the unattended
  // path. The watcher spawns with --yes, so a gate that lived only inside
  // that confirmation would never fire in the one place — unattended spend
  // — it exists to protect. An interactive TTY is offered Continue/Cancel
  // instead of dying: --force stays the unattended hatch, not the only one.
  const sizeGateChoice = await applySizeGate(sizeGate, options);
  if (sizeGateChoice === "abort") return 1;

  // 14 — the paid one. Local mode can never post (parseArgs rejects --post
  // without --pr), so the "don't post" option is not offered and the choice's
  // `post` field carries nothing local mode could act on.
  if (!options.yes) {
    const choice = await confirm(estimate.low, estimate.high, false, () =>
      planDetails(planContext, styleEnabled()),
    );
    if (choice.kind === "cancel") {
      log("aborted; nothing was spent.");
      return 1;
    }
  }

  // 15 — run, with live progress: the expectation line up front, then one
  // stderr line per pipeline event (plus a TTY heartbeat between them).
  log(
    `reviewing — ${hunterCount} hunter${hunterCount === 1 ? "" : "s"} + ` +
      `refuter ${summarizerLabel(summary)}${scoutLabel(options)}; ` +
      "comparable trees have taken " +
      "8–25 minutes",
  );
  const started = performance.now();
  const progress = startProgressRenderer(
    started,
    `${baseRef.ref}..${options.head}`,
    activeHunters.map((a) => a.key),
    spec.agents.some((a) => a.role === "refuter"),
    summary.enabled,
  );
  let result: PipelineResult;
  await registerActiveRun({
    pid: process.pid,
    repo: repoId ?? path.basename(repoRoot),
    runDir,
    startedAt: new Date().toISOString(),
  });
  // §5.3 D1-10b: ONE controller shared by the pipeline and the runner. The
  // pipeline aborts it when the ceiling fires; the runner's harness reads the
  // same signal and refuses to start another attempt. Two controllers would
  // leave the ceiling unable to stop the steps it is waiting on.
  const ceilingController = new AbortController();
  let productionRuntime: ProductionRuntime | undefined;
  try {
    if (routePlan !== undefined && productionAdmission !== undefined) {
      productionRuntime = await createProductionRuntime({
        ...productionAdmission.authorityOptions,
        plan: routePlan,
        workspaceRoot: repoRoot,
        registry: productionAdmission.registry,
        evidence: productionAdmission.evidence,
        // #182 follow-up: without this the admission may decide free-server
        // while the bindings stay metered, and the runtime's own guard
        // refuses the divergence — both or neither.
        ...(productionAdmission.freeModelProbe === undefined
          ? {}
          : { freeModelProbe: productionAdmission.freeModelProbe }),
        mode: "production",
        signal: ceilingController.signal,
      });
    }
    result = await runPipeline(
      {
        // Local mode has no PR number. 0 is the schema-legal "not a PR" value
        // the fixture eval already uses.
        pr: 0,
        // The commit the diff was actually computed against, not the tip of the
        // base branch: the recorded base_sha must name the range that was
        // reviewed, or nothing downstream can reproduce it.
        baseSha: diffFromSha,
        headSha,
        worktree: repoRoot,
        diffPath,
        excludedPaths: effectiveDiff.droppedPaths,
        exclusions: effectiveDiff.exclusions,
        ignoreFile: { readFrom: "working-tree", found: userIgnore.found },
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
        ...pipelineSummarizerInput(summary),
        ...pipelineScoutInput(options),
        ...pipelineConfigInput(loaded),
        ...(routePlan === undefined ? {} : { routePlan }),
        engine: await engineIdentity(),
        promptSet,
        spec,
      },
      {
        runner:
          productionRuntime !== undefined
            ? productionRuntime.runner
            : new ClaudeCodeRunner({
                ...runnerAuthority.runnerOptions,
                signal: ceilingController.signal,
              }),
        ...(productionRuntime !== undefined
          ? {
              transportRegistry: productionRuntime.registry,
              ...(productionRuntime.evidence === undefined
                ? {}
                : { admissionEvidence: productionRuntime.evidence }),
            }
          : {}),
        ceilingController,
        onProgress: progress.onProgress,
      },
    );
  } finally {
    // try/finally, never success-only: a leaked interval keeps the event
    // loop alive and hangs process exit on the error path.
    progress.stop();
    await unregisterActiveRun(process.pid);
    if (productionRuntime !== undefined) {
      await productionRuntime.dispose();
    }
  }
  const wallMs = Math.round(performance.now() - started);

  // 16 — the artifact.
  const telemetry: Telemetry = {
    // Local mode neither builds nor syncs a codegraph index: it consumes
    // whatever the repo already has, so there is no index cost to report.
    index_ms: 0,
    index_mode: "sync",
    index_disk_mb: 0,
    // Driver-MEASURED elapsed time, never the sum of the steps: hunters run
    // in parallel, so summing their wall clocks reports a number the run
    // never took — and this engine exists to be compared on time and cost.
    wall_ms: wallMs,
    tokens_in: result.usage.tokens_in,
    tokens_out: result.usage.tokens_out,
    tokens_total: result.usage.tokens_total,
    cost_usd_est: result.usage.cost_usd_est,
    ...(result.unresolved.length > 0 ? { cost_usd_est_is_floor: true } : {}),
    per_agent: result.perAgent,
  };
  const doc = mergeRunEnvelope({
    skillOutput: result.skillOutput,
    pr: 0,
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

  // 16b — canonical product store & observability metrics.
  persistCanonicalReview({
    repoId,
    runDir,
    checkoutPath: repoRoot,
    doc,
    perAgent: result.perAgent,
    comparison: null,
    log,
  });
  ingestReviewMetrics({
    dbPath: prheroLayout(os.homedir()).metricsDbPath,
    repoId,
    runDir,
    checkoutPath: repoRoot,
    doc,
    perAgent: result.perAgent,
    comparison: null,
    log,
  });

  // 17 — the report.
  const reportPath = path.join(runDir, "report.md");
  await Bun.write(
    reportPath,
    renderReport(doc, {
      repo: path.basename(repoRoot),
      base: baseRef.ref,
      head: options.head,
      diffStat,
      excludedPaths: effectiveDiff.droppedPaths,
      costUsd: result.usage.cost_usd_est,
      ...notionalCostInput(result),
      wallMs,
    }),
  );

  // 18 — the summary. Counts, the FINDINGS THEMSELVES, where the artifacts
  // landed, and a clickable url per finding: the renderer derives every number
  // from `doc`, so the terminal cannot disagree with the findings.json written
  // two steps up. Links are best-effort and silent when unavailable (no github
  // remote, or a head this repo has not pushed) — see localResultLinks.
  const links = await localResultLinks(repoRoot, headSha);
  for (const line of renderResult({
    doc,
    costUsd: result.usage.cost_usd_est,
    ...notionalCostInput(result),
    wallMs,
    estimate: { low: estimate.low, high: estimate.high },
    runDir,
    artifacts: [path.basename(reportPath), path.basename(findingsPath)],
    ...(links === undefined ? {} : { links }),
    sessionFailed: result.sessionFailed,
    ...(result.unresolved.length > 0 ? { unresolved: result.unresolved } : {}),
    styles: styleEnabled(),
  })) {
    log(line);
  }
  if (result.sessionFailed) return 1;
  return 0;
}

// PR mode (ROADMAP B1): one command from a PR number to a reviewed range, a
// detached worktree, a pipeline run, and a Greptile comparison.
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

// WHY this module-level state exists (paid for on PR #162, 2026-09-01): a run
// cancelled by the workflow's `cancel-in-progress` concurrency group posted its
// pending on the head it was legitimately reviewing and then never settled it,
// because the SIGTERM/SIGINT handlers end in `process.exit()` — which skips
// reviewPr's `finally`. The next run read that pending back through
// isInFlightCommitStatus, saw a lock younger than the 90-minute TTL, and
// skipped: PR #162 went unreviewed while the `review` job still reported
// success.
//
// The lock cannot tell "another process is working" from "a dead process left
// this behind" — it is a cross-machine TOCTOU guard, not a liveness probe. So
// the fix is on the holder's side: the process that took the lock releases it
// on the way out. This closes the CANCELLATION case, which is by far the most
// common one, because `cancel-in-progress: true` on a head-ref concurrency
// group fires on EVERY push, not only a force-push. A runner that dies with no
// signal at all (hard kill, OOM, a dropped machine) still reaches nothing here
// and remains covered only by the TTL.
//
// Module state, and the same precedent as `unregisterActiveRun(process.pid)`:
// a signal handler installed in runCli cannot see reviewPr's scope, so what it
// needs has to be parked where both can reach it.
let heldLock: HeldCommitStatusLock | null = null;

export function holdCommitStatusLock(lock: HeldCommitStatusLock): void {
  heldLock = lock;
}

export function releaseCommitStatusLock(): void {
  heldLock = null;
}

export function heldCommitStatusLock(): HeldCommitStatusLock | null {
  return heldLock;
}

// Settles the pending this process is holding, then exits — the caller is a
// signal handler and MUST still reach its `process.exit(code)`.
//
// Take-and-clear BEFORE the await, not after: Actions cancels with SIGINT and
// follows with SIGTERM before the grace period ends, so both handlers can be
// in flight at once and a peek-then-post would settle twice. `post` is a seam
// only so the take-and-clear and the bound below are testable offline.
//
// Every error is swallowed on purpose. Failing to settle leaves us exactly
// where PR #162 left us — never worse — and a throw here would cost the exit
// code the handler owes the runner.
export async function settleHeldCommitStatusOnSignal(
  post: typeof postCommitStatus = postCommitStatus,
): Promise<void> {
  const settle = settleRequestForCancellation(heldLock);
  releaseCommitStatusLock();
  if (settle === null) return;
  try {
    await post(settle.operatorRoot, settle.sha, settle.request, undefined, {
      attempts: 1,
      timeoutMs: CANCELLATION_COMMIT_STATUS_TIMEOUT_MS,
    });
  } catch {
    // Ignore
  }
}

async function tryPublishCommitStatus(
  operatorRoot: string,
  sha: string,
  request: ReturnType<typeof commitStatusRequest>,
): Promise<void> {
  try {
    await postCommitStatus(operatorRoot, sha, request);
  } catch (error) {
    log(
      `warning: commit status (${request.state}): ${(error as Error).message}`,
    );
  }
}

async function reviewPr(
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
  const agents = resolveAgentsDir(options, loaded);
  const { dir: agentsDir, source: agentsDirSource } = agents;
  const spec = validateReviewSpec(localReviewSpec());
  spec.agents.forEach((agent, i) => {
    assertBasenameOnly(agent.file, i);
  });
  await preflightAgentsDir(
    agents,
    spec.agents.map((a) => a.file),
  );
  const agentFiles = new Map<string, ParsedAgent>();
  for (const agent of spec.agents) {
    agentFiles.set(
      agent.key,
      await parseAgentFile(agentFilePath(agents, agent.file)),
    );
  }

  // The prompt set's identity (§3.9), computed from the spec's DECLARATION
  // order — the same order the lab's promptSetFingerprint hashes in, so the
  // two sides produce the same string for the same bytes. It is what turns
  // M6's central claim, "both arms ran the same prompt set", from something
  // believed into something recorded, and it fills the `prompt_set` seat
  // review/findings.ts has declared and never populated.
  const promptSet = await promptSetIdentity(
    agentsDir,
    // spec DECLARATION order, and it must stay that: promptSetFingerprint
    // hashes the concatenated texts in the order it is handed, and
    // `prompt_set.sha256` is compared across runs by an external consumer.
    // Reading the list off the bundled map's keys instead would move every
    // fingerprint ever recorded, silently — the digest still looks valid.
    spec.agents.map((a) => agentFilePath(agents, a.file)),
    // A bundled set has no directory basename to be named after. "default" is
    // what dev and npm derive from prompts/default, so the same prompt set
    // names itself identically in all three runtimes.
    agents.kind === "bundled" ? "default" : undefined,
  );
  const gotchasPath = options.gotchas
    ? path.resolve(options.gotchas)
    : path.join(operatorRoot, ".prhero", "gotchas.md");
  const gotchasFile = Bun.file(gotchasPath);
  const gotchas = (await gotchasFile.exists()) ? await gotchasFile.text() : "";
  const gotchasUnusable = gotchasUnusableReason(gotchas);
  if (gotchasUnusable !== undefined) {
    throw new CliError(gotchasErrorMessage(gotchasPath, gotchasUnusable));
  }
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
    if (baseSha === headSha) {
      throw new CliError(
        `base and head resolve to the same commit (${headSha}); there is ` +
          "nothing to review",
      );
    }

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
      : spec.agents.filter(
          (a) =>
            a.role === "hunter" && (a.trigger === undefined || parityFires),
        );
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
      await Bun.write(
        mcpConfigPath,
        `${JSON.stringify(
          codegraphAvailable ? CODEGRAPH_ONLY_MCP_CONFIG : EMPTY_MCP_CONFIG,
          null,
          2,
        )}\n`,
      );

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
        log(
          `reviewing — ${hunterCount} hunter${hunterCount === 1 ? "" : "s"} + ` +
            `refuter ${summarizerLabel(summary)}${scoutLabel(options)}; ` +
            "comparable trees have taken " +
            "8–25 minutes",
        );
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
          if (routePlan !== undefined && productionAdmission !== undefined) {
            productionRuntime = await createProductionRuntime({
              ...productionAdmission.authorityOptions,
              plan: routePlan,
              workspaceRoot: worktreePath,
              registry: productionAdmission.registry,
              evidence: productionAdmission.evidence,
              // #182 follow-up: without this the admission may decide
              // free-server while the bindings stay metered, and the
              // runtime's own guard refuses the divergence — both or neither.
              ...(productionAdmission.freeModelProbe === undefined
                ? {}
                : { freeModelProbe: productionAdmission.freeModelProbe }),
              mode: "production",
              signal: ceilingController.signal,
            });
          }
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
            {
              runner:
                productionRuntime !== undefined
                  ? productionRuntime.runner
                  : new ClaudeCodeRunner({
                      ...runnerAuthority.runnerOptions,
                      signal: ceilingController.signal,
                    }),
              ...(productionRuntime !== undefined
                ? {
                    transportRegistry: productionRuntime.registry,
                    ...(productionRuntime.evidence === undefined
                      ? {}
                      : { admissionEvidence: productionRuntime.evidence }),
                  }
                : {}),
              ceilingController,
              onProgress: progress.onProgress,
            },
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
      const telemetry: Telemetry = {
        // Unlike local mode's hardcoded 0, PR mode BUILDS the worktree's index
        // when it is missing, so the init cost is real and measured. Disk stays
        // unreported, and the mode is the same synchronous build.
        index_ms: indexMs,
        index_mode: "sync",
        index_disk_mb: 0,
        // Driver-MEASURED elapsed time, never the sum of the parallel steps —
        // same rule as local mode.
        wall_ms: wallMs,
        tokens_in: result.usage.tokens_in,
        tokens_out: result.usage.tokens_out,
        tokens_total: result.usage.tokens_total,
        cost_usd_est: result.usage.cost_usd_est,
        ...(result.unresolved.length > 0
          ? { cost_usd_est_is_floor: true }
          : {}),
        per_agent: result.perAgent,
      };
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

// The impure half of the agents-dir chain: the seat's `configDir` is the
// dirname of the file the WINNING layer lives in (agentsDirSeat, JD-14), and
// only the existence check below touches the disk.
export function resolveAgentsDir(
  // Narrowed to what it actually reads: `--agents` is the only flag in play,
  // and a wider type would let a caller believe this consults others.
  options: Pick<CliOptions, "agents">,
  loaded: EffectiveConfig,
  // Injected only by tests, which cannot otherwise reach the compiled branch:
  // detectAssetMode() reads `import.meta.dir` and always reports "dev" under
  // `bun test`.
  assets?: EngineAssets,
): AgentsDirResolution {
  const seat = agentsDirSeat({
    config: loaded.effective,
    sources: loaded.sources,
    repoConfigPath: loaded.repoConfigPath,
    globalConfigPath: loaded.globalConfigPath,
  });
  const resolution = resolveAgentsDirSetting({
    flag: options.agents,
    ...(seat === undefined ? {} : { config: seat }),
    env: process.env.PRHERO_AGENTS_DIR,
    cwd: process.cwd(),
    ...(assets === undefined ? {} : { assets }),
  });
  // Only a DIRECTORY can be checked for existence, and this gate running
  // unconditionally is the whole shipped defect: the compiled binary's bundled
  // set has no directory, `existsSync` on the embedded root is false, and every
  // run of the released binary died here with "agents dir does not exist"
  // before a single step spawned. A bundled set's conformance is checked by
  // preflightAgentsDir over the manifest's keys instead.
  if (resolution.kind === "dir" && !existsSync(resolution.dir)) {
    throw new CliError(`agents dir does not exist: ${resolution.dir}`);
  }
  return resolution;
}

export async function preflightAgentsDir(
  agents: Pick<AgentsDirResolution, "kind" | "dir" | "files">,
  specFiles: string[],
): Promise<void> {
  const present = new Set<string>();
  if (agents.kind === "bundled") {
    // The manifest's keys ARE the present set, and there is nothing to scan:
    // Bun.Glob().scan() over the embedded root THROWS ENOENT rather than
    // yielding nothing, so a bundled set reaching the glob below is not a
    // degraded check but a crash. Key ORDER is irrelevant here — unlike the
    // fingerprint, agentsDirProblems compares sets bidirectionally.
    for (const file of Object.keys(agents.files ?? {})) present.add(file);
  } else {
    for (const pattern of AGENT_FILE_PATTERNS) {
      for await (const entry of new Bun.Glob(pattern).scan({
        cwd: agents.dir,
      })) {
        present.add(entry);
      }
    }
  }
  const problems = agentsDirProblems(specFiles, [...present]);
  if (problems.length > 0) {
    throw new CliError(
      `prompt set ${agents.dir} does not match the review spec:\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
}

// repoId rides along with the run dir so the caller's fail-soft metrics
// ingest (W4 / #23) can reuse the SAME resolveRepoHome call below instead of
// paying for a second gitOriginUrl lookup. --out still skips resolveRepoHome
// itself (an explicit dir needs no ~/.prhero/repos/<id> registry, and must
// never gain the side effect of creating one just to learn an id — W4 Phase
// 6 remediation, GitHub #23 option D) — but it now tries origin via
// tryOriginRepoId (persist:false semantics) so a --out run on a checkout
// WITH a resolvable origin still ingests. repoId is null only when that
// origin lookup itself fails — the same no-origin escape hatch every other
// global-state path already has, never a throw.
export async function createRunDir(
  options: CliOptions,
  repoRoot: string,
  headSha: string,
): Promise<{ runDir: string; repoId: string | null }> {
  if (options.out) {
    const explicit = path.resolve(options.out);
    assertOutsideRepo(explicit, repoRoot);
    await mkdir(explicit, { recursive: true });
    return { runDir: explicit, repoId: await tryOriginRepoId(repoRoot) };
  }
  const repoHome = await resolveRepoHome({
    home: os.homedir(),
    operatorRoot: repoRoot,
    persist: true,
  });
  const root = repoHome.paths.runs;
  // Smallest unused integer, so a second review of the same commit never
  // overwrites the first one's artifacts — a run that cost money is evidence.
  for (let n = 1; ; n++) {
    const candidate = runDirCandidate(root, headSha, n);
    if (existsSync(candidate)) continue;
    assertOutsideRepo(candidate, repoRoot);
    await mkdir(candidate, { recursive: true });
    return { runDir: candidate, repoId: repoHome.repoId };
  }
}

// PR-mode twin of createRunDir, differing in exactly two ways: the candidate
// carries the PR number, and the outside-the-repo assertion runs against
// BOTH roots — artifacts inside either tree would contaminate a review.
async function createPrRunDir(
  options: CliOptions,
  operatorRoot: string,
  worktreePath: string,
  runsRoot: string,
  prNumber: number,
  headSha: string,
): Promise<string> {
  const dir = predictPrRunDir(
    options,
    operatorRoot,
    worktreePath,
    runsRoot,
    prNumber,
    headSha,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

// The same resolution WITHOUT the mkdir, because a PR-mode --dry-run must
// create nothing at all (local mode's dry run does create its run dir; PR
// mode deliberately does not) — yet the plan should still print the exact
// dir a confirmed run would use, and an --out that violates the containment
// rule should still fail inside the free dry run.
function predictPrRunDir(
  options: CliOptions,
  operatorRoot: string,
  worktreePath: string,
  runsRoot: string,
  prNumber: number,
  headSha: string,
): string {
  if (options.out) {
    const explicit = path.resolve(options.out);
    assertOutsideRepo(explicit, operatorRoot);
    assertOutsideRepo(explicit, worktreePath);
    return explicit;
  }
  const root = runsRoot;
  // Smallest unused integer, same reason as createRunDir: a run that cost
  // money is evidence and must never be overwritten.
  for (let n = 1; ; n++) {
    const candidate = prRunDirCandidate(root, prNumber, headSha, n);
    if (existsSync(candidate)) continue;
    assertOutsideRepo(candidate, operatorRoot);
    assertOutsideRepo(candidate, worktreePath);
    return candidate;
  }
}

export interface PrDryRunSizeGateResult {
  verdict: SizeGateVerdict;
  note: string;
}

// PR1b Addition 1 (#5557): the PR `--dry-run` size-gate estimate, fixed to
// use per-file data when it is trustworthy — pure, so the truncation-guard
// branching is unit-testable without a live `gh` call.
//
// Ported from watch/watch.ts's tier-2 pattern, not rewritten: the aggregate path
// (`{files, insertions, deletions}`, no paths) cannot express exclusions at
// all, so `.prheroignore` widens what was already a "wrong in the
// conservative direction" gap (see the WHY this replaces at the call site)
// from tens of lines (lockfiles) to potentially thousands (a whole ignored
// directory) — a gate that SKIPs a PR the real per-file run happily accepts
// reads as a broken tool, not a conservative estimate.
//
// `perFile: null` is the caller's signal that gh's own `files` list was
// truncated or unavailable — see watch/watch.ts:322-327's identical guard: a SHORT
// list under-counts, and under-counting here would falsely RESCUE exactly
// the monster this gate exists to stop, so an untrustworthy list is never
// used to compute a passing verdict.
export function resolvePrDryRunSizeGate(input: {
  ghDiffStat: NumstatDiffStat;
  perFile: NumstatFile[] | null;
  gateConfig: SizeGateConfig;
}): PrDryRunSizeGateResult {
  if (input.perFile !== null) {
    return {
      verdict: evaluateSizeGate(input.perFile, input.gateConfig),
      note:
        "(estimate from gh's per-file list; `.prheroignore` exclusions " +
        "apply, but the count is still not whitespace-adjusted — GitHub's " +
        "counters carry no whitespace information)",
    };
  }
  return {
    verdict: evaluateSizeGateAggregate(input.ghDiffStat, input.gateConfig),
    note:
      "(estimate from GitHub's aggregate counters; gh's per-file list was " +
      "truncated or unavailable, so exclusions are not applied and the " +
      "count is not whitespace-adjusted)",
  };
}

// Live progress for the paid leg, born from a real incident: the CLI went
// silent for ~10 minutes between `codegraph init` and `run complete`, and a
// paid run died to a Ctrl-C from a user who reasonably believed it hung.
// On a TTY: a multi-line panel redrawn in place (state and frame text are
// pure in progress.ts). Non-TTY (piped, backgrounded): one plain stderr
// line per event. I/O by nature, untested by construction — formatElapsed
// and the progress.ts halves are the pure, tested pieces.
interface ProgressRenderer {
  onProgress: (event: PipelineProgressEvent) => void;
  stop: () => void;
}

// Height the panel assumes when the stream will not say (a TTY without rows),
// and the rows it leaves free below itself.
const PANEL_FALLBACK_ROWS = 24;
const PANEL_HEADROOM = 3;

function startProgressRenderer(
  startedAtMs: number,
  subject: string,
  hunterKeys: string[],
  hasRefuter = true,
  hasSummarizer = false,
): ProgressRenderer {
  return process.stderr.isTTY
    ? startPanelRenderer(
        startedAtMs,
        subject,
        hunterKeys,
        hasRefuter,
        hasSummarizer,
      )
    : startLineRenderer(startedAtMs);
}

// The TTY panel: header + a TREE of agent rows (the refuter's per-finding
// leaves under it), redrawn in place with cursor-up (\x1b[<n>A) + per-line
// clear (\x1b[2K) on every event and on a 250ms tick that advances the
// spinner and the elapsed clocks. The cursor is deliberately NOT hidden:
// \x1b[?25l would need a restore on every exit path, and a leaked hidden
// cursor wrecks the user's terminal — a visible cursor over a redrawing
// panel is fine.
//
// Two things the tree made load-bearing that a fixed-height list did not:
//   - the height budget, recomputed EVERY draw (a mid-run resize must tighten
//     it on the next tick, not walk the cursor off the top of the screen);
//   - \x1b[0J after the frame. The old panel could only grow, so leftover
//     lines were impossible; a tree that collapses a finished branch shrinks,
//     and without the erase-to-end the previous frame's tail stays on screen
//     as orphaned rows.
// Exported for its test, which is the only consumer outside this module: the
// post-stop silence below is a CRITICAL invariant and an untested one regresses.
export function startPanelRenderer(
  startedAtMs: number,
  subject: string,
  hunterKeys: string[],
  hasRefuter = true,
  hasSummarizer = false,
): ProgressRenderer {
  // The NO_COLOR convention: any value disables color; a TTY alone is not
  // consent.
  const colors = process.env.NO_COLOR === undefined;
  const state = createPanelState(subject, startedAtMs, hunterKeys, {
    refuter: hasRefuter,
    summarizer: hasSummarizer,
  });
  let frame = 0;
  let drawnLines = 0;
  // Headroom, not the whole window: the summary block prints below the final
  // frame, and a panel that fills the terminal exactly would scroll it away
  // the moment anything else is written. 24 is the classic default for a
  // stream that will not say how tall it is.
  const budget = (): number =>
    Math.max((process.stderr.rows ?? PANEL_FALLBACK_ROWS) - PANEL_HEADROOM, 3);
  const draw = (): void => {
    const lines = renderPanelLines(
      state,
      performance.now(),
      frame,
      colors,
      budget(),
    );
    if (drawnLines > 0) process.stderr.write(`\x1b[${drawnLines}A`);
    for (const line of lines) {
      process.stderr.write(`\x1b[2K${line}\n`);
    }
    // See the header: the frame can shrink, so anything below it must go.
    process.stderr.write("\x1b[0J");
    drawnLines = lines.length;
  };
  const ticker = setInterval(() => {
    frame += 1;
    draw();
  }, 250);
  draw();
  // STOPPED IS LOAD-BEARING, and it is what makes \x1b[0J safe. The pipeline
  // ceiling resolves the run while in-flight step promises are ABANDONED, not
  // awaited (pipeline.ts: "abandoned, not awaited"), and their settle handlers
  // emit unconditionally. So an event can arrive after stop() — after the
  // result block has already printed below the final frame. Without this flag
  // that late event redraws: the cursor walks back UP over the summary and
  // \x1b[0J erases everything below it, deleting the findings of a paid run.
  // Found live by pr-hero reviewing its own PR #7 (F002, CRITICAL,
  // corroborated) — the erase-to-end-of-screen that fixed the shrinking-frame
  // bug created this one.
  let stopped = false;
  return {
    onProgress: (event: PipelineProgressEvent): void => {
      if (stopped) return;
      applyProgressEvent(state, event, performance.now());
      draw();
    },
    stop: (): void => {
      if (stopped) return;
      clearInterval(ticker);
      // One last draw so the completed states land; the frame then stays as
      // the static record, and the summary prints below it.
      draw();
      // AFTER the final draw, so stop() itself is not a no-op.
      stopped = true;
    },
  };
}

// Non-TTY: no redraw art, one plain line per event, elapsed prefix.
function startLineRenderer(startedAtMs: number): ProgressRenderer {
  const line = (text: string): void => {
    log(`  [${formatElapsed(performance.now() - startedAtMs)}] ${text}`);
  };
  return {
    onProgress: (event: PipelineProgressEvent): void => {
      switch (event.kind) {
        case "hunters-started":
          // The expectation line printed right before runPipeline already
          // announced the fan-out; restating it here would be its echo.
          return;
        case "hunter-finished":
          // A failed hunter is honest, not alarming: one dead hunter is a
          // partial run, never an abort.
          line(
            `hunter ${event.hunter}: ` +
              (event.ok ? "done" : "failed (the run continues)"),
          );
          return;
        case "dedupe-finished":
          line(
            `dedupe: ${event.drafts} draft${event.drafts === 1 ? "" : "s"} ` +
              `-> ${event.findings} finding${event.findings === 1 ? "" : "s"}`,
          );
          return;
        case "refuter-started":
          line(
            `refuter: ${event.severeFindings} severe finding` +
              `${event.severeFindings === 1 ? "" : "s"} to judge`,
          );
          return;
        case "refuter-step-finished":
          line(`refuter ${event.findingId}: ${event.verdict}`);
          return;
        case "verify-started":
          line(
            `verify: ${event.queued} prior finding` +
              `${event.queued === 1 ? "" : "s"} to check`,
          );
          return;
        case "verify-step-finished":
          line(`verify ${event.findingId}: ${event.verdict}`);
          return;
        case "summarizer-finished":
          line(
            `summarizer: ${event.ok ? "done" : "failed (the run continues)"}`,
          );
          return;
        case "scout-started":
          line(`scout: reading the diff (${event.model})`);
          return;
        case "scout-finished":
          // "unled", never "the run continues": a scout failure is not a
          // partial review, it is the control pipeline. Naming it as a
          // degradation would teach an operator to distrust a complete run.
          line(
            event.ok
              ? `scout: ${event.leads ?? 0} lead(s)`
              : "scout: failed (the hunters run unled)",
          );
          return;
        case "step-retry":
          // EVERY step, hunters and refuter alike — this is the launchd log,
          // where a retry that explains a long wall time has to be readable
          // after the fact and nothing competes for the line.
          line(
            `retry ${event.step}: ` +
              (event.reason === "format"
                ? "format retry"
                : `attempt ${event.attempt} of ${event.maxAttempts} ` +
                  "(transient)"),
          );
          return;
      }
    },
    stop: (): void => {
      // Nothing ticking to stop — kept so both renderers share one shape.
    },
  };
}

// The cost band's gate. `details` is a thunk so the details view — which
// probes the filesystem — is built only if the human asks for it, and
// `canSkipPost` is what decides whether "Review, but don't post" exists at
// all: offering it to a run that was never going to post is a no-op dressed
// as a choice.
function confirm(
  low: number,
  high: number,
  canSkipPost: boolean,
  details: () => string[],
): Promise<ConfirmResult> {
  return confirmReview({
    low,
    high,
    canSkipPost,
    details,
    styles: styleEnabled(),
  });
}

// The size-gate override. `onBlock` runs for both the hard skip and the
// interactive prompt (PR mode prints the SKIP line here, because that path
// never reaches the plan). Local mode passes nothing: the plan already
// printed the verdict.
async function applySizeGate(
  verdict: SizeGateVerdict,
  options: Pick<CliOptions, "force" | "yes">,
  onBlock?: () => void,
): Promise<"proceed" | "abort"> {
  const disposition = sizeGateDisposition(verdict, {
    force: options.force,
    yes: options.yes,
    interactive: Boolean(process.stdin.isTTY),
  });
  if (disposition.action === "proceed") return "proceed";
  onBlock?.();
  if (disposition.action === "skip") {
    throw new CliError(disposition.message);
  }
  const choice = await confirmSizeGate(styleEnabled());
  if (choice.kind === "cancel") {
    log("aborted; nothing was spent.");
    return "abort";
  }
  return "proceed";
}

// ROADMAP Pillar 3 (GitHub Actions CI). The mechanical glue behind a gate
// skip in CI mode: every DECISION (what to say, which marker, what the
// outputs are) already happened in `plan` (planCiSizeSkip/planCiBudgetSkip,
// ci/gates.ts) — this function has nothing left to decide, only three
// straight-line I/O calls gated by shouldWriteStepSummary/shouldWriteCiOutputs.
// `postPrComment`'s own `markerPrefix` (Phase 3's parameterization) makes
// this idempotent: a repeat CI run on the same still-failing PR updates its
// own prior skip comment rather than stacking a new one on every push.
type CiAdmissionLedgerState = {
  record: AdmissionRecord;
  checkRunId: number;
  headSha: string;
  operatorRoot: string;
};

async function persistCiAdmissionLedger(
  state: CiAdmissionLedgerState,
): Promise<void> {
  state.checkRunId = await upsertAdmissionCheckRun(state.operatorRoot, {
    headSha: state.headSha,
    record: state.record,
    checkRunId: state.checkRunId,
  });
}

async function tryPersistCiAdmissionLedger(
  state: CiAdmissionLedgerState | null,
): Promise<void> {
  if (state === null) return;
  try {
    await persistCiAdmissionLedger(state);
  } catch {
    // Best-effort: settlement must not mask the underlying review failure.
  }
}

async function settleCiAdmissionLedger(
  state: CiAdmissionLedgerState | null,
  status: AdmissionAttemptStatus,
  reason: string,
): Promise<void> {
  if (state === null) return;
  const terminal = new Set<AdmissionAttemptStatus>([
    "completed",
    "failed",
    "cancelled",
    "skipped",
  ]);
  if (
    terminal.has(state.record.status) &&
    state.record.status !== "provider-started"
  ) {
    return;
  }
  state.record = settleAdmissionAttempt(state.record, status, reason);
  await tryPersistCiAdmissionLedger(state);
}

async function reserveCiAdmissionLedger(input: {
  operatorRoot: string;
  prNumber: number;
  headSha: string;
  policy: CiReviewPolicy;
  policyHash: string;
  existing: readonly AdmissionRecord[];
  decisionReason: string;
  priorScore?: number | null;
  blockingCount?: number | null;
  advisoryCount?: number | null;
}): Promise<CiAdmissionLedgerState> {
  const { record } = reserveAdmissionAttempt({
    existing: input.existing,
    prNumber: input.prNumber,
    headSha: input.headSha,
    policyHash: input.policyHash,
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    decisionReason: input.decisionReason,
    priorScore: input.priorScore ?? null,
    blockingCount: input.blockingCount ?? null,
    advisoryCount: input.advisoryCount ?? null,
    reservationTtlSeconds: input.policy.reservationTtlSeconds,
  });
  const checkRunId = await upsertAdmissionCheckRun(input.operatorRoot, {
    headSha: input.headSha,
    record,
  });
  return {
    record,
    checkRunId,
    headSha: input.headSha,
    operatorRoot: input.operatorRoot,
  };
}

async function recordCiAdmissionGateSkip(input: {
  operatorRoot: string;
  prNumber: number;
  headSha: string;
  policy: CiReviewPolicy;
  policyHash: string;
  existing: readonly AdmissionRecord[];
  reason: string;
  priorScore: number | null;
  blockingCount: number | null;
  advisoryCount: number | null;
}): Promise<void> {
  try {
    const state = await reserveCiAdmissionLedger({
      operatorRoot: input.operatorRoot,
      prNumber: input.prNumber,
      headSha: input.headSha,
      policy: input.policy,
      policyHash: input.policyHash,
      existing: input.existing,
      decisionReason: input.reason,
      priorScore: input.priorScore,
      blockingCount: input.blockingCount,
      advisoryCount: input.advisoryCount,
    });
    await settleCiAdmissionLedger(state, "skipped", input.reason);
  } catch {
    // The skip notice is the operator-facing outcome; a check-run write must
    // not block publishing it.
  }
}

async function publishCiSkip(input: {
  operatorRoot: string;
  prNumber: number;
  post: boolean;
  isCi: boolean;
  stepSummaryFlag: boolean | undefined;
  plan: CiGateSkipPlan;
  noticeMessage: string;
}): Promise<number> {
  log(formatWorkflowCommand("notice", input.noticeMessage));
  if (input.post) {
    await postPrComment(
      input.operatorRoot,
      input.prNumber,
      input.plan.comment,
      undefined,
      undefined,
      input.plan.markerPrefix,
    );
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (shouldWriteStepSummary(input.isCi, input.stepSummaryFlag, summaryPath)) {
    await appendStepSummary(summaryPath as string, input.plan.summaryMarkdown);
  }
  const outputPath = process.env.GITHUB_OUTPUT;
  if (shouldWriteCiOutputs(input.isCi, outputPath)) {
    await appendCiOutputs(outputPath as string, input.plan.outputs);
  }
  return 0;
}

// The envelope needs ONE model string. With no --model override each agent
// carries its own frontmatter model, so report what actually ran rather than
// inventing a single value: identical models collapse to one name, a mixed
// set is recorded as a mix instead of as a lie.
function envelopeModel(
  options: CliOptions,
  agentFiles: Map<string, ParsedAgent>,
): string {
  if (options.model) return options.model;
  const models = new Set<string>();
  for (const agent of agentFiles.values()) {
    if (agent.model) models.add(agent.model);
  }
  if (models.size === 0) return "unspecified";
  return [...models].sort().join("+");
}

async function menuCommand(options: CliOptions): Promise<number> {
  const repoRoot = options.repo
    ? await resolveRepoRoot(options.repo).catch(() => undefined)
    : await resolveRepoRoot(process.cwd()).catch(() => undefined);
  const context = await resolveMenuContext(repoRoot ?? process.cwd());

  return await runMenuLoop({
    context,
    styles: styleEnabled(process.stderr),
    width: terminalWidth(),
    dispatchAction: async (action) => {
      switch (action) {
        case "review": {
          let effectiveConfig: LocalConfig | undefined;
          if (repoRoot) {
            try {
              const loaded = await loadEffectiveConfig({
                root: repoRoot,
                home: os.homedir(),
                configFlag: options.config,
              });
              effectiveConfig = loaded.effective;
            } catch {
              // ignore
            }
          }
          const res = await runReviewMenu({
            styles: styleEnabled(process.stderr),
            width: terminalWidth(),
            effectiveConfig,
            defaultBase:
              context.kind === "configured-repo"
                ? context.defaultBase
                : undefined,
          });
          if (res.action === "launch") {
            return await review(res.options);
          }
          return "back";
        }
        case "init": {
          return await init(options);
        }
        case "activity": {
          return await activityCommand(options);
        }
        case "ledger": {
          return await ledgerCommand(options);
        }
        case "doctor": {
          return await doctorCommand(options);
        }
        case "config": {
          return await runConfigSubmenu({
            styles: styleEnabled(process.stderr),
            width: terminalWidth(),
            repoRoot: repoRoot ?? undefined,
            home: os.homedir(),
          });
        }
        case "watcher": {
          return await runWatcherSubmenu({
            styles: styleEnabled(process.stderr),
            width: terminalWidth(),
            inRepo: context.kind !== "not-a-repo",
            home: os.homedir(),
            dispatch: async (subcmd) => {
              if (subcmd === "status")
                return await watchCommand({ ...options, watch: "status" });
              if (subcmd === "install")
                return await watchCommand({ ...options, watch: "install" });
              if (subcmd === "uninstall")
                return await watchCommand({ ...options, watch: "uninstall" });
              if (subcmd === "add")
                return await watchCommand({ ...options, watch: "add" });
              if (subcmd === "add-on-push")
                return await watchCommand({
                  ...options,
                  watch: "add",
                  onPush: true,
                });
              if (subcmd === "remove")
                return await watchCommand({ ...options, watch: "remove" });
              return 0;
            },
          });
        }
        case "lifecycle": {
          return await runLifecycleSubmenu({
            styles: styleEnabled(process.stderr),
            width: terminalWidth(),
            dispatch: async (subcmd) => {
              if (subcmd === "upgrade") return await upgradeCommand(options);
              if (subcmd === "setup")
                return await runWizard({ cwd: repoRoot ?? process.cwd() });
              if (subcmd === "uninstall")
                return await uninstallCommand(options);
              return 0;
            },
          });
        }
        case "quit": {
          return 0;
        }
        default:
          return 0;
      }
    },
  });
}

// main()'s two internal catches RETURN rather than throw, so runCli()'s catch
// — the only thing that has ever written `status=error` — never saw them. Both
// are failures docs/github-actions.md names as reasons the job goes red: a
// malformed argument (parseArgs, exit 2) and a CliError/CliUsageError from a
// command body (exit 1) — which is precisely what a missing or expired
// GITHUB_TOKEN produces, since pr/pr.ts raises CliError for `gh not found on
// PATH` and for a failed `gh pr view`. A consumer branching on
// `outputs.status == 'error'` therefore never saw it fire for the two most
// common failures; it saw `status` unset, indistinguishable from a step whose
// outputs were never read.
//
// $GITHUB_OUTPUT's mere presence is the CI signal here, exactly as it is for
// reportFatalCiError: GitHub sets it for every job step before any of this
// repo's own flags are parsed. Guarding the CALL rather than only the write is
// deliberate — reportFatalCiError also emits an `::error::` annotation, and
// printing workflow-command syntax on a developer's terminal after a plain
// typo is noise, not diagnostics. Exit codes are untouched; only the write is
// new.
async function reportFatalCiErrorIfInJobStep(error: unknown): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath === undefined || outputPath.length === 0) return;
  await reportFatalCiError(error, outputPath);
}

// Exported so bin/pr-hero.js can drive the exact same signal-handling +
// exit-code path as a direct `bun run src/cli.ts` invocation. `bun bin/pr-hero.js
// ...` (the npm-installed entrypoint) reaches this file through `import`, and
// `import.meta.main` is false for every imported module — only the directly
// executed entry file gets `true` — so the guard below never ran for it and the
// installed `pr-hero` command was a silent, zero-output, exit-0 no-op. Covered
// by packaging.test.ts's subprocess spawn of bin/pr-hero.js.
export async function runCli(
  argv: string[] = Bun.argv.slice(2),
): Promise<void> {
  const restoreCursor = () => {
    try {
      process.stderr.write("\x1b[?25h");
    } catch {
      // Ignore
    }
  };
  process.on("SIGTERM", async () => {
    restoreCursor();
    try {
      killAllChildProcesses();
      await unregisterActiveRun(process.pid);
    } catch {
      // Ignore
    }
    // After killing the children (stop spending first), before exiting: the
    // in-flight lock this process took is released by its holder, or the next
    // run skips the head for the rest of the 90-minute TTL (#146).
    await settleHeldCommitStatusOnSignal();
    process.exit(143);
  });
  process.on("SIGINT", async () => {
    restoreCursor();
    try {
      killAllChildProcesses();
      await unregisterActiveRun(process.pid);
    } catch {
      // Ignore
    }
    await settleHeldCommitStatusOnSignal();
    process.exit(130);
  });
  process.on("exit", () => {
    restoreCursor();
  });
  let exitCode: number;
  try {
    exitCode = await main(argv);
  } catch (error) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (outputPath === undefined || outputPath.length === 0) {
      // Not a real GitHub Actions job step — preserve the original
      // uncaught-exception path so a local `bun run src/cli.ts` crash still
      // prints its full stack trace instead of a swallowed one-line message.
      throw error;
    }
    await reportFatalCiError(error, outputPath);
    exitCode = 1;
  }
  process.exit(exitCode);
}

// Only when executed, never on import — the pure helpers (and runCli itself)
// stay importable from tests / bin/pr-hero.js without the CLI trying to run a
// review as a side effect of the import.
if (import.meta.main) {
  await runCli();
}
