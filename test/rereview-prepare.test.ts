import { describe, expect, test } from "bun:test";
import { claimFingerprint } from "../src/pr-preflight";
import type { PriorRecord } from "../src/rereview-classify";
import { planDiscovery } from "../src/rereview-plan";
import {
  buildPhaseBQueue,
  collapseTargets,
  enrichPriorsFromThreads,
  parseNameOnly,
  parseNameStatus,
  prepareDiscovery,
  priorsFromPostedMarkers,
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
    // path/line joined this fixture when the prior->comment binding stopped
    // keying on `c` alone (F001/F003). Same prior, same comment, same
    // assertions — the marker now simply carries the identity it always had.
    const posted = [
      { id: 22, marker: { path: "src/app.ts", line: 10, c: fingerprint } },
    ];
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
        priors: [{ id: "R001", claim, locs: ["src/app.ts:10"] }],
        posted: [
          {
            id: 9,
            channel: "review",
            marker: {
              path: "src/app.ts",
              line: 10,
              c: claimFingerprint(claim),
            },
          },
        ],
      }),
    ).toEqual([]);
  });

  test("verified-gone maps to the posted review comment", () => {
    expect(
      collapseTargets({
        verifiedGoneIds: ["R001"],
        priors: [{ id: "R001", claim, locs: ["src/app.ts:10"] }],
        posted: [
          {
            id: 9,
            channel: "review",
            marker: {
              path: "src/app.ts",
              line: 10,
              c: claimFingerprint(claim),
            },
          },
        ],
      }),
    ).toEqual([{ priorId: "R001", commentId: 9, channel: "review" }]);
  });
});

// ---------------------------------------------------------------------------
// F001/F002/F003 — the prior->comment binding is path:line, `c` is the
// tie-breaker it was always documented to be (`src/pr-preflight.ts:374-379`).
//
// Before this, both consumers keyed on `claimFingerprint(prior.claim)` ALONE
// and their `posted` parameter type was narrowed to `{ id, marker: { c } }`,
// so neither could reach the path and line the caller was already handing
// them. Two hats on one bug: identical claim text cross-wired two priors, and
// `priorsFromPostedMarkers`'s `claim: ""` — the path taken on the FIRST
// re-review of every PR, because a first review writes no state block — hashes
// to a constant no real marker carries, so both functions were silent no-ops
// there.
// ---------------------------------------------------------------------------

