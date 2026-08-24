// Phase 4 (Pillar 3, ROADMAP THE LAUNCH LINE): CI workflow scaffolding +
// doctor CI diagnostics.
//
// Offline only: generateCiWorkflowTemplate is pure and asserted with Bun's
// built-in YAML parser (Bun.YAML.parse — no new dependency); runCiSetup
// touches only an mkdtemp fixture, the same pattern test/ci-reporter.test.ts
// uses for its impure edge functions; doctor's CI check is exercised through
// fully injected exists/env, never real process.env, network, or spawn.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CI_WORKFLOW_RELATIVE_PATH,
  generateCiWorkflowTemplate,
  runCiSetup,
} from "../src/ci-setup";
import { runDoctor } from "../src/doctor";
import { parseArgs } from "../src/preflight";
import { checkCiConfiguration } from "../src/system-tools";

describe("generateCiWorkflowTemplate (pure)", () => {
  test("produces syntactically valid YAML", () => {
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate());
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe("object");
  });

  test("triggers on pull_request opened/synchronize/reopened", () => {
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      on: { pull_request: { types: string[] } };
    };
    expect(parsed.on.pull_request.types).toEqual([
      "opened",
      "synchronize",
      "reopened",
    ]);
  });

  test("grants pull-requests: write and contents: read", () => {
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      permissions: Record<string, string>;
    };
    expect(parsed.permissions["pull-requests"]).toBe("write");
    expect(parsed.permissions.contents).toBe("read");
  });

  test("checks out with fetch-depth: 0", () => {
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      jobs: { review: { steps: Array<Record<string, unknown>> } };
    };
    const checkoutStep = parsed.jobs.review.steps.find(
      (step) => step.uses === "actions/checkout@v4",
    ) as { with?: { "fetch-depth"?: number } } | undefined;
    expect(checkoutStep?.with?.["fetch-depth"]).toBe(0);
  });

  test("explains WHY fetch-depth: 0 is required, not merely that it is set", () => {
    const template = generateCiWorkflowTemplate();
    expect(template).toMatch(/fetch-depth: 0 is load-bearing/i);
  });

  test("invokes the official composite action", () => {
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      jobs: { review: { steps: Array<Record<string, unknown>> } };
    };
    const usesValues = parsed.jobs.review.steps.map((step) => step.uses);
    expect(usesValues).toContain("juanmaagd/pr-hero@v1");
  });

  test("never embeds a secret value — references secrets by name only", () => {
    const template = generateCiWorkflowTemplate();
    expect(template).toContain(`\${{ secrets.ANTHROPIC_API_KEY }}`);
    expect(template).toContain(`\${{ secrets.GITHUB_TOKEN }}`);
    expect(template).not.toMatch(/sk-ant-[a-z0-9-]+/i);
  });

  test("is deterministic — calling it twice returns byte-identical output", () => {
    expect(generateCiWorkflowTemplate()).toBe(generateCiWorkflowTemplate());
  });
});

describe("runCiSetup (impure edge)", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("creates .github/workflows/pr-hero.yml when absent", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-setup-"));

    const result = await runCiSetup({ cwd: dir });

    expect(result.status).toBe("created");
    const written = await readFile(
      path.join(dir, CI_WORKFLOW_RELATIVE_PATH),
      "utf8",
    );
    expect(written).toBe(generateCiWorkflowTemplate());
  });

  test("refuses to overwrite an existing workflow without --force", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-setup-"));
    const target = path.join(dir, CI_WORKFLOW_RELATIVE_PATH);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "# a user's customized workflow\n");

    const result = await runCiSetup({ cwd: dir });

    expect(result.status).toBe("skipped-existing");
    const stillThere = await readFile(target, "utf8");
    expect(stillThere).toBe("# a user's customized workflow\n");
  });

  test("overwrites the existing workflow when --force is passed", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ci-setup-"));
    const target = path.join(dir, CI_WORKFLOW_RELATIVE_PATH);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "# a user's customized workflow\n");

    const result = await runCiSetup({ cwd: dir, force: true });

    expect(result.status).toBe("overwritten");
    const written = await readFile(target, "utf8");
    expect(written).toBe(generateCiWorkflowTemplate());
  });
});

