import { describe, expect, test } from "bun:test";
import {
  classifyPrior,
  type PhaseBContext,
  type PriorRecord,
} from "../src/rereview-classify";
import type { FindingIdentity } from "../src/rereview-identity";

function prior(overrides: Partial<PriorRecord> = {}): PriorRecord {
  return {
    id: "R001",
    sev: "CRITICAL",
    tier: "blocking",
    channel: "inline",
    locs: ["src/app.ts:10"],
    claim: "a live defect",
    triage: null,
    newThreadReply: false,
    ...overrides,
  };
}

function ctx(overrides: Partial<PhaseBContext> = {}): PhaseBContext {
  return {
    case: "C",
    deletedFiles: new Set(),
    renameMap: new Map(),
    touched: () => false,
    summaryUpdatedAt: "2026-08-20T12:00:00Z",
    ...overrides,
  };
}

describe("rule 1 — every location's file deleted", () => {
  test("all files gone is verified-gone without a verification step", () => {
    const result = classifyPrior(
      prior({ locs: ["a.ts:1", "b.ts:2"] }),
      ctx({ deletedFiles: new Set(["a.ts", "b.ts"]) }),
    );
    expect(result.status).toBe("verified-gone");
    expect(result.trigger).toBeUndefined();
  });

  test("one surviving file is not verified-gone", () => {
    const result = classifyPrior(
      prior({ locs: ["a.ts:1", "b.ts:2"] }),
      ctx({
        deletedFiles: new Set(["a.ts"]),
        touched: () => true,
      }),
    );
    expect(result.status).toBe("queued");
    expect(result.trigger).toBe("touched");
  });
});

describe("rule 2 — rename before touched (R2-C1)", () => {
  test("rewrites locs onto the new path before touched() runs", () => {
    const seen: string[][] = [];
    const result = classifyPrior(
      prior({ locs: ["old.ts:10"] }),
      ctx({
        renameMap: new Map([["old.ts", "new.ts"]]),
        touched: (identity: FindingIdentity) => {
          seen.push([...identity.keys()]);
          return false;
        },
      }),
    );
    expect(result.renamed).toBe(true);
    expect(result.locs).toEqual(["new.ts:10"]);
    expect(seen).toEqual([["new.ts"]]);
    expect(result.status).toBe("carried");
  });

  test("a rename whose new path was then deleted is verified-gone", () => {
    const result = classifyPrior(
      prior({ locs: ["old.ts:10"] }),
      ctx({
        renameMap: new Map([["old.ts", "new.ts"]]),
        deletedFiles: new Set(["new.ts"]),
      }),
    );
    expect(result.status).toBe("verified-gone");
    expect(result.locs).toEqual(["new.ts:10"]);
  });
});

describe("rules 3–6 — triage outranks touched (O-3)", () => {
  test("dismissed+upheld stays suppressed even when the site moved", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "dismissed",
          verdict: "upheld",
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx({ touched: () => true }),
    );
    expect(result.status).toBe("suppressed");
    expect(result.trigger).toBeUndefined();
  });

  test("dismissed+rejected returns blocking, no verify", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "dismissed",
          verdict: "rejected",
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx(),
    );
    expect(result.status).toBe("returned");
  });

  test("deferred stays deferred without an issue number (S6)", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "deferred",
          verdict: "upheld",
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx({ touched: () => true }),
    );
    expect(result.status).toBe("deferred");
  });

  test("misclassified is re-tiered, not re-hunted", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "misclassified",
          verdict: "upheld",
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx(),
    );
    expect(result.status).toBe("re-tiered");
  });

  test("dismissed+inconclusive is not suppressed — touched still queues", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "dismissed",
          verdict: "inconclusive",
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx({ touched: () => true }),
    );
    expect(result.status).toBe("queued");
    expect(result.trigger).toBe("touched");
  });
});

describe("rule 7 — applied", () => {
  test("case C queues verify for applied", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "applied",
          verdict: null,
          createdAt: "2026-08-19T00:00:00Z",
        },
      }),
      ctx({ case: "C" }),
    );
    expect(result).toMatchObject({ status: "queued", trigger: "applied" });
  });

  test("case B does not re-buy an applied tag older than the summary (R2-S9)", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "applied",
          verdict: null,
          createdAt: "2026-08-19T00:00:00Z",
        },
      }),
      ctx({ case: "B", summaryUpdatedAt: "2026-08-20T12:00:00Z" }),
    );
    expect(result.status).toBe("carried");
  });

  test("case B queues a NEW applied tag", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "applied",
          verdict: null,
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx({ case: "B", summaryUpdatedAt: "2026-08-20T12:00:00Z" }),
    );
    expect(result).toMatchObject({ status: "queued", trigger: "applied" });
  });
});

describe("rule 7b — case B new reply", () => {
  test("a new thread reply queues verify when there is no new applied tag", () => {
    const result = classifyPrior(
      prior({ newThreadReply: true }),
      ctx({ case: "B" }),
    );
    expect(result).toMatchObject({ status: "queued", trigger: "case_b_reply" });
  });
});

describe("rules 8–9 — touched vs carried", () => {
  test("touched queues verify", () => {
    const result = classifyPrior(prior(), ctx({ touched: () => true }));
    expect(result).toMatchObject({ status: "queued", trigger: "touched" });
  });

  test("untouched with no triage is carried — never resolved from absence", () => {
    const result = classifyPrior(prior(), ctx());
    expect(result.status).toBe("carried");
    expect(result.trigger).toBeUndefined();
  });
});

describe("case D/E — verify-all after triage settles", () => {
  test("an unsettled prior is queued as verify_all", () => {
    const result = classifyPrior(prior(), ctx({ case: "D" }));
    expect(result).toMatchObject({ status: "queued", trigger: "verify_all" });
  });

  test("dismissed+upheld still settles as suppressed (O-3)", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "dismissed",
          verdict: "upheld",
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx({ case: "D" }),
    );
    expect(result.status).toBe("suppressed");
  });

  test("a deleted file is still verified-gone, not verify_all", () => {
    const result = classifyPrior(
      prior(),
      ctx({ case: "E", deletedFiles: new Set(["src/app.ts"]) }),
    );
    expect(result.status).toBe("verified-gone");
  });
});
