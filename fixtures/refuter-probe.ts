// Refuter-discrimination probe fixture (ROADMAP A2 diagnostic, not an arm).
//
// WHY THIS EXISTS. The A2 refuter's first live measurement returned
// `corroborated` on 15 of 15 findings — a 0% false-positive reduction. Two
// explanations fit that data equally well: (a) those hunters were genuinely
// precise, or (b) the v2 refuter prompt is deferential and never refutes
// anything. A replay cannot separate them, because a replay contains no
// finding whose truth value is known in advance — every verdict is graded
// against the same fallible judgement it is supposed to check.
//
// This fixture supplies what the replay cannot: a claim that is KNOWN false,
// against code that positively contradicts it. Two arms over the SAME repo,
// the same agent file, the same model, the same finding shape — only the claim
// text changes:
//   - `true-claim`  (control) — an accurate claim → a working gate corroborates
//   - `false-claim` (the test) — a contradicted claim → a working gate refutes
// The control carries as much weight as the test: without it, an all-`refuted`
// result would read as success when it is really a broken probe.
//
// The planted function is DELIBERATELY guarded. `withRetry` validates its
// `attempts` argument on the third line, so the false claim ("it never
// validates `attempts`") is disproved by a line the refuter can cite — exactly
// the positive disproof Mandate 2 of the A2 prompt demands. And the function
// has a live caller reachable from the entry point, which closes the
// `downgraded-latent` door: that verdict means "real defect nothing can
// execute at this commit", and an unwired function would hand the refuter a
// legitimate third answer that would confound the result.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DraftFinding, RefuterOutcome } from "../src/drafts";

export type ProbeArm = "true-claim" | "false-claim";

// The whole point of the probe, as data: what a refuter that discriminates
// MUST return for each arm. Single source of truth — the builder stamps it
// onto the fixture and the script reports against it.
export const EXPECTED_VERDICT: Record<ProbeArm, RefuterOutcome> = {
  "true-claim": "corroborated",
  "false-claim": "refuted",
};

// Agent filenames written into the fixture's agents dir. Exported so the
// probe's ReviewSpec cannot desync from the files that back it.
export const HUNTER_AGENT_FILE = "deep-review-resilience.md";
export const REFUTER_AGENT_FILE = "review-refuter.md";
// Findings-schema v1.0.0 pins hunter keys to reliability|resilience|parity|
// lifecycle, and the draft's `hunter` field must sit in the same enum.
// Non-parity on purpose: the parity leg must not fire.
export const HUNTER_KEY = "resilience";

export interface RefuterProbeFixture {
  arm: ProbeArm;
  repoDir: string;
  baseSha: string;
  headSha: string;
  diffPath: string;
  agentsDir: string;
  gotchasPath: string;
  runDir: string;
  // The single finding injected in place of a hunter draft — the arm's whole
  // experimental variable.
  draft: DraftFinding;
  expectedVerdict: RefuterOutcome;
  // The guard line the false claim collides with, resolved from the source so
  // an edit that deletes the guard fails loudly here instead of quietly
  // turning the false claim TRUE and inverting the probe. Deliberately absent
  // from the false arm's proof_refs: finding it is the refuter's job.
  contradictingLine: number;
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "pr-hero-fixture",
  GIT_AUTHOR_EMAIL: "fixture@pr-hero.invalid",
  GIT_COMMITTER_NAME: "pr-hero-fixture",
  GIT_COMMITTER_EMAIL: "fixture@pr-hero.invalid",
};

async function git(repoDir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repoDir, ...args], {
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`);
  }
  return stdout;
}

// --- The mini project -------------------------------------------------------

const README = `# fixture-config

Loads remote configuration at startup. The config module owns the fetch policy;
the client module owns the transport.
`;

// Unchanged by the diff: the transport that can fail, which is what makes a
// retry policy meaningful at all.
const CLIENT = `export interface ConfigPayload {
  featureFlags: Record<string, boolean>;
}

export async function fetchConfigPayload(url: string): Promise<ConfigPayload> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("config request failed: " + response.status);
  }
  return (await response.json()) as ConfigPayload;
}
`;

// Commit 1 (base): one shot, no retry policy anywhere in the repo.
const CONFIG_BASE = `import { type ConfigPayload, fetchConfigPayload } from "./client";

const CONFIG_URL = "https://config.internal/app.json";

