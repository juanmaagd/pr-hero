import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { wrapBlock } from "../boundary";

export type WorkspaceDenialCode = "path_not_approved";

// §6.2 defaults: per-file 512 KiB, aggregate 8 MiB per broker instance.
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
export const DEFAULT_MAX_AGGREGATE_BYTES = 8 * 1024 * 1024;

// §6.2 item 3 default deny list, applied to the path relative to the root.
// Basename patterns guard the final component; the git entries are exact
// relative paths because their danger is location, not name.
const DEFAULT_SENSITIVE_BASENAME_PATTERNS = [
  /^\.env/,
  /credential/i,
  /secret/i,
  /private[-_]?key/i,
  /\.pem$/i,
  /^id_rsa/,
] as const;

const DEFAULT_SENSITIVE_RELATIVE_PATHS = [
  ".git/config",
  ".git/credentials",
] as const;

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
  readonly maxFileBytes?: number;
  readonly maxAggregateBytes?: number;
}

// §6.3: broker-returned text is untrusted data and must be nonce-delimited and
// labelled before prompt inclusion. "comment_body" is the closest existing
// closed-vocabulary tag; the union is deliberately not widened here.
export interface WorkspaceReadThroughOptions {
  readonly nonce: string;
  readonly lstatFn?: (p: string) => Stats;
  readonly readFileFn?: (p: string) => Buffer;
}

