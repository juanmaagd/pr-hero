// pr-hero — a multi-agent PR-review engine (hunters → dedupe → refuter → tier).
// Public API surface; the deep-review lab consumes exactly these exports.

export const ENGINE_NAME = "pr-hero";
export const ENGINE_VERSION = "1.1.0";

export * from "./model/routing";
export * from "./pipeline";
export * from "./preflight";
export * from "./report";
export * from "./review/dedupe";
export * from "./review/drafts";
export * from "./review/findings";
export * from "./review/findings-conformance";
export * from "./review/prompt-set";
export * from "./review/root-cause";
export * from "./review/spec";
export * from "./step-runner";
export * from "./transport-registry";
export * from "./usage";
