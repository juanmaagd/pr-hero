// Authority for packaged-asset resolution and self-invocation.
// Single authority across dev, npm, and compiled runtimes.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { git } from "#git/git";
import {
  BUNDLED_AGENT_FILES,
  CI_SETUP_SKILL_FILES,
  SCOUT_PROMPT_PATH,
  SUMMARIZER_PROMPT_PATH,
  TRIAGE_SKILL_FILES,
} from "./asset-manifest";

export type AssetMode = "dev" | "npm" | "compiled";

export interface EngineAssets {
  mode: AssetMode;
  bundledAgentFiles: Record<string, string>; // logical filename → path, from the manifest (every mode)
  defaultAgentsDir: string; // the prompts/default dir in dev/npm, or embedded asset directory when compiled
  scoutPromptPath: string;
  summarizerPromptPath: string;
  triageSkillFiles: Record<string, string>; // logical filename → path, from the manifest
  ciSetupSkillFiles: Record<string, string>; // logical filename → path, from the manifest
  version: string; // baked at compile; package.json otherwise
}

export interface SelfInvocation {
  command: string; // absolute: the bun binary (dev/npm) or the compiled binary itself
  args: string[]; // [absolute cli.ts] in dev/npm; [] when compiled
}

declare const __PRHERO_VERSION__: string | undefined;

export function detectAssetMode(): AssetMode {
  // Bun compiled binaries embed files into /$bunfs/root/
  if (
    import.meta.dir.startsWith("/$bunfs") ||
    import.meta.url.startsWith("file:///$bunfs")
  ) {
    return "compiled";
  }

  // Check if we are inside a node_modules package or no .git directory
  const gitDir = path.resolve(import.meta.dir, "../.git");
  if (import.meta.dir.includes("node_modules") || !existsSync(gitDir)) {
    return "npm";
  }

  return "dev";
}

function resolveVersion(): string {
  if (typeof __PRHERO_VERSION__ === "string" && __PRHERO_VERSION__.length > 0) {
    return __PRHERO_VERSION__;
  }

  try {
    const pkgPath = path.resolve(import.meta.dir, "../package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (typeof pkg.version === "string") {
        return pkg.version;
      }
    }
  } catch {
    // Ignore read errors
  }

  return "1.1.0";
}

export function resolveEngineAssets(): EngineAssets {
  const mode = detectAssetMode();
  const version = resolveVersion();

  let defaultAgentsDir = path.dirname(BUNDLED_AGENT_FILES["review-refuter.md"]);
  if (mode !== "compiled") {
    const fsDefaultDir = path.resolve(import.meta.dir, "../prompts/default");
    if (existsSync(fsDefaultDir)) {
      defaultAgentsDir = fsDefaultDir;
    }
  }

  return {
    mode,
    bundledAgentFiles: BUNDLED_AGENT_FILES,
    defaultAgentsDir,
    scoutPromptPath: SCOUT_PROMPT_PATH,
    summarizerPromptPath: SUMMARIZER_PROMPT_PATH,
    triageSkillFiles: TRIAGE_SKILL_FILES,
    ciSetupSkillFiles: CI_SETUP_SKILL_FILES,
    version,
  };
}

export function selfInvocation(): SelfInvocation {
  const mode = detectAssetMode();
  if (mode === "compiled") {
    return {
      command: process.execPath,
      args: [],
    };
  }

  return {
    command: process.execPath,
    args: [path.resolve(import.meta.dir, "cli.ts")],
  };
}

// Read through resolveEngineAssets() rather than the constants in index.ts:
// the version a run is stamped with must be the one that would be published,
// and a hand-maintained duplicate drifts. That one resolver also covers the
// compiled binary, whose version is baked in at build time because its
// package.json is not shipped inside the executable.
// C4 O-0. `version` alone does not discriminate: for a source checkout it is
// package.json's, which said 0.1.0 from the scaffold commit onwards, so every
// run this engine has ever written — before and after a change that alters
// what every agent reads — reports the same engine. That is not a cosmetic gap. The Cal.com Martian
// baseline is ratified as valid ACROSS engine versions on the condition that
// the frontier is annotated (docs/martian-bench.md), and an artifact whose
// engine field cannot change cannot annotate anything.
//
// The revision is the git commit, which moves on its own and needs nobody to
// remember a bump — the failure mode this whole item exists to remove.
//
// PURE half, so the fallbacks are testable without a filesystem or a spawn.
export function deriveEngineIdentity(
  pkg: { name?: string; version?: string },
  revision: { ok: boolean; stdout: string },
): { name: string; version: string; revision?: string } {
  const sha = revision.ok ? revision.stdout.trim() : "";
  return {
    name: pkg.name ?? "pr-hero",
    version: pkg.version ?? "0.0.0",
    // ABSENT rather than "unknown" when git cannot answer. A checkout without
    // git, or a tarball install, still has to be able to run a review — a run
    // that refused to start over a provenance field would trade a paid review
    // for a string. Absent reads as "this run could not name its commit",
    // which is exactly true, and it is also what every pre-C4 artifact says.
    ...(sha.length === 0 ? {} : { revision: sha }),
  };
}

// The version comes from resolveEngineAssets(), never from a package.json
// read of its own. A compiled binary's `import.meta.dir` is /$bunfs/root and
// package.json is NOT among the embedded assets, so the old read rejected with
// `ENOENT: /$bunfs/package.json` inside a try/finally that had no catch —
// every `pr-hero upgrade` on a shipped binary died there. assets.version
// already answers the same question correctly in all three modes (the baked
// `__PRHERO_VERSION__` define when compiled, the guarded package.json
// otherwise), so a second source could only ever be the wrong one.
//
// The name is left to deriveEngineIdentity's documented "pr-hero" fallback:
// package.json's `name` IS "pr-hero", and a build cannot rename itself.
//
// `assets` is injectable because detectAssetMode() reads `import.meta.dir`,
// which under `bun test` always reports "dev" — without the seam the compiled
// branch below is unreachable from the offline suite, which is precisely how
// the ENOENT above survived it.
export async function engineIdentity(assets?: EngineAssets): Promise<{
  name: string;
  version: string;
  revision?: string;
}> {
  const resolved = assets ?? resolveEngineAssets();
  if (resolved.mode === "compiled") {
    // No spawn at all, rather than one that is guaranteed to fail: a compiled
    // binary carries no checkout, so `git rev-parse` in its virtual root can
    // only ever exit non-zero. deriveEngineIdentity already omits the field
    // for a failed lookup, so the artifact is identical either way — this
    // just declines to pay for a subprocess on every run to learn something
    // already known, and says so instead of pretending it tried.
    return deriveEngineIdentity(
      { version: resolved.version },
      { ok: false, stdout: "" },
    );
  }
  // `import.meta.dir` and not cwd: the revision that matters is the ENGINE's,
  // and in PR mode the process is routinely pointed at a worktree of somebody
  // else's repository. Reading that repo's HEAD here would stamp a review with
  // the reviewed project's commit and quietly make the field a lie.
  const revision = await git(path.join(import.meta.dir, ".."), [
    "rev-parse",
    "--short",
    "HEAD",
  ]);
  return deriveEngineIdentity({ version: resolved.version }, revision);
}
