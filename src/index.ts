// pr-hero — a multi-agent PR-review engine (hunters → dedupe → refuter → tier).
// Public API surface; the deep-review lab consumes exactly these exports.

export const ENGINE_NAME = "pr-hero";
export const ENGINE_VERSION = "0.1.0";

export * from "./dedupe";
export * from "./drafts";
export * from "./findings";
export * from "./pipeline";
export * from "./prompt-set";
export * from "./spec";
export * from "./step-runner";
export * from "./usage";
