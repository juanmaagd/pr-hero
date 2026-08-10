// Greptile comment parser — the other half of the head-to-head benchmark
// (live PRs replacing the aging golden dataset). Pure: no network, no clock,
// no I/O. The driver in scripts/compare-pr.ts owns every side effect, so this
// module can be replayed against a comment body captured months ago and come
// out byte-identical.
//
// WHY parse a comment at all: Greptile leaves ZERO inline review comments on
// this repo (`pulls/{n}/comments` is empty for greptile-apps[bot]). Everything
// it found lives in ONE issue comment, and the only machine-readable copy of
// the findings is the fenced block behind the "Prompt To Fix All With AI"
// disclosure. The prose summary above it is editorialised; the fenced block is
// the literal list, so that is what we parse and nothing else.

export interface GreptileFinding {
  index: number;
  path: string;
  startLine: number;
  // Equal to `startLine` when Greptile cited a single line rather than a range.
  endLine: number;
  title: string;
  description: string;
}

export const GREPTILE_BOT_LOGIN = "greptile-apps[bot]";

// Two header formats observed on real musivetech/musive comments, and they
// coexist in the same repo — the format changed around PR ~1560:
//   old: "### Issue 1 of 4"  (preceded by a "Fix the following N ..." preamble
//        and a leading `---`; NO trailing instruction line)
//   new: "### Issue 1"       (no preamble; a trailing `---` + "For each issue
//        above ..." instruction line closes the block)
// Both are load-bearing: the benchmark reaches back into old PRs for volume.
const ISSUE_HEADER = /^### Issue (\d+)(?: of \d+)?\s*$/;

// Greedy on the path segment so the LAST colon splits location from line
// numbers. A Windows-style or otherwise colon-bearing path would otherwise
// lose its tail to the capture group.
const LOCATION = /^(.+):(\d+)(?:-(\d+))?$/;

const TITLE = /^\*\*(.+)\*\*$/;

const ANCHOR = "Prompt To Fix All With AI";

// The trailing instruction Greptile appends to the new-format block. It is an
// instruction to a fixing agent, NOT a finding, and it sits after the last
// issue's description — so it must be stripped from that description rather
// than parsed as an issue of its own.
// `\s*` spans the blank line Greptile puts between the rule and the sentence.
const TRAILING_INSTRUCTION = /\n\s*(?:---\s*)?For each issue above[\s\S]*$/;

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

interface FencedBlock {
  content: string;
}

