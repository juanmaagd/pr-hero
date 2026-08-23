// Caller-level tests for cli.ts's ROADMAP B6 wiring (WU6/PR3): the step-14
// posting orchestration (postInlineFindings/postInlineIfEligible) and the
// pure decisions around it (postingExitCode, assertRunMatchesPr).
//
// PR2 verification (#3296) flagged this exact layer as load-bearing and
// missing: pr.ts's primitives (postPrReview, postIssueComment, postPrComment)
// are individually correct and individually tested, but nothing proved the
// CALLER wires them the way design D6 requires — ordering, the
// `sessionFailed` guard, and the exit-1 rule are all decisions this file
// makes, not pr.ts. Same fake-gh pattern as test/pr.test.ts, extended to
// capture stdin (needed to tell a leftover W1 finding issue comment from
// the summary comment — both hit the same `issues/<pr>/comments` endpoint).

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertRunMatchesPr,
  computeDroppedFindingIds,
  createRunDir,
  deriveEngineIdentity,
  type InlinePostOutcome,
  ingestReviewMetrics,
  originUsageScope,
  pipelineScoutInput,
  pipelineSummarizerInput,
  postInlineFindings,
  postInlineIfEligible,
  postingExitCode,
  runPostCommand,
  runTriageCommand,
  runTriageReplyCommand,
} from "../src/cli";
import type { PrHeroFindingRef } from "../src/compare";
import type { Finding, FindingsDocument, Telemetry } from "../src/findings";
import { canonicalRemoteId, missingOriginMessage } from "../src/home-preflight";
import type { StoredComparison } from "../src/ledger";
import {
  claimFingerprint,
  findingMarker,
  PR_FINDING_MARKER_PREFIX,
} from "../src/pr-preflight";
import type { CliOptions, SummarySettings } from "../src/preflight";
import { CliError, CliUsageError } from "../src/preflight";
import type { RereviewProvenance } from "../src/rereview-prepare";
import { triageMarker } from "../src/triage";

// ---------------------------------------------------------------------------
// FakeGh: records every call's argv AND stdin (decoded), in order. Routes
// responses by argv predicate, same shape as test/pr.test.ts's makeFakeGh —
// duplicated rather than imported: pr.ts's test harness is a TEST file, and
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

// Empty issue/review comment streams — the common "nothing posted yet"
// baseline every scripted PR extends.
//
// GitHub #39: the head re-read joins the baseline, answering with the head
// the caller says it reviewed, because "the PR did not move" is the ordinary
// state every one of these tests is about. Entry order matters — `script.find`
// takes the FIRST match, and `headRefOid` is specific enough that no other
// entry can swallow it, but a broad `["pr", "view"]` entry added later would,
// so this one goes first.
function headRefOidScript(headSha: string): ScriptEntry {
  return { match: ["headRefOid"], response: { stdout: `${headSha}\n` } };
}

function emptyCommentScript(headSha: string = HEAD): ScriptEntry[] {
  return [
    headRefOidScript(headSha),
    { match: ["issues/42/comments", "--paginate"], response: { stdout: "" } },
    { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
  ];
}

const OPERATOR_ROOT = "/repo";
const HEAD = "b".repeat(40);
const OLD_HEAD = "a".repeat(40);

function diffAddingLines(path: string, count: number): string {
  const body = Array.from({ length: count }, (_, i) => `+line ${i + 1}`).join(
    "\n",
  );
  return (
    `diff --git a/${path} b/${path}\n` +
    `index 0000000..1111111 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -0,0 +1,${count} @@\n` +
    `${body}\n`
  );
}

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    category: 12,
    path: "src/app.ts",
    line: 10,
    severity: "BLOCKER",
    evidence_class: "deterministic",
    refuter_verdict: "corroborated",
    causal_disposition: "introduced",
    claim: "the value is stored in seconds and read as milliseconds",
    proof_refs: [],
    hunter: "reliability",
    tier: "blocking",
    hops_used: 2,
    hop_trail: [],
    dedupe_key: `${overrides.path ?? "src/app.ts"}::12`,
    ...overrides,
  };
}

const TELEMETRY: Telemetry = {
  index_ms: 0,
  index_mode: "sync",
  index_disk_mb: 0,
  wall_ms: 1000,
  tokens_in: 10,
  tokens_out: 10,
  tokens_total: 20,
  cost_usd_est: 1,
};

function doc(overrides: Partial<FindingsDocument> = {}): FindingsDocument {
  const findings = overrides.findings ?? [];
  return {
    schema_version: "1.0.0",
    pr: 42,
    base_sha: OLD_HEAD,
    head_sha: HEAD,
    model: "sonnet",
    iteration: 0,
    parity_hunter_fired: false,
    run_status: "complete",
    telemetry: TELEMETRY,
    findings,
    debug: { refuted: [] },
    ...overrides,
  };
}

function findingIssueCommentPosts(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter(
    (c) =>
      c.argv.join(" ").includes("issues/42/comments") &&
      c.stdin?.startsWith(PR_FINDING_MARKER_PREFIX),
  );
}