export type WorkspaceReadThroughResult =
  | {
      readonly approved: true;
      readonly bytes: Buffer;
      readonly wrapped: string;
    }
  | WorkspaceAuthorizationDenied;

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
  readonly maxFileBytes: number;
  readonly maxAggregateBytes: number;
  private aggregateBytes = 0;

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
    this.maxFileBytes =
      typeof options === "object" && options.maxFileBytes !== undefined
        ? options.maxFileBytes
        : DEFAULT_MAX_FILE_BYTES;
    this.maxAggregateBytes =
      typeof options === "object" && options.maxAggregateBytes !== undefined
        ? options.maxAggregateBytes
        : DEFAULT_MAX_AGGREGATE_BYTES;
  }

  private checkSensitiveRelative(rel: string): boolean {
    const normalizedRel = rel.split(path.sep).join("/");
    if (
      (DEFAULT_SENSITIVE_RELATIVE_PATHS as readonly string[]).includes(
        normalizedRel,
      )
    ) {
      return true;
    }
    const basename = path.basename(normalizedRel);
    for (const pattern of DEFAULT_SENSITIVE_BASENAME_PATTERNS) {
      if (pattern.test(basename)) return true;
    }
    for (const pattern of this.sensitivePatterns) {
      if (
        typeof pattern === "string"
          ? basename === pattern || normalizedRel === pattern
          : pattern.test(basename) || pattern.test(normalizedRel)
      ) {
        return true;
      }
    }
    return false;
  }

  // §6.2 item 1: realpath alone is not enough for READS — a symlink that
  // resolves to another in-root location passes the containment proof but
  // still lets a reader follow re-pointed components. Returns "" when the
  // candidate cannot be walked lexically below either root spelling (an alias
  // reached through a symlink), else the offending component name, else null.
  private firstSymlinkComponent(resolvedPath: string): string | null {
    const candidates = [this.canonicalRoot, this.workspaceRoot];
    let rel: string | null = null;
    for (const base of candidates) {
      const candidateRel = path.relative(base, resolvedPath);
      if (!candidateRel.startsWith("..") && !path.isAbsolute(candidateRel)) {
        // The root itself has no components below it to inspect.
        if (candidateRel.length === 0) return null;
        rel = candidateRel;
        break;
      }
    }
    // Realpath proved containment, so a lexical path outside both spellings
    // of the root can only be an alias reached through a symlink; fail
    // closed ("" sentinel) rather than walk an attacker-chosen chain.
    if (rel === null) return "";

    let walked = this.canonicalRoot;
    for (const segment of rel.split(path.sep)) {
      walked = path.join(walked, segment);
      let stats: Stats;
      try {
        stats = lstatSync(walked);
      } catch {
        // Not-yet-existing components cannot be symlinks; the subsequent
        // explicit lstat of the final path still gates the read itself.
        break;
      }
      if (stats.isSymbolicLink()) return segment;
    }
    return null;
  }

  // Shared read-path gate: containment (via authorizePath), then per-component
  // symlink rejection (§6.2 item 1), then the sensitive deny list (§6.2 item 3,
  // distinct reason; denied reads never return bytes).
  private authorizeRead(
    lexicalResolvedPath: string,
    canonicalPath: string,
  ): WorkspaceAuthorizationDenied | null {
    const symlinkComponent = this.firstSymlinkComponent(lexicalResolvedPath);
    if (symlinkComponent !== null) {
      return {
        approved: false,
        code: "path_not_approved",
        reason:
          symlinkComponent.length > 0
            ? `Symlink traversal rejected at component '${symlinkComponent}' of ${lexicalResolvedPath}`
            : `Read path does not resolve lexically below the workspace root: ${lexicalResolvedPath}`,
      };
    }

    // The sensitive deny list keys on the root-relative shape of the
    // canonical location so an alias spelling cannot dodge it.
    let relToWorkspace = path.relative(this.workspaceRoot, canonicalPath);
    if (relToWorkspace.startsWith("..") || path.isAbsolute(relToWorkspace)) {
      relToWorkspace = path.basename(canonicalPath);
    }
    if (this.checkSensitiveRelative(relToWorkspace)) {
      return {
        approved: false,
        code: "path_not_approved",
        reason: `Sensitive path denied: ${relToWorkspace.split(path.sep).join("/")}`,
      };
    }

    return null;
  }

  readThrough(
    targetPath: string,
    options: WorkspaceReadThroughOptions,
  ): WorkspaceReadThroughResult {
    const auth = this.authorizePath(targetPath);
    if (!auth.approved) return auth;

    // The component walk must follow the caller's lexical spelling: realpath
    // has already dissolved any symlinks out of auth.canonicalPath.
    const lexicalResolved = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(this.workspaceRoot, targetPath);
    const readDenial = this.authorizeRead(lexicalResolved, auth.canonicalPath);
    if (readDenial !== null) return readDenial;

    const lstatFn = options.lstatFn ?? ((p: string) => lstatSync(p));
    const readFileFn = options.readFileFn ?? ((p: string) => readFileSync(p));

    try {
      const finalStats = lstatFn(auth.canonicalPath);
      // TOCTOU re-check of the final component after authorization.
      if (finalStats.isSymbolicLink()) {
        return {
          approved: false,
          code: "path_not_approved",
          reason: `Symlink traversal rejected at final component of ${targetPath}`,
        };
      }
    } catch {
      return {
        approved: false,
        code: "path_not_approved",
        reason: `Could not stat approved path: ${targetPath}`,
      };
    }

    let bytes: Buffer;
    try {
      bytes = readFileFn(auth.canonicalPath);
    } catch {
      return {
        approved: false,
        code: "path_not_approved",
        reason: `Could not read approved path: ${targetPath}`,
      };
    }

    if (bytes.byteLength > this.maxFileBytes) {
      return {
        approved: false,
        code: "path_not_approved",
        reason: `File exceeds per-file byte bound (${this.maxFileBytes}): ${targetPath} is ${bytes.byteLength} bytes`,
      };
    }

    if (this.aggregateBytes + bytes.byteLength > this.maxAggregateBytes) {
      return {
        approved: false,
        code: "path_not_approved",
        reason: `Aggregate read bound exceeded (${this.maxAggregateBytes}) before ${targetPath}`,
      };
    }
    this.aggregateBytes += bytes.byteLength;

    // §6.3: broker output is untrusted data — nonce-delimited and labelled
    // under an existing closed-vocabulary tag before prompt inclusion.
    return {
      approved: true,
      bytes,
      wrapped: wrapBlock("comment_body", options.nonce, bytes.toString("utf8")),
    };
  }

  resetAggregate(): void {
    this.aggregateBytes = 0;
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
