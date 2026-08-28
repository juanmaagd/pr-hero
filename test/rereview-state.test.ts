import { describe, expect, test } from "bun:test";
import {
  PR_COMMENT_MARKER_PREFIX,
  PR_FINDING_MARKER_PREFIX,
  parseFindingMarker,
  prCommentMarker,
} from "../src/pr-preflight";
import {
  assembleLive,
  assignFreshIds,
  capLiveFindings,
  type LiveFinding,
  PR_STATE_MARKER_PREFIX,
  parseStateBlock,
  renderStateBlock,
  rewriteStateFindings,
  type StateFinding,
  stateFinding,
} from "../src/rereview-state";
import { TRIAGE_MARKER_PREFIX } from "../src/triage";

const HEAD = "8da9fad5bc9f650df38fc8cb0237253d80ff3245";

function finding(
  id: string,
  overrides: Partial<Omit<StateFinding, "id">> = {},
): StateFinding {
  return stateFinding({
    id,
    sev: "CRITICAL",
    tier: "blocking",
    channel: "inline",
    locs: ["src/app.ts:10"],
    claim: `claim for ${id}`,
    ...overrides,
  });
}

function live(
  id: string,
  status: LiveFinding["status"],
  overrides: Partial<Omit<StateFinding, "id">> = {},
): LiveFinding {
  return { ...finding(id, overrides), status };
}

describe("D5a — parseFindingMarker returns null for the state block", () => {
  test("a state block is not a finding marker", () => {
    const block = renderStateBlock(HEAD, [finding("R001")]);
    expect(parseFindingMarker(block)).toBeNull();
    expect(parseFindingMarker(`${block}\nmore body`)).toBeNull();
  });
});

describe("prefix disjointness", () => {
  test("state prefix is not a prefix of report, finding, or triage — or vice versa", () => {
    const prefixes = [
      PR_COMMENT_MARKER_PREFIX,
      PR_FINDING_MARKER_PREFIX,
      TRIAGE_MARKER_PREFIX,
      PR_STATE_MARKER_PREFIX,
    ];
    for (let i = 0; i < prefixes.length; i++) {
      for (let j = 0; j < prefixes.length; j++) {
        if (i === j) continue;
        expect(prefixes[i]?.startsWith(prefixes[j] as string)).toBe(false);
      }
    }
  });
});

describe("render / parse round-trip", () => {
  test("recovers head and findings from a body that starts with the report marker", () => {
    const stored = [
      finding("R001", { channel: "inline", locs: ["a.ts:1-4"] }),
      finding("R002", {
        channel: "outside",
        claim: "the only copy of an Outside Diff finding",
      }),
    ];
    const body = `${prCommentMarker(HEAD)}\nvisible report\n${renderStateBlock(HEAD, stored)}`;
    expect(body.startsWith(PR_COMMENT_MARKER_PREFIX)).toBe(true);
    const parsed = parseStateBlock(body);
    expect(parsed?.headSha).toBe(HEAD);
    expect(parsed?.findings).toEqual(stored);
  });

  test("D5e — a claim containing --> and quotes round-trips", () => {
    const stored = [
      finding("R001", {
        claim: 'foo --> bar "quoted" and a \\ slash',
        locs: ["a.ts:1"],
      }),
    ];
    const rendered = renderStateBlock(HEAD, stored);
    expect(rendered).not.toContain("--> bar");
    expect(parseStateBlock(rendered)?.findings[0]?.claim).toBe(
      stored[0]?.claim,
    );
  });

  test("malformed JSON is a match failure, not a throw", () => {
    const body = `${stateish()}\n<!-- {not json} -->`;
    expect(parseStateBlock(body)).toBeNull();
  });

  test("reviews counter round-trips", () => {
    const body = renderStateBlock(HEAD, [finding("R001")], 2);
    expect(parseStateBlock(body)?.reviews).toBe(2);
  });
});

