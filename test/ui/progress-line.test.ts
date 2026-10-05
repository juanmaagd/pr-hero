// The non-TTY progress renderer (piped/CI output): one plain stderr line per
// pipeline event. #314 is why this file exists — a CI log that read only
// "hunter logic: failed" for every hunter, while the cause (E2BIG from an
// oversized argv) was printed nowhere. The renderer writes through log(), so
// these tests capture process.stderr.write.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startLineRenderer } from "#ui/progress";

const realWrite = process.stderr.write.bind(process.stderr);
let written: string[] = [];

beforeEach(() => {
  written = [];
  process.stderr.write = ((chunk: unknown): boolean => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = realWrite;
});

// The text after the "  [<elapsed>] " prefix, which depends on the clock.
function texts(): string[] {
  return written.map((chunk) =>
    chunk.replace(/^ {2}\[[^\]]*\] /, "").trimEnd(),
  );
}

describe("startLineRenderer failure lines", () => {
  test("a failed hunter prints its reason before the reassurance", () => {
    const renderer = startLineRenderer(performance.now());
    renderer.onProgress({
      kind: "hunter-finished",
      hunter: "logic",
      ok: false,
      durationMs: 7_000,
      reason: "spawn failed: E2BIG: argument list too long; no child started",
    });
    expect(texts()).toEqual([
      "hunter logic: failed — spawn failed: E2BIG: argument list too long; no child started (the run continues)",
    ]);
    expect(written.join("")).not.toContain("\x1b");
  });

  test("a failure with no reason keeps the original wording", () => {
    const renderer = startLineRenderer(performance.now());
    renderer.onProgress({
      kind: "hunter-finished",
      hunter: "logic",
      ok: false,
      durationMs: 7_000,
    });
    renderer.onProgress({
      kind: "summarizer-finished",
      ok: false,
      durationMs: 1_000,
    });
    expect(texts()).toEqual([
      "hunter logic: failed (the run continues)",
      "summarizer: failed (the run continues)",
    ]);
  });

  test("a done hunter and a failed summarizer with a reason", () => {
    const renderer = startLineRenderer(performance.now());
    renderer.onProgress({
      kind: "hunter-finished",
      hunter: "logic",
      ok: true,
      durationMs: 7_000,
      drafts: 2,
    });
    renderer.onProgress({
      kind: "summarizer-finished",
      ok: false,
      durationMs: 1_000,
      reason: "API Error: Connection closed mid-response",
    });
    expect(texts()).toEqual([
      "hunter logic: done",
      "summarizer: failed — API Error: Connection closed mid-response (the run continues)",
    ]);
    expect(written.join("")).not.toContain("\x1b");
  });
});
