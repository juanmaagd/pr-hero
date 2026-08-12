// A pure tree renderer over box-drawing characters (U+2500–U+257F). Fourth
// member of the terminal surface's pure half (ui.ts formats, ui-select.ts
// asks, ui-result.ts reports, this one nests): same contract as all three —
// a total function of its inputs, with the style flag AND the spinner frame
// arriving as PARAMETERS so nothing here needs a TTY or a timer to be tested.
//
// WHY a component rather than glyphs sprinkled into one panel: three surfaces
// in this CLI show a parent with children — the live progress panel's
// refuter fan-out (its first consumer), the plan card's agent list, and the
// result block's root-cause clusters (`debug.root_causes.clusters` is already
// `RC001 -> [F001, F002]`). Only the first is wired today; the shape below
// deliberately assumes nothing about it.
//
// Deliberately self-contained, matching the rule ui.ts's own header states:
// the ANSI convention is COPIED here, not imported, so that progress.ts —
// which must stay independent of ui.ts — can consume this without acquiring
// that dependency transitively.

export type TreeStatus = "pending" | "running" | "done" | "failed";

export interface TreeNode {
  label: string;
  // Absent → no glyph column at all (a plain nested label).
  status?: TreeStatus;
  // Dim, right of the label. Caller-formatted: a caller aligning sub-columns
  // pads them itself, and the string is emitted VERBATIM inside one dim wrap
  // so those runs of spaces survive (the same rule ui.ts's row() documents).
  detail?: string;
  children?: TreeNode[];
  // Caller's own decision to show a branch as a summary line. Honoured
  // ALWAYS, and never silently: the hidden descendants are counted on the
  // node's own line.
  collapsed?: boolean;
}

export interface TreeOptions {
  styles: boolean;
  // The spinner character for every "running" node — data, not a timer, so a
  // frame is reproducible in a test (renderPanelLines takes it the same way).
  frame: string;
  // Hard ceiling on the returned line count. The panel's redraw does cursor
  // arithmetic against the number of lines it last drew, so a tree that grows
  // past the terminal's height walks the cursor off the top and corrupts the
  // screen. Absent → unbounded (a caller that owns its own space).
  maxLines?: number;
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function paint(text: string, code: string, styles: boolean): string {
  return styles ? `${code}${text}${RESET}` : text;
}

function glyph(status: TreeStatus, opts: TreeOptions): string {
  switch (status) {
    case "pending":
      return paint("·", DIM, opts.styles);
    case "running":
      return opts.frame;
    case "done":
      return paint("✓", GREEN, opts.styles);
    case "failed":
      return paint("✗", RED, opts.styles);
  }
}

// How many LINES a collapsed node stands in for — not how many nodes it
// holds. A child that is itself collapsed contributes its own line only, so
// the count matches what expanding this branch would actually put on screen.
function countDescendants(node: TreeNode): number {
  let total = 0;
  for (const child of node.children ?? []) {
    total += 1 + (child.collapsed === true ? 0 : countDescendants(child));
  }
  return total;
}

// One node's own line. `hidden` > 0 appends the honest count of what this
// line stands in for — a collapsed branch that does not say so is a silent
// truncation of a run's history.
function nodeLine(
  node: TreeNode,
  prefix: string,
  isLast: boolean,
  hidden: number,
  opts: TreeOptions,
): string {
  const connector = paint(isLast ? "└─ " : "├─ ", DIM, opts.styles);
  const head = node.status === undefined ? "" : `${glyph(node.status, opts)} `;
  const detail =
    node.detail === undefined || node.detail.length === 0
      ? ""
      : `  ${paint(node.detail, DIM, opts.styles)}`;
  const folded =
    hidden === 0 ? "" : paint(`  (+${hidden} hidden)`, DIM, opts.styles);
  return `${prefix}${connector}${head}${node.label}${detail}${folded}`;
}

function walk(
  nodes: TreeNode[],
  prefix: string,
  opts: TreeOptions,
  folded: ReadonlySet<TreeNode>,
  out: string[],
): void {
  nodes.forEach((node, i) => {
    const isLast = i === nodes.length - 1;
    const collapsed = node.collapsed === true || folded.has(node);
    const hiddenCount = collapsed ? countDescendants(node) : 0;
    out.push(nodeLine(node, prefix, isLast, hiddenCount, opts));
    if (collapsed) return;
    walk(
      node.children ?? [],
      prefix + (isLast ? "   " : paint("│  ", DIM, opts.styles)),
      opts,
      folded,
      out,
    );
  });
}

// Completed branches, parents first and in document order — which is oldest
// first, so the height budget is paid by the part of the run that already
// settled while the part still moving stays expanded.
function collapseCandidates(nodes: TreeNode[], into: TreeNode[]): TreeNode[] {
  for (const node of nodes) {
    const done = node.status === "done" || node.status === "failed";
    if (done && (node.children?.length ?? 0) > 0 && node.collapsed !== true) {
      into.push(node);
    }
    collapseCandidates(node.children ?? [], into);
  }
  return into;
}

// Renders the tree, then makes it fit — in one place, by ONE mechanism, so
// "collapse a finished branch" and "the terminal is too short" are the same
// operation and cannot drift apart:
//   1. the full tree, when it fits (and always when maxLines is absent);
//   2. completed branches collapsed to their summary line, oldest first,
//      each stating how many lines it stands for;
//   3. still too tall → the MIDDLE elided, keeping the head (which rows
//      exist) and biased toward the tail (what just happened), with the
//      hidden count on its own line.
// What it never does is truncate quietly: every dropped line is counted
// somewhere in the output.
export function renderTree(nodes: TreeNode[], opts: TreeOptions): string[] {
  const render = (folded: ReadonlySet<TreeNode>): string[] => {
    const out: string[] = [];
    walk(nodes, "", opts, folded, out);
    return out;
  };
  const max = opts.maxLines;
  let lines = render(new Set());
  if (max === undefined || lines.length <= max) return lines;
  if (max <= 0) return [];
  const folded = new Set<TreeNode>();
  for (const candidate of collapseCandidates(nodes, [])) {
    folded.add(candidate);
    lines = render(folded);
    if (lines.length <= max) return lines;
  }
  // The elision line costs one of the budget, so head + tail share max - 1.
  const keep = max - 1;
  const hidden = lines.length - keep;
  const note = paint(`⋯ ${hidden} lines hidden`, DIM, opts.styles);
  if (keep <= 0) return [note];
  const headCount = Math.max(Math.floor(keep / 3), 1);
  const tailCount = keep - headCount;
  return [
    ...lines.slice(0, headCount),
    note,
    ...(tailCount > 0 ? lines.slice(lines.length - tailCount) : []),
  ];
}
