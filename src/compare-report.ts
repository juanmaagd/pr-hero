// Renders a head-to-head comparison as the markdown a human actually reads.
//
// Pure — no clock, no I/O, no randomness. Same reason as src/report.ts: a
// comparison must be re-renderable from artifacts on disk months later and
// come out byte-identical, otherwise "the report changed" and "the findings
// changed" become indistinguishable in the ledger.

import type { Bucket, ComparisonResult } from "./compare";
import type { GreptileFinding } from "./greptile";

export const BUCKET_HEADINGS: Record<Bucket, string> = {
  // greptile_only leads every rendering: it is the measured miss, and a report
  // that buries it behind the agreements invites the reader to skim past the
  // only number that can move the roadmap.
  greptile_only: "Greptile found, pr-hero missed",
  both: "Both found",
  prhero_only: "pr-hero found, Greptile missed",
};

function location(finding: GreptileFinding): string {
  return finding.startLine === finding.endLine
    ? `${finding.path}:${finding.startLine}`
    : `${finding.path}:${finding.startLine}-${finding.endLine}`;
}

// Blank lines inside a finding's description would break out of the list item
// they are rendered under, so descriptions are emitted as their own paragraph
// under a bolded heading line instead of being squeezed into a bullet.
function block(lines: string[]): string {
  return lines.join("\n");
}

export function renderComparison(pr: number, result: ComparisonResult): string {
  const out: string[] = [];
  out.push(`# Greptile vs pr-hero — PR #${pr}`);
  out.push("");
  out.push(
    `Greptile-only: ${result.greptileOnly.length} · Both: ${result.both.length} · pr-hero-only: ${result.prheroOnly.length}`,
  );
  out.push("");

  out.push(
    `## ${BUCKET_HEADINGS.greptile_only} (${result.greptileOnly.length})`,
  );
  out.push("");
  if (result.greptileOnly.length === 0) {
    // Zero misses because Greptile reported nothing is NOT the same result as
    // zero misses because pr-hero matched everything, and a benchmark that
    // renders them identically invites reading a silent reviewer as a win.
    out.push(
      result.both.length === 0
        ? "_Greptile reported no findings on this PR — there was nothing to miss._"
        : "_None — pr-hero located every finding Greptile reported._",
    );
    out.push("");
  }
  for (const g of result.greptileOnly) {
    out.push(
      block([
        `### G${g.index} — ${g.title || "(untitled)"}`,
        "",
        `\`${location(g)}\``,
        "",
        g.description,
        "",
      ]),
    );
  }

  out.push(`## ${BUCKET_HEADINGS.both} (${result.both.length})`);
  out.push("");
  if (result.both.length === 0) {
    out.push("_No location overlap between the two reviewers._");
    out.push("");
  }
  for (const pair of result.both) {
    // Both sides printed in full, side by side, because the match rule is
    // location-only: a human has to be able to reject a same-location pairing
    // that describes two different defects. See the WHY on compareFindings.
    out.push(
      block([
        `### G${pair.greptile.index} ↔ ${pair.prhero.id} — \`${location(pair.greptile)}\``,
        "",
        `**Greptile:** ${pair.greptile.title || "(untitled)"}`,
        "",
        pair.greptile.description,
        "",
        `**pr-hero (${pair.prhero.tier}, line ${pair.prhero.line}):** ${pair.prhero.claim}`,
        "",
      ]),
    );
  }

  out.push(`## ${BUCKET_HEADINGS.prhero_only} (${result.prheroOnly.length})`);
  out.push("");
  if (result.prheroOnly.length === 0) {
    // An empty bucket has two very different causes and they must not read
    // alike: "everything pr-hero said also came from Greptile" is agreement,
    // while "pr-hero said nothing at all" is silence. Rendering silence as
    // overlap is the same failure the Greptile-side message avoids — a
    // non-result printed as a win.
    out.push(
      result.both.length === 0
        ? "_pr-hero reported no findings on this PR, so there is nothing here — silence, not agreement._"
        : "_None — every pr-hero finding overlapped a Greptile finding._",
    );
    out.push("");
  }
  for (const p of result.prheroOnly) {
    out.push(
      block([
        `### ${p.id} — \`${p.path}:${p.line}\` (${p.tier})`,
        "",
        p.claim,
        "",
      ]),
    );
  }

  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
