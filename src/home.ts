// I/O for the global ~/.prhero/ product home (W3 / #24). Every decision it
// acts on lives in home-preflight.ts. cli.ts and watch.ts call this so the
// registry read/write and the origin lookup are not copied across shells.
//
// Same git-runner rule as the other shells: args as an ARRAY, never an
// interpolated shell string.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  canonicalRemoteId,
  decidePidLock,
  decideRegistryUpsert,
  missingOriginMessage,
  ownerGoneMessage,
  parseRepoRegistry,
  type RepoHomePaths,
  type RepoRegistry,
  registryLockPath,
  repoHomePaths,
  serializeRepoRegistry,
  touchWorktreeStamp,
} from "./home-preflight";
import { CliError } from "./preflight";
import { parseLockPid } from "./watch-preflight";

const PID_LOCK_ATTEMPTS = 3;

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

export async function gitOriginUrl(repoRoot: string): Promise<string> {
  const result = await git(repoRoot, ["remote", "get-url", "origin"]);
  if (!result.ok) {
    throw new CliError(missingOriginMessage(repoRoot));
  }
  const url = result.stdout.trim();
  if (url.length === 0) {
    throw new CliError(missingOriginMessage(repoRoot));
  }
  return url;
}

export function ownerPresent(ownerPath: string): boolean {
  return existsSync(ownerPath) && existsSync(path.join(ownerPath, ".git"));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isEexist(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "EEXIST"
  );
}

export function worktreeInFlight(lockPath: string): boolean {
  const snapshot = readLockPidSync(lockPath);
  return snapshot.existingPid !== null && pidAlive(snapshot.existingPid);
}

function readLockPidSync(lockPath: string): {
  fileExists: boolean;
  existingPid: number | null;
} {
  if (!existsSync(lockPath)) {
    return { fileExists: false, existingPid: null };
  }
  try {
    const raw = readFileSync(lockPath, "utf8");
    return { fileExists: true, existingPid: parseLockPid(raw) };
  } catch {
    return { fileExists: true, existingPid: null };
  }
}

export async function acquirePidLock(lockPath: string): Promise<void> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < PID_LOCK_ATTEMPTS; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`);
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (!isEexist(error)) throw error;
    }
    const snapshot = readLockPidSync(lockPath);
    const holderAlive =
      snapshot.existingPid !== null && pidAlive(snapshot.existingPid);
    const decision = decidePidLock({
      fileExists: snapshot.fileExists,
      existingPid: snapshot.existingPid,
      holderAlive,
    });
    if (decision.action === "held") {
      throw new CliError(`lock held by pid ${decision.pid}: ${lockPath}`);
    }
    if (decision.action === "create") continue;
    await rm(lockPath, { force: true });
  }
  throw new CliError(`could not acquire lock: ${lockPath}`);
}

export async function releasePidLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

export interface ResolvedRepoHome {
  repoId: string;
  paths: RepoHomePaths;
  registry: RepoRegistry;
  gitDirOwner: string;
  upsertAction: "create" | "append-checkout" | "unchanged";
}

async function readRegistry(
  registryPath: string,
): Promise<RepoRegistry | null> {
  if (!existsSync(registryPath)) return null;
  return parseRepoRegistry(await Bun.file(registryPath).text());
}

function upsertFromExisting(
  existing: RepoRegistry | null,
  repoId: string,
  originUrl: string,
  operatorRoot: string,
): ReturnType<typeof decideRegistryUpsert> {
  return decideRegistryUpsert({
    existing,
    canonicalRemote: repoId,
    originUrl,
    checkoutPath: operatorRoot,
    ownerPresent:
      existing === null ? true : ownerPresent(existing.git_dir_owner),
  });
}

export async function resolveRepoHome(input: {
  home: string;
  operatorRoot: string;
  persist: boolean;
}): Promise<ResolvedRepoHome> {
  const originUrl = await gitOriginUrl(input.operatorRoot);
  const repoId = canonicalRemoteId(originUrl);
  const paths = repoHomePaths(input.home, repoId);
  const apply = async (existing: RepoRegistry | null) => {
    const decision = upsertFromExisting(
      existing,
      repoId,
      originUrl,
      input.operatorRoot,
    );
    if (decision.action === "owner-gone") {
      throw new CliError(ownerGoneMessage(paths.registry, decision.message));
    }
    if (input.persist && decision.action !== "unchanged") {
      await writeRepoRegistry(paths.registry, decision.registry);
    }
    return {
      repoId,
      paths,
      registry: decision.registry,
      gitDirOwner: decision.registry.git_dir_owner,
      upsertAction: decision.action,
    } satisfies ResolvedRepoHome;
  };
  if (!input.persist) {
    return apply(await readRegistry(paths.registry));
  }
  const lockPath = registryLockPath(paths.registry);
  await acquirePidLock(lockPath);
  try {
    return await apply(await readRegistry(paths.registry));
  } finally {
    await releasePidLock(lockPath);
  }
}

export async function writeRepoRegistry(
  registryPath: string,
  registry: RepoRegistry,
): Promise<void> {
  await mkdir(path.dirname(registryPath), { recursive: true });
  const tmp = `${registryPath}.tmp`;
  await Bun.write(tmp, serializeRepoRegistry(registry));
  await rename(tmp, registryPath);
}

export async function stampWorktree(
  registryPath: string,
  pr: number,
  isoTimestamp: string,
): Promise<RepoRegistry> {
  const lockPath = registryLockPath(registryPath);
  await acquirePidLock(lockPath);
  try {
    const existing = await readRegistry(registryPath);
    if (existing === null) {
      throw new CliError(
        `registry.json is missing; cannot stamp worktree pr-${pr} ` +
          `(${registryPath})`,
      );
    }
    const next = touchWorktreeStamp(existing, pr, isoTimestamp);
    await writeRepoRegistry(registryPath, next);
    return next;
  } finally {
    await releasePidLock(lockPath);
  }
}
