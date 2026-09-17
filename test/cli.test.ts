// Caller-level tests for cli.ts's remaining orchestration: main()'s
// fatal-exit wiring, the summarizer/scout activation shape, the
// gotchas/cost/discovery/ignore-rule wiring both review shells share, and
// the in-flight commit-status lock. Same fake-gh pattern as
// test/pr/pr.test.ts, extended to capture stdin (needed to tell a leftover
// W1 finding issue comment from the summary comment — both hit the same
// `issues/<pr>/comments` endpoint).
//
// The step-14 posting orchestration itself (postInlineFindings/
// postInlineIfEligible) and its pure decisions (postingExitCode,
// computeDroppedFindingIds) moved to test/pr/inline-post.test.ts alongside
// src/pr/pr.ts and src/pr/inline.ts (cli-decomp S2, Cluster C). The
// `post`/`triage`/`usage`/`doctor` verbs' own wiring tests (runPostCommand,
// runTriageCommand/runTriageReplyCommand, originUsageScope,
// runDoctorCommand) moved to test/commands/*.test.ts alongside
// src/commands/*.ts (cli-decomp S3), duplicating the doc()/finding() half of
// the fixture block below; the makeFakeGh/ndjson/OPERATOR_ROOT half stays
// here too, still needed by "CI admission reviewCount" below.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AdmissionRecord,
  serializeAdmissionRecord,
} from "#ci/admission-ledger";
import {
  evaluateCiReviewAdmission,
  resolveCiAdmissionAttemptCount,
} from "#ci/review-admission";
import {
  ADMISSION_CHECK_RUN_NAME,
  listAdmissionCheckRuns,
  type postCommitStatus,
} from "#pr/pr";
import {
  CANCELLATION_COMMIT_STATUS_TIMEOUT_MS,
  type CommitStatusRequest,
  PR_FINDING_MARKER_PREFIX,
} from "#pr/preflight";
import type {
  CliOptions,
  NumstatDiffStat,
  NumstatFile,
  SummarySettings,
} from "#review/preflight";
import { DEFAULT_SIZE_GATE, type SizeGateConfig } from "#review/size-gate";
import {
  createRunDir,
  heldCommitStatusLock,
  holdCommitStatusLock,
  main,
  pipelineScoutInput,
  pipelineSummarizerInput,
  releaseCommitStatusLock,
  resolvePrDryRunSizeGate,
  settleHeldCommitStatusOnSignal,
} from "../src/cli";
import { canonicalRemoteId } from "../src/home-preflight";
import { readLocalIgnoreRules } from "../src/ignore-read";

// ---------------------------------------------------------------------------
// FakeGh: records every call's argv AND stdin (decoded), in order. Routes
// responses by argv predicate, same shape as test/pr/pr.test.ts's makeFakeGh —
// duplicated rather than imported: pr/pr.ts's test harness is a TEST file, and
// importing test fixtures across test files is the kind of coupling that
// breaks one suite when the other's fixture shape changes for unrelated
// reasons.

interface ScriptedResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  // Streams and exit settle only when kill() fires — the shape of a `gh`
  // call GitHub accepted and never answered. Ported from
  // test/step-runner.test.ts's makeFakeSpawn, which is how that module's
  // watchdog is exercised without a real 30-minute wait; the collapse loop's
  // watchdog needs the same lever.
  hang?: boolean;
}

interface ScriptEntry {
  match: string[];
  response?: ScriptedResponse;
  // Sequential per-call responses for the SAME matched argv (call-counting):
  // consumed in order across repeated calls to the same endpoint, the last
  // entry repeating once exhausted. Needed to simulate a re-fetch of the
  // SAME endpoint returning a DIFFERENT answer than the first fetch did —
  // e.g. a concurrent process posting a comment between this run's plan
  // snapshot and its immediately-pre-post re-fetch. `response` and
  // `responses` are mutually exclusive; `response` is a plain single-value
  // shorthand kept for every pre-existing script.
  responses?: ScriptedResponse[];
}

interface RecordedCall {
  argv: string[];
  stdin: string | undefined;
}

function argvContains(argv: string[], tokens: string[]): boolean {
  const joined = argv.join(" ");
  return tokens.every((token) => joined.includes(token));
}

