// The `.prheroignore` I/O shell. `ignore-file.ts` beside it is the PURE
// half — dialect, translation, matching — and this module is the part that
// touches a filesystem.
//
// It exists as its OWN module rather than living in cli.ts because
// `pr-hero watch` needs the same read, and importing it from cli.ts made
// cli.ts and watch.ts import EACH OTHER (cli.ts already imports
// `watchCommand` from watch.ts for dispatch). That cycle happened to work,
// but only because the binding was an `export async function` DECLARATION:
// function declarations are hoisted and bound at link time, so watch.ts
// could reference it at its own top level before cli.ts's body ran. Convert
// it to `export const … = async () => …` and the same code crashes at
// import time with a ReferenceError, in production only — watch.ts is the
// module required first in the real dispatch path, and test import order
// need not reproduce that.
//
// A load-bearing invariant that no test enforces and only a comment
// protects is the kind that gets refactored away by someone doing something
// else entirely. Breaking the cycle costs one small module and removes the
// invariant instead of documenting it.
//
// The CI counterpart (`readBaseRefIgnoreRules`) deliberately stays in
// cli.ts: it needs that module's own `GitRunner` plumbing, and cli.ts owns
// the CI flow. Both readers share the dialect and the error
// re-contextualizing below, which is the part that must not drift.

import { stat } from "node:fs/promises";
import path from "node:path";
import {
  IgnoreFileError,
  type IgnoreRule,
  parseIgnoreFile,
} from "./ignore-file";
import { CliError } from "./preflight";

export interface IgnoreFileReadResult {
  rules: IgnoreRule[];
  found: boolean;
}

// `IgnoreFileError` hardcodes its file name to the literal ".prheroignore"
// (see ignore-file.ts) because that pure parser never sees which PHYSICAL
// path it was asked to read — a working-tree file and a base-ref blob share
// the same dialect and the same parser. Every caller here re-contextualizes
// the message with whichever path it actually resolved, so the abort names
// something a human can go look at (local: a real filesystem path; CI: a
// `<sha>:.prheroignore` locator, since there is no working-tree path to
// name).
export function reContextualizeIgnoreError(
  error: IgnoreFileError,
  resolvedLocation: string,
): string {
  return error.message.replace(/^\.prheroignore:/, `${resolvedLocation}:`);
}

// Local working-tree read — local review, and PR review without --ci (O-8:
// always `operatorRoot`, never `worktreePath`; see design D3/O-8 and
// isCiEnvironment's own WHY at cli.ts's isCi read sites).
//
// Absent is NOT an error (`.exists()`-style check would suffice for that
// alone), but `Bun.file(...).exists()` ALSO reports false for a directory —
// verified directly — so an absent-vs-directory distinction needs `stat`,
// not `.exists()`. A directory named `.prheroignore`, or one this process
// cannot read, must abort loudly and must NEVER be treated as "absent,
// defaults apply": that silent equivalence is exactly the kind of quiet
// partial review this whole design exists to prevent.
export async function readLocalIgnoreRules(
  root: string,
): Promise<IgnoreFileReadResult> {
  const ignorePath = path.join(root, ".prheroignore");
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(ignorePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { rules: [], found: false };
    }
    throw new CliError(
      `.prheroignore at ${ignorePath} could not be accessed: ` +
        `${(error as Error).message}`,
    );
  }
  if (!fileStat.isFile()) {
    throw new CliError(
      `.prheroignore at ${ignorePath} is not a regular file (found a ` +
        "directory or special file); refusing to read it as ignore rules",
    );
  }
  let text: string;
  try {
    text = await Bun.file(ignorePath).text();
  } catch (error) {
    // The `stat` above already proved it is a regular file, so a read
    // failure here is something else — most likely permission denied.
    throw new CliError(
      `.prheroignore at ${ignorePath} could not be read: ` +
        `${(error as Error).message}`,
    );
  }
  try {
    return { rules: parseIgnoreFile(text, "user"), found: true };
  } catch (error) {
    if (error instanceof IgnoreFileError) {
      throw new CliError(reContextualizeIgnoreError(error, ignorePath));
    }
    throw error;
  }
}
