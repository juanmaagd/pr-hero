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

function run(
  cmd: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Run {
  const result = spawnSync(cmd[0] as string, cmd.slice(1), {
    cwd,
    encoding: "utf-8",
    // Reviews shell out to git, so PATH must survive.
    env,
  });
  if (result.error) {
    return {
      code: 1,
      output: result.error.message,
    };
  }
  return {
    code: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

// The read-only command surface, swept DIFFERENTIALLY: each one is run twice,
// once through the compiled binary and once through `bun run src/cli.ts`, with
// the same cwd and the same environment, and the two exit codes must agree.
//
// Asserting a table of expected exit codes instead would be worse in both
// directions: several of these legitimately exit non-zero depending on whether
// the repo has an origin remote and what the store already holds, so the table
// would be brittle, and it would encode MY belief about what each command does
// rather than the property that actually matters here — that compiling the
// engine does not change its behaviour. Source is the reference because source
// is what the offline suite proves.
//
// Excluded deliberately: anything needing `gh`, network or auth (`review --pr`,
// `post`, `triage`, `reverts`, `corpus`, `upgrade`), anything interactive
// (`menu`, `setup`), anything that starts a server (`mcp`), and the
// `install`/`uninstall` pairs, which register launchd agents — a smoke must not
// leave a daemon behind. That last exclusion is a real coverage gap and the
// launchd entry path is guarded by unit tests instead.
const SWEPT_COMMANDS: readonly string[][] = [
  ["--help"],
  ["doctor"],
  ["config"],
  ["activity"],
  ["usage"],
  ["ledger"],
  ["watch", "status"],
  ["gc", "status"],
];

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
  // pr-hero keys the global home by origin URL and several read-only commands
  // refuse without one. The URL is never contacted — nothing in the swept
  // surface talks to a network — it only has to exist and parse.
  git(
    "remote",
    "add",
    "origin",
    "https://github.com/example/pr-hero-smoke.git",
  );

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
  const rawProvided = process.argv[2];
  const provided =
    rawProvided !== undefined && rawProvided.trim().length > 0
      ? path.resolve(rawProvided)
      : undefined;
  const binary = provided ?? compileBinary();
  console.log(
    `compiled-smoke: ${provided ? "using provided binary" : "compiled"} ${binary}`,
  );

  const repo = makeFixtureRepo();
  const outDir = mkdtempSync(path.join(os.tmpdir(), "prhero-smoke-out-"));
  // A throwaway HOME so the sweep cannot read or write the real ~/.prhero: the
  // store, watch.json and the worktree registry all live there, and a smoke
  // that mutates a developer's state — or reads it and passes only because of
  // what it found — is not a smoke. --out is kept as well, so the run dir lands
  // beside the rest of the temp state rather than inside the fake home.
  const home = mkdtempSync(path.join(os.tmpdir(), "prhero-smoke-home-"));
  const env = { ...process.env, HOME: home };
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
    env,
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

  const cliEntry = path.join(REPO_ROOT, "src", "cli.ts");
  for (const argv of SWEPT_COMMANDS) {
    const label = argv.join(" ");
    const built = run([binary, ...argv], repo, env);
    passed =
      check(
        `${label} leaks no virtual-filesystem path`,
        !built.output.includes(VIRTUAL_FS_MARKER),
        built.output,
      ) && passed;

    const fromSource = run(["bun", "run", cliEntry, ...argv], repo, env);
    passed =
      check(
        `${label} behaves the same compiled as from source`,
        built.code === fromSource.code,
        `compiled exit ${built.code}, source exit ${fromSource.code}\n` +
          `--- compiled ---\n${built.output}\n--- source ---\n${fromSource.output}`,
      ) && passed;
  }

  rmSync(repo, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  if (provided === undefined) {
    rmSync(path.dirname(binary), { recursive: true, force: true });
  }

  console.log(passed ? "compiled-smoke: PASS" : "compiled-smoke: FAIL");
  return passed ? 0 : 1;
}

process.exit(await main());
