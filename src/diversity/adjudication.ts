import { createHash } from "node:crypto";
import type {
  CausalDisposition,
  EvidenceClass,
  HopTrail,
  Severity,
} from "../findings";
import type { AdjudicationGroup } from "./clustering";

export interface CodeEvidenceReport {
  readonly inspectedLocations: readonly {
    path: string;
    line?: number;
    symbol?: string;
  }[];
  readonly reachableBehavior: readonly string[];
  readonly proofRefs: readonly string[];
  readonly limitations: readonly string[];
  readonly sha256: string;
}

export interface ClusterAdjudication {
  readonly evidenceReportSha256: string;
  readonly relation:
    | "same_defect"
    | "distinct_defects"
    | "no_defect"
    | "inconclusive";
  readonly hypotheses: readonly {
    id: string;
    outcome: "supported" | "refuted" | "latent" | "inconclusive";
    proofRefs: readonly string[];
  }[];
  readonly canonicalFindings: readonly {
    path: string;
    line?: number;
    symbol?: string;
    severity: Severity;
    category: number;
    evidenceClass: EvidenceClass;
    causalDisposition: CausalDisposition;
    claim: string;
    proofRefs: readonly string[];
    hopsUsed: number;
    hopTrail: HopTrail;
  }[];
}

export function hashCodeEvidenceReport(
  report: Omit<CodeEvidenceReport, "sha256">,
): string {
  return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}

export function bindCodeEvidenceReport(
  report: Omit<CodeEvidenceReport, "sha256">,
): CodeEvidenceReport {
  const sha256 = hashCodeEvidenceReport(report);
  return { ...report, sha256 };
}

export function validateHashBinding(
  adjudication: ClusterAdjudication,
  report: CodeEvidenceReport,
): boolean {
  return adjudication.evidenceReportSha256 === report.sha256;
}

export function adjudicateGroupConservatively(
  group: AdjudicationGroup,
  report?: CodeEvidenceReport,
  adjudication?: ClusterAdjudication,
): ClusterAdjudication {
  if (!report || !adjudication) {
    return {
      evidenceReportSha256: report?.sha256 ?? "",
      relation: "inconclusive",
      hypotheses: group.clusters.flatMap((cluster, index) =>
        cluster.observations.map((_, hypothesisIndex) => ({
          id: `H${index + 1}-${hypothesisIndex + 1}`,
          outcome: "inconclusive" as const,
          proofRefs: [],
        })),
      ),
      canonicalFindings: [],
    };
  }
  if (!validateHashBinding(adjudication, report)) {
    return adjudicateGroupConservatively(group);
  }
  return adjudication;
}

export function anonymousHypothesisId(index: number): string {
  return `H${index + 1}`;
}
