import { SCHEMA_VERSION_V1_1, validateFindingsDocument } from "../findings";
import { FINDINGS_CONFORMANCE_CASES } from "../findings-conformance";
import { DiversityCapabilityError } from "./errors";

export interface InternalCapabilityReport {
  readonly ok: boolean;
  readonly c2SchemaVersion: string;
  readonly reason?: string;
}

export function checkInternalFindingsCapability(): InternalCapabilityReport {
  try {
    for (const conformanceCase of FINDINGS_CONFORMANCE_CASES) {
      const parsed = JSON.parse(conformanceCase.raw);
      const shouldAccept = conformanceCase.expect === "accept";
      try {
        validateFindingsDocument(parsed);
        if (!shouldAccept) {
          return {
            ok: false,
            c2SchemaVersion: SCHEMA_VERSION_V1_1,
            reason: `conformance case ${conformanceCase.id} expected reject`,
          };
        }
      } catch (error) {
        if (shouldAccept) {
          return {
            ok: false,
            c2SchemaVersion: SCHEMA_VERSION_V1_1,
            reason: `conformance case ${conformanceCase.id} expected accept: ${(error as Error).message}`,
          };
        }
      }
    }
    return { ok: true, c2SchemaVersion: SCHEMA_VERSION_V1_1 };
  } catch (error) {
    return {
      ok: false,
      c2SchemaVersion: SCHEMA_VERSION_V1_1,
      reason: (error as Error).message,
    };
  }
}

export function requireInternalFindingsCapability(): void {
  assertDiversityCapabilityOrThrow();
}

export function assertDiversityCapabilityOrThrow(
  report: InternalCapabilityReport = checkInternalFindingsCapability(),
): void {
  if (!report.ok) {
    throw new DiversityCapabilityError(
      report.reason ?? "internal findings v1.1 capability unavailable",
    );
  }
}
