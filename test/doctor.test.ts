import { describe, expect, test } from "bun:test";
import {
  type EngineAssets,
  resolveEngineAssets,
  selfInvocation,
} from "../src/assets";
import { CI_WORKFLOW_RELATIVE_PATH } from "../src/ci-setup";
import {
  type DoctorReport,
  PROVIDER_HINTS,
  renderDoctorReport,
  runDoctor,
} from "../src/doctor";
import type { ExactBindingCapabilityReport } from "../src/execution/contracts";
import { aliasCanonical } from "../src/model-catalog";
import { GOTCHAS_PLACEHOLDER_MARKER, GOTCHAS_TEMPLATE } from "../src/preflight";
import {
  PRICING_CATALOGS,
  PRICING_MAX_AGE_DAYS,
  type PricingCatalog,
} from "../src/pricing-catalog";
import { buildDoctorRoutePlan } from "../src/production-runtime";

// #137 made freshness per catalogue, so the tests need each table by name.
function bundledCatalog(provider: string): PricingCatalog {
  const catalog = PRICING_CATALOGS[provider];
  if (catalog === undefined) {
    throw new Error(`bundled pricing catalogue missing for "${provider}"`);
  }
  return catalog;
}

const ANTHROPIC_PRICING = bundledCatalog("anthropic");
const ZAI_PRICING = bundledCatalog("zai");

// The NEWEST stamp across every bundled table. A clock pinned to the oldest
// would leave a younger table reporting a negative age -- "-1 day(s) old" is
// not a thing doctor should ever print -- while still being fresh, so the
// all-healthy assertions would pass on nonsense output.
const NEWEST_FETCHED_AT = new Date(
  Math.max(
    ...Object.values(PRICING_CATALOGS).map((c) => Date.parse(c.fetched_at)),
  ),
);

// These fixtures fake the MACHINE's filesystem. The engine's own bundle is not
// on it — in a compiled binary the prompts live inside the executable — so a
// fixture saying "this machine has nothing" must not also be read as "the
// shipped prompt set is broken". Every fixture that is not specifically
// probing the bundle answers for it through this.
const BUNDLED_PROMPT_PATHS = new Set(
  Object.values(resolveEngineAssets().bundledAgentFiles),
);
const bundledPromptBody = (p: string): string | undefined =>
  BUNDLED_PROMPT_PATHS.has(p) ? "# bundled prompt\n" : undefined;

