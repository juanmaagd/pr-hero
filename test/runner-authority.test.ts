import { describe, expect, test } from "bun:test";
import { resolveRunnerAuthority } from "../src/runner-authority";

describe("resolveRunnerAuthority", () => {
  test("resolves an explicit absolute override to canonical path + sha256 allowlist", async () => {
    const bytes = new TextEncoder().encode("#!/bin/sh\necho hi\n");
    const canonical = "/fake/bin/claude";
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const expectedSha = hasher.digest("hex");

    const result = await resolveRunnerAuthority(
      { binaryPath: canonical, workspaceRoot: "/fake/ws" },
      {
        existsFn: () => true,
        realpathFn: async (p) => p,
        readFileFn: async () => bytes,
      },
    );

    expect(result.error).toBeUndefined();
    if (result.error !== undefined || result.runnerOptions === undefined)
      return;
    expect(result.runnerOptions.binaryPath).toBe(canonical);
    expect(result.runnerOptions.workspaceRoot).toBe("/fake/ws");
    expect(result.runnerOptions.executableAllowlist).toEqual([
      { absolutePath: canonical, sha256: expectedSha },
    ]);
  });

  test("without an override, searches the injected PATH dirs in order", async () => {
    const result = await resolveRunnerAuthority(
      {
        workspaceRoot: "/fake/ws",
        env: { PATH: "/first:/second:/third" },
      },
      {
        existsFn: (p) => p === "/second/claude",
        realpathFn: async (p) => `/real${p}`,
        readFileFn: async () => new Uint8Array([1, 2, 3]),
      },
    );

    expect(result.error).toBeUndefined();
    if (result.runnerOptions === undefined) return;
    expect(result.runnerOptions.binaryPath).toBe("/real/second/claude");
    expect(result.runnerOptions.executableAllowlist[0].absolutePath).toBe(
      "/real/second/claude",
    );
  });

  test("missing binary on PATH yields an error", async () => {
    const result = await resolveRunnerAuthority(
      { workspaceRoot: "/fake/ws", env: { PATH: "/empty" } },
      {
        existsFn: () => false,
        realpathFn: async (p) => p,
        readFileFn: async () => new Uint8Array(),
      },
    );

    expect(result.error).toBeDefined();
    expect(result.error).toContain("not found");
  });

  test("relative binary override is rejected", async () => {
    const result = await resolveRunnerAuthority(
      { binaryPath: "bin/claude", workspaceRoot: "/fake/ws" },
      {
        existsFn: () => true,
        realpathFn: async (p) => p,
        readFileFn: async () => new Uint8Array(),
      },
    );

    expect(result.error).toBeDefined();
    expect(result.error).toContain("absolute path");
  });
});
