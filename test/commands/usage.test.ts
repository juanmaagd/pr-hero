import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { originUsageScope } from "#commands/usage";
import { CliError } from "../../src/errors";
import {
  canonicalRemoteId,
  missingOriginMessage,
} from "../../src/home-preflight";

// ---------------------------------------------------------------------------
// W4 Phase 6 remediation (sdd-verify option D): four offline tests closing
// the PARTIAL scenarios the verify report flagged, plus the --out product
// fix. `runGit`/`tmpGitRepo` spawn a REAL git binary against a throwaway tmp
// dir — the only way to exercise gitOriginUrl/resolveRepoHome's actual
// decision (present vs. absent origin) without faking git itself.

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

async function tmpGitRepo(
  originUrl: string | null,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-git-"));
  await runGit(dir, ["init", "-q"]);
  await runGit(dir, ["config", "user.email", "test@example.com"]);
  await runGit(dir, ["config", "user.name", "Test"]);
  if (originUrl !== null) {
    await runGit(dir, ["remote", "add", "origin", originUrl]);
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("originUsageScope — usage's scoped-mode resolver (W4 Phase 6)", () => {
  test("a checkout with no resolvable origin throws the exact missingOriginMessage", async () => {
    const repo = await tmpGitRepo(null);
    const home = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-home-"));
    try {
      let caught: unknown;
      try {
        await originUsageScope(home, repo.dir);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CliError);
      expect((caught as Error).message).toBe(missingOriginMessage(repo.dir));
    } finally {
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a checkout with a resolvable origin resolves repoId from canonicalRemoteId", async () => {
    const originUrl = "https://github.com/acme/widgets.git";
    const repo = await tmpGitRepo(originUrl);
    const home = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-home-"));
    try {
      const scope = await originUsageScope(home, repo.dir);
      expect(scope).toEqual({ repoId: canonicalRemoteId(originUrl) });
    } finally {
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });
});
