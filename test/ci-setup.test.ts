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
import { DEFAULT_PIPELINE_TIMEOUT_MS } from "../src/pipeline";
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

  test("wires BOTH documented credential inputs, not just the API key", () => {
    // The `with:` comment tells the reader to provide EITHER secret. A repo
    // that follows it and sets only CLAUDE_CODE_OAUTH_TOKEN used to send an
    // empty credential and never authenticate, while `pr-hero doctor` — which
    // accepts either variable — reported a healthy CI configuration. Silent
    // auth failure behind a green diagnostic; the template has to pass the
    // path it documents.
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      jobs: { review: { steps: Array<Record<string, unknown>> } };
    };
    const step = parsed.jobs.review.steps.find(
      (s) => s.uses === "juanmaagd/pr-hero@v1",
    ) as { with?: Record<string, string> } | undefined;
    expect(step?.with?.["anthropic-api-key"]).toBe(
      `\${{ secrets.ANTHROPIC_API_KEY }}`,
    );
    expect(step?.with?.["claude-token"]).toBe(
      `\${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`,
    );
  });

  test("a secretless same-repo PR gets a LOUD notice, not a silent skip", () => {
    // The defect this pins is not hypothetical: this repo shipped five PRs
    // (D1-09, D1-03, D1-06, credential-projection, D1-07) whose review job
    // was skipped for missing credentials. A skipped job does not fail its
    // workflow, so `gh run list` reported "success" on every one and nobody
    // noticed the engine had never reviewed its own code. Silence read as
    // approval. The skip itself is correct — a permanent red X before
    // credentials are wired teaches people to stop reading CI — so the fix is
    // to make the skip SAY something, not to make it fail.
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      jobs: {
        credentials: { steps: Array<Record<string, string>> };
      };
    };
    const notice = parsed.jobs.credentials.steps.find(
      (step) => step.id === "notice",
    );
    expect(notice).toBeDefined();
    // Gated on BOTH conditions: fork PRs never receive secrets by design, so
    // a notice on every fork PR would be noise. The actionable case is a
    // same-repo PR whose owner simply has not wired a secret yet.
    expect(notice?.if).toContain("has_creds == 'false'");
    expect(notice?.if).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    // Both surfaces: an annotation on the run AND a line in the job summary.
    expect(notice?.run).toContain("::notice");
    expect(notice?.run).toContain("GITHUB_STEP_SUMMARY");
    // It must name the fix, not just the symptom.
    expect(notice?.run).toContain("claude setup-token");
  });

  test("EVERY job is bounded, not just the one that spends money", () => {
    // A bound on `review` alone does not deliver the hung-runner protection
    // its own comment claims. `credentials` runs FIRST and gates `review`
    // through `needs:`, on the same class of shared ephemeral runners — so a
    // runner that hangs there falls back to the GitHub default of 360
    // minutes and stalls the whole workflow for six hours, with `review`
    // never starting. Bounding the expensive job and leaving the gate
    // unbounded protects the budget, not the pipeline.
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      jobs: Record<string, { "timeout-minutes"?: number }>;
    };
    const names = Object.keys(parsed.jobs);
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) {
      expect(typeof parsed.jobs[name]?.["timeout-minutes"]).toBe("number");
    }
  });

  test("the notice script never lets bash run a backtick as a command", () => {
    // Backticks inside a DOUBLE-quoted bash string are command substitution,
    // not literal text. The notice body documents `gh run rerun` in prose, so
    // an echo that wrapped it in double quotes would actually invoke gh on the
    // runner and fail the step that exists to explain a failure. Every line
    // carrying a backtick must be single-quoted.
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      jobs: { credentials: { steps: Array<Record<string, string>> } };
    };
    const script =
      parsed.jobs.credentials.steps.find((step) => step.id === "notice")?.run ??
      "";
    expect(script).toContain("`");
    for (const line of script.split("\n")) {
      if (!line.includes("`")) continue;
      expect(line.trim()).toMatch(/^echo '/);
    }
  });

  test("the review job is bounded ABOVE the pipeline's own ceiling", () => {
    // DEFAULT_PIPELINE_TIMEOUT_MS is 75 minutes (src/pipeline.ts). A CI
    // timeout at or below that steals the salvage path: GitHub kills the job
    // before the pipeline's own ceiling can fire, close its artifacts and
    // report. The CI bound is a backstop for a HUNG runner, not a second
    // review budget — so it sits above the internal one with room for
    // checkout and action setup.
    const parsed = Bun.YAML.parse(generateCiWorkflowTemplate()) as {
      jobs: { review: { "timeout-minutes"?: number } };
    };
    const ceiling = parsed.jobs.review["timeout-minutes"];
    expect(typeof ceiling).toBe("number");
    expect(ceiling as number).toBeGreaterThan(
      DEFAULT_PIPELINE_TIMEOUT_MS / 60_000,
    );
  });

  test("the OAuth comment names setup-token, the only token that survives CI", () => {
    // Two different credentials wear the name "Claude OAuth token" and only
    // one works here. `claude setup-token` mints a long-lived (~1 year)
    // token meant for headless use; the `/login` session token in the
    // keychain expires in HOURS and is silently rotated by the CLI's refresh
    // token, which CI does not have. A reader who extracts the session token
    // gets a secret that works for a day and then breaks CI with no signal.
    // The template is where that distinction has to be stated, because it is
    // what the reader has open when they choose.
    const template = generateCiWorkflowTemplate();
    expect(template).toContain("claude setup-token");
    expect(template).toMatch(
      /never .*\/login|not the .*\/login|\/login.*expires/i,
    );
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
  // Both "local repo context" tests inject `env: {}` explicitly. Without it
  // `runDoctor` falls back to the real `process.env`, and the CI check is the
  // one check in the report whose severity is decided BY the environment — so
  // these two would assert one thing on a developer laptop and another inside
  // a GitHub Actions runner, where `GITHUB_ACTIONS=true` is always set and the
  // secrets this check looks for are not.
  //
  // Verified, not theorised: `GITHUB_ACTIONS=true bun test test/ci-setup.test.ts`
  // failed both of these before the injection was added. That matters now that
  // .github/workflows/ci.yml runs this suite on every pull request — a gate
  // that goes red for a reason unrelated to any defect is how a team learns to
  // ignore the gate. A test that asserts on the environment has to supply it.
  test("local repo context: healthy when a CI workflow is configured", async () => {
    const report = await runDoctor({
      cwd: "/repo",
      repoRoot: "/repo",
      home: "/home/user",
      exists: (p) => p === path.join("/repo", CI_WORKFLOW_RELATIVE_PATH),
      readFile: () => undefined,
      checkToolsOptions: { env: {} },
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
      checkToolsOptions: { env: {} },
    });
    const ciCheck = report.checks.find((c) => c.name === "ci");
    expect(ciCheck?.severity).toBe("degraded");
    expect(ciCheck?.hint).toMatch(/setup --ci|ci init/);
  });

  test("generic non-GitHub CI (CI=true) is degraded, never blocking", async () => {
    // `CI=true` is the near-universal convention — GitLab, CircleCI, Jenkins,
    // Travis, Buildkite, and plenty of container builds all set it. The
    // secrets this check looks for (GITHUB_TOKEN plus Anthropic/Claude auth)
    // only ever exist inside a GitHub Actions job, so on any of those it found
    // nothing, marked the check blocking, and flipped report.overall — which
    // makes `pr-hero upgrade --reconcile` push an error and exit 1, and a bare
    // `pr-hero doctor` exit 1, on a machine where nothing is wrong.
    const report = await runDoctor({
      cwd: "/repo",
      repoRoot: "/repo",
      home: "/home/user",
      exists: () => false,
      readFile: () => undefined,
      checkToolsOptions: { env: { CI: "true" } },
    });
    const ciCheck = report.checks.find((c) => c.name === "ci");
    expect(ciCheck?.severity).toBe("degraded");
    // And it is asked the question a non-GitHub machine can actually answer:
    // "do you have a workflow?", not "where are your GitHub Actions secrets?"
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
