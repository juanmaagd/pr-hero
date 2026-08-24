import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectAgentEnvironments,
  inspectMcpRegistration,
  inspectSkillsSync,
} from "./agent-env";
import { resolveEngineAssets, selfInvocation } from "./assets";
import { isCiEnvironment } from "./preflight";
import {
  type CheckSystemToolsOptions,
  checkCiConfiguration,
  checkSystemTools,
} from "./system-tools";

export type DoctorSeverity = "healthy" | "degraded" | "blocking";

export interface DoctorCheckItem {
  name: string;
  severity: DoctorSeverity;
  message: string;
  hint?: string;
}

export interface DoctorReport {
  overall: DoctorSeverity;
  checks: DoctorCheckItem[];
  exitCode: 0 | 1;
}

export interface RunDoctorOptions {
  cwd?: string;
  repoRoot?: string;
  home?: string;
  checkToolsOptions?: CheckSystemToolsOptions;
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string | undefined;
}

export function evaluateDoctorReport(checks: DoctorCheckItem[]): DoctorReport {
  let overall: DoctorSeverity = "healthy";
  if (checks.some((c) => c.severity === "blocking")) {
    overall = "blocking";
  } else if (checks.some((c) => c.severity === "degraded")) {
    overall = "degraded";
  }

  return {
    overall,
    checks,
    exitCode: overall === "blocking" ? 1 : 0,
  };
}

