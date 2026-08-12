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
    });
    expect(parseTriageMarker(marker)).toEqual({
      tag: "dismissed",
      headSha: HEAD,
      actor: "agent",
    });
  });

  test("round-trips tag, head, and actor for misclassified", () => {
    const marker = triageMarker({
      tag: "misclassified",
      headSha: HEAD,
      actor: "human",
    });
    expect(parseTriageMarker(marker)).toEqual({
      tag: "misclassified",
      headSha: HEAD,
      actor: "human",
    });
  });

  test("round-trips deferred with its issue number", () => {
    const marker = triageMarker({
      tag: "deferred",
      headSha: HEAD,
      actor: "agent",
      issue: 482,
    });
    expect(parseTriageMarker(marker)).toEqual({
      tag: "deferred",
      headSha: HEAD,
      actor: "agent",
      issue: 482,
    });
  });

  // The rule that stops defer from decaying into a dismiss with a better
  // name (ROADMAP B6b): the builder refuses to emit a deferred marker with
  // no destination at all.
  test("triageMarker throws for deferred with no issue number", () => {
    expect(() =>
      triageMarker({ tag: "deferred", headSha: HEAD, actor: "agent" }),
    ).toThrow(/deferred requires an issue/);
  });

  // The parser's half of the same rule: even a hand-written or corrupted
  // deferred marker with no `issue=` field must fail to parse rather than
  // be accepted as some other tag's shape.
  test("a deferred marker with no issue field does not parse", () => {
    const malformed = `${TRIAGE_MARKER_PREFIX}tag=deferred head=${HEAD} actor=agent -->`;
    expect(parseTriageMarker(malformed)).toBeNull();
  });

  test("a deferred marker with a non-numeric issue does not parse", () => {
    const malformed = `${TRIAGE_MARKER_PREFIX}tag=deferred head=${HEAD} actor=agent issue=NaN -->`;
    expect(parseTriageMarker(malformed)).toBeNull();
  });

  test("a deferred marker with a zero or negative issue does not parse", () => {
    expect(
      parseTriageMarker(
        `${TRIAGE_MARKER_PREFIX}tag=deferred head=${HEAD} actor=agent issue=0 -->`,
      ),
    ).toBeNull();
    expect(
      parseTriageMarker(
        `${TRIAGE_MARKER_PREFIX}tag=deferred head=${HEAD} actor=agent issue=-3 -->`,
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
