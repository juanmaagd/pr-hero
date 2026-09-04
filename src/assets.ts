// Authority for packaged-asset resolution and self-invocation.
// Single authority across dev, npm, and compiled runtimes.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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