export async function loadConfig(): Promise<ConfigPayload> {
  return fetchConfigPayload(CONFIG_URL);
}
`;

// Commit 2 (head): the caller is rewired onto the new helper. THIS is what
// closes the `downgraded-latent` door — `withRetry` is not an orphan, it sits
// on a path the entry point actually walks.
const CONFIG_HEAD = `import { type ConfigPayload, fetchConfigPayload } from "./client";
import { withRetry } from "./retry";

const CONFIG_URL = "https://config.internal/app.json";
const CONFIG_ATTEMPTS = 3;

export async function loadConfig(): Promise<ConfigPayload> {
  return withRetry(() => fetchConfigPayload(CONFIG_URL), CONFIG_ATTEMPTS);
}
`;

// The entry point, unchanged by the diff: index -> loadConfig -> withRetry.
const INDEX = `import { loadConfig } from "./config";

export async function start(): Promise<string[]> {
  const config = await loadConfig();
  return Object.keys(config.featureFlags);
}
`;

// The file under test, added by the head commit. Carries NO explanatory
// comment: both claims must be judged against the code, never against prose
// that confesses or denies the defect. The `attempts < 1` guard is the
// contradicting evidence the false arm must run into.
const RETRY = `export async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  if (attempts < 1) {
    throw new Error("attempts must be at least 1");
  }
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`;

// Neutral: nothing here answers either claim, and nothing hints that one of
// them is planted false.
const GOTCHAS = `- Remote configuration is fetched once at startup and cached for the process.
- The config gateway returns 503 for a few seconds while it restarts.
- Retry policy lives in one helper; call sites pass an attempt count and never
  write their own loop.
`;

// --- The fixture prompt set -------------------------------------------------

// Never spawned: the probe's dispatching runner answers the hunter step with a
// canned draft. The file exists because the pipeline parses every configured
// agent (and writes its templated body as an audit artifact) BEFORE any step
// runs, so a missing file would fail the run before the refuter is reached.
// Its `model` is likewise resolved but never used.
const HUNTER_AGENT = `---
name: deep-review-resilience
description: Probe placeholder — the hunter leg is faked, this is never spawned.
model: haiku
tools: Read, Grep, Glob
---

# Placeholder Hunter

This body is never sent to a model. It is parsed for its frontmatter and
rendered into the run dir so the templating path stays exercised.

Codebase gotchas (authoritative):
{{GOTCHAS}}

