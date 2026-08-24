import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

describe("Packaging & distribution configuration", () => {
  const rootDir = path.resolve(__dirname, "..");

  test("root LICENSE file exists and is Apache-2.0", () => {
    const licensePath = path.join(rootDir, "LICENSE");
    expect(existsSync(licensePath)).toBe(true);
    const content = readFileSync(licensePath, "utf-8");
    expect(content).toContain("Apache License");
    expect(content).toContain("Version 2.0");
  });

  test("package.json declares Apache-2.0 license and correct distribution metadata", () => {
    const pkgPath = path.join(rootDir, "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);

    expect(pkg.private).toBe(false);
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.engines).toBeDefined();
    expect(pkg.engines.bun).toBeDefined();
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin["pr-hero"]).toBeDefined();
    expect(pkg.files).toBeDefined();
    expect(pkg.files).toContain("prompts");
    expect(pkg.files).toContain("skills/pr-hero-triage");
    expect(pkg.files).toContain("dist");
    expect(pkg.files).not.toContain("docs");
    expect(pkg.files).not.toContain("scripts");
    expect(pkg.files).not.toContain("fixtures");
    expect(pkg.files).not.toContain("test");
    expect(pkg.files).not.toContain("openspec");
    expect(pkg.files).not.toContain("skills/martian-bench");
    expect(pkg.scripts.build).toBeDefined();
  });

  test("bin/pr-hero.js exists and is an executable wrapper", () => {
    const binPath = path.join(rootDir, "bin", "pr-hero.js");
    expect(existsSync(binPath)).toBe(true);
    const content = readFileSync(binPath, "utf-8");
    expect(content).toContain("#!/usr/bin/env bun");
    expect(content).toContain("cli.ts");
  });

  test("install.sh exists, contains OS detection, checksum verification and PATH setup", () => {
    const scriptPath = path.join(rootDir, "install.sh");
    expect(existsSync(scriptPath)).toBe(true);
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("darwin");
    expect(content).toContain("linux");
    expect(content).toContain("SHA256SUMS");
    expect(content).toContain(".prhero/bin");
  });

  test("release workflow exists and defines matrix and artifacts", () => {
    const workflowPath = path.join(
      rootDir,
      ".github",
      "workflows",
      "release.yml",
    );
    expect(existsSync(workflowPath)).toBe(true);
    const content = readFileSync(workflowPath, "utf-8");
    expect(content).toContain("darwin-arm64");
    expect(content).toContain("darwin-x64");
    expect(content).toContain("linux-x64");
    expect(content).toContain("linux-arm64");
    expect(content).toContain("SHA256SUMS");
    expect(content).toContain("--provenance");
  });

  test("build script produces standalone bundle without error", async () => {
    const proc = Bun.spawn(["bun", "run", "build"], {
      cwd: rootDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      console.error(stdout, stderr);
    }
    expect(exitCode).toBe(0);

    const distCliPath = path.join(rootDir, "dist", "cli.js");
    expect(existsSync(distCliPath)).toBe(true);
  });
});
