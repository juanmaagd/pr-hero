import { describe, expect, test } from "bun:test";
import {
  adjudicateGroupConservatively,
  bindCodeEvidenceReport,
} from "../../src/diversity/adjudication";
import { buildAdjudicationGroups } from "../../src/diversity/clustering";
import { projectAdjudicationToFindings } from "../../src/diversity/projection";

describe("adjudication integration", () => {
  test("projects severe groups only after valid two-stage binding", () => {
    const group = buildAdjudicationGroups([
      {
        observationId: "o1",
        specialty: "reliability",
        legId: "leg-1",
        backend: "claude-code",
        provider: "anthropic",
        modelFamily: "claude",
        modelSnapshot: "sonnet",
        replicate: 1,
        attempt: 1,
        promptFingerprint: "prompt",
        routeFingerprint: "route",
        path: "src/a.ts",
        line: 1,
        category: 1,
        severity: "BLOCKER",
        claim: "claim",
        evidence: "evidence",
        proofRefs: ["proof"],
        causalHypothesis: "hypothesis",
        artifactSha256: "sha",
      },
    ])[0];
    if (!group) throw new Error("missing group");
    const report = bindCodeEvidenceReport({
      inspectedLocations: [{ path: "src/a.ts", line: 1 }],
      reachableBehavior: ["panic"],
      proofRefs: ["proof"],
      limitations: [],
    });
    const adjudication = adjudicateGroupConservatively(group, report, {
      evidenceReportSha256: report.sha256,
      relation: "same_defect",
      hypotheses: [{ id: "H1", outcome: "supported", proofRefs: ["proof"] }],
      canonicalFindings: [
        {
          path: "src/a.ts",
          line: 1,
          severity: "BLOCKER",
          category: 1,
          evidenceClass: "deterministic",
          causalDisposition: "introduced",
          claim: "claim",
          proofRefs: ["proof"],
          hopsUsed: 0,
          hopTrail: [],
        },
      ],
    });
    const projected = projectAdjudicationToFindings(
      adjudication,
      "reliability",
    );
    expect(projected.findings[0]?.tier).toBe("blocking");
  });
});
