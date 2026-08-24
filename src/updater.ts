import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectAgentEnvironments,
  registerMcpServer,
  syncSkills,
} from "./agent-env";
import { resolveEngineAssets, selfInvocation } from "./assets";
import { runDoctor } from "./doctor";

export const PRHERO_GITHUB_REPO = "Gentleman-Programming/pr-hero";

export type InstallMethodKind = "standalone" | "package_manager" | "source";

export type InstallMethod =
  | { kind: "standalone"; binaryPath: string }
  | { kind: "package_manager"; manager: "npm" | "bun" }
  | { kind: "source" };

export interface DetectInstallMethodOptions {
  execPath?: string;
  home?: string;
  version?: string;
  isDev?: boolean;
  exists?: (p: string) => boolean;
}

export function detectInstallMethod(
  options: DetectInstallMethodOptions = {},
): InstallMethod {
  const home = options.home ?? os.homedir();
  const execPath = options.execPath ?? process.execPath;
  const version = options.version ?? "0.1.0";
  const exists = options.exists ?? existsSync;

  const isSource =
    options.isDev !== undefined
      ? options.isDev
      : version === "dev" ||
        (exists("./src/cli.ts") && !execPath.includes(".prhero/bin"));

  if (isSource) {
    return { kind: "source" };
  }

  const standaloneBinDir = path.join(home, ".prhero", "bin");
  if (
    execPath.startsWith(standaloneBinDir) ||
    path.resolve(execPath).startsWith(path.resolve(standaloneBinDir))
  ) {
    return { kind: "standalone", binaryPath: execPath };
  }

  return {
    kind: "package_manager",
    manager: execPath.includes("bun") ? "bun" : "npm",
  };
}

export interface DetectShadowInstallsOptions {
  currentBinary: string;
  which?: (bin: string) => Promise<string[]> | string[];
}

export async function detectShadowInstalls(
  options: DetectShadowInstallsOptions,
): Promise<string[]> {
  const which =
    options.which ??
    (async (bin: string) => {
      const found = Bun.which(bin);
      return found ? [found] : [];
    });

  const allFound = await which("pr-hero");
  const normalizedCurrent = path.resolve(options.currentBinary);

  return allFound
    .map((p) => path.resolve(p))
    .filter((p) => p !== normalizedCurrent);
}

export interface UpgradeCheckCache {
  checked_at: string;
  current_version: string;
  latest_version: string;
  reconciled_version?: string;
  release_url?: string;
  changelog?: string;
}

export function isCheckCacheFresh(
  cache?: UpgradeCheckCache,
  nowMs = Date.now(),
  ttlMs = 24 * 3600 * 1000,
): boolean {
  if (!cache?.checked_at) return false;
  const checkedAtMs = Date.parse(cache.checked_at);
  if (Number.isNaN(checkedAtMs)) return false;
  return nowMs - checkedAtMs < ttlMs;
}

export function readUpgradeCache(
  cachePath: string,
  options: {
    readFile?: (p: string) => string | undefined;
    exists?: (p: string) => boolean;
  } = {},
): UpgradeCheckCache | undefined {
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });
  const exists =
    options.exists ??
    (options.readFile ? (p: string) => readFile(p) !== undefined : existsSync);

  if (!exists(cachePath)) return undefined;
  try {
    const raw = readFile(cachePath);
    if (!raw) return undefined;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function writeUpgradeCache(
  cachePath: string,
  cache: UpgradeCheckCache,
  options: {
    writeFile?: (p: string, content: string) => void;
    mkdir?: (p: string, opts?: { recursive?: boolean }) => void;
  } = {},
): void {
  const writeFile =
    options.writeFile ??
    ((p: string, c: string) => {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, c, "utf-8");
    });

  writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
}

export interface UpgradePlan {
  action:
    | "upgrade_standalone"
    | "upgrade_package_manager"
    | "noop_source"
    | "up_to_date";
  currentVersion: string;
  targetVersion: string;
  targetBinary?: string;
  tempBinary?: string;
  bakBinary?: string;
  downloadUrl?: string;
  checksumsUrl?: string;
  steps: string[];
  message?: string;
}

export interface PlanUpgradeOptions {
  installMethod: InstallMethod;
  currentVersion: string;
  targetVersion: string;
  home?: string;
  platform?: string;
  arch?: string;
}

