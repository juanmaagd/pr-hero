// gatherRepoFacts and the pre-launch veto had ZERO coverage before this file
// (prheroignore Phase 6, design D6) — the exact gap pr-hero's own review of
// PR #204 caught (CRITICAL, blocking): watch mode never read `.prheroignore`,
// so a PR whose custom rules would rescue it was skipped PERMANENTLY.
//
// Every gatherRepoFacts scenario below runs through the REAL pipeline: a
// REAL tmpdir git repo (git init + origin), a REAL `.prheroignore` file on
// disk where the scenario calls for one, read by the REAL readLocalIgnoreRules
// — never a hand-rolled IgnoreRule fixture. Only the three things that would
// otherwise be a live network call (git rev-parse, `gh pr list`, `gh pr view
// --json files`) are scripted via WatchIo. This is the same discipline the
// `.prheroignore` dialect's own differential test learned the hard way:
// probing a matching/translation primitive in isolation from the real
// pipeline it runs through can pass while the real pipeline disagrees, and
// the isolated probe is the one that lies.
//
// DELIBERATE SCOPE BOUNDARY, found while writing this file, not assumed —
// flagged here for the next reader/orchestrator rather than silently worked
// around: gatherRepoFacts calls fetchPrComments/fetchCommitStatuses
// UNCONDITIONALLY for any candidate that survives both size-gate tiers — real
// `gh api` calls, outside design D6's DI seam (`{git, ghPrList, ghPrFiles,
// readIgnoreFile}`). So no fixture PR in this file is ever allowed to become
// genuinely ELIGIBLE through gatherRepoFacts itself — that would need a live,
// network-dependent `gh` response this offline suite must never depend on.
// The "rescue" scenarios below instead prove the discriminating flip between
// two SKIP verdicts (too-large vs nothing-to-review), which is exactly the
// point at which `.prheroignore` changes the gate's own decision, without
// ever reaching the unconditional comments/statuses fetch. A literal
// launch-vs-skip flip through gatherRepoFacts itself would need
// fetchPrComments/fetchCommitStatuses added to the DI seam too (both already
// accept an optional `spawnFn`, so the seam exists on their side) — that is a
// scope decision for whoever owns design D6 next, not one made unilaterally
// here. applyPreLaunchVeto — which exists precisely because an
// eligible-but-all-excluded PR reaches THAT unconditional fetch — is tested
// separately below, against a WatchedRepoFacts fixture whose `excludeRules`
// field is still built through the real sizeGateConfig()/parseIgnoreFile()
// pipeline, never hand-rolled.

import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseIgnoreFile } from "../src/ignore-file";
import { readLocalIgnoreRules } from "../src/ignore-read";
import { DEFAULT_SIZE_GATE, sizeGateConfig } from "../src/size-gate";
import {
  applyPreLaunchVeto,
  gatherRepoFacts,
  type WatchedRepoFacts,
  type WatchIo,
} from "../src/watch";
import {
  decideTick,
  type TickLaunch,
  type WatchConfig,
  type WatchPrCandidate,
} from "../src/watch-preflight";

const HEAD_A = "a".repeat(40);

