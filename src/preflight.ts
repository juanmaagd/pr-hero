// Everything local mode (ROADMAP B0) must decide BEFORE it is allowed to
// spend money, expressed as pure functions so it is all testable offline.
// The CLI in cli.ts is the I/O shell around these; nothing here touches the
// filesystem, git, or the network — a preflight that needs a live repo to be
// tested is a preflight that gets tested once, live, at $10 a go.

import path from "node:path";
import type { SuspicionPrior } from "./prompt-set";
import type { ReviewSpec } from "./spec";

// The lab's production value. Also the single biggest per-hunter cost lever
// in the whole engine: every hop is another round of tool calls against the
// tree, and hunter cost scales with hops far more sharply than with diff
// size. The fixture eval runs at 4 precisely because 12 is not cheap.
export const DEFAULT_HOP_BUDGET = 12;

// The LAST resort only. WHY it is not simply "the default": a hardcoded
// default branch silently reviews the wrong range on every repo that does not
// use `main` — musive's default branch is `dev`, so "main" there is not a
// sensible fallback, it is a wrong answer with a plausible face. See
// resolveBaseRef for the order that reaches this constant.
export const DEFAULT_BASE_REF = "main";
export const DEFAULT_HEAD_REF = "HEAD";

// The clean 5-file set at the time of writing. Named in the error text so a
// first-time user is one copy-paste from a working run instead of guessing.
export const SUGGESTED_AGENTS_DIR =
  "/Users/juanma/Desktop/deep-review/agents/slice3b-lifecycle-v6-clean";

export class CliUsageError extends Error {}

// Runtime failure (git, gh, the filesystem) as opposed to a usage error.
// Defined here rather than in a shell so both I/O shells (cli.ts, pr.ts)
// can throw the same class without importing each other.
export class CliError extends Error {}

export interface CliOptions {
  // Relative on purpose: parseArgs is pure, so "resolve against cwd" is the
  // caller's job, not a hidden dependency on process.cwd() in a pure function.
  repo: string;
  // UNSET when no --base was given, never pre-filled with a literal branch
  // name. Resolving the real default branch needs git (the remote head), and
  // parseArgs must stay pure — so the shell in cli.ts finishes the job via
  // resolveBaseRef. A default baked in here would be a wrong ref that nothing
  // downstream can tell apart from one the user asked for.
  base?: string;
  head: string;
  agents?: string;
  out?: string;
  // Gotchas describe the REPO, not the commit under review, so they must be
  // supplyable from outside the reviewed tree — see the note in cli.ts. The
  // same is true of the config: parity triggers and priors are properties of
  // the project, and requiring them in-tree silently disables the conditional
  // parity hunter on any tree you cannot add a file to.
  gotchas?: string;
  config?: string;
  model?: string;
  hopBudget: number;
  dryRun: boolean;
  yes: boolean;
  // PR mode (ROADMAP B1). Set only by --pr: head and base both come from the
  // PR record itself, so parseArgs rejects --base/--head/--two-dot beside it
  // — a hand-picked endpoint would silently contradict the PR's own range.
  pr?: number;
  // Publish the review as ONE marked PR comment (ROADMAP B2) — created the
  // first time, updated in place after, never stacked. Explicit and never a
  // default: posting is a public side effect. Requires --pr (parseArgs
  // enforces it): a comment needs a PR to land on.
  post: boolean;
  // ledger only (ROADMAP B4): the runs root to scan for comparison.json
  // files. Unset means defaultRunRoot(repoRoot) — the shell resolves it,
  // because the default needs the repo toplevel and parseArgs stays pure.
  runs?: string;
  // The escape hatch for change 3's default. See resolveDiffRange's WHY: the
  // three-dot (merge-base) range is right almost always, and this flag exists
  // for the rare caller who genuinely wants the literal two-point diff.
  twoDot: boolean;
}

export interface ParsedCli {
  command: "review" | "init" | "ledger" | "help";
  options: CliOptions;
}