describe("checkCiConfiguration (pure diagnostic, system-tools.ts)", () => {
  test("local context: configured true when the workflow file exists", () => {
    const status = checkCiConfiguration({
      cwd: "/repo",
      isCi: false,
      exists: (p) => p === path.join("/repo", CI_WORKFLOW_RELATIVE_PATH),
    });
    expect(status.configured).toBe(true);
  });

  test("local context: configured false with a setup hint when absent", () => {
    const status = checkCiConfiguration({
      cwd: "/repo",
      isCi: false,
      exists: () => false,
    });
    expect(status.configured).toBe(false);
    expect(status.hint).toMatch(/setup --ci|ci init/);
  });

  test("GitHub Actions context: configured true when GITHUB_TOKEN and an Anthropic/Claude credential are present", () => {
    const status = checkCiConfiguration({
      isCi: true,
      env: {
        GITHUB_TOKEN: "ghs_realtoken",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth_realtoken",
      },
    });
    expect(status.configured).toBe(true);
  });

  test("GitHub Actions context: accepts ANTHROPIC_API_KEY as the alternative credential", () => {
    const status = checkCiConfiguration({
      isCi: true,
      env: {
        GITHUB_TOKEN: "ghs_realtoken",
        ANTHROPIC_API_KEY: "sk-ant-realkey",
      },
    });
    expect(status.configured).toBe(true);
  });

  test("GitHub Actions context: names the missing secret without ever echoing a present value", () => {
    const status = checkCiConfiguration({
      isCi: true,
      env: { GITHUB_TOKEN: "ghs_realtoken12345" },
    });
    expect(status.configured).toBe(false);
    expect(status.message).toContain("ANTHROPIC_API_KEY");
    expect(status.message).not.toContain("ghs_realtoken12345");
  });

  test("GitHub Actions context: reports both secrets missing distinctly", () => {
    const status = checkCiConfiguration({ isCi: true, env: {} });
    expect(status.configured).toBe(false);
    expect(status.message).toContain("GITHUB_TOKEN");
    expect(status.message).toContain("ANTHROPIC_API_KEY");
  });
});

describe("doctor CI diagnostics (Pillar 3)", () => {
  test("local repo context: healthy when a CI workflow is configured", async () => {
    const report = await runDoctor({
      cwd: "/repo",
      repoRoot: "/repo",
      home: "/home/user",
      exists: (p) => p === path.join("/repo", CI_WORKFLOW_RELATIVE_PATH),
      readFile: () => undefined,
    });
    const ciCheck = report.checks.find((c) => c.name === "ci");
    expect(ciCheck?.severity).toBe("healthy");
  });

  test("local repo context: degraded (not blocking) when no CI workflow is configured", async () => {
    const report = await runDoctor({
      cwd: "/repo",
      repoRoot: "/repo",
      home: "/home/user",
      exists: () => false,
      readFile: () => undefined,
    });
    const ciCheck = report.checks.find((c) => c.name === "ci");
    expect(ciCheck?.severity).toBe("degraded");
    expect(ciCheck?.hint).toMatch(/setup --ci|ci init/);
  });

  test("GitHub Actions context: healthy when required secrets are present", async () => {
    const report = await runDoctor({
      cwd: "/repo",
      home: "/home/user",
      exists: () => false,
      readFile: () => undefined,
      checkToolsOptions: {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_TOKEN: "ghs_realtoken",
          ANTHROPIC_API_KEY: "sk-ant-realkey",
        },
      },
    });
    const ciCheck = report.checks.find((c) => c.name === "ci");
    expect(ciCheck?.severity).toBe("healthy");
  });

  test("GitHub Actions context: blocking when a required secret is missing, and never echoes any value", async () => {
    const report = await runDoctor({
      cwd: "/repo",
      home: "/home/user",
      exists: () => false,
      readFile: () => undefined,
      checkToolsOptions: {
        env: { GITHUB_ACTIONS: "true", GITHUB_TOKEN: "ghs_realtoken12345" },
      },
    });
    const ciCheck = report.checks.find((c) => c.name === "ci");
    expect(ciCheck?.severity).toBe("blocking");
    expect(ciCheck?.message).toContain("ANTHROPIC_API_KEY");
    expect(ciCheck?.message).not.toContain("ghs_realtoken12345");
    expect(report.overall).toBe("blocking");
  });
});

describe("CLI wiring: setup --ci and ci init (parseArgs)", () => {
  test("setup --ci parses with command=setup, options.ci=true", () => {
    const parsed = parseArgs(["setup", "--ci"]);
    expect(parsed.command).toBe("setup");
    expect(parsed.options.ci).toBe(true);
  });

  test("plain setup (no --ci) still parses — the interactive wizard path", () => {
    const parsed = parseArgs(["setup"]);
    expect(parsed.command).toBe("setup");
    expect(parsed.options.ci).toBeUndefined();
  });

  test("ci init parses with command=ci, options.ciSubcommand=init", () => {
    const parsed = parseArgs(["ci", "init"]);
    expect(parsed.command).toBe("ci");
    expect(parsed.options.ciSubcommand).toBe("init");
  });

  test("ci init --force parses with options.force=true", () => {
    const parsed = parseArgs(["ci", "init", "--force"]);
    expect(parsed.options.force).toBe(true);
  });

  test("bare ci with no subcommand is rejected", () => {
    expect(() => parseArgs(["ci"])).toThrow();
  });

  test("--ci still requires --pr on the review command (unchanged Phase 3 behavior)", () => {
    expect(() => parseArgs(["review", "--ci"])).toThrow(/--pr/);
  });

  test("--ci on a command other than review or setup is rejected", () => {
    expect(() => parseArgs(["doctor", "--ci"])).toThrow(
      /review or setup command/,
    );
  });
});