export async function planUpgrade(
  options: PlanUpgradeOptions,
): Promise<UpgradePlan> {
  const { installMethod, currentVersion, targetVersion } = options;

  if (installMethod.kind === "source") {
    return {
      action: "noop_source",
      currentVersion,
      targetVersion,
      steps: [],
      message:
        "Running from source checkout / development mode. Use git pull to update.",
    };
  }

  if (currentVersion === targetVersion) {
    return {
      action: "up_to_date",
      currentVersion,
      targetVersion,
      steps: ["reconcile"],
      message: `pr-hero is already up to date (v${currentVersion}).`,
    };
  }

  if (installMethod.kind === "standalone") {
    const targetBinary = installMethod.binaryPath;
    const binDir = path.dirname(targetBinary);
    const rand = crypto.randomBytes(4).toString("hex");
    const tempBinary = path.join(binDir, `pr-hero.tmp.${rand}`);
    const bakBinary = `${targetBinary}.bak`;

    const osName =
      (options.platform ?? os.platform()) === "darwin" ? "darwin" : "linux";
    const rawArch = options.arch ?? os.arch();
    const archName =
      rawArch === "arm64" || rawArch === "aarch64" ? "arm64" : "x64";
    const target = `${osName}-${archName}`;

    const downloadUrl = `https://github.com/${PRHERO_GITHUB_REPO}/releases/download/v${targetVersion}/pr-hero-${target}`;
    const checksumsUrl = `https://github.com/${PRHERO_GITHUB_REPO}/releases/download/v${targetVersion}/SHA256SUMS`;

    return {
      action: "upgrade_standalone",
      currentVersion,
      targetVersion,
      targetBinary,
      tempBinary,
      bakBinary,
      downloadUrl,
      checksumsUrl,
      steps: [
        `Download ${downloadUrl} to ${tempBinary}`,
        `Verify SHA256 against ${checksumsUrl}`,
        `Preserve previous binary as ${bakBinary}`,
        `Atomically replace ${targetBinary}`,
        "Reconcile agent skills, MCP registrations, and SQLite migrations",
      ],
    };
  }

  return {
    action: "upgrade_package_manager",
    currentVersion,
    targetVersion,
    steps: [
      `Run ${installMethod.manager} install -g pr-hero@latest`,
      "Reconcile agent skills, MCP registrations, and SQLite migrations",
    ],
  };
}

export interface ReconcileUpgradeOptions {
  home?: string;
  syncSkills?: () => Promise<{ synced: string[]; errors: string[] }>;
  verifyMcp?: () => Promise<{ ok: boolean }>;
  migrateStore?: () => Promise<{ ok: boolean; version?: number }>;
  reloadDaemons?: () => Promise<{ reloaded: string[] }>;
  runDoctorCheck?: () => Promise<{ overall: string }>;
}

export async function reconcileUpgrade(
  options: ReconcileUpgradeOptions = {},
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  const home = options.home ?? os.homedir();
  const assets = resolveEngineAssets();
  const envs = await detectAgentEnvironments({ home });
  const self = selfInvocation();

  // 1. Sync skills for all active environments
  if (options.syncSkills) {
    const res = await options.syncSkills();
    if (res.errors.length > 0) errors.push(...res.errors);
  } else {
    for (const env of envs) {
      if (env.skillsDir && (env.status === "active" || env.binaryFound)) {
        const res = await syncSkills(env, assets, { force: true });
        if (res.errors.length > 0) errors.push(...res.errors);
      }
    }
  }

  // 2. Verify MCP registration
  if (options.verifyMcp) {
    try {
      await options.verifyMcp();
    } catch (err) {
      errors.push(`MCP verification failed: ${(err as Error).message}`);
    }
  } else {
    for (const env of envs) {
      if (env.mcpConfigFile && (env.status === "active" || env.binaryFound)) {
        try {
          const res = await registerMcpServer(env, {
            command: self.command,
            args: [...self.args, "mcp"],
          });
          if (!res.registered && res.error) {
            errors.push(`${env.displayName} MCP: ${res.error}`);
          }
        } catch (err) {
          errors.push(`${env.displayName} MCP: ${(err as Error).message}`);
        }
      }
    }
  }

  // 3. Store migrations
  if (options.migrateStore) {
    try {
      await options.migrateStore();
    } catch (err) {
      errors.push(`Store migration failed: ${(err as Error).message}`);
    }
  }

  // 4. Reload daemons on macOS
  if (options.reloadDaemons) {
    try {
      await options.reloadDaemons();
    } catch (err) {
      errors.push(`Daemon reload failed: ${(err as Error).message}`);
    }
  }

  // 5. Doctor check
  if (options.runDoctorCheck) {
    try {
      await options.runDoctorCheck();
    } catch (err) {
      errors.push(`Doctor check failed: ${(err as Error).message}`);
    }
  } else {
    try {
      const doc = await runDoctor({ home });
      if (doc.overall === "blocking") {
        errors.push("Doctor check found blocking issues");
      }
    } catch (err) {
      errors.push(`Doctor check error: ${(err as Error).message}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
