// Architecture guard C2 (odd/tasks/cli-decomposition.md): value-import cycle guard.
//
// Structural enforcement: value-import cycles in TypeScript can cause runtime TDZ
// (Temporal Dead Zone) crashes or undefined module bindings at module initialization.
//
// Baseline on `dev` is exactly 0 known cycles (the last 5 — the ci/review-admission
// <-> pr/preflight <-> review/preflight triangle, and the four review/step-runner
// <-> execution/harness cycles — were broken by extracting shared leaf modules with
// no back-edges: src/ci/review-policy.ts, src/execution/step-artifacts.ts,
// src/execution/failure-classification.ts, and src/execution/spawned-process.ts).
// No PR or refactor slice may introduce any new value-import cycle. Type-only
// imports (`import type` or `{ type X }`) are excluded as they are completely
// erased by the compiler and cannot cause TDZ issues.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dir, "../..");
const SRC_DIR = path.join(REPO_ROOT, "src");

const pkg = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
);
const importsMap: Record<string, string> = pkg.imports || {};

function getAllTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllTsFiles(full));
    } else if (
      entry.isFile() &&
      full.endsWith(".ts") &&
      !full.endsWith(".d.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (spec.startsWith("#")) {
    for (const [key, target] of Object.entries(importsMap)) {
      if (key.endsWith("/*") && spec.startsWith(key.slice(0, -1))) {
        const sub = spec.slice(key.slice(0, -1).length);
        const resolvedPath = path.join(REPO_ROOT, target.replace("*", sub));
        const candidates = [
          resolvedPath,
          `${resolvedPath}.ts`,
          path.join(resolvedPath, "index.ts"),
        ];
        for (const c of candidates) {
          if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
        }
      } else if (key === spec) {
        const resolvedPath = path.join(REPO_ROOT, target);
        const candidates = [
          resolvedPath,
          `${resolvedPath}.ts`,
          path.join(resolvedPath, "index.ts"),
        ];
        for (const c of candidates) {
          if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
        }
      }
    }
    return null;
  }
  if (spec.startsWith(".")) {
    const dir = path.dirname(fromFile);
    const resolvedPath = path.resolve(dir, spec);
    const candidates = [
      resolvedPath,
      `${resolvedPath}.ts`,
      path.join(resolvedPath, "index.ts"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
  }
  return null;
}

function getValueImports(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf8");
  const imports: string[] = [];

  const importRegex =
    /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;

  for (const match of content.matchAll(importRegex)) {
    const fullClause = match[0];
    const clause = match[1].trim();
    const specifier = match[2];

    if (/^import\s+type\b/.test(fullClause)) {
      continue;
    }

    if (clause.startsWith("{") && clause.endsWith("}")) {
      const inside = clause.slice(1, -1).trim();
      const parts = inside
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const allType =
        parts.length > 0 && parts.every((p) => /^type\s+/.test(p));
      if (allType) continue;
    }

    const resolved = resolveSpecifier(filePath, specifier);
    if (resolved?.startsWith(SRC_DIR)) {
      imports.push(resolved);
    }
  }

  return [...new Set(imports)];
}

function findValueImportCycles(): string[][] {
  const allFiles = getAllTsFiles(SRC_DIR);
  const graph = new Map<string, string[]>();
  for (const file of allFiles) {
    graph.set(file, getValueImports(file));
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack: string[] = [];
  const inStack = new Set<string>();

  function dfs(node: string) {
    visited.add(node);
    stack.push(node);
    inStack.add(node);

    for (const neighbor of graph.get(node) || []) {
      if (!inStack.has(neighbor)) {
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        }
      } else {
        const cycleStartIndex = stack.indexOf(neighbor);
        if (cycleStartIndex !== -1) {
          const cycle = stack.slice(cycleStartIndex);
          cycles.push(cycle);
        }
      }
    }

    stack.pop();
    inStack.delete(node);
  }

  for (const node of allFiles) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  const uniqueCycles: string[][] = [];
  const seenSigs = new Set<string>();

  for (const cycle of cycles) {
    let minIdx = 0;
    for (let i = 1; i < cycle.length; i++) {
      if (cycle[i] < cycle[minIdx]) minIdx = i;
    }
    const rotated = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
    const sig = rotated.map((f) => path.relative(SRC_DIR, f)).join(" -> ");
    if (!seenSigs.has(sig)) {
      seenSigs.add(sig);
      uniqueCycles.push(rotated);
    }
  }

  return uniqueCycles;
}

describe("value-import cycle guard (C2)", () => {
  test("value-import cycles do not exceed the baseline of 0", () => {
    const cycles = findValueImportCycles();
    const cycleSignatures = cycles.map(
      (c) =>
        c.map((f) => path.relative(SRC_DIR, f)).join(" -> ") +
        ` -> ${path.relative(SRC_DIR, c[0])}`,
    );

    expect(
      cycles.length,
      `New value-import cycle introduced! Found ${cycles.length} cycles (baseline: 0):\n${cycleSignatures.join("\n")}`,
    ).toBeLessThanOrEqual(0);
  });
});
