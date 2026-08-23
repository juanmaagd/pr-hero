import { describe, expect, test } from "bun:test";
import { claimFingerprint } from "../src/pr-preflight";
import { planDiscovery } from "../src/rereview-plan";
import {
  buildPhaseBQueue,
  collapseTargets,
  enrichPriorsFromThreads,
  parseNameOnly,
  parseNameStatus,
  prepareDiscovery,
  type RereviewGit,
  shouldAbortEmptyDiscovery,
  toRereviewProvenance,
} from "../src/rereview-prepare";
import { triageMarker } from "../src/triage";

const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const L = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const H = "cccccccccccccccccccccccccccccccccccccccc";
const MISSING = "dddddddddddddddddddddddddddddddddddddddd";

function git(over: Partial<RereviewGit> = {}): RereviewGit {
  return {
    commitExists: async () => true,
    isAncestor: async () => true,
    nameOnly: async () => [],
    ...over,
  };
}

describe("parseNameOnly", () => {
  test("sorts, trims, and drops blanks and duplicates", () => {
    expect(parseNameOnly("src/b.ts\n\nsrc/a.ts\nsrc/b.ts\n")).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });
});

describe("shouldAbortEmptyDiscovery — S-empty", () => {
  test("a first review with an empty diff still errors", () => {
    expect(
      shouldAbortEmptyDiscovery(planDiscovery({ case: "A", full: false }), ""),
    ).toBe(true);
  });

  test("a re-review empty delta is not an error", () => {
    expect(
      shouldAbortEmptyDiscovery(planDiscovery({ case: "C", full: false }), ""),
    ).toBe(false);
    expect(
      shouldAbortEmptyDiscovery(planDiscovery({ case: "B", full: false }), ""),
    ).toBe(false);
  });

  test("a non-empty patch never aborts", () => {
    expect(
      shouldAbortEmptyDiscovery(
        planDiscovery({ case: "A", full: false }),
        "diff --git a/x b/x\n",
      ),
    ).toBe(false);
  });
});

