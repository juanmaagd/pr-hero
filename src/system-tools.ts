import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type SystemTool = "git" | "claude" | "gh" | "codegraph";

export interface SystemToolStatus {
  installed: boolean;
  version?: string;
  authOk?: boolean; // gh, claude
  repoIndexed?: boolean; // codegraph
  hint?: string;
}

export interface CheckSystemToolsOptions {
  cwd?: string;
  which?: (binary: string) => string | null | Promise<string | null>;
  exec?: (
    cmd: string[],
    options?: { cwd?: string },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  exists?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
  home?: string;
}

export interface InstallSystemToolOptions {
  platform?: NodeJS.Platform;
  which?: (binary: string) => string | null | Promise<string | null>;
  exec?: (
    cmd: string[],
    options?: { cwd?: string },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface InstallResult {
  ok: boolean;
  manualCommand?: string;
  error?: string;
}

async function defaultExec(
  cmd: string[],
  options?: { cwd?: string; timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const timeoutMs = options?.timeoutMs ?? 10_000;
    const proc = Bun.spawn(cmd, {
      cwd: options?.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // ignore
          }
          reject(
            new Error(
              `Command timed out after ${timeoutMs}ms: ${cmd.join(" ")}`,
            ),
          );
        }, timeoutMs);
      });

      const executionPromise = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      const [stdout, stderr, exitCode] = await Promise.race([
        executionPromise,
        timeoutPromise,
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: (error as Error).message };
  }
}

export async function checkSystemTools(
  options: CheckSystemToolsOptions = {},
): Promise<Record<SystemTool, SystemToolStatus>> {
  const cwd = options.cwd ?? process.cwd();
  const which = options.which ?? ((bin: string) => Bun.which(bin));
  const exec = options.exec ?? defaultExec;
  const exists = options.exists ?? existsSync;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();

  // 1. git
  const gitBin = await which("git");
  let gitStatus: SystemToolStatus;
  if (!gitBin) {
    gitStatus = {
      installed: false,
      hint: "Install git: brew install git (macOS) or apt install git (Linux)",
    };
  } else {
    const res = await exec([gitBin, "--version"]);
    const versionMatch = res.stdout.match(/git version\s+([0-9.]+)/i);
    gitStatus = {
      installed: true,
      version: versionMatch ? versionMatch[1] : undefined,
    };
  }

  // 2. claude
  const claudeBin = await which("claude");
  let claudeStatus: SystemToolStatus;
  if (!claudeBin) {
    claudeStatus = {
      installed: false,
      authOk: false,
      hint: "Install Claude Code CLI: npm i -g @anthropic-ai/claude-code",
    };
  } else {
    const res = await exec([claudeBin, "--version"]);
    const version = res.stdout.trim().replace(/^claude-code\//, "");

    // Check auth mechanisms
    const hasToken =
      Boolean(
        env.CLAUDE_CODE_OAUTH_TOKEN &&
          env.CLAUDE_CODE_OAUTH_TOKEN.trim().length > 0,
      ) ||
      Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim().length > 0);

    const hasSessionFile =
      exists(path.join(home, ".claude.json")) ||
      exists(path.join(home, ".claude", "session.json"));

    const authOk = hasToken || hasSessionFile;
    claudeStatus = {
      installed: true,
      version: version.length > 0 ? version : undefined,
      authOk,
      hint: authOk
        ? undefined
        : "Run 'claude' in your terminal to complete login or set ANTHROPIC_API_KEY",
    };
  }

  // 3. gh
  const ghBin = await which("gh");
  let ghStatus: SystemToolStatus;
  if (!ghBin) {
    ghStatus = {
      installed: false,
      authOk: false,
      hint: "Install GitHub CLI: brew install gh (macOS) or apt install gh (Linux)",
    };
  } else {
    const versionRes = await exec([ghBin, "--version"]);
    const versionMatch = versionRes.stdout.match(/gh version\s+([0-9.]+)/i);
    const authRes = await exec([ghBin, "auth", "status"]);
    const authOk = authRes.exitCode === 0;

    ghStatus = {
      installed: true,
      version: versionMatch ? versionMatch[1] : undefined,
      authOk,
      hint: authOk
        ? undefined
        : "Run 'gh auth login' to authenticate with GitHub for PR reviews",
    };
  }

  // 4. codegraph
  const codegraphBin = await which("codegraph");
  const repoIndexed = exists(path.join(cwd, ".codegraph"));
  let codegraphStatus: SystemToolStatus;
  if (!codegraphBin) {
    codegraphStatus = {
      installed: false,
      repoIndexed,
      hint: "Install CodeGraph: brew install codegraph or see https://github.com/Gentleman-Programming/codegraph",
    };
  } else {
    const versionRes = await exec([codegraphBin, "--version"]);
    const versionMatch = versionRes.stdout.match(/codegraph\s+([0-9.]+)/i);
    codegraphStatus = {
      installed: true,
      version: versionMatch ? versionMatch[1] : undefined,
      repoIndexed,
      hint: repoIndexed
        ? undefined
        : "Run 'gentle-ai codegraph init' in this repository to index for code intelligence",
    };
  }

  return {
    git: gitStatus,
    claude: claudeStatus,
    gh: ghStatus,
    codegraph: codegraphStatus,
  };
}

export async function installSystemTool(
  tool: SystemTool,
  options: InstallSystemToolOptions = {},
): Promise<InstallResult> {
  const platform = options.platform ?? process.platform;
  const which = options.which ?? ((bin: string) => Bun.which(bin));
  const exec = options.exec ?? defaultExec;

  if (tool === "claude") {
    const npmBin = (await which("npm")) ?? "npm";
    const res = await exec([
      npmBin,
      "install",
      "-g",
      "@anthropic-ai/claude-code",
    ]);
    return {
      ok: res.exitCode === 0,
      manualCommand: "npm install -g @anthropic-ai/claude-code",
      error: res.exitCode === 0 ? undefined : res.stderr,
    };
  }

  const brewBin = await which("brew");
  if (platform === "darwin" && brewBin) {
    const formula = tool === "codegraph" ? "codegraph" : tool;
    const res = await exec([brewBin, "install", formula]);
    return {
      ok: res.exitCode === 0,
      manualCommand: `brew install ${formula}`,
      error: res.exitCode === 0 ? undefined : res.stderr,
    };
  }

  // Linux or no brew
  const manualCommands: Record<SystemTool, string> = {
    git: "sudo apt-get install git",
    claude: "npm install -g @anthropic-ai/claude-code",
    gh: "sudo apt-get install gh",
    codegraph: "brew install codegraph # or see codegraph docs",
  };

  return {
    ok: false,
    manualCommand: manualCommands[tool],
  };
}
