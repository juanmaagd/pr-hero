// CLI decomposition P2.1 (odd/tasks/cli-decomposition.md): the pure stages
// `review()` and `reviewPr()` walk identically (or near-identically), pulled
// out of cli.ts so the duplication lives in exactly one place. Every stage
// here reproduces the orchestrators' CURRENT behaviour exactly — this is a
// pure extraction, not a redesign — so each test asserts the concrete values
// the two functions produce today, not a restatement of the implementation.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GOTCHAS_PLACEHOLDER_MARKER } from "#review/preflight";
import {
  assertDistinctRange,
  buildTelemetry,
  CODEGRAPH_ONLY_MCP_CONFIG,
  EMPTY_MCP_CONFIG,
  prepareRunnerForRoute,
  resolveGotchasPath,
  selectActiveHunters,
  validateGotchas,
  writeMcpConfig,
} from "#review/run";
import { ClaudeCodeRunner } from "#review/step-runner";
import { CliError } from "../../src/errors";

describe("assertDistinctRange", () => {
  test("distinct base and head shas: no throw", () => {
    expect(() => assertDistinctRange("aaa111", "bbb222")).not.toThrow();
  });

  // Exact message text pinned from cli.ts's review()/reviewPr() copies —
  // both read byte-identical apart from indentation.
  test("base === head throws CliError with the exact existing message", () => {
    expect(() => assertDistinctRange("deadbeef", "deadbeef")).toThrow(CliError);
    expect(() => assertDistinctRange("deadbeef", "deadbeef")).toThrow(
      "base and head resolve to the same commit (deadbeef); there is nothing to review",
    );
  });
});

describe("resolveGotchasPath", () => {
  test("--gotchas flag given: path.resolve() of the flag, root ignored", () => {
    expect(resolveGotchasPath("./my-gotchas.md", "/repo/root")).toBe(
      path.resolve("./my-gotchas.md"),
    );
  });

  test("no flag: <root>/.prhero/gotchas.md", () => {
    expect(resolveGotchasPath(undefined, "/repo/root")).toBe(
      path.join("/repo/root", ".prhero", "gotchas.md"),
    );
  });

  test("works for each of the three roots this replaces (repoRoot / operatorRoot / repoDir)", () => {
    for (const root of ["/repo/root", "/operator/root", "/some/repo/dir"]) {
      expect(resolveGotchasPath(undefined, root)).toBe(
        path.join(root, ".prhero", "gotchas.md"),
      );
    }
  });
});

describe("selectActiveHunters", () => {
  const hunterA = {
    key: "a",
    file: "a.md",
    role: "hunter" as const,
  };
  const hunterConditional = {
    key: "b",
    file: "b.md",
    role: "hunter" as const,
    trigger: "input" as const,
  };
  const refuter = {
    key: "refuter",
    file: "refuter.md",
    role: "refuter" as const,
  };

  test("unconditional hunters always run, refuters never do", () => {
    const active = selectActiveHunters([hunterA, refuter], false);
    expect(active).toEqual([hunterA]);
  });

  test("a triggered hunter is excluded when parity does not fire", () => {
    const active = selectActiveHunters([hunterA, hunterConditional], false);
    expect(active).toEqual([hunterA]);
  });

  test("a triggered hunter is included when parity fires", () => {
    const active = selectActiveHunters([hunterA, hunterConditional], true);
    expect(active).toEqual([hunterA, hunterConditional]);
  });
});