// Scans markdown fenced blocks, closing a fence only on a run of backticks at
// least as wide as the one that opened it.
//
// WHY the width matters: Greptile wraps the findings in a FIVE-backtick fence
// (```` ```markdown ````… ) precisely because a description may itself embed a
// three-backtick ```suggestion block (observed on PR 1509). A parser that
// closed on the first ``` would truncate the findings list mid-issue and
// silently under-report Greptile's recall — which is the number this whole
// comparison exists to measure.
function scanFencedBlocks(text: string): FencedBlock[] {
  const lines = text.split("\n");
  const blocks: FencedBlock[] = [];
  let openWidth = 0;
  let buffer: string[] = [];
  for (const line of lines) {
    const fence = /^(`{3,})(.*)$/.exec(line);
    if (openWidth === 0) {
      if (fence) {
        openWidth = fence[1].length;
        buffer = [];
      }
      continue;
    }
    // Only a bare run of backticks closes a fence; an info string means a new
    // (nested, hence ignored) opener.
    if (fence && fence[1].length >= openWidth && fence[2].trim() === "") {
      blocks.push({ content: buffer.join("\n") });
      openWidth = 0;
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  // An unterminated fence still yields whatever it accumulated: a truncated
  // comment body should degrade to partial findings, never to a throw.
  if (openWidth !== 0 && buffer.length > 0) {
    blocks.push({ content: buffer.join("\n") });
  }
  return blocks;
}

function hasIssueHeader(text: string): boolean {
  return text.split("\n").some((line) => ISSUE_HEADER.test(line));
}

// Locates the findings text inside a full comment body.
//
// Preference order, and the WHY for each step:
//  1. after the "Prompt To Fix All With AI" anchor — the canonical location;
//  2. any other fenced block carrying issue headers — covers a comment whose
//     <details> wrapper or summary label changed;
//  3. the raw body — covers a fence-less variant.
// Step 2/3 are safe against the "Fix All in Claude Code" badge links, which
// embed the SAME issue text: those are percent-encoded inside an href
// (`%23%23%23%20Issue%201`), so they cannot match a plain-text `### Issue`
// header and need no special-casing.
function locateFindingsText(body: string): string | null {
  const anchorAt = body.indexOf(ANCHOR);
  if (anchorAt !== -1) {
    const afterAnchor = body.slice(anchorAt + ANCHOR.length);
    const block = scanFencedBlocks(afterAnchor).find((b) =>
      hasIssueHeader(b.content),
    );
    if (block) return block.content;
  }
  const anywhere = scanFencedBlocks(body).find((b) =>
    hasIssueHeader(b.content),
  );
  if (anywhere) return anywhere.content;
  return hasIssueHeader(body) ? body : null;
}

function stripTail(description: string): string {
  let out = description.replace(TRAILING_INSTRUCTION, "").trim();
  // Drop the bare `---` rules Greptile uses as an issue separator in the new
  // format. Only TRAILING ones: a `---` in the middle of a description is the
  // author's prose and stays. Looped because a block can end with several.
  for (;;) {
    const next = out.replace(/(?:^|\n)[ \t]*---[ \t]*$/, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

export function parseGreptileComment(body: string): GreptileFinding[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const text = locateFindingsText(normalizeNewlines(body));
  if (text === null) return [];

  const lines = text.split("\n");
  // Header line numbers, in order. Everything before the first one is discarded
  // — that is exactly the old format's "Fix the following N code review
  // issues" preamble and its leading `---`.
  const headers: { at: number; index: number }[] = [];
  for (const [at, line] of lines.entries()) {
    const match = ISSUE_HEADER.exec(line);
    if (match) headers.push({ at, index: Number(match[1]) });
  }

  const findings: GreptileFinding[] = [];
  for (const [n, header] of headers.entries()) {
    const end = headers[n + 1]?.at ?? lines.length;
    const bodyLines = lines.slice(header.at + 1, end);

    let cursor = 0;
    while (cursor < bodyLines.length && bodyLines[cursor].trim() === "") {
      cursor += 1;
    }
    const locationLine = bodyLines[cursor]?.trim().replace(/^`|`$/g, "") ?? "";
    const location = LOCATION.exec(locationLine);
    // A header with no parseable `path:line` is not a finding we can bucket by
    // location, and location is the ONLY matching signal compareFindings uses.
    // Skipping keeps the rest of the list; throwing would lose a whole PR.
    if (!location) continue;
    cursor += 1;

    const startLine = Number(location[2]);
    const endLine = location[3] === undefined ? startLine : Number(location[3]);

    while (cursor < bodyLines.length && bodyLines[cursor].trim() === "") {
      cursor += 1;
    }
    const titleMatch = TITLE.exec(bodyLines[cursor]?.trim() ?? "");
    // A missing bold title is tolerated (empty string) rather than fatal: the
    // description still carries the mechanism a human needs to judge the match.
    const title = titleMatch ? titleMatch[1].trim() : "";
    if (titleMatch) cursor += 1;

    findings.push({
      index: header.index,
      path: location[1].trim(),
      startLine,
      endLine,
      title,
      description: stripTail(bodyLines.slice(cursor).join("\n")),
    });
  }
  return findings;
}

// Selects Greptile's comment from a PR's issue-comment list.
//
// "Newest, if several" is resolved positionally — LAST match wins — because the
// shape carries no timestamp. GitHub's issue-comments endpoint returns
// creation order ascending, so the driver must preserve API order verbatim
// (it must not sort or reverse) for this to mean what it says.
export function pickGreptileComment(
  bodies: { user: string; body: string }[],
): string | null {
  if (!Array.isArray(bodies)) return null;
  let picked: string | null = null;
  for (const comment of bodies) {
    if (typeof comment?.user !== "string") continue;
    if (comment.user.trim().toLowerCase() !== GREPTILE_BOT_LOGIN) continue;
    if (typeof comment.body !== "string") continue;
    picked = comment.body;
  }
  return picked;
}
