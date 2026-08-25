// pr-hero — a multi-agent PR-review engine (hunters → dedupe → refuter → tier).
// Public API surface; the deep-review lab consumes exactly these exports.

export const ENGINE_NAME = "pr-hero";
export const ENGINE_VERSION = "1.0.0";

export * from "./dedupe";
export * from "./drafts";
export * from "./findings";
export * from "./pipeline";
export * from "./preflight";
export * from "./prompt-set";
export * from "./report";
export * from "./root-cause";
export * from "./spec";
export * from "./step-runner";
export * from "./usage";