describe("buildTelemetry", () => {
  const baseResult = {
    usage: {
      wall_ms: 0,
      tokens_in: 10,
      tokens_out: 20,
      tokens_total: 30,
      cost_usd_est: 0.5,
    },
    perAgent: { reliability: { tokens_total: 30, duration_ms: 100 } },
    unresolved: [],
  } as unknown as Parameters<typeof buildTelemetry>[0];

  test("local mode shape: indexMs 0, no cost_usd_est_is_floor when unresolved is empty", () => {
    const telemetry = buildTelemetry(baseResult, 12345, 0);
    expect(telemetry).toEqual({
      index_ms: 0,
      index_mode: "sync",
      index_disk_mb: 0,
      wall_ms: 12345,
      tokens_in: 10,
      tokens_out: 20,
      tokens_total: 30,
      cost_usd_est: 0.5,
      per_agent: { reliability: { tokens_total: 30, duration_ms: 100 } },
    });
  });

  test("PR mode shape: a measured indexMs is passed through", () => {
    const telemetry = buildTelemetry(baseResult, 999, 4321);
    expect(telemetry.index_ms).toBe(4321);
    expect(telemetry.wall_ms).toBe(999);
  });

  test("a non-empty unresolved list sets cost_usd_est_is_floor: true", () => {
    const resultWithUnresolved = {
      ...baseResult,
      unresolved: [{ reservationId: "r1" }],
    } as unknown as Parameters<typeof buildTelemetry>[0];
    const telemetry = buildTelemetry(resultWithUnresolved, 1, 0);
    expect(telemetry.cost_usd_est_is_floor).toBe(true);
  });
});

describe("writeMcpConfig / validateGotchas (P2.2)", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("writeMcpConfig writes the codegraph server config when available", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-run-mcp-"));
    const mcpConfigPath = path.join(dir, "mcp.json");
    await writeMcpConfig(mcpConfigPath, true);
    expect(JSON.parse(await Bun.file(mcpConfigPath).text())).toEqual(
      CODEGRAPH_ONLY_MCP_CONFIG,
    );
  });

  test("writeMcpConfig writes the empty config when codegraph is unavailable", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-run-mcp-"));
    const mcpConfigPath = path.join(dir, "mcp.json");
    await writeMcpConfig(mcpConfigPath, false);
    expect(JSON.parse(await Bun.file(mcpConfigPath).text())).toEqual(
      EMPTY_MCP_CONFIG,
    );
  });

  test("validateGotchas resolves for real, filled-in content", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-run-gotchas-"));
    const gotchasPath = path.join(dir, "gotchas.md");
    await Bun.write(gotchasPath, "This repo always squashes on merge.");
    await expect(validateGotchas(gotchasPath)).resolves.toBeUndefined();
  });

  test("validateGotchas throws CliError for a missing file (empty)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-run-gotchas-"));
    const gotchasPath = path.join(dir, "does-not-exist.md");
    await expect(validateGotchas(gotchasPath)).rejects.toThrow(CliError);
  });

  test("validateGotchas throws CliError for the unedited scaffold marker", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-run-gotchas-"));
    const gotchasPath = path.join(dir, "gotchas.md");
    await Bun.write(
      gotchasPath,
      `<!-- ${GOTCHAS_PLACEHOLDER_MARKER} -->\nfill me in`,
    );
    await expect(validateGotchas(gotchasPath)).rejects.toThrow(CliError);
  });
});

describe("prepareRunnerForRoute (P2.2)", () => {
  test("legacy path (no route plan): falls back to ClaudeCodeRunner, no transport fields", async () => {
    const ceilingController = new AbortController();
    const onProgress = () => {};
    const prepared = await prepareRunnerForRoute({
      routePlan: undefined,
      productionAdmission: undefined,
      workspaceRoot: "/repo",
      runnerAuthority: {
        runnerOptions: {
          binaryPath: "/usr/local/bin/claude",
          workspaceRoot: "/repo",
          executableAllowlist: [],
        },
      },
      ceilingController,
      onProgress,
    });
    expect(prepared.productionRuntime).toBeUndefined();
    expect(prepared.deps.runner).toBeInstanceOf(ClaudeCodeRunner);
    expect(prepared.deps.ceilingController).toBe(ceilingController);
    expect(prepared.deps.onProgress).toBe(onProgress);
    expect(prepared.deps.transportRegistry).toBeUndefined();
    expect(prepared.deps.admissionEvidence).toBeUndefined();
  });
});
