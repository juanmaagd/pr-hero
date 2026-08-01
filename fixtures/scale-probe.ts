// Scale probe fixture (ROADMAP A1 diagnostic, not an arm).
//
// WHY THIS EXISTS. The comment probe killed the comment-deference hypothesis
// and showed the v2 lifecycle agent hitting the G2 defect shape 6/6 on an
// isolated fixture — while the same agent missed the real golden 0/4 across
// two arms. Two candidate explanations survived that probe, and it could not
// tell them apart because it varied neither:
//
//   1. PRIOR. The comment probe's suspicion prior said "loading backstop added
//      in this diff", which nearly names the resource. The real run's priors
//      point at unrelated musive hotspots.
//   2. DENSITY. The comment probe's repo held essentially ONE lifecycle
//      resource. The real diff is 22KB across 9 files, and the golden's file
//      alone carries many refs, effects, timers and memos, so the ledger the
//      pass must build is long and the golden's row is one of many.
//
// This fixture holds the prior NEUTRAL in every condition (it points at
// src/player.ts, which contains no planted defect) and varies ONLY resource
// density. Comparing the two conditions against the comment probe's 6/6
// baseline separates the two explanations:
//
//   sparse high, crowded low  -> density is the cause; the lever is chunking
//                                the pass per file or per resource.
//   sparse low                -> the naming prior was the crutch; the lever is
//                                targeting, not chunking.
//   both high                 -> neither; the miss lives in something the
//                                fixture still does not reproduce.
//
// The planted defect is identical in both conditions, byte for byte, and the
// decoy resources added in the crowded condition are all CORRECT — each one
// disarms on every mode — so a hit stays unambiguous and the pass earns no
// credit for finding something else.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type Density = "sparse" | "crowded";

