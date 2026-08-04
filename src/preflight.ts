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

export const DEFAULT_BASE_REF = "main";
export const DEFAULT_HEAD_REF = "HEAD";

// The clean 5-file set at the time of writing. Named in the error text so a
// first-time user is one copy-paste from a working run instead of guessing.
export const SUGGESTED_AGENTS_DIR =
  "/Users/juanma/Desktop/deep-review/agents/slice3b-lifecycle-v6-clean";

export class CliUsageError extends Error {}

export interface CliOptions {
  // Relative on purpose: parseArgs is pure, so "resolve against cwd" is the
  // caller's job, not a hidden dependency on process.cwd() in a pure function.
  repo: string;
  base: string;
  head: string;
  agents?: string;
  out?: string;
  model?: string;
  hopBudget: number;
  dryRun: boolean;
  yes: boolean;
}

export interface ParsedCli {
  command: "review" | "help";
  options: CliOptions;
}

export const HELP_TEXT = `pr-hero review — multi-agent review of a real repo + branch

Usage:
  pr-hero review [options]

Options:
  --repo <dir>        Repository to review (default: current directory)
  --base <ref>        Base branch or sha (default: ${DEFAULT_BASE_REF})
  --head <ref>        Head branch or sha (default: ${DEFAULT_HEAD_REF})
  --agents <dir>      Prompt-set directory (required; falls back to
                      PRHERO_AGENTS_DIR)
  --out <dir>         Run directory; must live OUTSIDE the reviewed repo
                      (default: <repo-parent>/<repo>-prhero-runs/<sha>-<n>)
  --model <model>     Override every agent's model
  --hop-budget <n>    Hops per hunter (default: ${DEFAULT_HOP_BUDGET}); the biggest
                      per-hunter cost lever there is
  --dry-run           Resolve, preflight, print the plan and the cost band,
                      then exit without spawning anything
  --yes               Skip the confirmation prompt
  --help              Show this text

Every run costs real money. --dry-run costs nothing and answers most
questions; use it first.`;

const VALUE_FLAGS = new Set([
  "--repo",
  "--base",
  "--head",
  "--agents",
  "--out",
  "--model",
  "--hop-budget",
]);

export function parseArgs(argv: string[]): ParsedCli {
  const options: CliOptions = {
    repo: ".",
    base: DEFAULT_BASE_REF,
    head: DEFAULT_HEAD_REF,
    hopBudget: DEFAULT_HOP_BUDGET,
    dryRun: false,
    yes: false,
  };
  let command: "review" | "help" | undefined;
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
    if (arg.startsWith("-")) {
      throw new CliUsageError(`unknown option: ${arg}`);
    }
    if (command !== undefined) {
      throw new CliUsageError(`unexpected argument: ${arg}`);
    }
    if (arg !== "review") {
      throw new CliUsageError(
        `unknown command: ${arg} (the only command is "review")`,
      );
    }
    command = "review";
  }
  if (command === undefined) {
    throw new CliUsageError(
      'no command given (did you mean "pr-hero review"?)',
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
    case "--model":
      options.model = value;
      return;
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
  };
}

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