describe("prepareDiscovery", () => {
  test("case A — no prior, unrestricted B..H", async () => {
    const prepared = await prepareDiscovery({
      B,
      H,
      full: false,
      summaryHead: null,
      findingMarkers: [],
      git: git(),
    });
    expect(prepared.case).toBe("A");
    expect(prepared.discoveryPaths).toBeNull();
    expect(prepared.discoveryFrom).toBe(B);
    expect(prepared.plan.emptyDeltaIsError).toBe(true);
    expect(toRereviewProvenance(prepared)).toBeUndefined();
  });

  test("S-A — summary gone, L recovered from latest finding-marker created_at", async () => {
    const prepared = await prepareDiscovery({
      B,
      H,
      full: false,
      summaryHead: null,
      findingMarkers: [
        { headSha: MISSING, createdAt: "2026-08-20T00:00:00Z" },
        { headSha: L, createdAt: "2026-08-21T00:00:00Z" },
      ],
      git: git({ isAncestor: async () => true }),
    });
    expect(prepared.last).toEqual({ L, source: "finding_markers" });
    expect(prepared.case).toBe("C");
    expect(prepared.plan.emptyDeltaIsError).toBe(false);
  });

  test("S-empty — restricted intersection empty skips discovery, does not error", async () => {
    const prepared = await prepareDiscovery({
      B,
      H,
      full: false,
      summaryHead: L,
      findingMarkers: [],
      git: git({
        nameOnly: async (from) => (from === B ? ["src/a.ts"] : ["vendor/x"]),
      }),
    });
    expect(prepared.case).toBe("C");
    expect(prepared.discoveryPaths).toEqual([]);
    expect(prepared.discoverySkippedEmptyDelta).toBe(true);
    expect(prepared.plan.emptyDeltaIsError).toBe(false);
    expect(toRereviewProvenance(prepared)?.discovery_skipped_empty_delta).toBe(
      true,
    );
  });

  test("S-merge — discovery files are files(B..H) ∩ files(L..H)", async () => {
    const prepared = await prepareDiscovery({
      B,
      H,
      full: false,
      summaryHead: L,
      findingMarkers: [],
      git: git({
        nameOnly: async (from) =>
          from === B
            ? ["src/a.ts", "src/b.ts"]
            : ["src/b.ts", "vendor/upstream.ts"],
      }),
    });
    expect(prepared.case).toBe("C");
    expect(prepared.discoveryPaths).toEqual(["src/b.ts"]);
    expect(prepared.discoveryFrom).toBe(L);
    expect(prepared.discoverySkippedEmptyDelta).toBe(false);
    expect(toRereviewProvenance(prepared)?.discovery_restricted).toBe(true);
  });

  test("W-cli — --full widens C to B..H and keeps the real case", async () => {
    const prepared = await prepareDiscovery({
      B,
      H,
      full: true,
      summaryHead: L,
      findingMarkers: [],
      git: git({
        nameOnly: async () => {
          throw new Error("restricted name-only must not run under --full");
        },
      }),
    });
    expect(prepared.case).toBe("C");
    expect(prepared.plan.discovery).toBe("full");
    expect(prepared.plan.discoveryRestricted).toBe(false);
    expect(prepared.discoveryPaths).toBeNull();
    expect(prepared.discoveryFrom).toBe(B);
    expect(toRereviewProvenance(prepared)?.discovery_restricted).toBe(false);
  });

  test("case B without --full skips discovery", async () => {
    const prepared = await prepareDiscovery({
      B,
      H: L,
      full: false,
      summaryHead: L,
      findingMarkers: [],
      git: git(),
    });
    expect(prepared.case).toBe("B");
    expect(prepared.plan.skipDiscovery).toBe(true);
    expect(prepared.discoveryPaths).toEqual([]);
    expect(prepared.discoverySkippedEmptyDelta).toBe(true);
  });

  test("D4 — L exists but is not an ancestor → full B..H, verify-all", async () => {
    const prepared = await prepareDiscovery({
      B,
      H,
      full: false,
      summaryHead: L,
      findingMarkers: [],
      git: git({ isAncestor: async () => false }),
    });
    expect(prepared.case).toBe("D");
    expect(prepared.plan.discovery).toBe("full");
    expect(prepared.plan.verifyAll).toBe(true);
    expect(prepared.discoveryPaths).toBeNull();
    expect(toRereviewProvenance(prepared)?.case).toBe("D");
  });

  test("W-prov — a first review carries no rereview block", async () => {
    const prepared = await prepareDiscovery({
      B,
      H,
      full: false,
      summaryHead: null,
      findingMarkers: [],
      git: git(),
    });
    expect(toRereviewProvenance(prepared, 4)).toBeUndefined();
  });
});

describe("parseNameStatus", () => {
  test("S-revert — a deleted path is still a touched file", () => {
    const parsed = parseNameStatus("M\tsrc/a.ts\nD\tsrc/gone.ts\n");
    expect(parsed.deleted).toEqual(["src/gone.ts"]);
    expect(parsed.files).toEqual(["src/a.ts", "src/gone.ts"]);
  });

  test("renames rewrite from → to and keep both paths", () => {
    const parsed = parseNameStatus("R100\told.ts\tnew.ts\n");
    expect(parsed.renameMap.get("old.ts")).toBe("new.ts");
    expect(parsed.files).toEqual(["new.ts", "old.ts"]);
  });
});

