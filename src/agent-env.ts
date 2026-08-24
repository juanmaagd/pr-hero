import crypto from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineAssets } from "./assets";

export type AgentEnvId =
  | "claude"
  | "cursor"
  | "windsurf"
  | "codex"
  | "antigravity"
  | "opencode";

export type AgentEnvStatus = "active" | "detected_inactive" | "coming_soon";

export interface AgentEnvCapabilities {
  skills: boolean;
  mcp: boolean;
}

export interface AgentEnvAuthStatus {
  authenticated: boolean;
  message: string;
  tokenSource?: "env" | "file" | "session";
}

export interface AgentEnvDetection {
  id: AgentEnvId;
  displayName: string;
  status: AgentEnvStatus;
  binaryFound: boolean;
  binaryPath?: string;
  version?: string;
  auth: AgentEnvAuthStatus;
  skillsDir?: string;
  mcpConfigFile?: string;
}

export interface McpRegistration {
  command: string;
  args: string[];
}

export interface DetectAgentEnvironmentsOptions {
  home?: string;
  which?: (binary: string) => string | null | Promise<string | null>;
  exists?: (path: string) => boolean;
}

export interface SyncSkillsOptions {
  force?: boolean;
  readFile?: (path: string) => string | undefined;
  writeFile?: (path: string, content: string) => Promise<void> | void;
  exists?: (path: string) => boolean;
}

export interface SyncSkillsResult {
  synced: string[];
  upToDate?: boolean;
  driftDetected?: boolean;
  errors: string[];
}

export interface RegisterMcpOptions {
  readFile?: (path: string) => string | undefined;
  writeFile?: (path: string, content: string) => Promise<void> | void;
  exists?: (path: string) => boolean;
}

