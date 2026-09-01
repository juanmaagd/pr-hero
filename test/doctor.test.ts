import { describe, expect, test } from "bun:test";
import {
  type EngineAssets,
  resolveEngineAssets,
  selfInvocation,
} from "../src/assets";
import { CI_WORKFLOW_RELATIVE_PATH } from "../src/ci-setup";
import {
  type DoctorReport,
  renderDoctorReport,
  runDoctor,
} from "../src/doctor";

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