function summaryStdins(calls: RecordedCall[]): string[] {
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

describe("postInlineFindings — step-14 ordering", () => {
  // Design rework (Juanma's PR #2 feedback item 2): the summary is CREATED
  // FIRST — before any finding is posted — so its position in the
  // Conversation timeline is fixed early, then PATCHED again LAST with the
  // final delta and comment links. Creation is a POST to
  // `issues/<pr>/comments`; the closing PATCH targets
  // `issues/comments/<id>` — two distinct endpoints, so the test tells them
  // apart by argv shape, not just by stdin prefix (both carry the same
  // marker prefix).
  test("summary created first, then review, then the summary PATCHed last", async () => {
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 10 }), // anchorable
      finding({ id: "F002", path: "src/b.ts", line: 999 }), // un-anchorable
    ];
    const { spawnFn, calls } = makeFakeGh([
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewOutcome).toBe("posted");
    expect(outcome.reviewFindingCount).toBe(1);
    expect(outcome.issueCommentIds).toEqual([]);
    expect(outcome.outsideDiffCount).toBe(1);
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(findingIssueCommentPosts(calls)).toHaveLength(0);

    const createIndex = calls.findIndex(
      (c) =>
        c.argv.join(" ").includes("POST") &&
        c.argv.join(" ").includes("issues/42/comments") &&
        c.stdin?.startsWith("<!-- pr-hero-report "),
    );
    const reviewIndex = calls.findIndex((c) =>
      c.argv.join(" ").includes("pulls/42/reviews"),
    );
    const patchIndex = calls.findIndex(
      (c) =>
        c.argv.join(" ").includes("PATCH") &&
        c.argv.join(" ").includes("issues/comments/") &&
        c.stdin?.startsWith("<!-- pr-hero-report "),
    );
    expect(createIndex).toBeGreaterThanOrEqual(0);
    // The summary create is the FIRST mutating (POST/PATCH) call this run
    // makes — every call before it is a read-only fetch (resolving the
    // plan), never another write.
    const firstMutatingIndex = calls.findIndex(
      (c) => c.argv.includes("POST") || c.argv.includes("PATCH"),
    );
    expect(createIndex).toBe(firstMutatingIndex);
    expect(reviewIndex).toBeGreaterThan(createIndex);
    expect(patchIndex).toBeGreaterThan(reviewIndex);
    // The summary PATCH is the very LAST call this run makes. No finding
    // issue-comment POSTs sit between review and PATCH (issues #16/#17).
    expect(patchIndex).toBe(calls.length - 1);
    const createBody = calls[createIndex]?.stdin ?? "";
    const patchBody = calls[patchIndex]?.stdin ?? "";
    expect(createBody).toContain("### Comments Outside Diff (1)");
    expect(createBody).toContain("src/b.ts");
    expect(patchBody).toContain("### Comments Outside Diff (1)");
    expect(patchBody).toContain("src/b.ts");
  });

  // GitHub #39, the sequence half. The pin (pr.ts) makes the comments
  // correct; these pin the DISCLOSURE — that a head which moved under the
  // run is said out loud on the PR and handed back to the caller, instead of
  // the run publishing as though nothing happened.
  const MOVED_HEAD = "e".repeat(40);

  test("a moved head is disclosed in the closing summary and on the outcome", async () => {
    const findings = [finding({ id: "F001", path: "src/a.ts", line: 10 })];
    const { spawnFn, calls } = makeFakeGh([
      headRefOidScript(MOVED_HEAD),
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.movedHeadSha).toBe(MOVED_HEAD);
    // Posted, pinned, disclosed — never aborted and never filtered. What a
    // re-review should DO about findings computed on a stale head is ROADMAP
    // item 7's design work; dropping the post here would be the invisible
    // loss the direction-of-error rule ranks worst.
    expect(outcome.reviewOutcome).toBe("posted");
    expect(outcome.reviewFindingCount).toBe(1);
    const patch = calls
      .filter(
        (c) =>
          c.argv.join(" ").includes("PATCH") &&
          c.stdin?.startsWith("<!-- pr-hero-report "),
      )
      .at(-1);
    expect(patch?.stdin).toContain("⚠️ **The PR moved while this review ran.**");
    expect(patch?.stdin).toContain(`the PR head is now \`${MOVED_HEAD}\``);
    // The placeholder create predates the re-read on purpose (it is the
    // FIRST write of the run, and the check belongs next to the
    // anchor-bearing call); the closing PATCH is the authoritative body.
    const create = calls.find(
      (c) =>
        c.argv.join(" ").includes("POST") &&
        c.argv.join(" ").includes("issues/42/comments") &&
        c.stdin?.startsWith("<!-- pr-hero-report "),
    );
    expect(create?.stdin).not.toContain("The PR moved");
  });

  test("the head is re-read BEFORE the review submission, not after it", async () => {
    const findings = [finding({ id: "F001", path: "src/a.ts", line: 10 })];
    const { spawnFn, calls } = makeFakeGh([
      headRefOidScript(MOVED_HEAD),
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    const readIndex = calls.findIndex((c) => c.argv.includes("headRefOid"));
    const reviewIndex = calls.findIndex((c) =>
      c.argv.join(" ").includes("pulls/42/reviews"),
    );
    expect(readIndex).toBeGreaterThanOrEqual(0);
    // The window is the whole point: a check run earlier answers a question
    // about a different moment.
    expect(readIndex).toBe(reviewIndex - 1);
  });

  // The reason the re-read lives in the sequence owner and not inside
  // postPrReview: postPrReview returns early on zero anchorable findings
  // without touching gh, and a run with nothing to anchor STILL publishes a
  // summary — the ✅ clean bill included.
  test("a run with nothing to anchor still re-reads the head and still discloses", async () => {
    const findings = [finding({ id: "F001", path: "src/never.ts", line: 1 })];
    const { spawnFn, calls } = makeFakeGh([
      headRefOidScript(MOVED_HEAD),
      ...emptyCommentScript(),
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/other.ts", 5),
      webUrl: undefined,
      spawnFn,
    });
    expect(calls.some((c) => c.argv.join(" ").includes("reviews"))).toBe(false);
    expect(calls.some((c) => c.argv.includes("headRefOid"))).toBe(true);
    expect(outcome.movedHeadSha).toBe(MOVED_HEAD);
    expect(summaryStdins(calls).at(-1)).toContain(
      "⚠️ **The PR moved while this review ran.**",
    );
  });

  test("an unmoved head says nothing, and the submission still pins the reviewed head", async () => {
    const findings = [finding({ id: "F001", path: "src/a.ts", line: 10 })];
    const { spawnFn, calls } = makeFakeGh([
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.movedHeadSha).toBeUndefined();
    expect(summaryStdins(calls).every((b) => !b.includes("The PR moved"))).toBe(
      true,
    );
    const submission = calls.find((c) =>
      c.argv.join(" ").includes("pulls/42/reviews"),
    );
    expect(JSON.parse(submission?.stdin ?? "{}").commit_id).toBe(HEAD);
  });

  // The pin is the correctness mechanism; the re-read is only the
  // disclosure. A disclosure that cannot be made must not cost the post the
  // pin already protects — so a failed re-read publishes exactly the
  // unmoved body, and the run neither throws nor invents a mismatch.
  test("a re-read that fails posts anyway, claiming nothing about the head", async () => {
    const findings = [finding({ id: "F001", path: "src/a.ts", line: 10 })];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["headRefOid"],
        response: { stderr: "gh: rate limited (HTTP 403)", exitCode: 1 },
      },
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.movedHeadSha).toBeUndefined();
    expect(outcome.reviewOutcome).toBe("posted");
    expect(summaryStdins(calls).every((b) => !b.includes("The PR moved"))).toBe(
      true,
    );
  });

  // Acceptance criterion 4, at the sequence level: pinning must not turn a
  // recoverable demotion into a hard failure. A force-push does BOTH — it
  // moves the head AND rewrites the reviewed commit out of the PR, so the
  // pinned submission 422s. The findings must still land, in the summary's
  // Outside Diff bucket, alongside the moved-head notice.
  test("a moved head plus a 422 still demotes into the Outside Diff bucket", async () => {
    const findings = [finding({ id: "F001", path: "src/a.ts", line: 10 })];
    const { spawnFn, calls } = makeFakeGh([
      headRefOidScript(MOVED_HEAD),
      ...emptyCommentScript(),
      {
        match: ["pulls/42/reviews"],
        response: {
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewOutcome).toBe("demoted");
    expect(outcome.outsideDiffCount).toBe(1);
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(outcome.movedHeadSha).toBe(MOVED_HEAD);
    const patch = summaryStdins(calls).at(-1) ?? "";
    expect(patch).toContain("### Comments Outside Diff (1)");
    expect(patch).toContain("⚠️ **The PR moved while this review ran.**");
  });

  test("zero anchorable findings never reaches the reviews endpoint at all", async () => {
    const findings = [finding({ id: "F001", path: "src/never.ts", line: 1 })];
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      // "src/never.ts" is not in the diff at all — un-anchorable.
      diffPatch: diffAddingLines("src/other.ts", 5),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewOutcome).toBe("posted");
    expect(outcome.reviewFindingCount).toBe(0);
    expect(outcome.issueCommentIds).toEqual([]);
    expect(outcome.outsideDiffCount).toBe(1);
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(calls.some((c) => c.argv.join(" ").includes("reviews"))).toBe(false);
    expect(findingIssueCommentPosts(calls)).toHaveLength(0);
    const bodies = summaryStdins(calls);
    expect(bodies.length).toBeGreaterThan(0);
    expect(
      bodies.every((b) => b.includes("### Comments Outside Diff (1)")),
    ).toBe(true);
    expect(bodies.some((b) => b.includes("src/never.ts"))).toBe(true);
  });

  // W2 (issues #16/#17): un-anchorable findings pool into ONE summary
  // Comments Outside Diff section, never as standalone issue comments.
  // The prior suite pinned R4's "exactly one issue comment each"; that
  // channel is retired. Two un-anchorable findings, both in the summary
  // bucket, zero finding-marker POSTs, closes the new contract.
  test("two un-anchorable findings post in the summary Outside Diff section, never as issue comments", async () => {
    const findings = [
      finding({ id: "F001", path: "src/never-a.ts", line: 1 }),
      finding({ id: "F002", path: "src/never-b.ts", line: 1 }),
    ];
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      // Neither path is in the diff at all — both un-anchorable.
      diffPatch: diffAddingLines("src/other.ts", 5),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewFindingCount).toBe(0);
    expect(outcome.issueCommentIds).toEqual([]);
    expect(outcome.outsideDiffCount).toBe(2);
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(findingIssueCommentPosts(calls)).toHaveLength(0);
    const bodies = summaryStdins(calls);
    expect(bodies.length).toBe(2); // create + PATCH
    for (const body of bodies) {
      expect(body).toContain("### Comments Outside Diff (2)");
      expect(body).toContain("src/never-a.ts");
      expect(body).toContain("src/never-b.ts");
      expect(body).toContain(
        "the value is stored in seconds and read as milliseconds",
      );
    }
  });

  test("an off-hunk finding re-anchors to a hunter-cited in-diff proof_ref instead of Outside Diff (Musive #1727)", async () => {
    const findings = [
      finding({
        id: "F001",
        path: "src/a.ts",
        line: 544,
        proof_refs: ["src/a.ts:544", "src/a.ts:10 (the retry that causes it)"],
      }),
    ];
    const { spawnFn, calls } = makeFakeGh([
      ...emptyCommentScript(),
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewOutcome).toBe("posted");
    expect(outcome.reviewFindingCount).toBe(1);
    expect(outcome.outsideDiffCount).toBe(0);
    expect(outcome.issueCommentIds).toEqual([]);
    const review = calls.find((c) =>
      c.argv.join(" ").includes("pulls/42/reviews"),
    );
    const body = JSON.parse(review?.stdin ?? "null") as {
      comments: { line: number; body: string }[];
    };
    expect(body.comments[0]?.line).toBe(10);
    expect(body.comments[0]?.body).toContain("line=10");
    // The summary still names the finding's original location — the claim
    // is about 544; only the GitHub anchor moved.
    const summaries = summaryStdins(calls);
    expect(summaries.some((s) => s.includes("src/a.ts:544"))).toBe(true);
    expect(summaries.every((s) => !s.includes("Comments Outside Diff"))).toBe(
      true,
    );
  });
});

describe("postInlineFindings — the 422 recovery never drops a finding", () => {
  // Mirrors verify-report-pr2 (#3296)'s CRIT-1 repro at THIS composition
  // layer: a prior comment already claimed by a PERSISTING finding must not
  // become available to swallow a DIFFERENT, genuinely fresh finding during
  // the 422 recovery. Proven by mutation (Method, per the brief): with
  // `allFindings` narrowed back to just the review-submission subset
  // (`reviewFindings`) in postInlineFindings, this test's assertion on
  // `droppedFindingIds` / F002 in the summary Outside Diff fails (F002
  // disappears from both channels); reverted after observing the failure.
  test("a claimed comment does not swallow a fresh finding on 422", async () => {
    const claimedMarker = findingMarker({
      path: "src/a.ts",
      line: 100,
      headSha: OLD_HEAD,
      claim: "F001's claim",
    });
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 100 }), // persists to P
      finding({ id: "F002", path: "src/a.ts", line: 103 }), // fresh, near P
    ];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        response: { stdout: "" },
      },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 7,
              user: "pr-hero",
              body: `${claimedMarker}\nclaim`,
              path: "src/a.ts",
              line: 100,
              original_line: 100,
              in_reply_to_id: null,
            },
          ]),
        },
      },
      {
        match: ["pulls/42/reviews"],
        response: {
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 200),
      webUrl: undefined,
      spawnFn,
    });
    // F001 already had a home (comment 7); F002 must surface in the
    // summary Outside Diff bucket — never dropped, never an issue comment.
    expect(outcome.reviewOutcome).toBe("demoted");
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(outcome.issueCommentIds).toEqual([]);
    expect(outcome.outsideDiffCount).toBe(1);
    expect(findingIssueCommentPosts(calls)).toHaveLength(0);
    const patchBody =
      calls.find(
        (c) =>
          c.argv.join(" ").includes("PATCH") &&
          c.stdin?.startsWith("<!-- pr-hero-report "),
      )?.stdin ?? "";
    expect(patchBody).toContain("### Comments Outside Diff (1)");
    expect(patchBody).toContain("`src/a.ts:103`");
    expect(patchBody).toContain(
      "the value is stored in seconds and read as milliseconds",
    );
  });

  // CRIT-A (verify-report-pr3, #3305) — the verifier's exact tie-dissolution
  // repro, driven through the FULL composition (resolveInlinePostPlan →
  // postPrReview's 422 recovery), not just the pr.ts unit. Prior comments R1
  // @ line 100 and R2 @ line 104 sit equidistant (2, 2) from F001 @ line
  // 102 — a genuine ambiguous tie the ORIGINAL plan resolves by posting F001
  // fresh, per spec "Ambiguous matches post as new, never a forced match".
  // F002 @ line 104 exactly claims R2 and persists. The failure this guards:
  // narrowing the 422 recovery's re-match to just the review submission's
  // own subset ([F001]) drops R2 from the candidate set (it is "claimed" by
  // F002), leaving R1 as F001's SOLE remaining candidate — dissolving the
  // tie and silently swallowing F001 into neither channel. Property under
  // test: no finding reaches neither channel, for this arrangement too, not
  // only the CRIT-1 arrangement above.
  test("a tie the plan resolved to post-fresh survives the 422 recovery, even though a sibling finding persists to the OTHER tied candidate (CRIT-A)", async () => {
    const r1 = findingMarker({
      path: "src/a.ts",
      line: 100,
      headSha: OLD_HEAD,
      claim: "prior claim one",
    });
    const r2 = findingMarker({
      path: "src/a.ts",
      line: 104,
      headSha: OLD_HEAD,
      claim: "prior claim two",
    });
    const findings = [
      finding({
        id: "F001",
        path: "src/a.ts",
        line: 102,
        claim: "a genuinely new finding, tied between R1 and R2",
      }),
      finding({
        id: "F002",
        path: "src/a.ts",
        line: 104,
        claim: "exactly claims the prior comment at line 104",
      }),
    ];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        response: { stdout: "" },
      },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 101,
              user: "pr-hero",
              body: `${r1}\nprior claim one`,
              path: "src/a.ts",
              line: 100,
              original_line: 100,
              in_reply_to_id: null,
            },
            {
              id: 102,
              user: "pr-hero",
              body: `${r2}\nprior claim two`,
              path: "src/a.ts",
              line: 104,
              original_line: 104,
              in_reply_to_id: null,
            },
          ]),
        },
      },
      {
        match: ["pulls/42/reviews"],
        response: {
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 200),
      webUrl: undefined,
      spawnFn,
    });
    // F001 must still reach a channel — never dropped because R2 (F002's
    // match) briefly looked like its sole remaining tie candidate.
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(outcome.reviewOutcome).toBe("demoted");
    expect(outcome.issueCommentIds).toEqual([]);
    expect(outcome.outsideDiffCount).toBe(1);
    expect(findingIssueCommentPosts(calls)).toHaveLength(0);
    const patchBody =
      calls.find(
        (c) =>
          c.argv.join(" ").includes("PATCH") &&
          c.stdin?.startsWith("<!-- pr-hero-report "),
      )?.stdin ?? "";
    expect(patchBody).toContain("### Comments Outside Diff (1)");
    expect(patchBody).toContain("`src/a.ts:102`");
    expect(patchBody).toContain(
      "a genuinely new finding, tied between R1 and R2",
    );
  });
});