describe("F001/F003 — prior->comment binding by path:line", () => {
  const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const dismissed = `${triageMarker({
    tag: "dismissed",
    headSha: HEAD,
    actor: "human",
    verdict: "upheld",
  })}\n`;

  function prior(over: {
    id: string;
    locs: readonly string[];
    claim: string;
  }): PriorRecord {
    return {
      sev: "CRITICAL",
      tier: "blocking",
      channel: "inline",
      triage: null,
      newThreadReply: false,
      ...over,
    };
  }

  function comment(over: {
    id: number;
    path: string;
    line: number;
    claim: string;
    liveLine?: number;
  }) {
    return {
      id: over.id,
      channel: "review" as const,
      marker: {
        path: over.path,
        line: over.line,
        headSha: HEAD,
        c: claimFingerprint(over.claim),
      },
      livePath: over.path,
      liveLine: over.liveLine ?? over.line,
    };
  }

  test("two priors with identical claim text keep their own triage", () => {
    // The whole point: `c` is EQUAL across these two comments (same claim
    // text, different defects at different sites), so a fingerprint-only
    // lookup hands both priors the first comment — a `dismissed`+`upheld`
    // meant for R001 would suppress R002, a different and still-live finding.
    const claim = "the value is stored in seconds and read as milliseconds";
    const posted = [
      comment({ id: 111, path: "src/a.ts", line: 10, claim }),
      comment({ id: 222, path: "src/b.ts", line: 20, claim }),
    ];
    expect(posted[0]?.marker.c).toBe(posted[1]?.marker.c ?? "");

    const enriched = enrichPriorsFromThreads({
      priors: [
        prior({ id: "R001", locs: ["src/a.ts:10"], claim }),
        prior({ id: "R002", locs: ["src/b.ts:20"], claim }),
      ],
      posted,
      replies: [
        {
          in_reply_to_id: 111,
          body: dismissed,
          created_at: "2026-08-22T00:00:00Z",
        },
      ],
      summaryUpdatedAt: "2026-08-01T00:00:00Z",
    });
    expect(enriched.map((p) => [p.id, p.triage?.tag ?? null])).toEqual([
      ["R001", "dismissed"],
      ["R002", null],
    ]);
  });

  test("a claim-less prior recovered from posted markers still enriches", () => {
    // `priorsFromPostedMarkers` is the state === null fallback, and
    // `claimFingerprint("")` is the constant e3b0c44298fc, which no real
    // marker's `c` ever equals — so this whole path used to drop every triage
    // reply an author wrote. path:line is the identity both sides DO have.
    const priors = priorsFromPostedMarkers([
      { path: "src/a.ts", line: 10, channel: "inline" },
      { path: "src/b.ts", line: 20, channel: "inline" },
    ]);
    expect(priors.map((p) => p.claim)).toEqual(["", ""]);
    expect(claimFingerprint("")).toBe("e3b0c44298fc");

    const enriched = enrichPriorsFromThreads({
      priors,
      posted: [
        comment({ id: 111, path: "src/a.ts", line: 10, claim: "one" }),
        comment({ id: 222, path: "src/b.ts", line: 20, claim: "two" }),
      ],
      replies: [
        {
          in_reply_to_id: 222,
          body: dismissed,
          created_at: "2026-08-22T00:00:00Z",
        },
      ],
      summaryUpdatedAt: "2026-08-01T00:00:00Z",
    });
    expect(enriched.map((p) => [p.id, p.triage?.tag ?? null])).toEqual([
      ["R001", null],
      ["R002", "dismissed"],
    ]);
    expect(enriched[1]?.newThreadReply).toBe(true);
  });

  test("a base-driven live-line re-anchor still binds on the stored line", () => {
    // GitHub re-anchors a review comment's live `line` when the BASE advances
    // with no new push (`src/inline.ts:213-219`). Marker stored at 100, live
    // projection 112, prior still at 100: zero drift, and live-only matching
    // would silently drop this author's triage.
    const enriched = enrichPriorsFromThreads({
      priors: [prior({ id: "R001", locs: ["src/c.ts:100"], claim: "drifted" })],
      posted: [
        comment({
          id: 333,
          path: "src/c.ts",
          line: 100,
          claim: "drifted",
          liveLine: 112,
        }),
      ],
      replies: [
        {
          in_reply_to_id: 333,
          body: dismissed,
          created_at: "2026-08-22T00:00:00Z",
        },
      ],
      summaryUpdatedAt: "2026-08-01T00:00:00Z",
    });
    expect(enriched[0]?.triage?.tag).toBe("dismissed");
  });

  test("`c` breaks a tie between two comments at the same path:line", () => {
    // Two distinct defects reported at one line: both candidates sit at
    // distance 0, so the tie-breaker does exactly the job it was named for.
    const posted = [
      comment({ id: 111, path: "src/a.ts", line: 10, claim: "defect one" }),
      comment({ id: 222, path: "src/a.ts", line: 10, claim: "defect two" }),
    ];
    const enriched = enrichPriorsFromThreads({
      priors: [
        prior({ id: "R001", locs: ["src/a.ts:10"], claim: "defect two" }),
      ],
      posted,
      replies: [
        {
          in_reply_to_id: 222,
          body: dismissed,
          created_at: "2026-08-22T00:00:00Z",
        },
      ],
      summaryUpdatedAt: "2026-08-01T00:00:00Z",
    });
    expect(enriched[0]?.triage?.tag).toBe("dismissed");
  });

  test("an unbreakable tie binds nothing — under-match, never over-match", () => {
    // Same path:line, same claim text, no claim on the prior to break it
    // with. Binding either one would be a guess, and the guess a ✅ on a live
    // finding. `src/inline.ts`'s ambiguity rule, applied here.
    const enriched = enrichPriorsFromThreads({
      priors: [prior({ id: "R001", locs: ["src/a.ts:10"], claim: "" })],
      posted: [
        comment({ id: 111, path: "src/a.ts", line: 10, claim: "same" }),
        comment({ id: 222, path: "src/a.ts", line: 10, claim: "same" }),
      ],
      replies: [
        {
          in_reply_to_id: 111,
          body: dismissed,
          created_at: "2026-08-22T00:00:00Z",
        },
      ],
      summaryUpdatedAt: "2026-08-01T00:00:00Z",
    });
    expect(enriched[0]?.triage).toBeNull();
  });
});

