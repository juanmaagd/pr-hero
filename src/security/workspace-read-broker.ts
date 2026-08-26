import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export type WorkspaceDenialCode = "path_not_approved";

// Git's global/one-shot config and repo-redirection flags can repoint git at
// an arbitrary tree or inject config from env without touching args order —
// none of them are ever legitimate inside a brokered read.
const DENIED_GIT_FLAGS = [
  "--git-dir",
  "--work-tree",
  "--super-prefix",
  "--namespace",
  "--exec-path",
  "-c",
] as const;

export const GIT_NOT_FOUND_STDERR = "git not found at pinned paths";

const PINNED_GIT_PATHS = [
  "/usr/bin/git",
  "/opt/homebrew/bin/git",
  "/usr/local/bin/git",
] as const;

export function resolvePinnedGitPath(
  override?: string,
  existsFn: (p: string) => boolean = existsSync,
): string | null {
  if (override !== undefined) {
    return existsFn(override) ? override : null;
  }
  for (const candidate of PINNED_GIT_PATHS) {
    if (existsFn(candidate)) return candidate;
  }
  return null;
}

function buildStrippedGitEnv(): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^GIT_/i.test(key)) continue;
    if (value !== undefined) childEnv[key] = value;
  }
  return childEnv;
}

export interface WorkspaceAuthorizationApproved {
  readonly approved: true;
  readonly canonicalPath: string;
  readonly code?: undefined;
  readonly reason?: undefined;
}

export interface WorkspaceAuthorizationDenied {
  readonly approved: false;
  readonly code: WorkspaceDenialCode;
  readonly reason: string;
  readonly canonicalPath?: undefined;
}

export type WorkspaceAuthorizationResult =
  | WorkspaceAuthorizationApproved
  | WorkspaceAuthorizationDenied;

export interface WorkspaceReadBrokerOptions {
  readonly workspaceRoot: string;
  readonly sensitivePatterns?: readonly (string | RegExp)[];
}

function isInsideRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveCanonicalPath(targetPath: string): string | null {
  try {
    return realpathSync(targetPath);
  } catch {
    let curr = path.dirname(targetPath);
    const trail: string[] = [path.basename(targetPath)];
    while (curr !== path.dirname(curr)) {
      if (existsSync(curr)) {
        try {
          const canonicalAncestor = realpathSync(curr);
          return path.join(canonicalAncestor, ...trail);
        } catch {
          return null;
        }
      }
      trail.unshift(path.basename(curr));
      curr = path.dirname(curr);
    }
    return null;
  }
}

export class WorkspaceReadBroker {
  readonly workspaceRoot: string;
  readonly canonicalRoot: string;
  readonly sensitivePatterns: readonly (string | RegExp)[];

  constructor(options: WorkspaceReadBrokerOptions | string) {
    const root = typeof options === "string" ? options : options.workspaceRoot;
    this.workspaceRoot = path.resolve(root);
    try {
      this.canonicalRoot = realpathSync(this.workspaceRoot);
    } catch {
      this.canonicalRoot = this.workspaceRoot;
    }
    this.sensitivePatterns =
      typeof options === "object" && options.sensitivePatterns
        ? options.sensitivePatterns
        : [];
  }

  authorizePath(candidatePath: string): WorkspaceAuthorizationResult {
    const resolvedPath = path.isAbsolute(candidatePath)
      ? path.resolve(candidatePath)
      : path.resolve(this.workspaceRoot, candidatePath);

    const canonical = resolveCanonicalPath(resolvedPath);
    if (!canonical) {
      return {
        approved: false,
        code: "path_not_approved",
        reason: `Could not resolve canonical path for: ${candidatePath}`,
      };
    }

    if (!isInsideRoot(canonical, this.canonicalRoot)) {
      return {
        approved: false,
        code: "path_not_approved",
        reason: `Path escapes workspace root: ${candidatePath} -> ${canonical}`,
      };
    }

    return {
      approved: true,
      canonicalPath: canonical,
    };
  }

  authorizeGitArgs(args: readonly string[]): WorkspaceAuthorizationResult {
    for (const arg of args) {
      const deniedFlag = DENIED_GIT_FLAGS.find((flag) => arg === flag);
      if (deniedFlag !== undefined || arg.startsWith("--config-env")) {
        return {
          approved: false,
          code: "path_not_approved",
          reason: `denied git flag: ${arg}`,
        };
      }
    }

    let currentDir = this.canonicalRoot;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-C") {
        const target = args[i + 1];
        if (!target) {
          return {
            approved: false,
            code: "path_not_approved",
            reason: "Missing directory argument following -C",
          };
        }
        i++;
        const nextResolved = path.isAbsolute(target)
          ? path.resolve(target)
          : path.resolve(currentDir, target);

        const canonical = resolveCanonicalPath(nextResolved);
        if (!canonical || !isInsideRoot(canonical, this.canonicalRoot)) {
          return {
            approved: false,
            code: "path_not_approved",
            reason: `git -C directory escapes workspace root: ${target}`,
          };
        }
        currentDir = canonical;
      }
    }

    return {
      approved: true,
      canonicalPath: currentDir,
    };
  }

  async execGit(
    args: readonly string[],
    options: {
      cwd?: string;
      spawnFn?: typeof Bun.spawn;
      gitPath?: string;
    } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const auth = this.authorizeGitArgs(args);
    if (!auth.approved) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `path_not_approved: ${auth.reason}`,
      };
    }

    // Ambient-PATH git is a hijack surface: spawn only from pinned absolute
    // locations, and never let inherited GIT_* env repoint the child.
    const gitPath = resolvePinnedGitPath(options.gitPath);
    if (gitPath === null) {
      return { exitCode: 127, stdout: "", stderr: GIT_NOT_FOUND_STDERR };
    }

    const spawnFn = options.spawnFn ?? Bun.spawn;
    const proc = spawnFn([gitPath, ...args], {
      cwd: auth.canonicalPath,
      env: buildStrippedGitEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { exitCode, stdout, stderr };
  }
}
