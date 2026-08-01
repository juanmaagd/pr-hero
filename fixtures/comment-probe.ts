// Comment-deference probe fixture (ROADMAP A1 diagnostic, not an arm).
//
// WHY THIS EXISTS. Across three benchmark runs spanning two lifecycle prompt
// arms, the pass never flagged golden G2 — an effect whose re-arm is keyed on
// a track identity that does not change on a same-track retry — while the one
// resource it DID flag, in the same file family, carried no explanatory
// comment. G2's effect carries a confident comment asserting its own re-arm
// correctness (true only for the different-track case). That is a correlation
// over a single resource, which is not enough to fund a new instrument.
//
// This fixture isolates the comment as the ONLY variable: two repos, the same
// planted latch bug, identical byte-for-byte except that one carries the
// comment and the other does not. Same agent file, same model, same diff
// shape. If the commented variant is systematically missed and the bare one
// is caught, comment deference is real and the lever is "treat a comment
// asserting a lifecycle property as a claim to verify". If both are caught or
// both missed, the hypothesis dies and the miss is about something else.
//
// The bug planted here is deliberately the SAME SHAPE as G2, not a copy of
// musive code: a loading latch armed by a timeout, disarmed only when its
// effect re-runs, keyed on the resource identity — so a retry of the SAME
// resource inherits the previous attempt's armed state.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type ProbeVariant = "commented" | "bare";

