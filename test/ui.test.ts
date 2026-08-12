import { describe, expect, test } from "bun:test";
import {
  box,
  row,
  section,
  severityLabel,
  shortPath,
  shortSha,
  styleEnabled,
  truncate,
  wrapText,
} from "../src/ui";

// Built rather than written as a literal: a regex literal carrying a raw ESC
// trips biome's noControlCharactersInRegex.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI, "");

describe("styleEnabled", () => {
  test("needs a TTY and an unset NO_COLOR", () => {
    expect(styleEnabled({ isTTY: true }, {})).toBe(true);
    expect(styleEnabled({ isTTY: false }, {})).toBe(false);
    expect(styleEnabled({}, {})).toBe(false);
  });

  test("ANY value of NO_COLOR disables, including the empty string", () => {
    expect(styleEnabled({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(styleEnabled({ isTTY: true }, { NO_COLOR: "" })).toBe(false);
    expect(styleEnabled({ isTTY: true }, { NO_COLOR: "0" })).toBe(false);
  });
});

describe("wrapText", () => {
  test("wraps on word boundaries", () => {
    expect(wrapText("alpha beta gamma delta", 11)).toEqual([
      "alpha beta",
      "gamma delta",
    ]);
  });

  test("never splits a word that is longer than the width", () => {
    const long = "a".repeat(30);
    expect(wrapText(`hi ${long} bye`, 10)).toEqual(["hi", long, "bye"]);
  });

  test("empty input yields one empty line", () => {
    expect(wrapText("   ", 10)).toEqual([""]);
  });
});

describe("row", () => {
  test("short values stay on one line at the value column", () => {
    expect(row("base", "main", { width: 80 })).toEqual([`  base       main`]);
  });

  test("a fitting value is emitted verbatim, runs of spaces intact", () => {
    const [line] = row("", "reliability  sonnet   always", { width: 80 });
    expect(line).toContain("reliability  sonnet   always");
  });

  test("continuation lines indent to the value column, not column 0", () => {
    const lines = row("estimate", "one two three four five six seven", {
      width: 40,
    });
    expect(lines.length).toBeGreaterThan(1);
    // value column = indent(2) + labelWidth(11) = 13
    for (const line of lines.slice(1)) {
      expect(line.startsWith(" ".repeat(13))).toBe(true);
      expect(line[13]).not.toBe(" ");
    }
    expect(lines.every((l) => l.length <= 40)).toBe(true);
  });

  test("the wrap follows the width it is given", () => {
    const value = "alpha beta gamma delta epsilon zeta eta theta iota";
    const narrow = row("x", value, { width: 40 });
    const wide = row("x", value, { width: 120 });
    expect(narrow.length).toBeGreaterThan(wide.length);
    expect(wide).toHaveLength(1);
  });

  test("a very narrow terminal still leaves a usable value column", () => {
    const lines = row("x", "alpha beta gamma delta epsilon", { width: 10 });
    for (const line of lines.slice(1)) {
      expect(line.startsWith(" ".repeat(13))).toBe(true);
    }
  });

  test("no styles means no escape sequences at all", () => {
    const lines = row("label", "some value that is quite long indeed here", {
      width: 30,
      styles: false,
    });
    expect(lines.join("\n")).not.toContain("\x1b[");
  });

  test("styles paint the label without moving the value column", () => {
    const styled = row("base", "main", { width: 80, styles: true });
    const plain = row("base", "main", { width: 80, styles: false });
    expect(styled[0]).toContain("\x1b[2m");
    expect(stripAnsi(styled[0] ?? "")).toBe(plain[0]);
  });
});

describe("box", () => {
  test("borders close at the requested width", () => {
    const lines = box("pr-hero · PR #6", ["title", "OPEN"], { width: 40 });
    for (const line of lines) expect(line).toHaveLength(40);
    expect(lines[0]?.startsWith("╭─ pr-hero · PR #6 ")).toBe(true);
    expect(lines.at(-1)).toBe(`╰${"─".repeat(38)}╯`);
  });

  test("a title longer than the width is truncated with an ellipsis", () => {
    const lines = box("x".repeat(200), [], { width: 30 });
    expect(lines[0]).toHaveLength(30);
    expect(lines[0]).toContain("…");
    // ╭─ + space + title + space + at least one dash + ╮
    expect(lines[0]?.endsWith("─╮")).toBe(true);
  });

  test("an overlong body line is truncated, never wrapped", () => {
    const lines = box("t", ["y".repeat(200)], { width: 30 });
    expect(lines).toHaveLength(3);
    expect(lines[1]).toHaveLength(30);
    expect(lines[1]).toContain("…");
  });

  test("no styles means no escape sequences at all", () => {
    const lines = box("t", ["body"], { width: 30, styles: false });
    expect(lines.join("\n")).not.toContain("\x1b[");
  });

  test("styled borders keep the same visible text", () => {
    const styled = box("t", ["body"], { width: 30, styles: true });
    const plain = box("t", ["body"], { width: 30, styles: false });
    expect(styled.map((l) => stripAnsi(l))).toEqual(plain);
  });
});

describe("truncate", () => {
  test("leaves a fitting string alone", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });

  test("ellipsises an overlong one to exactly the max", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abcdef", 1)).toBe("…");
    expect(truncate("abcdef", 0)).toBe("");
  });
});

describe("shortSha", () => {
  test("defaults to 10 characters", () => {
    expect(shortSha("17069c751c9f0ab3c2d1ef4455667788990011aa")).toBe(
      "17069c751c",
    );
  });

  test("honours an explicit length and never pads", () => {
    expect(shortSha("17069c751c9f", 4)).toBe("1706");
    expect(shortSha("abc")).toBe("abc");
  });
});

describe("shortPath", () => {
  const home = "/Users/juanma";

  test("renders a path under the root relative to it", () => {
    expect(
      shortPath(
        "/Users/juanma/Desktop/pr-hero/src/ui.ts",
        "/Users/juanma/Desktop/pr-hero",
        home,
      ),
    ).toBe("src/ui.ts");
  });

  test("the root itself renders as its basename", () => {
    expect(
      shortPath(
        "/Users/juanma/Desktop/pr-hero",
        "/Users/juanma/Desktop/pr-hero",
        home,
      ),
    ).toBe("pr-hero");
  });

  test("a sibling that merely shares a prefix is NOT treated as inside", () => {
    expect(
      shortPath(
        "/Users/juanma/Desktop/pr-hero-worktrees/x",
        "/Users/juanma/Desktop/pr-hero",
        home,
      ),
    ).toBe("~/Desktop/pr-hero-worktrees/x");
  });

  test("outside the root, $HOME collapses to ~", () => {
    expect(
      shortPath("/Users/juanma/Desktop/deep-review", undefined, home),
    ).toBe("~/Desktop/deep-review");
    expect(shortPath(home, undefined, home)).toBe("~");
  });

  test("a path outside both is left whole", () => {
    expect(shortPath("/tmp/pr-hero-runs/run-1", "/Users/juanma/x", home)).toBe(
      "/tmp/pr-hero-runs/run-1",
    );
  });
});

describe("severityLabel", () => {
  test("no styles means the bare severity, no escape sequences", () => {
    for (const tier of ["blocking", "advisory"] as const) {
      for (const sev of [
        "BLOCKER",
        "CRITICAL",
        "WARNING",
        "SUGGESTION",
      ] as const) {
        const label = severityLabel(sev, tier, false);
        expect(label).toBe(sev);
        expect(label).not.toContain("\x1b[");
      }
    }
  });

  test("advisory is dimmed whatever the severity", () => {
    expect(severityLabel("BLOCKER", "advisory", true)).toBe(
      "\x1b[2mBLOCKER\x1b[0m",
    );
  });

  test("blocking colours by severity", () => {
    expect(severityLabel("BLOCKER", "blocking", true)).toContain("\x1b[1;31m");
    expect(severityLabel("CRITICAL", "blocking", true)).toContain("\x1b[31m");
    expect(severityLabel("WARNING", "blocking", true)).toContain("\x1b[33m");
    expect(severityLabel("SUGGESTION", "blocking", true)).toContain("\x1b[36m");
  });
});

describe("section", () => {
  test("plain when unstyled, bold when styled", () => {
    expect(section("plan", false)).toBe("plan");
    expect(section("plan", true)).toBe("\x1b[1mplan\x1b[0m");
  });
});
