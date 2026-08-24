import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveEngineAssets } from "../src/assets";
import {
  type AgentsDirConfigSeat,
  resolveAgentsDirSetting,
} from "../src/preflight";
import { parseAgentSource } from "../src/prompt-set";

describe("resolveAgentsDirSetting with bundled prompts default", () => {
  test("with no flag, config, or env returns the bundled default with source 'default'", () => {
    const assets = resolveEngineAssets();
    const resolution = resolveAgentsDirSetting({
      cwd: "/some/arbitrary/repo",
    });

    expect(resolution.source).toBe("default");
    // In dev mode defaultAgentsDir is resolved, or points to assets defaultAgentsDir
    expect(resolution.dir).toBe(assets.defaultAgentsDir ?? "");
  });

  test("precedence: flag > config > env > default", () => {
    const seat: AgentsDirConfigSeat = {
      value: "./prompts",
      layer: "repo",
      dir: "/repo/.prhero",
    };

    // Flag beats everything
    expect(
      resolveAgentsDirSetting({
        flag: "/custom/agents",
        config: seat,
        env: "/env/agents",
        cwd: "/cwd",
      }),
    ).toEqual({
      dir: "/custom/agents",
      source: "flag",
    });

    // Config beats env and default
    expect(
      resolveAgentsDirSetting({
        config: seat,
        env: "/env/agents",
        cwd: "/cwd",
      }),
    ).toEqual({
      dir: "/repo/.prhero/prompts",
      source: "repo",
    });

    // Env beats default
    expect(
      resolveAgentsDirSetting({
        env: "./from-env",
        cwd: "/cwd",
      }),
    ).toEqual({
      dir: "/cwd/from-env",
      source: "env",
    });
  });
});

describe("Repo hygiene and O-15 productization scan", () => {
  test("no runtime source file in src/ references SUGGESTED_AGENTS_DIR or /Users/juanma", () => {
    const srcDir = path.resolve(import.meta.dir, "../src");
    const srcFiles = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

    for (const file of srcFiles) {
      const content = readFileSync(path.join(srcDir, file), "utf-8");
      expect(content).not.toContain("SUGGESTED_AGENTS_DIR");
      expect(content).not.toContain("/Users/juanma");
    }
  });

  test("O-15 scan over prompts/default/ has zero forbidden mentions in name/body", () => {
    const defaultDir = path.resolve(import.meta.dir, "../prompts/default");
    const files = readdirSync(defaultDir).filter(
      (f) => f.endsWith(".md") && f !== "PROVENANCE.md",
    );

    expect(files.length).toBe(5);

    const forbiddenPatterns = [
      /deep-review/i,
      /hunting-map/i,
      /golden/i,
      /\/Users\//i,
    ];

    for (const file of files) {
      const raw = readFileSync(path.join(defaultDir, file), "utf-8");
      const parsed = parseAgentSource(raw);

      // Check frontmatter name and description
      for (const pattern of forbiddenPatterns) {
        expect(parsed.name).not.toMatch(pattern);
        expect(parsed.description).not.toMatch(pattern);
        expect(parsed.body).not.toMatch(pattern);
      }
    }
  });
});
