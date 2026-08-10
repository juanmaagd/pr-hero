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
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { mergeRunEnvelope, type Telemetry, writeFindings } from "./findings";
import {
  aggregateLedger,
  parseComparisonJson,
  renderLedger,
  type StoredComparison,
} from "./ledger";
import { changedPathsFromDiff, parityTriggered, runPipeline } from "./pipeline";
import {
  type ComparisonOutcome,
  ensureWorktree,
  fetchPrRefs,
  ghPrView,
  initCodegraphIndex,
  postPrComment,
  writeComparison,
} from "./pr";
import {
  type PrTarget,
  prRunDirCandidate,
  prWorktreePath,
  resolvePrTarget,
} from "./pr-preflight";
import {
  AGENT_FILE_PATTERNS,
  agentsDirProblems,
  assertBasenameOnly,
  assertOutsideRepo,
  type BaseRefResolution,
  CliError,
  type CliOptions,
  CliUsageError,
  defaultRunRoot,
  EMPTY_LOCAL_CONFIG,
  emptyDiffMessage,
  GOTCHAS_TEMPLATE,
  gotchasErrorMessage,
  HELP_TEXT,
  headContainedInBaseMessage,
  INIT_GIT_REMINDER,
  initConfigTemplate,
  isFullCommitId,
  type LocalConfig,
  localReviewSpec,
  parseArgs,
  parseLocalConfig,
  parseNumstat,
  parseRemoteHead,
  resolveAgentsDirSetting,
  resolveBaseRef,
  runDirCandidate,
  SUGGESTED_AGENTS_DIR,
} from "./preflight";
import { type ParsedAgent, parseAgentFile } from "./prompt-set";
import {
  type DiffStat,
  estimateCost,
  renderPrComment,
  renderReport,
} from "./report";
import { type ReviewSpec, validateReviewSpec } from "./spec";
import { ClaudeCodeRunner } from "./step-runner";

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

const EMPTY_MCP_CONFIG = { mcpServers: {} };

function log(line = ""): void {
  process.stderr.write(`${line}\n`);
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

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
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
      : parsed.command === "ledger"
        ? await ledgerCommand(parsed.options)
        : await review(parsed.options);
  } catch (error) {
    if (error instanceof CliError || error instanceof CliUsageError) {
      log(`error: ${error.message}`);
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
  // An explicit --config is an ERROR when missing: silently falling back to
  // "no parity triggers" would disable a hunter the caller just asked for, and
  // a hunter that never fires looks exactly like a hunter that found nothing.
  const configPath = options.config
    ? path.resolve(options.config)
    : path.join(repoRoot, ".prhero", "config.json");
  if (options.config && !existsSync(configPath)) {
    throw new CliError(`config file not found: ${configPath}`);
  }
  const config: LocalConfig = existsSync(configPath)
    ? parseLocalConfig(await Bun.file(configPath).text())
    : EMPTY_LOCAL_CONFIG;

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
  const agentsDir = resolveAgentsDir(options, config, configPath);
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
  const runDir = await createRunDir(options, repoRoot, headSha);
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
  await Bun.write(diffPath, diff.stdout);

  // 9 — diff stat.
  const numstat = await git(repoRoot, [
    "diff",
    "--numstat",
    `${diffFromSha}..${headSha}`,
  ]);
  if (!numstat.ok) {
    throw new CliError(`git diff --numstat failed: ${numstat.stderr}`);
  }
  const diffStat: DiffStat = parseNumstat(numstat.stdout);

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

  // 11 — the plan.
  const changedPaths = changedPathsFromDiff(diff.stdout);
  const parityFires = parityTriggered(
    changedPaths,
    config.parity_trigger_paths,
  );
  const hunterCount = spec.agents.filter(
    (a) => a.role === "hunter" && (a.trigger === undefined || parityFires),
  ).length;
  const estimate = estimateCost(diffStat, hunterCount);
  printPlan({
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
    parityFires,
    codegraphAvailable,
    estimate,
    hunterCount,
  });

  // 12 — the free exit.
  if (options.dryRun) {
    log();
    log("dry run: nothing was spawned and nothing was spent.");
    return 0;
  }

  // 13 — the paid one.
  if (!options.yes && !(await confirm(estimate.low, estimate.high))) {
    log("aborted; nothing was spent.");
    return 1;
  }

  // 14 — run.
  const started = performance.now();
  const result = await runPipeline(
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
      gotchasPath,
      agentsDir,
      runDir,
      outPath: path.join(runDir, "findings.json"),
      mcpConfigPath,
      hopBudget: options.hopBudget,
      ...(options.model ? { model: options.model } : {}),
      parityTriggerPaths: config.parity_trigger_paths,
      suspicionPriors: config.suspicion_priors,
      spec,
    },
    { runner: new ClaudeCodeRunner() },
  );
  const wallMs = Math.round(performance.now() - started);

  // 15 — the artifact.
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
    engine: await engineIdentity(),
    sessionFailed: result.sessionFailed,
    telemetry,
  });
  const findingsPath = path.join(runDir, "findings.json");
  await writeFindings(findingsPath, doc);

  // 16 — the report.
  const reportPath = path.join(runDir, "report.md");
  await Bun.write(
    reportPath,
    renderReport(doc, {
      repo: path.basename(repoRoot),
      base: baseRef.ref,
      head: options.head,
      diffStat,
      costUsd: result.usage.cost_usd_est,
      wallMs,
    }),
  );

  // 17 — the summary.
  const blocking = doc.findings.filter((f) => f.tier === "blocking").length;
  const advisory = doc.findings.length - blocking;
  const rootCauses = doc.debug.root_causes?.distinct_root_causes ?? 0;
  log();
  log(
    `run ${doc.run_status}: ${blocking} blocking, ${advisory} advisory, ` +
      `${rootCauses} distinct root cause(s), ` +
      `${doc.debug.refuted.length} refuted`,
  );
  log(
    `spent $${result.usage.cost_usd_est.toFixed(2)} in ` +
      `${Math.round(wallMs / 1000)}s (estimated ` +
      `$${estimate.low.toFixed(2)}–$${estimate.high.toFixed(2)})`,
  );
  log(`report:   ${reportPath}`);
  log(`findings: ${findingsPath}`);
  if (result.sessionFailed) {
    log("every hunter failed — this run reviewed nothing.");
    return 1;
  }
  return 0;
}

