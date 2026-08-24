import { describe, expect, test } from "bun:test";
import {
  type ReviewMenuIo,
  type ReviewMenuState,
  renderReviewMenuCard,
  runReviewMenu,
} from "../src/ui-review-menu";
import type { KeyReader } from "../src/ui-select";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI, "");

function fakeReader(chunks: (string | undefined)[], raw = true): KeyReader {
  let i = 0;
  return {
    raw,
    read: () => Promise.resolve(i < chunks.length ? chunks[i++] : undefined),
    close: () => {},
  };
}

function testIo(): ReviewMenuIo & {
  lines: () => string[];
  text: () => string;
} {
  const out: string[] = [];
  return {
    write: (t) => out.push(t),
    line: (t = "") => out.push(`${t}\n`),
    lines: () =>
      stripAnsi(out.join(""))
        .split("\n")
        .map((l) => l.trimEnd()),
    text: () => out.join(""),
  };
}

describe("5.5 Review Submenu", () => {
  const defaultState: ReviewMenuState = {
    target: "branch",
    head: "HEAD",
    base: "main",
    post: false,
    scout: false,
    force: false,
    full: false,
    dryRun: false,
  };

  test("renderReviewMenuCard renders options and toggles cleanly", () => {
    const lines = renderReviewMenuCard(defaultState, 0, 80, false);
    expect(lines[0]).toContain("╔");
    expect(lines.join("\n")).toContain("Target: Local Branch");
    expect(lines.join("\n")).toContain("Start Review");
    expect(lines.at(-1)).toContain("╚");
  });

  test("renderReviewMenuCard produces zero ANSI bytes when styles are false", () => {
    const lines = renderReviewMenuCard(defaultState, 1, 80, false);
    expect(lines.join("\n")).not.toContain("\x1b[");
  });

  test("runReviewMenu allows toggling options and confirms launch", async () => {
    const io = testIo();
    // Move to 'Start Review' and press Enter to launch
    const reader = fakeReader(["j", "j", "\r"]);

    const result = await runReviewMenu({
      createReader: () => reader,
      io,
      styles: false,
      width: 80,
      defaultBase: "main",
    });

    expect(result.action).toBe("launch");
    if (result.action === "launch") {
      expect(result.options).toBeDefined();
      expect(result.options.repo).toBeDefined();
    }
  });

  test("runReviewMenu returns back on q or Esc", async () => {
    const io = testIo();
    const reader = fakeReader(["q"]);

    const result = await runReviewMenu({
      createReader: () => reader,
      io,
      styles: false,
      width: 80,
    });

    expect(result.action).toBe("back");
  });
});
