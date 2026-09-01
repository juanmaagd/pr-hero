import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EngineAssets } from "../src/assets";
import { resolveEngineAssets } from "../src/assets";
import {
  type AgentsDirConfigSeat,
  agentFilePath,
  agentsDirProblems,
  BUNDLED_AGENTS_DIR_LABEL,
  localReviewSpec,
  resolveAgentsDirSetting,
} from "../src/preflight";
import { parseAgentSource, promptSetFingerprint } from "../src/prompt-set";

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
      kind: "dir",
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
      kind: "dir",
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
      kind: "dir",
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

describe("bundled prompts carry no tool-injected content", () => {
  // The prompt set is frozen from agent files that live under a developer's
  // `~/.claude/agents/`, where machine-local tooling appends its own guidance
  // as HTML-comment-delimited blocks. Those blocks name commands that exist
  // only on that developer's machine and would ship to every user inside the
  // npm package. A prompt is a system prompt and never needs an HTML comment,
  // so the guard forbids the delimiter itself: a freeze must strip such
  // blocks, and this keeps a future freeze from importing them again.
  test("no prompt file contains an HTML comment", () => {
    const promptsRoot = path.resolve(import.meta.dir, "../prompts");
    const files = readdirSync(promptsRoot, { recursive: true })
      .map(String)
      // PROVENANCE.md is the ledger, not a prompt: it describes what was
      // stripped and is never sent to a model.
      .filter((f) => f.endsWith(".md") && path.basename(f) !== "PROVENANCE.md")
      .sort();
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((f) =>
      readFileSync(path.join(promptsRoot, f), "utf8").includes("<!--"),
    );
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Compiled mode: the prompt set is a MAP, never a directory.
//
// The Bun-compiled binary embeds every prompt at a hashed, flattened path
// (`/$bunfs/root/review-refuter-qkhw7k00.md`), and three properties of that
// filesystem are load-bearing here: `existsSync("/$bunfs/root")` is FALSE,
// `Bun.Glob(...).scan({cwd:"/$bunfs/root"})` THROWS ENOENT rather than
// returning empty, and only `Bun.file(<embedded path>)` reads. So every
// directory-shaped access to the bundled set is broken in the shipped binary
// and unfixable by patching an existence check.
//
// These tests exist because `detectAssetMode()` reads `import.meta.dir`, which
// under `bun test` always reports "dev" — which is exactly why the whole suite
// stayed green while the shipped binary could not load a single prompt. The
// injected `assets` seam is the ONLY way this path is reachable offline.
// ---------------------------------------------------------------------------

const EMBEDDED_ROOT = "/$bunfs/root";

function compiledAssets(
  bundledAgentFiles: Record<string, string> = {
    "review-refuter.md": `${EMBEDDED_ROOT}/review-refuter-qkhw7k00.md`,
    "deep-review-parity.md": `${EMBEDDED_ROOT}/deep-review-parity-8f3ka100.md`,
    "deep-review-lifecycle.md": `${EMBEDDED_ROOT}/deep-review-lifecycle-p0zz2200.md`,
    "deep-review-resilience.md": `${EMBEDDED_ROOT}/deep-review-resilience-mm41xx00.md`,
    "deep-review-reliability.md": `${EMBEDDED_ROOT}/deep-review-reliability-7bq9dd00.md`,
  },
): EngineAssets {
  return {
    mode: "compiled",
    bundledAgentFiles,
    // What resolveEngineAssets() actually computes when compiled: the dirname
    // of an embedded path. It is not a directory that exists.
    defaultAgentsDir: EMBEDDED_ROOT,
    scoutPromptPath: `${EMBEDDED_ROOT}/scout-a1b2c300.md`,
    summarizerPromptPath: `${EMBEDDED_ROOT}/summarizer-d4e5f600.md`,
    triageSkillFiles: {},
    ciSetupSkillFiles: {},
    version: "9.9.9",
  };
}

describe("resolveAgentsDirSetting in compiled mode", () => {
  test("the default branch resolves to the bundled MAP, not a directory", () => {
    const assets = compiledAssets();
    const resolution = resolveAgentsDirSetting({
      cwd: "/some/arbitrary/repo",
      assets,
    });

    expect(resolution.source).toBe("default");
    expect(resolution.kind).toBe("bundled");
    expect(resolution.files).toEqual(assets.bundledAgentFiles);
  });

  test("the bundled dir is a display label and never leaks $bunfs", () => {
    // `dir` reaches the plan card, the config row and pipeline.json. A user
    // reading "/$bunfs/root" there learns nothing and cannot act on it, and an
    // artifact recording it names a path that exists on no machine.
    const resolution = resolveAgentsDirSetting({
      cwd: "/repo",
      assets: compiledAssets(),
    });

    expect(resolution.dir).toBe(BUNDLED_AGENTS_DIR_LABEL);
    expect(resolution.dir).not.toContain("$bunfs");
  });

  test("an explicit flag, config or env still resolves a real directory", () => {
    // Compiled mode changes only the DEFAULT. A user who points at their own
    // prompt set gets a directory in every runtime.
    const assets = compiledAssets();
    for (const resolution of [
      resolveAgentsDirSetting({ flag: "agents", cwd: "/work", assets }),
      resolveAgentsDirSetting({
        config: { value: "./prompts", layer: "repo", dir: "/repo/.prhero" },
        cwd: "/work",
        assets,
      }),
      resolveAgentsDirSetting({ env: "/from/env", cwd: "/work", assets }),
    ]) {
      expect(resolution.kind).toBe("dir");
      expect(resolution.files).toBeUndefined();
    }
  });
});

describe("agentFilePath", () => {
  test("a bundled resolution answers with the hashed embedded path", () => {
    const resolution = resolveAgentsDirSetting({
      cwd: "/repo",
      assets: compiledAssets(),
    });

    expect(agentFilePath(resolution, "review-refuter.md")).toBe(
      `${EMBEDDED_ROOT}/review-refuter-qkhw7k00.md`,
    );
  });

  test("a dir resolution joins, exactly as before", () => {
    expect(
      agentFilePath({ kind: "dir", dir: "/abs/agents" }, "review-refuter.md"),
    ).toBe("/abs/agents/review-refuter.md");
  });

  test("a logical name the manifest never embedded throws, naming the file", () => {
    // A spec that references a prompt the build did not embed is a BUILD
    // defect. Falling back to a join would produce
    // "/$bunfs/root/deep-review-lifecycle.md" — a path that reads fine in an
    // error message and does not exist, sending the reader after a filesystem
    // bug instead of a manifest gap.
    const resolution = resolveAgentsDirSetting({
      cwd: "/repo",
      assets: compiledAssets({
        "review-refuter.md": `${EMBEDDED_ROOT}/review-refuter-qkhw7k00.md`,
      }),
    });

    expect(() => agentFilePath(resolution, "deep-review-lifecycle.md")).toThrow(
      /deep-review-lifecycle\.md/,
    );
  });
});

describe("the bundled set satisfies the spec without touching a filesystem", () => {
  test("agentsDirProblems is clean over the manifest's keys", () => {
    // The conformance check compares SETS bidirectionally, so manifest key
    // order is irrelevant here — unlike the fingerprint below, where it is
    // everything.
    const resolution = resolveAgentsDirSetting({
      cwd: "/repo",
      assets: compiledAssets(),
    });
    const spec = localReviewSpec();

    expect(
      agentsDirProblems(
        spec.agents.map((a) => a.file),
        Object.keys(resolution.files ?? {}),
      ),
    ).toEqual([]);
  });

  test("the fingerprint follows spec declaration order, not manifest key order", async () => {
    // `prompt_set.sha256` is compared ACROSS runs by an external consumer, and
    // promptSetFingerprint hashes the concatenated file texts in the order it
    // is handed. Reading the file list off the manifest's keys instead of the
    // spec's agents would move every fingerprint ever recorded — silently,
    // because the digest is still a valid-looking 16 hex chars.
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-embedded-"));
    const spec = localReviewSpec();
    const embedded: Record<string, string> = {};
    // Built in REVERSE spec order, with hashed basenames, so the two orders
    // provably differ and the assertion below cannot pass by coincidence.
    for (const agent of [...spec.agents].reverse()) {
      const hashed = path.join(
        dir,
        `${path.basename(agent.file, ".md")}-qkhw7k00.md`,
      );
      await Bun.write(hashed, `body of ${agent.file}\n`);
      embedded[agent.file] = hashed;
    }

    const resolution = resolveAgentsDirSetting({
      cwd: "/repo",
      assets: compiledAssets(embedded),
    });
    const specOrder = spec.agents.map((a) => a.file);
    expect(Object.keys(embedded)).not.toEqual(specOrder);

    const viaHelper = specOrder.map((file) => agentFilePath(resolution, file));
    expect(await promptSetFingerprint(viaHelper)).toBe(
      await promptSetFingerprint(
        specOrder.map((file) => embedded[file] as string),
      ),
    );
    expect(await promptSetFingerprint(viaHelper)).not.toBe(
      await promptSetFingerprint(Object.values(embedded)),
    );

    await rm(dir, { recursive: true, force: true });
  });
});
