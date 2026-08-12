// Pure-decision tests for the triage reply marker (ROADMAP B6b). All
// offline, literal in → literal out — same discipline as
// pr-preflight.test.ts's marker suites.

import { describe, expect, test } from "bun:test";
import {
  PR_COMMENT_MARKER_PREFIX,
  PR_FINDING_MARKER_PREFIX,
} from "../src/pr-preflight";
import {
  parseTriageMarker,
  TRIAGE_MARKER_PREFIX,
  triageMarker,
} from "../src/triage";

const HEAD = "e3ab386a63020c6f5c21d814d176ff33849eef8d";

describe("marker prefix disjointness", () => {
  // Extends the pr-preflight.test.ts discipline to the third marker family:
  // none of the three may be a prefix of another, or a matcher scanning the
  // shared comment stream could misfile one as another.
  test("triage prefix is disjoint from both existing marker prefixes", () => {
    expect(TRIAGE_MARKER_PREFIX.startsWith(PR_COMMENT_MARKER_PREFIX)).toBe(
      false,
    );
    expect(PR_COMMENT_MARKER_PREFIX.startsWith(TRIAGE_MARKER_PREFIX)).toBe(
      false,
    );
    expect(TRIAGE_MARKER_PREFIX.startsWith(PR_FINDING_MARKER_PREFIX)).toBe(
      false,
    );
    expect(PR_FINDING_MARKER_PREFIX.startsWith(TRIAGE_MARKER_PREFIX)).toBe(
      false,
    );
  });
});

