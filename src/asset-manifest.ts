/// <reference path="./assets.d.ts" />

// Authoritative asset manifest for pr-hero.
// Every packaged asset is imported using `with { type: "file" }` so Bun's compiler embeds them.
// compile.assets is a silent no-op on Bun 1.3.14 — this manifest is the permanent mechanism.

import lifecyclePrompt from "../prompts/default/deep-review-lifecycle.md" with {
  type: "file",
};
import parityPrompt from "../prompts/default/deep-review-parity.md" with {
  type: "file",
};
import reliabilityPrompt from "../prompts/default/deep-review-reliability.md" with {
  type: "file",
};
import resiliencePrompt from "../prompts/default/deep-review-resilience.md" with {
  type: "file",
};
import refuterPrompt from "../prompts/default/review-refuter.md" with {
  type: "file",
};

import scoutPrompt from "../prompts/scout.md" with { type: "file" };
import summarizerPrompt from "../prompts/summarizer.md" with { type: "file" };
import triageAdjudicator from "../skills/pr-hero-triage/adjudicator.md" with {
  type: "file",
};
import triageSkill from "../skills/pr-hero-triage/SKILL.md" with {
  type: "file",
};

export const BUNDLED_AGENT_FILES: Record<string, string> = {
  "deep-review-lifecycle.md": lifecyclePrompt,
  "deep-review-parity.md": parityPrompt,
  "deep-review-reliability.md": reliabilityPrompt,
  "deep-review-resilience.md": resiliencePrompt,
  "review-refuter.md": refuterPrompt,
};

export const SCOUT_PROMPT_PATH = scoutPrompt;
export const SUMMARIZER_PROMPT_PATH = summarizerPrompt;

export const TRIAGE_SKILL_FILES: Record<string, string> = {
  "SKILL.md": triageSkill,
  "adjudicator.md": triageAdjudicator,
};
