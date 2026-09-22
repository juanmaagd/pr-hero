import path from "node:path";
import { DiversityTargetError } from "./errors";
import type { BenchmarkTarget } from "./identity";

const ALLOWED_GH_FLAGS = new Set([
  "--repo",
  "--base",
  "--head",
  "--two-dot",
  "--yes",
  "--json",
]);

export interface ResolvedTargetIdentity {
  readonly repoRoot: string;
  readonly pr: number;
  readonly baseSha: string;
  readonly headSha: string;
}

export interface GhPrViewFields {
  readonly number: number;
  readonly baseRefOid: string;
  readonly headRefOid: string;
}

function assertArgvOnly(command: readonly string[], label: string): void {
  if (
    !Array.isArray(command) ||
    command.some((part) => typeof part !== "string")
  ) {
    throw new DiversityTargetError(`${label} must be an argv string array`);
  }
  if (command.some((part) => part.includes("\0") || part.includes("\n"))) {
    throw new DiversityTargetError(
      `${label} contains forbidden control characters`,
    );
  }
  const joined = command.join(" ");
  if (joined.includes("&&") || joined.includes("|") || joined.includes(";")) {
    throw new DiversityTargetError(
      `${label} must not be a composed shell command`,
    );
  }
  if (command.some((part) => /^\w+=/.test(part))) {
    throw new DiversityTargetError(
      `${label} must not use environment-prefix injection`,
    );
  }
}

export function resolveGitRepositoryRoot(
  selector: string | readonly string[],
  cwd: string,
): string {
  if (Array.isArray(selector)) {
    assertArgvOnly(selector, "git selector");
    if (selector[0] !== "git") {
      throw new DiversityTargetError("git selector must start with git");
    }
    if (selector[1] === "-C" && typeof selector[2] === "string") {
      return path.resolve(cwd, selector[2]);
    }
    throw new DiversityTargetError("unsupported git argv selector");
  }
  if (typeof selector !== "string") {
    throw new DiversityTargetError("unsupported git selector type");
  }
  if (path.isAbsolute(selector)) {
    return path.resolve(selector);
  }
  return path.resolve(cwd, selector);
}

export function assertSameRepositoryRoot(
  roots: readonly string[],
  label: string,
): string {
  const normalized = roots.map((root) => path.resolve(root));
  const first = normalized[0];
  if (!first) {
    throw new DiversityTargetError(
      `${label} requires at least one repository root`,
    );
  }
  for (const root of normalized.slice(1)) {
    if (root !== first) {
      throw new DiversityTargetError(
        `${label} selectors resolved different repository roots`,
      );
    }
  }
  return first;
}

export function parseGhPrViewArgv(argv: readonly string[]): GhPrViewFields {
  assertArgvOnly(argv, "gh pr view");
  if (argv[0] !== "gh" || argv[1] !== "pr" || argv[2] !== "view") {
    throw new DiversityTargetError("gh argv must be gh pr view");
  }
  for (let i = 3; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    if (!ALLOWED_GH_FLAGS.has(token)) {
      throw new DiversityTargetError(`gh pr view flag not allowed: ${token}`);
    }
  }
  const jsonIndex = argv.indexOf("--json");
  if (jsonIndex === -1) {
    throw new DiversityTargetError("gh pr view requires --json");
  }
  const fields = argv[jsonIndex + 1];
  if (!fields) {
    throw new DiversityTargetError("gh pr view --json requires field list");
  }
  const required = ["number", "baseRefOid", "headRefOid"];
  for (const field of required) {
    if (
      !fields
        .split(",")
        .map((part) => part.trim())
        .includes(field)
    ) {
      throw new DiversityTargetError(
        `gh pr view --json missing field ${field}`,
      );
    }
  }
  return {
    number: 0,
    baseRefOid: "",
    headRefOid: "",
  };
}

export function validateGhPrViewPayload(
  payload: GhPrViewFields,
  frozen: BenchmarkTarget,
): ResolvedTargetIdentity {
  if (payload.number !== frozen.pr) {
    throw new DiversityTargetError(
      `gh pr view number ${payload.number} != frozen pr ${frozen.pr}`,
    );
  }
  if (payload.baseRefOid !== frozen.baseSha) {
    throw new DiversityTargetError(
      "gh pr view baseRefOid drift from frozen baseSha",
    );
  }
  if (payload.headRefOid !== frozen.headSha) {
    throw new DiversityTargetError(
      "gh pr view headRefOid drift from frozen headSha",
    );
  }
  return {
    repoRoot: frozen.repoId,
    pr: frozen.pr,
    baseSha: frozen.baseSha,
    headSha: frozen.headSha,
  };
}

export function validateFrozenExternalTarget(
  frozen: BenchmarkTarget,
  observed: BenchmarkTarget,
): void {
  if (frozen.repoId !== observed.repoId) {
    throw new DiversityTargetError("frozen repoId drift");
  }
  if (frozen.pr !== observed.pr) {
    throw new DiversityTargetError("frozen pr drift");
  }
  if (frozen.baseSha !== observed.baseSha) {
    throw new DiversityTargetError("frozen baseSha drift");
  }
  if (frozen.headSha !== observed.headSha) {
    throw new DiversityTargetError("frozen headSha drift");
  }
}
