// Domain reorg (odd/tasks/domain-reorg.md): CI configuration references source
// files by PATH STRING, and no gate in this repo reads it. `bun run typecheck`
// covers src/test/fixtures, `bun run check` covers src+test, and `bun test`
// never loads a workflow. So `.github/` and `action.yml` are the one surface
// where a path can rot completely unobserved.
//
// It already happened. PR #232 moved `src/ci-setup.ts` into `src/ci/setup.ts`
// and `action.yml` kept invoking the old path; the review job failed on eight
// consecutive stacked PRs with `Module not found` while tests, typecheck and
// lint stayed green on every one of them. The failure was in the job that runs
// this engine against its own pull requests, so the repo was not reviewing
// itself for eight PRs and nothing said so.
//
// This scan is deliberately dumb: pull every repo-relative-looking path out of
// the CI config and assert the file exists. It cannot check semantics, but the
// defect it guards was never semantic.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github/workflows");

// Anchored on a known top-level directory so prose cannot masquerade as a path.
//
// This regex carries NO lookbehind, and that is the point. The first version
// used `(?<![.\w/-])` to keep `./node_modules/.bin/biome` from reading as
// `bin/biome` -- and it silently also excluded the one reference this test
// exists to catch, because action.yml writes it as
// `${{ github.action_path }}/src/ci/setup.ts`, where the character before
// `src` is a slash. The guard passed against its own founding defect. It was
// caught by mutating it, not by reading it.
//
// node_modules paths are excluded below by looking at what precedes the match
// instead, which cannot swallow a legitimate reference the same way.
const PATH_RE =
  /(src|test|scripts|fixtures|prompts|config|bin)\/[A-Za-z0-9_./-]+/g;

const NODE_MODULES_WINDOW = 24;

function ciConfigFiles(): string[] {
  const files = [path.join(REPO_ROOT, "action.yml")];
  for (const name of readdirSync(WORKFLOWS_DIR)) {
    if (name.endsWith(".yml") || name.endsWith(".yaml")) {
      files.push(path.join(WORKFLOWS_DIR, name));
    }
  }
  return files;
}

function referencedPaths(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const found = new Set<string>();
  for (const match of src.matchAll(PATH_RE)) {
    const at = match.index ?? 0;
    const before = src.slice(Math.max(0, at - NODE_MODULES_WINDOW), at);
    if (before.includes("node_modules")) continue;
    found.add(match[0]);
  }
  return [...found];
}

describe("CI configuration references only paths that exist", () => {
  test("every repo path named in action.yml or a workflow resolves", () => {
    const files = ciConfigFiles();
    // A scan over no files passes vacuously. action.yml plus the workflows is
    // at least two; pin the floor so a renamed directory cannot quietly turn
    // this into a test of nothing.
    expect(files.length).toBeGreaterThanOrEqual(2);

    let checked = 0;
    for (const file of files) {
      for (const referenced of referencedPaths(file)) {
        checked++;
        expect(
          existsSync(path.join(REPO_ROOT, referenced)),
          `${path.basename(file)} references "${referenced}", which does not exist`,
        ).toBe(true);
      }
    }

    // The same vacuity guard one level down: the regex matching nothing at all
    // would leave the loop above empty and green.
    expect(checked).toBeGreaterThan(0);
  });
});
