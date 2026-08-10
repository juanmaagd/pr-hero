// Head-to-head driver: fetch Greptile's review comment for a real PR, parse it,
// bucket it against a pr-hero findings.json, and render the comparison.
//
// Run:
//   bun run scripts/compare-pr.ts --pr 1677 --findings runs/1677/findings.json \
//     [--repo /Users/juanma/Desktop/musive/musive-s3] [--out compare-1677.md]
//
// STRICTLY READ-ONLY against GitHub: the only network call is `gh api` on the
// issue-comments endpoint with the default GET verb. It never posts, edits,
// closes, or labels anything. Costs nothing and runs no pr-hero review — point
// it at an artifact a review already produced.

import { compareFindings, type PrHeroFindingRef } from "../src/compare";
import { renderComparison } from "../src/compare-report";
import { parseGreptileComment, pickGreptileComment } from "../src/greptile";

function fail(message: string): never {
  console.error(`compare-pr: ${message}`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const prRaw = arg("pr");
const findingsPath = arg("findings");
if (!prRaw || !findingsPath) {
  fail(
    "usage: bun run scripts/compare-pr.ts --pr <n> --findings <path> [--repo <dir>] [--out <file.md>] [--line-window <n>]",
  );
}
const pr = Number(prRaw);
if (!Number.isInteger(pr) || pr <= 0) fail(`--pr must be a positive integer`);

const repo = arg("repo") ?? "/Users/juanma/Desktop/musive/musive-s3";
const outPath = arg("out");
const lineWindowRaw = arg("line-window");
const lineWindow =
  lineWindowRaw === undefined ? undefined : Number(lineWindowRaw);
if (lineWindow !== undefined && !Number.isFinite(lineWindow)) {
  fail("--line-window must be a number");
}

// Args as an ARRAY, never a shell string: `pr` is validated above, but the repo
// path is caller-supplied and a shell string would make it injectable. Bun's
// spawn with an array never involves a shell.
//
// --paginate matters: a busy PR accumulates enough comments to push Greptile's
// off page 1, and a missing comment looks identical to "Greptile found
// nothing" — the exact failure mode that would silently flatter pr-hero.
const proc = Bun.spawn(
  [
    "gh",
    "api",
    "--paginate",
    `repos/{owner}/{repo}/issues/${pr}/comments`,
    "--jq",
    ".[] | {user: .user.login, body: .body}",
  ],
  { cwd: repo, stdout: "pipe", stderr: "pipe" },
);
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);
if (exitCode !== 0) fail(`gh api failed (exit ${exitCode}): ${stderr.trim()}`);

// `--jq` streams one JSON object per line; parsed in API order, which is
// creation order ascending — pickGreptileComment relies on that for "newest".
const comments: { user: string; body: string }[] = [];
for (const line of stdout.split("\n")) {
  if (line.trim() === "") continue;
  try {
    comments.push(JSON.parse(line) as { user: string; body: string });
  } catch {
    fail(`unparseable line from gh api: ${line.slice(0, 120)}`);
  }
}

const greptileBody = pickGreptileComment(comments);
if (greptileBody === null) {
  console.error(
    `compare-pr: no greptile-apps[bot] comment on PR #${pr} — nothing to compare against`,
  );
}
const greptile =
  greptileBody === null ? [] : parseGreptileComment(greptileBody);

// Accepts both artifact shapes: a full FindingsDocument (take `.findings`) and
// a bare array, because run dirs and ad-hoc extracts both exist in the lab.
let raw: unknown;
try {
  raw = await Bun.file(findingsPath).json();
} catch (error) {
  // A mistyped run-dir path is the likeliest way to invoke this wrong; a bare
  // stack trace would read like the comparison itself broke.
  fail(`cannot read ${findingsPath} as JSON: ${(error as Error).message}`);
}
const findingsArray = Array.isArray(raw)
  ? raw
  : ((raw as { findings?: unknown }).findings ?? []);
if (!Array.isArray(findingsArray)) {
  fail(`${findingsPath} has neither a findings[] array nor is one`);
}
const prhero: PrHeroFindingRef[] = (findingsArray as Record<string, unknown>[])
  .filter((f) => typeof f?.path === "string")
  .map((f) => ({
    id: String(f.id ?? ""),
    path: String(f.path),
    line: Number(f.line ?? 0),
    claim: String(f.claim ?? ""),
    tier: String(f.tier ?? ""),
  }));

const result = compareFindings(prhero, greptile, { lineWindow });
const markdown = renderComparison(pr, result);

if (outPath) {
  await Bun.write(outPath, markdown);
  console.error(`compare-pr: wrote ${outPath}`);
} else {
  console.log(markdown);
}