async function runGit(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

// A REAL git binary against a throwaway tmp dir — the only way to exercise
// resolveRepoHome's actual origin read (called unconditionally inside
// gatherRepoFacts) without faking git itself. Duplicated from test/cli.test.ts's
// own tmpGitRepo on purpose, matching this repo's "no shell imports another
// shell" convention extended to test helpers.
async function tmpGitRepo(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const raw = await mkdtemp(path.join(tmpdir(), "pr-hero-watch-git-"));
  // macOS's /tmp is a symlink to /private/tmp — `git rev-parse
  // --show-toplevel` resolves it, so a raw mkdtemp() path would never equal
  // gatherRepoFacts's own resolved repoRoot. Canonicalize once, here, so
  // every assertion below compares the SAME resolved path git itself uses.
  const dir = await realpath(raw);
  await runGit(dir, ["init", "-q"]);
  await runGit(dir, ["config", "user.email", "test@example.com"]);
  await runGit(dir, [
    "remote",
    "add",
    "origin",
    "https://github.com/acme/widgets.git",
  ]);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// The DI seam's own `git` field — a REAL shelling implementation, matching
// production wiring, since every gatherRepoFacts test here runs against a
// REAL tmpdir repo and there is no reason to fake `git rev-parse` when the
// real answer is one spawn away.
async function shellGit(
  repo: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
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

function ghPrListJson(
  prs: {
    number: number;
    head: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    isDraft?: boolean;
  }[],
): string {
  return JSON.stringify(
    prs.map((p) => ({
      number: p.number,
      headRefOid: p.head,
      isDraft: p.isDraft ?? false,
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: p.changedFiles,
    })),
  );
}

function ghPrFilesJson(
  files: { path: string; additions: number; deletions?: number }[],
): string {
  return JSON.stringify({
    files: files.map((f) => ({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions ?? 0,
      changeType: "modified",
    })),
  });
}

function watchConfig(repoPath: string): WatchConfig {
  return {
    repos: [
      {
        path: repoPath,
        post: false,
        onPush: false,
        maxChangedLines: 100,
        maxChangedFiles: 10,
      },
    ],
    dailyCap: 5,
    window: null,
  };
}

describe("gatherRepoFacts — .prheroignore wiring (prheroignore Phase 6)", () => {
  test("gate config for a repo with no open PRs still reflects its own .prheroignore rule, merged builtins-first", async () => {
    const repo = await tmpGitRepo();
    const home = await mkdtemp(path.join(tmpdir(), "pr-hero-watch-home-"));
    try {
      await writeFile(path.join(repo.dir, ".prheroignore"), "vendor/**\n");
      const io: WatchIo = {
        git: shellGit,
        ghPrList: async () => ghPrListJson([]),
        ghPrFiles: async () => ghPrFilesJson([]),
        readIgnoreFile: readLocalIgnoreRules,
      };

      const facts = await gatherRepoFacts(watchConfig(repo.dir), home, io);

      const expected = sizeGateConfig(
        { maxChangedLines: 100, maxChangedFiles: 10 },
        undefined,
        parseIgnoreFile("vendor/**\n", "user"),
      ).excludeRules;
      expect(facts[0]?.excludeRules).toEqual(expected);
      // Not merely "read" — actually DIFFERENT from builtins-only, or a
      // reads-then-ignores implementation would pass this test too.
      expect(facts[0]?.excludeRules).not.toEqual(
        DEFAULT_SIZE_GATE.excludeRules,
      );
    } finally {
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });

  // THE discriminating test: the SAME PR, with and without a .prheroignore
  // that covers its bulk, must produce OPPOSITE tier-2 verdicts. A single
  // vendor file is the whole diff, so the flip is too-large -> nothing-to-
  // review — a genuine change in the gate's own ok/effectiveFiles verdict,
  // never reaching the live comments/statuses fetch either way (see this
  // file's header for why that boundary matters).
  test("SAME all-vendor PR, with vs without .prheroignore, produces OPPOSITE scheduling decisions", async () => {
    const repo = await tmpGitRepo();
    const home = await mkdtemp(path.join(tmpdir(), "pr-hero-watch-home-"));
    try {
      const io: WatchIo = {
        git: shellGit,
        ghPrList: async () =>
          ghPrListJson([
            {
              number: 42,
              head: HEAD_A,
              additions: 2000,
              deletions: 0,
              changedFiles: 1,
            },
          ]),
        ghPrFiles: async () =>
          ghPrFilesJson([{ path: "vendor/bundle.js", additions: 2000 }]),
        readIgnoreFile: readLocalIgnoreRules,
      };

      const before = await gatherRepoFacts(watchConfig(repo.dir), home, io);
      expect(before[0]?.tooLarge).toEqual([42]);
      expect(before[0]?.nothingToReview).toEqual([]);
      const beforeDecision = decideTick({
        window: null,
        localMinutes: 0,
        dailyCap: 5,
        launchedToday: 0,
        repos: before,
      });
      expect(beforeDecision.skips).toEqual([
        { repo: repo.dir, pr: 42, head: HEAD_A, reason: "too-large" },
      ]);

      await writeFile(path.join(repo.dir, ".prheroignore"), "vendor/**\n");

      const after = await gatherRepoFacts(watchConfig(repo.dir), home, io);
      expect(after[0]?.tooLarge).toEqual([]);
      expect(after[0]?.nothingToReview).toEqual([42]);
      const afterDecision = decideTick({
        window: null,
        localMinutes: 0,
        dailyCap: 5,
        launchedToday: 0,
        repos: after,
      });
      expect(afterDecision.skips).toEqual([
        { repo: repo.dir, pr: 42, head: HEAD_A, reason: "nothing-to-review" },
      ]);
    } finally {
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("no .prheroignore present behaves exactly as builtins-only (no regression)", async () => {
    const repo = await tmpGitRepo();
    const home = await mkdtemp(path.join(tmpdir(), "pr-hero-watch-home-"));
    try {
      const io: WatchIo = {
        git: shellGit,
        ghPrList: async () =>
          ghPrListJson([
            {
              number: 7,
              head: HEAD_A,
              additions: 5000,
              deletions: 0,
              changedFiles: 1,
            },
          ]),
        // A lockfile-only bump: builtins alone already exclude it, so this
        // must stay nothing-to-review (never reach eligibility/fetchPrComments)
        // whether or not this change exists — the no-regression proof.
        ghPrFiles: async () =>
          ghPrFilesJson([{ path: "bun.lock", additions: 5000 }]),
        readIgnoreFile: readLocalIgnoreRules,
      };

      const facts = await gatherRepoFacts(watchConfig(repo.dir), home, io);
      expect(facts[0]?.excludeRules).toEqual(DEFAULT_SIZE_GATE.excludeRules);
      // bun.lock is a builtin exclusion: same rescue as before this change.
      expect(facts[0]?.tooLarge).toEqual([]);
      expect(facts[0]?.nothingToReview).toEqual([7]);
    } finally {
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });

  // Tier 2's pre-existing truncation guard, unbroken by threading real
  // exclusion rules through: gh's file list can be truncated on a very
  // large PR, and an under-counted list must never be trusted to rescue
  // anything, even when the .prheroignore rule that WOULD exclude every
  // listed file is present and real.
  test("a truncated ghPrFiles list still refuses to rescue", async () => {
    const repo = await tmpGitRepo();
    const home = await mkdtemp(path.join(tmpdir(), "pr-hero-watch-home-"));
    try {
      await writeFile(path.join(repo.dir, ".prheroignore"), "vendor/**\n");
      const io: WatchIo = {
        git: shellGit,
        ghPrList: async () =>
          ghPrListJson([
            {
              number: 9,
              head: HEAD_A,
              additions: 2000,
              deletions: 0,
              // The real PR touches 5 files; gh reports only 2 below.
              changedFiles: 5,
            },
          ]),
        ghPrFiles: async () =>
          ghPrFilesJson([{ path: "vendor/a.js", additions: 1000 }]),
        readIgnoreFile: readLocalIgnoreRules,
      };

      const facts = await gatherRepoFacts(watchConfig(repo.dir), home, io);
      expect(facts[0]?.tooLarge).toEqual([9]);
      expect(facts[0]?.nothingToReview).toEqual([]);
    } finally {
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// applyPreLaunchVeto — D6's pre-launch exclusion veto. Fixtures are built
// directly (the same pattern watch-preflight.test.ts's decideTick tests use
// for TickRepoFacts) rather than through a live gatherRepoFacts run, because
// the scenario this veto exists FOR — an eligible, all-excluded PR — is
// exactly the one gatherRepoFacts cannot safely reach offline (see this
// file's header). `excludeRules` below is still built through the real
// sizeGateConfig()/parseIgnoreFile() pipeline, never a hand-rolled IgnoreRule.

function watchedRepoFacts(
  over: Partial<WatchedRepoFacts> & { prs: WatchPrCandidate[] },
): WatchedRepoFacts {
  return {
    path: "/x/repo",
    post: false,
    onPush: false,
    localReviews: [],
    remoteHeads: [],
    attempts: [],
    tooLarge: [],
    nothingToReview: [],
    inFlight: [],
    pending: [],
    runsRoot: "/x/repo/.prhero-runs",
    maxChangedLines: 100,
    maxChangedFiles: 10,
    excludeRules: sizeGateConfig(
      { maxChangedLines: 100, maxChangedFiles: 10 },
      undefined,
      parseIgnoreFile("vendor/**\n", "user"),
    ).excludeRules,
    ...over,
  };
}

const LAUNCH: TickLaunch = {
  repo: "/x/repo",
  post: false,
  pr: 42,
  head: HEAD_A,
};

describe("applyPreLaunchVeto (D6 — the pre-launch exclusion veto)", () => {
  test("an all-excluded PR under both aggregate limits is vetoed, costing exactly one ghPrFiles call", async () => {
    let calls = 0;
    const repos = [
      watchedRepoFacts({
        prs: [
          {
            pr: 42,
            head: HEAD_A,
            isDraft: false,
            additions: 50,
            deletions: 0,
            changedFiles: 1,
          },
        ],
      }),
    ];
    const io = {
      ghPrFiles: async () => {
        calls++;
        return ghPrFilesJson([{ path: "vendor/x.js", additions: 50 }]);
      },
    };

    const result = await applyPreLaunchVeto(io, LAUNCH, repos);

    expect(result).toEqual({ launch: null, vetoed: true });
    expect(calls).toBe(1);
  });

  test("a surviving (non-excluded) file is not vetoed", async () => {
    const repos = [
      watchedRepoFacts({
        prs: [
          {
            pr: 42,
            head: HEAD_A,
            isDraft: false,
            additions: 60,
            deletions: 0,
            changedFiles: 2,
          },
        ],
      }),
    ];
    const io = {
      ghPrFiles: async () =>
        ghPrFilesJson([
          { path: "vendor/x.js", additions: 50 },
          { path: "src/real.ts", additions: 10 },
        ]),
    };

    const result = await applyPreLaunchVeto(io, LAUNCH, repos);

    expect(result).toEqual({ launch: LAUNCH, vetoed: false });
  });

  test("a truncated ghPrFiles list never vetoes, even if every listed file is excluded", async () => {
    const repos = [
      watchedRepoFacts({
        prs: [
          {
            pr: 42,
            head: HEAD_A,
            isDraft: false,
            additions: 50,
            deletions: 0,
            // The real PR touches 3 files; gh reports only 1 below.
            changedFiles: 3,
          },
        ],
      }),
    ];
    const io = {
      ghPrFiles: async () =>
        ghPrFilesJson([{ path: "vendor/x.js", additions: 50 }]),
    };

    const result = await applyPreLaunchVeto(io, LAUNCH, repos);

    expect(result).toEqual({ launch: LAUNCH, vetoed: false });
  });

  test("a ghPrFiles failure during the veto fails open — the launch proceeds", async () => {
    const repos = [
      watchedRepoFacts({
        prs: [
          {
            pr: 42,
            head: HEAD_A,
            isDraft: false,
            additions: 50,
            deletions: 0,
            changedFiles: 1,
          },
        ],
      }),
    ];
    const io = {
      ghPrFiles: async () => {
        throw new Error("gh: rate limited");
      },
    };

    const result = await applyPreLaunchVeto(io, LAUNCH, repos);

    expect(result).toEqual({ launch: LAUNCH, vetoed: false });
  });
});

// ---------------------------------------------------------------------------
// The property applyPreLaunchVeto's own unit tests above CANNOT observe:
// "a vetoed launch consumes no daily-cap unit." That property lives in
// runTick, which spawns a real child process end to end — not something an
// offline test drives directly (see this file's own header for the same
// live-`gh` boundary). `launchedLine` is what `countLaunchedToday` reads back
// as the daily-cap counter (watch-preflight.ts's own WHY on that pair), so
// "consumes no daily-cap unit" reduces to "the veto call happens before that
// log line is appended" — a source-text pin, same precedent test/cli.test.ts
// already uses for an unexported I/O shell's wiring.
describe("runTick source-text pin — the veto settles before the daily-cap-consuming log line", () => {
  test("applyPreLaunchVeto is invoked, and re-checked for null, before launchedLine is ever appended", async () => {
    const source = await Bun.file(
      path.resolve(import.meta.dir, "../src/watch.ts"),
    ).text();
    const runTickStart = source.indexOf("async function runTick(");
    expect(runTickStart).toBeGreaterThan(-1);
    const vetoCallIndex = source.indexOf("applyPreLaunchVeto(", runTickStart);
    const nullCheckIndex = source.indexOf(
      "if (launch === null) {",
      vetoCallIndex,
    );
    const launchedLineIndex = source.indexOf("launchedLine(", runTickStart);
    expect(vetoCallIndex).toBeGreaterThan(runTickStart);
    expect(nullCheckIndex).toBeGreaterThan(vetoCallIndex);
    expect(launchedLineIndex).toBeGreaterThan(nullCheckIndex);
  });
});
