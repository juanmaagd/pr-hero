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
import path from "node:path";
import { mergeRunEnvelope, type Telemetry, writeFindings } from "./findings";
import { changedPathsFromDiff, parityTriggered, runPipeline } from "./pipeline";
import {
  AGENT_FILE_PATTERNS,
  agentsDirProblems,
  assertBasenameOnly,
  assertOutsideRepo,
  type CliOptions,
  CliUsageError,
  defaultRunRoot,
  EMPTY_LOCAL_CONFIG,
  gotchasErrorMessage,
  HELP_TEXT,
  isFullCommitId,
  type LocalConfig,
  localReviewSpec,
  parseArgs,
  parseLocalConfig,
  parseNumstat,
  runDirCandidate,
  SUGGESTED_AGENTS_DIR,
} from "./preflight";
import { type ParsedAgent, parseAgentFile } from "./prompt-set";
import { type DiffStat, estimateCost, renderReport } from "./report";
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

class CliError extends Error {}

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
    return await review(parsed.options);
  } catch (error) {
    if (error instanceof CliError || error instanceof CliUsageError) {
      log(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function review(options: CliOptions): Promise<number> {
  // 1 — the repo.
  const repoArg = path.resolve(options.repo);
  const toplevel = await git(repoArg, ["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok) {
    throw new CliError(`not a git repository: ${repoArg}`);
  }
  const repoRoot = toplevel.stdout.trim();

  // 2 — canonical refs.
  const baseSha = await resolveCommit(repoRoot, options.base);
  const headSha = await resolveCommit(repoRoot, options.head);
  if (baseSha === headSha) {
    throw new CliError(
      `base and head resolve to the same commit (${headSha}); there is ` +
        "nothing to review",
    );
  }

  // 3 — the tree the hunters will actually read.
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

  // 4 + 5 — the prompt set and the wiring that consumes it.
  const agentsDir = resolveAgentsDir(options);
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

  // 6 — optional repo config. An explicit --config is an ERROR when missing:
  // silently falling back to "no parity triggers" would disable a hunter the
  // caller just asked for, and a hunter that never fires looks exactly like a
  // hunter that found nothing.
  const configPath = options.config
    ? path.resolve(options.config)
    : path.join(repoRoot, ".prhero", "config.json");
  if (options.config && !existsSync(configPath)) {
    throw new CliError(`config file not found: ${configPath}`);
  }
  const config: LocalConfig = existsSync(configPath)
    ? parseLocalConfig(await Bun.file(configPath).text())
    : EMPTY_LOCAL_CONFIG;

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
  const diff = await git(repoRoot, ["diff", `${baseSha}..${headSha}`]);
  if (!diff.ok) throw new CliError(`git diff failed: ${diff.stderr}`);
  if (diff.stdout.trim().length === 0) {
    throw new CliError(
      `the diff ${options.base}..${options.head} is empty; there is nothing ` +
        "to review",
    );
  }
  await Bun.write(diffPath, diff.stdout);

  // 9 — diff stat.
  const numstat = await git(repoRoot, [
    "diff",
    "--numstat",
    `${baseSha}..${headSha}`,
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
    baseSha,
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
      baseSha,
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
    base_sha: baseSha,
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
      base: options.base,
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

function resolveAgentsDir(options: CliOptions): string {
  const raw = options.agents ?? process.env.PRHERO_AGENTS_DIR;
  if (!raw) {
    throw new CliError(
      "no prompt set given. Pass --agents <dir> or set PRHERO_AGENTS_DIR. " +
        `The current clean set is ${SUGGESTED_AGENTS_DIR}`,
    );
  }
  const resolved = path.resolve(raw);
  if (!existsSync(resolved)) {
    throw new CliError(`agents dir does not exist: ${resolved}`);
  }
  return resolved;
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

interface PlanContext {
  options: CliOptions;
  repoRoot: string;
  baseSha: string;
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

function printPlan(ctx: PlanContext): void {
  const row = (label: string, value: string): void => {
    log(`  ${label.padEnd(15)}${value}`);
  };
  log("pr-hero review — plan");
  log();
  row("repo", ctx.repoRoot);
  row("base", `${ctx.options.base} → ${ctx.baseSha}`);
  row("head", `${ctx.options.head} → ${ctx.headSha}`);
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