// The rematch-before-issue-comment-POST (live PR #4, comment 3767088276)
// existed only to prevent duplicate finding issue comments. W2 retires that
// POST, so the rematch is gone too — identity for the Outside Diff bucket
// is the next slice. These tests pin the retirement: zero finding issue
// comments, and a workless persist run still pays for no extra gh call.
describe("postInlineFindings — no finding issue-comment POST (issues #16/#17)", () => {
  test("a leftover concurrent issue comment does not recreate a finding issue comment; the finding reaches Outside Diff", async () => {
    const findings = [
      finding({
        id: "F001",
        path: "src/never.ts", // not in the diff — un-anchorable
        line: 1,
        claim: "an un-anchorable finding",
      }),
    ];
    // An existing SUMMARY comment is scripted so `postPrComment`'s own
    // internal existing-comment check doesn't add a THIRD indistinguishable
    // read. The concurrent leftover issue comment from another process is
    // NOT re-fetched this slice (rematch retired); the finding still lands
    // in the summary Outside Diff and is not dropped.
    const summaryMarker = `<!-- pr-hero-report head=${HEAD} -->`;
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        responses: [
          {
            stdout: ndjson([
              {
                id: 200,
                user: "pr-hero",
                body: `${summaryMarker}\nsummary body`,
              },
            ]),
          }, // 1st fetch (resolveInlinePostPlan's own existingSummaryId read)
          { stdout: "" }, // 2nd fetch (fetchPostedFindingComments, same plan snapshot)
        ],
      },
      { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/other.ts", 5),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.issueCommentIds).toEqual([]);
    expect(outcome.outsideDiffCount).toBe(1);
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(findingIssueCommentPosts(calls)).toHaveLength(0);
    const issueGetCalls = calls.filter(
      (c) =>
        c.argv.join(" ").includes("issues/42/comments") &&
        c.argv.join(" ").includes("--paginate"),
    );
    expect(issueGetCalls.length).toBe(2);
    const patchBody =
      calls.find(
        (c) =>
          c.argv.join(" ").includes("PATCH") &&
          c.stdin?.startsWith("<!-- pr-hero-report "),
      )?.stdin ?? "";
    expect(patchBody).toContain("### Comments Outside Diff (1)");
    expect(patchBody).toContain("an un-anchorable finding");
  });

  test("nothing to post skips the re-fetch entirely — a workless run pays for no extra gh call", async () => {
    // Anchorable finding, already persisting from a prior run — the plan has
    // NOTHING to post in either channel. An existing summary comment is
    // scripted too, so `postPrComment`'s own internal existing-comment check
    // never fires either (it PATCHes the known summary id directly) — the
    // ONLY "issues/42/comments" reads in a fully-idempotent run are the two
    // the plan snapshot itself makes.
    const summaryMarker = `<!-- pr-hero-report head=${OLD_HEAD} -->`;
    const marker = findingMarker({
      path: "src/a.ts",
      line: 10,
      headSha: HEAD,
      claim: "unchanged claim",
    });
    const findings = [
      finding({
        id: "F001",
        path: "src/a.ts",
        line: 10,
        claim: "unchanged claim",
      }),
    ];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 200,
              user: "pr-hero",
              body: `${summaryMarker}\nsummary body`,
            },
          ]),
        },
      },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 9,
              user: "pr-hero",
              body: `${marker}\nunchanged claim`,
              path: "src/a.ts",
              line: 10,
              original_line: 10,
              in_reply_to_id: null,
            },
          ]),
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.issueCommentIds.length).toBe(0);
    expect(outcome.reviewFindingCount).toBe(0);
    expect(outcome.droppedFindingIds).toEqual([]);
    // Exactly TWO reads of the issue endpoint (existingSummaryId + the
    // plan's own posted-comments read) — no rematch re-fetch (retired with
    // the issue-comment POST).
    const issueGetCalls = calls.filter(
      (c) =>
        c.argv.join(" ").includes("issues/42/comments") &&
        c.argv.join(" ").includes("--paginate"),
    );
    expect(issueGetCalls.length).toBe(2);
    const reviewGetCalls = calls.filter(
      (c) =>
        c.argv.join(" ").includes("pulls/42/comments") &&
        c.argv.join(" ").includes("--paginate"),
    );
    expect(reviewGetCalls.length).toBe(1);
  });
});

describe("postInlineFindings — idempotency, same head, drifted live line", () => {
  // Spec "Idempotency across two runs on the same head" + PR1's verify-report
  // §9 note: exercise a same-head case where liveLine != marker.line. GitHub
  // re-anchors a review comment's live `line` whenever the diff changes
  // (e.g. the base moved), even with no new push to THIS head — the
  // same-head match must key on the MARKER's stored line, not the drifted
  // live one, or an unmoved finding reposts.
  test("same head, live line drifted from the marker's stored line: zero reposts", async () => {
    const marker = findingMarker({
      path: "src/a.ts",
      line: 100,
      headSha: HEAD, // SAME head as this run
      claim: "unchanged claim",
    });
    // F002 fix: the exact same-head branch now consults the claim
    // fingerprint too, so this genuinely idempotent case needs the
    // finding's claim to match what the marker was posted with — an
    // UNCHANGED claim, as the describe block's name promises.
    const findings = [
      finding({
        id: "F001",
        path: "src/a.ts",
        line: 100,
        claim: "unchanged claim",
      }),
    ];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        response: { stdout: "" },
      },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 7,
              user: "pr-hero",
              body: `${marker}\nunchanged claim`,
              path: "src/a.ts",
              // Drifted live line (base advanced, no new push) — 12 away
              // from the marker's stored 100, well outside the ±5 window.
              line: 112,
              original_line: 112,
              in_reply_to_id: null,
            },
          ]),
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 200),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome.reviewFindingCount).toBe(0); // matched, not fresh
    expect(outcome.issueCommentIds.length).toBe(0);
    expect(outcome.droppedFindingIds).toEqual([]);
    expect(outcome.delta).toEqual({ resolved: 0, new: 0, persist: 1 });
    // No POST to pulls/42/reviews and no per-finding issue comment — the
    // ONLY mutating call is the summary PATCH/POST.
    expect(calls.some((c) => c.argv.join(" ").includes("reviews"))).toBe(false);
    expect(
      calls.filter(
        (c) =>
          c.argv.join(" ").includes("issues/42/comments") &&
          c.stdin?.startsWith(PR_FINDING_MARKER_PREFIX),
      ).length,
    ).toBe(0);
  });
});

// Juanma's PR #2 feedback: the summary's index links each line to its own
// comment. Three sources feed `buildCommentUrlMap` (cli.ts) and none are
// exercised by makeFakeGh's STATELESS script — a persisting match's url
// needs no extra fetch, but a FRESHLY posted review comment's url needs a
// re-fetch to see what THIS run just posted, which a stateless fixture
// cannot simulate. This test uses a bespoke, call-counting fake instead.
describe("postInlineFindings — comment url map reaches the summary's index", () => {
  test("persisting, freshly-issued, and freshly-reviewed findings all resolve to a comment url", async () => {
    const WEB_URL = "https://github.com/musivetech/musive";
    const priorMarker = findingMarker({
      path: "src/a.ts",
      line: 10,
      headSha: OLD_HEAD,
      claim: "unchanged claim",
    });
    const findings = [
      // Persists — matched to comment id 7 from a prior run.
      finding({
        id: "F001",
        path: "src/a.ts",
        line: 10,
        claim: "unchanged claim",
      }),
      // Fresh, anchorable — goes into the review submission.
      finding({
        id: "F002",
        path: "src/a.ts",
        line: 20,
        claim: "a fresh anchorable finding",
      }),
      // Fresh, un-anchorable — goes into the summary Outside Diff section.
      finding({
        id: "F003",
        path: "src/never.ts",
        line: 1,
        claim: "a fresh un-anchorable finding",
      }),
    ];
    let pullsCommentsCalls = 0;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const calls: RecordedCall[] = [];
    let nextId = 200;
    const respond = (stdout: string, exitCode = 0) => {
      const stream = (text: string) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (text) controller.enqueue(encoder.encode(text));
            controller.close();
          },
        });
      return {
        stdout: stream(stdout),
        stderr: stream(""),
        exited: Promise.resolve(exitCode),
        kill() {},
      };
    };
    const spawnFn = ((argv: string[], opts?: { stdin?: Uint8Array }) => {
      const stdin =
        opts?.stdin === undefined ? undefined : decoder.decode(opts.stdin);
      calls.push({ argv, stdin });
      const joined = argv.join(" ");
      if (
        joined.includes("issues/42/comments") &&
        joined.includes("--paginate")
      ) {
        return respond("");
      }
      if (
        joined.includes("pulls/42/comments") &&
        joined.includes("--paginate")
      ) {
        pullsCommentsCalls += 1;
        const rows: unknown[] = [
          {
            id: 7,
            user: "pr-hero",
            body: `${priorMarker}\nunchanged claim`,
            path: "src/a.ts",
            line: 10,
            original_line: 10,
            in_reply_to_id: null,
          },
        ];
        // Only the SECOND+ fetch (the re-fetch after the review posted)
        // sees F002's own comment — simulating "this run just created it".
        if (pullsCommentsCalls > 1) {
          const freshMarker = findingMarker({
            path: "src/a.ts",
            line: 20,
            headSha: HEAD,
            claim: "a fresh anchorable finding",
          });
          rows.push({
            id: 55,
            user: "pr-hero",
            body: `${freshMarker}\nfresh`,
            path: "src/a.ts",
            line: 20,
            original_line: 20,
            in_reply_to_id: null,
          });
        }
        return respond(ndjson(rows));
      }
      if (joined.includes("pulls/42/reviews")) {
        return respond("");
      }
      return respond(JSON.stringify({ id: nextId++ }));
    }) as unknown as typeof Bun.spawn;

    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 30),
      webUrl: WEB_URL,
      spawnFn,
    });

    expect(outcome.reviewFindingCount).toBe(1); // F002
    expect(outcome.issueCommentIds).toEqual([]);
    expect(outcome.outsideDiffCount).toBe(1); // F003
    expect(outcome.droppedFindingIds).toEqual([]);

    const patchCall = calls.find(
      (c) =>
        c.argv.join(" ").includes("PATCH") &&
        c.stdin?.startsWith("<!-- pr-hero-report "),
    );
    // F001, persisting, linked from plan.persisting with no extra fetch.
    expect(patchCall?.stdin).toContain(`${WEB_URL}/pull/42#discussion_r7`);
    // F002, freshly posted to the review, linked via the post-posting
    // re-fetch + marker match.
    expect(patchCall?.stdin).toContain(`${WEB_URL}/pull/42#discussion_r55`);
    // F003 has no per-finding comment — unlinked in the index, full body
    // in the Outside Diff bucket, never an #issuecomment- permalink.
    expect(patchCall?.stdin).not.toContain("#issuecomment-");
    expect(patchCall?.stdin).toContain("### Comments Outside Diff (1)");
    expect(patchCall?.stdin).toContain("a fresh un-anchorable finding");
    expect(patchCall?.stdin).toContain("`src/never.ts:1`");
  });
});

