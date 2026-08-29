import { describe, expect, test } from "bun:test";
import {
  adjudicateGroupConservatively,
  bindCodeEvidenceReport,
  validateHashBinding,
} from "../../src/diversity/adjudication";
import {
  buildAdjudicationGroups,
  type FindingObservation,
} from "../../src/diversity/clustering";
import {
  projectAdjudicationToFindings,
  stableProjectionOrder,
} from "../../src/diversity/projection";

const observation = (id: string): FindingObservation => ({
  observationId: id,
  specialty: "reliability",
  legId: `leg-${id}`,
  backend: "claude-code",
  provider: "anthropic",
  modelFamily: "claude",
  modelSnapshot: "sonnet",
  replicate: 1,
  attempt: 1,
  promptFingerprint: "prompt",
  routeFingerprint: "route",
  path: "src/a.ts",
  line: 10,
  symbol: "foo",
  category: 1,
  severity: "CRITICAL",
  claim: "claim",
  evidence: "evidence",
  proofRefs: ["proof-a"],
  causalHypothesis: "hypothesis",
  artifactSha256: "sha",
});

describe("blind adjudication", () => {
  test("accepts hash-bound anonymous votes", () => {
    const report = bindCodeEvidenceReport({
      inspectedLocations: [{ path: "src/a.ts", line: 10, symbol: "foo" }],
      reachableBehavior: ["throws"],
      proofRefs: ["proof-a"],
      limitations: [],
    });
    const adjudication = {
      evidenceReportSha256: report.sha256,
      relation: "same_defect" as const,
      hypotheses: [
        { id: "H1", outcome: "supported" as const, proofRefs: ["proof-a"] },
      ],
      canonicalFindings: [
        {
          path: "src/a.ts",
          line: 10,
          symbol: "foo",
          severity: "CRITICAL" as const,
          category: 1,
          evidenceClass: "deterministic" as const,
          causalDisposition: "introduced" as const,
          claim: "claim",
          proofRefs: ["proof-a"],
          hopsUsed: 0,
          hopTrail: [],
        },
      ],
    };
    expect(validateHashBinding(adjudication, report)).toBe(true);
    const projected = projectAdjudicationToFindings(
      adjudication,
      "reliability",
    );
    expect(projected.findings).toHaveLength(1);
    expect(stableProjectionOrder(projected.findings)[0]?.hunter).toBe(
      "reliability",
    );
  });

  test("fails conservatively on missing or mismatched binding", () => {
    const group = buildAdjudicationGroups([
      observation("o1"),
      observation("o2"),
    ])[0];
    if (!group) throw new Error("missing group");
    const conservative = adjudicateGroupConservatively(group);
    expect(conservative.relation).toBe("inconclusive");
    expect(conservative.canonicalFindings).toHaveLength(0);
  });
});