Suspicion priors:
{{PRIORS}}
`;

// --- The planted claims -----------------------------------------------------

// Accurate: the loop re-invokes `fn` with nothing between iterations. A
// discriminating refuter reads the loop, hunts for a delay/backoff it does not
// find, and corroborates.
const TRUE_CLAIM = [
  "`withRetry` retries immediately with no delay between attempts, so a",
  "failing dependency is retried `attempts` times in a tight loop with no",
  "backoff.",
].join(" ");

// False, and mechanically so: `attempts` IS validated, three lines above the
// loop, and `0` throws instead of skipping. A refuter that corroborates this
// has not read past the signature.
const FALSE_CLAIM = [
  "`withRetry` never validates `attempts`, so calling it with `0` skips the",
  "loop entirely and returns `undefined` — silently reporting success for work",
  "that never ran.",
].join(" ");

const SIGNATURE_MARKER = "export async function withRetry";
const GUARD_MARKER = "if (attempts < 1) {";
const LOOP_MARKER = "for (let i = 0; i < attempts; i++) {";
const CALL_MARKER = "return withRetry(";

// Line refs are DERIVED, never typed by hand: an edit to a source constant
// above must either move the refs with it or fail here, because a claim citing
// the wrong lines would be refutable for a reason that has nothing to do with
// the hypothesis under test.
function lineOf(source: string, marker: string, label: string): number {
  const index = source.split("\n").findIndex((l) => l.includes(marker));
  if (index < 0) {
    throw new Error(
      `refuter probe fixture: ${label} not located (marker "${marker}")`,
    );
  }
  return index + 1; // 1-indexed, the form proof_refs use
}

function plantedDraft(arm: ProbeArm): {
  draft: DraftFinding;
  contradictingLine: number;
} {
  const signatureLine = lineOf(RETRY, SIGNATURE_MARKER, "withRetry signature");
  const guardLine = lineOf(RETRY, GUARD_MARKER, "attempts guard");
  const loopLine = lineOf(RETRY, LOOP_MARKER, "retry loop");
  const callLine = lineOf(CONFIG_HEAD, CALL_MARKER, "withRetry call site");

  // Everything except `line`, `claim` and `proof_refs` is identical across the
  // arms. Severity especially: BLOCKER/CRITICAL is what admits a finding to
  // the refuter batch at all, so an arm-dependent severity would silently make
  // one arm a no-op. `evidence_class` never reaches the refuter (its prompt
  // carries id, location, severity, claim, proof_refs and nothing else), so it
  // cannot be the variable either — it is fixed only to keep the tier
  // arithmetic comparable between arms.
  const common = {
    id: "RES-1",
    category: 6, // hunting-map: retry / idempotency
    path: "src/retry.ts",
    symbol: "withRetry",
    severity: "CRITICAL" as const,
    evidence_class: "inferential" as const,
    causal_disposition: "introduced" as const,
    hunter: HUNTER_KEY as DraftFinding["hunter"],
    hops_used: 1,
    hop_trail: [],
    dedupe_key: "src/retry.ts:withRetry:6",
  };

  const draft: DraftFinding =
    arm === "true-claim"
      ? {
          ...common,
          line: loopLine,
          claim: TRUE_CLAIM,
          proof_refs: [`src/retry.ts:${loopLine}`, `src/config.ts:${callLine}`],
        }
      : {
          ...common,
          line: signatureLine,
          claim: FALSE_CLAIM,
          // The guard line is NOT cited. Mandate 1 of the A2 prompt requires
          // the refuter to expand beyond the hunter's refs and hunt the
          // counterexample itself; handing it the disproof would test reading
          // comprehension instead of the behaviour under investigation.
          proof_refs: [
            `src/retry.ts:${signatureLine}`,
            `src/retry.ts:${loopLine}`,
            `src/config.ts:${callLine}`,
          ],
        };

  return { draft, contradictingLine: guardLine };
}

export async function buildRefuterProbeFixture(
  arm: ProbeArm,
  refuterAgentSource: string,
): Promise<RefuterProbeFixture> {
  const base = await mkdtemp(path.join(tmpdir(), `pr-hero-refuter-${arm}-`));
  // agents/ and run/ are SIBLINGS of the repo, never inside it: the refuter's
  // cwd is repoDir, and an agent prompt or an answer key under that root would
  // surface in its own Grep results.
  const repoDir = path.join(base, "repo");
  const agentsDir = path.join(base, "agents");
  const runDir = path.join(base, "run");
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  await mkdir(agentsDir);
  await mkdir(runDir);

  await writeFile(path.join(repoDir, "README.md"), README);
  await writeFile(path.join(repoDir, "src", "client.ts"), CLIENT);
  await writeFile(path.join(repoDir, "src", "config.ts"), CONFIG_BASE);
  await writeFile(path.join(repoDir, "src", "index.ts"), INDEX);
  await git(repoDir, ["init", "-q", "-b", "main"]);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "feat: load remote config"]);
  const baseSha = (await git(repoDir, ["rev-parse", "HEAD"])).trim();

  await writeFile(path.join(repoDir, "src", "retry.ts"), RETRY);
  await writeFile(path.join(repoDir, "src", "config.ts"), CONFIG_HEAD);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, [
    "commit",
    "-q",
    "-m",
    "feat: retry the config fetch on transient failure",
  ]);
  const headSha = (await git(repoDir, ["rev-parse", "HEAD"])).trim();

  const diffPath = path.join(base, "diff.patch");
  await writeFile(diffPath, await git(repoDir, ["diff", baseSha, headSha]));

  await writeFile(path.join(agentsDir, HUNTER_AGENT_FILE), HUNTER_AGENT);
  await writeFile(path.join(agentsDir, REFUTER_AGENT_FILE), refuterAgentSource);

  const gotchasPath = path.join(base, "gotchas.md");
  await writeFile(gotchasPath, GOTCHAS);

  const { draft, contradictingLine } = plantedDraft(arm);

  return {
    arm,
    repoDir,
    baseSha,
    headSha,
    diffPath,
    agentsDir,
    gotchasPath,
    runDir,
    draft,
    expectedVerdict: EXPECTED_VERDICT[arm],
    contradictingLine,
  };
}
