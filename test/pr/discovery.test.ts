import { describe, expect, test } from "bun:test";
import { discoveryHunters, resolvePrDiscovery } from "#pr/discovery";
import type { AgentSpec } from "#review/spec";

const HUNTER_A: AgentSpec = {
  key: "hunter-a",
  role: "hunter",
  file: "hunter-a.md",
};
const HUNTER_B: AgentSpec = {
  key: "hunter-b",
  role: "hunter",
  file: "hunter-b.md",
  trigger: ["some/path/**"],
};

// Invariant 1 (rereview-coverage fix): the gate is `skipDiscovery` ALONE —
// never a hardcoded case check that would silently reintroduce the exact
// defect the fix closes (a case-B re-review that skips discovery even when
// it has something to discover).
describe("discoveryHunters", () => {
  test("skipDiscovery true returns no hunters regardless of triggers", () => {
    expect(
      discoveryHunters({
        skipDiscovery: true,
        agents: [HUNTER_A, HUNTER_B],
        parityFires: true,
      }),
    ).toEqual([]);
  });

  test("skipDiscovery false selects hunters exactly like selectActiveHunters", () => {
    const result = discoveryHunters({
      skipDiscovery: false,
      agents: [HUNTER_A, HUNTER_B],
      parityFires: false,
    });
    expect(result.map((a) => a.key)).toEqual(["hunter-a"]);
  });
});

const L = "1111111111111111111111111111111111111111";
const H = "2222222222222222222222222222222222222222";
const B = "3333333333333333333333333333333333333333";
const PATCH =
  "diff --git a/src/a.ts b/src/a.ts\n" +
  "index 1111111..2222222 100644\n" +
  "--- a/src/a.ts\n" +
  "+++ b/src/a.ts\n" +
  "@@ -1 +1 @@\n" +
  "-old\n" +
  "+new\n";

function fakeRunGit(args: string[]) {
  if (args[0] === "diff" && args.includes("--numstat")) {
    return Promise.resolve({
      ok: true,
      stdout: "1\t1\tsrc/a.ts\n",
      stderr: "",
    });
  }
  return Promise.resolve({ ok: true, stdout: PATCH, stderr: "" });
}

function baseGit() {
  return {
    commitExists: () => Promise.resolve(true),
    isAncestor: () => Promise.resolve(true),
    nameOnly: () => Promise.resolve([] as string[]),
    nameStatus: () => Promise.resolve(""),
    runGit: fakeRunGit,
  };
}

function markerComment(complete: boolean) {
  const coverage = complete ? "" : " coverage=partial";
  return {
    id: 1,
    user: "pr-hero",
    body: `<!-- pr-hero-report head=${L}${coverage} -->\n\nprevious review body`,
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const POSTED_FINDING = {
  id: 100,
  channel: "review" as const,
  marker: { path: "src/a.ts", line: 10, headSha: L, c: "abc" },
  created_at: "2026-01-01T00:00:00Z",
};

// Invariants 2 & 3 together (rereview-coverage fix): a PARTIAL prior review
// must force `plan.verifyAll: true` (invariant 2 — the marker's own
// completeness, not a hardcoded default), and that `verifyAll` must actually
// reach `buildPhaseBQueue` so an untouched, untriaged prior gets QUEUED for
// re-verification rather than silently carried forward unexamined
// (invariant 3 — the wiring gap the fix closes). Both are proven through the
// real outcome — which queue the prior lands in — not by inspecting an
// intermediate field.
describe("resolvePrDiscovery — rereview-coverage fix (invariants 2 & 3)", () => {
  test("a partial last review forces verifyAll and queues an untouched prior for re-verification", async () => {
    const result = await resolvePrDiscovery({
      diffFromSha: B,
      headSha: H,
      full: false,
      baseRef: B,
      headLabel: "PR #1 head",
      isCi: false,
      sizeGateOverrides: {},
      config: { parity_trigger_paths: [], suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [markerComment(false)],
      postedFindings: [POSTED_FINDING],
      reviewComments: [],
      git: baseGit(),
      log: () => {},
    });
    expect(result.prepared.plan.verifyAll).toBe(true);
    expect(result.verifyQueue.map((v) => v.priorId)).toEqual(["R001"]);
    expect(result.overlapCandidates).toEqual([]);
  });

  test("a complete last review does not force verifyAll, and the same untouched prior is carried instead", async () => {
    const result = await resolvePrDiscovery({
      diffFromSha: B,
      headSha: H,
      full: false,
      baseRef: B,
      headLabel: "PR #1 head",
      isCi: false,
      sizeGateOverrides: {},
      config: { parity_trigger_paths: [], suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [markerComment(true)],
      postedFindings: [POSTED_FINDING],
      reviewComments: [],
      git: baseGit(),
      log: () => {},
    });
    expect(result.prepared.plan.verifyAll).toBe(false);
    expect(result.verifyQueue).toEqual([]);
    expect(result.overlapCandidates.map((v) => v.priorId)).toEqual(["R001"]);
  });
});

// #206 follow-up (pr-hero on #285): review comments and issue comments are
// different GitHub resources, and nothing documents that their numeric ids
// share a namespace. A posted inline finding must recover ITS OWN body even
// when an issue comment carries the same id — otherwise the prior silently
// inherits another comment's severity, which is worse than UNRECOVERABLE.
describe("resolvePrDiscovery — #206 body recovery keys by comment kind", () => {
  test("an issue comment sharing an inline finding's id never supplies its severity", async () => {
    const inlineBody =
      `<!-- pr-hero-finding path=src%2Fa.ts line=10 head=${L} c=abc -->\n` +
      "\n" +
      "🔴 blocking · BLOCKER · introduced · reliability\n" +
      "`src/a.ts:10`\n" +
      "\n" +
      "the retry loop never clears the prior timer\n";
    const collidingIssueBody =
      "🟡 advisory · WARNING · introduced · logic\n" +
      "`src/other.ts:1`\n" +
      "\n" +
      "an unrelated issue comment that happens to share the id\n";
    const result = await resolvePrDiscovery({
      diffFromSha: B,
      headSha: H,
      full: false,
      baseRef: B,
      headLabel: "PR #1 head",
      isCi: false,
      sizeGateOverrides: {},
      config: { parity_trigger_paths: [], suspicion_priors: [] },
      prIgnore: { rules: [], found: false },
      issueComments: [
        markerComment(false),
        {
          id: POSTED_FINDING.id,
          user: "someone",
          body: collidingIssueBody,
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      postedFindings: [POSTED_FINDING],
      reviewComments: [
        {
          id: POSTED_FINDING.id,
          user: "pr-hero",
          body: inlineBody,
          path: "src/a.ts",
          line: 10,
          original_line: 10,
          in_reply_to_id: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      git: baseGit(),
      log: () => {},
    });
    expect(result.verifyQueue.map((v) => v.sev)).toEqual(["BLOCKER"]);
    expect(result.verifyQueue[0]?.claim).toContain(
      "the retry loop never clears the prior timer",
    );
  });
});