describe("triageMarker + parseTriageMarker", () => {
  test("round-trips tag, head, and actor for applied", () => {
    const marker = triageMarker({
      tag: "applied",
      headSha: HEAD,
      actor: "agent",
    });
    expect(marker.startsWith(TRIAGE_MARKER_PREFIX)).toBe(true);
    expect(parseTriageMarker(marker)).toEqual({
      tag: "applied",
      headSha: HEAD,
      actor: "agent",
    });
  });

  test("round-trips tag, head, and actor for dismissed", () => {
    const marker = triageMarker({
      tag: "dismissed",
      headSha: HEAD,
      actor: "agent",
      verdict: "upheld",
    });
    expect(parseTriageMarker(marker)).toEqual({
      tag: "dismissed",
      headSha: HEAD,
      actor: "agent",
      verdict: "upheld",
    });
  });

  test("round-trips tag, head, and actor for misclassified", () => {
    const marker = triageMarker({
      tag: "misclassified",
      headSha: HEAD,
      actor: "human",
      verdict: "upheld",
    });
    expect(parseTriageMarker(marker)).toEqual({
      tag: "misclassified",
      headSha: HEAD,
      actor: "human",
      verdict: "upheld",
    });
  });

  test("round-trips deferred with its issue number and verdict", () => {
    const marker = triageMarker({
      tag: "deferred",
      headSha: HEAD,
      actor: "agent",
      issue: 482,
      verdict: "upheld",
    });
    expect(parseTriageMarker(marker)).toEqual({
      tag: "deferred",
      headSha: HEAD,
      actor: "agent",
      issue: 482,
      verdict: "upheld",
    });
  });

  // The adjudicator's full vocabulary round-trips, not just `upheld` —
  // `rejected` and `inconclusive` are the other two verdicts 6c depends on
  // to distinguish "settled against the author" from "still unsettled".
  test("round-trips rejected and inconclusive verdicts", () => {
    const rejected = triageMarker({
      tag: "dismissed",
      headSha: HEAD,
      actor: "agent",
      verdict: "rejected",
    });
    expect(parseTriageMarker(rejected)?.verdict).toBe("rejected");

    const inconclusive = triageMarker({
      tag: "misclassified",
      headSha: HEAD,
      actor: "agent",
      verdict: "inconclusive",
    });
    expect(parseTriageMarker(inconclusive)?.verdict).toBe("inconclusive");
  });

  // The rule that stops defer from decaying into a dismiss with a better
  // name (ROADMAP B6b): the builder refuses to emit a deferred marker with
  // no destination at all.
  test("triageMarker throws for deferred with no issue number", () => {
    expect(() =>
      triageMarker({ tag: "deferred", headSha: HEAD, actor: "agent" }),
    ).toThrow(/deferred requires an issue/);
  });

  // The same two-way guard, now for `verdict`: dismissed, deferred, and
  // misclassified all spawn an adjudicator, so a marker missing its verdict
  // must fail to BUILD...
  test("triageMarker throws for dismissed/deferred/misclassified with no verdict", () => {
    expect(() =>
      triageMarker({ tag: "dismissed", headSha: HEAD, actor: "agent" }),
    ).toThrow(/dismissed requires a verdict/);
    expect(() =>
      triageMarker({
        tag: "deferred",
        headSha: HEAD,
        actor: "agent",
        issue: 482,
      }),
    ).toThrow(/deferred requires a verdict/);
    expect(() =>
      triageMarker({ tag: "misclassified", headSha: HEAD, actor: "agent" }),
    ).toThrow(/misclassified requires a verdict/);
  });

  // ...and must fail to PARSE, for the same reason a missing `issue` on a
  // deferred marker must fail to parse: a hand-written or corrupted marker
  // with no `verdict=` field must never be accepted, or 6c would read an
  // un-adjudicated finding as settled.
  test("dismissed/deferred/misclassified markers with no verdict field do not parse", () => {
    expect(
      parseTriageMarker(
        `${TRIAGE_MARKER_PREFIX}tag=dismissed head=${HEAD} actor=agent -->`,
      ),
    ).toBeNull();
    expect(
      parseTriageMarker(
        `${TRIAGE_MARKER_PREFIX}tag=deferred head=${HEAD} actor=agent issue=482 -->`,
      ),
    ).toBeNull();
    expect(
      parseTriageMarker(
        `${TRIAGE_MARKER_PREFIX}tag=misclassified head=${HEAD} actor=agent -->`,
      ),
    ).toBeNull();
  });

  test("a marker with an unknown verdict word does not parse", () => {
    const malformed = `${TRIAGE_MARKER_PREFIX}tag=dismissed head=${HEAD} actor=agent verdict=maybe -->`;
    expect(parseTriageMarker(malformed)).toBeNull();
  });

  // Stricter than `issue` (which is merely ignored on non-deferred tags):
  // `applied` never spawns an adjudicator, so a verdict on an `applied`
  // marker is a false claim, not harmless noise. The builder refuses to
  // emit one...
  test("triageMarker throws for applied with a verdict", () => {
    expect(() =>
      triageMarker({
        tag: "applied",
        headSha: HEAD,
        actor: "agent",
        verdict: "upheld",
      }),
    ).toThrow(/applied must not carry a verdict/);
  });

  // ...and the parser rejects one it finds, rather than silently ignore it.
  test("an applied marker with a verdict field does not parse", () => {
    const malformed = `${TRIAGE_MARKER_PREFIX}tag=applied head=${HEAD} actor=agent verdict=upheld -->`;
    expect(parseTriageMarker(malformed)).toBeNull();
  });

  // The parser's half of the same rule: even a hand-written or corrupted
  // deferred marker with no `issue=` field must fail to parse rather than
  // be accepted as some other tag's shape.
  // `verdict=upheld` is present in each of these so the null result is
  // attributable to the issue guard being tested, not the verdict guard
  // above (which would also fail these markers for an unrelated reason).
  test("a deferred marker with no issue field does not parse", () => {
    const malformed = `${TRIAGE_MARKER_PREFIX}tag=deferred head=${HEAD} actor=agent verdict=upheld -->`;
    expect(parseTriageMarker(malformed)).toBeNull();
  });

  test("a deferred marker with a non-numeric issue does not parse", () => {
    const malformed = `${TRIAGE_MARKER_PREFIX}tag=deferred head=${HEAD} actor=agent verdict=upheld issue=NaN -->`;
    expect(parseTriageMarker(malformed)).toBeNull();
  });

  test("a deferred marker with a zero or negative issue does not parse", () => {
    expect(
      parseTriageMarker(
        `${TRIAGE_MARKER_PREFIX}tag=deferred head=${HEAD} actor=agent verdict=upheld issue=0 -->`,
      ),
    ).toBeNull();
    expect(
      parseTriageMarker(
        `${TRIAGE_MARKER_PREFIX}tag=deferred head=${HEAD} actor=agent verdict=upheld issue=-3 -->`,
      ),
    ).toBeNull();
  });

  test("an unknown tag does not parse", () => {
    const malformed = `${TRIAGE_MARKER_PREFIX}tag=wontfix head=${HEAD} actor=agent -->`;
    expect(parseTriageMarker(malformed)).toBeNull();
  });

  test("an unknown actor does not parse", () => {
    const malformed = `${TRIAGE_MARKER_PREFIX}tag=applied head=${HEAD} actor=robot -->`;
    expect(parseTriageMarker(malformed)).toBeNull();
  });

  test("a non-40-hex head does not parse", () => {
    const malformed = `${TRIAGE_MARKER_PREFIX}tag=applied head=abc123 actor=agent -->`;
    expect(parseTriageMarker(malformed)).toBeNull();
  });

  test("missing a required field does not parse", () => {
    expect(
      parseTriageMarker(`${TRIAGE_MARKER_PREFIX}tag=applied head=${HEAD} -->`),
    ).toBeNull();
    expect(
      parseTriageMarker(`${TRIAGE_MARKER_PREFIX}head=${HEAD} actor=agent -->`),
    ).toBeNull();
  });

  test("a body with no marker prefix returns null", () => {
    expect(parseTriageMarker("just a reply, no marker")).toBeNull();
  });

  test("a body missing the closing --> returns null", () => {
    expect(
      parseTriageMarker(
        `${TRIAGE_MARKER_PREFIX}tag=applied head=${HEAD} actor=agent`,
      ),
    ).toBeNull();
  });

  // Only a body that STARTS with the marker is ours: a triage marker quoted
  // mid-reply (someone pasting a prior triage into a new comment) must
  // never be treated as a fresh one.
  test("a marker quoted mid-body is not a match", () => {
    const marker = triageMarker({
      tag: "applied",
      headSha: HEAD,
      actor: "agent",
    });
    expect(parseTriageMarker(`see above:\n${marker}`)).toBeNull();
    expect(parseTriageMarker(` ${marker} leading space`)).toBeNull();
  });
});
