import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ExecutableAllowlistEntry } from "./provider-capabilities";

export interface RunnerAuthorityOptions {
  readonly binaryPath?: string;
  readonly workspaceRoot: string;
  readonly env?: { PATH?: string };
}

export interface ResolvedRunnerOptions {
  readonly binaryPath: string;
  readonly workspaceRoot: string;
  readonly executableAllowlist: readonly ExecutableAllowlistEntry[];
}

export type RunnerAuthorityResolution =
  | {
      readonly runnerOptions: ResolvedRunnerOptions;
      readonly error?: undefined;
    }
  | { readonly error: string; readonly runnerOptions?: undefined };

export interface ResolveRunnerAuthorityDeps {
  readonly existsFn?: (p: string) => boolean;
  readonly realpathFn?: (p: string) => Promise<string>;
  readonly readFileFn?: (p: string) => Promise<Uint8Array>;
}

const CLAUDE_BINARY_NAME = "claude";

export async function resolveRunnerAuthority(
  options: RunnerAuthorityOptions,
  deps: ResolveRunnerAuthorityDeps = {},
): Promise<RunnerAuthorityResolution> {
  const exists = deps.existsFn ?? existsSync;
  const toRealpath = deps.realpathFn ?? realpath;
  const readBytes =
    deps.readFileFn ?? ((p: string) => readFile(p) as Promise<Uint8Array>);

  let candidate: string;
  if (options.binaryPath !== undefined) {
    if (!path.isAbsolute(options.binaryPath)) {
      return {
        error: `binary override must be an absolute path: ${options.binaryPath}`,
      };
    }
    candidate = options.binaryPath;
  } else {
    const searchDirs = (options.env?.PATH ?? process.env.PATH ?? "")
      .split(path.delimiter)
      .filter((dir) => dir.length > 0);
    candidate = "";
    for (const dir of searchDirs) {
      const probe = path.join(dir, CLAUDE_BINARY_NAME);
      if (exists(probe)) {
        candidate = probe;
        break;
      }
    }
    if (candidate === "") {
      return { error: "claude binary not found on PATH" };
    }
  }

  try {
    const canonical = await toRealpath(candidate);
    const bytes = await readBytes(canonical);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const sha256 = hasher.digest("hex");
    return {
      runnerOptions: {
        binaryPath: canonical,
        workspaceRoot: options.workspaceRoot,
        executableAllowlist: [{ absolutePath: canonical, sha256 }],
      },
    };
  } catch (error) {
    return {
      error: `failed to resolve claude binary ${candidate}: ${(error as Error).message}`,
    };
  }
}