export const HELP_TEXT = `pr-hero — multi-agent review of a real repo + branch

Usage:
  pr-hero review [options]   Review a branch (zero flags inside a configured repo)
  pr-hero init [options]     Scaffold <repo>/.prhero/ (config.json + gotchas.md)
  pr-hero ledger [options]   Accumulate every run's comparison.json into one
                             markdown ledger (the three buckets as a rate)

Options:
  --repo <dir>        Repository to review (default: current directory)
  --pr <n>            Review GitHub PR #n: head and base come from gh, the
                      review runs in a detached worktree with its own
                      codegraph index, and the result is compared against
                      Greptile's comment on the PR. Excludes --base, --head
                      and --two-dot
  --post              With --pr only: publish the review to the PR as one
                      marked comment — created the first time, updated in
                      place on re-runs, never stacked. Explicit, never a
                      default
  --base <ref>        Base branch or sha. Default, in order: the config's
                      default_base, then the remote head
                      (refs/remotes/origin/HEAD), then ${DEFAULT_BASE_REF}
  --head <ref>        Head branch or sha (default: ${DEFAULT_HEAD_REF})
  --agents <dir>      Prompt-set directory. Default, in order: the config's
                      agents_dir (relative paths resolve against the config
                      file), then PRHERO_AGENTS_DIR
  --out <dir>         Run directory; must live OUTSIDE the reviewed repo
                      (default: <repo-parent>/<repo>-prhero-runs/<sha>-<n>).
                      For ledger: the file to write instead of stdout
  --runs <dir>        ledger only: the runs root to scan for comparison.json
                      files (default: <repo-parent>/<repo>-prhero-runs)
  --gotchas <file>    Repo gotchas file (default: <repo>/.prhero/gotchas.md);
                      supply it from outside to review a tree you cannot dirty
  --config <file>     Local config (default: <repo>/.prhero/config.json) with
                      agents_dir, default_base, parity_trigger_paths and
                      suspicion_priors
  --model <model>     Override every agent's model
  --hop-budget <n>    Hops per hunter (default: ${DEFAULT_HOP_BUDGET}); the biggest
                      per-hunter cost lever there is
  --two-dot           Diff the literal <base>..<head> two-point range instead
                      of from the merge base. Rarely what you want: when base
                      has moved on, its newer commits show up REVERSED in the
                      review
  --dry-run           Resolve, preflight, print the plan and the cost band,
                      then exit without spawning anything
  --yes               Skip the confirmation prompt
  --help              Show this text

By default the diff runs from the MERGE BASE of base and head (the three-dot
range), so only what this branch adds is reviewed. The plan prints both the
base ref you asked for and the merge-base sha it actually used.

Every run costs real money. --dry-run costs nothing and answers most
questions; use it first.`;

const VALUE_FLAGS = new Set([
  "--repo",
  "--pr",
  "--base",
  "--head",
  "--agents",
  "--out",
  "--runs",
  "--gotchas",
  "--config",
  "--model",
  "--hop-budget",
]);

export function parseArgs(argv: string[]): ParsedCli {
  const options: CliOptions = {
    repo: ".",
    head: DEFAULT_HEAD_REF,
    hopBudget: DEFAULT_HOP_BUDGET,
    dryRun: false,
    yes: false,
    post: false,
    twoDot: false,
  };
  let command: "review" | "init" | "ledger" | "help" | undefined;
  // --head carries a baked-in default, so "was it explicitly given" cannot
  // be read off options afterwards — and the --pr exclusion below must fire
  // on an explicit --head even when its value equals that default.
  let headExplicit = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") return { command: "help", options };
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      // A flag swallowing the NEXT flag as its value is the classic way to
      // end up reviewing the wrong tree: `--base --head foo` would otherwise
      // resolve base to "--head".
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(`${arg} needs a value`);
      }
      i++;
      if (arg === "--head") headExplicit = true;
      applyValueFlag(options, arg, value);
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      options.yes = true;
      continue;
    }
    if (arg === "--post") {
      options.post = true;
      continue;
    }
    if (arg === "--two-dot") {
      options.twoDot = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CliUsageError(`unknown option: ${arg}`);
    }
    if (command !== undefined) {
      throw new CliUsageError(`unexpected argument: ${arg}`);
    }
    if (arg !== "review" && arg !== "init" && arg !== "ledger") {
      throw new CliUsageError(
        `unknown command: ${arg} (the commands are "review", "init" and ` +
          '"ledger")',
      );
    }
    command = arg;
  }
  if (command === undefined) {
    throw new CliUsageError(
      'no command given (did you mean "pr-hero review"?)',
    );
  }
  // --pr derives the whole range from the PR record — head from GitHub, base
  // from the merge commit's parent or the base branch — so a hand-picked
  // endpoint or range shape beside it would silently contradict what the PR
  // actually contains. Checked after the loop so flag order cannot matter.
  if (options.pr !== undefined) {
    if (options.base !== undefined) {
      throw new CliUsageError(
        "--pr resolves base from the PR itself, so it cannot be combined " +
          "with --base",
      );
    }
    if (headExplicit) {
      throw new CliUsageError(
        "--pr reviews the PR's own head commit, so it cannot be combined " +
          "with --head",
      );
    }
    if (options.twoDot) {
      throw new CliUsageError(
        "--pr always diffs the PR from its merge base, so it cannot be " +
          "combined with --two-dot",
      );
    }
  }
  // Also after the loop, for the same flag-order reason: posting publishes a
  // PR comment, and only --pr names a PR to publish to.
  if (options.post && options.pr === undefined) {
    throw new CliUsageError(
      "--post publishes the review as a PR comment, so it requires --pr",
    );
  }
  return { command, options };
}