export interface ProbeFixture {
  variant: ProbeVariant;
  repoDir: string;
  baseSha: string;
  headSha: string;
  diffPath: string;
  agentsDir: string;
  gotchasPath: string;
  runDir: string;
  // Overlap answer key, same semantics as the planted-bug fixture: a hit is a
  // finding on this path whose line falls inside the range. Never exact-claim
  // matching — the same defect gets phrased a dozen ways.
  expected: { path: string; lineMin: number; lineMax: number };
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

const CONSTANTS = `export const LOAD_TIMEOUT_MS = 8000;
`;

const LOADER = `interface LoaderInput {
  isLoading: boolean;
  isReady: boolean;
  timedOut: boolean;
}

// The spinner is suppressed once a load has exhausted its timeout window, so
// the placeholder artwork stays on screen instead of a spinner that will not
// resolve.
export function shouldShowLoader(input: LoaderInput): boolean {
  if (!input.isLoading) return false;
  if (input.isReady) return false;
  return !input.timedOut;
}
`;

// Commit 1 (base): no timeout latch at all — the loader shows for as long as
// the track is loading. The head commit introduces the latch, so the whole
// resource is diff-touched.
const WAVEFORM_BASE = `import { useState } from "react";
import { shouldShowLoader } from "./loader";

interface Props {
  trackId: string;
  peaks: number[] | undefined;
  isLoading: boolean;
}

export function TrackWaveform({ trackId, peaks, isLoading }: Props) {
  const isReady = peaks !== undefined && peaks.length > 0;
  const [timedOut] = useState(false);

  const showLoader = shouldShowLoader({ isLoading, isReady, timedOut });

  return { trackId, showLoader, peaks };
}
`;

// The planted defect, shared by both variants BYTE FOR BYTE. \`setTimedOut(false)\`
// only runs when the effect re-runs, and the effect re-runs only when one of
// its deps changes. On a retry of the SAME track, trackId is unchanged and the
// readiness inputs are unchanged, so the latch carries the previous attempt's
// armed state into the new attempt and the loader stays suppressed.
const EFFECT_BODY = `  useEffect(() => {
    setTimedOut(false);
    if (!isLoading || isReady) return;
    const timer = setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isLoading, isReady, trackId]);`;

// THE ONLY VARIABLE. Modelled on the real comment in the golden's code: it
// asserts the re-arm works, and it is true — but only for the different-track
// case it names. It says nothing about a retry of the same track.
const EFFECT_COMMENT = `  // \`trackId\` is never read in this effect body — it is a deliberate CHANGE
  // SIGNAL, so a new loading target re-arms the timeout instead of inheriting
  // whatever \`timedOut\` the previous target already reached.`;

function waveformHead(variant: ProbeVariant): string {
  const effect =
    variant === "commented"
      ? `${EFFECT_COMMENT}\n${EFFECT_BODY}`
      : EFFECT_BODY;
  return `import { useEffect, useState } from "react";
import { LOAD_TIMEOUT_MS } from "./constants";
import { shouldShowLoader } from "./loader";

interface Props {
  trackId: string;
  peaks: number[] | undefined;
  isLoading: boolean;
}

export function TrackWaveform({ trackId, peaks, isLoading }: Props) {
  const isReady = peaks !== undefined && peaks.length > 0;
  const [timedOut, setTimedOut] = useState(false);

${effect}

  const showLoader = shouldShowLoader({ isLoading, isReady, timedOut });

  return { trackId, showLoader, peaks };
}
`;
}

// A caller that retries the same track, so the mode is not merely theoretical.
// Both variants get it identically — it exists so that the probe tests comment
// deference and NOT the reachability carve-out, which would otherwise be a
// second variable.
const PLAYER = `import { TrackWaveform } from "./TrackWaveform";

interface RetryState {
  attempt: number;
  trackId: string;
}

// Retry loads the SAME track again: trackId is intentionally unchanged, only
// the attempt counter moves.
export function retryLoad(state: RetryState): RetryState {
  return { attempt: state.attempt + 1, trackId: state.trackId };
}

export function renderTrack(trackId: string, peaks: number[] | undefined) {
  return TrackWaveform({ trackId, peaks, isLoading: true });
}
`;

const README = `# fixture-waveform

Renders a track waveform with a loading placeholder. \`shouldShowLoader\` owns
the spinner decision; \`TrackWaveform\` owns the load-timeout backstop.
`;

// Deliberately neutral: nothing here hints at the latch or the retry path.
const GOTCHAS = `- React effects re-run only when a value in their dependency array changes.
- Placeholder artwork is shown whenever the spinner is suppressed.
- Track ids are stable strings; the same id is reused across retries of a track.
`;

export async function buildProbeFixture(
  variant: ProbeVariant,
  lifecycleAgentSource: string,
): Promise<ProbeFixture> {
  const base = await mkdtemp(path.join(tmpdir(), `pr-hero-probe-${variant}-`));
  const repoDir = path.join(base, "repo");
  const agentsDir = path.join(base, "agents");
  const runDir = path.join(base, "run");
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  await mkdir(agentsDir);
  await mkdir(runDir);

  await writeFile(path.join(repoDir, "README.md"), README);
  await writeFile(path.join(repoDir, "src", "constants.ts"), CONSTANTS);
  await writeFile(path.join(repoDir, "src", "loader.ts"), LOADER);
  await writeFile(path.join(repoDir, "src", "player.ts"), PLAYER);
  await writeFile(
    path.join(repoDir, "src", "TrackWaveform.tsx"),
    WAVEFORM_BASE,
  );
  await git(repoDir, ["init", "-q", "-b", "main"]);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "feat: track waveform"]);
  const baseSha = (await git(repoDir, ["rev-parse", "HEAD"])).trim();

  const head = waveformHead(variant);
  await writeFile(path.join(repoDir, "src", "TrackWaveform.tsx"), head);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, [
    "commit",
    "-q",
    "-m",
    "feat: bound waveform loading with a timeout backstop",
  ]);
  const headSha = (await git(repoDir, ["rev-parse", "HEAD"])).trim();

  const diffPath = path.join(base, "diff.patch");
  await writeFile(diffPath, await git(repoDir, ["diff", baseSha, headSha]));

  await writeFile(
    path.join(agentsDir, "deep-review-lifecycle.md"),
    lifecycleAgentSource,
  );

  const gotchasPath = path.join(base, "gotchas.md");
  await writeFile(gotchasPath, GOTCHAS);

  // The answer key is the effect block, located in the file we just wrote so
  // an edit to either variant cannot silently desync the range.
  const lines = head.split("\n");
  const effectStart = lines.findIndex((l) => l.includes("useEffect(() => {"));
  const effectEnd = lines.findIndex((l) =>
    l.includes("}, [isLoading, isReady, trackId]);"),
  );
  if (effectStart < 0 || effectEnd < 0) {
    throw new Error(`probe fixture (${variant}): effect block not located`);
  }
  const expected = {
    path: "src/TrackWaveform.tsx",
    // 1-indexed, and generous by a line on each side: models cite the latch
    // declaration or the dep array rather than the `useEffect` token itself.
    lineMin: effectStart, // the declaration line above, 1-indexed start - 1
    lineMax: effectEnd + 2,
  };

  return {
    variant,
    repoDir,
    baseSha,
    headSha,
    diffPath,
    agentsDir,
    gotchasPath,
    runDir,
    expected,
  };
}