describe("doctor tri-state evaluation", () => {
  test("healthy when all checks pass", async () => {
    const self = selfInvocation();
    const report = await runDoctor({
      cwd: "/repo",
      home: "/home/user",
      // Pinned to the day the newest bundled pricing table was fetched.
      // Without this the assertion below ("every check is healthy") reads the
      // wall clock through the pricing-catalogue checks and turns red on the
      // calendar date a table crosses PRICING_MAX_AGE_DAYS — a failure with
      // no commit behind it. What this test is about is unchanged.
      now: () => NEWEST_FETCHED_AT,
      exists: (p) => {
        if (p === "/repo/.prhero/gotchas.md") return true;
        if (p === "/repo/.codegraph") return true;
        if (p === "/home/user/.prhero/setup.json") return true;
        if (p === "/home/user/.claude/mcp.json") return true;
        if (p.includes(".claude/skills/")) return true;
        if (p === `/repo/${CI_WORKFLOW_RELATIVE_PATH}`) return true;
        return false;
      },
      readFile: (p) => {
        if (p === "/repo/.prhero/gotchas.md")
          return "## Gotchas\nDo not mutate state.";
        if (p === "/home/user/.claude/mcp.json")
          return JSON.stringify({
            mcpServers: {
              "pr-hero": {
                command: self.command,
                args: [...self.args, "mcp"],
              },
            },
          });
        if (p.endsWith("digest.json")) {
          return JSON.stringify({
            files: {
              "SKILL.md": "mock_hash",
              "adjudicator.md": "mock_hash",
              "assets/workflow.yml": "mock_hash",
            },
          });
        }
        if (
          p.endsWith("SKILL.md") ||
          p.endsWith("adjudicator.md") ||
          p.endsWith("workflow.yml")
        ) {
          // If reading either the upstream asset or the synced copy, return the same content
          return "same mock content";
        }
        return bundledPromptBody(p);
      },
      checkToolsOptions: {
        which: (bin) =>
          ["git", "claude", "gh", "codegraph"].includes(bin)
            ? `/bin/${bin}`
            : null,
        exec: async (cmd) => {
          if (cmd.includes("git"))
            return { exitCode: 0, stdout: "git version 2.40.0", stderr: "" };
          if (cmd.includes("claude"))
            return { exitCode: 0, stdout: "1.0.0", stderr: "" };
          if (cmd.includes("gh"))
            return { exitCode: 0, stdout: "gh version 2.30.0", stderr: "" };
          if (cmd.includes("codegraph"))
            return { exitCode: 0, stdout: "codegraph 0.5.0", stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        env: { ANTHROPIC_API_KEY: "sk-test" },
      },
    });

    expect(report.overall).toBe("healthy");
    expect(report.exitCode).toBe(0);
    expect(report.checks.every((c) => c.severity === "healthy")).toBe(true);
  });

  describe("blocking cases (exitCode: 1)", () => {
    test("git missing is blocking", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) =>
          p === "/repo/.prhero/gotchas.md" ||
          p === "/home/user/.prhero/setup.json",
        readFile: () => "## Gotchas\nContent",
        checkToolsOptions: {
          which: (bin) => (bin === "git" ? null : `/bin/${bin}`),
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(report.overall).toBe("blocking");
      expect(report.exitCode).toBe(1);
      const gitCheck = report.checks.find((c) => c.name === "git");
      expect(gitCheck?.severity).toBe("blocking");
    });

    test("claude missing is blocking", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) =>
          p === "/repo/.prhero/gotchas.md" ||
          p === "/home/user/.prhero/setup.json",
        readFile: () => "## Gotchas\nContent",
        checkToolsOptions: {
          which: (bin) => (bin === "claude" ? null : `/bin/${bin}`),
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        },
      });

      expect(report.overall).toBe("blocking");
      expect(report.exitCode).toBe(1);
      const claudeCheck = report.checks.find((c) => c.name === "claude");
      expect(claudeCheck?.severity).toBe("blocking");
    });

    test("claude unauthenticated is blocking", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) =>
          p === "/repo/.prhero/gotchas.md" ||
          p === "/home/user/.prhero/setup.json",
        readFile: () => "## Gotchas\nContent",
        checkToolsOptions: {
          which: () => "/bin/tool",
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: {}, // no auth
        },
      });

      expect(report.overall).toBe("blocking");
      expect(report.exitCode).toBe(1);
      const claudeCheck = report.checks.find((c) => c.name === "claude");
      expect(claudeCheck?.severity).toBe("blocking");
    });

    test("stale agents_dir pointing at missing path is blocking with fallback hint", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => {
          if (p === "/repo/.prhero/config.json") return true;
          if (p === "/repo/.prhero/gotchas.md") return true;
          if (p === "/home/user/.prhero/setup.json") return true;
          return false;
        },
        readFile: (p) => {
          if (p === "/repo/.prhero/config.json") {
            return JSON.stringify({ agents_dir: "/missing/old/path" });
          }
          if (p === "/repo/.prhero/gotchas.md") return "## Gotchas\nContent";
          return undefined;
        },
        checkToolsOptions: {
          which: () => "/bin/tool",
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(report.overall).toBe("blocking");
      expect(report.exitCode).toBe(1);
      const agentsCheck = report.checks.find((c) => c.name === "agents_dir");
      expect(agentsCheck?.severity).toBe("blocking");
      expect(agentsCheck?.hint).toContain("Delete");
      expect(agentsCheck?.hint).toContain("bundled default");
    });

    test("missing or empty gotchas.md in current repo is blocking", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => p === "/home/user/.prhero/setup.json",
        readFile: () => "   ", // empty
        checkToolsOptions: {
          which: () => "/bin/tool",
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(report.overall).toBe("blocking");
      expect(report.exitCode).toBe(1);
      const gotchasCheck = report.checks.find((c) => c.name === "gotchas");
      expect(gotchasCheck?.severity).toBe("blocking");
    });

    // Without this, `doctor` and `review` disagree about the same file:
    // doctor prints "Repository gotchas present" and a green overall, then
    // the review the user runs on that advice refuses. A diagnostic whose
    // healthy verdict does not survive the next command is worse than no
    // diagnostic — the user believes the problem is elsewhere.
    test("a still-scaffolded gotchas.md is blocking, not 'present'", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) =>
          p === "/repo/.prhero/gotchas.md" ||
          p === "/home/user/.prhero/setup.json",
        readFile: (p) =>
          p === "/repo/.prhero/gotchas.md" ? GOTCHAS_TEMPLATE : undefined,
        checkToolsOptions: {
          which: () => "/bin/tool",
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      // Deliberately NOT asserting report.overall/exitCode here: this fixture
      // resolves no agents_dir, so `overall` is already "blocking" for an
      // unrelated reason and would pass whatever the gotchas check said. Only
      // the gotchas check itself discriminates.
      const gotchasCheck = report.checks.find((c) => c.name === "gotchas");
      expect(gotchasCheck?.severity).toBe("blocking");
      // The message has to name what is wrong with THIS file: "empty or
      // missing" would send the reader looking for a file they can see.
      expect(gotchasCheck?.message).not.toContain("empty or missing");
      expect(gotchasCheck?.hint).toContain(GOTCHAS_PLACEHOLDER_MARKER);
    });
  });

  describe("degraded cases (exitCode: 0 with hints)", () => {
    test("gh missing is degraded, not blocking", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) =>
          p === "/repo/.prhero/gotchas.md" ||
          p === "/home/user/.prhero/setup.json",
        readFile: () => "## Gotchas\nContent",
        checkToolsOptions: {
          which: (bin) => (bin === "gh" ? null : `/bin/${bin}`),
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(report.overall).toBe("degraded");
      expect(report.exitCode).toBe(0);
      const ghCheck = report.checks.find((c) => c.name === "gh");
      expect(ghCheck?.severity).toBe("degraded");
      expect(ghCheck?.hint).toBeDefined();
    });

    test("codegraph unindexed is degraded, not blocking", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) =>
          p === "/repo/.prhero/gotchas.md" ||
          p === "/home/user/.prhero/setup.json",
        readFile: () => "## Gotchas\nContent",
        checkToolsOptions: {
          which: () => "/bin/tool",
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(report.overall).toBe("degraded");
      expect(report.exitCode).toBe(0);
      const cgCheck = report.checks.find((c) => c.name === "codegraph");
      expect(cgCheck?.severity).toBe("degraded");
      // The exact upstream command, opening quote included (see system-tools.test.ts).
      expect(cgCheck?.hint).toContain("Run 'codegraph init'");
    });

    test("setup.json missing is degraded with init hint", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => p === "/repo/.prhero/gotchas.md", // setup.json missing
        readFile: () => "## Gotchas\nContent",
        checkToolsOptions: {
          which: () => "/bin/tool",
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          exists: (p) => p === "/repo/.codegraph",
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(report.overall).toBe("degraded");
      expect(report.exitCode).toBe(0);
      const setupCheck = report.checks.find((c) => c.name === "setup");
      expect(setupCheck?.severity).toBe("degraded");
      expect(setupCheck?.hint).toContain("pr-hero init");
    });

    test("skills not synced reports degraded with hint", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => {
          if (p === "/repo/.prhero/gotchas.md") return true;
          if (p === "/repo/.codegraph") return true;
          if (p === "/home/user/.prhero/setup.json") return true;
          if (p === "/home/user/.claude/mcp.json") return true;
          // Skills not synced
          return false;
        },
        readFile: (p) => {
          if (p === "/repo/.prhero/gotchas.md") return "## Gotchas\nContent";
          return bundledPromptBody(p);
        },
        checkToolsOptions: {
          which: (bin) => (bin === "claude" ? "/bin/claude" : `/bin/${bin}`),
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(report.overall).toBe("degraded");
      const skillsCheck = report.checks.find((c) =>
        c.name.startsWith("skills:"),
      );
      expect(skillsCheck?.severity).toBe("degraded");
      expect(skillsCheck?.hint).toBeDefined();
    });

    test("mcp server not registered reports degraded with hint", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => {
          if (p === "/repo/.prhero/gotchas.md") return true;
          if (p === "/repo/.codegraph") return true;
          if (p === "/home/user/.prhero/setup.json") return true;
          // MCP not registered
          return false;
        },
        readFile: (p) => {
          if (p === "/repo/.prhero/gotchas.md") return "## Gotchas\nContent";
          return bundledPromptBody(p);
        },
        checkToolsOptions: {
          which: (bin) => (bin === "claude" ? "/bin/claude" : `/bin/${bin}`),
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(report.overall).toBe("degraded");
      const mcpCheck = report.checks.find((c) => c.name.startsWith("mcp:"));
      expect(mcpCheck?.severity).toBe("degraded");
      expect(mcpCheck?.hint).toBeDefined();
    });
  });

  describe("provider capability section (§11/D1-09)", () => {
    test("blocking report issue propagates to overall blocking and exitCode 1", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => p === "/repo/.prhero/gotchas.md",
        readFile: (p) =>
          p === "/repo/.prhero/gotchas.md"
            ? "## Gotchas\nContent"
            : bundledPromptBody(p),
        checkToolsOptions: {
          which: (bin) => `/bin/${bin}`,
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
        produceCapabilityReport: async () => ({
          backend: "claude-code",
          status: "blocking",
          auth: {
            kind: "claude_subscription_oauth",
            projectionReady: false,
            probe: "failed",
          },
          isolation: {
            syntheticHome: false,
            workspaceReadBroker: true,
            codegraphPolicy: false,
          },
          protocol: {
            terminalProof: true,
            boundedEvents: false,
            usageMode: "snapshot",
          },
          cancellation: { deadlineMs: 7500, conformance: "passed" },
          billing: { mode: "subscription", pricingReady: false },
          issues: [
            {
              code: "auth_failed",
              message: "claude authentication not detected",
              blocking: true,
            },
          ],
        }),
      });

      expect(report.overall).toBe("blocking");
      expect(report.exitCode).toBe(1);
      const providerCheck = report.checks.find(
        (c) => c.name === "provider:auth_failed",
      );
      expect(providerCheck?.severity).toBe("blocking");
    });

    test("non-blocking issues render degraded with a hint and do not fail the run", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => p === "/repo/.prhero/gotchas.md",
        readFile: (p) =>
          p === "/repo/.prhero/gotchas.md"
            ? "## Gotchas\nContent"
            : bundledPromptBody(p),
        checkToolsOptions: {
          which: (bin) => `/bin/${bin}`,
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
        produceCapabilityReport: async () => ({
          backend: "claude-code",
          status: "degraded",
          binary: {
            absolutePath: "/bin/claude",
            sha256: "a".repeat(64),
            version: "1.0.0",
          },
          auth: {
            kind: "claude_subscription_oauth",
            projectionReady: true,
            probe: "passed",
          },
          isolation: {
            syntheticHome: true,
            workspaceReadBroker: true,
            codegraphPolicy: false,
          },
          protocol: {
            terminalProof: true,
            boundedEvents: false,
            usageMode: "snapshot",
          },
          cancellation: { deadlineMs: 7500, conformance: "passed" },
          billing: { mode: "subscription", pricingReady: false },
          issues: [
            {
              code: "pricing_table_missing",
              message: "no per-model pricing table is bundled",
              blocking: false,
            },
          ],
        }),
      });

      expect(report.overall).toBe("degraded");
      expect(report.exitCode).toBe(0);
      const providerCheck = report.checks.find(
        (c) => c.name === "provider:pricing_table_missing",
      );
      expect(providerCheck?.severity).toBe("degraded");
      expect(providerCheck?.hint).toBeDefined();
    });

    test("a throwing producer fails loud as blocking", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => p === "/repo/.prhero/gotchas.md",
        readFile: (p) =>
          p === "/repo/.prhero/gotchas.md"
            ? "## Gotchas\nContent"
            : bundledPromptBody(p),
        checkToolsOptions: {
          which: (bin) => `/bin/${bin}`,
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
        produceCapabilityReport: async () => {
          throw new Error("boom");
        },
      });

      expect(report.overall).toBe("blocking");
      const providerCheck = report.checks.find((c) => c.name === "provider");
      expect(providerCheck?.severity).toBe("blocking");
      expect(providerCheck?.message).toContain("boom");
    });
  });

  describe("exact-binding capability facts", () => {
    const exact = (
      overrides: Partial<ExactBindingCapabilityReport> = {},
    ): ExactBindingCapabilityReport => ({
      routeKey: "fp",
      backend: "claude-code",
      sdk: { available: true },
      binary: { resolved: true, absolutePath: "/bin/claude", sha256: "aa" },
      auth: {
        kind: "claude_subscription_oauth",
        projectionReady: true,
        probe: "passed",
      },
      environment: { syntheticHome: true, enumeratedPassthrough: false },
      isolation: { workspaceReadBroker: true, codegraphPolicy: false },
      toolsMcp: { allowMapEnforced: true, mcpIntegrityChecked: true },
      protocol: {
        terminalProof: true,
        boundedEvents: false,
        usageMode: "snapshot",
      },
      usage: { normalized: true },
      billing: {
        mode: "subscription",
        pricingApplicability: "not_applicable",
        tokenPricingAvailable: false,
        cashCostAccountingValid: true,
      },
      ...overrides,
    });
    const base = {
      cwd: "/repo",
      home: "/home/user",
      exists: (p: string) => p === "/repo/.prhero/gotchas.md",
      readFile: () => "## Gotchas\nContent",
      checkToolsOptions: {
        which: (bin: string) => `/bin/${bin}`,
        exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
        env: { ANTHROPIC_API_KEY: "sk-test" },
      },
    };

    test("subscription pricing is non-blocking; metered missing prices block", async () => {
      const sub = await runDoctor({
        ...base,
        probeExactBindings: async () => [exact()],
      });
      expect(sub.exitCode).toBe(0);
      expect(
        sub.checks.some((c) => c.name === "provider:pricing_table_missing"),
      ).toBe(false);
      const metered = await runDoctor({
        ...base,
        probeExactBindings: async () => [
          exact({
            billing: {
              mode: "metered",
              pricingApplicability: "required",
              tokenPricingAvailable: false,
              cashCostAccountingValid: false,
            },
          }),
        ],
      });
      expect(metered.overall).toBe("blocking");
      expect(
        metered.checks.find((c) => c.name === "provider:pricing_table_missing")
          ?.severity,
      ).toBe("blocking");
    });

    test("stale ProviderCapabilityReport cannot override exact-binding facts", async () => {
      const report = await runDoctor({
        ...base,
        produceCapabilityReport: async () => ({
          backend: "claude-code",
          status: "ready",
          auth: {
            kind: "claude_subscription_oauth",
            projectionReady: true,
            probe: "passed",
          },
          isolation: {
            syntheticHome: true,
            workspaceReadBroker: true,
            codegraphPolicy: true,
          },
          protocol: {
            terminalProof: true,
            boundedEvents: true,
            usageMode: "snapshot",
          },
          cancellation: { deadlineMs: 7500, conformance: "passed" },
          billing: { mode: "subscription", pricingReady: true },
          issues: [],
        }),
        probeExactBindings: async () => [exact({ sdk: { available: false } })],
      });
      expect(report.overall).toBe("blocking");
      expect(
        report.checks.find((c) => c.name === "provider:sdk_unavailable")
          ?.severity,
      ).toBe("blocking");
    });

    test("doctor route plan constructs an OpenCode binding from routing", () => {
      const open = buildDoctorRoutePlan({
        mappings: {
          [aliasCanonical("sonnet")]: {
            backend: "opencode",
            provider: "openai",
            modelFamily: "gpt-4o",
            modelSnapshot: "gpt-4o",
            modelVariant: "high",
          },
        },
      }).steps.find((step) => step.route.backend === "opencode");
      expect(open?.route).toMatchObject({
        provider: "openai",
        modelFamily: "gpt-4o",
        modelVariant: "high",
      });
    });
  });

  // The check that was pure assertion until this suite existed: doctor
  // reported "Using bundled prompt set (default)" unconditionally, having
  // verified nothing, on the very machine whose next `review` died with
  // `agents dir does not exist: /$bunfs/root`. A green doctor beside a broken
  // review is worse than no doctor, because it is the thing people trust.
  describe("bundled prompt set", () => {
    // A COMPILED bundle, which is the mode that broke: the paths are the
    // manifest's embedded ones, so nothing here touches a real filesystem.
    const embedded: Record<string, string> = {
      "deep-review-reliability.md": "/embedded/reliability-aaaa.md",
      "deep-review-resilience.md": "/embedded/resilience-bbbb.md",
      "deep-review-lifecycle.md": "/embedded/lifecycle-cccc.md",
      "deep-review-parity.md": "/embedded/parity-dddd.md",
      "review-refuter.md": "/embedded/refuter-eeee.md",
    };
    const compiledAssets = (files: Record<string, string>): EngineAssets => ({
      ...resolveEngineAssets(),
      mode: "compiled",
      bundledAgentFiles: files,
    });

    const baseOptions = {
      cwd: "/repo",
      home: "/home/user",
      exists: (p: string) =>
        p === "/repo/.prhero/gotchas.md" ||
        p === "/home/user/.prhero/setup.json",
      checkToolsOptions: {
        which: (bin: string) => `/bin/${bin}`,
        exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
        env: { ANTHROPIC_API_KEY: "sk-test" },
      },
    };

    test("every prompt the review spec names is readable -> healthy", async () => {
      const report = await runDoctor({
        ...baseOptions,
        assets: compiledAssets(embedded),
        readFile: (p) =>
          p === "/repo/.prhero/gotchas.md"
            ? "## Gotchas\nContent"
            : "# a prompt body\n",
      });

      const check = report.checks.find((c) => c.name === "agents_dir");
      expect(check?.severity).toBe("healthy");
      expect(check?.message).toContain("5");
    });

    test("a prompt that cannot be read is blocking, named by its logical file", async () => {
      const report = await runDoctor({
        ...baseOptions,
        assets: compiledAssets(embedded),
        readFile: (p) => {
          if (p === "/repo/.prhero/gotchas.md") return "## Gotchas\nContent";
          if (p === "/embedded/refuter-eeee.md") return undefined;
          return "# a prompt body\n";
        },
      });

      const check = report.checks.find((c) => c.name === "agents_dir");
      expect(check?.severity).toBe("blocking");
      expect(check?.message).toContain("review-refuter.md");
      // The logical name, never the embedded path: "/$bunfs/root/<hash>.md" is
      // actionable to nobody and names a file that exists on no machine.
      expect(check?.message).not.toContain("/embedded/");
      expect(check?.hint).toBeDefined();
    });

    test("an empty prompt is as broken as a missing one", async () => {
      const report = await runDoctor({
        ...baseOptions,
        assets: compiledAssets(embedded),
        readFile: (p) => {
          if (p === "/repo/.prhero/gotchas.md") return "## Gotchas\nContent";
          if (p === "/embedded/parity-dddd.md") return "   \n";
          return "# a prompt body\n";
        },
      });

      const check = report.checks.find((c) => c.name === "agents_dir");
      expect(check?.severity).toBe("blocking");
      expect(check?.message).toContain("deep-review-parity.md");
    });

    test("a manifest the build never embedded is blocking, not a crash", async () => {
      const { "review-refuter.md": _dropped, ...incomplete } = embedded;
      const report = await runDoctor({
        ...baseOptions,
        assets: compiledAssets(incomplete),
        readFile: (p) =>
          p === "/repo/.prhero/gotchas.md"
            ? "## Gotchas\nContent"
            : "# a prompt body\n",
      });

      const check = report.checks.find((c) => c.name === "agents_dir");
      expect(check?.severity).toBe("blocking");
      expect(check?.message).toContain("review-refuter.md");
    });
  });

  describe("pricing catalog freshness", () => {
    // Same machine fixture the all-healthy case above uses, minus the parts no
    // pricing assertion depends on: this check reads only the bundled
    // catalogue and the injected clock, never the filesystem.
    const pricingOptions = {
      cwd: "/repo",
      home: "/home/user",
      exists: (p: string) => p === "/repo/.prhero/gotchas.md",
      readFile: (p: string) =>
        p === "/repo/.prhero/gotchas.md"
          ? "## Gotchas\nContent"
          : bundledPromptBody(p),
      checkToolsOptions: {
        which: (bin: string) => `/bin/${bin}`,
        exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
        env: { ANTHROPIC_API_KEY: "sk-test" },
      },
    };

    // Aged against ANTHROPIC's stamp, and every assertion below names the
    // anthropic check. #137 gives each provider its own table, its own stamp
    // and therefore its own check: an arm that aged one table and read
    // another's line would report on a freshness it never set.
    const atAge = (days: number): Date =>
      new Date(Date.parse(ANTHROPIC_PRICING.fetched_at) + days * 86_400_000);

    test("a fresh catalogue is healthy and names its age and source", async () => {
      const report = await runDoctor({
        ...pricingOptions,
        now: () => atAge(PRICING_MAX_AGE_DAYS - 1),
      });

      const check = report.checks.find(
        (c) => c.name === "pricing-catalog:anthropic",
      );
      expect(check?.severity).toBe("healthy");
      expect(check?.message).toContain(String(PRICING_MAX_AGE_DAYS - 1));
      expect(check?.message).toContain(ANTHROPIC_PRICING.source_url);
      expect(check?.message).toContain(ANTHROPIC_PRICING.fetched_at);
    });

    test("a catalogue at the age limit is degraded with a re-fetch hint", async () => {
      const report = await runDoctor({
        ...pricingOptions,
        now: () => atAge(PRICING_MAX_AGE_DAYS),
      });

      const check = report.checks.find(
        (c) => c.name === "pricing-catalog:anthropic",
      );
      expect(check?.severity).toBe("degraded");
      expect(check?.message).toContain(String(PRICING_MAX_AGE_DAYS));
      expect(check?.hint).toBeDefined();
      expect(check?.hint).toContain(ANTHROPIC_PRICING.source_url);
      // The hint names the file to re-fetch INTO, and there is now more than
      // one, so naming the wrong provider's file would send the operator to
      // edit a table that is not the expired one.
      expect(check?.hint).toContain("config/models/anthropic-pricing.json");
    });

    test("staleness never blocks: a subscription user is the common case and is unaffected", async () => {
      const report = await runDoctor({
        ...pricingOptions,
        now: () => atAge(PRICING_MAX_AGE_DAYS * 10),
      });

      const check = report.checks.find(
        (c) => c.name === "pricing-catalog:anthropic",
      );
      expect(check?.severity).toBe("degraded");
      expect(report.overall).not.toBe("blocking");
      expect(report.exitCode).toBe(0);
    });

    // #137. The reason there is one check per catalogue rather than one line
    // about "the" pricing table: at this instant Anthropic's table has
    // expired and z.ai's has not, and BOTH facts are operationally load
    // bearing -- one provider's metered routes are refused while the other's
    // are still priced. A single reported age would have to pick one, and the
    // one it hid could be either.
    test("each bundled catalogue reports its own age", async () => {
      const report = await runDoctor({
        ...pricingOptions,
        now: () => atAge(PRICING_MAX_AGE_DAYS),
      });

      const anthropic = report.checks.find(
        (c) => c.name === "pricing-catalog:anthropic",
      );
      const zai = report.checks.find((c) => c.name === "pricing-catalog:zai");
      expect(anthropic?.severity).toBe("degraded");
      expect(zai?.severity).toBe("healthy");
      expect(zai?.message).toContain(ZAI_PRICING.source_url);
      expect(zai?.message).toContain(ZAI_PRICING.fetched_at);
      // One expired table is not a reason to stop reviewing on a provider
      // whose table is current.
      expect(report.overall).not.toBe("blocking");
      expect(report.exitCode).toBe(0);
    });

    test("every bundled catalogue gets a check, with no hardcoded provider list", async () => {
      // A table added to the bundle and forgotten by doctor would age in
      // silence, which is the one thing doctor is here to prevent.
      const report = await runDoctor({
        ...pricingOptions,
        now: () => NEWEST_FETCHED_AT,
      });

      const reported = report.checks
        .filter((c) => c.name.startsWith("pricing-catalog:"))
        .map((c) => c.name.slice("pricing-catalog:".length))
        .sort();
      expect(reported).toEqual(Object.keys(PRICING_CATALOGS).sort());
    });
  });

  describe("PROVIDER_HINTS reachability", () => {
    test("cash_cost_accounting_invalid has no hint entry (the issue is always blocking, so pushProviderIssues never attaches its hint)", () => {
      expect(Object.keys(PROVIDER_HINTS)).not.toContain(
        "cash_cost_accounting_invalid",
      );
    });
  });

  describe("renderDoctorReport", () => {
    test("renders report lines with styles: false containing zero ANSI escape bytes", () => {
      const report: DoctorReport = {
        overall: "degraded",
        exitCode: 0,
        checks: [
          { name: "git", severity: "healthy", message: "git version 2.40.0" },
          {
            name: "gh",
            severity: "degraded",
            message: "gh missing",
            hint: "brew install gh",
          },
        ],
      };

      const lines = renderDoctorReport(report, { styles: false, width: 80 });
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain("\x1b");
      }
    });
  });
});