describe("F002 — collapseTargets gives each verified-gone id its own thread", () => {
  const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  function comment(id: number, path: string, line: number, claim: string) {
    return {
      id,
      channel: "review" as const,
      marker: { path, line, headSha: HEAD, c: claimFingerprint(claim) },
      livePath: path,
      liveLine: line,
    };
  }

  test("a batch of claim-less priors collapses each to its own comment", () => {
    // The guaranteed-reachable shape from the review: every prior recovered
    // by `priorsFromPostedMarkers` carries `claim: ""`, so the old
    // fingerprint-only `.find()` returned the SAME first comment for every id
    // in the batch — a "✅ RESOLVED · verified gone" reply and a programmatic
    // thread-resolve landing on a finding nobody checked.
    const priors = priorsFromPostedMarkers([
      { path: "src/a.ts", line: 10, channel: "inline" },
      { path: "src/b.ts", line: 20, channel: "inline" },
      { path: "src/c.ts", line: 30, channel: "inline" },
    ]);
    expect(
      collapseTargets({
        verifiedGoneIds: ["R001", "R002", "R003"],
        priors,
        posted: [
          comment(111, "src/a.ts", 10, "one"),
          comment(222, "src/b.ts", 20, "two"),
          comment(333, "src/c.ts", 30, "three"),
        ],
      }),
    ).toEqual([
      { priorId: "R001", commentId: 111, channel: "review" },
      { priorId: "R002", commentId: 222, channel: "review" },
      { priorId: "R003", commentId: 333, channel: "review" },
    ]);
  });

  test("priors sharing claim text collapse to their own threads, not the first", () => {
    const claim = "a recurring pattern, reported at two sites";
    expect(
      collapseTargets({
        verifiedGoneIds: ["R001", "R002"],
        priors: [
          { id: "R001", claim, locs: ["src/a.ts:10"] },
          { id: "R002", claim, locs: ["src/b.ts:20"] },
        ],
        posted: [
          comment(111, "src/a.ts", 10, claim),
          comment(222, "src/b.ts", 20, claim),
        ],
      }),
    ).toEqual([
      { priorId: "R001", commentId: 111, channel: "review" },
      { priorId: "R002", commentId: 222, channel: "review" },
    ]);
  });

  test("a carried neighbour's thread is never taken by a verified-gone prior", () => {
    // One-to-one runs over EVERY prior, not just the retired ones: R002 is
    // carried and still live, and its comment sits within the line window of
    // R001's. Binding only the verified-gone subset would hand R001 whichever
    // comment came first and close a live finding's thread.
    expect(
      collapseTargets({
        verifiedGoneIds: ["R002"],
        priors: [
          { id: "R001", claim: "still live", locs: ["src/a.ts:10"] },
          { id: "R002", claim: "gone now", locs: ["src/a.ts:12"] },
        ],
        posted: [
          comment(111, "src/a.ts", 10, "still live"),
          comment(222, "src/a.ts", 12, "gone now"),
        ],
      }),
    ).toEqual([{ priorId: "R002", commentId: 222, channel: "review" }]);
  });
});