function applyValueFlag(
  options: CliOptions,
  flag: string,
  value: string,
): void {
  switch (flag) {
    case "--repo":
      options.repo = value;
      return;
    case "--base":
      options.base = value;
      return;
    case "--head":
      options.head = value;
      return;
    case "--agents":
      options.agents = value;
      return;
    case "--out":
      options.out = value;
      return;
    case "--gotchas":
      options.gotchas = value;
      return;
    case "--config":
      options.config = value;
      return;
    case "--model":
      options.model = value;
      return;
    case "--runs":
      options.runs = value;
      return;
    case "--pr": {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new CliUsageError(
          `--pr must be a positive integer, got: ${value}`,
        );
      }
      options.pr = parsed;
      return;
    }
    default: {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new CliUsageError(
          `--hop-budget must be a positive integer, got: ${value}`,
        );
      }
      options.hopBudget = parsed;
    }
  }
}

export type BaseRefSource = "flag" | "config" | "remote" | "fallback";

export interface BaseRefResolution {
  ref: string;
  source: BaseRefSource;
}

// `git symbolic-ref refs/remotes/origin/HEAD` answers with the full ref name
// (`refs/remotes/origin/dev`); everything downstream wants the branch. Split
// out as its own function because the shell can only hand it a string, and a
// prefix strip that is wrong by one character reviews a ref nobody named.
// Returns undefined for anything that is not that shape — including the empty
// output of a repo whose origin/HEAD was never set, which is not an error.
export function parseRemoteHead(raw: string): string | undefined {
  const trimmed = raw.trim();
  const prefix = "refs/remotes/origin/";
  if (!trimmed.startsWith(prefix)) return undefined;
  const branch = trimmed.slice(prefix.length);
  return branch.length > 0 ? branch : undefined;
}

// WHY this order, and WHY it is a function rather than a default: the base ref
// decides WHICH range gets reviewed, and a hardcoded "main" is silently wrong
// on any repo that does not use it (musive is on `dev`). So the explicit flag
// wins, then the repo's own recorded choice, then what the remote actually
// says its default branch is, and only then the historical literal. The git
// call that produces `remoteHead` lives in the shell; this stays pure so every
// branch of the precedence is tested without a repo.
export function resolveBaseRef(input: {
  flag?: string | undefined;
  configDefaultBase?: string | undefined;
  remoteHead?: string | undefined;
}): BaseRefResolution {
  if (input.flag) return { ref: input.flag, source: "flag" };
  if (input.configDefaultBase) {
    return { ref: input.configDefaultBase, source: "config" };
  }
  if (input.remoteHead) return { ref: input.remoteHead, source: "remote" };
  return { ref: DEFAULT_BASE_REF, source: "fallback" };
}

export type AgentsDirSource = "flag" | "config" | "env";

export interface AgentsDirResolution {
  dir: string;
  source: AgentsDirSource;
}

