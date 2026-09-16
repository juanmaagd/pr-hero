// PR mode's review-root setup: the detached worktree, its own codegraph
// index, and the MCP registry the hunters read. Relocated out of reviewPr()
// (src/pr/review-pr.ts): identifiers renamed to explicit parameters
// (`repoHome.paths.registry` -> `registryPath`), control flow unchanged. The
// WHY comments below move with the code they explain.

import { existsSync } from "node:fs";
import path from "node:path";
import { ensureWorktree, initCodegraphIndex } from "#pr/pr";
import { writeMcpConfig } from "#review/run";
import { log } from "#ui/primitives";
import { stampWorktree } from "../home";

export interface PrWorktreeSetupResult {
  mcpConfigPath: string;
  indexMs: number;
}

export async function setupPrWorktree(input: {
  gitDirOwner: string;
  worktreePath: string;
  headSha: string;
  registryPath: string;
  prNumber: number;
  runDir: string;
}): Promise<PrWorktreeSetupResult> {
  const { gitDirOwner, worktreePath, headSha, registryPath, prNumber, runDir } =
    input;

  // The review root.
  const worktree = await ensureWorktree(gitDirOwner, worktreePath, headSha);
  log();
  log(`worktree ${worktree.action}: ${worktreePath} (${worktree.reason})`);
  await stampWorktree(registryPath, prNumber, new Date().toISOString());

  // The worktree's own index. Never another checkout's: the ROADMAP forbids
  // riding a sibling's index, because its bytes may differ.
  let indexMs = 0;
  if (!existsSync(path.join(worktreePath, ".codegraph"))) {
    if (Bun.which("codegraph") === null) {
      log(
        "codegraph CLI not found — no index will be built; hunters run on " +
          "Read/Grep/Glob alone",
      );
    } else {
      indexMs = await initCodegraphIndex(worktreePath);
      log(`codegraph init: ${Math.round(indexMs / 1000)}s`);
    }
  }

  // MCP registry, checked against the WORKTREE. Local mode checks the repo
  // root because the repo root is what its hunters read; here the hunters'
  // tree is the worktree, and an index found in the operator checkout would
  // be exactly the other-checkout's index the step above refuses to ride.
  const mcpConfigPath = path.join(runDir, "mcp.json");
  const codegraphAvailable = existsSync(path.join(worktreePath, ".codegraph"));
  await writeMcpConfig(mcpConfigPath, codegraphAvailable);

  return { mcpConfigPath, indexMs };
}