describe("D5d — rewrite from the merged live set", () => {
  test("one new, three carried, one verified-gone → four entries; gone retired", () => {
    const previous = [
      finding("R001"),
      finding("R002"),
      finding("R003"),
      finding("R004"),
    ];
    const next = rewriteStateFindings({
      previous,
      survivingIds: new Set(["R002", "R003", "R004"]),
      fresh: [
        {
          sev: "WARNING",
          tier: "advisory",
          channel: "inline",
          locs: ["new.ts:3"],
          c: finding("R999", { claim: "fresh" }).c,
          claim: "fresh",
        },
      ],
    });
    expect(next.map((f) => f.id)).toEqual(["R002", "R003", "R004", "R005"]);
    expect(next).toHaveLength(4);
  });

  test("a retired id is never reused (R2-S1)", () => {
    const assigned = assignFreshIds(
      ["R001", "R002"],
      [
        {
          sev: "CRITICAL",
          tier: "blocking",
          channel: "inline",
          locs: ["a.ts:1"],
          c: "aaaaaaaaaaaa",
          claim: "x",
        },
      ],
    );
    expect(assigned[0]?.id).toBe("R003");
  });
});

describe("D5b — cap evicts unconfirmed then carried, never suppressed or deferred", () => {
  test("drops unconfirmed before carried, and keeps suppressed + deferred", () => {
    const entries = [
      live("R001", "suppressed"),
      live("R002", "deferred"),
      live("R003", "carried", { claim: "c".repeat(80) }),
      live("R004", "unconfirmed", { claim: "u".repeat(80) }),
    ];
    const prefix = "x".repeat(200);
    const result = capLiveFindings(entries, prefix, HEAD, 400);
    expect(result.kept.map((e) => e.id)).not.toContain("R004");
    expect(result.droppedUnconfirmed).toBeGreaterThan(0);
    expect(result.kept.some((e) => e.status === "suppressed")).toBe(true);
    expect(result.kept.some((e) => e.status === "deferred")).toBe(true);
    expect(result.kept.some((e) => e.status === "unconfirmed")).toBe(false);
  });

  test("never drops suppressed even when they are the only entries left", () => {
    const entries = [live("R001", "suppressed"), live("R002", "deferred")];
    const result = capLiveFindings(entries, "x".repeat(500), HEAD, 100);
    expect(result.kept.map((e) => e.id)).toEqual(["R001", "R002"]);
    expect(result.droppedUnconfirmed).toBe(0);
    expect(result.droppedCarried).toBe(0);
  });
});

function stateish(): string {
  return `<!-- pr-hero-state v=1 head=${HEAD} -->`;
}

describe("assembleLive", () => {
  test("queued priors take the verify verdict; capped ones stay unconfirmed", () => {
    const priors = [
      {
        id: "R001",
        sev: "CRITICAL" as const,
        tier: "blocking" as const,
        channel: "inline" as const,
        locs: ["src/app.ts:10"],
        claim: "still live",
        triage: null,
        newThreadReply: false,
      },
      {
        id: "R002",
        sev: "WARNING" as const,
        tier: "advisory" as const,
        channel: "inline" as const,
        locs: ["src/b.ts:1"],
        claim: "capped",
        triage: null,
        newThreadReply: false,
      },
    ];
    const assembled = assembleLive({
      settled: [
        {
          id: "R001",
          status: "queued",
          locs: ["src/app.ts:10"],
          renamed: false,
          trigger: "touched",
        },
        {
          id: "R002",
          status: "queued",
          locs: ["src/b.ts:1"],
          renamed: false,
          trigger: "verify_all",
        },
      ],
      priors,
      verifyVerdicts: new Map([["R001", "verified-gone"]]),
    });
    expect(assembled.verifiedGone).toBe(1);
    expect(assembled.verifiedGoneIds).toEqual(["R001"]);
    expect(assembled.live.map((row) => `${row.id}:${row.status}`)).toEqual([
      "R002:unconfirmed",
    ]);
  });
});
