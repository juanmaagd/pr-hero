// Offline tests for the tree component: connectors, glyphs, the caller's own
// collapse, and — the one that matters for the live panel — the height bound,
// because a tree that outgrows the terminal walks the redraw's cursor
// arithmetic off the top of the screen.

import { describe, expect, test } from "bun:test";
import {
  renderTree,
  type TreeNode,
  type TreeOptions,
  type TreeStatus,
} from "../src/ui-tree";

const plain: TreeOptions = { styles: false, frame: "⠋" };

function leaves(count: number, status: TreeStatus = "done"): TreeNode[] {
  return Array.from({ length: count }, (_, i) => ({
    label: `F${String(i + 1).padStart(3, "0")}`,
    status,
    detail: "corroborated",
  }));
}

describe("renderTree", () => {
  test("siblings get ├─ and the last one └─, children indent under it", () => {
    const lines = renderTree(
      [
        { label: "a", status: "done" },
        {
          label: "b",
          status: "running",
          children: [
            { label: "b1", status: "done" },
            { label: "b2", status: "running" },
          ],
        },
      ],
      plain,
    );
    expect(lines).toEqual(["├─ ✓ a", "└─ ⠋ b", "   ├─ ✓ b1", "   └─ ⠋ b2"]);
  });

  test("a non-last parent keeps a │ rail down its children's column", () => {
    const lines = renderTree(
      [
        { label: "a", status: "done", children: [{ label: "a1" }] },
        { label: "b", status: "running" },
      ],
      plain,
    );
    expect(lines[1]).toBe("│  └─ a1");
  });

  test("each status renders its own glyph and details sit right of the label", () => {
    const lines = renderTree(
      [
        { label: "w", status: "pending", detail: "waiting" },
        { label: "r", status: "running" },
        { label: "d", status: "done", detail: "2m31s   2 drafts" },
        { label: "f", status: "failed" },
        { label: "n" },
      ],
      plain,
    );
    expect(lines[0]).toBe("├─ · w  waiting");
    expect(lines[1]).toBe("├─ ⠋ r");
    expect(lines[2]).toBe("├─ ✓ d  2m31s   2 drafts");
    expect(lines[3]).toBe("├─ ✗ f");
    // No status at all → no glyph column, just the nested label.
    expect(lines[4]).toBe("└─ n");
  });

  test("the frame is data: the running glyph is whatever the caller passes", () => {
    const lines = renderTree([{ label: "r", status: "running" }], {
      styles: false,
      frame: "⠹",
    });
    expect(lines[0]).toBe("└─ ⠹ r");
  });

  test("a caller-collapsed branch hides its children and says how many", () => {
    const lines = renderTree(
      [
        {
          label: "refuter",
          status: "done",
          detail: "2 judged",
          collapsed: true,
          children: leaves(2),
        },
      ],
      plain,
    );
    expect(lines).toEqual(["└─ ✓ refuter  2 judged  (+2 hidden)"]);
  });

  test("no maxLines means no bound: every leaf renders", () => {
    const lines = renderTree(
      [{ label: "refuter", status: "running", children: leaves(40) }],
      plain,
    );
    expect(lines).toHaveLength(41);
  });

  test("over budget, a COMPLETED branch collapses to its summary line", () => {
    const lines = renderTree(
      [
        {
          label: "refuter",
          status: "done",
          detail: "6 judged",
          children: leaves(6),
        },
        { label: "next", status: "running" },
      ],
      { ...plain, maxLines: 4 },
    );
    expect(lines).toEqual(["├─ ✓ refuter  6 judged  (+6 hidden)", "└─ ⠋ next"]);
  });

  test("a branch still running is NOT collapsed to make room — it is elided", () => {
    const lines = renderTree(
      [{ label: "refuter", status: "running", children: leaves(30) }],
      { ...plain, maxLines: 8 },
    );
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe("└─ ⠋ refuter");
    // The head says what exists, the tail is what just happened, and the
    // elision counts itself rather than truncating silently.
    expect(lines[2]).toBe("⋯ 24 lines hidden");
    expect(lines.at(-1)).toBe("   └─ ✓ F030  corroborated");
  });

  test("the bound holds for any leaf count at any small maxLines", () => {
    for (const max of [1, 2, 3, 5, 9, 17]) {
      for (const count of [0, 1, 5, 50, 200]) {
        const lines = renderTree(
          [{ label: "refuter", status: "running", children: leaves(count) }],
          { ...plain, maxLines: max },
        );
        expect(lines.length).toBeLessThanOrEqual(max);
      }
    }
  });

  test("maxLines 1 keeps only the note, and 0 renders nothing", () => {
    const nodes: TreeNode[] = [
      { label: "refuter", status: "running", children: leaves(5) },
    ];
    expect(renderTree(nodes, { ...plain, maxLines: 1 })).toEqual([
      // Six, not five: with no budget left for a single row the parent is
      // hidden too, and the note counts everything it stands for.
      "⋯ 6 lines hidden",
    ]);
    expect(renderTree(nodes, { ...plain, maxLines: 0 })).toEqual([]);
  });

  test("styles paint the glyphs, connectors and details; styles off is bare", () => {
    const nodes: TreeNode[] = [
      { label: "a", status: "done", detail: "ok" },
      { label: "b", status: "failed", children: [{ label: "b1" }] },
      { label: "c", status: "pending", collapsed: true, children: leaves(2) },
    ];
    const styled = renderTree(nodes, { ...plain, styles: true, maxLines: 20 });
    expect(styled[0]).toContain("\x1b[32m✓\x1b[0m");
    expect(styled[0]).toContain("\x1b[2mok\x1b[0m");
    expect(styled[1]).toContain("\x1b[31m✗\x1b[0m");
    expect(styled[0]).toContain("\x1b[2m├─ \x1b[0m");
    const bare = renderTree(nodes, { ...plain, maxLines: 20 });
    expect(bare.join("\n")).not.toContain("\x1b[");
  });

  test("a running leaf takes the caller's frame, wherever it sits", () => {
    const lines = renderTree(
      [{ label: "refuter", status: "running", children: leaves(2, "running") }],
      plain,
    );
    expect(lines[1]).toBe("   ├─ ⠋ F001  corroborated");
  });

  test("styles off leaves no escape byte even on the elided path", () => {
    const lines = renderTree(
      [{ label: "refuter", status: "running", children: leaves(40) }],
      { ...plain, maxLines: 6 },
    );
    expect(lines.join("\n")).not.toContain("\x1b");
  });
});
