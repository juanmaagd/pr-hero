// The guard for a whole class of defect the offline suite structurally cannot
// see: anything that behaves differently inside a Bun-compiled binary.
//
// `bun test` always runs from source, so `import.meta.dir` always names a real
// directory and `detectAssetMode()` always answers "dev". Every code path that
// keys off the compiled runtime is therefore unreachable from the suite. That
// is not a coverage gap to backfill with more unit tests — it is a different
// runtime, and the only honest way to test it is to build the artifact and run
// it. Release v1.0.0 shipped a binary whose `review` command failed for 100% of
// users, past 2466 green tests and a green `doctor`, because nothing here
// executed the thing that was published.
//
// What it proves, concretely: the binary boots, resolves its BUNDLED prompt set
// (which lives at hashed paths inside Bun's virtual filesystem, not in any
// directory), reads those prompts, fingerprints them, and prints a plan — with
// no `/$bunfs` path escaping into user-facing output.
//
// Deliberately free: `--dry-run` returns before the capability gate, so this
// needs no `claude`, no authentication and no network, and spawns nothing. It
// costs a compile and about a second.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

// The marker for the bug class. Bun compiles embedded assets to paths under
// this root, and it is not a real directory: any of these reaching the terminal
// means some code path handed a virtual path to something that wanted a file.
const VIRTUAL_FS_MARKER = "/$bunfs";

interface Run {
  code: number;
  output: string; // stdout and stderr together — a leaked path is a defect on either
}

function run(cmd: string[], cwd: string): Run {
  const result = spawnSync(cmd[0] as string, cmd.slice(1), {
    cwd,
    encoding: "utf-8",
    // Reviews shell out to git; PATH must survive. HOME must too, since the
    // run directory lives under ~/.prhero.
    env: process.env,
  });
  return {
    code: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function compileBinary(): string {
  const out = path.join(
    mkdtempSync(path.join(os.tmpdir(), "prhero-smoke-bin-")),
    "pr-hero",
  );
  // The same flags release.yml:48 publishes with, minus --target (host arch is
  // what we can execute) and --minify (irrelevant to asset resolution, and it
  // makes a failure stack unreadable). A smoke built with different flags would
  // be testing a different artifact.
  const built = run(
    [
      "bun",
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--define",
      '__PRHERO_VERSION__="0.0.0-smoke"',
      "src/cli.ts",
      "--outfile",
      out,
    ],
    REPO_ROOT,
  );
  if (built.code !== 0) {
    console.error(built.output);
    throw new Error(`compile failed (exit ${built.code})`);
  }
  return out;
}

// A throwaway repository with exactly one commit of history to review. Small on
// purpose: the size gate's verdict is irrelevant here (a dry run exits 0 either
// way) and a large tree would only make the smoke slower.
function makeFixtureRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prhero-smoke-repo-"));
  const git = (...args: string[]) => {
    const r = run(["git", ...args], dir);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.output}`);
  };
  git("init", "--quiet", "--initial-branch", "main");
  git("config", "user.email", "smoke@example.invalid");
  git("config", "user.name", "smoke");
  // Identity must not be inherited from the developer's global gitconfig, and
  // commit signing must be off: a smoke that prompts for a passphrase hangs CI.
  git("config", "commit.gpgsign", "false");

  // A real repository has been through `pr-hero init`, and the engine refuses
  // to review without a non-empty gotchas file on purpose: an empty one makes
  // the whole review a zero-cost no-op that LOOKS like a clean result. Writing
  // one here reproduces an initialised repo rather than weakening the smoke —
  // without it the run dies on that guard and never reaches the prompt-set
  // resolution this exists to exercise.
  mkdirSync(path.join(dir, ".prhero"), { recursive: true });
  writeFileSync(
    path.join(dir, ".prhero", "gotchas.md"),
    "# Repo gotchas\n\n- smoke: this fixture exists only to boot the engine.\n",
  );

  writeFileSync(path.join(dir, "seed.ts"), "export const seed = 1;\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "seed");

  writeFileSync(
    path.join(dir, "seed.ts"),
    "export const seed = 1;\nexport const added = 2;\n",
  );
  git("add", "-A");
  git("commit", "--quiet", "-m", "change");
  return dir;
}

function check(name: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}`);
  if (!ok) console.log(detail.replace(/^/gm, "        "));
  return ok;
}

async function main(): Promise<number> {
  // Release CI already built the real artifact for its target; re-compiling it
  // here would smoke a DIFFERENT binary from the one it uploads.
  const provided = process.argv[2];
  const binary = provided ?? compileBinary();
  console.log(
    `compiled-smoke: ${provided ? "using provided binary" : "compiled"} ${binary}`,
  );

  const repo = makeFixtureRepo();
  // --out, not a fabricated `origin`. pr-hero keys the global home by origin
  // URL, so a fixture with an invented remote would litter ~/.prhero/repos on
  // every run, on CI and on a developer's machine alike. --out keeps the whole
  // smoke inside temp directories it also removes. It must live OUTSIDE the
  // reviewed repo, hence a sibling rather than a subdirectory.
  const outDir = mkdtempSync(path.join(os.tmpdir(), "prhero-smoke-out-"));
  let passed = true;

  const review = run(
    [
      binary,
      "review",
      "--base",
      "HEAD~1",
      "--dry-run",
      "--yes",
      "--out",
      outDir,
    ],
    repo,
  );
  passed =
    check(
      "review --dry-run exits 0",
      review.code === 0,
      `exit ${review.code}\n${review.output}`,
    ) && passed;
  passed =
    check(
      "review --dry-run leaks no virtual-filesystem path",
      !review.output.includes(VIRTUAL_FS_MARKER),
      review.output,
    ) && passed;
  // The plan card proves the prompt set was not merely resolved but READ: the
  // agent rows are built from parsed prompt bodies.
  passed =
    check(
      "review --dry-run resolved and read the bundled prompt set",
      review.output.includes("AGENTS") && review.output.includes("refuter"),
      review.output,
    ) && passed;

  // doctor's exit code is intentionally not asserted: on a CI runner the Claude
  // Code CLI is absent, which is a legitimate blocking verdict. Only the leak
  // matters here.
  const doctor = run([binary, "doctor"], repo);
  passed =
    check(
      "doctor leaks no virtual-filesystem path",
      !doctor.output.includes(VIRTUAL_FS_MARKER),
      doctor.output,
    ) && passed;

  rmSync(repo, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  if (provided === undefined) {
    rmSync(path.dirname(binary), { recursive: true, force: true });
  }

  console.log(passed ? "compiled-smoke: PASS" : "compiled-smoke: FAIL");
  return passed ? 0 : 1;
}

process.exit(await main());
