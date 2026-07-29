// Pipeline-as-data: the review DAG is a validated TS literal, convoy-style —
// creating, removing, or re-wiring subagents is a config change, never an
// engine edit. The engine consumes a ReviewSpec; defaultReviewSpec() encodes
// EXACTLY the wiring the engine used to hard-code (prose Step 4), so a caller
// that passes nothing gets byte-identical behavior.

import type { Hunter } from "./findings";

// A conditional hunter's trigger. `string[]` is a glob/contains pattern list
// matched against the diff's changed paths with the same parityTriggered
// semantics the parity hunter always used. The `"input"` sentinel means "use
// PipelineInput.parityTriggerPaths" — the trigger PATHS stay lab config
// (deep-review.config.json), only the WIRING ("parity is conditional") lives
// in the spec. Chosen over a second optional field because a union keeps
// "has a trigger" a single presence check.
export type AgentTrigger = string[] | "input";

export interface AgentSpec {
  // Stable id: becomes the per_agent telemetry key and the step-name suffix
  // ("hunter-<key>"; the single refuter step keeps the fixed name "refuter").
  key: string;
  // Agent .md basename inside agentsDir, e.g. "deep-review-reliability.md".
  file: string;
  role: "hunter" | "refuter";
  // Hunters only. Omitted → the hunter always runs. Present → it runs only
  // when any changed path matches (see AgentTrigger).
  trigger?: AgentTrigger;
  // Per-agent model override. Precedence for every step:
  // input.model (CLI --model) > spec.model > agent frontmatter model.
  model?: string;
}

export interface ReviewSpec {
  agents: AgentSpec[];
}

// Findings schema v1.0.0 stamps `hunter` with the producing step's key, and
// its Hunter enum is closed ("reliability" | "resilience" | "parity") — the
// SCHEMA is the constraint here, not the engine. Until schema v1.1 lifts the
// enum, hunter keys must stay inside it so tonight's artifacts keep
// validating; the spec layer is otherwise already key-agnostic.
const SCHEMA_HUNTER_KEYS: Hunter[] = ["reliability", "resilience", "parity"];

export class ReviewSpecValidationError extends Error {}

function must(condition: boolean, message: string): void {
  if (!condition) throw new ReviewSpecValidationError(message);
}

export function validateReviewSpec(candidate: unknown): ReviewSpec {
  must(
    typeof candidate === "object" && candidate !== null,
    "review spec must be an object",
  );
  const spec = candidate as Record<string, unknown>;
  must(Array.isArray(spec.agents), "spec.agents must be an array");
  const agents = spec.agents as unknown[];
  const keys = new Set<string>();
  let hunterCount = 0;
  let refuterCount = 0;
  agents.forEach((entry, i) => {
    must(
      typeof entry === "object" && entry !== null,
      `agents[${i}] must be an object`,
    );
    const a = entry as Record<string, unknown>;
    must(
      typeof a.key === "string" && a.key.length > 0,
      `agents[${i}].key required`,
    );
    must(!keys.has(a.key as string), `agents[${i}].key duplicates "${a.key}"`);
    keys.add(a.key as string);
    must(
      typeof a.file === "string" && a.file.length > 0,
      `agents[${i}].file required`,
    );
    must(
      a.role === "hunter" || a.role === "refuter",
      `agents[${i}].role must be hunter|refuter`,
    );
    must(
      a.model === undefined ||
        (typeof a.model === "string" && a.model.length > 0),
      `agents[${i}].model must be a non-empty string when present`,
    );
    if (a.role === "hunter") {
      hunterCount++;
      must(
        SCHEMA_HUNTER_KEYS.includes(a.key as Hunter),
        `agents[${i}].key "${a.key}" is not a findings-schema v1.0.0 Hunter ` +
          "enum value (reliability|resilience|parity); schema v1.1 will " +
          "lift this",
      );
      must(
        a.trigger === undefined ||
          a.trigger === "input" ||
          (Array.isArray(a.trigger) &&
            (a.trigger as unknown[]).every(
              (p) => typeof p === "string" && p.length > 0,
            )),
        `agents[${i}].trigger must be "input" or a string array`,
      );
    } else {
      refuterCount++;
      must(
        a.trigger === undefined,
        `agents[${i}] is a refuter and cannot carry a trigger`,
      );
    }
  });
  must(hunterCount >= 1, "spec needs at least one hunter");
  must(refuterCount <= 1, "spec allows at most one refuter");
  return spec as unknown as ReviewSpec;
}

// EXACTLY today's hard-coded wiring (prose Step 4): reliability + resilience
// unconditional, parity conditional on the lab's parityTriggerPaths (the
// "input" sentinel), one refuter. runPipeline without an explicit spec uses
// this, which is what keeps the default engine behavior byte-stable.
export function defaultReviewSpec(): ReviewSpec {
  return {
    agents: [
      {
        key: "reliability",
        file: "deep-review-reliability.md",
        role: "hunter",
      },
      { key: "resilience", file: "deep-review-resilience.md", role: "hunter" },
      {
        key: "parity",
        file: "deep-review-parity.md",
        role: "hunter",
        trigger: "input",
      },
      { key: "refuter", file: "review-refuter.md", role: "refuter" },
    ],
  };
}