export async function runDoctor(
  options: RunDoctorOptions = {},
): Promise<DoctorReport> {
  const home = options.home ?? os.homedir();
  const exists =
    options.exists ?? options.checkToolsOptions?.exists ?? existsSync;
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });

  const repoDir = options.repoRoot ?? options.cwd;

  const checks: DoctorCheckItem[] = [];

  // 1. System tools
  const tools = await checkSystemTools({
    cwd: repoDir ?? process.cwd(),
    home,
    exists,
    ...options.checkToolsOptions,
  });

  // Git (required)
  if (!tools.git.installed) {
    checks.push({
      name: "git",
      severity: "blocking",
      message: "git is not installed",
      hint: tools.git.hint,
    });
  } else {
    checks.push({
      name: "git",
      severity: "healthy",
      message: `git is installed (${tools.git.version ?? "version unknown"})`,
    });
  }

  // Claude (required + auth)
  if (!tools.claude.installed) {
    checks.push({
      name: "claude",
      severity: "blocking",
      message: "Claude Code CLI is not installed",
      hint: tools.claude.hint,
    });
  } else if (!tools.claude.authOk) {
    checks.push({
      name: "claude",
      severity: "blocking",
      message: `Claude Code CLI is installed (${tools.claude.version ?? "unknown"}) but not authenticated`,
      hint: tools.claude.hint,
    });
  } else {
    checks.push({
      name: "claude",
      severity: "healthy",
      message: `Claude Code CLI is installed and authenticated (${tools.claude.version ?? "unknown"})`,
    });
  }

  // GitHub CLI (optional, PR mode)
  if (!tools.gh.installed) {
    checks.push({
      name: "gh",
      severity: "degraded",
      message: "GitHub CLI is not installed (needed for PR review mode)",
      hint: tools.gh.hint,
    });
  } else if (!tools.gh.authOk) {
    checks.push({
      name: "gh",
      severity: "degraded",
      message: `GitHub CLI is installed (${tools.gh.version ?? "unknown"}) but not authenticated with GitHub`,
      hint: tools.gh.hint,
    });
  } else {
    checks.push({
      name: "gh",
      severity: "healthy",
      message: `GitHub CLI is installed and authenticated (${tools.gh.version ?? "unknown"})`,
    });
  }

  // CodeGraph (optional, code intelligence)
  if (!tools.codegraph.installed) {
    checks.push({
      name: "codegraph",
      severity: "degraded",
      message: "CodeGraph binary is not installed (optional code intelligence)",
      hint: tools.codegraph.hint,
    });
  } else if (!tools.codegraph.repoIndexed) {
    checks.push({
      name: "codegraph",
      severity: "degraded",
      message: `CodeGraph is installed (${tools.codegraph.version ?? "unknown"}) but repository is not indexed (.codegraph missing)`,
      hint: tools.codegraph.hint,
    });
  } else {
    checks.push({
      name: "codegraph",
      severity: "healthy",
      message: `CodeGraph is installed (${tools.codegraph.version ?? "unknown"}) and repository is indexed`,
    });
  }

  // 2. Config layer / agents_dir check
  const repoConfigPath = repoDir
    ? path.join(repoDir, ".prhero", "config.json")
    : undefined;
  const globalConfigPath = path.join(home, ".prhero", "config.json");

  let parsedAgentsDir: string | undefined;
  if (repoConfigPath && exists(repoConfigPath)) {
    try {
      const raw = readFile(repoConfigPath);
      if (raw) {
        const json = JSON.parse(raw);
        if (json.agents_dir && typeof json.agents_dir === "string") {
          parsedAgentsDir = path.resolve(
            path.dirname(repoConfigPath),
            json.agents_dir,
          );
        }
      }
    } catch {
      // Ignored here, parsed elsewhere
    }
  } else if (exists(globalConfigPath)) {
    try {
      const raw = readFile(globalConfigPath);
      if (raw) {
        const json = JSON.parse(raw);
        if (json.agents_dir && typeof json.agents_dir === "string") {
          parsedAgentsDir = path.resolve(
            path.dirname(globalConfigPath),
            json.agents_dir,
          );
        }
      }
    } catch {
      // Ignored
    }
  }

  if (parsedAgentsDir !== undefined) {
    if (!exists(parsedAgentsDir)) {
      checks.push({
        name: "agents_dir",
        severity: "blocking",
        message: `Configured agents_dir not found: ${parsedAgentsDir}`,
        hint: `Delete "agents_dir" from .prhero/config.json to fall through to the bundled default prompt set.`,
      });
    } else {
      checks.push({
        name: "agents_dir",
        severity: "healthy",
        message: `Custom agents_dir configured and verified: ${parsedAgentsDir}`,
      });
    }
  } else {
    checks.push({
      name: "agents_dir",
      severity: "healthy",
      message: "Using bundled prompt set (default)",
    });
  }

  // 3. Gotchas check (only when repo root is supplied or discovered)
  if (repoDir) {
    const gotchasPath = path.join(repoDir, ".prhero", "gotchas.md");
    const gotchasContent = exists(gotchasPath)
      ? readFile(gotchasPath)
      : undefined;
    if (!gotchasContent || gotchasContent.trim().length === 0) {
      checks.push({
        name: "gotchas",
        severity: "blocking",
        message:
          "Repository gotchas file (.prhero/gotchas.md) is empty or missing",
        hint: "Create and populate .prhero/gotchas.md with repository-specific invariants and failure traps.",
      });
    } else {
      checks.push({
        name: "gotchas",
        severity: "healthy",
        message: "Repository gotchas present (.prhero/gotchas.md)",
      });
    }
  }

  // 4. Setup state check (~/.prhero/setup.json)
  const setupJsonPath = path.join(home, ".prhero", "setup.json");
  if (!exists(setupJsonPath)) {
    checks.push({
      name: "setup",
      severity: "degraded",
      message:
        "Global setup state not initialized (~/.prhero/setup.json absent)",
      hint: "Run 'pr-hero init' or complete onboarding to initialize.",
    });
  } else {
    checks.push({
      name: "setup",
      severity: "healthy",
      message: "Global setup state verified (~/.prhero/setup.json)",
    });
  }

  // 5. Agent Environments (S3)
  const envs = await detectAgentEnvironments({
    home,
    exists,
    which: options.checkToolsOptions?.which,
  });

  const assets = resolveEngineAssets();
  const self = selfInvocation();
  const mcpReg = {
    command: self.command,
    args: [...self.args, "mcp"],
  };

  if (envs.length === 0) {
    checks.push({
      name: "agent_environments",
      severity: "degraded",
      message:
        "No AI agent coding environments detected (Claude Code, Cursor, Windsurf, Codex, Antigravity, OpenCode)",
      hint: "Install or configure an AI agent environment to use pr-hero triage skills and MCP server.",
    });
  } else {
    for (const env of envs) {
      if (env.skillsDir) {
        const syncStatus = inspectSkillsSync(env, assets, { exists, readFile });
        if (syncStatus.synced) {
          checks.push({
            name: `skills:${env.id}`,
            severity: "healthy",
            message: `pr-hero-triage skill synced for ${env.displayName} (${env.skillsDir})`,
          });
        } else if (syncStatus.drift) {
          checks.push({
            name: `skills:${env.id}`,
            severity: "degraded",
            message: `Local modifications detected in skills for ${env.displayName}`,
            hint: "Run 'pr-hero setup' or sync skills with force.",
          });
        } else {
          checks.push({
            name: `skills:${env.id}`,
            severity: "degraded",
            message: `pr-hero-triage skill not synced to ${env.displayName}`,
            hint: "Run 'pr-hero setup' or 'pr-hero init' to sync skills.",
          });
        }
      }

      if (env.mcpConfigFile) {
        const mcpOk = inspectMcpRegistration(env, mcpReg, { exists, readFile });
        if (mcpOk) {
          checks.push({
            name: `mcp:${env.id}`,
            severity: "healthy",
            message: `pr-hero MCP server registered for ${env.displayName} (${env.mcpConfigFile})`,
          });
        } else {
          checks.push({
            name: `mcp:${env.id}`,
            severity: "degraded",
            message: `pr-hero MCP server not registered for ${env.displayName}`,
            hint: "Run 'pr-hero setup' to register the MCP server.",
          });
        }
      }
    }
  }

  // 6. CI configuration (Pillar 3). Reuses checkToolsOptions.env rather than
  // adding a separate top-level env field — one injectable env source for
  // both "is claude authenticated" and "is this a GitHub Actions run",
  // matching how doctor.test.ts already threads env through today.
  const env = options.checkToolsOptions?.env ?? process.env;
  const isCi = isCiEnvironment({}, env);
  const ciStatus = checkCiConfiguration({
    cwd: repoDir ?? process.cwd(),
    isCi,
    env,
    exists,
  });
  checks.push({
    name: "ci",
    severity: ciStatus.configured ? "healthy" : isCi ? "blocking" : "degraded",
    message: ciStatus.message,
    hint: ciStatus.hint,
  });

  return evaluateDoctorReport(checks);
}