export interface ScaleFixture {
  density: Density;
  repoDir: string;
  baseSha: string;
  headSha: string;
  diffPath: string;
  agentsDir: string;
  gotchasPath: string;
  runDir: string;
  expected: { path: string; lineMin: number; lineMax: number };
  decoyCount: number;
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

// --- The planted defect (identical in both conditions) -----------------------
// setTimedOut(false) runs only when the effect re-runs, and the effect re-runs
// only when a dep changes. A retry of the SAME track changes none of them, so
// the latch carries the previous attempt's armed state into the new attempt.
const PLANTED_EFFECT = `  useEffect(() => {
    setTimedOut(false);
    if (!isLoading || isReady) return;
    const timer = setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isLoading, isReady, trackId]);`;

// --- Decoys: every one of these is CORRECT ----------------------------------
// Each arms something and disarms it on unmount and on identity change. They
// exist to lengthen the ledger, never to be findings.
const DECOYS: string[] = [
  `  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);`,
  `  useEffect(() => {
    const controller = new AbortController();
    void fetchTrackMeta(trackId, controller.signal).then(setMeta);
    return () => controller.abort();
  }, [trackId]);`,
  `  useEffect(() => {
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [trackId]);`,
  `  useEffect(() => {
    const unsubscribe = playerBus.subscribe(trackId, setPlayhead);
    return () => unsubscribe();
  }, [trackId]);`,
  `  useEffect(() => {
    hoverRef.current = false;
    const onLeave = () => {
      hoverRef.current = false;
    };
    document.addEventListener("mouseleave", onLeave);
    return () => document.removeEventListener("mouseleave", onLeave);
  }, [trackId]);`,
  `  useEffect(() => {
    const observer = new ResizeObserver(() => setViewportWidth(window.innerWidth));
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [trackId]);`,
  `  useEffect(() => {
    let cancelled = false;
    void decodePeaks(trackId).then((p) => {
      if (!cancelled) setDecoded(p);
    });
    return () => {
      cancelled = true;
    };
  }, [trackId]);`,
];

const SUPPORT = `export const LOAD_TIMEOUT_MS = 8000;

export async function fetchTrackMeta(
  trackId: string,
  signal: AbortSignal,
): Promise<{ title: string }> {
  const res = await fetch(\`/api/tracks/\${trackId}\`, { signal });
  return res.json();
}

export async function decodePeaks(trackId: string): Promise<number[]> {
  const res = await fetch(\`/api/tracks/\${trackId}/peaks\`);
  return res.json();
}

export const playerBus = {
  subscribe(_trackId: string, _cb: (t: number) => void): () => void {
    return () => {};
  },
};
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

// Retries the SAME track: trackId is intentionally unchanged.
const PLAYER = `import { TrackWaveform } from "./TrackWaveform";

interface RetryState {
  attempt: number;
  trackId: string;
}

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

const GOTCHAS = `- React effects re-run only when a value in their dependency array changes.
- Placeholder artwork is shown whenever the spinner is suppressed.
- Track ids are stable strings; the same id is reused across retries of a track.
`;

// The decoy state each decoy effect drives. Present in the crowded condition's
// BASE commit so the diff adds effects, not bookkeeping.
const DECOY_STATE = `  const [viewportWidth, setViewportWidth] = useState(0);
  const [meta, setMeta] = useState<{ title: string } | undefined>();
  const [elapsed, setElapsed] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const [decoded, setDecoded] = useState<number[] | undefined>();
  const hoverRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);`;

const DECOY_RETURN = `, viewportWidth, meta, elapsed, playhead, decoded, hoverRef, containerRef`;

function waveformFile(
  density: Density,
  stage: "base" | "head",
): string {
  const crowded = density === "crowded";
  // DENSITY IS THE VARIABLE, and it must land in the DIFF: the pass enumerates
  // resources the diff TOUCHES, so decoys sitting in the base commit would
  // leave the ledger one row long in both conditions and measure reading
  // burden instead of ledger length. The decoy EFFECTS are therefore added by
  // the head commit alongside the planted one — 1 ledger row in sparse, 8 in
  // crowded — while the planted hunk itself stays byte-identical.
  const effects: string[] = [];
  if (stage === "head") {
    if (crowded) effects.push(...DECOYS);
    effects.push(PLANTED_EFFECT);
  }
  const imports = crowded
    ? `import { useEffect, useRef, useState } from "react";
import { LOAD_TIMEOUT_MS, decodePeaks, fetchTrackMeta, playerBus } from "./support";`
    : `import { useEffect, useState } from "react";
import { LOAD_TIMEOUT_MS } from "./support";`;
  const latch =
    stage === "head"
      ? "  const [timedOut, setTimedOut] = useState(false);"
      : "  const [timedOut] = useState(false);";
  const body = effects.length ? `\n${effects.join("\n\n")}\n` : "";
  return `${imports}
import { shouldShowLoader } from "./loader";

interface Props {
  trackId: string;
  peaks: number[] | undefined;
  isLoading: boolean;
}

export function TrackWaveform({ trackId, peaks, isLoading }: Props) {
  const isReady = peaks !== undefined && peaks.length > 0;
${latch}
${crowded ? `${DECOY_STATE}\n` : ""}${body}
  const showLoader = shouldShowLoader({ isLoading, isReady, timedOut });

  return { trackId, showLoader, peaks${crowded ? DECOY_RETURN : ""} };
}
`;
}

export async function buildScaleFixture(
  density: Density,
  lifecycleAgentSource: string,
): Promise<ScaleFixture> {
  const base = await mkdtemp(path.join(tmpdir(), `pr-hero-scale-${density}-`));
  const repoDir = path.join(base, "repo");
  const agentsDir = path.join(base, "agents");
  const runDir = path.join(base, "run");
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  await mkdir(agentsDir);
  await mkdir(runDir);

  await writeFile(path.join(repoDir, "README.md"), README);
  await writeFile(path.join(repoDir, "src", "support.ts"), SUPPORT);
  await writeFile(path.join(repoDir, "src", "loader.ts"), LOADER);
  await writeFile(path.join(repoDir, "src", "player.ts"), PLAYER);
  await writeFile(
    path.join(repoDir, "src", "TrackWaveform.tsx"),
    waveformFile(density, "base"),
  );
  await git(repoDir, ["init", "-q", "-b", "main"]);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "feat: track waveform"]);
  const baseSha = (await git(repoDir, ["rev-parse", "HEAD"])).trim();

  const head = waveformFile(density, "head");
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

  const lines = head.split("\n");
  const start = lines.findIndex((l) =>
    l.includes("setTimedOut(false);"),
  );
  const end = lines.findIndex((l) =>
    l.includes("}, [isLoading, isReady, trackId]);"),
  );
  if (start < 0 || end < 0) {
    throw new Error(`scale fixture (${density}): planted effect not located`);
  }
  const expected = {
    path: "src/TrackWaveform.tsx",
    // Generous by two lines each way: models cite the latch declaration, the
    // setTimeout, or the dep array rather than one canonical line.
    lineMin: start - 2,
    lineMax: end + 2,
  };

  return {
    density,
    repoDir,
    baseSha,
    headSha,
    diffPath,
    agentsDir,
    gotchasPath,
    runDir,
    expected,
    decoyCount: density === "crowded" ? DECOYS.length : 0,
  };
}
