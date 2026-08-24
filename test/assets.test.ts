import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { resolveEngineAssets, selfInvocation } from "../src/assets";
import { localReviewSpec } from "../src/preflight";

describe("resolveEngineAssets", () => {
  test("returns populated assets in dev mode with existing paths", () => {
    const assets = resolveEngineAssets();
    expect(assets.mode).toBe("dev");
    expect(assets.version).toBeDefined();
    expect(assets.version.length).toBeGreaterThan(0);

    // Scout and summarizer paths exist
    expect(existsSync(assets.scoutPromptPath)).toBe(true);
    expect(existsSync(assets.summarizerPromptPath)).toBe(true);

    // Bundled agent files all exist on disk
    expect(Object.keys(assets.bundledAgentFiles).length).toBe(5);
    for (const [logicalName, filePath] of Object.entries(
      assets.bundledAgentFiles,
    )) {
      expect(typeof logicalName).toBe("string");
      expect(existsSync(filePath)).toBe(true);
    }

    // Triage skill files all exist on disk
    expect(Object.keys(assets.triageSkillFiles).length).toBe(2);
    for (const [logicalName, filePath] of Object.entries(
      assets.triageSkillFiles,
    )) {
      expect(typeof logicalName).toBe("string");
      expect(existsSync(filePath)).toBe(true);
    }

    // defaultAgentsDir is populated in dev mode and points to existing directory
    expect(assets.defaultAgentsDir).toBeDefined();
    expect(existsSync(assets.defaultAgentsDir ?? "")).toBe(true);
  });

  test("manifest <-> prompts/default/ parity (build-time bidirectional check)", () => {
    const assets = resolveEngineAssets();
    const defaultDir = path.resolve(import.meta.dir, "../prompts/default");
    expect(existsSync(defaultDir)).toBe(true);

    const onDiskEntries = readdirSync(defaultDir).filter((file) => {
      // PROVENANCE.md and directories or non-md files are not agent files
      return file.endsWith(".md") && file !== "PROVENANCE.md";
    });

    const manifestEntries = Object.keys(assets.bundledAgentFiles);

    // Assert parity in both directions
    const missingInManifest = onDiskEntries.filter(
      (f) => !manifestEntries.includes(f),
    );
    const missingOnDisk = manifestEntries.filter(
      (f) => !onDiskEntries.includes(f),
    );

    expect(missingInManifest).toEqual([]);
    expect(missingOnDisk).toEqual([]);
    expect(manifestEntries.sort()).toEqual(onDiskEntries.sort());
  });

  test("manifest-loaded set satisfies localReviewSpec() (all five logical names, nothing extra)", () => {
    const assets = resolveEngineAssets();
    const spec = localReviewSpec();
    const specFiles = spec.agents.map((a) => a.file).sort();
    const manifestFiles = Object.keys(assets.bundledAgentFiles).sort();

    expect(manifestFiles).toEqual(specFiles);
  });
});

describe("selfInvocation", () => {
  test("returns absolute bun binary and absolute cli.ts in dev mode", () => {
    const inv = selfInvocation();
    expect(inv.command).toBe(process.execPath);
    expect(path.isAbsolute(inv.command)).toBe(true);
    expect(inv.args).toHaveLength(1);
    expect(inv.args[0]).toBe(path.resolve(import.meta.dir, "../src/cli.ts"));
    expect(existsSync(inv.args[0])).toBe(true);
  });
});