// WHY `agents_dir` belongs in the config at all: requiring a flag that points
// into a SIBLING repository is the single thing that stopped this from being a
// one-word command inside the repo being reviewed. Recorded once in
// .prhero/config.json, `pr-hero review` needs no arguments.
//
// The relative case resolves against the CONFIG FILE's directory, not cwd: the
// config is the thing that names the path, so the path travels with it. A
// cwd-relative reading would make the same config mean different prompt sets
// depending on which subdirectory the developer happened to be standing in.
export function resolveAgentsDirSetting(input: {
  flag?: string | undefined;
  configAgentsDir?: string | undefined;
  configDir?: string | undefined;
  env?: string | undefined;
  cwd: string;
}): AgentsDirResolution {
  if (input.flag) {
    return { dir: path.resolve(input.cwd, input.flag), source: "flag" };
  }
  if (input.configAgentsDir) {
    return {
      dir: path.resolve(input.configDir ?? input.cwd, input.configAgentsDir),
      source: "config",
    };
  }
  if (input.env) {
    return { dir: path.resolve(input.cwd, input.env), source: "env" };
  }
  throw new CliUsageError(
    "no prompt set given. Pass --agents <dir>, set agents_dir in " +
      ".prhero/config.json (run `pr-hero init`), or set PRHERO_AGENTS_DIR. " +
      `The current clean set is ${SUGGESTED_AGENTS_DIR}`,
  );
}

// The already-merged branch, spelled out. This is not a rare edge: reviewing a
// branch that has already landed is exactly what someone does when they want
// to see what the reviewer would have said, and "empty diff" alone reads as a
// bug in the tool rather than as the true answer.
export function headContainedInBaseMessage(
  baseRef: string,
  headRef: string,
): string {
  return (
    `the merge base of ${baseRef} and ${headRef} IS ${headRef}: head is ` +
    "already contained in base; there is nothing this branch adds. If the " +
    "branch has already been merged, review it against its own parent (" +
    "--base <the-commit-before-it>) or pass --two-dot to diff the literal " +
    "two-point range."
  );
}

export function emptyDiffMessage(
  baseRef: string,
  headRef: string,
  twoDot: boolean,
): string {
  return (
    `the diff ${baseRef}${twoDot ? ".." : "..."}${headRef} is empty; there ` +
    "is nothing to review. The usual cause is that head is already contained " +
    "in base (an already-merged branch), or that the branch's changes were " +
    "reverted."
  );
}

// A full 40-hex commit id and nothing else. WHY it is enforced this hard: an
// abbreviated head sha once made a COMPLETED three-replicate arm — $29.15
// already spent — unscoreable, because nothing downstream could match the
// recorded run to the tree it reviewed. Refs are canonicalized before they
// are written anywhere.
export function isFullCommitId(candidate: string): boolean {
  return /^[0-9a-f]{40}$/.test(candidate.trim());
}

export interface NumstatDiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

// `git diff --numstat` emits `<added>\t<deleted>\t<path>` per file, and for a
// binary file both counters are a literal `-`. A binary file is still a
// changed file (it counts toward `files`) but contributes no lines — reading
// `-` as NaN would poison the whole cost estimate.
export function parseNumstat(raw: string): NumstatDiffStat {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    files++;
    insertions += countField(fields[0]);
    deletions += countField(fields[1]);
  }
  return { files, insertions, deletions };
}