// WARN-5 (verify-report-pr3, #3305): `previousHeadSha` and the finding
// `claim` feed are dead at the composition layer — pinned one layer down
// (report.ts/inline.ts) but not proven to actually REACH those functions
// from here. Both closed below.
describe("postInlineFindings — previousHeadSha reaches the rendered summary", () => {
  test("a prior summary comment's head= is threaded through to the delta's 'since' clause", async () => {
    const priorSummary = `<!-- pr-hero-report head=${OLD_HEAD} -->\n## pr-hero review`;
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([{ id: 1, user: "pr-hero", body: priorSummary }]),
        },
      },
      { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
    ]);
    await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    const summaryCall = calls.find((c) =>
      c.stdin?.startsWith("<!-- pr-hero-report "),
    );
    expect(summaryCall).toBeDefined();
    // "diff from `aaaaaaaa`" (base_sha) ALSO contains OLD_HEAD's 8-char
    // prefix unconditionally, so assert the SPECIFIC "since" clause, not
    // merely the substring's presence — the weaker assertion would pass
    // even with previousHeadSha wired to undefined.
    expect(summaryCall?.stdin).toContain(`Δ since \`${OLD_HEAD.slice(0, 8)}\``);
  });
});

// WARN-5's other half: the fingerprint tie-break (design D3) depends on the
// REAL claim text reaching the matcher through resolveInlinePostPlan's
// `findingRefs` — a claim silently replaced by "" would disable the
// tie-break for every real run.
describe("postInlineFindings — the claim feed reaches the fingerprint tie-break", () => {
  test("a tie resolved by a matching fingerprint persists, using the finding's REAL claim text", async () => {
    const priorClaim = "the exact claim text this run's finding repeats";
    const r1 = findingMarker({
      path: "src/a.ts",
      line: 100,
      headSha: OLD_HEAD,
      claim: "a different prior claim, at the same distance",
    });
    const r2 = findingMarker({
      path: "src/a.ts",
      line: 104,
      headSha: OLD_HEAD,
      claim: priorClaim,
    });
    // F001 sits equidistant (2) from both R1 (line 100) and R2 (line 104) —
    // an ambiguous tie UNLESS the fingerprint on its real claim breaks it
    // toward R2, whose stored fingerprint matches priorClaim.
    const findings = [
      finding({ id: "F001", path: "src/a.ts", line: 102, claim: priorClaim }),
    ];
    const { spawnFn, calls } = makeFakeGh([
      {
        match: ["issues/42/comments", "--paginate"],
        response: { stdout: "" },
      },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 101,
              user: "pr-hero",
              body: `${r1}\na different prior claim, at the same distance`,
              path: "src/a.ts",
              line: 100,
              original_line: 100,
              in_reply_to_id: null,
            },
            {
              id: 102,
              user: "pr-hero",
              body: `${r2}\n${priorClaim}`,
              path: "src/a.ts",
              line: 104,
              original_line: 104,
              in_reply_to_id: null,
            },
          ]),
        },
      },
    ]);
    const outcome = await postInlineFindings({
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings }),
      diffPatch: diffAddingLines("src/a.ts", 200),
      webUrl: undefined,
      spawnFn,
    });
    // The fingerprint tie-break resolved the ambiguity: F001 persists
    // (matched to R2), never posted fresh.
    expect(outcome.reviewFindingCount).toBe(0);
    expect(outcome.issueCommentIds.length).toBe(0);
    // R1 (unmatched this run) is the delta's "resolved" side; F001 is the
    // "persist" side (matched to R2 via the fingerprint tie-break).
    expect(outcome.delta).toEqual({ resolved: 1, new: 0, persist: 1 });
    expect(calls.some((c) => c.argv.join(" ").includes("reviews"))).toBe(false);
  });
});