describe("buildPhaseBQueue", () => {
  test("case C queues a touched prior and leaves an untouched one for overlap", () => {
    const { queued, overlapCandidates, settled } = buildPhaseBQueue({
      case: "C",
      priors: [
        {
          id: "R001",
          sev: "CRITICAL",
          tier: "blocking",
          channel: "inline",
          locs: ["src/a.ts:10"],
          claim: "touched",
          triage: null,
          newThreadReply: false,
        },
        {
          id: "R002",
          sev: "WARNING",
          tier: "advisory",
          channel: "inline",
          locs: ["src/b.ts:1"],
          claim: "carried",
          triage: null,
          newThreadReply: false,
        },
      ],
      nameStatus: {
        files: ["src/a.ts"],
        deleted: [],
        renameMap: new Map(),
      },
      summaryUpdatedAt: null,
    });
    expect(queued.map((e) => `${e.priorId}:${e.trigger}`)).toEqual([
      "R001:touched",
    ]);
    expect(overlapCandidates.map((e) => e.priorId)).toEqual(["R002"]);
    expect(settled.map((s) => `${s.id}:${s.status}`)).toEqual([
      "R001:queued",
      "R002:carried",
    ]);
  });

  test("D4 — case D queues every prior as verify_all", () => {
    const { queued } = buildPhaseBQueue({
      case: "D",
      priors: [
        {
          id: "R001",
          sev: "WARNING",
          tier: "advisory",
          channel: "inline",
          locs: ["src/a.ts:10"],
          claim: "still live?",
          triage: null,
          newThreadReply: false,
        },
      ],
      nameStatus: { files: [], deleted: [], renameMap: new Map() },
      summaryUpdatedAt: null,
    });
    expect(queued.map((e) => e.trigger)).toEqual(["verify_all"]);
  });
});

describe("S-B — enrichPriorsFromThreads newness", () => {
  const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const claim = "a live defect";

  test("a reply after summary.updated_at is new; a predating one is not", () => {
    const fingerprint = claimFingerprint(claim);
    const prior = {
      id: "R001",
      sev: "CRITICAL" as const,
      tier: "blocking" as const,
      channel: "inline" as const,
      locs: ["src/app.ts:10"],
      claim,
      triage: null,
      newThreadReply: false,
    };
    const posted = [{ id: 22, marker: { c: fingerprint } }];
    const applied = `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\n`;
    const after = enrichPriorsFromThreads({
      priors: [prior],
      posted,
      replies: [
        {
          in_reply_to_id: 22,
          body: applied,
          created_at: "2026-08-21T12:00:00Z",
        },
      ],
      summaryUpdatedAt: "2026-08-20T12:00:00Z",
    });
    expect(after[0]?.newThreadReply).toBe(true);
    expect(after[0]?.triage?.tag).toBe("applied");

    const before = enrichPriorsFromThreads({
      priors: [prior],
      posted,
      replies: [
        {
          in_reply_to_id: 22,
          body: applied,
          created_at: "2026-08-19T12:00:00Z",
        },
      ],
      summaryUpdatedAt: "2026-08-20T12:00:00Z",
    });
    expect(before[0]?.newThreadReply).toBe(false);

    const queuedAfter = buildPhaseBQueue({
      case: "B",
      priors: after,
      nameStatus: { files: [], deleted: [], renameMap: new Map() },
      summaryUpdatedAt: "2026-08-20T12:00:00Z",
    });
    expect(queuedAfter.queued.map((e) => e.trigger)).toEqual(["applied"]);

    const queuedBefore = buildPhaseBQueue({
      case: "B",
      priors: before,
      nameStatus: { files: [], deleted: [], renameMap: new Map() },
      summaryUpdatedAt: "2026-08-20T12:00:00Z",
    });
    expect(queuedBefore.queued).toEqual([]);
    expect(queuedBefore.settled[0]?.status).toBe("carried");
  });
});

describe("O-1c — collapseTargets ignore matcher leftovers", () => {
  const claim = "a live defect";

  test("carried priors produce no collapse even if a posted comment is unmatched", () => {
    expect(
      collapseTargets({
        verifiedGoneIds: [],
        priors: [{ id: "R001", claim }],
        posted: [
          { id: 9, channel: "review", marker: { c: claimFingerprint(claim) } },
        ],
      }),
    ).toEqual([]);
  });

  test("verified-gone maps to the posted review comment", () => {
    expect(
      collapseTargets({
        verifiedGoneIds: ["R001"],
        priors: [{ id: "R001", claim }],
        posted: [
          { id: 9, channel: "review", marker: { c: claimFingerprint(claim) } },
        ],
      }),
    ).toEqual([{ priorId: "R001", commentId: 9, channel: "review" }]);
  });
});
