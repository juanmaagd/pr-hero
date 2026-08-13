// The panel renderer's post-stop silence, which is a CRITICAL invariant rather
// than a cosmetic one.
//
// pr-hero found this reviewing its own PR #7 (F002, CRITICAL, corroborated,
// deterministic). The mechanism, end to end:
//
//   1. runPipeline races execute() against a whole-run ceiling, and on firing
//      the in-flight step promises are ABANDONED, not awaited (pipeline.ts).
//   2. Those abandoned steps' settle handlers emit `hunter-finished`
//      unconditionally — nothing checks whether the run already ended.
//   3. cli.ts prints the result block BELOW the panel's final frame.
//   4. draw() moves the cursor back up over the frame and then issues
//      \x1b[0J — erase from the cursor to the end of the screen.
//
// So one late event after stop() erases the findings of a paid run. The \x1b[0J
// that fixed the shrinking-frame bug is exactly what made this destructive, so
// the two must be tested together: the erase must still be emitted while drawing
// (or orphan rows come back), and no draw may happen after stop().

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startPanelRenderer } from "../src/cli";

const realWrite = process.stderr.write.bind(process.stderr);
const realIsTty = process.stderr.isTTY;
let written: string[] = [];

beforeEach(() => {
  written = [];
  // A TTY is what the panel renderer is for; the non-TTY path is a different
  // renderer entirely (startLineRenderer) and production's actual path.
  Object.defineProperty(process.stderr, "isTTY", {
    value: true,
    configurable: true,
  });
  process.stderr.write = ((chunk: unknown): boolean => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = realWrite;
  Object.defineProperty(process.stderr, "isTTY", {
    value: realIsTty,
    configurable: true,
  });
});

const panel = () => startPanelRenderer(performance.now(), "PR #7", ["a", "b"]);

describe("startPanelRenderer post-stop silence", () => {
  test("a progress event after stop() writes NOTHING", () => {
    const p = panel();
    p.stop();
    written = [];

    p.onProgress({
      kind: "hunter-finished",
      hunter: "a",
      ok: true,
      durationMs: 1000,
    });

    // Not "no escape codes" — no bytes at all. Any write here means the cursor
    // moved above a result block that is already on screen.
    expect(written).toEqual([]);
  });

  test("the erase-to-end-of-screen never reaches the terminal after stop()", () => {
    const p = panel();
    p.stop();
    written = [];
    p.onProgress({ kind: "dedupe-finished", drafts: 2, findings: 1 });
    p.onProgress({ kind: "refuter-started", severeFindings: 1 });
    expect(written.join("")).not.toContain("\x1b[0J");
  });

  test("stop() is idempotent: a second call redraws nothing", () => {
    const p = panel();
    p.stop();
    written = [];
    p.stop();
    expect(written).toEqual([]);
  });

  test("stop() still performs its own final draw, flag or no flag", () => {
    // The guard must not turn stop() itself into a no-op — the last frame is
    // the run's static record.
    const p = panel();
    written = [];
    p.stop();
    expect(written.length).toBeGreaterThan(0);
    // And that final draw still erases below itself, or a collapsed branch
    // leaves orphaned rows on screen.
    expect(written.join("")).toContain("\x1b[0J");
  });

  test("before stop(), events draw normally", () => {
    const p = panel();
    written = [];
    p.onProgress({
      kind: "hunter-finished",
      hunter: "a",
      ok: true,
      durationMs: 1000,
    });
    expect(written.length).toBeGreaterThan(0);
  });
});