describe("postInlineIfEligible — sessionFailed suppresses all posting", () => {
  test("sessionFailed true: zero HTTP calls, returns null", async () => {
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
    const outcome = await postInlineIfEligible({
      sessionFailed: true,
      skippedReason: "post skipped: every hunter failed",
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings: [finding({ id: "F001" })] }),
      diffPatch: diffAddingLines("src/app.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome).toBeNull();
    expect(calls.length).toBe(0);
  });

  test("sessionFailed false: posts normally and returns the outcome", async () => {
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript());
    const outcome = await postInlineIfEligible({
      sessionFailed: false,
      skippedReason: "unreachable",
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({ findings: [] }),
      diffPatch: diffAddingLines("src/app.ts", 20),
      webUrl: undefined,
      spawnFn,
    });
    expect(outcome).not.toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("postingExitCode — design D6's exit-1 rule", () => {
  function outcome(overrides: Partial<InlinePostOutcome>): InlinePostOutcome {
    return {
      reviewOutcome: "posted",
      reviewFindingCount: 0,
      issueCommentIds: [],
      outsideDiffCount: 0,
      summary: { action: "created", commentId: 1 },
      delta: { resolved: 0, new: 0, persist: 0 },
      droppedFindingIds: [],
      commentUrls: new Map(),
      movedHeadSha: undefined,
      ...overrides,
    };
  }

  test("exit 0 when every finding reached a channel", () => {
    expect(postingExitCode(outcome({ droppedFindingIds: [] }))).toBe(0);
  });

  test("exit 1 when any finding reached neither channel", () => {
    expect(postingExitCode(outcome({ droppedFindingIds: ["F002"] }))).toBe(1);
  });

  test("a null outcome (sessionFailed, or --post not given) is not itself a posting failure", () => {
    expect(postingExitCode(null)).toBe(0);
  });
});

describe("assertRunMatchesPr — Threat Matrix: Git repository selection", () => {
  test("a run-dir for the SAME pr passes silently", () => {
    expect(() =>
      assertRunMatchesPr(doc({ pr: 42 }), 42, "/runs/x"),
    ).not.toThrow();
  });

  // Deferred from PR2's verification (WARN-1's scope note): the `post` verb
  // must reject a run-dir belonging to a DIFFERENT PR than --pr names,
  // rather than silently publishing PR #17's findings to PR #18.
  test("a run-dir for a DIFFERENT pr is rejected, naming both", () => {
    try {
      assertRunMatchesPr(doc({ pr: 17 }), 18, "/runs/pr-17-run");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain("17");
      expect((error as Error).message).toContain("18");
      expect((error as Error).message).toContain("/runs/pr-17-run");
    }
  });
});

describe("computeDroppedFindingIds — design D6's oracle", () => {
  // WARN-1 (verify-report-pr3, #3305): under the CRIT-A fix, a genuine drop
  // is no longer reachable through normal postInlineFindings execution — the
  // formula itself still needs its own pin, hand-built, the same way
  // postingExitCode is tested against a literal rather than a live outcome.
  function ref(id: string): PrHeroFindingRef {
    return { id, path: "src/a.ts", line: 1, claim: "x", tier: "blocking" };
  }

  test("every expected id reached: nothing dropped", () => {
    expect(
      computeDroppedFindingIds(
        [ref("F001"), ref("F002")],
        new Set(["F001", "F002"]),
      ),
    ).toEqual([]);
  });

  test("an expected id absent from reached: dropped", () => {
    expect(
      computeDroppedFindingIds([ref("F001"), ref("F002")], new Set(["F001"])),
    ).toEqual(["F002"]);
  });

  test("reached carrying an id NOT in expected does not manufacture a drop", () => {
    expect(
      computeDroppedFindingIds([ref("F001")], new Set(["F001", "F999"])),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runPostCommand — CRIT-B (verify-report-pr3, #3305): the `post` verb is the
// $0 gate standing in front of the first live GitHub write this project will
// ever make. It had zero covering tests and was structurally untestable —
// unexported, and its dry-run branch never threaded `spawnFn`, so even an
// exported version would still have reached the real `gh`. Fixed by
// extracting `runPostCommand` (everything after `resolveRepoRoot`'s real
// `git` call, which stays in the unexported, untested-by-design
// `postCommand` shell) as an exported, `spawnFn`-injectable function.
//
// Uses a REAL temp directory for findings.json/diff.patch (runPostCommand
// reads them off disk via Bun.file — that I/O is not worth faking) but a
// FAKE gh for every network-shaped call, via the same makeFakeGh harness
// used everywhere else in this file.

const RUN_HEAD = "c".repeat(40);

async function writeRunDir(
  overrides: Partial<FindingsDocument> = {},
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-post-test-"));
  const runDoc = doc({ head_sha: RUN_HEAD, ...overrides });
  await Bun.write(
    path.join(dir, "findings.json"),
    JSON.stringify(runDoc, null, 2),
  );
  await Bun.write(
    path.join(dir, "diff.patch"),
    diffAddingLines("src/a.ts", 200),
  );
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("runPostCommand — CRIT-B: the $0 gate before the first live write", () => {
  test("dry-run performs ZERO mutating gh calls — inverting this must fail a test", async () => {
    const { dir, cleanup } = await writeRunDir({
      findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
    });
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: true,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      // The read-only comment fetches DID happen (this is a real preview,
      // not a no-op) — but nothing in them mutates.
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.argv).not.toContain("--method");
        expect(call.argv.join(" ")).not.toContain("reviews");
      }
    } finally {
      await cleanup();
    }
  });

  test("dry-run lists un-anchorable findings as outside, not issue", async () => {
    const { dir, cleanup } = await writeRunDir({
      findings: [finding({ id: "F001", path: "src/never.ts", line: 1 })],
    });
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: true,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const logged = chunks.join("");
      expect(logged).toContain("1 outside diff");
      expect(logged).toContain("outside src/never.ts:1 F001");
      expect(logged).not.toContain("issue comment(s)");
      expect(logged).not.toContain("  issue   ");
      for (const call of calls) {
        expect(call.argv).not.toContain("--method");
      }
    } finally {
      process.stderr.write = origWrite;
      await cleanup();
    }
  });

  test("a live post (no --dry-run) performs exactly the expected mutating calls and writes post.json", async () => {
    const { dir, cleanup } = await writeRunDir({
      findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
    });
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...emptyCommentScript(RUN_HEAD),
        { match: ["pulls/42/reviews"], response: { stdout: "" } },
      ]);
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(
        calls.some((c) => c.argv.join(" ").includes("pulls/42/reviews")),
      ).toBe(true);
      expect(
        calls.some(
          (c) =>
            c.argv.join(" ").includes("issues/42/comments") &&
            c.stdin?.startsWith("<!-- pr-hero-report "),
        ),
      ).toBe(true);
      // WARN-2 (verify-report-pr3): post.json is written but was never
      // asserted anywhere — WU7/4.4's idempotency proof reads it back.
      const receiptPath = path.join(dir, "post.json");
      const receipt = JSON.parse(await Bun.file(receiptPath).text());
      expect(receipt.pr).toBe(42);
      expect(receipt.head_sha).toBe(RUN_HEAD);
      expect(receipt.review.outcome).toBe("posted");
      expect(receipt.review.finding_count).toBe(1);
      expect(Array.isArray(receipt.issue_comment_ids)).toBe(true);
      expect(receipt.dropped_finding_ids).toEqual([]);
      expect(receipt.summary_comment.action).toBe("created");
    } finally {
      await cleanup();
    }
  });

  // WARN-3 (deferred from PR2's verification): assertRunMatchesPr's call
  // site inside the verb, not just the pure function — reject a run-dir
  // whose OWN findings.json disagrees with --pr, before any gh call at all.
  test("a run-dir for a DIFFERENT pr is rejected before any gh call — assertRunMatchesPr's call site", async () => {
    const { dir, cleanup } = await writeRunDir({ pr: 17 });
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 18,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(CliUsageError);
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  // The run-status guard: a partial run refuses to post live and makes zero
  // gh calls — this is the property M4 (verify-report-pr3's mutation table)
  // proved unpinned by forcing the guard to `false`.
  test("the run-status guard refuses a partial run on a live post: exit 1, zero gh calls", async () => {
    const { dir, cleanup } = await writeRunDir({ run_status: "partial" });
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(1);
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("the run-status guard on a dry-run of a partial run: exit 0, zero gh calls, no plan printed", async () => {
    const { dir, cleanup } = await writeRunDir({ run_status: "partial" });
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: true,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  // Juanma's decision (verify-report-pr3, #3305): the verb guards on the
  // PERSISTED `sessionFailed`, matching `--pr --post` exactly — a partial
  // run with `sessionFailed: false` (some hunter found nothing, or none ran
  // because gotchas were missing) still posts, same as the live path.
  test("sessionFailed: false persisted on a partial run — posts anyway, matching --pr --post", async () => {
    const { dir, cleanup } = await writeRunDir({
      run_status: "partial",
      sessionFailed: false,
      findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
    });
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...emptyCommentScript(RUN_HEAD),
        { match: ["pulls/42/reviews"], response: { stdout: "" } },
      ]);
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(
        calls.some((c) => c.argv.join(" ").includes("pulls/42/reviews")),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  // The other branch of the same decision: sessionFailed: true persisted —
  // even on a "complete"-looking run_status, the persisted flag is
  // authoritative and refuses to publish.
  test("sessionFailed: true persisted — refuses to post even if run_status looks complete", async () => {
    const { dir, cleanup } = await writeRunDir({
      run_status: "complete",
      sessionFailed: true,
    });
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(1);
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  // Back-compat (mandatory): an artifact written BEFORE this change has no
  // `sessionFailed` field at all. Absent must fall back to today's
  // conservative `run_status !== "complete"` proxy — never to `false`,
  // which would publish a dead run as clean.
  test("sessionFailed absent (legacy artifact) — falls back to the run_status proxy: partial refuses", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-post-test-"));
    try {
      // Hand-built, deliberately WITHOUT `sessionFailed`, unlike writeRunDir
      // (which always calls doc(), and doc()'s spread would carry `undefined`
      // through JSON.stringify as an omitted key anyway — written explicitly
      // here so the "legacy artifact" shape is unambiguous to a reader).
      const legacyDoc = {
        schema_version: "1.0.0",
        pr: 42,
        base_sha: OLD_HEAD,
        head_sha: RUN_HEAD,
        model: "sonnet",
        iteration: 0,
        parity_hunter_fired: false,
        run_status: "partial",
        telemetry: TELEMETRY,
        findings: [],
        debug: { refuted: [] },
      };
      expect("sessionFailed" in legacyDoc).toBe(false);
      await Bun.write(
        path.join(dir, "findings.json"),
        JSON.stringify(legacyDoc, null, 2),
      );
      await Bun.write(
        path.join(dir, "diff.patch"),
        diffAddingLines("src/a.ts", 200),
      );
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(1);
      expect(calls.length).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sessionFailed absent (legacy artifact), run_status complete — the proxy proceeds to post", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-post-test-"));
    try {
      const legacyDoc = {
        schema_version: "1.0.0",
        pr: 42,
        base_sha: OLD_HEAD,
        head_sha: RUN_HEAD,
        model: "sonnet",
        iteration: 0,
        parity_hunter_fired: false,
        run_status: "complete",
        telemetry: TELEMETRY,
        findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
        debug: { refuted: [] },
      };
      await Bun.write(
        path.join(dir, "findings.json"),
        JSON.stringify(legacyDoc, null, 2),
      );
      await Bun.write(
        path.join(dir, "diff.patch"),
        diffAddingLines("src/a.ts", 200),
      );
      const { spawnFn, calls } = makeFakeGh([
        ...emptyCommentScript(RUN_HEAD),
        { match: ["pulls/42/reviews"], response: { stdout: "" } },
      ]);
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(
        calls.some((c) => c.argv.join(" ").includes("pulls/42/reviews")),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// F008 — `post --from` is a re-review too.
//
// Found by a LIVE case-C re-review of PR #49, which is the part that matters:
// `postCommand` called `postInlineFindings` with no `rereview` at all, so a
// run whose pipeline.json recorded {case C, verified 4, live 2} published
// "Δ since e23d8063: 3 resolved · 0 new · 1 persist" — the absence matcher's
// count, three "resolved" for two checks, the exact PR 1759 shape the feature
// exists to prevent — plus no state block, which then costs the NEXT run its
// priors. Nothing offline caught it; the whole `post --from` seam had no
// re-review coverage. These are that coverage.
// ---------------------------------------------------------------------------

describe("runPostCommand — post --from carries the re-review (F008)", () => {
  const SUMMARY_MARKER = `<!-- pr-hero-report head=${OLD_HEAD} -->`;

  function liveRow(over: {
    id: string;
    sev: Finding["severity"];
    status: string;
    line: number;
    claim: string;
  }) {
    return {
      id: over.id,
      sev: over.sev,
      tier: over.sev === "SUGGESTION" ? "advisory" : "blocking",
      channel: "inline",
      status: over.status,
      locs: [`src/a.ts:${over.line}`],
      c: claimFingerprint(over.claim),
      claim: over.claim,
    };
  }

  function rereviewBlock(over: Record<string, unknown> = {}) {
    return {
      case: "C",
      last_reviewed_head: OLD_HEAD,
      last_head_source: "summary_marker",
      discovery_range: `${OLD_HEAD}..${RUN_HEAD}`,
      discovery_restricted: true,
      discovery_skipped_empty_delta: false,
      prior_findings: 3,
      settled_deterministically: 1,
      verified: 2,
      verification_capped: 0,
      verification_triggers: {
        applied: 0,
        touched: 2,
        overlap: 0,
        verify_all: 0,
      },
      live: [
        liveRow({
          id: "R001",
          sev: "CRITICAL",
          status: "carried",
          line: 10,
          claim: "the prior nobody touched",
        }),
        liveRow({
          id: "R002",
          sev: "WARNING",
          status: "unconfirmed",
          line: 20,
          claim: "checked, and the check did not settle it",
        }),
        liveRow({
          id: "R003",
          sev: "WARNING",
          status: "unconfirmed",
          line: 30,
          claim: "the other one the check did not settle",
        }),
      ],
      resolved_verified: 0,
      resolved_ids: [],
      returned: 0,
      re_tiered: 0,
      ...over,
    };
  }

  // A run dir as `pr-hero review --pr <n>` leaves it: findings.json,
  // diff.patch AND pipeline.json. `writeRunDir` deliberately writes only the
  // first two — pipeline.json stays optional, so every first-review post in
  // the suite above keeps proving that path unchanged.
  async function writeRereviewRunDir(
    pipeline: Record<string, unknown> | null,
    docOverrides: Partial<FindingsDocument> = {},
  ): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const { dir, cleanup } = await writeRunDir(docOverrides);
    if (pipeline !== null) {
      await Bun.write(
        path.join(dir, "pipeline.json"),
        JSON.stringify(pipeline, null, 2),
      );
    }
    return { dir, cleanup };
  }

  function priorSummaryScript(): ScriptEntry[] {
    return [
      headRefOidScript(RUN_HEAD),
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 200,
              user: "pr-hero",
              body: `${SUMMARY_MARKER}\n## pr-hero review`,
              updated_at: "2026-08-20T00:00:00Z",
            },
          ]),
        },
      },
      { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
    ];
  }

  function summaryPatch(calls: RecordedCall[]): string {
    const patches = calls.filter((c) =>
      c.stdin?.startsWith("<!-- pr-hero-report "),
    );
    return patches[patches.length - 1]?.stdin ?? "";
  }

  test("the delta and the state block come from live[], never from the matcher", async () => {
    const { dir, cleanup } = await writeRereviewRunDir(
      { rereview: rereviewBlock() },
      { findings: [] },
    );
    try {
      const { spawnFn, calls } = makeFakeGh(priorSummaryScript());
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const body = summaryPatch(calls);
      // The gate vocabulary, counted off live[]: two unconfirmed, one
      // carried, nothing resolved because nothing was checked-and-gone.
      expect(body).toContain(
        "Δ since `aaaaaaaa`: 2 unconfirmed · 1 carried · 0 deferred · 0 new",
      );
      // The matcher's shape, in any form, is the defect.
      expect(body).not.toContain("persist");
      expect(body).not.toContain("resolved (verified)");
      // §3.6: the state block, AFTER the report marker, so the next run has
      // priors with real claims instead of `priorsFromPostedMarkers`' "".
      expect(body).toContain(`<!-- pr-hero-state v=1 head=${RUN_HEAD} -->`);
      expect(body.indexOf("<!-- pr-hero-state ")).toBeGreaterThan(0);
      expect(body).toContain("the prior nobody touched");
      // C7: zero new findings is not a clean bill while priors are live.
      expect(body).not.toContain("found nothing to report");
      expect(body).toContain("`carried`");
      expect(body).toContain("`unconfirmed`");
      // Nothing was verified gone, so nothing is collapsed.
      expect(
        calls.filter((c) => c.argv.join(" ").includes("reviewThreads")),
      ).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("a run dir with no rereview block refuses on a PR that already has a summary", async () => {
    // The self-perpetuating half: publishing this as a first review would
    // print the matcher delta AND write no state block, so the next
    // re-review falls back to claim-less priors.
    const { dir, cleanup } = await writeRereviewRunDir(null, {
      findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
    });
    try {
      const { spawnFn, calls } = makeFakeGh(priorSummaryScript());
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(/no\s+`rereview` block in its pipeline\.json/);
      // Refused BEFORE any write: the summary create and the review
      // submission are both downstream of the precondition.
      expect(calls.filter((c) => c.argv.includes("--method"))).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("a rereview block whose summary the PR no longer has refuses before any write", async () => {
    // The mirror direction, and the one nobody tested: the run dir DID come
    // from a re-review, but the summary it was computed against is gone from
    // the PR — deleted, or `post --from` run long enough after `review` that
    // it did not survive. `existingSummaryId === null` then routes into the
    // create-first branch, so without the precondition this publishes a BRAND
    // NEW comment carrying a `Δ since` delta, a `Still live:` list of `R###`
    // ids and a state block — none of it describing a thread that exists.
    const { dir, cleanup } = await writeRereviewRunDir(
      { rereview: rereviewBlock() },
      { findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })] },
    );
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(/no longer carries a pr-hero summary comment/);
      // Refused BEFORE any write. Refusing after posting the very comment the
      // refusal is about would be worse than not refusing at all.
      expect(calls.filter((c) => c.argv.includes("--method"))).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("a finding_markers block with no summary is S-A, not drift — it posts", async () => {
    // The narrowing the vanished-summary guard needs. Design obligation S-A:
    // "with the summary comment absent, L is recovered from per-finding
    // markers and the run does NOT fall to first-review semantics". Such a
    // block was computed with no summary in sight, so a missing summary at
    // post time is agreement, and its R### ids name finding threads that DO
    // still exist. A guard keyed on `rereview !== undefined` alone refuses
    // here and breaks a case the design supports.
    const { dir, cleanup } = await writeRereviewRunDir(
      { rereview: rereviewBlock({ last_head_source: "finding_markers" }) },
      { findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })] },
    );
    try {
      const { spawnFn } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).resolves.toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("an unreadable rereview block refuses before a single gh call, naming the field", async () => {
    const { dir, cleanup } = await writeRereviewRunDir({
      rereview: rereviewBlock({ live: [{ id: "R001", status: "carried" }] }),
    });
    try {
      const { spawnFn, calls } = makeFakeGh(priorSummaryScript());
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(/unreadable re-review block \(rereview\.live\[0\]\)/);
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("verified-gone findings refuse: the run dir cannot supply the priors collapse binds through", async () => {
    // `assembleLive` retires a verified-gone entry from `live[]`, so the rows
    // the collapse binding needs are exactly the rows the artifact no longer
    // holds — and re-deriving them from the PR renumbers `R###`. Refuse, and
    // name the path that still holds them.
    const { dir, cleanup } = await writeRereviewRunDir({
      rereview: rereviewBlock({
        resolved_verified: 2,
        resolved_ids: ["R004", "R005"],
      }),
    });
    try {
      const { spawnFn, calls } = makeFakeGh(priorSummaryScript());
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(
        /records 2 verified-gone finding\(s\) \(R004, R005\)[\s\S]*review --pr 42 --post/,
      );
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("--dry-run refuses exactly what the post refuses — the preview cannot disagree", async () => {
    // A $0 gate that green-lights a run dir the live path then rejects has
    // answered a different question than the one asked.
    const missing = await writeRereviewRunDir(null);
    const verifiedGone = await writeRereviewRunDir({
      rereview: rereviewBlock({ resolved_verified: 1, resolved_ids: ["R004"] }),
    });
    try {
      const first = makeFakeGh(priorSummaryScript());
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: missing.dir,
          dryRun: true,
          spawnFn: first.spawnFn,
        }),
      ).rejects.toThrow(/no\s+`rereview` block in its pipeline\.json/);
      expect(
        first.calls.filter((c) => c.argv.includes("--method")),
      ).toHaveLength(0);

      const second = makeFakeGh(priorSummaryScript());
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: verifiedGone.dir,
          dryRun: true,
          spawnFn: second.spawnFn,
        }),
      ).rejects.toThrow(/records 1 verified-gone finding/);
      expect(second.calls).toHaveLength(0);
    } finally {
      await missing.cleanup();
      await verifiedGone.cleanup();
    }
  });

  test("--dry-run refuses the vanished summary too — both directions, one answer", async () => {
    // The mirrored half of the same rule: a $0 preview that green-lights a
    // run dir the live path rejects has answered a different question, and
    // that is as true of the re-review-without-a-summary direction as it is
    // of the summary-without-a-rereview-block one above.
    const { dir, cleanup } = await writeRereviewRunDir(
      { rereview: rereviewBlock() },
      { findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })] },
    );
    try {
      const { spawnFn, calls } = makeFakeGh(emptyCommentScript(RUN_HEAD));
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: true,
          spawnFn,
        }),
      ).rejects.toThrow(/no longer carries a pr-hero summary comment/);
      expect(calls.filter((c) => c.argv.includes("--method"))).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("a worsened prior reaches the summary — both severities, from pipeline.json", async () => {
    // W-worse through the `post --from` seam: the "returned" line is the
    // only place the summary names the severity a prior came back at.
    const { dir, cleanup } = await writeRereviewRunDir({
      rereview: rereviewBlock({
        worsened: [
          { priorId: "R001", priorSev: "WARNING", discoverySev: "CRITICAL" },
        ],
      }),
    });
    try {
      const { spawnFn, calls } = makeFakeGh(priorSummaryScript());
      expect(
        await runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).toBe(0);
      expect(summaryPatch(calls)).toContain(
        "returned R001: WARNING → CRITICAL",
      );
    } finally {
      await cleanup();
    }
  });

  test("a pipeline.json that is not JSON refuses before a single gh call", async () => {
    const { dir, cleanup } = await writeRereviewRunDir(null);
    try {
      await Bun.write(path.join(dir, "pipeline.json"), "{ not json");
      const { spawnFn, calls } = makeFakeGh(priorSummaryScript());
      await expect(
        runPostCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(/pipeline\.json is not valid JSON/);
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("a first review is untouched: no summary, no block, matcher delta stays", async () => {
    // The regression boundary. `post --from` on a PR with no prior pr-hero
    // comment is not a re-review and must keep rendering byte-identically.
    const { dir, cleanup } = await writeRereviewRunDir(null, {
      findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
    });
    try {
      const { spawnFn, calls } = makeFakeGh([
        ...emptyCommentScript(RUN_HEAD),
        { match: ["pulls/42/reviews"], response: { stdout: "" } },
      ]);
      const exitCode = await runPostCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const body = summaryPatch(calls);
      expect(body).toContain("1 new · 0 persist");
      expect(body).not.toContain("<!-- pr-hero-state ");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The vanished prior summary on the path that has ALREADY PAID: `--pr --post`.
//
// Every guard test in the F008 suite above drives `runPostCommand`, and that
// is exactly how the vanished-summary guard stayed structurally dead on the
// primary path for a whole slice: it hung off `requireRereviewOnPriorSummary`,
// a flag only `post --from` sets. These drive `postInlineIfEligible` — what
// reviewPr's step 14 actually calls — because a defect on one path is
// invisible to every test of the other.
//
// The window is real: the PR's comments are read in phase B, the pipeline then
// runs 8-25 minutes, and the summary this re-review was computed against can
// be deleted inside it. The two callers meet that state having paid very
// different prices, so the answers differ on purpose: `post --from` refuses
// (free to re-run), `--pr --post` publishes the findings with the re-review
// framing dropped and says so in the log.
// ---------------------------------------------------------------------------

describe("postInlineIfEligible — a vanished prior summary degrades, never refuses", () => {
  const PRIOR_CLAIM = "the prior finding, still live and still unfixed";

  function liveRereview(
    over: Partial<RereviewProvenance> = {},
  ): RereviewProvenance {
    return {
      case: "C",
      last_reviewed_head: OLD_HEAD,
      last_head_source: "summary_marker",
      discovery_range: `${OLD_HEAD}..${HEAD}`,
      discovery_restricted: true,
      discovery_skipped_empty_delta: false,
      prior_findings: 1,
      settled_deterministically: 0,
      verified: 0,
      verification_capped: 0,
      verification_triggers: {
        applied: 0,
        touched: 0,
        overlap: 0,
        verify_all: 0,
      },
      // Non-empty on purpose: an empty `live[]` renders no `Still live:`
      // section even when the framing survives, so the absence assertion
      // below would pass against the defect and prove nothing.
      live: [
        {
          id: "R001",
          sev: "CRITICAL",
          tier: "blocking",
          channel: "inline",
          status: "carried",
          locs: ["src/a.ts:10"],
          c: claimFingerprint(PRIOR_CLAIM),
          claim: PRIOR_CLAIM,
        },
      ],
      resolved_verified: 0,
      resolved_ids: [],
      returned: 0,
      re_tiered: 0,
      ...over,
    };
  }

  function prPostInput(spawnFn: typeof Bun.spawn) {
    return {
      sessionFailed: false,
      skippedReason: "unreachable",
      operatorRoot: OPERATOR_ROOT,
      pr: 42,
      headSha: HEAD,
      doc: doc({
        findings: [finding({ id: "F001", path: "src/a.ts", line: 10 })],
      }),
      diffPatch: diffAddingLines("src/a.ts", 20),
      webUrl: undefined,
      spawnFn,
      rereview: liveRereview(),
      rereviewPriors: [],
    };
  }

  // Same stderr capture the F005 collapse suite uses: `log` writes there, and
  // the disclosure is half of what this fix is — a silent downgrade would be
  // the same class of defect as the dead guard it replaces.
  async function capturingLog<T>(
    fn: () => Promise<T>,
  ): Promise<{ result: T; logged: string }> {
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      return { result: await fn(), logged: chunks.join("") };
    } finally {
      process.stderr.write = origWrite;
    }
  }

  function lastSummaryBody(calls: RecordedCall[]): string {
    const bodies = summaryStdins(calls);
    return bodies[bodies.length - 1] ?? "";
  }

  test("the summary vanished mid-run: the findings post, the framing does not", async () => {
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript(HEAD));
    const { result: outcome, logged } = await capturingLog(() =>
      postInlineIfEligible(prPostInput(spawnFn)),
    );

    // The whole point of the asymmetry: a review that cost $2.49-$6.34 is
    // published, not thrown away over a framing that went stale.
    expect(outcome).not.toBeNull();
    expect(outcome?.reviewFindingCount).toBe(1);
    expect(outcome?.droppedFindingIds).toEqual([]);

    const body = lastSummaryBody(calls);
    // All three re-review surfaces, gone. NOT asserted via "Δ since": with
    // no summary on the PR `previousHeadSha` is undefined either way, so the
    // delta line reads a bare "Δ:" even on the defect — an assertion that
    // would pass against the bug and prove nothing.
    expect(body).not.toContain("Still live:");
    expect(body).not.toContain("<!-- pr-hero-state ");
    expect(body).not.toContain("unconfirmed");
    expect(body).not.toContain("carried");
    expect(body).not.toContain("R001");
    // And what it renders instead is exactly the first-review shape, which is
    // what this run now IS: the review it was a re-review OF is not there.
    expect(body).toContain("Δ: 0 resolved · 1 new · 0 persist");
    // post.json must describe the comment that was published, not the one the
    // stale block said it would be.
    expect(outcome?.delta).toEqual({ resolved: 0, new: 1, persist: 0 });

    // Loud. An operator who expected a delta must be able to read WHY off the
    // log rather than suspect the re-review silently broke.
    expect(logged).toContain(
      "the pr-hero summary comment this re-review was computed against is gone",
    );
    expect(logged).toContain("drops the re-review framing");
    expect(logged).toContain("review --pr 42 --post");
  });

  test("`post --from` meets the same state and still refuses — the asymmetry is deliberate", async () => {
    // The regression guard on the split. `runPostCommand`'s own coverage sits
    // in the F008 suite above (live and --dry-run); this pins it at the seam,
    // one flag away from the degrade path, so the two answers stay visibly
    // different rather than drifting into one.
    const { spawnFn, calls } = makeFakeGh(emptyCommentScript(HEAD));
    const { sessionFailed, skippedReason, ...postInput } = prPostInput(spawnFn);
    expect(sessionFailed).toBe(false);
    expect(skippedReason).toBe("unreachable");
    await expect(
      postInlineFindings({
        ...postInput,
        refuseOnVanishedPriorSummary: true,
      }),
    ).rejects.toThrow(/no longer carries a pr-hero summary comment/);
    // Refused before any write, exactly as `post --from` always has.
    expect(calls.filter((c) => c.argv.includes("--method"))).toHaveLength(0);
  });

  test("the summary is still there: delta, live list and state block untouched", async () => {
    // The control. The degrade must fire on a VANISHED summary and nothing
    // else — a fix that drops the framing whenever a `rereview` block is
    // present would pass the first test and destroy the feature.
    const { spawnFn, calls } = makeFakeGh([
      headRefOidScript(HEAD),
      {
        match: ["issues/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 200,
              user: "pr-hero",
              body: `<!-- pr-hero-report head=${OLD_HEAD} -->\n## pr-hero review`,
              updated_at: "2026-08-20T00:00:00Z",
            },
          ]),
        },
      },
      { match: ["pulls/42/comments", "--paginate"], response: { stdout: "" } },
    ]);
    const { result: outcome, logged } = await capturingLog(() =>
      postInlineIfEligible(prPostInput(spawnFn)),
    );
    expect(outcome).not.toBeNull();
    const body = lastSummaryBody(calls);
    expect(body).toContain(`Δ since \`${OLD_HEAD.slice(0, 8)}\``);
    expect(body).toContain("0 unconfirmed · 1 carried · 0 deferred · 1 new");
    expect(body).toContain("Still live:");
    expect(body).toContain(PRIOR_CLAIM);
    expect(body).toContain(`<!-- pr-hero-state v=1 head=${HEAD} -->`);
    expect(logged).not.toContain("drops the re-review framing");
  });
});

// runTriageCommand — ROADMAP B6c. BINDING rules are proven once in
// test/triage-write.test.ts; this only proves the WIRING (same real-dir +
// fake-gh split as runPostCommand's suite).

function storedComparison(
  overrides: Partial<StoredComparison> = {},
): StoredComparison {
  return {
    pr: 42,
    head_sha: RUN_HEAD,
    diff_from_sha: OLD_HEAD,
    run_dir: "/x/runs/pr-42",
    run_status: "complete",
    greptile: { found: false },
    rows: [
      {
        bucket: "prhero_only",
        greptile: null,
        prhero: {
          id: "F001",
          path: "src/a.ts",
          line: 10,
          claim: "the latch never resets",
          tier: "blocking",
        },
        verdict: null,
        reasoning: null,
        actor: null,
      },
    ],
    ...overrides,
  };
}

async function writeComparisonRunDir(
  comparison: StoredComparison,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-triage-test-"));
  await Bun.write(
    path.join(dir, "comparison.json"),
    `${JSON.stringify(comparison, null, 2)}\n`,
  );
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// One finding comment (mirrors postInlineFindings's marker + prose) plus
// one `applied` reply to it — the single scripted thread every wiring test
// below needs; `[]` (no gh script) is enough for the reject-before-any-call
// tests.
function appliedReplyScript(): ScriptEntry[] {
  return [
    {
      match: ["pulls/42/comments", "--paginate"],
      response: {
        stdout: ndjson([
          {
            id: 1,
            user: "octocat",
            body: `${findingMarker({ path: "src/a.ts", line: 10, headSha: RUN_HEAD, claim: "the latch never resets" })}\nthe latch never resets`,
            path: "src/a.ts",
            line: 10,
            original_line: 10,
            in_reply_to_id: null,
          },
          {
            id: 2,
            user: "coding-agent",
            body: `${triageMarker({ tag: "applied", headSha: RUN_HEAD, actor: "agent" })}\nfixed by resetting the latch on unmount`,
            path: "src/a.ts",
            line: 10,
            original_line: 10,
            in_reply_to_id: 1,
          },
        ]),
      },
    },
  ];
}

describe("runTriageCommand", () => {
  test("dry-run binds and reports the plan, writes nothing", async () => {
    const { dir, cleanup } = await writeComparisonRunDir(storedComparison());
    try {
      const { spawnFn, calls } = makeFakeGh(appliedReplyScript());
      const exitCode = await runTriageCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: true,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      // The read DID happen (this is a real preview) — but nothing mutates.
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call.argv).not.toContain("--method");
      const onDisk = JSON.parse(
        await Bun.file(path.join(dir, "comparison.json")).text(),
      ) as StoredComparison;
      expect(onDisk.rows[0]?.verdict).toBeNull();
      expect(onDisk.rows[0]?.actor).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("a live run writes verdict/reasoning/actor back to comparison.json, everything else untouched", async () => {
    const { dir, cleanup } = await writeComparisonRunDir(storedComparison());
    try {
      const { spawnFn } = makeFakeGh(appliedReplyScript());
      const exitCode = await runTriageCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const onDisk = JSON.parse(
        await Bun.file(path.join(dir, "comparison.json")).text(),
      ) as StoredComparison;
      expect(onDisk.rows[0]?.verdict).toBe("applied");
      expect(onDisk.rows[0]?.actor).toBe("agent");
      expect(onDisk.rows[0]?.reasoning).toBe(
        "fixed by resetting the latch on unmount",
      );
      // A write-back, not a fresh comparison.json — the rest survives.
      expect(onDisk.pr).toBe(42);
      expect(onDisk.head_sha).toBe(RUN_HEAD);
    } finally {
      await cleanup();
    }
  });

  // Two ways a run-dir can be wrong before any gh call is made: no
  // comparison.json at all, or one written for a different PR (the same
  // "don't act on the wrong PR" guard runPostCommand's assertRunMatchesPr
  // gives findings.json).
  test.each([
    [
      "missing comparison.json",
      async () => mkdtemp(path.join(tmpdir(), "pr-hero-triage-test-")),
    ],
    [
      "comparison.json for a different PR",
      async () =>
        (await writeComparisonRunDir(storedComparison({ pr: 17 }))).dir,
    ],
  ])("%s is rejected before any gh call", async (_label, makeDir) => {
    const dir = await makeDir();
    try {
      const { spawnFn, calls } = makeFakeGh([]);
      await expect(
        runTriageCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(CliUsageError);
      expect(calls.length).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const F001_CLAIM = "the latch never resets";
const F001_PATH = "docs/runbook.md";

async function writeReplyRunDir(input?: {
  findingLine?: number;
  postLine?: number;
  path?: string;
}): Promise<{
  dir: string;
  bodyFile: string;
  cleanup: () => Promise<void>;
}> {
  const findingPath = input?.path ?? F001_PATH;
  const findingsLine = input?.findingLine ?? 144;
  const postLine = input?.postLine ?? findingsLine;
  // When post remaps off-hunk → in-diff, the hunk must cover the post line
  // only — not the hunter cite — or resolvePostLine never moves.
  const hunkStart = postLine !== findingsLine ? postLine : findingsLine;
  const hunkLength = 10;
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-reply-test-"));
  const runDoc = doc({
    head_sha: RUN_HEAD,
    findings: [
      finding({
        id: "F001",
        path: findingPath,
        line: findingsLine,
        claim: F001_CLAIM,
        ...(postLine !== findingsLine
          ? { proof_refs: [`${findingPath}:${postLine}`] }
          : {}),
      }),
    ],
  });
  await Bun.write(
    path.join(dir, "findings.json"),
    JSON.stringify(runDoc, null, 2),
  );
  const diffBody = Array.from(
    { length: hunkLength },
    (_, i) => `+line ${hunkStart + i}`,
  ).join("\n");
  const diffPatch =
    `diff --git a/${findingPath} b/${findingPath}\n` +
    `index 0000000..1111111 100644\n` +
    `--- a/${findingPath}\n` +
    `+++ b/${findingPath}\n` +
    `@@ -0,0 +${hunkStart},${hunkLength} @@\n` +
    `${diffBody}\n`;
  await Bun.write(path.join(dir, "diff.patch"), diffPatch);
  const bodyFile = path.join(dir, "reason.md");
  await Bun.write(bodyFile, "Fixed by resetting the latch on unmount.");
  return {
    dir,
    bodyFile,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function greptileCollisionScript(input?: {
  postLine?: number;
  path?: string;
}): ScriptEntry[] {
  const postLine = input?.postLine ?? 144;
  const findingPath = input?.path ?? F001_PATH;
  return [
    {
      match: ["issues/42/comments", "--paginate"],
      response: { stdout: "" },
    },
    {
      match: ["pulls/42/comments", "--paginate"],
      response: {
        stdout: ndjson([
          {
            id: 11,
            user: "greptile-apps",
            body: "same line, not ours",
            path: findingPath,
            line: postLine,
            original_line: postLine,
            in_reply_to_id: null,
          },
          {
            id: 22,
            user: "pr-hero",
            body: `${findingMarker({
              path: findingPath,
              line: postLine,
              headSha: RUN_HEAD,
              claim: F001_CLAIM,
            })}\n${F001_CLAIM}`,
            path: findingPath,
            line: postLine,
            original_line: postLine,
            in_reply_to_id: null,
          },
        ]),
      },
    },
    {
      match: ["repo", "view", "--json", "owner,name"],
      response: {
        stdout: JSON.stringify({
          name: "musive",
          owner: { login: "MusiveTech" },
        }),
      },
    },
    {
      match: ["graphql", "reviewThreads"],
      response: {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "PRRT_f001",
                      isResolved: false,
                      comments: { nodes: [{ fullDatabaseId: 22 }] },
                    },
                  ],
                },
              },
            },
          },
        }),
      },
    },
    {
      match: ["graphql", "resolveReviewThread"],
      response: {
        stdout: JSON.stringify({
          data: { resolveReviewThread: { thread: { isResolved: true } } },
        }),
      },
    },
  ];
}

describe("runTriageReplyCommand", () => {
  test("dry-run fetches but does not POST or resolve", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    try {
      const { spawnFn, calls } = makeFakeGh(greptileCollisionScript());
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        findingId: "F001",
        tag: "applied",
        bodyFile,
        dryRun: true,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.argv).not.toContain("--method");
        expect(call.argv.join(" ")).not.toContain("resolveReviewThread");
      }
    } finally {
      await cleanup();
    }
  });

  test("#20: replies to the pr-hero marker, not Greptile at the same line", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    try {
      const { spawnFn, calls } = makeFakeGh(greptileCollisionScript());
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        findingId: "F001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const post = calls.find(
        (call) =>
          call.argv.includes("--method") &&
          call.argv.join(" ").includes("pulls/42/comments"),
      );
      expect(post).toBeDefined();
      expect(post?.argv.join(" ")).toContain("in_reply_to=22");
      expect(post?.argv.join(" ")).not.toContain("in_reply_to=11");
      expect(post?.stdin).toContain("<!-- pr-hero-triage tag=applied");
      expect(post?.stdin).toContain("✅ **APPLIED**");
      expect(post?.stdin).toContain("Fixed by resetting the latch on unmount.");
      expect(
        calls.some((call) =>
          call.argv.join(" ").includes("resolveReviewThread"),
        ),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("binds when post remapped the line (findings.json:19 → posted marker:27)", async () => {
    const findingPath = "src/a.ts";
    const { dir, bodyFile, cleanup } = await writeReplyRunDir({
      path: findingPath,
      findingLine: 19,
      postLine: 27,
    });
    try {
      const { spawnFn, calls } = makeFakeGh(
        greptileCollisionScript({ path: findingPath, postLine: 27 }),
      );
      const exitCode = await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        findingId: "F001",
        tag: "applied",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(exitCode).toBe(0);
      const post = calls.find(
        (call) =>
          call.argv.includes("--method") &&
          call.argv.join(" ").includes("pulls/42/comments"),
      );
      expect(post?.argv.join(" ")).toContain("in_reply_to=22");
    } finally {
      await cleanup();
    }
  });

  test("refuses when diff.patch is missing", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    await rm(path.join(dir, "diff.patch"));
    try {
      const { spawnFn, calls } = makeFakeGh([]);
      await expect(
        runTriageReplyCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          findingId: "F001",
          tag: "applied",
          bodyFile,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(/missing diff\.patch/);
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("refuses a --body-file that already starts with the triage marker", async () => {
    const { dir, cleanup } = await writeReplyRunDir();
    const bodyFile = path.join(dir, "bad.md");
    await Bun.write(
      bodyFile,
      `${triageMarker({ tag: "applied", headSha: RUN_HEAD, actor: "agent" })}\nnope`,
    );
    try {
      const { spawnFn, calls } = makeFakeGh([]);
      await expect(
        runTriageReplyCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          findingId: "F001",
          tag: "applied",
          bodyFile,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(/reasoning prose only/);
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("live #34: resolve failure after a successful post says re-run, not gh", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    try {
      const script = greptileCollisionScript().map((entry) =>
        entry.match.includes("reviewThreads")
          ? {
              ...entry,
              response: {
                stdout: "",
                stderr: 'Expected NAME, actual: (none) ("") at [1, 202]',
                exitCode: 1,
              },
            }
          : entry,
      );
      const { spawnFn, calls } = makeFakeGh(script);
      await expect(
        runTriageReplyCommand({
          operatorRoot: OPERATOR_ROOT,
          pr: 42,
          from: dir,
          findingId: "F001",
          tag: "applied",
          bodyFile,
          dryRun: false,
          spawnFn,
        }),
      ).rejects.toThrow(/resolve failed after the reply was on GitHub/);
      expect(
        calls.some(
          (call) =>
            call.argv.includes("--method") &&
            call.argv.join(" ").includes("pulls/42/comments"),
        ),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("skips resolve when the adjudicator is inconclusive", async () => {
    const { dir, bodyFile, cleanup } = await writeReplyRunDir();
    try {
      const { spawnFn, calls } = makeFakeGh(greptileCollisionScript());
      await runTriageReplyCommand({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        from: dir,
        findingId: "F001",
        tag: "dismissed",
        verdict: "inconclusive",
        bodyFile,
        dryRun: false,
        spawnFn,
      });
      expect(
        calls.some((call) =>
          call.argv.join(" ").includes("resolveReviewThread"),
        ),
      ).toBe(false);
      const post = calls.find((call) => call.argv.includes("--method"));
      expect(post?.stdin).toContain("verdict=inconclusive");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// W4 Phase 6 remediation (sdd-verify option D): four offline tests closing
// the PARTIAL scenarios the verify report flagged, plus the --out product
// fix. `runGit`/`tmpGitRepo` spawn a REAL git binary against a throwaway tmp
// dir — the only way to exercise gitOriginUrl/resolveRepoHome's actual
// decision (present vs. absent origin) without faking git itself.

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

describe("ingestReviewMetrics — the review()/reviewPr() caller seam (W4 Phase 6)", () => {
  test("a throwing ingest seam never throws and warns with the exact prefix", () => {
    const warnings: string[] = [];
    expect(() =>
      ingestReviewMetrics({
        dbPath: "/tmp/does-not-matter.db",
        repoId: "github.com/acme/widgets",
        runDir: "/runs/local-1",
        checkoutPath: OPERATOR_ROOT,
        doc: doc({ pr: 0 }),
        perAgent: {},
        comparison: null,
        log: (line) => warnings.push(line),
        ingest: () => {
          throw new Error("disk full");
        },
      }),
    ).not.toThrow();
    expect(warnings).toEqual([
      "warning: metrics ingest failed — the review itself is intact: disk full",
    ]);
  });

  test("a successful ingest logs nothing and reaches the seam with the given runDir", () => {
    const warnings: string[] = [];
    const seenRunDirs: string[] = [];
    ingestReviewMetrics({
      dbPath: "/tmp/does-not-matter.db",
      repoId: "github.com/acme/widgets",
      runDir: "/runs/pr-42-1",
      checkoutPath: OPERATOR_ROOT,
      doc: doc({ pr: 42 }),
      perAgent: {},
      comparison: null,
      log: (line) => warnings.push(line),
      ingest: (input) => {
        seenRunDirs.push(input.runDir);
      },
    });
    expect(warnings).toEqual([]);
    expect(seenRunDirs).toEqual(["/runs/pr-42-1"]);
  });
});

describe("originUsageScope — usage's scoped-mode resolver (W4 Phase 6)", () => {
  test("a checkout with no resolvable origin throws the exact missingOriginMessage", async () => {
    const repo = await tmpGitRepo(null);
    const home = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-home-"));
    try {
      let caught: unknown;
      try {
        await originUsageScope(home, repo.dir);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CliError);
      expect((caught as Error).message).toBe(missingOriginMessage(repo.dir));
    } finally {
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a checkout with a resolvable origin resolves repoId from canonicalRemoteId", async () => {
    const originUrl = "https://github.com/acme/widgets.git";
    const repo = await tmpGitRepo(originUrl);
    const home = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-home-"));
    try {
      const scope = await originUsageScope(home, repo.dir);
      expect(scope).toEqual({ repoId: canonicalRemoteId(originUrl) });
    } finally {
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
    }
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
// C4 O-0 — the engine identity has to be able to change
// ---------------------------------------------------------------------------

describe("deriveEngineIdentity", () => {
  test("carries the revision so two engines are distinguishable", () => {
    // The reason this obligation exists: `version` is read from package.json,
    // which has said 0.1.0 since the scaffold commit. Every run this engine
    // ever wrote reports the same engine, so an artifact could not tell a
    // pre-C4 review from a post-C4 one — and the Martian baseline is ratified
    // as valid across engine versions only on condition the frontier is
    // annotated. A field that never changes annotates nothing.
    expect(
      deriveEngineIdentity(
        { name: "pr-hero", version: "0.1.0" },
        { ok: true, stdout: "961acef\n" },
      ),
    ).toEqual({ name: "pr-hero", version: "0.1.0", revision: "961acef" });
  });

  test("omits revision rather than inventing one when git cannot answer", () => {
    // A tarball install or a checkout without git still has to run a review.
    // Refusing to start over a provenance string would trade a paid review for
    // a field, and "unknown" would be a value that sorts and compares like a
    // real commit.
    expect(
      deriveEngineIdentity(
        { name: "pr-hero", version: "0.1.0" },
        { ok: false, stdout: "" },
      ),
    ).toEqual({ name: "pr-hero", version: "0.1.0" });
  });

  test("treats an empty stdout on a zero exit as no revision", () => {
    // git can exit 0 and say nothing. An empty `revision: ""` in an artifact
    // reads as a commit whose name is the empty string.
    expect(
      deriveEngineIdentity(
        { name: "pr-hero", version: "0.1.0" },
        {
          ok: true,
          stdout: "  \n",
        },
      ).revision,
    ).toBeUndefined();
  });

  test("falls back on a package.json missing its own fields", () => {
    expect(deriveEngineIdentity({}, { ok: false, stdout: "" })).toEqual({
      name: "pr-hero",
      version: "0.0.0",
    });
  });
});

// ---------------------------------------------------------------------------
// F005 — the verified-gone collapse loop's two gh calls are bounded.
//
// Every LLM step in the pipeline is bounded by `stepTimeoutMs`; these two were
// the only awaits on the `--post` path with no bound at all, so an
// accepted-but-unanswered GitHub request hung `review --pr --post` forever —
// including an unattended `--yes` run from the watcher, where nothing is
// present to notice it. The bound has to degrade to "thread left open": a
// resolve on a thread whose ✅ reply never landed is a silent close, the same
// false `resolved` item 7 exists to never produce.
// ---------------------------------------------------------------------------

describe("postInlineFindings — the collapse loop cannot hang (F005)", () => {
  const PRIOR_CLAIM = "the prior finding, checked and gone at this head";
  const PRIOR_MARKER = findingMarker({
    path: "src/a.ts",
    line: 10,
    headSha: OLD_HEAD,
    claim: PRIOR_CLAIM,
  });

  function rereview(): RereviewProvenance {
    return {
      case: "C",
      last_reviewed_head: OLD_HEAD,
      last_head_source: "summary_marker",
      discovery_range: `${OLD_HEAD}..${HEAD}`,
      discovery_restricted: true,
      discovery_skipped_empty_delta: false,
      prior_findings: 1,
      settled_deterministically: 0,
      verified: 1,
      verification_capped: 0,
      verification_triggers: {
        applied: 0,
        touched: 1,
        overlap: 0,
        verify_all: 0,
      },
      live: [],
      resolved_verified: 1,
      resolved_ids: ["R001"],
      returned: 0,
      re_tiered: 0,
    };
  }

  function priorCommentScript(hangOn: string): ScriptEntry[] {
    return [
      headRefOidScript(HEAD),
      { match: ["issues/42/comments", "--paginate"], response: { stdout: "" } },
      {
        match: ["pulls/42/comments", "--paginate"],
        response: {
          stdout: ndjson([
            {
              id: 501,
              user: "pr-hero",
              body: `${PRIOR_MARKER}\n${PRIOR_CLAIM}`,
              path: "src/a.ts",
              line: 10,
              original_line: 10,
              in_reply_to_id: null,
            },
          ]),
        },
      },
      // Ahead of the successful entries so a `hangOn` naming any of them
      // wins the `script.find` — including `owner,name`, the repo lookup
      // resolveReviewThreadForComment makes BEFORE either graphql call. A
      // bound on two of three gh calls still hangs on the third.
      { match: [hangOn], response: { hang: true } },
      {
        match: ["repo", "view", "--json", "owner,name"],
        response: {
          stdout: JSON.stringify({
            owner: { login: "juanmaagd" },
            name: "pr-hero",
          }),
        },
      },
      { match: ["pulls/42/reviews"], response: { stdout: "" } },
    ];
  }

  async function collapseWith(hangOn: string): Promise<{
    logged: string;
    calls: RecordedCall[];
  }> {
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      const { spawnFn, calls } = makeFakeGh(priorCommentScript(hangOn));
      await postInlineFindings({
        operatorRoot: OPERATOR_ROOT,
        pr: 42,
        headSha: HEAD,
        doc: doc({ findings: [] }),
        diffPatch: diffAddingLines("src/a.ts", 20),
        webUrl: undefined,
        spawnFn,
        rereview: rereview(),
        rereviewPriors: [
          { id: "R001", claim: PRIOR_CLAIM, locs: ["src/a.ts:10"] },
        ],
        ghTimeoutMs: 30,
      });
      return { logged: chunks.join(""), calls };
    } finally {
      process.stderr.write = origWrite;
    }
  }

  test("a hung reply post leaves the thread open and never resolves it", async () => {
    // Without the bound this test does not fail — it never returns.
    const { logged, calls } = await collapseWith("in_reply_to=501");
    expect(logged).toContain("collapse skipped for R001");
    expect(logged).toContain("thread left open");
    expect(logged).toContain("timed out after 30 ms");
    // The resolve must NOT run: closing a thread whose ✅ reply never posted
    // is the false `resolved` the whole verified-gone path forbids.
    expect(
      calls.filter((c) => c.argv.join(" ").includes("reviewThreads")),
    ).toHaveLength(0);
    expect(logged).not.toContain("resolved: review thread for R001");
  });

  test("a hung thread-resolve is reported, not awaited forever", async () => {
    const { logged, calls } = await collapseWith("reviewThreads");
    expect(
      calls.filter((c) => c.argv.join(" ").includes("in_reply_to=501")),
    ).toHaveLength(1);
    expect(logged).toContain("resolve failed for R001");
    expect(logged).toContain("timed out after 30 ms");
    expect(logged).not.toContain("resolved: review thread for R001");
  });

  test("the resolve's inner repo lookup is bounded too", async () => {
    // `resolveReviewThreadForComment` makes THREE gh calls; `ghRepoOwnerName`
    // is the first and used to be the one nobody thought to bound.
    const { logged } = await collapseWith("owner,name");
    expect(logged).toContain("resolve failed for R001");
    expect(logged).toContain("timed out after 30 ms");
    expect(logged).not.toContain("resolved: review thread for R001");
  });
});
