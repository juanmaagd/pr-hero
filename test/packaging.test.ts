import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { generateCiWorkflowTemplate } from "../src/ci-setup";

describe("Packaging & distribution configuration", () => {
  const rootDir = path.resolve(__dirname, "..");

  test("root LICENSE file exists and is Apache-2.0", () => {
    const licensePath = path.join(rootDir, "LICENSE");
    expect(existsSync(licensePath)).toBe(true);
    const content = readFileSync(licensePath, "utf-8");
    expect(content).toContain("Apache License");
    expect(content).toContain("Version 2.0");
  });

  test("package.json declares Apache-2.0 license and correct distribution metadata", () => {
    const pkgPath = path.join(rootDir, "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);

    expect(pkg.private).toBe(false);
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.engines).toBeDefined();
    expect(pkg.engines.bun).toBeDefined();
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin["pr-hero"]).toBeDefined();
    expect(pkg.files).toBeDefined();
    expect(pkg.files).toContain("prompts");
    expect(pkg.files).toContain("skills/pr-hero-triage");
    expect(pkg.files).toContain("skills/pr-hero-ci-setup");
    expect(pkg.files).toContain("dist");
    expect(pkg.files).not.toContain("docs");
    expect(pkg.files).not.toContain("scripts");
    expect(pkg.files).not.toContain("fixtures");
    expect(pkg.files).not.toContain("test");
    expect(pkg.files).not.toContain("openspec");
    expect(pkg.files).not.toContain("skills/martian-bench");
    expect(pkg.scripts.build).toBeDefined();
  });

  test("bin/pr-hero.js exists and is an executable wrapper", () => {
    const binPath = path.join(rootDir, "bin", "pr-hero.js");
    expect(existsSync(binPath)).toBe(true);
    const content = readFileSync(binPath, "utf-8");
    expect(content).toContain("#!/usr/bin/env bun");
    expect(content).toContain("cli.ts");
  });

  // Regression guard: bin/pr-hero.js is reached via `import`, where
  // `import.meta.main` is always false inside the imported cli.ts module —
  // only the directly executed entry file gets `true`. A version of
  // bin/pr-hero.js that relies on cli.ts's own `if (import.meta.main)` guard
  // (instead of explicitly calling an exported runCli()/main()) silently
  // produces zero output on both streams and exits 0 for every invocation —
  // the npm-installed `pr-hero` command would do nothing at all. This spawns
  // the real bin/pr-hero.js as a local subprocess of THIS repo's own CLI
  // (no network access, no agent spawn — `--help` is fully offline) and
  // asserts it actually ran.
  test("bin/pr-hero.js, spawned directly, runs the real CLI instead of silently no-op'ing (import.meta.main-under-import regression)", async () => {
    const proc = Bun.spawn(["bun", "bin/pr-hero.js", "--help"], {
      cwd: rootDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      console.error(stdout, stderr);
    }
    // log() writes to stderr unconditionally (src/ui.ts) — assert there, not stdout.
    expect(stderr.length).toBeGreaterThan(0);
    expect(stderr).toContain("pr-hero");
    expect(stderr).toContain("Usage:");
    expect(exitCode).toBe(0);
  });

  test("install.sh exists, contains OS detection, checksum verification and PATH setup", () => {
    const scriptPath = path.join(rootDir, "install.sh");
    expect(existsSync(scriptPath)).toBe(true);
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("darwin");
    expect(content).toContain("linux");
    expect(content).toContain("SHA256SUMS");
    expect(content).toContain(".prhero/bin");
  });

  test("release workflow exists and defines matrix and artifacts", () => {
    const workflowPath = path.join(
      rootDir,
      ".github",
      "workflows",
      "release.yml",
    );
    expect(existsSync(workflowPath)).toBe(true);
    const content = readFileSync(workflowPath, "utf-8");
    expect(content).toContain("darwin-arm64");
    expect(content).toContain("darwin-x64");
    expect(content).toContain("linux-x64");
    expect(content).toContain("linux-arm64");
    expect(content).toContain("SHA256SUMS");
    expect(content).toContain("--provenance");
  });

  // Until this workflow existed, .github/workflows/ held only release.yml:
  // nothing ran this repo's own suite on a pull request, so every merge to
  // main was verified by whoever happened to run the gates by hand. These
  // assertions exist so a future edit cannot quietly drop one of the three.
  test("ci workflow runs all three gates on pull requests", () => {
    const workflowPath = path.join(rootDir, ".github", "workflows", "ci.yml");
    expect(existsSync(workflowPath)).toBe(true);
    const content = readFileSync(workflowPath, "utf-8");
    expect(content).toContain("pull_request");
    expect(content).toContain("bun install --frozen-lockfile");
    expect(content).toContain("bun test");
    expect(content).toContain("bun run typecheck");
  });

  // The scar this assertion guards: `bunx biome` resolves to an unrelated
  // abandoned package that ignores the flags, checks nothing, and exits 0.
  // docs/research/scout-design.md:344 records the CI gate sitting green for 18 days on
  // exactly that while real Biome found 10 errors over the same commit. A
  // linter that always passes is worse than no linter, because it is trusted.
  test("ci workflow invokes the real biome binary, never the bunx shim", () => {
    const workflowPath = path.join(rootDir, ".github", "workflows", "ci.yml");
    const content = readFileSync(workflowPath, "utf-8");
    expect(content).toContain("./node_modules/.bin/biome check src test");

    // Comments are stripped before the negative assertion on purpose: the
    // workflow SHOULD name the antipattern to explain why the long path is
    // there, and a whole-file substring check would make documenting the
    // hazard indistinguishable from committing it.
    const commands = content
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(commands).not.toContain("bunx biome");
  });

  describe("action.yml — the official Composite Action (Pillar 3 task 5.1)", () => {
    const actionPath = path.join(rootDir, "action.yml");

    function parsedAction(): {
      inputs: Record<string, { default?: string; required: boolean }>;
      outputs: Record<string, { description: string; value: string }>;
      runs: { using: string; steps: Array<Record<string, unknown>> };
    } {
      return Bun.YAML.parse(readFileSync(actionPath, "utf-8")) as never;
    }

    test("exists and is syntactically valid YAML", () => {
      expect(existsSync(actionPath)).toBe(true);
      const parsed = Bun.YAML.parse(readFileSync(actionPath, "utf-8"));
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");
    });

    test("declares the four-member status enum spec 1.1 actually emits", () => {
      // Not five: skipped-clean was never wired (a clean review already
      // reports status=reviewed, findings_count=0) and was dropped from
      // spec.md 1.1 rather than left as a documented lie. `error` IS now
      // wired, via reportFatalCiError (src/cli.ts).
      const action = parsedAction();
      expect(action.outputs.status.description).toContain(
        "reviewed, skipped-size, skipped-budget, or error",
      );
    });

    test("every `with:` key the generated workflow emits is a declared input", () => {
      // The drift this guards is not hypothetical: the template's `with:`
      // block told readers to set EITHER ANTHROPIC_API_KEY or
      // CLAUDE_CODE_OAUTH_TOKEN and wired only the first, so the documented
      // OAuth path sent an empty credential and never authenticated — while
      // `pr-hero doctor`, which accepts either variable, called the setup
      // healthy. A `with:` key with no matching input is silently ignored by
      // GitHub Actions; nothing else in this repo would notice.
      const declared = Object.keys(parsedAction().inputs);
      const workflow = Bun.YAML.parse(
        generateCiWorkflowTemplate({ actionRef: "./" }),
      ) as {
        jobs: {
          review: {
            steps: Array<{ uses?: string; with?: Record<string, string> }>;
          };
        };
      };
      // Select the pr-hero step BY its `uses`, rather than subtracting the
      // third-party keys we happen to know about today. The subtraction form
      // of this test (an exclusion list holding just `fetch-depth`) went red
      // the moment a second third-party step — actions/upload-artifact —
      // joined the job, though nothing about pr-hero's own inputs had
      // changed. Only the keys handed to OUR action can drift from
      // action.yml, so those are the only ones this should look at.
      const ours = workflow.jobs.review.steps.flatMap((step) =>
        step.uses === "./" && step.with !== undefined
          ? Object.keys(step.with)
          : [],
      );
      expect(ours.length).toBeGreaterThan(0);
      for (const key of ours) {
        expect(declared).toContain(key);
      }
      // And both credential paths are actually wired, not just declared.
      expect(ours).toContain("anthropic-api-key");
      expect(ours).toContain("claude-token");
    });

    test("run step invokes bin/pr-hero.js — the entrypoint verified to actually run", () => {
      const action = parsedAction();
      const runStep = action.runs.steps.find(
        (step) => step.id === "run-pr-hero",
      ) as { run?: string } | undefined;
      expect(runStep?.run).toContain("bin/pr-hero.js");
    });

    test("passes --ci unconditionally (--budget-usd/--step-summary require it at parse time)", () => {
      const action = parsedAction();
      const runStep = action.runs.steps.find(
        (step) => step.id === "run-pr-hero",
      ) as { run?: string } | undefined;
      expect(runStep?.run).toContain("--ci");
      expect(runStep?.run).toContain("--yes");
    });

    test("never interpolates a free-text input directly into the shell script body", () => {
      // Every input / github-context value the run step needs must be
      // routed through `env:` and referenced as a shell variable — see the
      // step's own header comment. github.action_path is GitHub-controlled
      // (safe to interpolate directly); nothing else should appear as a raw
      // `${{ ... }}` expression inside the run script's own TEXT (as opposed
      // to the step's `env:` mapping, where binding them is exactly right).
      const action = parsedAction();
      const runStep = action.runs.steps.find(
        (step) => step.id === "run-pr-hero",
      ) as { run?: string } | undefined;
      const script = runStep?.run ?? "";
      const interpolations = script.match(/\$\{\{[^}]*\}\}/g) ?? [];
      expect(interpolations.length).toBeGreaterThan(0);
      for (const token of interpolations) {
        expect(token).toContain("github.action_path");
      }
    });

    test("never embeds a secret value — references secrets by name only", () => {
      const raw = readFileSync(actionPath, "utf-8");
      expect(raw).not.toMatch(/sk-ant-|ghp_|ghs_/);
    });
  });

  test("committed .github/workflows/pr-hero.yml never drifts from generateCiWorkflowTemplate()", () => {
    // This repo's own canonical example workflow is generated by, not
    // hand-copied from, ci-setup.ts's generateCiWorkflowTemplate() — the same
    // function `pr-hero setup --ci` / `pr-hero ci init` runs for any caller
    // repo. A byte-for-byte equality assertion is the only thing standing
    // between the two ever silently diverging.
    const workflowPath = path.join(
      rootDir,
      ".github",
      "workflows",
      "pr-hero.yml",
    );
    expect(existsSync(workflowPath)).toBe(true);
    const committed = readFileSync(workflowPath, "utf-8");
    expect(committed).toBe(generateCiWorkflowTemplate({ actionRef: "./" }));
  });

  test("skills/pr-hero-ci-setup/assets/workflow.yml never drifts from generateCiWorkflowTemplate()", () => {
    const assetPath = path.join(
      rootDir,
      "skills",
      "pr-hero-ci-setup",
      "assets",
      "workflow.yml",
    );
    expect(existsSync(assetPath)).toBe(true);
    const assetContent = readFileSync(assetPath, "utf-8");
    expect(assetContent).toBe(generateCiWorkflowTemplate());
  });

  // A consumer repo has no copy of this action's source, so it must resolve
  // the published tag. This repo DOES have the source — and resolving a tag
  // that does not exist yet would paint every PR here permanently red, which
  // is strictly worse than no check at all: a red that can never go green
  // teaches everyone to stop reading it. `./` runs the action.yml sitting in
  // the checked-out tree, which is also the only form that actually tests the
  // action being changed in the PR that changes it.
  test("the default action ref targets the published tag for consumer repos", () => {
    expect(generateCiWorkflowTemplate()).toContain(
      "uses: juanmaagd/pr-hero@v1",
    );
  });

  test("this repo's own workflow runs the local action, not an unpublished tag", () => {
    const own = generateCiWorkflowTemplate({ actionRef: "./" });
    expect(own).toContain("uses: ./");
    expect(own).not.toContain("juanmaagd/pr-hero@v1");
  });

  test("build script produces standalone bundle without error", async () => {
    const proc = Bun.spawn(["bun", "run", "build"], {
      cwd: rootDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      console.error(stdout, stderr);
    }
    expect(exitCode).toBe(0);

    const distCliPath = path.join(rootDir, "dist", "cli.js");
    expect(existsSync(distCliPath)).toBe(true);
  });
});
