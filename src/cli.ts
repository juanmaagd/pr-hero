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

import crypto from "node:crypto";
import { chmodSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getWatcherSpend,
  killActiveRun,
  listActiveRuns,
  queryRecentRuns,
  registerActiveRun,
  unregisterActiveRun,
} from "./activity";
import { resolveEngineAssets } from "./assets";
import type { PrHeroFindingRef } from "./compare";
import { corpusCommand } from "./corpus";
import { renderDoctorReport, runDoctor } from "./doctor";
import {
  type Finding,
  type FindingsDocument,
  mergeRunEnvelope,
  type Telemetry,
  validateFindingsDocument,
  writeFindings,
} from "./findings";
import { gcCommand, runGc } from "./gc";
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
import {
  buildPostPlan,
  type PostedFindingComment,
  type PostPlan,
  parseHunkAnchors,
  resolvePostLine,
} from "./inline";
import {
  aggregateLedger,
  parseComparisonJson,
  renderLedger,
  type StoredComparison,
} from "./ledger";
import { runMcpServer } from "./mcp";
import {
  type FailSoftIngestInput,
  failSoftIngest,
  queryUsage,
} from "./metrics";
import { type RunRow, renderUsage } from "./metrics-preflight";
import {
  changedPathsFromDiff,
  DEFAULT_SCOUT_MODEL,
  type PerAgentUsage,
  type PipelineProgressEvent,
  type PipelineResult,
  parityTriggered,
  runPipeline,
} from "./pipeline";
import {
  type ComparisonOutcome,
  ensureWorktree,
  fetchCommitStatuses,
  fetchPostedFindingComments,
  fetchPrComments,
  fetchPrRefs,
  fetchPrReviewComments,
  ghCurrentBranchPr,
  ghPrHeadSha,
  ghPrView,
  ghRepoWebUrl,
  initCodegraphIndex,
  postCommitStatus,
  postIssueTriageComment,
  postPrComment,
  postPrReview,
  postReviewCommentReply,
  resolveReviewThreadForComment,
  writeComparison,
} from "./pr";
import {
  claimFingerprint,
  commitStatusCompletion,
  commitStatusRequest,
  findMarkedCommentId,
  isInFlightCommitStatus,
  type PrTarget,
  parseFindingMarker,
  prHtmlUrl,
  prRunDirCandidate,
  resolveCurrentPrNumber,
  resolvePrTarget,
} from "./pr-preflight";
import {
  AGENT_FILE_PATTERNS,
  type AgentsDirResolution,
  type AgentsDirSource,
  agentsDirProblems,
  agentsDirSeat,
  allExcludedMessage,
  assertBasenameOnly,
  assertOutsideRepo,
  type BaseRefResolution,
  CliError,
  type CliOptions,
  CliUsageError,
  type ConfigLayer,
  type ConfigSource,
  type ConfigSources,
  DEFAULT_SUMMARY_MODEL,
  emptyDiffMessage,
  GOTCHAS_TEMPLATE,
  gotchasErrorMessage,
  HELP_TEXT,
  headContainedInBaseMessage,
  INIT_GIT_REMINDER,
  initConfigTemplate,
  initTemplateOmissions,
  isFullCommitId,
  type LocalConfig,
  listPaths,
  localReviewSpec,
  mergeConfig,
  parseArgs,
  parseGlobalConfig,
  parseLocalConfig,
  parseNumstatFiles,
  parseRemoteHead,
  repoWebUrlFromRemote,
  resolveAgentsDirSetting,
  resolveBaseRef,
  resolveMaxVerificationSteps,
  resolveSummary,
  runDirCandidate,
  type SummarySettings,
} from "./preflight";
import {
  applyProgressEvent,
  createPanelState,
  renderPanelLines,
} from "./progress";
import {
  type ParsedAgent,
  parseAgentFile,
  promptSetIdentity,
} from "./prompt-set";
import {
  type DiffStat,
  estimateCost,
  formatElapsed,
  type PrCommentDelta,
  renderPrComment,
  renderReport,
  rereviewDeltaFromProvenance,
} from "./report";
import {
  buildPhaseBQueue,
  collapseTargets,
  enrichPriorsFromThreads,
  parseNameOnly,
  parseNameStatus,
  prepareDiscovery,
  priorsFromPostedMarkers,
  priorsFromStateFindings,
  type RereviewProvenance,
  readRereviewProvenance,
  shouldAbortEmptyDiscovery,
  toRereviewProvenance,
} from "./rereview-prepare";
import { parseStateBlock, renderStateBlock } from "./rereview-state";
import { revertsCommand } from "./reverts";
import {
  effectiveDiffStat,
  evaluateSizeGate,
  evaluateSizeGateAggregate,
  filterDiffByGlobs,
  type SizeGateVerdict,
  sizeGateConfig,
  sizeGateDisposition,
  sizeGateLine,
} from "./size-gate";
import { type ReviewSpec, validateReviewSpec } from "./spec";
import { ClaudeCodeRunner, killAllChildProcesses } from "./step-runner";
import {
  openProductStore,
  queryRuns,
  recordFindingTriage,
  saveRunTransaction,
} from "./store";
import { projectCompleteRun } from "./store-preflight";
import {
  renderTriageReplyBody,
  TRIAGE_MARKER_PREFIX,
  type TriageMarkerFields,
  type TriageTag,
  type TriageVerdict,
} from "./triage";
import {
  decideThreadResolve,
  existingTriageAtHead,
  findingIdentityForMarkerMatch,
  matchPostedFindingExact,
} from "./triage-reply";
import { applyTriageReplies, type TriageReplyCandidate } from "./triage-write";
import {
  bold,
  box,
  dim,
  green,
  labelColumnWidth,
  log,
  red,
  row,
  section,
  shortPath,
  shortSha,
  styleEnabled,
  terminalWidth,
  yellow,
} from "./ui";
import { renderActivityScreen } from "./ui-activity";
import { renderConfig } from "./ui-config";
import { type ResultLinks, renderResult } from "./ui-result";
import {
  type ConfirmResult,
  confirmReview,
  confirmSizeGate,
} from "./ui-select";
import { executeUninstallPlan, planUninstallation } from "./uninstaller";
import {
  detectInstallMethod,
  PRHERO_GITHUB_REPO,
  planUpgrade,
  readUpgradeCache,
  reconcileUpgrade,
  writeUpgradeCache,
} from "./updater";
import { watchCommand } from "./watch";
// Pure decision module, not a shell — same category as pr-preflight.ts (see
// its own header comment). Reads the ALREADY-POSTED summary marker's head=
// declaration so the delta line's "since <sha>" clause is free (report.ts's
// PrCommentDelta.previousHeadSha), the exact reuse watch-preflight.ts's own
// header describes for the cross-machine guard.
import { parseMarkerHead } from "./watch-preflight";
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

// C5 O-6's half of the pipeline input. Unconditional, unlike its two
// neighbours above: the summarizer and the scout are stages that may not run,
// while a config ALWAYS resolved to something — and D7's whole point is that
// the artifact must discriminate the builds. `global_present` is carried
// separately because `sources` cannot express it: a global file that exists
// and says `{}` leaves every source at `repo` or `default`, exactly like no
// file at all.
export function pipelineConfigInput(loaded: EffectiveConfig): {
  config: {
    effective: LocalConfig;
    sources: ConfigSources;
    global_present: boolean;
  };
} {
  return {
    config: {
      effective: loaded.effective,
      sources: loaded.sources,
      global_present: loaded.globalPresent,
    },
  };
}

const EMPTY_MCP_CONFIG = { mcpServers: {} };

// Exclusions are a MUTATION of the reviewed diff, so they are stated out
// loud: an operator who is told "3 files reviewed" must be able to see that
// two more were dropped, and where the unfiltered bytes went. It sits in the
// decision block because an exclusion is what the size gate's numbers were
// computed after.
function exclusionLines(
  droppedPaths: string[],
  styles: boolean,
  width: number,
): string[] {
  if (droppedPaths.length === 0) return [];
  return markerRowLines(
    "!",
    `exclusions: ${droppedPaths.length} generated file(s) dropped from the ` +
      `reviewed diff (${listPaths(droppedPaths)}); the unfiltered diff is ` +
      "kept as diff.raw.patch",
    dim,
    styles,
    width,
  );
}