function countField(field: string | undefined): number {
  const parsed = Number(field);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Run artifacts NEVER live inside the reviewed tree. The system prompts, the
// diff, and every draft would otherwise show up in the hunters' own Grep and
// Glob results — a review that reads its own prompts is contaminated, and the
// contamination is invisible in the output.
export function defaultRunRoot(repoRoot: string): string {
  const parent = path.dirname(repoRoot);
  return path.join(parent, `${path.basename(repoRoot)}-prhero-runs`);
}

export function runDirCandidate(
  root: string,
  headSha: string,
  n: number,
): string {
  return path.join(root, `${headSha.slice(0, 8)}-${n}`);
}

export function assertOutsideRepo(runDir: string, repoRoot: string): void {
  const resolvedRun = path.resolve(runDir);
  const resolvedRepo = path.resolve(repoRoot);
  if (
    resolvedRun === resolvedRepo ||
    resolvedRun.startsWith(`${resolvedRepo}${path.sep}`)
  ) {
    throw new CliUsageError(
      `run dir ${resolvedRun} is inside the reviewed repo ${resolvedRepo}. ` +
        "Prompts and artifacts written inside the tree show up in the " +
        "hunters' own Grep results and contaminate the review — pick a " +
        "--out outside the repo.",
    );
  }
}

// Threat matrix, ported from the lab: a ReviewSpec's `file` values name the
// .md files that become the SYSTEM PROMPTS of spawned sessions. A basename
// that escapes agentsDir (separator, `..`, or an absolute path) must fail
// loud before any spawn, never be silently joined against a location the
// caller did not choose.
export function assertBasenameOnly(file: string, index: number): void {
  if (
    file.includes("/") ||
    file.includes("\\") ||
    file.includes("..") ||
    path.isAbsolute(file)
  ) {
    throw new CliUsageError(
      `spec.agents[${index}].file must be a plain basename (no "/", "\\", ` +
        `"..", or absolute paths), got: ${JSON.stringify(file)}`,
    );
  }
}

export const AGENT_FILE_PATTERNS = ["deep-review-*.md", "review-*.md"];

// BIDIRECTIONAL on purpose, and this is the check that pays for itself. The
// default spec declares four agents and omits the lifecycle hunter, so
// running the 5-file clean set with that spec silently drops the one hunter
// the whole campaign is about — the run completes, the artifacts validate,
// the cost looks normal, and nothing downstream notices. So: every file the
// spec names must exist, AND every agent file present must be named.
export function agentsDirProblems(
  specFiles: string[],
  presentFiles: string[],
): string[] {
  const problems: string[] = [];
  const present = new Set(presentFiles);
  const named = new Set(specFiles);
  for (const file of named) {
    if (!present.has(file)) {
      problems.push(
        `the spec references "${file}" but the dir does not have it`,
      );
    }
  }
  for (const file of presentFiles) {
    if (!named.has(file)) {
      problems.push(
        `the dir has "${file}" but no agent in the spec references it ` +
          "(it would never run)",
      );
    }
  }
  return problems.sort();
}

// Local mode's wiring: the three unconditional hunters, the conditional
// parity hunter, and the refuter. Deliberately NOT defaultReviewSpec() — that
// one omits the lifecycle hunter, and local mode targets the 5-file clean
// set. Hunter keys stay inside the findings-schema v1.0.0 Hunter enum, which
// validateReviewSpec enforces.
export function localReviewSpec(): ReviewSpec {
  return {
    agents: [
      {
        key: "reliability",
        file: "deep-review-reliability.md",
        role: "hunter",
      },
      { key: "resilience", file: "deep-review-resilience.md", role: "hunter" },
      { key: "lifecycle", file: "deep-review-lifecycle.md", role: "hunter" },
      {
        key: "parity",
        file: "deep-review-parity.md",
        role: "hunter",
        trigger: "input",
      },
      { key: "refuter", file: "review-refuter.md", role: "refuter" },
    ],
  };
}

export interface LocalConfig {
  parity_trigger_paths: string[];
  suspicion_priors: SuspicionPrior[];
  // Both optional, and both exist to make `pr-hero review` a zero-flag
  // command: the prompt set lives in a sibling repo, and the default branch is
  // a property of THIS repo that no constant can know.
  agents_dir?: string;
  default_base?: string;
}

export const EMPTY_LOCAL_CONFIG: LocalConfig = {
  parity_trigger_paths: [],
  suspicion_priors: [],
};

// `.prhero/config.json` is optional and both keys are optional inside it — an
// absent config is a legal, complete configuration (parity simply never
// fires). What is NOT tolerated is a malformed one: a typo'd key silently
// read as "no triggers" is exactly how the parity hunter stops firing without
// anyone noticing, so shape violations throw.
export function parseLocalConfig(raw: string): LocalConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(
      `.prhero/config.json is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError(".prhero/config.json must be a JSON object");
  }
  const config = parsed as Record<string, unknown>;
  const triggers = config.parity_trigger_paths ?? [];
  if (
    !Array.isArray(triggers) ||
    !triggers.every((p) => typeof p === "string" && p.length > 0)
  ) {
    throw new CliUsageError(
      ".prhero/config.json parity_trigger_paths must be an array of " +
        "non-empty strings",
    );
  }
  const priors = config.suspicion_priors ?? [];
  if (!Array.isArray(priors)) {
    throw new CliUsageError(
      ".prhero/config.json suspicion_priors must be an array",
    );
  }
  for (const [i, entry] of priors.entries()) {
    if (typeof entry !== "object" || entry === null) {
      throw new CliUsageError(`suspicion_priors[${i}] must be an object`);
    }
    const prior = entry as Record<string, unknown>;
    if (typeof prior.path !== "string" || prior.path.length === 0) {
      throw new CliUsageError(`suspicion_priors[${i}].path required`);
    }
    if (typeof prior.weight !== "string" && typeof prior.weight !== "number") {
      throw new CliUsageError(
        `suspicion_priors[${i}].weight must be a string or a number`,
      );
    }
    if (typeof prior.reason !== "string" || prior.reason.length === 0) {
      throw new CliUsageError(`suspicion_priors[${i}].reason required`);
    }
  }
  return {
    parity_trigger_paths: triggers as string[],
    suspicion_priors: priors as SuspicionPrior[],
    ...optionalString(config, "agents_dir"),
    ...optionalString(config, "default_base"),
  };
}

// Same fail-loud discipline as the two array keys: an `agents_dir` that is a
// number, or an empty `default_base`, must not be read as "absent" — that is
// how a config silently stops configuring anything.
function optionalString(
  config: Record<string, unknown>,
  key: "agents_dir" | "default_base",
): Record<string, string> {
  const value = config[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliUsageError(
      `.prhero/config.json ${key} must be a non-empty string`,
    );
  }
  return { [key]: value };
}

// The scaffold `pr-hero init` writes. Kept pure and next to parseLocalConfig
// on purpose: a template its own parser would reject is a bug that only shows
// up on someone else's machine, and a round-trip test through parseLocalConfig
// costs nothing.
export function initConfigTemplate(input: {
  agentsDir: string;
  defaultBase: string;
}): string {
  return `${JSON.stringify(
    {
      agents_dir: input.agentsDir,
      default_base: input.defaultBase,
      parity_trigger_paths: [],
      suspicion_priors: [],
    },
    null,
    2,
  )}\n`;
}

// WHY init says this out loud: an untracked file under .prhero/ dirties the
// working tree, and the clean-tree gate in cli.ts then refuses to run at all.
// A first-time user who scaffolds and immediately hits "the working tree is
// dirty" has no way to connect the two.
export const INIT_GIT_REMINDER =
  "Now either commit .prhero/ or add it to .gitignore. Every review step " +
  "reads the checkout directly, so pr-hero refuses to run on a dirty tree — " +
  "and an untracked .prhero/ is exactly that.";

export const GOTCHAS_TEMPLATE = `# Repo gotchas

Facts a reviewer cannot infer from the diff alone. Each line is injected
verbatim into every hunter's system prompt, so keep them short and true.

- <subsystem>: <the thing that looks like a bug but is deliberate, and why>
- <subsystem>: <the invariant that is enforced somewhere the diff does not show>
- <subsystem>: <the naming/ownership rule a newcomer would violate>
`;

// The pipeline treats missing-or-empty gotchas as a fail-loud abort and
// returns a zero-cost partial run. Correct, but a bare "partial, 0 findings"
// tells the user nothing — so the CLI checks first and explains.
export function gotchasErrorMessage(gotchasPath: string): string {
  return [
    `missing or empty gotchas file: ${gotchasPath}`,
    "",
    "Gotchas are the repo-specific facts a hunter cannot infer from the diff",
    "— deliberate oddities, invariants enforced elsewhere, conventions worth",
    "more than they look. They are injected into every hunter's system",
    "prompt, and the engine refuses to run without them: an empty file makes",
    "the whole review a zero-cost no-op that LOOKS like a clean result.",
    "",
    "Create it with something like:",
    "",
    GOTCHAS_TEMPLATE,
  ].join("\n");
}
