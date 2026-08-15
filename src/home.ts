// I/O for the global ~/.prhero/ product home (W3 / #24). Every decision it
// acts on lives in home-preflight.ts. cli.ts and watch.ts call this so the
// registry read/write and the origin lookup are not copied across shells.
//
// Same git-runner rule as the other shells: args as an ARRAY, never an
// interpolated shell string.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  canonicalRemoteId,
  decideRegistryUpsert,
  missingOriginMessage,
  ownerGoneMessage,
  parseRepoRegistry,
  type RepoHomePaths,
  type RepoRegistry,
  repoHomePaths,
  serializeRepoRegistry,
} from "./home-preflight";
import { CliError } from "./preflight";

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

export interface ResolvedRepoHome {
  repoId: string;
  paths: RepoHomePaths;
  registry: RepoRegistry;
  gitDirOwner: string;
  upsertAction: "create" | "append-checkout" | "unchanged";
}

export async function resolveRepoHome(input: {
  home: string;
  operatorRoot: string;
  persist: boolean;
}): Promise<ResolvedRepoHome> {
  const originUrl = await gitOriginUrl(input.operatorRoot);
  const repoId = canonicalRemoteId(originUrl);
  const paths = repoHomePaths(input.home, repoId);
  const existing = existsSync(paths.registry)
    ? parseRepoRegistry(await Bun.file(paths.registry).text())
    : null;
  const decision = decideRegistryUpsert({
    existing,
    canonicalRemote: repoId,
    originUrl,
    checkoutPath: input.operatorRoot,
    ownerPresent:
      existing === null ? true : ownerPresent(existing.git_dir_owner),
  });
  if (decision.action === "owner-gone") {
    throw new CliError(ownerGoneMessage(paths.registry, decision.message));
  }
  if (input.persist && decision.action !== "unchanged") {
    await mkdir(paths.root, { recursive: true });
    await Bun.write(paths.registry, serializeRepoRegistry(decision.registry));
  }
  return {
    repoId,
    paths,
    registry: decision.registry,
    gitDirOwner: decision.registry.git_dir_owner,
    upsertAction: decision.action,
  };
}

export async function writeRepoRegistry(
  registryPath: string,
  registry: RepoRegistry,
): Promise<void> {
  await mkdir(path.dirname(registryPath), { recursive: true });
  await Bun.write(registryPath, serializeRepoRegistry(registry));
}
