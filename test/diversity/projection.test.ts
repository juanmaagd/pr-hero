import { describe, expect, test } from "bun:test";
import {
  projectAdjudicationToFindings,
  stableProjectionOrder,
} from "../../src/diversity/projection";

describe("diversity projection", () => {
  test("ignores arrival order when ordering canonical findings", () => {
    const adjudication = {
      evidenceReportSha256: "hash",
      relation: "distinct_defects" as const,
      hypotheses: [],
      canonicalFindings: [
        {
          path: "src/b.ts",
          line: 2,
          severity: "WARNING" as const,
          category: 2,
          evidenceClass: "inferential" as const,
          causalDisposition: "introduced" as const,
          claim: "b",
          proofRefs: [],
          hopsUsed: 0,
          hopTrail: [],
        },
        {
          path: "src/a.ts",
          line: 1,
          severity: "CRITICAL" as const,
          category: 1,
          evidenceClass: "deterministic" as const,
          causalDisposition: "introduced" as const,
          claim: "a",
          proofRefs: [],
          hopsUsed: 0,
          hopTrail: [],
        },
      ],
    };
    const first = stableProjectionOrder(
      projectAdjudicationToFindings(adjudication, "reliability").findings,
    );
    const second = stableProjectionOrder(
      projectAdjudicationToFindings(
        {
          ...adjudication,
          canonicalFindings: [...adjudication.canonicalFindings].reverse(),
        },
        "reliability",
      ).findings,
    );
    expect(first.map((finding) => finding.path)).toEqual(
      second.map((finding) => finding.path),
    );
  });
});
