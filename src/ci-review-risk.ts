// Current-head delta risk classification for CI admission (WU-04). Pure — no I/O.
// Unknown never qualifies as safe; only an explicit all-low allowlist may skip.

import { normalizePath } from "./compare";

export const CI_RISK_POLICY_VERSION = 1;

export type RiskClass = "high" | "low" | "unknown";

export interface DeltaRiskAssessment {
  version: typeof CI_RISK_POLICY_VERSION;
  class: RiskClass;
  reason: string;
  changedPaths: readonly string[];
  highRiskPaths: readonly string[];
  lowRiskPaths: readonly string[];
}

export type CompareFileStatus = "added" | "modified" | "removed" | "renamed";

export interface ComparePathStatus {
  path: string;
  status: CompareFileStatus;
}

const HIGH_RISK_GLOBS = [
  "src/**",
  "scripts/**",
  ".github/**",
  "action.yml",
  "package.json",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "npm-shrinkwrap.json",
  "deno.lock",
  "poetry.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "**/auth/**",
  "**/*secret*",
  "**/*credential*",
  "**/*password*",
  "**/.env",
  "**/.env.*",
] as const;

const LOW_RISK_GLOBS = [
  "docs/**",
  "**/*.md",
  "test/**",
  "**/*.test.ts",
  "**/*.spec.ts",
  "fixtures/**",
] as const;

function escapeRegexChar(char: string): string {
  return char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 2;
        } else {
          regex += ".*";
          i += 1;
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    regex += escapeRegexChar(char);
  }
  regex += "$";
  return new RegExp(regex);
}

const HIGH_RISK_REGEXES = HIGH_RISK_GLOBS.map(globToRegExp);
const LOW_RISK_REGEXES = LOW_RISK_GLOBS.map(globToRegExp);

function matchesAnyGlob(path: string, regexes: readonly RegExp[]): boolean {
  return regexes.some((regex) => regex.test(path));
}

function statusByPath(
  compareStatuses: readonly ComparePathStatus[] | undefined,
): Map<string, CompareFileStatus> {
  const out = new Map<string, CompareFileStatus>();
  if (compareStatuses === undefined) return out;
  for (const entry of compareStatuses) {
    out.set(normalizePath(entry.path), entry.status);
  }
  return out;
}

function classifyPath(
  path: string,
  status: CompareFileStatus | undefined,
): "high" | "low" {
  if (status === "removed" || status === "renamed") {
    return "high";
  }
  if (matchesAnyGlob(path, HIGH_RISK_REGEXES)) {
    return "high";
  }
  if (matchesAnyGlob(path, LOW_RISK_REGEXES)) {
    return "low";
  }
  return "high";
}

export function classifyChangedPaths(
  paths: readonly string[],
  compareStatuses?: readonly ComparePathStatus[],
): DeltaRiskAssessment {
  const changedPaths = [...new Set(paths.map(normalizePath))].sort();
  if (changedPaths.length === 0) {
    return {
      version: CI_RISK_POLICY_VERSION,
      class: "unknown",
      reason: "no changed paths in delta metadata",
      changedPaths,
      highRiskPaths: [],
      lowRiskPaths: [],
    };
  }

  const statuses = statusByPath(compareStatuses);
  const highRiskPaths: string[] = [];
  const lowRiskPaths: string[] = [];

  for (const path of changedPaths) {
    const bucket = classifyPath(path, statuses.get(path));
    if (bucket === "high") {
      highRiskPaths.push(path);
    } else {
      lowRiskPaths.push(path);
    }
  }

  if (highRiskPaths.length === 0) {
    return {
      version: CI_RISK_POLICY_VERSION,
      class: "low",
      reason: "all changed paths match the low-risk allowlist",
      changedPaths,
      highRiskPaths,
      lowRiskPaths,
    };
  }
  if (lowRiskPaths.length === 0) {
    return {
      version: CI_RISK_POLICY_VERSION,
      class: "high",
      reason: "delta touches high-risk paths",
      changedPaths,
      highRiskPaths,
      lowRiskPaths,
    };
  }
  return {
    version: CI_RISK_POLICY_VERSION,
    class: "unknown",
    reason: "delta mixes high-risk and low-risk paths",
    changedPaths,
    highRiskPaths,
    lowRiskPaths,
  };
}

export function deltaRiskTriggersReview(
  assessment: DeltaRiskAssessment,
): boolean {
  return assessment.class === "high" || assessment.class === "unknown";
}