function makeFakeGh(script: ScriptEntry[]): {
  spawnFn: typeof Bun.spawn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // gh api's create/update calls always print `{"id": N}`-shaped JSON; N
  // increments per call so two comments created in the same test never
  // collide on id.
  let nextId = 100;
  // Per-entry call counter, only consulted when an entry uses `responses`
  // (sequential) rather than `response` (single, repeats forever).
  const responseIndex = new Map<ScriptEntry, number>();
  const spawnFn = ((argv: string[], opts?: { stdin?: Uint8Array }) => {
    const stdin =
      opts?.stdin === undefined ? undefined : decoder.decode(opts.stdin);
    calls.push({ argv, stdin });
    const entry = script.find((s) => argvContains(argv, s.match));
    let scripted: ScriptedResponse | undefined;
    if (entry?.responses) {
      const i = responseIndex.get(entry) ?? 0;
      scripted = entry.responses[Math.min(i, entry.responses.length - 1)];
      responseIndex.set(entry, i + 1);
    } else {
      scripted = entry?.response;
    }
    if (scripted === undefined) {
      // Default: any unscripted --method POST/PATCH create succeeds with a
      // fresh id — covers the summary create/patch without a script entry
      // per call.
      //
      // GATED on --method since GitHub #39, and the gate is the point: an
      // unscripted READ used to get `{"id":N}` too, which was harmless only
      // as long as nothing read a scalar. `ghPrHeadSha` reads one (`gh pr
      // view --json headRefOid -q .headRefOid`), and a fabricated `{"id":102}`
      // is not the reviewed sha, so every unscripted post test started
      // reporting a moved head. An unscripted read now answers with NOTHING,
      // which ghPrHeadSha reads as "could not verify" and renders as silence
      // — the honest default for a question the script never answered. Tests
      // that need a definite answer script `headRefOid` explicitly.
      scripted = argv.includes("--method")
        ? { stdout: JSON.stringify({ id: nextId++ }), exitCode: 0 }
        : { stdout: "", exitCode: 0 };
    }
    const held: ReadableStreamDefaultController<Uint8Array>[] = [];
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (scripted?.hang) {
            held.push(controller);
            return;
          }
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    const stdout = stream(scripted.stdout ?? "");
    const stderr = stream(scripted.stderr ?? "");
    if (!scripted.hang) resolveExit(scripted.exitCode ?? 0);
    return {
      stdout,
      stderr,
      exited,
      kill() {
        for (const controller of held) {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
        resolveExit(143);
      },
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

function ndjson(rows: unknown[]): string {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

const OPERATOR_ROOT = "/repo";
const OLD_HEAD = "a".repeat(40);

function _findingIssueCommentPosts(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter(
    (c) =>
      c.argv.join(" ").includes("issues/42/comments") &&
      c.stdin?.startsWith(PR_FINDING_MARKER_PREFIX),
  );
}

function _summaryStdins(calls: RecordedCall[]): string[] {
  return calls
    .filter((c) => c.stdin?.startsWith("<!-- pr-hero-report "))
    .map((c) => c.stdin ?? "");
}

describe("CLI summarizer activation", () => {
  test("default-on activation supplies the bundled prompt and model override", () => {
    const settings: SummarySettings = { enabled: true, model: "opus" };
    expect(pipelineSummarizerInput(settings)).toEqual({
      summarizer: {
        promptPath: path.join(
          import.meta.dir,
          "..",
          "prompts",
          "summarizer.md",
        ),
        model: "opus",
      },
    });
  });

  test("--no-summary's resolved setting preserves WU2 optional absence", () => {
    expect(pipelineSummarizerInput({ enabled: false })).toEqual({});
  });
});

describe("CLI scout activation (ROADMAP-DOORDASH M5)", () => {
  const BUNDLED = path.join(import.meta.dir, "..", "prompts", "scout.md");

  test("off resolves to WU2's optional absence — the pipeline sees no scout key", () => {
    expect(pipelineScoutInput({ scout: false })).toEqual({});
    expect(pipelineScoutInput({ scout: false, scoutModel: "haiku" })).toEqual(
      {},
    );
  });

  test("on supplies the bundled prompt, and the model only when asked for", () => {
    expect(pipelineScoutInput({ scout: true })).toEqual({
      scout: { promptPath: BUNDLED },
    });
    expect(pipelineScoutInput({ scout: true, scoutModel: "haiku" })).toEqual({
      scout: { promptPath: BUNDLED, model: "haiku" },
    });
  });

  // §3.12 obligation 9, and the failure it prevents is a hard CliError on
  // EVERY run, not a subtle one: `preflightAgentsDir` treats a
  // `review-*.md` / `deep-review-*.md` file in the agents dir that the spec
  // does not name as a prompt-set mismatch and refuses to start.
  test("the prompt lives in prompts/, is not agent-named, and exists on disk", async () => {
    const resolved = (
      pipelineScoutInput({ scout: true }) as {
        scout: { promptPath: string };
      }
    ).scout.promptPath;
    const base = path.basename(resolved);
    expect(base).toBe("scout.md");
    expect(base.startsWith("review-")).toBe(false);
    expect(base.startsWith("deep-review-")).toBe(false);
    expect(path.basename(path.dirname(resolved))).toBe("prompts");
    expect(resolved).not.toContain(`${path.sep}agents${path.sep}`);
    expect(await Bun.file(resolved).exists()).toBe(true);
  });

  // Not a style check: `tools:` in this file is IGNORED by the engine
  // (pipeline.ts forces []), so a frontmatter tools line here would document
  // a capability the scout does not have and cannot get.
  test("the bundled prompt claims no tools and pins no model", async () => {
    const raw = await Bun.file(BUNDLED).text();
    const frontmatter = raw.split("---")[1] ?? "";
    expect(frontmatter).not.toContain("tools:");
    // No `model:` on purpose — DEFAULT_SCOUT_MODEL owns that seat, so the
    // file's sha256 stays the one M4 ratified.
    expect(frontmatter).not.toContain("model:");
  });
});

// The call sites themselves, guarded by shape rather than by behaviour, and
// the reason is measured rather than assumed: `review()` and `reviewPr()` are
// I/O shells no offline test can invoke, so with `notionalCostInput` tested
// and both renderers tested, DELETING all four call sites still flipped zero
// tests. That is the precise shape of the defect this issue reports — a
// correct mechanism whose last wiring step silently never lands — so the wiring
// gets a guard of its own, in the same spirit as the repo-hygiene scan in
// test/preflight-bundled-prompts.test.ts.
//
// The invariant, not the line numbers, and stated at its real width
// (2026-09-02, #177): every `renderResult(`/`renderReport(` call IN THE TWO
// REVIEW SHELLS carries the notional companion. There are four today (two
// per review shell); adding a FIFTH, or a third review shell, is meant to
// trip this until it does the same.
//
// cli-decomp-08 moved review() and reviewPr() out of src/cli.ts into
// src/review/review.ts and src/pr/review-pr.ts respectively; this scan moved
// with them rather than going dark the moment the call sites left cli.ts.
//
// What is deliberately OUTSIDE it, and would not trip it: every other surface
// that renders a run's cost — `ci-reporter`'s `cost_usd_est=` in
// `$GITHUB_OUTPUT`, the `runs`/`run_agents` store and `pr-hero usage`,
// metrics, the watcher feed, the server, backfill, and diversity's spend cap.
// They all read `projectLegacyUsage`'s `cost_usd_est`, which is cash-only and
// has no notional companion to pair with; the `runs` table has no notional
// column at all, so `pr-hero usage` would mix two semantics across time. That
// is a store-schema slice (#173's commit body names it), not this one — so
// this scan pins the shell it can actually pin rather than claiming a
// guarantee the codebase does not yet make.
describe("every cost-rendering call site in the review shells carries the notional split (#173)", () => {
  test("renderResult and renderReport are each paired with notionalCostInput", async () => {
    const sources = await Promise.all(
      ["../src/review/review.ts", "../src/pr/review-pr.ts"].map((rel) =>
        Bun.file(path.resolve(import.meta.dir, rel)).text(),
      ),
    );
    const source = sources.join("\n");
    const count = (needle: string) => source.split(needle).length - 1;
    const renderCalls = count("renderResult(") + count("renderReport(");
    expect(renderCalls).toBeGreaterThan(0);
    expect(count("notionalCostInput(result)")).toBe(renderCalls);
  });
});

// `review()` and `reviewPr()` are unexported I/O shells, so no offline test
// reaches their gotchas gate — which is exactly how the gate came to promise
// something it did not enforce. The predicate itself is unit-tested in
// test/review/preflight.test.ts; what has no other guard is that both shells
// actually ASK it. Same precedent as the notional-split scan above: pin the
// wiring, state the invariant rather than the line numbers.
describe("every gotchas gate asks the shared predicate", () => {
  const sources = [
    "../src/review/review.ts",
    "../src/pr/review-pr.ts",
    "../src/review/pipeline.ts",
    "../src/doctor.ts",
  ];

  test("no gate re-implements the old empty-only check", async () => {
    // The exact statements the four gates used before the placeholder was
    // rejected. The `if (` prefix is load-bearing: without it the guard also
    // fires on the WHY comments that quote the old expression to explain why
    // it was wrong, which would make the guard forbid naming its own subject.
    // Collected into a list rather than asserted with `not.toContain` per
    // file, because a failing `not.toContain` on a 7000-line source prints
    // the whole file.
    const offenders: string[] = [];
    for (const rel of sources) {
      const source = await Bun.file(path.resolve(import.meta.dir, rel)).text();
      for (const needle of [
        "if (gotchas.trim().length === 0)",
        "gotchasContent.trim().length === 0)",
      ]) {
        if (source.includes(needle)) offenders.push(`${rel}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("both review shells route through gotchasUnusableReason", async () => {
    // Local review and PR review moved to their own modules (cli-decomp-08),
    // then P2.2 (odd/tasks/shared-run-stages.md) moved the gate ITSELF into
    // `#review/run`'s `validateGotchas` — both shells now call that shared
    // function exactly once, and `validateGotchas` is the one place left
    // that asks `gotchasUnusableReason` and renders `gotchasErrorMessage`.
    // The invariant is unchanged: one gate, one error render, reused rather
    // than duplicated per shell.
    for (const rel of ["../src/review/review.ts", "../src/pr/review-pr.ts"]) {
      const source = await Bun.file(path.resolve(import.meta.dir, rel)).text();
      const count = (needle: string) => source.split(needle).length - 1;
      expect(count("validateGotchas(gotchasPath)")).toBe(1);
    }
    const runSource = await Bun.file(
      path.resolve(import.meta.dir, "../src/review/run.ts"),
    ).text();
    const count = (needle: string) => runSource.split(needle).length - 1;
    expect(count("gotchasUnusableReason(gotchas)")).toBe(1);
    expect(count("gotchasErrorMessage(gotchasPath, ")).toBe(1);
  });

  // `init`'s own gotchas-block wiring test moved to
  // test/commands/init.test.ts (cli-decomp S3) when `init` moved to
  // src/commands/init.ts — it tests init's wiring specifically, not the
  // shared-predicate theme this describe covers for the two review shells.
});

// Rereview-coverage fix (GitHub #42's re-review half, MusiveTech/musive
// #1823): reviewPr() is the SAME unexported I/O shell as the gotchas gate
// above, so "hunters are non-empty for a forced-full case B re-review" can't
// be proven end-to-end offline either. What CAN be pinned, same precedent —
// source-shape, not execution — is the wiring the fix depends on: that
// `activeHunters` still derives from `skipDiscovery` alone (never a
// case === "B" special-case that would defeat the fix), and that both
// `prepareDiscovery` and `buildPhaseBQueue` are actually handed the values
// this fix computes rather than a hardcoded default. The pure half of this
// —`skipDiscovery: false` / `verifyAll: true` for a forced-full case B — is
// exhaustively covered in test/rereview/prepare.test.ts and
// test/rereview/plan.test.ts; this only guards that reviewPr() (moved to
// src/pr/review-pr.ts by cli-decomp-08) still WIRES those results through.
describe("reviewPr's discovery wiring stays honest (rereview-coverage fix)", () => {
  const REVIEW_PR_PATH = "../src/pr/review-pr.ts";

  test("activeHunters is still gated on skipDiscovery alone, not a hardcoded case check", async () => {
    const source = await Bun.file(
      path.resolve(import.meta.dir, REVIEW_PR_PATH),
    ).text();
    // CLI decomposition P2.1 (odd/tasks/cli-decomposition.md): the filter
    // itself moved into `selectActiveHunters` in src/review/run.ts (shared
    // with review()'s copy, tested there), but the wiring this test guards
    // — skipDiscovery gates activeHunters directly, never a hardcoded case
    // check — is unchanged.
    expect(source).toContain(
      "const activeHunters = skipDiscovery\n      ? []\n      : selectActiveHunters(spec.agents, parityFires);",
    );
    // The one thing that must NEVER reappear: a discovery gate that special-
    // cases case B directly would silently reintroduce the exact defect this
    // fix closes, bypassing `plan.skipDiscovery`/`lastComplete` entirely.
    expect(source).not.toContain('prepared.case === "B"');
  });

  test("prepareDiscovery is handed a computed summaryComplete, not a bare literal", async () => {
    const source = await Bun.file(
      path.resolve(import.meta.dir, REVIEW_PR_PATH),
    ).text();
    expect(source).toContain("const summaryComplete = summaryMarker?.complete");
    expect(source).toContain("summaryComplete,\n      findingMarkers:");
  });

  test("buildPhaseBQueue receives plan.verifyAll — the wiring gap this fix closes", async () => {
    const source = await Bun.file(
      path.resolve(import.meta.dir, REVIEW_PR_PATH),
    ).text();
    expect(source).toContain("verifyAll: prepared.plan.verifyAll,");
  });

  // Split-review-pr refactor: the CI admission gate (and this exact wiring)
  // moved out of reviewPr() into evaluateCiAdmissionGate
  // (src/pr/ci-admission-gate.ts) as a byte-for-byte relocation.
  //
  // review-pr-behavior-seams: the marker-derivation HALF of this invariant
  // ("complete defaults to true, never a hardcoded literal") is no longer
  // pinned here — it is `summaryMarkerFields`'s own behavior, mutation-tested
  // in test/watch/preflight.test.ts (shared by this gate AND reviewPr()'s own
  // discovery seam, closing the exact two-call-sites-can-drift gap the old
  // inline duplication risked). What remains genuinely unreachable offline is
  // this gate's OWN wiring — an I/O shell with no injectable seam for its
  // `gh`-backed fetches (same class of limitation as the gotchas-gate scan
  // above) — so a source check still confirms it calls the shared, tested
  // helper rather than re-deriving the fields inline.
  test("CI admission derives its marker fields via the shared, tested summaryMarkerFields helper", async () => {
    const source = await Bun.file(
      path.resolve(import.meta.dir, "../src/pr/ci-admission-gate.ts"),
    ).text();
    expect(source).toContain(
      "const { summaryHead, summaryComplete } = summaryMarkerFields(summaryMarker);",
    );
    expect(source).not.toContain("summaryMarker?.complete ?? true");
  });
});

// review-pr-behavior-seams: invariants 5, 6 and 9 (rules threaded into the
// gate config, the dry-run degrade rule, and "no call site can drop the
// rules argument") moved OFF this source-text scan entirely.
//   - 5 & 9 are now `sizeGateConfigFor`'s own behavior — a REQUIRED third
//     parameter (unlike sizeGateConfig's own optional one), tested with a
//     real custom rule in test/review/size-gate.test.ts. Both review shells
//     call it instead of sizeGateConfig directly.
//   - 6 is `resolvePrDryRunNumstat`'s own behavior, tested through the real
//     downstream size-gate verdict in test/pr/target.test.ts.
// What is left here (7 & 8) is genuinely ROOT/REF SELECTION inside an I/O
// shell no offline test can invoke directly — see each test's own comment.
describe("PR review resolves .prheroignore against the correct root and ref (O-8, design D1)", () => {
  test("PR review reads the operator root eagerly for non-CI, and never reads worktreePath (O-8)", async () => {
    const source = await Bun.file(
      path.resolve(import.meta.dir, "../src/pr/review-pr.ts"),
    ).text();
    expect(source).toContain("readLocalIgnoreRules(operatorRoot)");
    expect(source).not.toContain("readLocalIgnoreRules(worktreePath)");
  });

  test("PR review's base-ref read takes the RESOLVED baseSha, not target.baseRef/baseRefName", async () => {
    const source = await Bun.file(
      path.resolve(import.meta.dir, "../src/pr/review-pr.ts"),
    ).text();
    // The read must run against the sha `resolveCommit` already canonicalized
    // (a merged PR's baseRef is a `<sha>^1` EXPRESSION, not a sha — see
    // pr/preflight.ts's PrTarget.baseRef comment), never the raw PrTarget
    // field, and never gitDirOwner's cwd-relative form.
    expect(source).toContain(
      "readBaseRefIgnoreRules(git, gitDirOwner, baseSha)",
    );
    expect(source).not.toContain(
      "readBaseRefIgnoreRules(git, gitDirOwner, target.baseRef)",
    );
  });
});

function runDirOptions(over: Partial<CliOptions> = {}): CliOptions {
  return {
    repo: ".",
    head: "HEAD",
    hopBudget: 3,
    scout: false,
    full: false,
    dryRun: false,
    yes: false,
    post: false,
    twoDot: false,
    onPush: false,
    force: false,
    all: false,
    fixes: false,
    incidents: false,
    issues: false,
    proximity: false,
    threads: false,
    ...over,
  };
}

// W4 Phase 6 remediation (sdd-verify option D): offline tests closing the
// PARTIAL scenarios the verify report flagged for the --out product fix.
// `runGit`/`tmpGitRepo` spawn a REAL git binary against a throwaway tmp dir
// — the only way to exercise gitOriginUrl/resolveRepoHome's actual decision
// (present vs. absent origin) without faking git itself. Duplicated (not
// shared) in test/commands/usage.test.ts, which needs the same fixture for
// originUsageScope's own suite (cli-decomp S3): this file's own precedent is
// to duplicate rather than import test fixtures across files.

async function runGit(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

async function tmpGitRepo(
  originUrl: string | null,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-git-"));
  await runGit(dir, ["init", "-q"]);
  await runGit(dir, ["config", "user.email", "test@example.com"]);
  await runGit(dir, ["config", "user.name", "Test"]);
  if (originUrl !== null) {
    await runGit(dir, ["remote", "add", "origin", originUrl]);
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("createRunDir — --out product fix D (W4 Phase 6)", () => {
  test("--out on a checkout WITH origin still ingests: repoId is the canonical origin", async () => {
    const originUrl = "https://github.com/acme/widgets.git";
    const repo = await tmpGitRepo(originUrl);
    const outDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-out-"));
    try {
      const { runDir, repoId } = await createRunDir(
        runDirOptions({ out: outDir }),
        repo.dir,
        "c".repeat(40),
      );
      expect(runDir).toBe(path.resolve(outDir));
      expect(repoId).toBe(canonicalRemoteId(originUrl));
    } finally {
      await repo.cleanup();
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("--out on a checkout WITHOUT origin stays the escape hatch: repoId is null, no throw", async () => {
    const repo = await tmpGitRepo(null);
    const outDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-out-"));
    try {
      const { runDir, repoId } = await createRunDir(
        runDirOptions({ out: outDir }),
        repo.dir,
        "c".repeat(40),
      );
      expect(runDir).toBe(path.resolve(outDir));
      expect(repoId).toBeNull();
    } finally {
      await repo.cleanup();
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// prheroignore Phase 3 — the read paths (local working tree, base-ref)
// ---------------------------------------------------------------------------

describe("readLocalIgnoreRules — the working-tree read (local review, PR review without --ci)", () => {
  test("absent file: defaults only, no error", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ignore-local-"));
    try {
      expect(await readLocalIgnoreRules(dir)).toEqual({
        rules: [],
        found: false,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("valid file: its rules parse as user rules", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ignore-local-"));
    try {
      await Bun.write(path.join(dir, ".prheroignore"), "vendor/**\n");
      const result = await readLocalIgnoreRules(dir);
      expect(result.found).toBe(true);
      expect(result.rules).toHaveLength(1);
      expect(result.rules[0]?.pattern).toBe("vendor/**");
      expect(result.rules[0]?.source).toBe("user");
      expect(result.rules[0]?.line).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("malformed file: loud abort naming the resolved path, line, and text — aborts the WHOLE file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ignore-local-"));
    try {
      await Bun.write(path.join(dir, ".prheroignore"), "ok/**\n!\n");
      const ignorePath = path.join(dir, ".prheroignore");
      const escaped = ignorePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      await expect(readLocalIgnoreRules(dir)).rejects.toThrow(
        new RegExp(`^${escaped}:2: .*offending line.*"!"`),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("directory named .prheroignore: loud abort, never treated as absent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ignore-local-"));
    try {
      await mkdir(path.join(dir, ".prheroignore"));
      await expect(readLocalIgnoreRules(dir)).rejects.toThrow(
        /is not a regular file/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unreadable file (permission denied): loud abort, never treated as absent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ignore-local-"));
    const ignorePath = path.join(dir, ".prheroignore");
    try {
      await Bun.write(ignorePath, "vendor/**\n");
      await chmod(ignorePath, 0o000);
      await expect(readLocalIgnoreRules(dir)).rejects.toThrow(
        /could not be read/,
      );
    } finally {
      await chmod(ignorePath, 0o644).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// PR1b Addition 1 (#5557): the aggregate-only dry-run estimate cannot express
// exclusions at all — no per-file paths, so `.prheroignore` widens what was
// already a "wrong in the conservative direction" gap from tens of lines
// (lockfiles) to potentially thousands (a whole ignored directory). Ported
// from watch/watch.ts's tier-2 pattern: when gh's per-file list is TRUSTWORTHY (not
// truncated), evaluate the real per-file gate; otherwise fall back to the
// aggregate estimate and label it.
describe("resolvePrDryRunSizeGate — the PR --dry-run size-gate estimate (Addition 1)", () => {
  const gateConfig: SizeGateConfig = {
    ...DEFAULT_SIZE_GATE,
    maxChangedLines: 1500,
    excludeRules: [
      {
        pattern: "openspec/**",
        negated: false,
        globs: ["**/openspec/**"],
        source: "user",
        line: 1,
      },
    ],
  };

  function file(path: string, lines: number): NumstatFile {
    return { path, insertions: lines, deletions: 0, binary: false };
  }

  test("per-file data available: excluded files are subtracted BEFORE the limit check (the central scenario)", () => {
    // 29 files x 100 lines under openspec/ (excluded) + one 100-line file —
    // 3000 raw lines, 100 effective. The aggregate-only estimate would SKIP a
    // PR the real per-file gate accepts; this is exactly that reproduction.
    const perFile: NumstatFile[] = [
      ...Array.from({ length: 29 }, (_, i) =>
        file(`openspec/changes/thing/f${i}.md`, 100),
      ),
      file("src/cli.ts", 100),
    ];
    const ghDiffStat: NumstatDiffStat = {
      files: 30,
      insertions: 3000,
      deletions: 0,
    };
    const result = resolvePrDryRunSizeGate({ ghDiffStat, perFile, gateConfig });
    expect(result.verdict.ok).toBe(true);
    if (result.verdict.ok) {
      expect(result.verdict.effectiveLines).toBe(100);
      expect(result.verdict.excludedFiles).toBe(29);
    }
    expect(result.note).not.toContain("truncated");
  });

  test("per-file list is null (truncated/unavailable): falls back to the aggregate estimate, labelled", () => {
    const ghDiffStat: NumstatDiffStat = {
      files: 30,
      insertions: 3000,
      deletions: 0,
    };
    const result = resolvePrDryRunSizeGate({
      ghDiffStat,
      perFile: null,
      gateConfig,
    });
    // The aggregate path cannot apply exclusions at all — same reproduction
    // as above, but this time the SKIP is real: gh's own truncated list left
    // no trustworthy per-file answer to fall back on.
    expect(result.verdict.ok).toBe(false);
    expect(result.note).toContain("truncated");
  });

  test("small PR: both per-file and aggregate agree it passes", () => {
    const perFile: NumstatFile[] = [file("src/a.ts", 10)];
    const ghDiffStat: NumstatDiffStat = {
      files: 1,
      insertions: 10,
      deletions: 0,
    };
    const result = resolvePrDryRunSizeGate({ ghDiffStat, perFile, gateConfig });
    expect(result.verdict.ok).toBe(true);
  });
});

// Pillar 3 Phase 5, gap closure #2: reportFatalCiError above is only reached
// from runCli()'s catch, which fires only for errors that ESCAPE main(). But
// main() catches and RETURNS for the two failures docs/github-actions.md
// names as the reasons this job can go red — a malformed argument (parseArgs
// throws, exit 2) and a CliError/CliUsageError from a command body (exit 1,
// which is exactly what a bad or expired GITHUB_TOKEN produces, since pr/pr.ts
// raises CliError for `gh not found` and for a failed `gh pr view`). Neither
// ever reached runCli's catch, so a consumer workflow branching on
// `outputs.status == 'error'` saw `status` completely unset — indistinguishable
// from a step whose outputs were never read.
describe("main — status=error on the exits that never reached runCli's catch", () => {
  let savedOutput: string | undefined;
  let savedStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    savedOutput = process.env.GITHUB_OUTPUT;
    // main() prints HELP_TEXT and error lines; swallow them so the suite's
    // output stays readable. Restored in afterEach.
    savedStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = savedStderrWrite;
    // The suite itself may be RUNNING inside GitHub Actions, where
    // GITHUB_OUTPUT is genuinely set — restore exactly, and delete when it
    // was absent, or the "not a job step" case below silently tests nothing.
    if (savedOutput === undefined) {
      process.env.GITHUB_OUTPUT = undefined;
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = savedOutput;
    }
  });

  test("a malformed argument writes status=error and still exits 2", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-main-parse-"));
    const outputPath = path.join(dir, "github_output");
    process.env.GITHUB_OUTPUT = outputPath;
    try {
      const code = await main(["review", "--no-such-flag"]);
      expect(code).toBe(2);
      expect(await Bun.file(outputPath).text()).toContain("status=error\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a CliError from a command body writes status=error and still exits 1", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-main-clierror-"));
    const outputPath = path.join(dir, "github_output");
    const notARepo = path.join(dir, "not-a-repo");
    await mkdir(notARepo, { recursive: true });
    process.env.GITHUB_OUTPUT = outputPath;
    try {
      // resolveRepoRoot is postCommand's first statement and throws CliError
      // ("not a git repository") — no network, no agent spawn, one failing
      // `git rev-parse`.
      const code = await main([
        "post",
        "--pr",
        "5",
        "--from",
        dir,
        "--repo",
        notARepo,
      ]);
      expect(code).toBe(1);
      expect(await Bun.file(outputPath).text()).toContain("status=error\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("outside a job step ($GITHUB_OUTPUT unset) neither exit writes anything", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-main-local-"));
    const notARepo = path.join(dir, "not-a-repo");
    await mkdir(notARepo, { recursive: true });
    process.env.GITHUB_OUTPUT = undefined;
    delete process.env.GITHUB_OUTPUT;
    try {
      expect(await main(["review", "--no-such-flag"])).toBe(2);
      expect(
        await main(["post", "--pr", "5", "--from", dir, "--repo", notARepo]),
      ).toBe(1);
      // Nothing to assert a file against — the point is that the local exit
      // codes are untouched and no write is attempted at all.
      expect(process.env.GITHUB_OUTPUT).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CI admission reviewCount — ledger check runs feed admission", () => {
  test("resolveCiAdmissionAttemptCount uses terminal ledger rows from check-runs", async () => {
    const head = "e".repeat(40);
    const policyHash = "policyhash123456";
    const record: AdmissionRecord = {
      schemaVersion: 1,
      prNumber: 42,
      headSha: head,
      policyHash,
      reservationId: "reservation123456",
      attemptNumber: 1,
      status: "failed",
      decisionReason: "provider failed",
      priorScore: null,
      blockingCount: null,
      advisoryCount: null,
      workflowRunId: null,
      createdAt: "2026-08-28T12:00:00.000Z",
      settledAt: "2026-08-28T12:05:00.000Z",
    };
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["check-runs"],
        response: {
          stdout: ndjson([
            {
              id: 77,
              name: ADMISSION_CHECK_RUN_NAME,
              status: "completed",
              output: { text: serializeAdmissionRecord(record) },
            },
          ]),
        },
      },
    ]);
    const ledgerRecords = await listAdmissionCheckRuns(OPERATOR_ROOT, head, {
      spawnFn,
    });
    expect(ledgerRecords).toEqual([record]);
    expect(calls[0]?.argv.join(" ")).toContain(`commits/${head}/check-runs`);

    const reviewCount = resolveCiAdmissionAttemptCount({
      stateCount: 0,
      workflowHeads: new Set<string>(),
      ledgerRecords,
    });
    expect(reviewCount).toBe(1);

    const exhausted = evaluateCiReviewAdmission({
      currentHead: "f".repeat(40),
      summaryHead: OLD_HEAD,
      markerSeen: true,
      reviewCount: 2,
      state: null,
      admission: null,
      postedFindings: null,
      policy: {
        schemaVersion: 1,
        mode: "risk_aware",
        maxAttempts: 2,
        rereviewMinScore: 4,
        blockingWeight: 2,
        advisoryWeight: 1,
        reservationTtlSeconds: 3600,
      },
      deltaTouchesPriorFindings: false,
      deltaRisk: null,
    });
    expect(exhausted.action).toBe("manual-required");
  });
});

describe("the in-flight commit-status lock this process holds", () => {
  const lock = {
    operatorRoot: "/repo",
    sha: "c".repeat(40),
    targetUrl: "https://github.com/org/repo/pull/162",
  };

  afterEach(() => {
    releaseCommitStatusLock();
  });

  test("nothing is held before a pending is published", () => {
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("holding records exactly what settling needs", () => {
    holdCommitStatusLock(lock);
    expect(heldCommitStatusLock()).toEqual(lock);
  });

  test("releasing clears it, so the normal settle cannot leave it set", () => {
    holdCommitStatusLock(lock);
    releaseCommitStatusLock();
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("releasing twice is a no-op", () => {
    holdCommitStatusLock(lock);
    releaseCommitStatusLock();
    releaseCommitStatusLock();
    expect(heldCommitStatusLock()).toBeNull();
  });
});

describe("settleHeldCommitStatusOnSignal", () => {
  const lock = {
    operatorRoot: "/repo",
    sha: "d".repeat(40),
    targetUrl: "https://github.com/org/repo/pull/162",
  };

  afterEach(() => {
    releaseCommitStatusLock();
  });

  function recordingPoster(): {
    post: typeof postCommitStatus;
    calls: {
      operatorRoot: string;
      sha: string;
      request: CommitStatusRequest;
      options: unknown;
    }[];
  } {
    const calls: {
      operatorRoot: string;
      sha: string;
      request: CommitStatusRequest;
      options: unknown;
    }[] = [];
    const post = (async (
      operatorRoot: string,
      sha: string,
      request: CommitStatusRequest,
      _spawnFn?: unknown,
      options?: unknown,
    ) => {
      calls.push({ operatorRoot, sha, request, options });
    }) as unknown as typeof postCommitStatus;
    return { post, calls };
  }

  test("holding nothing posts nothing", async () => {
    const { post, calls } = recordingPoster();
    await settleHeldCommitStatusOnSignal(post);
    expect(calls).toHaveLength(0);
  });

  test("settles the held sha with one bounded attempt", async () => {
    holdCommitStatusLock(lock);
    const { post, calls } = recordingPoster();
    await settleHeldCommitStatusOnSignal(post);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.operatorRoot).toBe(lock.operatorRoot);
    expect(calls[0]?.sha).toBe(lock.sha);
    expect(calls[0]?.request.state).toBe("error");
    expect(calls[0]?.request.description).toBe("review did not finish");
    expect(calls[0]?.options).toEqual({
      attempts: 1,
      timeoutMs: CANCELLATION_COMMIT_STATUS_TIMEOUT_MS,
    });
  });

  test("take-and-clear: a second signal posts nothing", async () => {
    // Actions cancels with SIGINT and follows with SIGTERM before the grace
    // period ends. Both handlers can be in flight at once, and the lock must
    // be claimed before the await, not after it.
    holdCommitStatusLock(lock);
    const { post, calls } = recordingPoster();
    await Promise.all([
      settleHeldCommitStatusOnSignal(post),
      settleHeldCommitStatusOnSignal(post),
    ]);
    expect(calls).toHaveLength(1);
    expect(heldCommitStatusLock()).toBeNull();
  });

  test("a failing settle never escapes the handler", async () => {
    holdCommitStatusLock(lock);
    const post = (async () => {
      throw new Error("missing permission (HTTP 403)");
    }) as unknown as typeof postCommitStatus;
    await expect(settleHeldCommitStatusOnSignal(post)).resolves.toBeUndefined();
  });
});
