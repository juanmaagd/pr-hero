import { describe, expect, test } from "bun:test";
import { selfInvocation } from "../src/assets";
import { CI_WORKFLOW_RELATIVE_PATH } from "../src/ci-setup";
import {
  type DoctorReport,
  renderDoctorReport,
  runDoctor,
} from "../src/doctor";

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
        return undefined;
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
          return undefined;
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
          return undefined;
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