export interface RegisterMcpResult {
  registered: boolean;
  alreadyRegistered?: boolean;
  configFile: string;
  error?: string;
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export async function detectAgentEnvironments(
  options: DetectAgentEnvironmentsOptions = {},
): Promise<AgentEnvDetection[]> {
  const home = options.home ?? os.homedir();
  const which = options.which ?? ((bin: string) => Bun.which(bin));
  const exists = options.exists ?? existsSync;

  const results: AgentEnvDetection[] = [];

  // 1. Claude Code
  const claudeBin = await which("claude");
  const claudeDirExists =
    exists(path.join(home, ".claude")) ||
    exists(path.join(home, ".claude.json"));
  if (claudeBin || claudeDirExists) {
    results.push({
      id: "claude",
      displayName: "Claude Code",
      status: "active",
      binaryFound: Boolean(claudeBin),
      binaryPath: claudeBin ?? undefined,
      auth: { authenticated: true, message: "Detected" },
      skillsDir: path.join(home, ".claude", "skills"),
      mcpConfigFile: path.join(home, ".claude", "mcp.json"),
    });
  }

  // 2. Cursor
  const cursorBin = await which("cursor");
  const cursorDirExists =
    exists(path.join(home, ".cursor")) ||
    exists(path.join(home, ".config", "cursor"));
  if (cursorBin || cursorDirExists) {
    results.push({
      id: "cursor",
      displayName: "Cursor",
      status: "active",
      binaryFound: Boolean(cursorBin),
      binaryPath: cursorBin ?? undefined,
      auth: { authenticated: true, message: "Detected" },
      skillsDir: path.join(home, ".cursor", "skills"),
      mcpConfigFile: path.join(home, ".cursor", "mcp.json"),
    });
  }

  // 3. Windsurf
  const windsurfBin = await which("windsurf");
  const windsurfDirExists =
    exists(path.join(home, ".windsurf")) ||
    exists(path.join(home, ".codeium", "windsurf"));
  if (windsurfBin || windsurfDirExists) {
    results.push({
      id: "windsurf",
      displayName: "Windsurf",
      status: "active",
      binaryFound: Boolean(windsurfBin),
      binaryPath: windsurfBin ?? undefined,
      auth: { authenticated: true, message: "Detected" },
      skillsDir: path.join(home, ".windsurf", "skills"),
      mcpConfigFile: path.join(home, ".windsurf", "mcp.json"),
    });
  }

  // 4. Codex
  const codexBin = await which("codex");
  const codexDirExists =
    exists(path.join(home, ".codex")) ||
    exists(path.join(home, ".config", "codex"));
  if (codexBin || codexDirExists) {
    results.push({
      id: "codex",
      displayName: "OpenAI Codex CLI",
      status: "active",
      binaryFound: Boolean(codexBin),
      binaryPath: codexBin ?? undefined,
      auth: { authenticated: true, message: "Detected" },
      skillsDir: path.join(home, ".codex", "skills"),
      mcpConfigFile: path.join(home, ".codex", "mcp.json"),
    });
  }

  // 5. Antigravity / Gemini
  const agyBin = (await which("antigravity")) || (await which("agy"));
  const agyDirExists =
    exists(path.join(home, ".gemini")) ||
    exists(path.join(home, ".antigravity"));
  if (agyBin || agyDirExists) {
    results.push({
      id: "antigravity",
      displayName: "Antigravity",
      status: "active",
      binaryFound: Boolean(agyBin),
      binaryPath: agyBin ?? undefined,
      auth: { authenticated: true, message: "Detected" },
      skillsDir: exists(path.join(home, ".gemini", "config", "skills"))
        ? path.join(home, ".gemini", "config", "skills")
        : path.join(home, ".antigravity", "skills"),
      mcpConfigFile: path.join(home, ".antigravity", "mcp.json"),
    });
  }

  // 6. OpenCode
  const opencodeBin = await which("opencode");
  const opencodeDirExists =
    exists(path.join(home, ".opencode")) ||
    exists(path.join(home, ".config", "opencode"));
  if (opencodeBin || opencodeDirExists) {
    results.push({
      id: "opencode",
      displayName: "OpenCode",
      status: "active",
      binaryFound: Boolean(opencodeBin),
      binaryPath: opencodeBin ?? undefined,
      auth: { authenticated: true, message: "Detected" },
      skillsDir: path.join(home, ".opencode", "skills"),
      mcpConfigFile: path.join(home, ".opencode", "mcp.json"),
    });
  }

  return results;
}

export async function syncSkills(
  env: AgentEnvDetection,
  assets: EngineAssets,
  options: SyncSkillsOptions = {},
): Promise<SyncSkillsResult> {
  if (!env.skillsDir) {
    return {
      synced: [],
      errors: ["No skills directory resolved for environment"],
    };
  }

  const exists = options.exists ?? existsSync;
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });
  const writeFile =
    options.writeFile ??
    ((p: string, c: string) => {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, c, "utf-8");
    });

  const targetDir = path.join(env.skillsDir, "pr-hero-triage");
  const digestFile = path.join(targetDir, "digest.json");

  // 1. Read existing digest
  let existingDigest:
    | { files?: Record<string, string>; engine_version?: string }
    | undefined;
  if (exists(digestFile)) {
    try {
      const raw = readFile(digestFile);
      if (raw) existingDigest = JSON.parse(raw);
    } catch {
      // Ignored
    }
  }

  // 2. Read upstream assets and check hashes
  const upstreamContents: Record<string, string> = {};
  const upstreamHashes: Record<string, string> = {};

  for (const [logicalName, srcPath] of Object.entries(
    assets.triageSkillFiles,
  )) {
    const content = readFile(srcPath);
    if (content === undefined) {
      return {
        synced: [],
        errors: [`Missing upstream asset for ${logicalName} at ${srcPath}`],
      };
    }
    upstreamContents[logicalName] = content;
    upstreamHashes[logicalName] = sha256(content);
  }

  // 3. Drift detection
  let isUpToDate = true;
  for (const [logicalName, upstreamHash] of Object.entries(upstreamHashes)) {
    const destFile = path.join(targetDir, logicalName);
    if (!exists(destFile)) {
      isUpToDate = false;
      continue;
    }

    const diskContent = readFile(destFile);
    if (diskContent === undefined) {
      isUpToDate = false;
      continue;
    }

    const diskHash = sha256(diskContent);
    if (diskHash !== upstreamHash) {
      isUpToDate = false;
      const recordedHash = existingDigest?.files?.[logicalName];
      if (recordedHash && diskHash !== recordedHash && !options.force) {
        return {
          synced: [],
          driftDetected: true,
          errors: [
            `Local edits detected in ${destFile}. Pass force to overwrite.`,
          ],
        };
      }
    }
  }

  if (isUpToDate && existingDigest) {
    return { synced: [], upToDate: true, errors: [] };
  }

  // 4. Write synced files
  const synced: string[] = [];
  for (const [logicalName, content] of Object.entries(upstreamContents)) {
    const destFile = path.join(targetDir, logicalName);
    await writeFile(destFile, content);
    synced.push(logicalName);
  }

  // Write digest
  const newDigest = {
    files: upstreamHashes,
    synced_at: new Date().toISOString(),
    engine_version: assets.version,
  };
  await writeFile(digestFile, `${JSON.stringify(newDigest, null, 2)}\n`);

  return { synced, errors: [] };
}

