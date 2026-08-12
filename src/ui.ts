// The terminal surface's pure half: styling, key/value rows, cards and the
// path/sha shorteners every human-readable printer in this CLI shares. Same
// split as progress.ts — everything here is a total function of its inputs
// (the style flag and the width arrive as PARAMETERS, never sniffed inside),
// so the whole layout is testable offline without a TTY. The shells (cli.ts,
// watch.ts) own the one impure decision, `styleEnabled()`, and hand the
// answer down.
//
// Deliberately independent of progress.ts: the two render different things at
// different times and neither should be able to break the other by editing a
// shared constant. The ANSI convention is copied on purpose, not imported.

import { homedir } from "node:os";
import path from "node:path";
import type { Severity, Tier } from "./findings";

// The one shared writer. stderr, ALWAYS: stdout is reserved for the `ledger`
// command's markdown, so every human-readable line in this CLI — plans,
// progress, errors — goes to the other stream or the reserve is worthless.
// Lived in duplicate in cli.ts and watch.ts before this module existed.
export function log(line = ""): void {
  process.stderr.write(`${line}\n`);
}

// NO_COLOR convention, matching progress.ts: style only when the stream we
// write to is a TTY *and* NO_COLOR is unset. ANY value counts, including the
// empty string — `NO_COLOR=` on the command line is still an operator saying
// no, and `=== undefined` is the only test that honours that.
export function styleEnabled(
  stream: { isTTY?: boolean } = process.stderr,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(stream.isTTY) && env.NO_COLOR === undefined;
}

// Width from stdout first (that is the terminal the human sized), stderr as
// the fallback for a piped-stdout run, 80 when neither knows.
export function terminalWidth(): number {
  return process.stdout.columns ?? process.stderr.columns ?? 80;
}

const RESET = "\x1b[0m";

function paint(text: string, code: string, styles: boolean): string {
  return styles ? `\x1b[${code}m${text}${RESET}` : text;
}

export function bold(text: string, styles: boolean): string {
  return paint(text, "1", styles);
}

export function dim(text: string, styles: boolean): string {
  return paint(text, "2", styles);
}

export function red(text: string, styles: boolean): string {
  return paint(text, "31", styles);
}

export function green(text: string, styles: boolean): string {
  return paint(text, "32", styles);
}

export function yellow(text: string, styles: boolean): string {
  return paint(text, "33", styles);
}

export function cyan(text: string, styles: boolean): string {
  return paint(text, "36", styles);
}

// A group heading. Bold, unindented, and never coloured: the rows under it
// carry the colour, and a heading that competes with them costs the eye the
// scan it exists to enable.
export function section(title: string, styles: boolean): string {
  return bold(title, styles);
}

export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return "…";
  return `${text.slice(0, max - 1)}…`;
}

// Word wrap. A single word longer than the width is never split — it goes on
// its own overlong line, because a hard-split sha or path is unusable and a
// wrapped one is merely ugly.
export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  lines.push(current);
  return lines;
}

interface RowOptions {
  width?: number;
  styles?: boolean;
  indent?: number;
  labelWidth?: number;
}

// The indent of the value column: two spaces of margin plus the label field.
const DEFAULT_INDENT = 2;
const DEFAULT_LABEL_WIDTH = 11;
// Below this the value column would leave nothing to wrap into, so a very
// narrow terminal gets an overlong line instead of a one-word-per-line
// column.
const MIN_VALUE_WIDTH = 20;

// One key/value row as its lines. The point of this function — the whole
// reason it exists rather than a `padEnd` template — is that a long value
// wraps to the VALUE COLUMN, not to column 0: base refs, cost bases and
// paths used to fall back to the left margin mid-word and destroy the grid
// that makes a plan scannable.
//
// A value that already fits is emitted VERBATIM, never re-joined: rows that
// align sub-columns with runs of spaces (the agent list) depend on those runs
// surviving, and the wrapper collapses whitespace by construction.
export function row(
  label: string,
  value: string,
  opts: RowOptions = {},
): string[] {
  const indent = opts.indent ?? DEFAULT_INDENT;
  const labelWidth = opts.labelWidth ?? DEFAULT_LABEL_WIDTH;
  const width = opts.width ?? terminalWidth();
  const styles = opts.styles ?? false;
  const valueCol = indent + labelWidth;
  const available = Math.max(width - valueCol, MIN_VALUE_WIDTH);
  const head = " ".repeat(indent) + dim(label.padEnd(labelWidth), styles);
  const pad = " ".repeat(valueCol);
  const chunks =
    value.length <= available ? [value] : wrapText(value, available);
  return chunks.map((chunk, i) => (i === 0 ? head + chunk : pad + chunk));
}

interface BoxOptions {
  width?: number;
  styles?: boolean;
}

const MIN_BOX_WIDTH = 24;
const MAX_BOX_WIDTH = 96;

// A unicode card: `╭─ title ───╮` over a body. Both the title and the body
// lines are truncated to fit rather than wrapped — a card whose border does
// not close reads as corruption, and the facts it summarises are all
// repeated in the rows below it.
export function box(
  title: string,
  body: string[],
  opts: BoxOptions = {},
): string[] {
  const width = Math.max(
    Math.min(opts.width ?? terminalWidth(), MAX_BOX_WIDTH),
    MIN_BOX_WIDTH,
  );
  const styles = opts.styles ?? false;
  const inner = width - 4;
  const shownTitle = truncate(title, width - 6);
  const fill = Math.max(width - 5 - shownTitle.length, 1);
  const lines = [
    dim("╭─ ", styles) +
      bold(shownTitle, styles) +
      dim(` ${"─".repeat(fill)}╮`, styles),
  ];
  for (const line of body) {
    lines.push(
      `${dim("│", styles)} ${truncate(line, inner).padEnd(inner)} ` +
        dim("│", styles),
    );
  }
  lines.push(dim(`╰${"─".repeat(width - 2)}╯`, styles));
  return lines;
}

const SHORT_SHA_LENGTH = 10;

export function shortSha(sha: string, len: number = SHORT_SHA_LENGTH): string {
  return sha.slice(0, len);
}

// A path a human can read at a glance. Relative to `root` when it lives
// under it, `~`-collapsed otherwise: three absolute paths sharing a 60-char
// prefix carry one bit of information each and cost a whole line apiece.
// The FULL path still goes to pipeline.json — this is a display projection.
export function shortPath(
  p: string,
  root?: string,
  home: string = homedir(),
): string {
  if (root !== undefined && root.length > 0) {
    if (p === root) return path.basename(p) || p;
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (p.startsWith(prefix)) return p.slice(prefix.length);
  }
  if (home.length > 0) {
    if (p === home) return "~";
    const prefix = home.endsWith(path.sep) ? home : home + path.sep;
    if (p.startsWith(prefix)) return `~${path.sep}${p.slice(prefix.length)}`;
  }
  return p;
}

// Severity carries the colour, tier carries the weight: an advisory finding
// is dimmed whatever its severity, because the tier is what decides whether
// a human must act and the severity only says how bad it would be.
export function severityLabel(
  severity: Severity,
  tier: Tier,
  styles: boolean,
): string {
  if (!styles) return severity;
  if (tier === "advisory") return dim(severity, true);
  switch (severity) {
    case "BLOCKER":
      return paint(severity, "1;31", true);
    case "CRITICAL":
      return red(severity, true);
    case "WARNING":
      return yellow(severity, true);
    default:
      return cyan(severity, true);
  }
}
