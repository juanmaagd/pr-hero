// Worktree GC I/O (W3 / GitHub #18). Scans ~/.prhero/repos/*/worktrees,
// asks gh for PR state, and tears trees down with `git worktree remove
// --force` only. Decisions live in gc-preflight.ts.
//
// Same git-runner rule as the other shells: args as an ARRAY, never an
// interpolated shell string. Never rm -rf — a live codegraph daemon holds
// .codegraph/daemon.sock.

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  decideGc,
  type PrLifecycle,
  parseGhPrState,
  parseWorktreePr,
  worktreeRemoveArgs,
} from "./gc-preflight";
import { resolveRepoHome, worktreeInFlight } from "./home";
import {
  parseRepoRegistry,
  prheroLayout,
  type RepoRegistry,
  repoHomePaths,
  worktreeLockPath,
} from "./home-preflight";
import { CliError, type CliOptions } from "./preflight";
import { log } from "./ui";

async function git(
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

async function ghPrStateJson(cwd: string, pr: number): Promise<string | null> {
  const proc = Bun.spawn(["gh", "pr", "view", String(pr), "--json", "state"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) return null;
  return stdout;
}

interface DiscoveredWorktree {
  repoId: string;
  pr: number;
  worktreePath: string;
  lockPath: string;
  registry: RepoRegistry;
  dirMtimeMs: number | null;
}

async function discoverWorktrees(
  home: string,
  onlyRepoId: string | undefined,
): Promise<DiscoveredWorktree[]> {
  const reposDir = prheroLayout(home).reposDir;
  if (!existsSync(reposDir)) return [];
  const found: DiscoveredWorktree[] = [];
  const glob = new Bun.Glob("**/registry.json");
  for await (const rel of glob.scan({ cwd: reposDir })) {
    const registryPath = path.join(reposDir, rel);
    let registry: RepoRegistry;
    try {
      registry = parseRepoRegistry(await Bun.file(registryPath).text());
    } catch {
      continue;
    }
    if (onlyRepoId !== undefined && registry.canonical_remote !== onlyRepoId) {
      continue;
    }
    const paths = repoHomePaths(home, registry.canonical_remote);
    if (!existsSync(paths.worktrees)) continue;
    for (const entry of await readdir(paths.worktrees, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const pr = parseWorktreePr(entry.name);
      if (pr === null) continue;
      const worktreePath = path.join(paths.worktrees, entry.name);
      let dirMtimeMs: number | null = null;
      try {
        dirMtimeMs = (await stat(worktreePath)).mtimeMs;
      } catch {
        dirMtimeMs = null;
      }
      found.push({
        repoId: registry.canonical_remote,
        pr,
        worktreePath,
        lockPath: worktreeLockPath(home, registry.canonical_remote, pr),
        registry,
        dirMtimeMs,
      });
    }
  }
  found.sort((a, b) =>
    a.repoId === b.repoId ? a.pr - b.pr : a.repoId.localeCompare(b.repoId),
  );
  return found;
}

function stampMs(registry: RepoRegistry, pr: number): number | null {
  const stamp = registry.worktrees[String(pr)]?.last_review_at;
  if (stamp === undefined) return null;
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function runGc(input: {
  home: string;
  repoId?: string;
  dryRun: boolean;
  nowMs?: number;
  silent?: boolean;
}): Promise<{ collected: number; kept: number; failed: number }> {
  const nowMs = input.nowMs ?? Date.now();
  const trees = await discoverWorktrees(input.home, input.repoId);
  let collected = 0;
  let kept = 0;
  let failed = 0;
  for (const tree of trees) {
    let prState: PrLifecycle = "unknown";
    const raw = await ghPrStateJson(tree.registry.git_dir_owner, tree.pr);
    if (raw !== null) {
      prState = parseGhPrState(raw);
    } else if (!input.silent) {
      log(
        `gc: gh pr view ${tree.pr} failed for ${tree.repoId}; applying TTL only`,
      );
    }
    const decision = decideGc({
      prState,
      lastReviewAtMs: stampMs(tree.registry, tree.pr),
      dirMtimeMs: tree.dirMtimeMs,
      nowMs,
      inFlight: worktreeInFlight(tree.lockPath),
    });
    if (!input.silent) {
      log(
        `${decision.action.padEnd(8)} pr-${tree.pr}  ${tree.repoId}  ${decision.reason}`,
      );
    }
    if (decision.action === "keep") {
      kept++;
      continue;
    }
    if (input.dryRun) {
      collected++;
      continue;
    }
    const removed = await git(
      tree.registry.git_dir_owner,
      worktreeRemoveArgs(tree.worktreePath),
    );
    if (!removed.ok) {
      failed++;
      if (!input.silent) {
        log(
          `gc: git worktree remove --force ${tree.worktreePath} failed: ` +
            removed.stderr.trim(),
        );
      }
      continue;
    }
    collected++;
  }
  return { collected, kept, failed };
}

export async function gcCommand(options: CliOptions): Promise<number> {
  const home = os.homedir();
  // parseArgs defaults --repo to ".". For gc that means "the whole home",
  // not "the current checkout" — scoping takes an explicit path.
  let repoId: string | undefined;
  if (options.repo !== ".") {
    const resolved = await resolveRepoHome({
      home,
      operatorRoot: path.resolve(options.repo),
      persist: false,
    });
    repoId = resolved.repoId;
  }
  const result = await runGc({
    home,
    repoId,
    dryRun: options.dryRun,
  });
  const verb = options.dryRun ? "dry run: would collect" : "gc: collected";
  log(
    `${verb} ${result.collected}, keep ${result.kept}` +
      (result.failed > 0 ? `, ${result.failed} failed` : ""),
  );
  if (!options.dryRun && result.failed > 0) {
    throw new CliError(
      `gc failed to remove ${result.failed} worktree(s); see stderr`,
    );
  }
  return 0;
}