export function renderDoctorReport(
  report: DoctorReport,
  options: { styles?: boolean; width?: number } = {},
): string[] {
  const styles = options.styles ?? false;
  const lines: string[] = [];

  const green = (s: string) => (styles ? `\x1b[32m${s}\x1b[0m` : s);
  const yellow = (s: string) => (styles ? `\x1b[33m${s}\x1b[0m` : s);
  const red = (s: string) => (styles ? `\x1b[31m${s}\x1b[0m` : s);
  const bold = (s: string) => (styles ? `\x1b[1m${s}\x1b[0m` : s);
  const dim = (s: string) => (styles ? `\x1b[2m${s}\x1b[0m` : s);

  lines.push(bold("pr-hero doctor"));
  lines.push("");

  for (const check of report.checks) {
    let symbol: string;
    if (check.severity === "healthy") {
      symbol = green("[✓]");
    } else if (check.severity === "degraded") {
      symbol = yellow("[!]");
    } else {
      symbol = red("[✗]");
    }

    lines.push(`  ${symbol} ${bold(check.name)}: ${check.message}`);
    if (check.hint) {
      lines.push(`      ${dim(`Hint: ${check.hint}`)}`);
    }
  }

  lines.push("");
  if (report.overall === "healthy") {
    lines.push(green("All checks passed. Environment is ready for reviews."));
  } else if (report.overall === "degraded") {
    lines.push(
      yellow(
        "Environment is operational, but some optional tools or configurations are degraded.",
      ),
    );
  } else {
    lines.push(
      red(
        "Environment has blocking issues. Reviews cannot run until resolved.",
      ),
    );
  }

  return lines;
}
