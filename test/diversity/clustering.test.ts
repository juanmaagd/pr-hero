import { describe, expect, test } from "bun:test";
import {
  buildAdjudicationGroups,
  buildClusters,
  compareObservations,
  type FindingObservation,
  projectClusterIds,
} from "../../src/diversity/clustering";

function observation(
  id: string,
  overrides: Partial<FindingObservation> = {},
): FindingObservation {
  return {
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
    ...overrides,
  };
}

describe("diversity clustering", () => {
  test("merges only strong_same_defect pairs with shared anchors", () => {
    const left = observation("o1");
    const right = observation("o2", { legId: "leg-2", proofRefs: ["proof-a"] });
    expect(compareObservations(left, right)).toBe("strong_same_defect");
    const clusters = buildClusters([left, right]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.observations).toHaveLength(2);
  });

  test("keeps ambiguous pairs visible without definitive merge", () => {
    const left = observation("o1", { proofRefs: [], line: 10, category: 1 });
    const right = observation("o2", {
      line: 20,
      proofRefs: [],
      legId: "leg-2",
      category: 2,
    });
    expect(compareObservations(left, right)).toBe("ambiguous");
    const groups = buildAdjudicationGroups([left, right]);
    expect(groups.some((group) => group.ambiguous)).toBe(true);
  });

  test("projection is stable across permuted arrivals", () => {
    const obs = [
      observation("o1"),
      observation("o2", { legId: "leg-2", proofRefs: ["proof-a"] }),
      observation("o3", {
        path: "src/b.ts",
        symbol: "bar",
        proofRefs: ["proof-b"],
        legId: "leg-3",
      }),
    ];
    const forward = projectClusterIds(obs);
    const reversed = projectClusterIds([...obs].reverse());
    expect(forward).toEqual(reversed);
  });
});