export function inspectSkillsSync(
  env: AgentEnvDetection,
  assets: EngineAssets,
  options: {
    exists?: (p: string) => boolean;
    readFile?: (p: string) => string | undefined;
  } = {},
): { synced: boolean; drift: boolean } {
  if (!env.skillsDir) return { synced: false, drift: false };
  const exists = options.exists ?? existsSync;
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });

  const targetDir = path.join(env.skillsDir, "pr-hero-triage");
  const digestFile = path.join(targetDir, "digest.json");

  if (!exists(digestFile)) return { synced: false, drift: false };

  let existingDigest: { files?: Record<string, string> } | undefined;
  try {
    const raw = readFile(digestFile);
    if (raw) existingDigest = JSON.parse(raw);
  } catch {
    return { synced: false, drift: false };
  }

  for (const [logicalName, srcPath] of Object.entries(
    assets.triageSkillFiles,
  )) {
    const destFile = path.join(targetDir, logicalName);
    if (!exists(destFile)) return { synced: false, drift: false };

    const srcContent = readFile(srcPath);
    const destContent = readFile(destFile);
    if (!srcContent || !destContent) return { synced: false, drift: false };

    const diskHash = sha256(destContent);
    const upstreamHash = sha256(srcContent);
    const recordedHash = existingDigest?.files?.[logicalName];

    if (
      recordedHash &&
      diskHash !== recordedHash &&
      diskHash !== upstreamHash
    ) {
      return { synced: false, drift: true };
    }
    if (diskHash !== upstreamHash) {
      return { synced: false, drift: false };
    }
  }

  return { synced: true, drift: false };
}

export async function registerMcpServer(
  env: AgentEnvDetection,
  reg: McpRegistration,
  options: RegisterMcpOptions = {},
): Promise<RegisterMcpResult> {
  if (!env.mcpConfigFile) {
    return {
      registered: false,
      configFile: "",
      error: "No MCP configuration file path resolved for environment",
    };
  }

  const configFile = env.mcpConfigFile;
  const exists = options.exists ?? existsSync;
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });
  const writeFile =
    options.writeFile ??
    ((p: string, c: string) => {
      mkdirSync(path.dirname(p), { recursive: true });
      const tmpPath = `${p}.tmp.${Date.now()}`;
      writeFileSync(tmpPath, c, "utf-8");
      renameSync(tmpPath, p);
    });

  if (exists(configFile)) {
    try {
      const stat = lstatSync(configFile);
      if (stat.isSymbolicLink()) {
        return {
          registered: false,
          configFile,
          error: `Refusing to edit symlinked MCP config file: ${configFile}`,
        };
      }
    } catch {
      // ignore
    }
  }

  let config: {
    mcpServers?: Record<string, { command: string; args: string[] }>;
  } = {};

  if (exists(configFile)) {
    const raw = readFile(configFile);
    if (raw && raw.trim().length > 0) {
      try {
        config = JSON.parse(raw);
      } catch (err) {
        return {
          registered: false,
          configFile,
          error: `Failed to parse existing MCP config at ${configFile}: ${(err as Error).message}`,
        };
      }
    }
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  const existing = config.mcpServers["pr-hero"];
  if (
    existing &&
    existing.command === reg.command &&
    JSON.stringify(existing.args) === JSON.stringify(reg.args)
  ) {
    return {
      registered: true,
      alreadyRegistered: true,
      configFile,
    };
  }

  // Backup original config if it existed
  if (exists(configFile)) {
    const raw = readFile(configFile);
    if (raw) {
      await writeFile(`${configFile}.bak`, raw);
    }
  }

  config.mcpServers["pr-hero"] = {
    command: reg.command,
    args: reg.args,
  };

  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);

  return {
    registered: true,
    configFile,
  };
}

export function inspectMcpRegistration(
  env: AgentEnvDetection,
  reg: McpRegistration,
  options: {
    exists?: (p: string) => boolean;
    readFile?: (p: string) => string | undefined;
  } = {},
): boolean {
  if (!env.mcpConfigFile) return false;
  const exists = options.exists ?? existsSync;
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });

  if (!exists(env.mcpConfigFile)) return false;
  try {
    const raw = readFile(env.mcpConfigFile);
    if (!raw) return false;
    const config = JSON.parse(raw);
    const server = config.mcpServers?.["pr-hero"];
    if (!server) return false;
    return (
      server.command === reg.command &&
      JSON.stringify(server.args) === JSON.stringify(reg.args)
    );
  } catch {
    return false;
  }
}
