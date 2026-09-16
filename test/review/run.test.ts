// CLI decomposition P2.1 (odd/tasks/cli-decomposition.md): the pure stages
// `review()` and `reviewPr()` walk identically (or near-identically), pulled
// out of cli.ts so the duplication lives in exactly one place. Every stage
// here reproduces the orchestrators' CURRENT behaviour exactly — this is a
// pure extraction, not a redesign — so each test asserts the concrete values
// the two functions produce today, not a restatement of the implementation.

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { CliError } from "#review/preflight";
import {
  assertDistinctRange,
  buildTelemetry,
  resolveGotchasPath,
  reviewingLine,
  selectActiveHunters,
} from "#review/run";

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

describe("reviewingLine", () => {
  const summaryDisabled = {
    enabled: false,
    model: undefined,
  } as unknown as Parameters<typeof reviewingLine>[1];
  const summaryEnabled = {
    enabled: true,
    model: undefined,
  } as unknown as Parameters<typeof reviewingLine>[1];

  test("singular hunter count reads '1 hunter', no trailing s", () => {
    const line = reviewingLine(1, summaryDisabled, { scout: false });
    expect(line).toBe(
      "reviewing — 1 hunter + refuter + summarizer disabled; comparable trees have taken 8–25 minutes",
    );
  });

  test("plural hunter count reads 'N hunters'", () => {
    const line = reviewingLine(3, summaryDisabled, { scout: false });
    expect(line).toBe(
      "reviewing — 3 hunters + refuter + summarizer disabled; comparable trees have taken 8–25 minutes",
    );
  });

  test("zero hunters still pluralizes (0 !== 1)", () => {
    const line = reviewingLine(0, summaryDisabled, { scout: false });
    expect(line).toBe(
      "reviewing — 0 hunters + refuter + summarizer disabled; comparable trees have taken 8–25 minutes",
    );
  });

  test("summarizer enabled and scout on: both labels appended in order", () => {
    const line = reviewingLine(2, summaryEnabled, { scout: true });
    expect(line).toBe(
      "reviewing — 2 hunters + refuter + summarizer + scout; comparable trees have taken 8–25 minutes",
    );
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
