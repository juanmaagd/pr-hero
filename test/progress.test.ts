// Offline tests for the progress panel's pure half: state transitions under
// the pipeline event stream, and the frame text each state renders. The
// redraw/ticker mechanics in cli.ts are I/O, untested by construction.

import { describe, expect, test } from "bun:test";
import {
  applyProgressEvent,
  createPanelState,
  type PanelState,
  renderPanelLines,
  SPINNER_FRAMES,
} from "../src/progress";

function freshState(): PanelState {
  return createPanelState("PR #1682", 0, ["reliability", "resilience"]);
}

// colors: false everywhere except the color test — plain text is what the
// transition assertions are about.
function lines(state: PanelState, nowMs: number, frame = 0): string[] {
  return renderPanelLines(state, nowMs, frame, false);
}

describe("panel state transitions", () => {
  test("seeded rows wait, with the subject and elapsed in the header", () => {
    const rendered = lines(freshState(), 192_000);
    expect(rendered[0]).toBe(`${SPINNER_FRAMES[0]} reviewing PR #1682 — 3m12s`);
    expect(rendered[1]).toBe("· reliability waiting");
    expect(rendered[2]).toBe("· resilience waiting");
    expect(rendered).toHaveLength(3);
  });

  test("hunters-started flips the named rows to running with elapsed", () => {
    const state = freshState();
    applyProgressEvent(
      state,
      { kind: "hunters-started", hunters: ["reliability", "resilience"] },
      1_000,
    );
    const rendered = lines(state, 63_000);
    // Elapsed measured from the fan-out's own start, not the panel's.
    expect(rendered[1]).toBe(`${SPINNER_FRAMES[0]} reliability running… 1m02s`);
    expect(rendered[2]).toBe(`${SPINNER_FRAMES[0]} resilience running… 1m02s`);
  });

  test("a key the seed missed is added by the authoritative event", () => {
    const state = createPanelState("PR #1682", 0, ["reliability"]);
    applyProgressEvent(
      state,
      { kind: "hunters-started", hunters: ["reliability", "parity"] },
      0,
    );
    const rendered = lines(state, 0);
    expect(rendered.some((line) => line.includes("parity running…"))).toBe(
      true,
    );
  });

  test("hunter-finished renders done-with-duration or the honest failure", () => {
    const state = freshState();
    applyProgressEvent(
      state,
      { kind: "hunters-started", hunters: ["reliability", "resilience"] },
      0,
    );
    applyProgressEvent(
      state,
      {
        kind: "hunter-finished",
        hunter: "reliability",
        ok: true,
        durationMs: 122_000,
      },
      122_000,
    );
    applyProgressEvent(
      state,
      {
        kind: "hunter-finished",
        hunter: "resilience",
        ok: false,
        durationMs: 60_000,
      },
      122_000,
    );
    const rendered = lines(state, 122_000);
    expect(rendered[1]).toBe("✓ reliability done 2m02s");
    expect(rendered[2]).toBe("✗ resilience failed (the run continues)");
  });

  test("dedupe appends the hunters-done row", () => {
    const state = freshState();
    applyProgressEvent(
      state,
      { kind: "dedupe-finished", drafts: 6, findings: 4 },
      0,
    );
    expect(lines(state, 0)).toContain(
      "✓ hunters done — 6 drafts -> 4 findings",
    );
  });

  test("the refuter row counts settles, names the last, then closes", () => {
    const state = freshState();
    applyProgressEvent(
      state,
      { kind: "refuter-started", severeFindings: 2 },
      0,
    );
    // Before the first settle there is no finding id to name.
    expect(lines(state, 0)).toContain(
      `${SPINNER_FRAMES[0]} refuter — judging (0 of 2)…`,
    );
    applyProgressEvent(
      state,
      {
        kind: "refuter-step-finished",
        findingId: "F001",
        verdict: "corroborated",
        durationMs: 1,
      },
      0,
    );
    expect(lines(state, 0)).toContain(
      `${SPINNER_FRAMES[0]} refuter — judging F001 (1 of 2)…`,
    );
    applyProgressEvent(
      state,
      {
        kind: "refuter-step-finished",
        findingId: "F002",
        verdict: "refuted",
        durationMs: 1,
      },
      0,
    );
    expect(lines(state, 0)).toContain("✓ refuter — 2 judged");
  });

  test("the spinner advances with the frame index and wraps", () => {
    const state = freshState();
    expect(lines(state, 0, 1)[0]?.startsWith(SPINNER_FRAMES[1])).toBe(true);
    expect(
      lines(state, 0, SPINNER_FRAMES.length)[0]?.startsWith(SPINNER_FRAMES[0]),
    ).toBe(true);
  });

  test("colors paint the symbols and dim the waiting rows only when asked", () => {
    const state = freshState();
    applyProgressEvent(
      state,
      { kind: "hunters-started", hunters: ["reliability"] },
      0,
    );
    applyProgressEvent(
      state,
      {
        kind: "hunter-finished",
        hunter: "reliability",
        ok: true,
        durationMs: 0,
      },
      0,
    );
    const colored = renderPanelLines(state, 0, 0, true);
    expect(colored[1]).toContain("\x1b[32m✓\x1b[0m");
    expect(colored[2]).toContain("\x1b[2m");
    const plain = renderPanelLines(state, 0, 0, false);
    expect(plain.join("\n")).not.toContain("\x1b[");
  });
});