// PR mode (ROADMAP B1): one command from a PR number to a reviewed range, a
// detached worktree, a pipeline run, and a Greptile comparison.
//
// Two roots run through everything below, and confusing them is the failure
// this design exists to prevent:
//   - the OPERATOR root: --repo's toplevel. cwd for every gh and git call
//     (the fetch, rev-parse, merge-base and diff all share its object db),
//     home of .prhero/ config+gotchas resolution, anchor of the run-dir
//     default. Config is NEVER read from the worktree — the operator
//     checkout is the trust anchor, and a reviewed PR's tree must not
//     influence engine config.
//   - the REVIEW root: the worktree, detached at the PR's head. The
//     pipeline's cwd, the tree the codegraph checks run against, and the
//     second root the run dir must stay outside of.
async function reviewPr(
  options: CliOptions,
  prNumber: number,
): Promise<number> {
  // 1 — the operator root, and everything .prhero/ decides — loaded exactly
  // as local mode loads it, all against the operator root.
  const operatorRoot = await resolveRepoRoot(options.repo);
  const configPath = options.config
    ? path.resolve(options.config)
    : path.join(operatorRoot, ".prhero", "config.json");
  if (options.config && !existsSync(configPath)) {
    throw new CliError(`config file not found: ${configPath}`);
  }
  const config: LocalConfig = existsSync(configPath)
    ? parseLocalConfig(await Bun.file(configPath).text())
    : EMPTY_LOCAL_CONFIG;
  const agentsDir = resolveAgentsDir(options, config, configPath);
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

  // 2 — the PR record, and the review root's name derived from it.
  const target = resolvePrTarget(await ghPrView(operatorRoot, prNumber));
  const worktreePath = prWorktreePath(operatorRoot, prNumber);

  // 3 — the free exit, BEFORE the fetch: a PR-mode dry run creates NOTHING —
  // no fetch, no run dir, no worktree — so the cost band rides on GitHub's
  // own counters instead of a local numstat.
  if (options.dryRun) {
    const hunterCount = dryRunHunterCount(spec, config);
    const estimate = estimateCost(target.ghDiffStat, hunterCount);
    printPrPlan({
      options,
      operatorRoot,
      target,
      worktreePath,
      runDir: predictPrRunDir(
        options,
        operatorRoot,
        worktreePath,
        prNumber,
        target.headSha,
      ),
      diffStat: target.ghDiffStat,
      agentsDir,
      agentFiles,
      spec,
      config,
      estimate,
      hunterCount,
    });
    log();
    log("dry run: nothing was fetched, created, or spent.");
    return 0;
  }

  // 4 — fetch, then canonicalize. See fetchPrRefs for why that refspec pair.
  await fetchPrRefs(operatorRoot, prNumber, target.baseRefName);
  const headSha = await resolveCommit(operatorRoot, target.headSha);
  // baseRef may be a `<sha>^1` expression (merged PR); rev-parse settles it.
  const baseSha = await resolveCommit(operatorRoot, target.baseRef);
  if (baseSha === headSha) {
    throw new CliError(
      `base and head resolve to the same commit (${headSha}); there is ` +
        "nothing to review",
    );
  }
  const headLabel = `PR #${prNumber} head`;
  const diffFromSha = await resolveDiffFrom(
    operatorRoot,
    false,
    target.baseRef,
    headLabel,
    baseSha,
    headSha,
  );

  // 5 — the diff and its true size, computed in the operator root (the
  // worktree shares its object db) and BEFORE anything is created on disk.
  const diff = await git(operatorRoot, ["diff", `${diffFromSha}..${headSha}`]);
  if (!diff.ok) throw new CliError(`git diff failed: ${diff.stderr}`);
  if (diff.stdout.trim().length === 0) {
    throw new CliError(emptyDiffMessage(target.baseRef, headLabel, false));
  }
  const numstat = await git(operatorRoot, [
    "diff",
    "--numstat",
    `${diffFromSha}..${headSha}`,
  ]);
  if (!numstat.ok) {
    throw new CliError(`git diff --numstat failed: ${numstat.stderr}`);
  }
  const diffStat: DiffStat = parseNumstat(numstat.stdout);

  // 6 — run dir + diff artifact (PR naming; outside BOTH roots).
  const runDir = await createPrRunDir(
    options,
    operatorRoot,
    worktreePath,
    prNumber,
    headSha,
  );
  const diffPath = path.join(runDir, "diff.patch");
  await Bun.write(diffPath, diff.stdout);

  // 7 — the plan and the paid gate, exactly like local mode but with the
  // real numstat replacing GitHub's counters.
  const changedPaths = changedPathsFromDiff(diff.stdout);
  const parityFires = parityTriggered(
    changedPaths,
    config.parity_trigger_paths,
  );
  const hunterCount = spec.agents.filter(
    (a) => a.role === "hunter" && (a.trigger === undefined || parityFires),
  ).length;
  const estimate = estimateCost(diffStat, hunterCount);
  printPrPlan({
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
    estimate,
    hunterCount,
    resolved: { baseSha, diffFromSha, diffPath, parityFires },
  });
  if (!options.yes && !(await confirm(estimate.low, estimate.high))) {
    log("aborted; nothing was spent.");
    return 1;
  }

  // 8 — the review root.
  const worktree = await ensureWorktree(operatorRoot, worktreePath, headSha);
  log();
  log(`worktree ${worktree.action}: ${worktreePath} (${worktree.reason})`);

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
  const codegraphAvailable = existsSync(path.join(worktreePath, ".codegraph"));
  await Bun.write(
    mcpConfigPath,
    `${JSON.stringify(
      codegraphAvailable ? CODEGRAPH_ONLY_MCP_CONFIG : EMPTY_MCP_CONFIG,
      null,
      2,
    )}\n`,
  );

  // 11 — run. The pipeline is untouched: it gets the worktree as its cwd
  // and the PR's real number for the envelope.
  const started = performance.now();
  const result = await runPipeline(
    {
      pr: prNumber,
      // Same rule as local mode: record the commit the diff was actually
      // computed against, or nothing downstream can reproduce the range.
      baseSha: diffFromSha,
      headSha,
      worktree: worktreePath,
      diffPath,
      gotchasPath,
      agentsDir,
      runDir,
      outPath: path.join(runDir, "findings.json"),
      mcpConfigPath,
      hopBudget: options.hopBudget,
      ...(options.model ? { model: options.model } : {}),
      parityTriggerPaths: config.parity_trigger_paths,
      suspicionPriors: config.suspicion_priors,
      spec,
    },
    { runner: new ClaudeCodeRunner() },
  );
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

  // 14 — the posting, only when asked. AFTER the comparison on purpose: a
  // posting failure must never cost the comparison artifact. And unlike the
  // comparison, posting does NOT degrade to a warning — it was explicitly
  // requested, so a failure propagates as CliError and exits 1 (the review
  // artifacts are already on disk; a lying exit 0 would hide a failed ask).
  let posted: { action: "created" | "updated"; commentId: number } | null =
    null;
  if (options.post) {
    if (result.sessionFailed) {
      // Same honesty rule as the comparison guard above: a clean-bill
      // comment from a review that never ran would be a public lie.
      log(
        "post skipped: every hunter failed, so there is no review to publish",
      );
    } else {
      posted = await postPrComment(
        operatorRoot,
        prNumber,
        renderPrComment(doc),
      );
      log(`posted: ${posted.action} comment ${posted.commentId}`);
    }
  }

  // 15 — the summary.
  const blocking = doc.findings.filter((f) => f.tier === "blocking").length;
  const advisory = doc.findings.length - blocking;
  const rootCauses = doc.debug.root_causes?.distinct_root_causes ?? 0;
  log();
  log(
    `run ${doc.run_status}: ${blocking} blocking, ${advisory} advisory, ` +
      `${rootCauses} distinct root cause(s), ` +
      `${doc.debug.refuted.length} refuted`,
  );
  log(
    `spent $${result.usage.cost_usd_est.toFixed(2)} in ` +
      `${Math.round(wallMs / 1000)}s (estimated ` +
      `$${estimate.low.toFixed(2)}–$${estimate.high.toFixed(2)})`,
  );
  log(`report:     ${reportPath}`);
  log(`findings:   ${findingsPath}`);
  if (comparison) {
    log(
      `comparison: Greptile-only ${comparison.greptileOnly} · Both ` +
        `${comparison.both} · pr-hero-only ${comparison.prheroOnly}` +
        (comparison.greptileFound ? "" : " — no Greptile comment on this PR") +
        ` (${comparison.markdownPath})`,
    );
  }
  if (posted) {
    log(`posted:     ${posted.action} PR comment ${posted.commentId}`);
  }
  // The worktree is kept and reused by decision; cleanup is manual, so hand
  // over the exact command (worktree remove, never rm -rf — a live
  // codegraph daemon holds .codegraph/daemon.sock).
  log("worktree kept for finding-verification; remove it later with:");
  log(`  git -C ${operatorRoot} worktree remove --force ${worktreePath}`);
  if (result.sessionFailed) {
    log("every hunter failed — this run reviewed nothing.");
    return 1;
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

function resolveAgentsDir(
  options: CliOptions,
  config: LocalConfig,
  configPath: string,
): string {
  const { dir } = resolveAgentsDirSetting({
    flag: options.agents,
    configAgentsDir: config.agents_dir,
    configDir: path.dirname(configPath),
    env: process.env.PRHERO_AGENTS_DIR,
    cwd: process.cwd(),
  });
  if (!existsSync(dir)) {
    throw new CliError(`agents dir does not exist: ${dir}`);
  }
  return dir;
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
  // still produce a usable scaffold, so the suggested clean set is the seed of
  // last resort rather than a hard error.
  const agentsFromEnv = process.env.PRHERO_AGENTS_DIR;
  const agentsSeed = options.agents
    ? { dir: path.resolve(options.agents), source: "--agents" }
    : agentsFromEnv
      ? { dir: path.resolve(agentsFromEnv), source: "PRHERO_AGENTS_DIR" }
      : { dir: SUGGESTED_AGENTS_DIR, source: "the suggested clean set" };
  const baseSeed = resolveBaseRef({
    flag: options.base,
    remoteHead: await remoteHeadRef(repoRoot),
  });

  const configPath = path.join(dir, "config.json");
  const gotchasPath = path.join(dir, "gotchas.md");
  const wrote: string[] = [];
  const kept: string[] = [];
  for (const [file, contents] of [
    [
      configPath,
      initConfigTemplate({
        agentsDir: agentsSeed.dir,
        defaultBase: baseSeed.ref,
      }),
    ],
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
  log(`  agents_dir    ${agentsSeed.dir} (from ${agentsSeed.source})`);
  log(`  default_base  ${baseSeed.ref} (from ${baseSeed.source})`);
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
    : defaultRunRoot(repoRoot);
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

async function createRunDir(
  options: CliOptions,
  repoRoot: string,
  headSha: string,
): Promise<string> {
  if (options.out) {
    const explicit = path.resolve(options.out);
    assertOutsideRepo(explicit, repoRoot);
    await mkdir(explicit, { recursive: true });
    return explicit;
  }
  const root = defaultRunRoot(repoRoot);
  // Smallest unused integer, so a second review of the same commit never
  // overwrites the first one's artifacts — a run that cost money is evidence.
  for (let n = 1; ; n++) {
    const candidate = runDirCandidate(root, headSha, n);
    if (existsSync(candidate)) continue;
    assertOutsideRepo(candidate, repoRoot);
    await mkdir(candidate, { recursive: true });
    return candidate;
  }
}

// PR-mode twin of createRunDir, differing in exactly two ways: the candidate
// carries the PR number, and the outside-the-repo assertion runs against
// BOTH roots — artifacts inside either tree would contaminate a review.
async function createPrRunDir(
  options: CliOptions,
  operatorRoot: string,
  worktreePath: string,
  prNumber: number,
  headSha: string,
): Promise<string> {
  const dir = predictPrRunDir(
    options,
    operatorRoot,
    worktreePath,
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
  prNumber: number,
  headSha: string,
): string {
  if (options.out) {
    const explicit = path.resolve(options.out);
    assertOutsideRepo(explicit, operatorRoot);
    assertOutsideRepo(explicit, worktreePath);
    return explicit;
  }
  const root = defaultRunRoot(operatorRoot);
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

interface PlanContext {
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
  parityFires: boolean;
  codegraphAvailable: boolean;
  estimate: ReturnType<typeof estimateCost>;
  hunterCount: number;
}

// Where the base ref came from, because "main" chosen by fallback and "main"
// asked for by name are the same string with very different confidence behind
// them.
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

function printPlan(ctx: PlanContext): void {
  const row = (label: string, value: string): void => {
    log(`  ${label.padEnd(15)}${value}`);
  };
  log("pr-hero review — plan");
  log();
  row("repo", ctx.repoRoot);
  row("base", `${ctx.baseRef.ref} → ${ctx.baseSha} (${baseSourceNote(ctx)})`);
  row("head", `${ctx.options.head} → ${ctx.headSha}`);
  // BOTH endpoints, always. The base ref the user asked for and the commit the
  // diff is actually computed from are different things whenever base has
  // moved on, and a plan that printed only one of them would leave the range
  // ambiguous in exactly the case that motivated the merge-base default.
  row(
    "diff from",
    ctx.options.twoDot
      ? `${ctx.baseSha} — --two-dot: the literal ${ctx.baseRef.ref}..` +
          `${ctx.options.head} two-point range, so commits base gained since ` +
          "the branch point appear REVERSED"
      : `${ctx.diffFromSha} — merge base of ${ctx.baseRef.ref} and ` +
          `${ctx.options.head}; only what this branch adds is reviewed`,
  );
  row(
    "diff",
    `${ctx.diffStat.files} files, +${ctx.diffStat.insertions} ` +
      `−${ctx.diffStat.deletions} (${ctx.diffPath})`,
  );
  row("agents dir", ctx.agentsDir);
  for (const agent of ctx.spec.agents) {
    const parsed = ctx.agentFiles.get(agent.key);
    const model = ctx.options.model ?? agent.model ?? parsed?.model ?? "?";
    const fires =
      agent.role === "refuter"
        ? "per severe finding"
        : agent.trigger === undefined
          ? "always"
          : ctx.parityFires
            ? "triggered"
            : "will NOT fire";
    row("", `${agent.key.padEnd(12)} ${model.padEnd(8)} ${fires}`);
  }
  row("hop budget", String(ctx.options.hopBudget));
  row("run dir", ctx.runDir);
  row(
    "parity",
    ctx.config.parity_trigger_paths.length === 0
      ? "no parity_trigger_paths configured — the parity hunter never fires"
      : ctx.parityFires
        ? `fires (a changed path matches ${ctx.config.parity_trigger_paths.length} configured pattern(s))`
        : "configured, but no changed path matches — it will not fire",
  );
  row(
    "codegraph",
    ctx.codegraphAvailable
      ? "available (.codegraph found; codegraph_explore is live)"
      : "NOT FOUND — the agents' codegraph_explore grant is inert, so this " +
          "review runs on Read/Grep/Glob alone",
  );
  row("priors", `${ctx.config.suspicion_priors.length} suspicion prior(s)`);
  row(
    "cost estimate",
    `$${ctx.estimate.low.toFixed(2)} – $${ctx.estimate.high.toFixed(2)} ` +
      `(${ctx.hunterCount} hunter(s) + refuter)`,
  );
  row("", ctx.estimate.basis);
  row(
    "permissions",
    "steps run with --permission-mode bypassPermissions, bounded only by " +
      "each agent's read-only tool allow-list",
  );
}

interface PrPlanContext {
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
  estimate: ReturnType<typeof estimateCost>;
  hunterCount: number;
  // Present only once the fetch has happened: the canonical range and the
  // on-disk diff. A dry-run plan prints GitHub's own counters instead.
  resolved?: {
    baseSha: string;
    diffFromSha: string;
    diffPath: string;
    parityFires: boolean;
  };
}

function prBaseSourceNote(target: PrTarget): string {
  return target.baseSource === "merge-commit-parent"
    ? "first parent of the merge commit — base as it was when the PR landed"
    : `tip of ${target.baseRefName} as recorded on the PR`;
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

function printPrPlan(ctx: PrPlanContext): void {
  const row = (label: string, value: string): void => {
    log(`  ${label.padEnd(15)}${value}`);
  };
  log("pr-hero review — plan (PR mode)");
  log();
  row("repo", `${ctx.operatorRoot} (operator checkout; gh and git run here)`);
  row("pr", `#${ctx.target.number} [${ctx.target.state}] ${ctx.target.title}`);
  row("head", `${ctx.target.headSha} (the PR's head commit)`);
  row(
    "base",
    ctx.resolved
      ? `${ctx.target.baseRef} → ${ctx.resolved.baseSha} ` +
          `(${prBaseSourceNote(ctx.target)})`
      : `${ctx.target.baseRef} (${prBaseSourceNote(ctx.target)}; resolved ` +
          "after fetch)",
  );
  if (ctx.resolved) {
    row(
      "diff from",
      `${ctx.resolved.diffFromSha} — merge base of base and the PR head; ` +
        "only what the PR adds is reviewed",
    );
  }
  row(
    "diff",
    `${ctx.diffStat.files} files, +${ctx.diffStat.insertions} ` +
      `−${ctx.diffStat.deletions} ` +
      (ctx.resolved
        ? `(${ctx.resolved.diffPath})`
        : "(band from gh; exact numstat after fetch)"),
  );
  row(
    "worktree",
    `${ctx.worktreePath} — ${worktreePlanNote(ctx.worktreePath)}`,
  );
  row("agents dir", ctx.agentsDir);
  for (const agent of ctx.spec.agents) {
    const parsed = ctx.agentFiles.get(agent.key);
    const model = ctx.options.model ?? agent.model ?? parsed?.model ?? "?";
    const fires =
      agent.role === "refuter"
        ? "per severe finding"
        : agent.trigger === undefined
          ? "always"
          : ctx.resolved === undefined
            ? "decided by the diff after fetch"
            : ctx.resolved.parityFires
              ? "triggered"
              : "will NOT fire";
    row("", `${agent.key.padEnd(12)} ${model.padEnd(8)} ${fires}`);
  }
  row("hop budget", String(ctx.options.hopBudget));
  row("run dir", ctx.runDir);
  if (ctx.options.post) {
    row(
      "post",
      "a marked PR comment will be created, or updated in place if one " +
        "exists (idempotent — one comment per PR, found by its marker)",
    );
  }
  row(
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
  row("codegraph", codegraphPlanNote(ctx.worktreePath));
  row("priors", `${ctx.config.suspicion_priors.length} suspicion prior(s)`);
  row(
    "cost estimate",
    `$${ctx.estimate.low.toFixed(2)} – $${ctx.estimate.high.toFixed(2)} ` +
      `(${ctx.hunterCount} hunter(s) + refuter)`,
  );
  row("", ctx.estimate.basis);
  row(
    "permissions",
    "steps run with --permission-mode bypassPermissions, bounded only by " +
      "each agent's read-only tool allow-list",
  );
}

async function confirm(low: number, high: number): Promise<boolean> {
  log();
  process.stderr.write(
    `Spend an estimated $${low.toFixed(2)}–$${high.toFixed(2)} on this ` +
      "review? [y/N] ",
  );
  // One chunk off stdin, then release it. Reading the whole stream would
  // block until EOF, which never comes on an interactive terminal.
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const answer = new TextDecoder()
    .decode(value ?? new Uint8Array())
    .trim()
    .toLowerCase();
  log();
  return answer === "y" || answer === "yes";
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
async function engineIdentity(): Promise<{ name: string; version: string }> {
  const pkgPath = path.join(import.meta.dir, "..", "package.json");
  const pkg = (await Bun.file(pkgPath).json()) as {
    name?: string;
    version?: string;
  };
  return { name: pkg.name ?? "pr-hero", version: pkg.version ?? "0.0.0" };
}

// Only when executed, never on import — the pure helpers stay importable from
// tests without the CLI trying to run a review.
if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