async function git(
  repo: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  // Args as an ARRAY, never an interpolated shell string: `base` and `head`
  // are user input that reaches git verbatim, and a shell in the middle would
  // turn a branch name into an execution surface.
  const proc = Bun.spawn(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}

async function gitCommitExists(repo: string, sha: string): Promise<boolean> {
  const result = await git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
  return result.ok;
}

async function gitIsAncestor(
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await git(repo, [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
  return result.ok;
}

async function gitNameOnly(
  repo: string,
  from: string,
  to: string,
): Promise<string[]> {
  const result = await git(repo, ["diff", "--name-only", `${from}..${to}`]);
  if (!result.ok) {
    throw new CliError(`git diff --name-only failed: ${result.stderr.trim()}`);
  }
  return parseNameOnly(result.stdout);
}

async function gitNameStatus(
  repo: string,
  from: string,
  to: string,
): Promise<string> {
  const result = await git(repo, ["diff", "--name-status", `${from}..${to}`]);
  if (!result.ok) {
    throw new CliError(
      `git diff --name-status failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

async function resolveCommit(repo: string, rev: string): Promise<string> {
  // `--end-of-options` stops a ref that starts with a dash from being read as
  // an option; `^{commit}` forces a tag or annotated object down to the
  // commit it points at.
  const result = await git(repo, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${rev}^{commit}`,
  ]);
  const sha = result.stdout.trim();
  if (!result.ok || !isFullCommitId(sha)) {
    throw new CliError(
      `cannot resolve "${rev}" to a commit in ${repo}` +
        (result.stderr.trim() ? `: ${result.stderr.trim()}` : ""),
    );
  }
  return sha;
}

// The repo's web url from the remote already on disk — no `gh`, no network,
// no cost, which is precisely why the terminal can afford a link on EVERY run
// and not only on a `--post` one (see repoWebUrlFromRemote's WHY). Cosmetic by
// contract, same as ghRepoWebUrl: any failure returns undefined and the block
// prints plain locations.
async function gitRemoteWebUrl(repo: string): Promise<string | undefined> {
  const remote = await git(repo, ["remote", "get-url", "origin"]);
  if (!remote.ok) return undefined;
  return repoWebUrlFromRemote(remote.stdout);
}

// Local mode's links, and the ONE extra condition PR mode does not need: a PR
// head was fetched from origin, so it is pushed by construction, but a local
// `--head HEAD` is usually a commit that exists only here — and a blob link to
// an unpushed commit is a 404. `git branch -r --contains` answers "does any
// remote-tracking ref already contain this commit" from the local object db:
// free, offline, and the only thing standing between the block and a dead link.
//
// Safe because local mode reviews a COMMITTED range (`diffFromSha..headSha`,
// step 8) — every finding's line lives in headSha itself, so a link pinned to
// that sha points at the bytes the hunters actually read. Were the working
// tree ever reviewed directly, containment would prove nothing and this would
// have to go back to printing no links at all.
async function localResultLinks(
  repoRoot: string,
  headSha: string,
): Promise<ResultLinks | undefined> {
  const webUrl = await gitRemoteWebUrl(repoRoot);
  if (webUrl === undefined) return undefined;
  const contains = await git(repoRoot, ["branch", "-r", "--contains", headSha]);
  if (!contains.ok || contains.stdout.trim().length === 0) return undefined;
  return { webUrl, headSha };
}

async function main(argv: string[]): Promise<number> {
  // Bare zero-argument entry: launch wizard if un-onboarded in a TTY, otherwise error in non-TTY
  if (argv.length === 0) {
    if (!process.stdin.isTTY) {
      log(HELP_TEXT);
      log();
      log("error: no command given");
      return 2;
    }
    if (!isMachineOnboarded()) {
      return await runWizard();
    }
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv.length === 0 ? ["review"] : argv);
  } catch (error) {
    log(HELP_TEXT);
    log();
    log(`error: ${(error as Error).message}`);
    return 2;
  }
  if (parsed.command === "help") {
    log(HELP_TEXT);
    return 0;
  }
  try {
    return parsed.command === "init"
      ? await init(parsed.options)
      : parsed.command === "setup"
        ? await runWizard({
            cwd:
              (await resolveOptionalRepoRoot(parsed.options)) ?? process.cwd(),
          })
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
      return 1;
    }
    throw error;
  }
}

// The ONE caller-layer seam review() and reviewPr() both call after writing
// their artifact (W4 Phase 6 remediation, GitHub #23 option D — spec
// "Fail-Soft Ingest": "WHEN a review finishes THEN the review still exits
// successfully"). A thin wrapper around failSoftIngest is deliberate: the
// verify report flagged that the fail-soft proof lived one layer BELOW this
// call (failSoftIngest's own unit tests), never at the layer review()/
// reviewPr() actually invoke — this function IS that layer, so a test
// against it proves the same seam the two real callers use, not a sibling
// one.
export function ingestReviewMetrics(input: FailSoftIngestInput): void {
  failSoftIngest(input);
}

export interface PersistCanonicalReviewInput {
  dbPath?: string;
  home?: string;
  repoId: string | null;
  runDir: string;
  checkoutPath: string | null;
  doc: FindingsDocument;
  perAgent?: Record<string, PerAgentUsage>;
  comparison: StoredComparison | null;
  generatedAt?: string;
  log?: (line: string) => void;
  // Test seam
  persist?: (input: PersistCanonicalReviewInput) => number;
}

// Canonical Product Store (Fundamentals #6 / observability-canonical-store.md).
// Persists the complete run result into ~/.prhero/prhero.db transactionally.
export function persistCanonicalReview(
  input: PersistCanonicalReviewInput,
): number {
  if (input.persist) {
    return input.persist(input);
  }
  if (input.repoId === null) {
    input.log?.(
      "warning: no repo_id resolved for this run; skipping canonical store persistence",
    );
    return 0;
  }
  try {
    const dbPath =
      input.dbPath ?? prheroLayout(input.home ?? os.homedir()).prheroDbPath;
    const db = openProductStore(dbPath);
    try {
      const projected = projectCompleteRun({
        doc: input.doc,
        perAgent: input.perAgent,
        comparison: input.comparison,
        repoId: input.repoId,
        runDir: input.runDir,
        checkoutPath: input.checkoutPath,
        generatedAt: input.generatedAt,
      });
      return saveRunTransaction(db, projected);
    } finally {
      db.close();
    }
  } catch (err) {
    input.log?.(
      `warning: canonical store persistence failed — the review itself is intact: ${(err as Error).message}`,
    );
    return 0;
  }
}

export interface EffectiveConfig {
  // The ONE shape every resolver downstream receives, exactly as before C5.
  // They cannot tell how it was built, which is the whole of D9's promise.
  effective: LocalConfig;
  sources: ConfigSources;
  repoConfigPath: string;
  globalConfigPath: string;
  // Additive beyond design §3.4's four fields, and O-6 needs it: pipeline.json
  // has to record whether a global layer EXISTED, and that is not derivable
  // from `sources` — a global file that exists and says `{}` leaves every
  // source at `repo` or `default`, indistinguishable from no file at all.
  // Returned from the same stat the read used, so the artifact cannot
  // disagree with what was actually loaded.
  globalPresent: boolean;
}

// C5 §3.4 — the two-layer read, and the ONLY place either config file is
// opened on the review path. Replaces the duplicated
// existsSync/parseLocalConfig/EMPTY_LOCAL_CONFIG block that used to sit in
// both review() and reviewPr().
//
// `root` is the OPERATOR root in both modes and NEVER the review worktree
// (O-8): a reviewed PR's tree must not influence engine config, and the
// global file is read from os.homedir(), which is one step further from a PR
// author's reach than the operator checkout already was. C5 cannot weaken
// that boundary; it only adds a source the author has strictly less access to.
//
// WHY a missing file yields an ABSENT layer instead of EMPTY_LOCAL_CONFIG:
// the constant materialises `parity_trigger_paths: []` and
// `suspicion_priors: []`, so handing it to the merge would make "no file at
// all" indistinguishable from "a file that said []", and provenance would
// report `repo` for a layer that does not exist. mergeConfig decides what an
// all-silent run resolves to; EMPTY_LOCAL_CONFIG is now the shape that comes
// OUT of that, not the input that goes in.
//
// `--config` overrides the repo path only. A flag that repointed the global
// layer is a footgun with no use case. Its missing-file CliError is
// unchanged: an explicitly named file that is not there stays an error,
// because silently falling back to "no parity triggers" would disable a
// hunter the caller just asked for, and a hunter that never fires looks
// exactly like a hunter that found nothing.
// The global layer on its own, and the ONE place `~/.prhero/config.json` is
// opened. Two callers need it for different reasons and must not read it two
// ways: loadEffectiveConfig folds it under the repo file, while `pr-hero init`
// needs it WITHOUT the repo file, because init is writing that file and asking
// what the global already supplies is the whole of O-9. A second read site
// would be a second chance for the two to disagree about what "the global
// layer" is — the same reason §3.4 collapsed review()/reviewPr()'s duplicated
// block into one function.
//
// A malformed global file throws here, so it fails init exactly as loudly as
// it fails a review. That is deliberate: a scaffold silently written against
// "no global file" when there IS one, broken, would hardcode into the repo
// file precisely the keys the operator was about to fix.
export async function loadGlobalConfigLayer(home: string): Promise<{
  filePath: string;
  layer: ConfigLayer | undefined;
}> {
  const filePath = prheroLayout(home).reviewConfigPath;
  if (!existsSync(filePath)) return { filePath, layer: undefined };
  return {
    filePath,
    layer: parseGlobalConfig(await Bun.file(filePath).text()),
  };
}

export async function loadEffectiveConfig(input: {
  root?: string | undefined;
  home: string;
  configFlag?: string | undefined;
}): Promise<EffectiveConfig> {
  const repoConfigPath = input.configFlag
    ? path.resolve(input.configFlag)
    : input.root
      ? path.join(input.root, ".prhero", "config.json")
      : path.join(input.home, ".prhero", "config.json");
  if (input.configFlag && !existsSync(repoConfigPath)) {
    throw new CliError(`config file not found: ${repoConfigPath}`);
  }
  const { filePath: globalConfigPath, layer: global } =
    await loadGlobalConfigLayer(input.home);
  // `global !== undefined` and not a second stat: the helper returns a layer
  // exactly when the file was there and read, so the artifact's
  // `global_present` cannot disagree with what was actually loaded — which is
  // the property the field was added for.
  const globalPresent = global !== undefined;
  const repo =
    (input.configFlag || input.root) && existsSync(repoConfigPath)
      ? parseLocalConfig(await Bun.file(repoConfigPath).text())
      : {};
  return {
    ...mergeConfig(global, repo),
    repoConfigPath,
    globalConfigPath,
    globalPresent,
  };
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
  const { dir: agentsDir, source: agentsDirSource } = resolveAgentsDir(
    options,
    loaded,
  );
  const spec = validateReviewSpec(localReviewSpec());
  spec.agents.forEach((agent, i) => {
    assertBasenameOnly(agent.file, i);
  });
  await preflightAgentsDir(
    agentsDir,
    spec.agents.map((a) => a.file),
  );
  const agentFiles = new Map<string, ParsedAgent>();
  for (const agent of spec.agents) {
    // Parsing every agent file now is a preflight too: a malformed
    // frontmatter block must fail here, not three spawned steps later.
    agentFiles.set(
      agent.key,
      await parseAgentFile(path.join(agentsDir, agent.file)),
    );
  }

  // The prompt set's identity (§3.9), computed from the spec's DECLARATION
  // order — the same order the lab's promptSetFingerprint hashes in, so the
  // two sides produce the same string for the same bytes. It is what turns
  // M6's central claim, "both arms ran the same prompt set", from something
  // believed into something recorded, and it fills the `prompt_set` seat
  // findings.ts has declared and never populated.
  const promptSet = await promptSetIdentity(
    agentsDir,
    spec.agents.map((a) => path.join(agentsDir, a.file)),
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
  if (gotchas.trim().length === 0) {
    throw new CliError(gotchasErrorMessage(gotchasPath));
  }

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
  // pays for in full (see filterDiffByGlobs). diff.raw.patch keeps the
  // unfiltered bytes for audit, and only when there is a difference to audit.
  const gateConfig = sizeGateConfig(options);
  const effectiveDiff = filterDiffByGlobs(diff.stdout, gateConfig.excludeGlobs);
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
    gateConfig.excludeGlobs,
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
  try {
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
        gotchasPath,
        agentsDir,
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
        engine: await engineIdentity(),
        promptSet,
        spec,
      },
      { runner: new ClaudeCodeRunner(), onProgress: progress.onProgress },
    );
  } finally {
    // try/finally, never success-only: a leaked interval keeps the event
    // loop alive and hangs process exit on the error path.
    progress.stop();
    await unregisterActiveRun(process.pid);
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
    wallMs,
    estimate: { low: estimate.low, high: estimate.high },
    runDir,
    artifacts: [path.basename(reportPath), path.basename(findingsPath)],
    ...(links === undefined ? {} : { links }),
    sessionFailed: result.sessionFailed,
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
  const { dir: agentsDir, source: agentsDirSource } = resolveAgentsDir(
    options,
    loaded,
  );
  const spec = validateReviewSpec(localReviewSpec());
  spec.agents.forEach((agent, i) => {
    assertBasenameOnly(agent.file, i);
  });
  await preflightAgentsDir(
    agentsDir,
    spec.agents.map((a) => a.file),
  );
  const agentFiles = new Map<string, ParsedAgent>();
  for (const agent of spec.agents) {
    agentFiles.set(
      agent.key,
      await parseAgentFile(path.join(agentsDir, agent.file)),
    );
  }

  // The prompt set's identity (§3.9), computed from the spec's DECLARATION
  // order — the same order the lab's promptSetFingerprint hashes in, so the
  // two sides produce the same string for the same bytes. It is what turns
  // M6's central claim, "both arms ran the same prompt set", from something
  // believed into something recorded, and it fills the `prompt_set` seat
  // findings.ts has declared and never populated.
  const promptSet = await promptSetIdentity(
    agentsDir,
    spec.agents.map((a) => path.join(agentsDir, a.file)),
  );
  const gotchasPath = options.gotchas
    ? path.resolve(options.gotchas)
    : path.join(operatorRoot, ".prhero", "gotchas.md");
  const gotchasFile = Bun.file(gotchasPath);
  const gotchas = (await gotchasFile.exists()) ? await gotchasFile.text() : "";
  if (gotchas.trim().length === 0) {
    throw new CliError(gotchasErrorMessage(gotchasPath));
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

  // 3 — the free exit, BEFORE the fetch: a PR-mode dry run creates NOTHING —
  // no fetch, no run dir, no worktree — so the cost band rides on GitHub's
  // own counters instead of a local numstat.
  if (options.dryRun) {
    const hunterCount = dryRunHunterCount(spec, config);
    const estimate = estimateCost(
      target.ghDiffStat,
      hunterCount,
      summary.enabled,
      options.scout,
    );
    // The gate, ESTIMATED. A PR dry run creates nothing and fetches nothing,
    // so the only size facts on hand are GitHub's own aggregate counters —
    // no per-file paths, therefore no exclusions. Fetching `gh pr view
    // --json files` here would buy exactness at the price of the "nothing
    // was fetched" contract, and the estimate is only ever wrong in the
    // conservative direction (a gate that fires here may pass for real once
    // lockfiles come off, and GitHub's counters carry no whitespace
    // information, so a formatter sweep counts in full here and counts zero
    // in the real git-side gate). Labelled on both counts, in the plan's own
    // decision block, so nobody reads it as the verdict.
    const estimated = evaluateSizeGateAggregate(
      target.ghDiffStat,
      sizeGateConfig(options),
    );
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
      sizeGateNote:
        "(estimate from GitHub's aggregate counters; exclusions not " +
        "applied and the count is not whitespace-adjusted)",
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
    const summaryHead =
      existingSummaryId === null
        ? null
        : parseMarkerHead(
            issueComments.find((c) => c.id === existingSummaryId)?.body ?? "",
          );
    const prepared = await prepareDiscovery({
      B: diffFromSha,
      H: headSha,
      full: options.full,
      summaryHead,
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
    const gateConfig = sizeGateConfig(options);
    const effectiveDiff = skipPlannedDiscovery
      ? { patch: "", droppedPaths: [] as string[] }
      : filterDiffByGlobs(rawDiff, gateConfig.excludeGlobs);
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
    if (prepared.case !== "A" && prepared.last.L !== null) {
      const nameStatus = parseNameStatus(
        await gitNameStatus(gitDirOwner, prepared.last.L, headSha),
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
        gateConfig.excludeGlobs,
      );
      sizeGate = evaluateSizeGate(
        parseNumstatFiles(gateNumstat.stdout),
        gateConfig,
      );
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
    // filterDiffByGlobs); diff.raw.patch preserves the unfiltered bytes, and
    // only when the filter actually dropped something.
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
    };
    for (const line of renderPrPlan(planContext, styleEnabled())) log(line);
    // What this run will actually publish. `options` is never mutated: the plan
    // card and the details view print what was ASKED FOR, and only the run
    // itself follows the answer given here.
    let postEnabled = options.post;
    if (!options.yes) {
      const choice = await confirm(
        estimate.low,
        estimate.high,
        options.post,
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
      log(
        `reviewing — ${hunterCount} hunter${hunterCount === 1 ? "" : "s"} + ` +
          `refuter ${summarizerLabel(summary)}${scoutLabel(options)}; ` +
          "comparable trees have taken " +
          "8–25 minutes",
      );
      const started = performance.now();
      const progress = startProgressRenderer(
        started,
        `PR #${prNumber}`,
        activeHunters.map((a) => a.key),
        spec.agents.some((a) => a.role === "refuter"),
        summary.enabled,
      );
      await registerActiveRun({
        pid: process.pid,
        repo: repoHome.paths.repoId ?? path.basename(gitDirOwner),
        pr: prNumber,
        runDir,
        startedAt: new Date().toISOString(),
      });
      try {
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
            gotchasPath,
            agentsDir,
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
          { runner: new ClaudeCodeRunner(), onProgress: progress.onProgress },
        );
      } finally {
        // try/finally, never success-only: a leaked interval keeps the event
        // loop alive and hangs process exit on the error path.
        progress.stop();
        await unregisterActiveRun(process.pid);
      }
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
        styles: styleEnabled(),
      })) {
        log(line);
      }
      if (result.sessionFailed) return 1;
      return postingExitCode(posted);
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
    }
  } finally {
    await releasePidLock(lockPath);
    await runGc({
      home,
      repoId: repoHome.repoId,
      dryRun: false,
      silent: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Inline review surface orchestration (ROADMAP B6, WU6) — the ONLY place
// that composes inline.ts's pure plan with pr.ts's I/O primitives into the
// actual post sequence. Shared verbatim by reviewPr's step 14 (a review that
// just finished) and postCommand (a review read off disk): the SAME code
// posts either way, because a finding does not know or care whether it came
// from a fresh run or a `--from <run-dir>` replay.
//
// `spawnFn` is the same invisible-to-production seam pr.ts's own B6
// functions already use (see gh()'s WHY comment there) — threaded through
// here so test/cli.test.ts can drive the WHOLE sequence, including the
// summary PATCH, through one shared fake gh.

// The exact oracle behind `droppedFindingIds` (design D6's exit-1 rule),
// pinned as its own pure function — WARN-1 (verify-report-pr3, #3305): under
// the CRIT-A fix, a genuine drop is no longer REACHABLE through normal
// execution (every finding the plan classified fresh now ends up in exactly
// one of `reachedIds` or the demoted-and-matched set), which is the correct
// outcome but leaves the formula itself untestable through composition
// alone — the only way to exercise a non-empty result is a hand-built
// `reached` set, exactly the way `postingExitCode` is already tested against
// a hand-built literal. Extracted so a future regression in the SET
// arithmetic (not the posting sequence) is still caught.
export function computeDroppedFindingIds(
  expectedFresh: PrHeroFindingRef[],
  reached: ReadonlySet<string>,
): string[] {
  const expectedIds = new Set(expectedFresh.map((f) => f.id));
  return [...expectedIds].filter((id) => !reached.has(id));
}

export interface InlinePostOutcome {
  reviewOutcome: "posted" | "demoted";
  reviewFindingCount: number;
  // Always [] this slice (issues #16/#17): findings no longer POST as
  // standalone issue comments. Kept on the outcome so the receipt's
  // `issue_comment_ids` shape stays unchanged.
  issueCommentIds: number[];
  // Un-anchorable findings plus any 422-demoted review findings that landed
  // in the summary Outside Diff section. Counted separately from
  // issueCommentIds so the posted: log can name the bucket without lying
  // that those findings became issue comments.
  outsideDiffCount: number;
  summary: { action: "created" | "updated"; commentId: number };
  delta: PostPlan["delta"];
  // Finding ids the plan classified as fresh (reviewComments + issueComments)
  // that, after posting completed WITHOUT throwing, reached NEITHER the
  // review NOR the summary Outside Diff bucket — the exact shape of the bug
  // CRIT-1 (verify-report-pr2, #3296) found: a claimed comment swallowing a
  // genuinely new finding. Computed independently of postPrReview's own
  // return value on purpose — this is the caller's OWN check, not a re-read
  // of the primitive's opinion, because trusting the primitive's opinion is
  // exactly what let CRIT-1 through undetected in PR2's own test suite.
  droppedFindingIds: string[];
  // findingId -> the url of the comment that finding now lives at (persisting
  // from a prior run, or posted by this one). Built by buildCommentUrlMap for
  // the summary's index; handed OUT as well so the terminal's result block can
  // link each finding to the thread the reader will reply in rather than to a
  // read-only blob view. Deliberately NOT in post.json: writePostReceipt names
  // its fields one by one, so the receipt's shape is unchanged, and a Map
  // would JSON.stringify to `{}` anyway.
  commentUrls: ReadonlyMap<string, string>;
  // GitHub #39: the PR's head as GitHub reported it immediately before the
  // review submission, when it was NOT the head this run reviewed. Undefined
  // on an unmoved head AND on a re-read that could not be made — the two are
  // deliberately indistinguishable here, because the only thing this field
  // authorizes is a notice, and a notice needs a confirmed mismatch. Handed
  // out so the terminal block can print the same disclosure the summary
  // comment carries, and so the caller can say it in the run log at the
  // moment it happened.
  movedHeadSha: string | undefined;
}

// Fetch + anchor + plan, with NO posting — the exact subset `post --dry-run`
// needs (spec "Dry-run from a prior run directory": a read-only comment
// fetch, zero mutating HTTP calls) and the first half of postInlineFindings,
// factored out so the two never compute two different plans for the same
// state.
async function resolveInlinePostPlan(input: {
  operatorRoot: string;
  pr: number;
  headSha: string;
  doc: FindingsDocument;
  diffPatch: string;
  spawnFn?: typeof Bun.spawn;
}): Promise<{
  plan: PostPlan;
  previousHeadSha: string | undefined;
  // Whether a marked summary comment already exists on the PR — threaded
  // through so postInlineFindings knows whether to CREATE the summary up
  // front (design rework: create-first fixes the summary's position in the
  // timeline; see postInlineFindings's own WHY) or leave a pre-existing one
  // alone until the closing PATCH.
  existingSummaryId: number | null;
  // The FULL finding list the plan matched against — threaded through to
  // postPrReview's 422 recovery so it can re-match with the SAME finding
  // set the plan used, never a narrower one (CRIT-A, verify-report-pr3
  // #3305: re-matching a subset can dissolve a tie the plan already
  // resolved). See ReviewSubmissionOutcome's WHY in pr.ts.
  findingRefs: PrHeroFindingRef[];
  posted: PostedFindingComment[];
}> {
  const issueComments = await fetchPrComments(input.operatorRoot, input.pr, {
    spawnFn: input.spawnFn,
  });
  const existingSummaryId = findMarkedCommentId(issueComments);
  const previousHeadSha =
    existingSummaryId === null
      ? undefined
      : (parseMarkerHead(
          issueComments.find((c) => c.id === existingSummaryId)?.body ?? "",
        ) ?? undefined);
  const posted = await fetchPostedFindingComments(
    input.operatorRoot,
    input.pr,
    { spawnFn: input.spawnFn },
  );
  const anchors = parseHunkAnchors(input.diffPatch);
  const findingRefs: PrHeroFindingRef[] = input.doc.findings.map((f) => {
    const ref = {
      id: f.id,
      path: f.path,
      line: f.line,
      claim: f.claim,
      tier: f.tier,
      proof_refs: f.proof_refs,
    };
    // Resolve here, not only inside buildPostPlan: postPrReview's 422
    // rematch uses this same list as `allFindings`, and CRIT-A requires
    // that rematch to see the SAME lines the plan matched against. A
    // re-anchored 544→938 finding compared at 544 against a comment stored
    // at 938 would miss the persist and duplicate. Original order is
    // load-bearing (a persist-first reorder dissolves the CRIT-A tie).
    const postLine = resolvePostLine(ref, anchors);
    return postLine === undefined ? ref : { ...ref, line: postLine };
  });
  const plan = buildPostPlan({
    findings: findingRefs,
    anchors,
    posted,
    headSha: input.headSha,
  });
  return { plan, previousHeadSha, existingSummaryId, findingRefs, posted };
}

// A finding's own posted comment, as a clickable link for the summary's
// index (Juanma's PR #2 feedback: each index line links to its own
// comment). GitHub's fragment conventions for the two comment families
// differ — a REVIEW (inline) comment anchors on `#discussion_r<id>`, a
// top-level issue comment on `#issuecomment-<id>` — so the channel the
// comment actually landed in decides the shape, never guessed from one.
function findingCommentUrl(
  webUrl: string,
  pr: number,
  channel: "review" | "issue",
  id: number,
): string {
  const fragment =
    channel === "review" ? `discussion_r${id}` : `issuecomment-${id}`;
  return `${webUrl}/pull/${pr}#${fragment}`;
}

// Watchdog for the verified-gone collapse loop's `gh` calls. Every LLM step
// in the pipeline is bounded by `stepTimeoutMs`; the collapse loop's two gh
// calls were the only awaits on the `--post` path with no bound at all, and
// an accepted-but-unanswered GitHub request there hangs `review --pr --post`
// forever — including an unattended `--yes` run launched by the watcher,
// where nothing is present to notice or ^C it. Two minutes is generous for a
// single REST/graphql round trip and still finite; the failure it converts is
// "hangs until someone kills it" → "one logged line, thread left open".
const COLLAPSE_GH_TIMEOUT_MS = 120_000;

// The actual post sequence (design D6, reordered per Juanma's PR #2
// feedback item 2; W2 issues #16/#17 retire the issue-comment loop):
// summary CREATED FIRST when none exists yet → review submission (with
// 422 recovery into the summary Outside Diff bucket) → summary PATCHED
// LAST with the final delta, comment links, and the Outside Diff union.
// NO `sessionFailed` awareness here — same contract as pr.ts's own
// primitives (see postPrReview's own WHY): the guard belongs to the
// caller that decides whether to invoke this at all (postInlineIfEligible,
// below).
//
// WHY create-first: the summary was landing BELOW every finding in the
// Conversation timeline (real posted evidence: review comments 13:12:43,
// summary 13:12:45) because it was created LAST. Creation order fixes a
// comment's position; a PATCH never moves it. So on a PR with no summary
// yet, this posts a placeholder summary — the full index, the PLANNED
// Outside Diff bucket (known before any write), and the PLANNED delta,
// just without per-finding review-comment links (they do not exist yet)
// — as the FIRST write of the run, then patches it again at the end with
// the ACTUAL delta, the links, and any 422-demoted findings that joined
// the bucket. On a re-run (a summary already exists), the early create is
// skipped entirely: that comment's position was already fixed by a
// PREVIOUS run, and creating again would either duplicate it or waste an
// API call patching it twice.
// The final PATCH's delta-must-describe-what-was-posted invariant (PR2
// verification, WARN-3) is unchanged — the placeholder is provisional, the
// closing PATCH is authoritative, same as before this rework.

// One wording PER refusal, each said by both the post sequence's precondition
// and `post --dry-run`'s preview of it. The preview and the post disagreeing
// about whether a run dir may be published is the failure the whole $0-gate
// suite exists to prevent, and two hand-written messages is how that starts.
function missingRereviewBlockMessage(pr: number, summaryId: number): string {
  return (
    `PR #${pr} already carries a pr-hero summary (comment ${summaryId}), so ` +
    "this post is a re-review — but the run directory carries no `rereview` " +
    "block in its pipeline.json, so the summary would report the old " +
    'absence matcher\'s "N resolved" and write no state block. Re-run ' +
    `\`pr-hero review --pr ${pr} --post\` instead.`
  );
}

// The same rule read in the other direction. Same shared-wording reason, and
// it names the mismatch specifically: the run dir describes a re-review of a
// summary the PR no longer has.
function vanishedPriorSummaryMessage(pr: number): string {
  return (
    "The run directory carries a `rereview` block in its pipeline.json, so " +
    `this post is a re-review — but PR #${pr} no longer carries a pr-hero ` +
    "summary comment for it to be a re-review OF. Its `live[]` rows, " +
    "`resolved_ids` and `R###` numbering all name review threads the PR has " +
    "no record of, so this would publish a brand new summary claiming a " +
    `delta against a review that is not there. Re-run \`pr-hero review --pr ` +
    `${pr} --post\` instead.`
  );
}

// The `--pr --post` half of the same state (see the guard's WHY below): that
// caller does not refuse, it drops the re-review framing and says so. Loud on
// purpose — an operator who sees a first-review comment where a delta was
// expected must be able to read WHY off the run log instead of suspecting the
// re-review silently broke. A silent downgrade would be the same class of
// defect as a guard that never fires.
function vanishedPriorSummaryDegradedMessage(pr: number): string {
  return (
    "warning: the pr-hero summary comment this re-review was computed " +
    `against is gone from PR #${pr} — deleted, or never re-findable, while ` +
    "the review ran. Its `live[]` rows and `R###` ids name review threads " +
    "the PR has no record of, so this post drops the re-review framing: no " +
    "`Δ since` delta, no `Still live:` list and no state block. The findings " +
    "themselves are published, as the first review of what the PR carries " +
    `now. Re-run \`pr-hero review --pr ${pr} --post\` if you want a full ` +
    "re-review against the PR's current state."
  );
}

export async function postInlineFindings(input: {
  operatorRoot: string;
  pr: number;
  headSha: string;
  doc: FindingsDocument;
  diffPatch: string;
  webUrl: string | undefined;
  spawnFn?: typeof Bun.spawn;
  rereview?: RereviewProvenance;
  rereviewPriors?: readonly {
    id: string;
    claim: string;
    locs: readonly string[];
  }[];
  // Watchdog for the collapse loop's gh calls. A seam, like `spawnFn`: no
  // production caller sets it, the tests drive the timeout path with it.
  ghTimeoutMs?: number;
  // Set ONLY by `post --from` (`runPostCommand`). A PR that already carries a
  // pr-hero summary is by definition a re-review, so publishing it without a
  // `rereview` block renders the absence-matcher delta ("N resolved") and no
  // state block — the PR 1759 shape, observed live on PR #49. That caller
  // reconstructs the block from the run's `pipeline.json` and cannot see the
  // PR, so it asks the sequence owner — which has just read the comments — to
  // enforce the precondition and refuse before any write.
  //
  // A flag rather than an unconditional invariant, for two reasons that are
  // not stylistic — and BOTH of them are about this direction only, a
  // `rereview` block that is ABSENT. The `--pr --post` path computes its own
  // case from the same comments and reaches `rereview === undefined` only in
  // case A (no summary head AND no finding markers), so the check is
  // structurally dead there — except in one race, a summary created by a
  // concurrent run between this run's phase-B fetch and this one, where
  // aborting a review that has already been paid for would be the wrong
  // direction of error. And the existing postInlineFindings suites script
  // prior summaries with no block on purpose; the flag keeps this a
  // `post --from` rule, not a rewrite of what a first-review post means.
  //
  // Neither reason survives the trip to the OPPOSITE direction — a `rereview`
  // block whose summary has vanished — which is why that case carries its own
  // flag below instead of riding on this one. Gating it here is precisely
  // what left it structurally dead on `--pr --post`, the primary path.
  requireRereviewOnPriorSummary?: boolean;
  // Also set ONLY by `post --from` (`runPostCommand`), and deliberately NOT
  // the mirror of the flag above: unset, the vanished-summary case degrades
  // rather than passing. The two callers meet the same state having paid very
  // different prices for it — see the guard's own WHY below.
  refuseOnVanishedPriorSummary?: boolean;
}): Promise<InlinePostOutcome> {
  const { operatorRoot, pr, headSha, doc, webUrl, spawnFn } = input;
  const ghTimeoutMs = input.ghTimeoutMs ?? COLLAPSE_GH_TIMEOUT_MS;
  const { plan, previousHeadSha, existingSummaryId, findingRefs, posted } =
    await resolveInlinePostPlan(input);

  // Before the create-first POST and before the review submission — the last
  // point at which refusing costs nothing. Keyed on `existingSummaryId`, not
  // on `previousHeadSha`: a summary whose `head=` will not parse is still a
  // prior review, and rendering the matcher delta over it is still the lie.
  if (
    input.requireRereviewOnPriorSummary === true &&
    input.rereview === undefined &&
    existingSummaryId !== null
  ) {
    throw new CliError(missingRereviewBlockMessage(pr, existingSummaryId));
  }

  // The mirror STATE, at the same point — and deliberately NOT the mirror
  // ANSWER. The run dir CAN carry a valid `rereview` block while the summary
  // it was computed against is gone from the PR: deleted mid-run (the window
  // is real — the comments are read in phase B, the pipeline then runs 8-25
  // minutes), or `post --from` run long after `review`, which this seam
  // deliberately allows. Then `existingSummaryId === null` falls into the
  // create-first branch below and, left alone, `renderBody`/`overlayDelta`
  // publish a BRAND NEW comment full of re-review vocabulary sourced from a
  // stale directory: a delta counted in `unconfirmed`/`carried`, a `Still
  // live:` list of `R###` ids, a state block — none of it naming a thread
  // that exists.
  //
  // The two callers meet that state having paid very different prices, so
  // they answer it differently ON PURPOSE. Only `post --from` sets
  // `refuseOnVanishedPriorSummary`:
  //   - `post --from` REFUSES. Nothing has been spent; the operator re-runs
  //     `review --pr <n> --post` and gets a correct result for free.
  //   - `--pr --post` has ALREADY paid for a full review ($2.49-$6.34 on this
  //     repo). Throwing that away to avoid a stale framing is the wrong
  //     direction of error — the very rule the flag above cites. So it posts,
  //     with the re-review framing DROPPED (`framing` below): no delta
  //     overlay, no `Still live:`, no state block. That is not a downgrade of
  //     the findings, it is an accurate description of what the run now is —
  //     the review this one was a re-review OF is no longer on the PR, so
  //     what remains is a first review of the current state, and the findings
  //     are as valid as they were a minute ago. The degradation is LOGGED,
  //     never silent: a quiet downgrade would be the same class of defect as
  //     a guard that never fires, which is exactly what this one was while it
  //     hung off `requireRereviewOnPriorSummary`.
  //
  // Narrowed to `summary_marker` on purpose: a block whose L came from
  // `finding_markers` was ALREADY computed with no summary in sight, so a
  // missing summary at post time is agreement, not drift — and its R### ids
  // name finding threads that do still exist. Refusing OR degrading there
  // would break obligation S-A ("with the summary comment absent, L is
  // recovered from per-finding markers and the run does NOT fall to
  // first-review semantics"), which is a case the design supports rather
  // than a hazard.
  const priorSummaryVanished =
    input.rereview?.last_head_source === "summary_marker" &&
    existingSummaryId === null;
  if (priorSummaryVanished && input.refuseOnVanishedPriorSummary === true) {
    throw new CliError(vanishedPriorSummaryMessage(pr));
  }
  if (priorSummaryVanished) log(vanishedPriorSummaryDegradedMessage(pr));

  // Every re-review-framed surface reads off THIS, never `input.rereview`
  // directly — the delta overlay, the `Still live:` list it carries, and the
  // state block appended after the report marker. The collapse loop at the
  // bottom deliberately does NOT: a verified-gone prior's ✅ reply and thread
  // resolve are bound to per-finding REVIEW threads, which the summary
  // comment's disappearance says nothing about, and `--pr --post` binds them
  // through priors it is still holding in memory. Suppressing those would
  // leave a thread that IS gone sitting open on the PR.
  const framing = priorSummaryVanished ? undefined : input.rereview;
  const rereviewDelta =
    framing === undefined
      ? undefined
      : rereviewDeltaFromProvenance(framing, doc.findings.length);
  const overlayDelta = (delta: PrCommentDelta): PrCommentDelta =>
    rereviewDelta === undefined ? delta : { ...delta, rereview: rereviewDelta };
  const renderBody = (
    delta: PrCommentDelta,
    outside: readonly Finding[],
    moved: string | undefined,
    urls?: ReadonlyMap<string, string>,
  ): string => {
    const body = renderPrComment(
      doc,
      webUrl,
      overlayDelta(delta),
      outside,
      moved,
      urls,
    );
    if (framing === undefined) return body;
    return `${body}${renderStateBlock(doc.head_sha, framing.live)}`;
  };

  const byId = new Map(doc.findings.map((f) => [f.id, f]));
  const findingsFor = (refs: PrHeroFindingRef[]): Finding[] =>
    refs
      .map((ref) => {
        const found = byId.get(ref.id);
        if (found === undefined) return undefined;
        // The planner may have moved `line` onto a hunter-cited in-diff
        // proof_ref (Musive #1727). GitHub's `line` and the finding marker
        // must share that post line or a re-run duplicates. findings.json
        // keeps the original line; only the posted comment is overlaid.
        return found.line === ref.line ? found : { ...found, line: ref.line };
      })
      .filter((f): f is Finding => f !== undefined);

  // Initial Outside Diff set: plan.issueComments stays the un-anchorable
  // bucket (field name unchanged this slice). Known before any write, so
  // the create-first POST already includes it — after the review, the
  // closing PATCH may grow it with 422-demoted findings.
  const plannedOutsideDiff = findingsFor(plan.issueComments);

  // The id this run's own creation just returned, if any — threaded to the
  // closing PATCH below so it updates THIS comment directly rather than
  // re-discovering it by marker (postPrComment's `knownCommentId`; see its
  // own WHY).
  let summaryCommentId = existingSummaryId;
  if (existingSummaryId === null) {
    const plannedDelta: PrCommentDelta = { ...plan.delta, previousHeadSha };
    const created = await postPrComment(
      operatorRoot,
      pr,
      // `movedHeadSha: undefined` — the re-read has not happened yet, and it
      // deliberately does not happen before this write. Same shape as the
      // absent link map above: the placeholder is provisional, the closing
      // PATCH is authoritative, and the re-read belongs as close to the
      // ANCHOR-BEARING call as it can get, not one write earlier.
      renderBody(plannedDelta, plannedOutsideDiff, undefined),
      spawnFn,
    );
    summaryCommentId = created.commentId;
  }

  const reviewFindings = findingsFor(plan.reviewComments);
  const reachedIds = new Set<string>();

  // GitHub #39 — the head re-read, HERE and not inside postPrReview, for one
  // reason that is not stylistic: postPrReview returns early on zero
  // anchorable findings without touching gh at all (spec "Zero anchorable
  // findings"), and a run with nothing to anchor STILL publishes a summary
  // comment — the ✅ clean bill included. That summary read against a head
  // the PR has since moved past is the same undisclosed staleness the issue
  // is about, so the check belongs to the sequence owner, which posts on
  // every path, rather than to the primitive that sometimes does not.
  //
  // Immediately before the review submission: this is the tightest window
  // available around the anchor-bearing call, and the window is the whole
  // point — a check run minutes earlier would answer a question about a
  // different moment. The comparison happens exactly ONCE, here, and both
  // surfaces render the same answer; deriving it twice is how two surfaces
  // start disagreeing about whether the PR moved.
  //
  // Never aborts, never filters, never re-runs anything. What a re-review
  // should DO about findings computed on a stale head is ROADMAP item 7's
  // design work, and with `commit_id` pinned (pr.ts) the answer here
  // collapses to a sentence: post, pinned, and say which commit this is
  // about. Silently dropping the post would be the invisible loss this
  // project's direction-of-error rule ranks worst.
  const liveHeadSha = await ghPrHeadSha(operatorRoot, pr, { spawnFn });
  const movedHeadSha =
    liveHeadSha !== undefined && liveHeadSha !== headSha
      ? liveHeadSha
      : undefined;

  const reviewResult = await postPrReview({
    operatorRoot,
    pr,
    headSha,
    findings: reviewFindings,
    // The FULL finding list, not just `reviewFindings` — see
    // ReviewSubmissionOutcome's WHY in pr.ts (CRIT-A, verify-report-pr3
    // #3305). This is exactly the line a caller could silently narrow and
    // reintroduce the tie-dissolution bug; test/cli.test.ts's tie-repro
    // fails if this is ever swapped back to `reviewFindings`.
    allFindings: findingRefs,
    webUrl,
    spawnFn,
  });
  // On 422, reviewResult.findings JOIN the Outside Diff set instead of
  // posting as issue comments (issues #16/#17). Dedupe by id so a finding
  // cannot appear twice if it somehow sat in both buckets.
  let outsideDiff = plannedOutsideDiff;
  if (reviewResult.outcome === "posted") {
    for (const finding of reviewFindings) reachedIds.add(finding.id);
  } else {
    const stillUnmatched = new Set(
      reviewResult.findings.map((finding) => finding.id),
    );
    for (const finding of reviewFindings) {
      if (!stillUnmatched.has(finding.id)) reachedIds.add(finding.id);
    }
    const already = new Set(outsideDiff.map((finding) => finding.id));
    outsideDiff = [
      ...outsideDiff,
      ...reviewResult.findings.filter((finding) => !already.has(finding.id)),
    ];
  }

  // Outside Diff findings reached the summary — they must not fire
  // droppedFindingIds. No rematch-before-POST: that block existed only to
  // prevent duplicate issue comments, and this slice posts none. Re-review
  // identity for the bucket is the next slice.
  for (const finding of outsideDiff) reachedIds.add(finding.id);

  // Receipt shape unchanged this slice: issue_comment_ids stays [].
  const issueCommentIds: number[] = [];

  const droppedFindingIds = computeDroppedFindingIds(
    [...plan.reviewComments, ...plan.issueComments],
    reachedIds,
  );

  const commentUrlByFindingId = await buildCommentUrlMap({
    operatorRoot,
    pr,
    headSha,
    webUrl,
    spawnFn,
    persisting: plan.persisting,
    issueIdByFindingId: new Map(),
    freshlyPostedReview:
      reviewResult.outcome === "posted" ? reviewFindings : [],
  });

  const delta: PrCommentDelta = { ...plan.delta, previousHeadSha };
  const patched = await postPrComment(
    operatorRoot,
    pr,
    renderBody(delta, outsideDiff, movedHeadSha, commentUrlByFindingId),
    spawnFn,
    summaryCommentId ?? undefined,
  );
  // `patched.action` is always "updated" once the create-first branch above
  // ran (this call PATCHes the comment it just created), which would report
  // a first-EVER run as "updated" — misleading to a human reading the log
  // or post.json. The outward-facing action names whether THIS RUN created
  // the summary at all (existingSummaryId was null before this run), not
  // which HTTP verb the LAST of its two calls happened to use.
  const summary = {
    action: existingSummaryId === null ? ("created" as const) : patched.action,
    commentId: patched.commentId,
  };

  if (input.rereview !== undefined) {
    const targets = collapseTargets({
      verifiedGoneIds: input.rereview.resolved_ids ?? [],
      priors: input.rereviewPriors ?? [],
      posted,
    });
    for (const target of targets) {
      if (target.channel !== "review") continue;
      // The reply is bounded AND caught, and a failure `continue`s past the
      // resolve on purpose. Resolving a thread whose ✅ reply never landed
      // closes the conversation with no explanation of why — a silent
      // resolve, which is the same false `resolved` the whole verified-gone
      // path is built to never produce. Degrading to "thread left open" is
      // always the safe direction: the finding stays visible on the PR.
      try {
        await postReviewCommentReply({
          operatorRoot,
          pr,
          inReplyTo: target.commentId,
          body:
            "✅ **RESOLVED** · verified gone\n\n" +
            "This finding was checked at the current head and is no longer present.\n",
          spawnFn,
          timeoutMs: ghTimeoutMs,
        });
      } catch (error) {
        log(
          `collapse skipped for ${target.priorId}: the verified-gone reply did ` +
            `not post (${error instanceof Error ? error.message : String(error)}) ` +
            "— thread left open",
        );
        continue;
      }
      try {
        const resolveOutcome = await resolveReviewThreadForComment({
          operatorRoot,
          pr,
          commentId: target.commentId,
          spawnFn,
          timeoutMs: ghTimeoutMs,
        });
        if (resolveOutcome === "resolved") {
          log(`resolved: review thread for ${target.priorId} (verified-gone)`);
        } else if (resolveOutcome === "already-resolved") {
          log(`resolved: thread already closed for ${target.priorId}`);
        } else {
          log(
            `resolve skipped: no review thread found for comment ${target.commentId}`,
          );
        }
      } catch (error) {
        log(
          `resolve failed for ${target.priorId} after the verified-gone reply posted: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return {
    reviewOutcome: reviewResult.outcome,
    reviewFindingCount: reviewFindings.length,
    issueCommentIds,
    outsideDiffCount: outsideDiff.length,
    summary,
    delta: overlayDelta(plan.delta),
    droppedFindingIds,
    commentUrls: commentUrlByFindingId,
    movedHeadSha,
  };
}

// Maps every CURRENTLY-live finding (persisting from a prior run, or
// freshly posted this run) to its own comment's URL, for the summary's
// closing PATCH (Juanma's PR #2 feedback: each index line links to its own
// comment). Two sources, none of which can be read off the plan alone:
//   - persisting matches already carry the prior comment's id/channel
//     (`plan.persisting`, from inline.ts's matcher) — free, no extra fetch;
//     leftover W1 issue-comment orphans still resolve here via channel
//     "issue";
//   - fresh REVIEW comments' ids are NOT returned by `POST .../reviews` at
//     all (GitHub's response is the review object, not its comments[]), so
//     the only way to learn them is a follow-up read-only fetch, matched
//     back to a finding by the SAME marker fields the identity contract
//     already uses (path, line, this run's headSha, and the claim
//     fingerprint) — deterministic here because this run posted them
//     moments ago with exactly those fields.
// Fresh un-anchorable findings have no per-finding comment (issues #16/#17:
// they land in the summary Outside Diff section), so they contribute no
// url; the index line stays unlinked. `issueIdByFindingId` is kept so a
// leftover caller can still hand ids through; postInlineFindings passes
// an empty map.
// `webUrl === undefined` skips all of it: no repo web url means no comment
// URL is buildable, and renderPrComment already degrades to plain text when
// a finding's id is absent from the map, never a broken link.
async function buildCommentUrlMap(input: {
  operatorRoot: string;
  pr: number;
  headSha: string;
  webUrl: string | undefined;
  spawnFn?: typeof Bun.spawn;
  persisting: PostPlan["persisting"];
  issueIdByFindingId: Map<string, number>;
  freshlyPostedReview: Finding[];
}): Promise<Map<string, string>> {
  const { operatorRoot, pr, headSha, webUrl, spawnFn } = input;
  const urls = new Map<string, string>();
  if (webUrl === undefined) return urls;
  for (const match of input.persisting) {
    urls.set(
      match.finding.id,
      findingCommentUrl(webUrl, pr, match.posted.channel, match.posted.id),
    );
  }
  for (const [findingId, id] of input.issueIdByFindingId) {
    urls.set(findingId, findingCommentUrl(webUrl, pr, "issue", id));
  }
  if (input.freshlyPostedReview.length > 0) {
    const freshReview = await fetchPrReviewComments(operatorRoot, pr, {
      spawnFn,
    });
    for (const finding of input.freshlyPostedReview) {
      const fingerprint = claimFingerprint(finding.claim);
      const match = freshReview.find((c) => {
        const marker = parseFindingMarker(c.body);
        return (
          marker !== null &&
          marker.path === finding.path &&
          marker.line === finding.line &&
          marker.headSha === headSha &&
          marker.c === fingerprint
        );
      });
      if (match) {
        urls.set(finding.id, findingCommentUrl(webUrl, pr, "review", match.id));
      }
    }
  }
  return urls;
}

// The `sessionFailed` guard (spec "sessionFailed suppresses all posting"):
// the single decision point for BOTH callers on whether to invoke
// postInlineFindings at all. `null` means "skipped, nothing was posted, zero
// HTTP calls were made" — the exact shape the spec's scenario asserts.
//
// Neither `requireRereviewOnPriorSummary` nor `refuseOnVanishedPriorSummary`
// is declared here, and that absence is the contract, not an oversight: this
// is the `--pr --post` entry point, the one that has already paid for a full
// review, and both flags exist to make `post --from` refuse where refusing is
// free. See their WHYs on postInlineFindings.
export async function postInlineIfEligible(input: {
  sessionFailed: boolean;
  skippedReason: string;
  operatorRoot: string;
  pr: number;
  headSha: string;
  doc: FindingsDocument;
  diffPatch: string;
  webUrl: string | undefined;
  spawnFn?: typeof Bun.spawn;
  rereview?: RereviewProvenance;
  rereviewPriors?: readonly {
    id: string;
    claim: string;
    locs: readonly string[];
  }[];
}): Promise<InlinePostOutcome | null> {
  if (input.sessionFailed) {
    log(input.skippedReason);
    return null;
  }
  return postInlineFindings(input);
}

// Design D6's exit-code rule, pinned as its own pure function so the rule is
// testable without a live post: exit 1 ONLY when a finding reached neither
// channel (the CRIT-1 failure mode); a `null` outcome (sessionFailed, or
// `--post` never given) is not itself a posting failure — its caller already
// decides the exit code on its own terms (e.g. reviewPr's sessionFailed
// early-return above).
export function postingExitCode(outcome: InlinePostOutcome | null): 0 | 1 {
  if (outcome === null) return 0;
  return outcome.droppedFindingIds.length > 0 ? 1 : 0;
}

// post.json — the receipt (design's File Changes table): channel, comment
// ids, demotions, mirroring pipeline.json's provenance role so the
// idempotency proof (WU7/4.4) can read back exactly what a run posted
// without re-deriving it from GitHub.
async function writePostReceipt(
  runDir: string,
  pr: number,
  headSha: string,
  outcome: InlinePostOutcome,
): Promise<void> {
  const receipt = {
    pr,
    head_sha: headSha,
    generated_at: new Date().toISOString(),
    review: {
      outcome: outcome.reviewOutcome,
      finding_count: outcome.reviewFindingCount,
    },
    issue_comment_ids: outcome.issueCommentIds,
    summary_comment: outcome.summary,
    delta: outcome.delta,
    dropped_finding_ids: outcome.droppedFindingIds,
  };
  await Bun.write(
    path.join(runDir, "post.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

// Pure on purpose (design Threat Matrix, "Git repository selection" row,
// deferred from PR2's verification): --from names a directory on disk, and
// nothing stops it from pointing at a DIFFERENT PR's run than --pr names.
// findings.json's own `pr` field is the one thing that cannot lie about
// which review it came from — checked here, before any fetch or post,
// rather than trusting the operator to keep --pr and --from in sync by hand.
export function assertRunMatchesPr(
  doc: FindingsDocument,
  pr: number,
  runDir: string,
): void {
  if (doc.pr !== pr) {
    throw new CliUsageError(
      `${runDir} is a run of PR #${doc.pr}, not PR #${pr} — point --from ` +
        "at a run directory for the PR you are posting to",
    );
  }
}

// `pr-hero post --pr <n> --from <run-dir> [--dry-run]` (ROADMAP B6, spec
// "Offline replay via `post` verb"): the `ledger` verb's precedent — read a
// prior run's artifacts off disk — applied to publishing instead of
// aggregating. Exists because PR-mode `--dry-run` returns at reviewPr's own
// step 3, BEFORE any findings exist (see the comment there): it is
// structurally impossible for `--pr --dry-run` to preview a comment plan, so
// this verb is the only way to preview one at $0.
//
// `postCommand` itself stays unexported and untestable on purpose — it is
// nothing but `resolveRepoRoot` (a real `git rev-parse`) plus flag
// narrowing. Everything that can actually go wrong (dry-run vs live, the
// run-status guard, `assertRunMatchesPr`, the receipt) lives in
// `runPostCommand`, exported and `spawnFn`-injectable on EVERY gh-touching
// path including dry-run (CRIT-B, verify-report-pr3 #3305: an unexported
// verb whose dry-run branch never threaded spawnFn could not be proven not
// to reach a real `gh` — this is the $0 gate standing in front of the first
// live GitHub write this project will ever make, and it must not be
// possible to invert it with a green suite).
async function postCommand(options: CliOptions): Promise<number> {
  const operatorRoot = await resolveRepoRoot(options.repo);
  // parseArgs already enforces both of these for the "post" command; the
  // checks here are the type-narrowing TypeScript needs, not new validation.
  if (options.pr === undefined) {
    throw new CliUsageError("post requires --pr <n>");
  }
  if (options.from === undefined) {
    throw new CliUsageError("post requires --from <run-dir>");
  }
  const prNumber =
    options.pr === "current"
      ? resolveCurrentPrNumber(await ghCurrentBranchPr(operatorRoot))
      : options.pr;
  return runPostCommand({
    operatorRoot,
    pr: prNumber,
    from: options.from,
    dryRun: options.dryRun,
  });
}

export async function runPostCommand(input: {
  operatorRoot: string;
  pr: number;
  from: string;
  dryRun: boolean;
  spawnFn?: typeof Bun.spawn;
}): Promise<number> {
  const { operatorRoot, pr: prNumber, dryRun, spawnFn } = input;
  const runDir = path.resolve(input.from);
  const findingsPath = path.join(runDir, "findings.json");
  const diffPath = path.join(runDir, "diff.patch");
  if (!existsSync(findingsPath) || !existsSync(diffPath)) {
    throw new CliUsageError(
      `${runDir} is missing findings.json or diff.patch — point --from at ` +
        'a completed run directory ("pr-hero review --pr <n>" writes both)',
    );
  }
  const doc = validateFindingsDocument(
    JSON.parse(await Bun.file(findingsPath).text()),
  );
  // Design Threat Matrix, "Git repository selection" row (deferred from
  // PR2's verification, WARN-1's scope note): --from names a directory, and
  // a directory is not the PR it was reviewed for — reject a run-dir whose
  // OWN artifact disagrees with --pr rather than silently publishing PR
  // #17's findings to PR #18 because someone reused a stale --from.
  assertRunMatchesPr(doc, prNumber, runDir);
  const diffPatch = await Bun.file(diffPath).text();
  // Juanma's decision (verify-report-pr3, #3305): guard on the PERSISTED
  // `sessionFailed`, matching `--pr --post` (cli.ts's `postInlineIfEligible`
  // call, guarded on `result.sessionFailed`) exactly — a partial run with
  // findings from SOME hunters still publishes, same as the live path.
  //
  // Back-compat is mandatory: `sessionFailed` is additive/optional
  // (findings.ts), so a run written before this change has no such field.
  // Absent MUST mean "unknown", never "false" — falling back to `false`
  // would publish a dead run's clean bill. The fallback is today's
  // conservative proxy, `run_status !== "complete"`: every genuinely
  // sessionFailed run IS "partial" (mergeRunEnvelope forces it), so the
  // proxy never UNDER-fires; it can only OVER-fire on a partial run that
  // failed for some other reason, which is still the honest "do not publish
  // this as a clean review" answer.
  const sessionFailedEquivalent =
    doc.sessionFailed ?? doc.run_status !== "complete";
  if (sessionFailedEquivalent) {
    log(
      `post skipped: ${findingsPath} is not a complete run ` +
        `(run_status=${doc.run_status}), so there is no review to publish`,
    );
    return dryRun ? 0 : 1;
  }

  // Item 7, and the reason this block exists at all: a re-review's case,
  // `live[]` and verified-gone count live ONLY in the run's `pipeline.json`
  // once the process that computed them has exited. Read back here, they make
  // `post --from`'s summary say what the review actually checked; NOT read
  // back — the defect this repairs — the summary silently falls through to
  // `MatchResult.resolved`, prints "3 resolved" for 2 checks, and writes no
  // state block, which then costs the NEXT run its priors as well.
  //
  // Validated rather than trusted: a block that half-parses would feed the
  // same fallback with none of the noise. Absent is a legitimate answer (a
  // first review, or a run dir from before item 7) — the precondition inside
  // `postInlineFindings` is what tells those apart from a re-review whose
  // block went missing, because only it can see whether the PR already has a
  // summary.
  const pipelinePath = path.join(runDir, "pipeline.json");
  let rereview: RereviewProvenance | undefined;
  if (existsSync(pipelinePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Bun.file(pipelinePath).text());
    } catch (error) {
      throw new CliError(
        `${pipelinePath} is not valid JSON (${(error as Error).message}) — ` +
          "a re-review's case and live findings are only recoverable from it",
      );
    }
    const read = readRereviewProvenance(parsed);
    if (read.kind === "invalid") {
      throw new CliError(
        `${pipelinePath} has an unreadable re-review block (${read.problem}) — ` +
          "publishing it would report the old absence matcher's counts and " +
          `write no state block. Re-run \`pr-hero review --pr ${prNumber} --post\`.`,
      );
    }
    if (read.kind === "ok") rereview = read.rereview;
  }

  // The one field of the `--pr --post` call that a run directory genuinely
  // cannot supply. Collapse binds every verified-gone id to its review thread
  // through the FULL prior set (`bindPriorsToPosted`, one-to-one over carried
  // priors too) — and `live[]` is not that set: `assembleLive` retires a
  // verified-gone entry from it, by design (§3.6), so the very rows collapse
  // needs are the rows the artifact no longer holds. Re-deriving them from
  // the PR at post time is not a substitute either: the `state === null`
  // fallback renumbers `R###` positionally, so ids from `resolved_ids` would
  // point at whichever comments happen to sit in those positions now — the
  // exact over-match that puts "✅ RESOLVED · verified gone" on a live
  // finding.
  //
  // So: nothing verified gone → `[]` is the whole truth and collapse is a
  // no-op. Something verified gone → refuse, loudly, and name the path that
  // still holds the priors in memory. A `post --from` that published the
  // right summary and silently skipped the collapse it cannot compute would
  // be the third thing this feature forbids.
  const verifiedGoneIds = rereview?.resolved_ids ?? [];
  if (verifiedGoneIds.length > 0) {
    throw new CliError(
      `${pipelinePath} records ${verifiedGoneIds.length} verified-gone ` +
        `finding(s) (${verifiedGoneIds.join(", ")}), and their prior records ` +
        "are not in the run directory — `live[]` retires a verified-gone " +
        "entry — so `post --from` cannot bind them to their review threads " +
        `to collapse them. Re-run \`pr-hero review --pr ${prNumber} --post\`, ` +
        "which holds the priors from the run that checked them.",
    );
  }

  if (dryRun) {
    const { plan, previousHeadSha, existingSummaryId } =
      await resolveInlinePostPlan({
        operatorRoot,
        pr: prNumber,
        headSha: doc.head_sha,
        doc,
        diffPatch,
        spawnFn,
      });
    // The preview refuses whatever the post would refuse. A dry run that
    // prints a plan for a run dir the live path then rejects is a $0 gate
    // that answered a different question than the one asked.
    if (rereview === undefined && existingSummaryId !== null) {
      throw new CliError(
        missingRereviewBlockMessage(prNumber, existingSummaryId),
      );
    }
    // Both directions, or the preview is only half a gate — and narrowed to
    // `summary_marker` for the same reason the live guard is (S-A).
    if (
      rereview?.last_head_source === "summary_marker" &&
      existingSummaryId === null
    ) {
      throw new CliError(vanishedPriorSummaryMessage(prNumber));
    }
    log(
      `plan: ${plan.reviewComments.length} review comment(s), ` +
        `${plan.issueComments.length} outside diff, ` +
        `${plan.persisting.length} already posted (skipped)` +
        (previousHeadSha === undefined
          ? `, ${plan.resolved.length} resolved`
          : ""),
    );
    if (previousHeadSha === undefined) {
      log(
        `delta: ${plan.delta.resolved} resolved · ${plan.delta.new} new · ` +
          `${plan.delta.persist} persist`,
      );
    } else {
      log(
        `delta: re-review (MatchResult.resolved not shown; gate outcomes only)`,
      );
    }
    for (const finding of plan.reviewComments) {
      log(`  review  ${finding.path}:${finding.line} ${finding.id}`);
    }
    for (const finding of plan.issueComments) {
      log(`  outside ${finding.path}:${finding.line} ${finding.id}`);
    }
    log("dry run: nothing was fetched-for-mutation or posted.");
    return 0;
  }

  const repoWebUrl = await ghRepoWebUrl(operatorRoot, { spawnFn });
  if (repoWebUrl === undefined) {
    log("repo web url unavailable: posting plain locations");
  }
  const outcome = await postInlineFindings({
    operatorRoot,
    pr: prNumber,
    headSha: doc.head_sha,
    doc,
    diffPatch,
    webUrl: repoWebUrl,
    spawnFn,
    ...(rereview === undefined ? {} : { rereview, rereviewPriors: [] }),
    requireRereviewOnPriorSummary: true,
    refuseOnVanishedPriorSummary: true,
  });
  await writePostReceipt(runDir, prNumber, doc.head_sha, outcome);
  log(
    `posted: review ${outcome.reviewOutcome} (${outcome.reviewFindingCount} ` +
      `finding(s)), ${outcome.outsideDiffCount} outside diff, ` +
      `summary ${outcome.summary.action} comment ${outcome.summary.commentId}`,
  );
  // GitHub #39: `post --from` reaches the same `movedHeadSha` re-read inside
  // the post sequence, so it can carry the same disclosure. Unconditional,
  // not chained into the else-if below — a moved head is orthogonal to both a
  // dropped finding and a 422, and can happen alongside either.
  //
  // "Same sequence, therefore same everything" is what this comment used to
  // say, and it was false in a way that cost a live run: the sequence is
  // shared, its INPUTS are not. `--pr --post` hands over the `rereview` block
  // and the phase-B priors it is still holding; this path has only a
  // directory, so it reconstructs the block from `pipeline.json` above,
  // refuses when that block is unreadable or when collapse would need priors
  // it does not have, and passes `requireRereviewOnPriorSummary` so a missing
  // block on a PR that already has a summary cannot be published as a first
  // review. Equivalence here is enforced, never assumed.
  //
  // `refuseOnVanishedPriorSummary` is the other half of that, and it is where
  // the two paths are enforced UNEQUAL: a re-review whose summary has
  // vanished costs this caller nothing to refuse (re-run `review --pr <n>
  // --post` and the answer is correct), while refusing it on `--pr --post`
  // would discard a review already paid for. Set here, unset there.
  if (outcome.movedHeadSha) {
    log(
      `warning: the PR head moved while the review ran — reviewed ` +
        `${doc.head_sha}, head is now ${outcome.movedHeadSha}; the comments ` +
        "are pinned to the reviewed commit",
    );
  }
  if (outcome.droppedFindingIds.length > 0) {
    log(
      `error: ${outcome.droppedFindingIds.length} finding(s) reached ` +
        `neither channel: ${outcome.droppedFindingIds.join(", ")}`,
    );
  } else if (outcome.reviewOutcome === "demoted") {
    log(
      "warning: the review submission was rejected (422) and recovered " +
        "into the summary Outside Diff bucket",
    );
  }
  return postingExitCode(outcome);
}

// `pr-hero triage --pr <n> --from <run-dir> [--dry-run]` (ROADMAP B6c):
// reads the PR's review-comment threads, binds every triage reply (ROADMAP
// B6b's marker) to its finding's row in that run's comparison.json, and
// writes verdict/reasoning/actor back — the ledger's two null columns
// (pr-preflight.ts's ComparisonRow), filled from the loop instead of by
// hand. Same shell/pure split as postCommand: the binding decision lives in
// triage-write.ts (pure), this function is resolveRepoRoot plus flag
// narrowing; runTriageCommand does the actual read/fetch/write and is
// exported + spawnFn-injectable for the same CRIT-B reason runPostCommand
// is (verify-report-pr3 #3305) — a dry-run branch that could not be proven
// gh-free is not a $0 gate.
async function triageCommand(options: CliOptions): Promise<number> {
  const operatorRoot = await resolveRepoRoot(options.repo);
  // parseArgs already enforces both of these for the "triage" command; the
  // checks here are the type-narrowing TypeScript needs, not new validation.
  if (options.pr === undefined) {
    throw new CliUsageError("triage requires --pr <n>");
  }
  if (options.from === undefined) {
    throw new CliUsageError("triage requires --from <run-dir>");
  }
  const prNumber =
    options.pr === "current"
      ? resolveCurrentPrNumber(await ghCurrentBranchPr(operatorRoot))
      : options.pr;
  if (options.triage === "reply") {
    if (options.finding === undefined) {
      throw new CliUsageError("triage reply requires --finding <id>");
    }
    if (options.tag === undefined) {
      throw new CliUsageError("triage reply requires --tag <tag>");
    }
    if (options.bodyFile === undefined) {
      throw new CliUsageError("triage reply requires --body-file <path>");
    }
    return runTriageReplyCommand({
      operatorRoot,
      pr: prNumber,
      from: options.from,
      findingId: options.finding,
      tag: options.tag,
      bodyFile: options.bodyFile,
      verdict: options.verdict,
      issue: options.issue,
      dryRun: options.dryRun,
    });
  }
  return runTriageCommand({
    operatorRoot,
    pr: prNumber,
    from: options.from,
    dryRun: options.dryRun,
  });
}

export async function runTriageCommand(input: {
  operatorRoot: string;
  pr: number;
  from: string;
  dryRun: boolean;
  spawnFn?: typeof Bun.spawn;
}): Promise<number> {
  const { operatorRoot, pr: prNumber, dryRun, spawnFn } = input;
  const runDir = path.resolve(input.from);
  const comparisonPath = path.join(runDir, "comparison.json");
  if (!existsSync(comparisonPath)) {
    throw new CliUsageError(
      `${runDir} is missing comparison.json — point --from at a completed ` +
        'PR-mode run directory ("pr-hero review --pr <n>" writes it)',
    );
  }
  const raw = await Bun.file(comparisonPath).text();
  let comparison: StoredComparison;
  try {
    comparison = parseComparisonJson(raw);
  } catch (error) {
    // The pure parser names the field; only the shell knows the file.
    if (error instanceof CliUsageError) {
      throw new CliError(`${comparisonPath}: ${error.message}`);
    }
    throw error;
  }
  // Same "don't act on the wrong PR" guard runPostCommand's
  // assertRunMatchesPr gives findings.json — a run-dir named by --from is
  // not the same thing as --pr, and a stale --from must not silently triage
  // the wrong PR's ledger row.
  if (comparison.pr !== prNumber) {
    throw new CliUsageError(
      `${comparisonPath} is for PR ${comparison.pr}, not --pr ${prNumber}`,
    );
  }
  const reviewComments = await fetchPrReviewComments(operatorRoot, prNumber, {
    spawnFn,
  });
  // id -> comment, so a reply's `in_reply_to_id` resolves to its parent in
  // O(1) — both live in the SAME endpoint (pulls/<n>/comments), never
  // fetched separately: reply-threading only exists on inline review
  // comments, GitHub has no `in_reply_to_id` on top-level issue comments.
  const byId = new Map(reviewComments.map((comment) => [comment.id, comment]));
  // `gh api --paginate` returns comments in ascending-id (creation) order —
  // the SAME order applyTriageReplies needs for its last-write-wins rule,
  // so this loop feeds them through unsorted.
  const replies: TriageReplyCandidate[] = [];
  for (const comment of reviewComments) {
    if (comment.in_reply_to_id === null) continue;
    const parent = byId.get(comment.in_reply_to_id);
    // The parent was deleted, or is outside what this fetch saw —
    // applyTriageReplies would reject a missing parent anyway (no body to
    // parse), but skipping here avoids handing it a body that never
    // existed.
    if (parent === undefined) continue;
    replies.push({ parentBody: parent.body, replyBody: comment.body });
  }
  const outcome = applyTriageReplies(comparison.rows, replies);
  if (dryRun) {
    log(
      `plan: ${outcome.bound} row(s) would be triaged, ${outcome.ignored} ` +
        "reply(ies) ignored (not ours, malformed, or no matching row)",
    );
    log("dry run: comparison.json was not written.");
    return 0;
  }
  const updated: StoredComparison = { ...comparison, rows: outcome.rows };
  await Bun.write(comparisonPath, `${JSON.stringify(updated, null, 2)}\n`);
  log(
    `triaged: ${outcome.bound} row(s) written to ${comparisonPath}, ` +
      `${outcome.ignored} reply(ies) ignored`,
  );
  return 0;
}

export async function runTriageReplyCommand(input: {
  operatorRoot: string;
  pr: number;
  from: string;
  findingId: string;
  tag: TriageTag;
  bodyFile: string;
  verdict?: TriageVerdict;
  issue?: number;
  dryRun: boolean;
  spawnFn?: typeof Bun.spawn;
}): Promise<number> {
  const { operatorRoot, pr: prNumber, dryRun, spawnFn } = input;
  const runDir = path.resolve(input.from);
  const findingsPath = path.join(runDir, "findings.json");
  if (!existsSync(findingsPath)) {
    throw new CliUsageError(
      `${runDir} is missing findings.json — point --from at a completed ` +
        'PR-mode run directory ("pr-hero review --pr <n>" writes it)',
    );
  }
  const doc = validateFindingsDocument(
    JSON.parse(await Bun.file(findingsPath).text()),
  );
  assertRunMatchesPr(doc, prNumber, runDir);
  const finding = doc.findings.find((row) => row.id === input.findingId);
  if (finding === undefined) {
    throw new CliUsageError(
      `${findingsPath} has no finding ${input.findingId}`,
    );
  }
  const bodyPath = path.resolve(input.bodyFile);
  if (!existsSync(bodyPath)) {
    throw new CliUsageError(`--body-file not found: ${bodyPath}`);
  }
  const reasoning = await Bun.file(bodyPath).text();
  if (reasoning.startsWith(TRIAGE_MARKER_PREFIX)) {
    throw new CliUsageError(
      "--body-file must be reasoning prose only — the driver prepends the " +
        "triage marker and badge (do not start the file with " +
        "`<!-- pr-hero-triage`)",
    );
  }
  const diffPath = path.join(runDir, "diff.patch");
  if (!existsSync(diffPath)) {
    throw new CliUsageError(
      `${runDir} is missing diff.patch — point --from at a completed ` +
        'PR-mode run directory ("pr-hero review --pr <n>" writes it)',
    );
  }
  const diffPatch = await Bun.file(diffPath).text();
  const { identity, findingsLine } = findingIdentityForMarkerMatch({
    path: finding.path,
    line: finding.line,
    claim: finding.claim,
    proof_refs: finding.proof_refs,
    diffPatch,
  });
  const fields: TriageMarkerFields = {
    tag: input.tag,
    headSha: doc.head_sha,
    actor: "agent",
    verdict: input.verdict,
    issue: input.issue,
  };
  const body = renderTriageReplyBody(fields, reasoning);
  const posted = await fetchPostedFindingComments(operatorRoot, prNumber, {
    spawnFn,
  });
  const match = matchPostedFindingExact({
    finding: identity,
    headSha: doc.head_sha,
    posted,
  });
  if (match.kind === "none") {
    const lineHint =
      identity.line === findingsLine
        ? `${finding.path}:${identity.line}`
        : `${finding.path}: post line ${identity.line} ` +
          `(findings.json:${findingsLine})`;
    throw new CliError(
      `no posted <!-- pr-hero-finding marker matches ${input.findingId} ` +
        `on PR #${prNumber} (${lineHint}, head ${doc.head_sha.slice(0, 8)}). ` +
        "Bind by marker, never by a GitHub comment id or the nearest line",
    );
  }
  if (match.kind === "ambiguous") {
    throw new CliError(
      `multiple posted finding comments match ${input.findingId} ` +
        `(ids ${match.ids.join(", ")}) — will not pick by proximity`,
    );
  }
  const parent = match.posted;
  const reviewComments = await fetchPrReviewComments(operatorRoot, prNumber, {
    spawnFn,
  });
  const already = existingTriageAtHead({
    parentId: parent.id,
    headSha: doc.head_sha,
    replies: reviewComments,
  });
  const resolveDecision = decideThreadResolve({
    channel: parent.channel,
    verdict: input.verdict,
  });
  if (dryRun) {
    log(
      `plan: reply to ${parent.channel} comment ${parent.id} ` +
        `(${input.findingId}, marker match) as ${input.tag}` +
        (already ? " — already triaged at this head, would skip post" : ""),
    );
    if (resolveDecision === "resolve") {
      log("plan: would resolve the review thread after posting");
    } else if (resolveDecision === "skip-inconclusive") {
      log("plan: would leave the thread open (adjudicator inconclusive)");
    } else {
      log("plan: no review thread to resolve (issue-comment finding)");
    }
    log("dry run: nothing was posted.");
    return 0;
  }
  if (!already) {
    if (parent.channel === "review") {
      await postReviewCommentReply({
        operatorRoot,
        pr: prNumber,
        inReplyTo: parent.id,
        body,
        spawnFn,
      });
    } else {
      const webUrl = await ghRepoWebUrl(operatorRoot, { spawnFn });
      const withLink =
        webUrl === undefined
          ? body
          : `${body.trimEnd()}\n\nIn reply to: ${webUrl}/pull/${prNumber}#issuecomment-${parent.id}\n`;
      await postIssueTriageComment({
        operatorRoot,
        pr: prNumber,
        body: withLink,
        spawnFn,
      });
    }
    log(
      `posted: ${input.tag} on ${input.findingId} ` +
        `(${parent.channel} comment ${parent.id})`,
    );
  } else {
    log(
      `skip post: ${input.findingId} already triaged at this head ` +
        `(${parent.channel} comment ${parent.id})`,
    );
  }

  // Persist triage record to canonical product store (idempotent upsert)
  try {
    const layout = prheroLayout(os.homedir());
    if (existsSync(layout.prheroDbPath)) {
      const repoId = await tryOriginRepoId(operatorRoot);
      if (repoId) {
        const db = openProductStore(layout.prheroDbPath);
        try {
          const runDirBasename = path.basename(runDir);
          const runRow = db
            .query(
              "SELECT id FROM runs WHERE repo_id = ? AND run_dir = ? LIMIT 1",
            )
            .get(repoId, runDirBasename) as { id: number } | null;
          if (runRow) {
            recordFindingTriage(db, {
              run_id: runRow.id,
              finding_id: input.findingId,
              comment_id: parent.id,
              tag: input.tag,
              verdict: input.verdict,
              actor: "agent",
              reasoning,
              issue_number: input.issue,
              created_at: new Date().toISOString(),
            });
          }
        } finally {
          db.close();
        }
      }
    }
  } catch (err) {
    log(
      `warning: failed to record triage in product store: ${(err as Error).message}`,
    );
  }

  if (resolveDecision !== "resolve") {
    return 0;
  }
  // Live #34: the reply POST succeeded, then GraphQL resolve threw and the
  // process exited 1. The skill's rule is never `gh` — say the reply is
  // already on GitHub and the same command retries resolve only.
  try {
    const resolveOutcome = await resolveReviewThreadForComment({
      operatorRoot,
      pr: prNumber,
      commentId: parent.id,
      spawnFn,
    });
    if (resolveOutcome === "resolved") {
      log(`resolved: review thread for ${input.findingId}`);
    } else if (resolveOutcome === "already-resolved") {
      log(`resolved: thread already closed for ${input.findingId}`);
    } else {
      log(`resolve skipped: no review thread found for comment ${parent.id}`);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError(
        `resolve failed after the reply was on GitHub (${error.message}). ` +
          "Re-run the same `pr-hero triage reply` command to retry resolve " +
          "only — same-head skip will not double-post.",
      );
    }
    throw error;
  }
  return 0;
}

async function resolveRepoRoot(repoOption: string): Promise<string> {
  const repoArg = path.resolve(repoOption);
  const toplevel = await git(repoArg, ["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok) {
    throw new CliError(`not a git repository: ${repoArg}`);
  }
  return toplevel.stdout.trim();
}

// The one git call the pure resolver cannot make. `symbolic-ref --quiet` exits
// non-zero when origin/HEAD is unset — normal on a local-only clone — so a
// failure here means "no remote head", not an error worth stopping for.
async function remoteHeadRef(repoRoot: string): Promise<string | undefined> {
  const result = await git(repoRoot, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  return result.ok ? parseRemoteHead(result.stdout) : undefined;
}

async function resolveBase(
  repoRoot: string,
  options: CliOptions,
  config: LocalConfig,
): Promise<BaseRefResolution> {
  // Only ask git when the answer can still change it: a flag or a configured
  // default_base already decides the ref, and a subprocess whose result is
  // discarded is just latency.
  const needsRemote = !options.base && !config.default_base;
  return resolveBaseRef({
    flag: options.base,
    configDefaultBase: config.default_base,
    remoteHead: needsRemote ? await remoteHeadRef(repoRoot) : undefined,
  });
}

// THE range fix. `git diff base..head` is a two-POINT diff: once base has
// advanced past the branch point, every commit base gained since shows up in
// the review as a REVERSED change the branch never made. Measured on the real
// target repo: for a branch already merged into `dev`, `git diff dev..branch`
// reported 111 files and 6175 deletions belonging to other people's work,
// while the correct range was empty.
//
// So the default diffs from the MERGE BASE (equivalent to `base...head`), and
// the merge-base commit is resolved EXPLICITLY rather than left implicit in a
// three-dot range: the plan has to print it, and the recorded base_sha has to
// be the commit the review was actually computed against.
//
// A failure here is unrelated histories, and it fails loud: silently falling
// back to the two-dot range would reintroduce exactly the bug this replaces.
async function resolveDiffFrom(
  repoRoot: string,
  twoDot: boolean,
  baseLabel: string,
  headLabel: string,
  baseSha: string,
  headSha: string,
): Promise<string> {
  if (twoDot) return baseSha;
  const result = await git(repoRoot, ["merge-base", baseSha, headSha]);
  const sha = result.stdout.trim();
  if (!result.ok || !isFullCommitId(sha)) {
    throw new CliError(
      `no merge base between ${baseLabel} (${baseSha}) and ${headLabel} ` +
        `(${headSha})` +
        (result.stderr.trim() ? `: ${result.stderr.trim()}` : "") +
        ". The histories are unrelated, so there is no branch point to " +
        "review from. Pick a --base that shares history, or pass --two-dot " +
        "to diff the literal two-point range anyway.",
    );
  }
  if (sha === headSha) {
    throw new CliError(headContainedInBaseMessage(baseLabel, headLabel));
  }
  return sha;
}

// The impure half of the agents-dir chain: the seat's `configDir` is the
// dirname of the file the WINNING layer lives in (agentsDirSeat, JD-14), and
// only the existence check below touches the disk.
function resolveAgentsDir(
  options: CliOptions,
  loaded: EffectiveConfig,
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
  });
  if (!existsSync(resolution.dir)) {
    throw new CliError(`agents dir does not exist: ${resolution.dir}`);
  }
  return resolution;
}

// `pr-hero init` — the other half of making `pr-hero review` a zero-flag
// command. It writes the two files local mode looks for and nothing else, and
// it never overwrites: a config or a gotchas file already on disk is the
// user's work, and the whole value of gotchas is that a human wrote them.
async function init(options: CliOptions): Promise<number> {
  const repoRoot = await resolveRepoRoot(options.repo);
  const dir = path.join(repoRoot, ".prhero");
  await mkdir(dir, { recursive: true });

  // NOT resolveAgentsDirSetting: that one is the review-time precedence
  // (flag > config > env) and it throws when nothing is set. init has no
  // config to read yet — it is writing one — and a missing prompt set must
  // still produce a usable scaffold. When no flag or env is given, agents_dir
  // is omitted entirely so the repo uses the engine's bundled default.
  const agentsFromEnv = process.env.PRHERO_AGENTS_DIR;
  const agentsSeed = options.agents
    ? { dir: path.resolve(options.agents), source: "--agents" }
    : agentsFromEnv
      ? { dir: path.resolve(agentsFromEnv), source: "PRHERO_AGENTS_DIR" }
      : undefined;
  const baseSeed = resolveBaseRef({
    flag: options.base,
    remoteHead: await remoteHeadRef(repoRoot),
  });

  // C5 O-9. The global file is read but never written: init scaffolds the TEAM
  // file, and the person/capped keys the global already supplies are left OUT
  // of it. Without this the command ships the duplication C5 exists to delete
  // — §0.5 measured three byte-identical configs on one machine, all three
  // restating the same agents_dir and summary block.
  const { filePath: globalConfigPath, layer: globalLayer } =
    await loadGlobalConfigLayer(os.homedir());
  const templateInput = {
    ...(agentsSeed === undefined ? {} : { agentsDir: agentsSeed.dir }),
    defaultBase: baseSeed.ref,
    ...(globalLayer === undefined ? {} : { global: globalLayer }),
    agentsDirFromFlag: options.agents !== undefined,
  };
  const omitted = initTemplateOmissions(templateInput);

  // `repoConfigPath`, not `configPath`: C5 put a second config.json under
  // ~/.prhero/, and a bare `configPath` in a codebase where PrheroLayout
  // deliberately retired that name (home-preflight.ts) is the same ambiguity
  // the retirement exists to delete. `init` writes the TEAM file and only the
  // team file — the global layer is the operator's own, and scaffolding it
  // from inside a repo would be this command reaching outside its checkout.
  const repoConfigPath = path.join(dir, "config.json");
  const gotchasPath = path.join(dir, "gotchas.md");
  const wrote: string[] = [];
  const kept: string[] = [];
  for (const [file, contents] of [
    [repoConfigPath, initConfigTemplate(templateInput)],
    [gotchasPath, GOTCHAS_TEMPLATE],
  ] as const) {
    if (existsSync(file)) {
      kept.push(file);
      continue;
    }
    await Bun.write(file, contents);
    wrote.push(file);
  }

  log(`pr-hero init — ${dir}`);
  log();
  for (const file of wrote) log(`  wrote  ${file}`);
  for (const file of kept) log(`  kept   ${file} (already exists, untouched)`);
  log();
  // The seed line has to follow the FILE, not the seed: a scaffold that
  // omitted agents_dir while the terminal still reported "agents_dir <path>
  // (from the suggested clean set)" would send the reader looking for a line
  // that is not in the file they were just told was written.
  log(
    omitted.agentsDir
      ? globalLayer?.agents_dir
        ? `  agents_dir    ${globalLayer.agents_dir} (from ${globalConfigPath})`
        : "  agents_dir    bundled default (from engine)"
      : `  agents_dir    ${agentsSeed?.dir} (from ${agentsSeed?.source})`,
  );
  log(`  default_base  ${baseSeed.ref} (from ${baseSeed.source})`);
  if (omitted.keys.length > 0) {
    log();
    log(
      `  Left out of ${repoConfigPath}: ${omitted.keys.join(", ")} — ` +
        `${globalConfigPath} already supplies ${
          omitted.keys.length === 1 ? "that key" : "those keys"
        }, and restating them here is the duplication the global layer ` +
        "exists to delete.",
    );
  }
  log();
  log(INIT_GIT_REMINDER);
  log();
  log("Then edit .prhero/gotchas.md — pr-hero refuses to run without it.");
  return 0;
}

// `pr-hero ledger` (ROADMAP B4) — accumulate every run's comparison.json
// into one markdown ledger, so the three buckets become a rate instead of a
// per-run snapshot. Read-only over the runs root; every decision (parse,
// latest-run-per-PR, render) is pure in ledger.ts.
async function ledgerCommand(options: CliOptions): Promise<number> {
  const repoRoot = await resolveRepoRoot(options.repo);
  const runsRoot = options.runs
    ? path.resolve(options.runs)
    : (
        await resolveRepoHome({
          home: os.homedir(),
          operatorRoot: repoRoot,
          persist: false,
        })
      ).paths.runs;
  // One level deep on purpose: run dirs are flat children of the root, and
  // a recursive glob would pick up anything a run itself wrote deeper down.
  const files: string[] = [];
  if (existsSync(runsRoot)) {
    for await (const entry of new Bun.Glob("*/comparison.json").scan({
      cwd: runsRoot,
    })) {
      files.push(path.join(runsRoot, entry));
    }
  }
  // Sorted so aggregation sees a deterministic order — timestamp ties in
  // the latest-run pick resolve by input order.
  files.sort();
  // An empty ledger is a valid state of the world (no reviews have run
  // yet), not an error: note it on stderr, leave stdout clean, exit 0.
  if (files.length === 0) {
    log(
      `no comparison.json found under ${runsRoot} — run ` +
        "`pr-hero review --pr <n>` first, or point --runs at the runs root",
    );
    return 0;
  }
  const entries: { comparison: StoredComparison; mtimeMs: number }[] = [];
  for (const file of files) {
    const raw = await Bun.file(file).text();
    let comparison: StoredComparison;
    try {
      comparison = parseComparisonJson(raw);
    } catch (error) {
      // The pure parser names the field; only the shell knows the file.
      if (error instanceof CliUsageError) {
        throw new CliError(`${file}: ${error.message}`);
      }
      throw error;
    }
    // mtime is the ordering fallback for files that predate the
    // generated_at stamp (the first paid run's artifact is one of them).
    const { mtimeMs } = await stat(file);
    entries.push({ comparison, mtimeMs });
  }
  const markdown = renderLedger(aggregateLedger(entries));
  if (options.out) {
    const outPath = path.resolve(options.out);
    await Bun.write(outPath, markdown);
    log(`ledger: wrote ${outPath} (from ${files.length} run(s))`);
    return 0;
  }
  // The markdown IS this command's product, and stdout is the one clean
  // channel (everything human-facing goes to stderr), so it can be piped or
  // redirected without the notes riding along.
  process.stdout.write(markdown);
  return 0;
}

// `pr-hero usage` (W4 / #23) — the thin read side of the observability
// store every completed review auto-ingests into. Origin-scoped by default
// (spec "Origin-Scoped Usage By Default"); `--all` is the operator-wide
// escape hatch and DELIBERATELY skips resolveRepoHome entirely — it must
// run from anywhere, including outside a git repo (design "usage render").
// A checkout with no resolvable origin fails/warns via the SAME CliError
// gitOriginUrl already throws (spec "No-origin checkout"): resolveRepoRoot
// still needs the cwd to be a git repo, resolveRepoHome still needs an
// origin, and neither is bypassed in scoped mode.
// The scoped-mode half of `usage`'s origin resolution, pulled out on its own
// (W4 Phase 6 remediation, GitHub #23 option D) so a no-origin checkout's
// failure path — the pre-existing CliError/missingOriginMessage that
// resolveRepoHome's gitOriginUrl call already throws — is exercisable
// directly, without needing `usageCommand`'s whole `--all`/parseArgs
// surface around it. persist:false: `usage` must never write a registry.
export async function originUsageScope(
  home: string,
  operatorRoot: string,
): Promise<{ repoId: string }> {
  const repoHome = await resolveRepoHome({
    home,
    operatorRoot,
    persist: false,
  });
  return { repoId: repoHome.repoId };
}

async function usageCommand(options: CliOptions): Promise<number> {
  const layout = prheroLayout(os.homedir());
  const scope = options.all
    ? ({ all: true } as const)
    : await originUsageScope(os.homedir(), await resolveRepoRoot(options.repo));

  const canonicalRows = existsSync(layout.prheroDbPath)
    ? (() => {
        const db = openProductStore(layout.prheroDbPath);
        try {
          return queryRuns(db, scope);
        } finally {
          db.close();
        }
      })()
    : [];

  let runRows: RunRow[] = canonicalRows.map((r) => ({
    repo_id: r.repo_id,
    run_dir: r.run_dir,
    pr: r.pr,
    checkout_path: r.checkout_path,
    head_sha: r.head_sha,
    base_sha: r.base_sha,
    run_status: r.run_status,
    session_failed: r.session_failed === 1 ? 1 : 0,
    model: r.model,
    generated_at: r.generated_at,
    wall_ms: r.wall_ms,
    index_ms: r.index_ms,
    tokens_in: r.tokens_in,
    tokens_out: r.tokens_out,
    tokens_total: r.tokens_total,
    cost_usd_est: r.cost_usd_est,
    blocking: r.blocking,
    advisory: r.advisory,
  }));

  if (runRows.length === 0 && existsSync(layout.metricsDbPath)) {
    runRows = queryUsage(layout.metricsDbPath, scope);
  }

  // An empty store is a valid state of the world (no review has ingested
  // yet, or none matches this scope), not an error — same split as
  // ledgerCommand: a human note on stderr, stdout left clean, exit 0.
  if (runRows.length === 0) {
    log(
      `no usage rows found in ${layout.prheroDbPath} — run \`pr-hero review\` or ` +
        "`pr-hero review --pr <n>` first",
    );
    return 0;
  }
  // The report IS this command's product, same stdout/stderr split as
  // ledgerCommand: everything human-facing above went to stderr via log(),
  // so stdout stays pipeable.
  process.stdout.write(
    `${renderUsage(runRows, { styles: styleEnabled() }).join("\n")}\n`,
  );
  return 0;
}

// `pr-hero config` (C5 O-12 / D10 / §3.10) — read-only, $0, and deliberately
// the thinnest shell in this file: resolve the two layers through the SAME
// loadEffectiveConfig a review takes, hand the result to a pure renderer,
// print. Every decision it could get wrong lives in mergeConfig, which is
// already the engine's; re-deriving anything here is how the command that
// explains the config starts disagreeing with the config.
//
// It never writes either file. Editing config from menus is distribution
// pillar 2 (§3.10, "Not in scope"), and a command an operator runs to
// UNDERSTAND their setup must be safe to run without reading its flags first.
//
// stdout, like `ledger` and `usage`: the listing IS this command's product,
// so it stays pipeable. Everything human-facing elsewhere in this CLI goes to
// stderr via log(), which is what reserves the channel — and the style flag is
// therefore sniffed off stdout, the stream actually being written.
async function resolveOptionalRepoRoot(
  options: CliOptions,
): Promise<string | undefined> {
  if (options.repoExplicit) {
    return await resolveRepoRoot(options.repo);
  }
  return await resolveRepoRoot(process.cwd()).catch(() => undefined);
}

async function configCommand(options: CliOptions): Promise<number> {
  const repoRoot = await resolveOptionalRepoRoot(options);
  const loaded = await loadEffectiveConfig({
    root: repoRoot,
    home: os.homedir(),
    configFlag: options.config,
  });
  const lines = renderConfig({
    effective: loaded.effective,
    sources: loaded.sources,
    repoConfigPath: repoRoot
      ? loaded.repoConfigPath
      : path.join(process.cwd(), ".prhero", "config.json"),
    // Not carried on EffectiveConfig: the review path has no use for it (an
    // absent repo file is simply an absent layer), and widening a type six
    // callers share to serve one renderer is how shared shapes rot.
    repoPresent: repoRoot ? existsSync(loaded.repoConfigPath) : false,
    globalConfigPath: loaded.globalConfigPath,
    globalPresent: loaded.globalPresent,
    styles: styleEnabled(process.stdout),
    width: terminalWidth(),
  });
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function doctorCommand(options: CliOptions): Promise<number> {
  const repoRoot = await resolveOptionalRepoRoot(options);
  const report = await runDoctor({ cwd: repoRoot ?? process.cwd() });
  const lines = renderDoctorReport(report, {
    styles: styleEnabled(process.stdout),
    width: terminalWidth(),
  });
  process.stdout.write(`${lines.join("\n")}\n`);
  return report.exitCode;
}

export async function mcpCommand(options: CliOptions): Promise<number> {
  await runMcpServer({
    socketPath: options.socket,
    dbPath: options.db,
  });
  return 0;
}

async function preflightAgentsDir(
  agentsDir: string,
  specFiles: string[],
): Promise<void> {
  const present = new Set<string>();
  for (const pattern of AGENT_FILE_PATTERNS) {
    for await (const entry of new Bun.Glob(pattern).scan({ cwd: agentsDir })) {
      present.add(entry);
    }
  }
  const problems = agentsDirProblems(specFiles, [...present]);
  if (problems.length > 0) {
    throw new CliError(
      `prompt set ${agentsDir} does not match the review spec:\n` +
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

// C5 O-7's payload for both plan surfaces: everything the card and the
// details view need to name a value the operator cannot see by opening their
// checkout. Optional on both contexts, so a context assembled without it
// renders exactly the pre-C5 plan.
export interface ConfigProvenance {
  sources: ConfigSources;
  // Read off the RESOLUTION, never off `sources`: ConfigSource has no `flag`
  // member (judgment ledger JD-10), so the record cannot say that --agents
  // beat both layers — and a card that tagged such a run `global` would be
  // naming the file that LOST. AgentsDirSource can say it, so it is what the
  // tag is derived from.
  agentsDirSource: AgentsDirSource;
  repoConfigPath: string;
  globalConfigPath: string;
  globalPresent: boolean;
}

// The two halves the shell holds separately — the merge's record, and the
// agents-dir chain's own answer — joined once, so the three plan contexts
// (local, PR dry run, PR real) cannot assemble three different versions of
// the same fact.
function configProvenanceOf(
  loaded: EffectiveConfig,
  agentsDirSource: AgentsDirSource,
): ConfigProvenance {
  return {
    sources: loaded.sources,
    agentsDirSource,
    repoConfigPath: loaded.repoConfigPath,
    globalConfigPath: loaded.globalConfigPath,
    globalPresent: loaded.globalPresent,
  };
}

// A value the operator cannot see in the checkout is tagged; a value from the
// repo file is not, because that is the unsurprising case and the card is
// already dense.
//
// `default` is deliberately NOT tagged (judgment ledger JD-21, where O-7's
// "any value that did not come from the repo file" and §3.6's "global or
// capped" disagree). §3.6's reading is the one that keeps the operator
// un-surprised: a defaulted value is byte-for-byte pre-C5 behaviour, and the
// card already prints every one of them in a row of its own — the summarizer
// row, the parity row, the priors count, the base's source tag. Tagging six
// defaults on every quiet repo would bury the one tag that is genuinely new
// information. Naming every key's layer is `pr-hero config`'s job (§3.10),
// where the whole point is the exhaustive list.
function configTag(key: string, source: ConfigSource): string | undefined {
  return source === "global" || source === "capped"
    ? `${key} ← ${source}`
    : undefined;
}

// Which keys a flag decided, so the two consumers below cannot disagree about
// it. A flag decided the value, so NO config layer did — and D5 lets a flag
// exceed a cap on purpose. ConfigSource cannot express that (JD-10), so the
// honest move is to print no tag at all rather than to name a layer that lost.
// `agents_dir` is read off the RESOLUTION, the only thing that can say a flag
// beat both layers. Shared rather than inlined because the suppression and the
// caption that has to account for it are two sides of one fact: when this said
// only "suppress the tag", configDetail went on claiming an origin for exactly
// the keys the suppression had removed from the check.
function flagDecided(
  provenance: ConfigProvenance,
  options: Pick<CliOptions, "base" | "summary" | "model">,
): { base: boolean; summary: boolean; model: boolean; any: boolean } {
  const base = options.base !== undefined;
  const summary = options.summary !== undefined;
  const model = options.model !== undefined;
  return {
    base,
    summary,
    model,
    any: base || summary || model || provenance.agentsDirSource === "flag",
  };
}

function configTags(
  provenance: ConfigProvenance,
  options: Pick<CliOptions, "base" | "summary" | "model">,
): string[] {
  const s = provenance.sources;
  const flagged = flagDecided(provenance, options);
  // Every key is listed, including the three `repo` ones that can never
  // produce a tag today: a direction change must not silently drop a key off
  // the card.
  return [
    // Both sources the operator cannot see by opening the checkout, not just
    // the global file. Judgment ledger JD-9 left "a global `agents_dir`
    // silently preempts PRHERO_AGENTS_DIR" open on the grounds that this tag
    // is the mitigation — but firing on `global` alone covered one direction
    // only: an env-sourced prompt set, which picks every hunter's model, was
    // as absent from the checkout as a global one and printed nothing. `flag`
    // stays untagged (D5, JD-10) and `repo` stays untagged (§3.6, the
    // unsurprising case).
    provenance.agentsDirSource === "global" ||
    provenance.agentsDirSource === "env"
      ? `agents_dir ← ${provenance.agentsDirSource}`
      : undefined,
    flagged.base ? undefined : configTag("default_base", s.default_base),
    configTag("parity_trigger_paths", s.parity_trigger_paths),
    configTag("suspicion_priors", s.suspicion_priors),
    flagged.summary
      ? undefined
      : configTag("summary.enabled", s.summary.enabled),
    flagged.model ? undefined : configTag("summary.model", s.summary.model),
    configTag("max_verification_steps", s.max_verification_steps),
  ].filter((tag): tag is string => tag !== undefined);
}

// The card's row, present only when there is something to say. Empty is the
// common case — one global file and one quiet repo produce at most a couple
// of tags — so this costs the card nothing on a run where nothing hoisted.
function configRow(
  provenance: ConfigProvenance | undefined,
  options: Pick<CliOptions, "base" | "summary" | "model">,
  styles: boolean,
  width: number,
): string[] {
  if (provenance === undefined) return [];
  const tags = configTags(provenance, options);
  if (tags.length === 0) return [];
  return row(
    "CONFIG",
    `${tags.join(" · ")}  (${provenance.globalConfigPath})`,
    {
      styles,
      width,
    },
  );
}

// The details view's row: both file paths whether or not they exist, because
// "where do I even write this" is the other half of the question a teammate
// asks the moment a value surprises them. Not dense, and this is the view
// that exists for the reader who wants the whole answer.
function configDetail(
  provenance: ConfigProvenance,
  options: Pick<CliOptions, "base" | "summary" | "model">,
): string {
  const tags = configTags(provenance, options);
  // No tags has TWO causes, and only one of them licenses the sentence this
  // used to print unconditionally. Nothing hoisted is one. The other is that a
  // flag decided a key and configTags suppressed its tag on purpose (JD-10) —
  // and on that run "every value came from the repo file or a built-in
  // default" is false about the one value the operator most recently typed.
  // The caption is therefore scoped to what the function actually checked; it
  // is not fixed by tagging the flag, which would reopen JD-10 by naming a
  // layer for a key no layer decided. With no flag in play the original
  // sentence is exact and stays: `flag` is excluded by the branch, `global`
  // and `env` both produce a tag, so only repo-or-default can reach it.
  return (
    `repo ${provenance.repoConfigPath}` +
    ` · global ${provenance.globalConfigPath}` +
    ` (${provenance.globalPresent ? "present" : "absent"})` +
    (tags.length > 0
      ? ` · ${tags.join(" · ")}`
      : flagDecided(provenance, options).any
        ? " — every value a flag did not decide came from the repo file or" +
          " a built-in default"
        : " — every value came from the repo file or a built-in default")
  );
}

export interface PlanContext {
  options: CliOptions;
  repoRoot: string;
  baseRef: BaseRefResolution;
  baseSha: string;
  diffFromSha: string;
  headSha: string;
  diffStat: DiffStat;
  diffPath: string;
  agentsDir: string;
  agentFiles: Map<string, ParsedAgent>;
  spec: ReviewSpec;
  runDir: string;
  config: LocalConfig;
  summary: SummarySettings;
  parityFires: boolean;
  codegraphAvailable: boolean;
  estimate: ReturnType<typeof estimateCost>;
  hunterCount: number;
  // The gate's ALREADY-EVALUATED verdict, carried in so the plan can print
  // it last. The gate is still decided by the shell, before the cost band's
  // confirm() — this only moves where the line lands on screen.
  sizeGate: SizeGateVerdict;
  droppedPaths: string[];
  // C5 O-7. Optional for the reason `resolved`/`rereview` are on the PR
  // context: a plan assembled without it renders the pre-C5 card.
  configProvenance?: ConfigProvenance;
  // The terminal width every row and card below is laid out against, carried
  // in exactly as ui-result.ts's ResultInput carries it. Optional so the shell
  // may leave the one sniff to the renderer's entry point; the tests ALWAYS
  // pin it, because these renderers were the reason `bun test` in a narrow
  // pane could fail on a wrap point no test could stub.
  width?: number;
}

// Where the base ref came from, because "main" chosen by fallback and "main"
// asked for by name are the same string with very different confidence behind
// them. The full sentence lives in the details view now; the card carries the
// short tag below, which says the same thing in one token.
function baseSourceNote(ctx: PlanContext): string {
  switch (ctx.baseRef.source) {
    case "flag":
      return "--base";
    case "config":
      return "config default_base";
    case "remote":
      return "refs/remotes/origin/HEAD";
    default:
      return "fallback: no --base, no default_base, no remote head";
  }
}

function baseSourceTag(ctx: PlanContext): string {
  return ctx.baseRef.source === "fallback" ? "fallback" : baseSourceNote(ctx);
}

// The prose the plan card demotes: why the base ref is trusted, what the
// range actually means, and what the cost band was computed from. Long,
// true, and read at most once — so it does not belong between the operator
// and the yes/no they are about to give.
const PERMISSIONS_NOTE =
  "steps run with --permission-mode bypassPermissions, bounded only by " +
  "each agent's read-only tool allow-list";

// The decision block deliberately breaks the grid above it: a one-character
// marker instead of a label column, so the two lines that decide "spend or
// not" do not read as two more rows of setup.
const MARKER_ROW = { indent: 2, labelWidth: 2 } as const;

// Built UNSTYLED and painted whole afterwards: row() measures the value to
// place the wrap, and an escape sequence inside that value would be counted
// as visible width.
function markerRowLines(
  marker: string,
  value: string,
  paint: (text: string, styles: boolean) => string,
  styles: boolean,
  width: number,
): string[] {
  return row(marker, value, { ...MARKER_ROW, styles: false, width }).map(
    (line) => paint(line, styles),
  );
}

function agentRow(
  ctx: { options: CliOptions; agentFiles: Map<string, ParsedAgent> },
  agent: ReviewSpec["agents"][number],
  fires: string,
): string {
  const parsed = ctx.agentFiles.get(agent.key);
  const model = ctx.options.model ?? agent.model ?? parsed?.model ?? "?";
  return `${agent.key.padEnd(12)} ${model.padEnd(8)} ${fires}`;
}

function summarizerRow(summary: SummarySettings): string {
  const model = summary.model ?? DEFAULT_SUMMARY_MODEL;
  return (
    `summarizer`.padEnd(12) +
    `${model}`.padEnd(8) +
    (summary.enabled ? "always" : "disabled")
  );
}

function summarizerLabel(summary: SummarySettings): string {
  return summary.enabled ? "+ summarizer" : "+ summarizer disabled";
}

// Printed on EVERY plan, off included. The scout adds a paid stage to the
// front of the run and the operator is about to confirm a band that already
// counts it, so "scout: off" is information, not noise — and a stage that
// only appears when it is on is a stage nobody notices arriving.
function scoutRow(
  options: Pick<CliOptions, "scout" | "scoutModel" | "model">,
): string {
  const label = "scout".padEnd(12);
  if (!options.scout) return `${label}${"-".padEnd(8)}disabled`;
  // The same chain the pipeline resolves, printed before the money is spent:
  // --model > --scout-model > the engine default (the bundled prompt pins no
  // model, so there is no frontmatter seat to show here).
  const model = options.model ?? options.scoutModel ?? DEFAULT_SCOUT_MODEL;
  return `${label}${model.padEnd(8)}diff-only, before the hunters (experimental)`;
}

function scoutLabel(options: Pick<CliOptions, "scout">): string {
  return options.scout ? " + scout" : "";
}

// The last block on screen and the only one an operator must read: the gate
// verdict, then the money. Both used to sit mid-list, where the eye that had
// already given up on the plan never reached them.
interface PlanDecision {
  sizeGate: SizeGateVerdict;
  // Set only where the verdict is an ESTIMATE rather than the gate's own
  // answer (the PR dry run's aggregate counters); printed beside it so
  // nobody reads a guess as the verdict.
  sizeGateNote?: string;
  droppedPaths: string[];
  force: boolean;
  // Interactive override, distinct from --force: the operator confirmed
  // "review anyway" at the size-gate menu. The plan names which hatch
  // opened so a log cannot be read as "they passed --force".
  sizeGateConfirmed?: boolean;
  estimate: ReturnType<typeof estimateCost>;
  hunterCount: number;
  summarizer: boolean;
}

function decisionLines(
  d: PlanDecision,
  styles: boolean,
  width: number,
): string[] {
  // sizeGateLine's wording is FIXED — size-gate.test.ts pins five substrings
  // of it, and the watcher's log parser reads the same phrasing. The ✓/✗ is
  // decoration in front of it, never a replacement for it.
  const note = d.sizeGateNote === undefined ? "" : ` ${d.sizeGateNote}`;
  const lines = [
    "",
    ...markerRowLines(
      d.sizeGate.ok ? "✓" : "✗",
      `${sizeGateLine(d.sizeGate)}${note}`,
      d.sizeGate.ok ? green : red,
      styles,
      width,
    ),
    ...exclusionLines(d.droppedPaths, styles, width),
  ];
  if (!d.sizeGate.ok && d.force) {
    lines.push(
      ...markerRowLines(
        "!",
        "--force given: reviewing anyway.",
        yellow,
        styles,
        width,
      ),
    );
  } else if (!d.sizeGate.ok && d.sizeGateConfirmed) {
    lines.push(
      ...markerRowLines(
        "!",
        "confirmed: reviewing anyway.",
        yellow,
        styles,
        width,
      ),
    );
  }
  lines.push(
    ...markerRowLines(
      "$",
      `estimate $${d.estimate.low.toFixed(2)} – ` +
        `$${d.estimate.high.toFixed(2)} (${d.hunterCount} hunter(s) + refuter ` +
        `${d.summarizer ? "+ summarizer" : "+ summarizer disabled"})`,
      bold,
      styles,
      width,
    ),
  );
  return lines;
}

// Both details views' rows, with a label column DERIVED from their own labels
// instead of inherited from row()'s fixed default.
//
// WHY: that default is 11 and "permissions" is 11 characters, so padEnd() gave
// it no gap and the live run printed
// `permissionssteps run with --permission-mode bypassPermissions…` — one word
// welded out of two columns. Deriving the width means the next label longer
// than any of today's cannot bring the collision back.
function detailRows(
  pairs: readonly [string, string][],
  styles: boolean,
  width: number,
): string[] {
  const labelWidth = labelColumnWidth(pairs.map(([label]) => label));
  return pairs.flatMap(([label, value]) =>
    row(label, value, { styles, width, labelWidth }),
  );
}

// NOT printed by default: everything the plan card demoted lands here, and
// the confirm menu's "Show details" option is the only thing that prints it.
// Exported ONLY for test/cli-plan.test.ts — a test is a real consumer, and
// these four renderers had zero coverage until WU4. Nothing else may import
// them:
// biome's unused-symbol rule does not flag exports, so an `export` for a
// hypothetical consumer is how dead code hides through a clean `bun run check`
// (which is exactly how this pair sat unread for two work units).
//
// `styles` ARRIVES AS A PARAMETER and so does the WIDTH (`ctx.width`, resolved
// once here): ui.ts's contract, and the only reason the returned lines can be
// asserted offline without a TTY.
export function planDetails(ctx: PlanContext, styles: boolean): string[] {
  const width = ctx.width ?? terminalWidth();
  const pairs: [string, string][] = [];
  const push = (label: string, value: string): void => {
    pairs.push([label, value]);
  };
  push("repo", ctx.repoRoot);
  push("base", `${ctx.baseRef.ref} → ${ctx.baseSha} (${baseSourceNote(ctx)})`);
  push("head", `${ctx.options.head} → ${ctx.headSha}`);
  // BOTH endpoints, always. The base ref the user asked for and the commit the
  // diff is actually computed from are different things whenever base has
  // moved on, and a plan that printed only one of them would leave the range
  // ambiguous in exactly the case that motivated the merge-base default. The
  // card satisfies that with its own BASE + RANGE pair (short shas); this
  // view adds the full shas and the sentence explaining the range.
  push(
    "diff from",
    ctx.options.twoDot
      ? `${ctx.baseSha} — --two-dot: the literal ${ctx.baseRef.ref}..` +
          `${ctx.options.head} two-point range, so commits base gained since ` +
          "the branch point appear REVERSED"
      : `${ctx.diffFromSha} — merge base of ${ctx.baseRef.ref} and ` +
          `${ctx.options.head}; only what this branch adds is reviewed`,
  );
  push("diff", ctx.diffPath);
  push("agents dir", ctx.agentsDir);
  if (ctx.configProvenance) {
    push("config", configDetail(ctx.configProvenance, ctx.options));
  }
  push("run dir", ctx.runDir);
  push("hop budget", String(ctx.options.hopBudget));
  push("summarizer", summarizerRow(ctx.summary));
  push("scout", scoutRow(ctx.options));
  push(
    "parity",
    ctx.config.parity_trigger_paths.length === 0
      ? "no parity_trigger_paths configured — the parity hunter never fires"
      : ctx.parityFires
        ? `fires (a changed path matches ${ctx.config.parity_trigger_paths.length} configured pattern(s))`
        : "configured, but no changed path matches — it will not fire",
  );
  push(
    "codegraph",
    ctx.codegraphAvailable
      ? "available (.codegraph found; codegraph_explore is live)"
      : "NOT FOUND — the agents' codegraph_explore grant is inert, so this " +
          "review runs on Read/Grep/Glob alone",
  );
  push("priors", `${ctx.config.suspicion_priors.length} suspicion prior(s)`);
  push("estimate", ctx.estimate.basis);
  push("permissions", PERMISSIONS_NOTE);
  return [section("details", styles), ...detailRows(pairs, styles, width)];
}

// The plan card as LINES, printed by the shell. Returning them rather than
// logging them is what makes the composition — card, agent grid, endpoints,
// decision block — assertable in one offline expectation.
export function renderPlan(ctx: PlanContext, styles: boolean): string[] {
  const width = ctx.width ?? terminalWidth();
  const lines = [
    ...box(
      "pr-hero · review",
      [
        `${ctx.baseRef.ref}..${ctx.options.head}`,
        `${shortPath(ctx.repoRoot)} · ${ctx.diffStat.files} files  ` +
          `+${ctx.diffStat.insertions} −${ctx.diffStat.deletions}`,
      ],
      { styles, width },
    ),
    "",
  ];
  let label = "AGENTS";
  for (const agent of ctx.spec.agents) {
    const fires =
      agent.role === "refuter"
        ? "per severe finding"
        : agent.trigger === undefined
          ? "always"
          : ctx.parityFires
            ? "triggered"
            : "✗ will not fire";
    lines.push(...row(label, agentRow(ctx, agent, fires), { styles, width }));
    label = "";
  }
  lines.push(...row(label, summarizerRow(ctx.summary), { styles, width }));
  lines.push(...row("", scoutRow(ctx.options), { styles, width }));
  label = "";
  lines.push(
    "",
    ...row(
      "BASE",
      `${ctx.baseRef.ref} → ${shortSha(ctx.baseSha)}  (${baseSourceTag(ctx)})`,
      { styles, width },
    ),
    // The second endpoint of the pair the details view explains: what the diff
    // is actually computed from, which is the merge base unless --two-dot moved
    // it back to the base tip.
    ...row(
      "RANGE",
      `${shortSha(ctx.diffFromSha)} → ${shortSha(ctx.headSha)}  ` +
        (ctx.options.twoDot ? "(--two-dot, two-point range)" : "(merge base)"),
      { styles, width },
    ),
    ...row(
      "RUN",
      `${path.basename(ctx.runDir)} · ` +
        (ctx.codegraphAvailable ? "codegraph live" : "codegraph NOT FOUND") +
        ` · hop budget ${ctx.options.hopBudget}` +
        ` · ${ctx.config.suspicion_priors.length} prior(s)`,
      { styles, width },
    ),
    ...configRow(ctx.configProvenance, ctx.options, styles, width),
    ...decisionLines(
      {
        sizeGate: ctx.sizeGate,
        droppedPaths: ctx.droppedPaths,
        force: ctx.options.force,
        estimate: ctx.estimate,
        hunterCount: ctx.hunterCount,
        summarizer: ctx.summary.enabled,
      },
      styles,
      width,
    ),
  );
  return lines;
}

export interface PrPlanContext {
  options: CliOptions;
  operatorRoot: string;
  target: PrTarget;
  worktreePath: string;
  runDir: string;
  diffStat: DiffStat;
  agentsDir: string;
  agentFiles: Map<string, ParsedAgent>;
  spec: ReviewSpec;
  config: LocalConfig;
  summary: SummarySettings;
  estimate: ReturnType<typeof estimateCost>;
  hunterCount: number;
  // Same contract as PlanContext: the verdict is decided by the shell (and
  // in PR mode enforced before the run dir even exists), printed here.
  sizeGate: SizeGateVerdict;
  sizeGateNote?: string;
  droppedPaths: string[];
  // C5 O-7, same contract as PlanContext's.
  configProvenance?: ConfigProvenance;
  // Set when this plan follows an interactive "Review anyway" at the
  // size-gate menu. Distinct from options.force so the decision block can
  // say "confirmed" rather than lie that --force was passed.
  sizeGateConfirmed?: boolean;
  // Present only once the fetch has happened: the canonical range and the
  // on-disk diff. A dry-run plan prints GitHub's own counters instead.
  resolved?: {
    baseSha: string;
    diffFromSha: string;
    diffPath: string;
    parityFires: boolean;
  };
  // Same contract, same reason as PlanContext.width.
  width?: number;
  // Item 7: queued verify steps shown as their own cost-band term (O-5a).
  verificationSteps?: number;
  rereview?: {
    case: string;
    lastHead: string | null;
    discoveryRestricted: boolean;
    skipDiscovery: boolean;
  };
}

function prBaseSourceNote(target: PrTarget): string {
  return target.baseSource === "merge-commit-parent"
    ? "first parent of the merge commit — base as it was when the PR landed"
    : `tip of ${target.baseRefName} as recorded on the PR`;
}

// A merged PR's baseRef is a `<sha>^1` EXPRESSION, not a branch name, so the
// card would otherwise carry a 40-char sha with a suffix. Shortened only for
// display, and only when it really is a full commit id — a branch name that
// happens to be long is left whole, because truncating a ref makes it
// unusable. The details view and pipeline.json both keep the full form.
function shortRev(rev: string): string {
  const bare = rev.replace(/\^\d*$/, "");
  return isFullCommitId(bare) ? shortSha(bare) + rev.slice(bare.length) : rev;
}

// The same fact in one token, for the card; the sentence above is the
// details view's job.
function prBaseSourceTag(target: PrTarget): string {
  return target.baseSource === "merge-commit-parent"
    ? "merge commit parent"
    : "PR base tip";
}

// Pre-fetch the parity trigger cannot be evaluated (there is no diff yet).
// When triggers are configured the parity hunter MIGHT fire, so it counts:
// both recorded cost overruns were under-estimates, and a band that errs
// high costs a second of hesitation while one that errs low costs money.
function dryRunHunterCount(spec: ReviewSpec, config: LocalConfig): number {
  return spec.agents.filter(
    (a) =>
      a.role === "hunter" &&
      (a.trigger === undefined || config.parity_trigger_paths.length > 0),
  ).length;
}

// Predicted, not decided: the ensure step runs only after the confirm gate,
// so the plan can promise a create but must leave reuse-vs-recreate to the
// HEAD and cleanliness checks at run time.
function worktreePlanNote(worktreePath: string): string {
  return existsSync(worktreePath)
    ? "exists — reuse/recreate decided at run time"
    : "will create (git worktree add --detach)";
}

function codegraphPlanNote(worktreePath: string): string {
  if (existsSync(path.join(worktreePath, ".codegraph"))) {
    return (
      "available (.codegraph found in the worktree; codegraph_explore " +
      "is live)"
    );
  }
  return Bun.which("codegraph") === null
    ? "codegraph CLI not found — hunters run on Read/Grep/Glob alone"
    : "will `codegraph init` in the worktree (~10s measured)";
}

// Same three states as codegraphPlanNote, in card width.
function codegraphPlanTag(worktreePath: string): string {
  if (existsSync(path.join(worktreePath, ".codegraph"))) {
    return "codegraph live";
  }
  return Bun.which("codegraph") === null
    ? "codegraph NOT FOUND"
    : "codegraph init ~10s";
}

function prWorktreePlanTag(worktreePath: string): string {
  return existsSync(worktreePath)
    ? "worktree exists"
    : "worktree will be created";
}

// PR mode's half of planDetails — same contract, same test-only export:
// printed only when the confirm menu's "Show details" option asks for it.
export function prPlanDetails(ctx: PrPlanContext, styles: boolean): string[] {
  const width = ctx.width ?? terminalWidth();
  const pairs: [string, string][] = [];
  const push = (label: string, value: string): void => {
    pairs.push([label, value]);
  };
  push("repo", `${ctx.operatorRoot} (operator checkout; gh and git run here)`);
  push("head", `${ctx.target.headSha} (the PR's head commit)`);
  // BOTH endpoints, always — the rule local mode's details view spells out.
  // The card shows the pair as short shas; here they are whole, with the
  // sentence that says which is which.
  push(
    "base",
    ctx.resolved
      ? `${ctx.target.baseRef} → ${ctx.resolved.baseSha} ` +
          `(${prBaseSourceNote(ctx.target)})`
      : `${ctx.target.baseRef} (${prBaseSourceNote(ctx.target)}; resolved ` +
          "after fetch)",
  );
  if (ctx.resolved) {
    push(
      "diff from",
      `${ctx.resolved.diffFromSha} — merge base of base and the PR head; ` +
        "only what the PR adds is reviewed",
    );
  }
  push(
    "diff",
    ctx.resolved
      ? ctx.resolved.diffPath
      : "band from gh; exact numstat after fetch",
  );
  push(
    "worktree",
    `${ctx.worktreePath} — ${worktreePlanNote(ctx.worktreePath)}`,
  );
  push("agents dir", ctx.agentsDir);
  if (ctx.configProvenance) {
    // The repo path here is the OPERATOR checkout's, never the worktree's
    // (O-8) — printed so that fact is visible rather than asserted.
    push("config", configDetail(ctx.configProvenance, ctx.options));
  }
  push("run dir", ctx.runDir);
  push("hop budget", String(ctx.options.hopBudget));
  push("summarizer", summarizerRow(ctx.summary));
  push("scout", scoutRow(ctx.options));
  if (ctx.rereview) {
    const last =
      ctx.rereview.lastHead === null
        ? "none"
        : ctx.rereview.lastHead.slice(0, 8);
    push(
      "re-review",
      `case ${ctx.rereview.case} · L=${last}` +
        (ctx.rereview.skipDiscovery
          ? " · discovery skipped (empty delta)"
          : ctx.rereview.discoveryRestricted
            ? " · restricted L..H"
            : " · full B..H"),
    );
    if (ctx.rereview.case === "D") {
      push(
        "D4",
        "last reviewed head is not an ancestor of this head — full B..H",
      );
    }
  }
  if (ctx.verificationSteps !== undefined && ctx.verificationSteps > 0) {
    push(
      "verify",
      `${ctx.verificationSteps} verification step(s) (capped; not bypassed by --yes)`,
    );
  }
  if (ctx.options.post) {
    push(
      "post",
      "a marked PR comment will be created, or updated in place if one " +
        "exists (idempotent — one comment per PR, found by its marker)",
    );
  }
  push(
    "parity",
    ctx.config.parity_trigger_paths.length === 0
      ? "no parity_trigger_paths configured — the parity hunter never fires"
      : ctx.resolved === undefined
        ? `configured (${ctx.config.parity_trigger_paths.length} ` +
          "pattern(s)); whether a changed path matches is decided after fetch"
        : ctx.resolved.parityFires
          ? `fires (a changed path matches ${ctx.config.parity_trigger_paths.length} configured pattern(s))`
          : "configured, but no changed path matches — it will not fire",
  );
  push("codegraph", codegraphPlanNote(ctx.worktreePath));
  push("priors", `${ctx.config.suspicion_priors.length} suspicion prior(s)`);
  push("estimate", ctx.estimate.basis);
  push("permissions", PERMISSIONS_NOTE);
  return [section("details", styles), ...detailRows(pairs, styles, width)];
}

export function renderPrPlan(ctx: PrPlanContext, styles: boolean): string[] {
  const width = ctx.width ?? terminalWidth();
  const lines = [
    ...box(
      `pr-hero · PR #${ctx.target.number}`,
      [
        ctx.target.title,
        `${ctx.target.state} · base ${ctx.target.baseRefName} · ` +
          `${ctx.diffStat.files} files  +${ctx.diffStat.insertions} ` +
          `−${ctx.diffStat.deletions}` +
          (ctx.resolved ? "" : " (gh counters)"),
      ],
      { styles, width },
    ),
    "",
  ];
  let label = "AGENTS";
  for (const agent of ctx.spec.agents) {
    const fires =
      agent.role === "refuter"
        ? "per severe finding"
        : agent.trigger === undefined
          ? "always"
          : ctx.resolved === undefined
            ? "decided by the diff after fetch"
            : ctx.resolved.parityFires
              ? "triggered"
              : "✗ will not fire";
    lines.push(...row(label, agentRow(ctx, agent, fires), { styles, width }));
    label = "";
  }
  lines.push(...row(label, summarizerRow(ctx.summary), { styles, width }));
  lines.push(...row("", scoutRow(ctx.options), { styles, width }));
  if (ctx.rereview) {
    lines.push(
      ...row(
        "",
        `re-review   case ${ctx.rereview.case}` +
          (ctx.rereview.skipDiscovery
            ? "  discovery skipped"
            : ctx.rereview.discoveryRestricted
              ? "  restricted"
              : "  full range"),
        { styles, width },
      ),
    );
    if (ctx.rereview.case === "D") {
      lines.push(
        ...row(
          "",
          "⚠️ last reviewed head is not an ancestor — reviewing full B..H",
          { styles, width },
        ),
      );
    }
  }
  if (ctx.verificationSteps !== undefined && ctx.verificationSteps > 0) {
    lines.push(
      ...row("", `verify      ${ctx.verificationSteps} step(s)`, {
        styles,
        width,
      }),
    );
  }
  label = "";
  lines.push(
    "",
    ...row(
      "BASE",
      ctx.resolved
        ? `${shortRev(ctx.target.baseRef)} → ` +
            `${shortSha(ctx.resolved.baseSha)}  ` +
            `(${prBaseSourceTag(ctx.target)})`
        : `${shortRev(ctx.target.baseRef)}  (${prBaseSourceTag(ctx.target)}; ` +
            "resolved after fetch)",
      { styles, width },
    ),
    // The other endpoint. Pre-fetch there is no merge base yet, so the card
    // says so rather than showing the head alone — a single endpoint is the
    // ambiguity the details view's rule exists to prevent.
    ...row(
      "RANGE",
      ctx.resolved
        ? `${shortSha(ctx.resolved.diffFromSha)} → ` +
            `${shortSha(ctx.target.headSha)}  (merge base)`
        : // A bare "?" for the unresolved endpoint was honest and read as a
          // bug. Name the operation instead: the reader learns WHAT will be
          // reviewed (only what the PR adds) without being shown a
          // placeholder where a sha belongs.
          `merge base of ${shortRev(ctx.target.baseRef)} → ` +
            `${shortSha(ctx.target.headSha)}  (exact sha after fetch)`,
      { styles, width },
    ),
    ...row(
      "RUN",
      `${path.basename(ctx.runDir)} · ` +
        `${prWorktreePlanTag(ctx.worktreePath)} · ` +
        `${codegraphPlanTag(ctx.worktreePath)} · ` +
        `hop budget ${ctx.options.hopBudget} · ` +
        `${ctx.config.suspicion_priors.length} prior(s)`,
      { styles, width },
    ),
    ...configRow(ctx.configProvenance, ctx.options, styles, width),
  );
  if (ctx.options.post) {
    lines.push(
      ...row(
        "POST",
        "✓ one marked PR comment — created, or updated in place (idempotent)",
        { styles, width },
      ),
    );
  }
  lines.push(
    ...decisionLines(
      {
        sizeGate: ctx.sizeGate,
        ...(ctx.sizeGateNote === undefined
          ? {}
          : { sizeGateNote: ctx.sizeGateNote }),
        droppedPaths: ctx.droppedPaths,
        force: ctx.options.force,
        ...(ctx.sizeGateConfirmed === true ? { sizeGateConfirmed: true } : {}),
        estimate: ctx.estimate,
        hunterCount: ctx.hunterCount,
        summarizer: ctx.summary.enabled,
      },
      styles,
      width,
    ),
  );
  return lines;
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

// Read from package.json rather than the constants in index.ts: the version a
// run is stamped with must be the one that would be published, and a
// hand-maintained duplicate drifts.
// C4 O-0. `version` alone does not discriminate: it is read from package.json,
// which has said 0.1.0 since the scaffold commit, so every run this engine has
// ever written — before and after a change that alters what every agent reads
// — reports the same engine. That is not a cosmetic gap. The Cal.com Martian
// baseline is ratified as valid ACROSS engine versions on the condition that
// the frontier is annotated (docs/martian-bench.md), and an artifact whose
// engine field cannot change cannot annotate anything.
//
// The revision is the git commit, which moves on its own and needs nobody to
// remember a bump — the failure mode this whole item exists to remove.
//
async function upgradeCommand(options: CliOptions): Promise<number> {
  const home = os.homedir();
  const layout = prheroLayout(home);
  const identity = await engineIdentity();
  const currentVersion = identity.version;

  if (options.reconcile) {
    log("Reconciling agent skills, MCP registrations, and product database...");
    const res = await reconcileUpgrade({ home });
    if (!res.ok) {
      log(
        `warning: reconciliation encountered issues: ${res.errors.join("; ")}`,
      );
      return 1;
    }
    const cache = readUpgradeCache(layout.upgradeCheckPath);
    if (cache) {
      writeUpgradeCache(layout.upgradeCheckPath, {
        ...cache,
        reconciled_version: currentVersion,
      });
    }
    log(
      "✓ Reconciliation complete (skills synced, MCP verified, store ready).",
    );
    return 0;
  }

  const method = detectInstallMethod({
    home,
    execPath: process.execPath,
    version: currentVersion,
  });

  // Query latest release
  let latestVersion = currentVersion;
  let releaseUrl = `https://github.com/${PRHERO_GITHUB_REPO}/releases/latest`;
  let changelog = "";

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${PRHERO_GITHUB_REPO}/releases/latest`,
      {
        headers: { "User-Agent": "pr-hero-cli" },
      },
    );
    if (resp.ok) {
      const data = (await resp.json()) as {
        tag_name?: string;
        html_url?: string;
        body?: string;
      };
      if (data.tag_name) {
        latestVersion = data.tag_name.replace(/^v/, "");
      }
      if (data.html_url) releaseUrl = data.html_url;
      if (data.body) changelog = data.body;

      writeUpgradeCache(layout.upgradeCheckPath, {
        checked_at: new Date().toISOString(),
        current_version: currentVersion,
        latest_version: latestVersion,
        reconciled_version: currentVersion,
        release_url: releaseUrl,
        changelog,
      });
    }
  } catch {
    // Network failure fallback to cache
    const cache = readUpgradeCache(layout.upgradeCheckPath);
    if (cache?.latest_version) {
      latestVersion = cache.latest_version;
    }
  }

  if (options.check) {
    log(`pr-hero version: v${currentVersion}`);
    log(`latest release:  v${latestVersion} (${releaseUrl})`);
    if (currentVersion === latestVersion) {
      log("✓ pr-hero is up to date.");
    } else {
      log(`Update available! Run 'pr-hero upgrade' to update.`);
    }
    return 0;
  }

  const plan = await planUpgrade({
    installMethod: method,
    currentVersion,
    targetVersion: latestVersion,
    home,
  });

  if (plan.action === "noop_source") {
    log(`info: ${plan.message}`);
    log("Running asset reconciliation to keep skills & MCP in sync...");
    await reconcileUpgrade({ home });
    log("✓ Synced skills & MCP registrations.");
    return 0;
  }

  if (plan.action === "up_to_date") {
    log(`✓ pr-hero is already up to date (v${currentVersion}).`);
    log("Running asset reconciliation to keep skills & MCP in sync...");
    await reconcileUpgrade({ home });
    log("✓ Synced skills & MCP registrations.");
    return 0;
  }

  if (options.dryRun) {
    log("Planned upgrade steps (--dry-run):");
    for (const step of plan.steps) {
      log(`  • ${step}`);
    }
    return 0;
  }

  if (plan.action === "upgrade_package_manager") {
    log("pr-hero is installed via global package manager.");
    log(
      `Please run: ${method.kind === "package_manager" ? method.manager : "npm"} install -g pr-hero@latest`,
    );
    return 0;
  }

  if (plan.action === "upgrade_standalone") {
    const downloadUrl = plan.downloadUrl;
    const checksumsUrl = plan.checksumsUrl;
    const tempBinary = plan.tempBinary;
    const targetBinary = plan.targetBinary;
    const bakBinary = plan.bakBinary;

    if (
      !downloadUrl ||
      !checksumsUrl ||
      !tempBinary ||
      !targetBinary ||
      !bakBinary
    ) {
      throw new CliError("Incomplete standalone upgrade plan.");
    }

    log(`Downloading ${downloadUrl}...`);
    const binResp = await fetch(downloadUrl);
    if (!binResp.ok) {
      throw new CliError(
        `Failed to download pr-hero binary from ${downloadUrl}`,
      );
    }
    const binBuffer = await binResp.arrayBuffer();

    log("Verifying SHA256 checksums...");
    const sumsResp = await fetch(checksumsUrl);
    if (!sumsResp.ok) {
      throw new CliError(`Failed to download SHA256SUMS from ${checksumsUrl}`);
    }
    const sumsText = await sumsResp.text();

    const actualHash = crypto
      .createHash("sha256")
      .update(Buffer.from(binBuffer))
      .digest("hex");
    const targetFileName = path.basename(downloadUrl);
    const expectedLine = sumsText
      .split("\n")
      .find((l) => l.includes(targetFileName));
    if (!expectedLine?.startsWith(actualHash)) {
      throw new CliError(
        `SHA256 checksum verification failed for ${targetFileName}!`,
      );
    }

    await Bun.write(tempBinary, binBuffer);
    chmodSync(tempBinary, 0o755);

    if (existsSync(bakBinary)) {
      try {
        unlinkSync(bakBinary);
      } catch {
        // ignore
      }
    }

    if (existsSync(targetBinary)) {
      renameSync(targetBinary, bakBinary);
    }
    renameSync(tempBinary, targetBinary);

    // Smoke test that the upgraded binary can execute before removing backup
    const smokeProc = Bun.spawn([targetBinary, "--help"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const smokeExit = await smokeProc.exited;

    if (smokeExit !== 0) {
      log(
        "warning: upgraded binary failed to execute. Restoring previous version...",
      );
      if (existsSync(bakBinary)) {
        renameSync(bakBinary, targetBinary);
      }
      throw new CliError(
        "Upgrade failed during binary validation and was rolled back.",
      );
    }

    if (existsSync(bakBinary)) {
      unlinkSync(bakBinary);
    }

    log("Running reconciliation via upgraded binary...");
    const proc = Bun.spawn([targetBinary, "upgrade", "--reconcile"], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      log(
        "warning: reconciliation reported errors. Run 'pr-hero upgrade --reconcile' to retry.",
      );
    }

    log(`✓ Successfully upgraded pr-hero to v${latestVersion}!`);
    return 0;
  }

  return 0;
}

async function uninstallCommand(options: CliOptions): Promise<number> {
  const home = os.homedir();
  const repoRoot = options.repo
    ? await resolveRepoRoot(options.repo).catch(() => undefined)
    : await resolveRepoRoot(process.cwd()).catch(() => undefined);

  const plan = await planUninstallation({
    home,
    purge: options.purge,
    repoRoot,
  });

  if (options.dryRun) {
    log("Planned uninstallation steps (--dry-run):");
    for (const s of [...plan.programSteps, ...plan.dataSteps]) {
      log(`  • ${s.desc}`);
    }
    if (plan.warnings.length > 0) {
      for (const w of plan.warnings) log(`warning: ${w}`);
    }
    return 0;
  }

  const res = await executeUninstallPlan(plan);
  if (!res.ok) {
    for (const err of res.errors) log(`warning: ${err}`);
  }

  log("✓ pr-hero uninstallation complete.");
  return 0;
}

async function activityCommand(options: CliOptions): Promise<number> {
  const home = os.homedir();

  if (options.kill !== undefined) {
    const pid = options.kill;
    if (!options.yes) {
      if (!process.stdin.isTTY) {
        throw new CliError(
          "--yes is required to terminate a review in non-interactive mode",
        );
      }
      process.stderr.write(`Terminate review process (PID ${pid})? [y/N] `);
      const reader = process.stdin[Symbol.asyncIterator]();
      const chunk = (await reader.next()).value;
      const answer = chunk ? chunk.toString().trim().toLowerCase() : "";
      if (answer !== "y" && answer !== "yes") {
        log("Aborted.");
        return 0;
      }
    }

    const res = await killActiveRun(pid, { home });
    if (res.status === "not_found") {
      log(`error: ${res.message}`);
      return 1;
    }
    if (res.status === "identity_mismatch") {
      log(`error: ${res.message}`);
      return 1;
    }
    if (res.status === "terminated") {
      log(`✓ Terminated review process ${res.pid} (${res.signal}).`);
      if (res.warning) {
        log(`warning: ${res.warning}`);
      }
      return 0;
    }
    return 0;
  }

  const runs = await listActiveRuns({ home });
  const spend = await getWatcherSpend({ home });
  const history = await queryRecentRuns({ home, limit: 10 });

  const lines = renderActivityScreen(
    { runs, spend, history },
    { styles: styleEnabled(), width: terminalWidth() },
  );

  for (const line of lines) {
    log(line);
  }

  return 0;
}

// PURE half, so the fallbacks are testable without a filesystem or a spawn.
export function deriveEngineIdentity(
  pkg: { name?: string; version?: string },
  revision: { ok: boolean; stdout: string },
): { name: string; version: string; revision?: string } {
  const sha = revision.ok ? revision.stdout.trim() : "";
  return {
    name: pkg.name ?? "pr-hero",
    version: pkg.version ?? "0.0.0",
    // ABSENT rather than "unknown" when git cannot answer. A checkout without
    // git, or a tarball install, still has to be able to run a review — a run
    // that refused to start over a provenance field would trade a paid review
    // for a string. Absent reads as "this run could not name its commit",
    // which is exactly true, and it is also what every pre-C4 artifact says.
    ...(sha.length === 0 ? {} : { revision: sha }),
  };
}

async function engineIdentity(): Promise<{
  name: string;
  version: string;
  revision?: string;
}> {
  const pkgPath = path.join(import.meta.dir, "..", "package.json");
  const pkg = (await Bun.file(pkgPath).json()) as {
    name?: string;
    version?: string;
  };
  // `import.meta.dir` and not cwd: the revision that matters is the ENGINE's,
  // and in PR mode the process is routinely pointed at a worktree of somebody
  // else's repository. Reading that repo's HEAD here would stamp a review with
  // the reviewed project's commit and quietly make the field a lie.
  const revision = await git(path.join(import.meta.dir, ".."), [
    "rev-parse",
    "--short",
    "HEAD",
  ]);
  return deriveEngineIdentity(pkg, revision);
}

// Only when executed, never on import — the pure helpers stay importable from
// tests without the CLI trying to run a review.
if (import.meta.main) {
  process.on("SIGTERM", async () => {
    try {
      killAllChildProcesses();
      await unregisterActiveRun(process.pid);
    } catch {
      // Ignore
    }
    process.exit(143);
  });
  process.exit(await main(Bun.argv.slice(2)));
}
