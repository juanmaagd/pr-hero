// Offline tests for the one corpus.ts decision that cannot live in
// corpus-preflight.ts: whether a commit→PR lookup ANSWERED. Same fake-spawn
// pattern as test/pr.test.ts — no real gh anywhere here, and the `spawnFn`
// seam is the only thing these tests need from the shell.
//
// The defect under test (2026-08-17): `ghCommitPulls` returned `[]` for both a
// 404 and a 200 listing zero PRs, so the caller recorded `introducer.pr = null`
// either way, the tier ladder read that as a direct push, and a run degraded by
// transient GitHub failures produced an artifact byte-indistinguishable from a
// complete one (12 blame-linked candidates against a clean re-run's 428).

import { describe, expect, test } from "bun:test";
import { ghCommitPulls } from "../src/corpus";

interface ScriptedResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function makeFakeGh(response: ScriptedResponse): {
  spawnFn: typeof Bun.spawn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const encoder = new TextEncoder();
  const spawnFn = ((argv: string[]) => {
    calls.push(argv);
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    return {
      stdout: stream(response.stdout ?? ""),
      stderr: stream(response.stderr ?? ""),
      exited: Promise.resolve(response.exitCode ?? 0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

const OPERATOR_ROOT = "/repo";
const SLUG = "MusiveTech/musive";
const SHA = "a".repeat(40);

describe("ghCommitPulls — a failed lookup is not an empty answer", () => {
  test("a 404 is `not found`, never an empty list", async () => {
    const { spawnFn, calls } = makeFakeGh({
      stderr: "gh: Not Found (HTTP 404)",
      exitCode: 1,
    });
    const lookup = await ghCommitPulls(OPERATOR_ROOT, SLUG, SHA, { spawnFn });
    expect(lookup.found).toBe(false);
    // One call: a 404 is NOT_TRANSIENT, so the retry ladder must not run.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.join(" ")).toContain(`repos/${SLUG}/commits/${SHA}/pulls`);
  });

  test("a 200 listing zero PRs is an ANSWER — an empty list", async () => {
    const { spawnFn } = makeFakeGh({ stdout: "[]" });
    const lookup = await ghCommitPulls(OPERATOR_ROOT, SLUG, SHA, { spawnFn });
    expect(lookup.found).toBe(true);
    expect(lookup.found && lookup.pulls).toEqual([]);
  });

  test("the two outcomes are distinguishable, which is the whole point", async () => {
    const notFound = await ghCommitPulls(OPERATOR_ROOT, SLUG, SHA, {
      spawnFn: makeFakeGh({ stderr: "HTTP 404", exitCode: 1 }).spawnFn,
    });
    const empty = await ghCommitPulls(OPERATOR_ROOT, SLUG, SHA, {
      spawnFn: makeFakeGh({ stdout: "[]" }).spawnFn,
    });
    expect(notFound).not.toEqual(empty);
  });

  test("a real answer carries the PRs", async () => {
    const { spawnFn } = makeFakeGh({
      stdout: JSON.stringify([
        {
          number: 478,
          title: "feat: username cannot change",
          merged_at: "2026-01-02T00:00:00Z",
        },
      ]),
    });
    const lookup = await ghCommitPulls(OPERATOR_ROOT, SLUG, SHA, { spawnFn });
    expect(lookup.found && lookup.pulls.map((pull) => pull.number)).toEqual([
      478,
    ]);
  });

  test("anything that is not a 404 still throws — fail-loud is not a counter", async () => {
    // "bad credentials" is one of gh()'s NOT_TRANSIENT signatures, so this
    // asserts the throw without paying the 12s retry backoff.
    const { spawnFn } = makeFakeGh({
      stderr: "gh: Bad credentials (HTTP 401)",
      exitCode: 1,
    });
    await expect(
      ghCommitPulls(OPERATOR_ROOT, SLUG, SHA, { spawnFn }),
    ).rejects.toThrow(/commits/);
  });
});
