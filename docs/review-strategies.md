# Proposal: Named Review Strategies

This document proposes the missing product layer: **one named, selectable strategy per launch**. It is a design, not an implementation plan. Nothing here changes `execute()`, isolation flags, schema v1.0.0, or the scout's bias-not-replace contract.

Status: **AWAITING RATIFICATION.**

---

## Decision Summary

| Area | Decision |
|---|---|
| Unit of choice | One **strategy** per launch. Never two strategies in one run. |
| What a strategy is | A named occupancy of the **fixed** DAG: which hunters/refuter, scout on/off, summarizer, hop budget |
| What a strategy is not | A generic workflow engine, a second pipeline, or a replacement for prompt sets |
| Hunter vs scout | Distinct **strategies**. Scout is a **stage** inside `scout-led`, not a competing findings engine |
| Deep review | Scout on + larger hop budget, measured. Not "more specialist hunters" |
| Prompt sets | Stay independently selectable. A strategy may default an `agentsDir`; `--agents` still wins |
| Engine DAG | Unchanged: optional scout → parallel hunters → dedupe → refuter → `deriveTier` |
| Create-today path | Add a registry entry in code. Do not edit `pipeline.ts` |
| Select-later path | `--strategy <id>` and `strategy` in config. Flag > config > default |
| Default | Byte-identical to today's CLI: `localReviewSpec()`, scout off |
| Provenance | Record `strategy.id` **and** `prompt_set` separately on every run |
| Schema / C2 | New hunter keys stay blocked until schema v1.1. Strategies do not wait on C2 |
| Refactor | None of the engine. This layer is additive |

---

## Problem

The engine already runs **one** pipeline per launch. What it does not have is a **name** for "which pipeline."

Today a "kind of review" is a pile of orthogonal knobs:

```text
ReviewSpec (hardcoded localReviewSpec in the CLI)
  + agentsDir / --agents
  + --scout
  + summarizer on/off
  + --hop-budget
```

That is fine for one or two modes. It fails the goal:

> Pick **one** strategy at launch. Create a new one without mutating the previous. Experiment fast.

Three concrete pains:

1. **Hunter review and scout review are the same object with a flag.** In the operator's head they are different strategies. In the code, `--scout` mutates the hunter pipeline. There is no way to say "run the scout-led strategy" without composing flags.
2. **Two silent defaults already disagree.** `runPipeline` with no spec uses `defaultReviewSpec()` (no lifecycle hunter). The CLI always injects `localReviewSpec()` (lifecycle included). That split is invisible. A registry would make it two named entries.
3. **Creating a third kind means another flag.** Scout and summarizer already special-case `PipelineInput`. The next idea (`deep`, `light`, a future re-review recipe) becomes combination math, which is the opposite of easy experiments.

---

## Target Shape

Three layers. Only the middle one is new.

```text
┌─────────────────────────────────────────────────────────┐
│  1. ENGINE DAG  (rare to change, code, robust)          │
│     scout? → hunters ∥ → dedupe → refuter? → tiers      │
│     plus optional summarizer in parallel with hunters   │
└─────────────────────────────────────────────────────────┘
                         ▲ occupies
┌─────────────────────────────────────────────────────────┐
│  2. STRATEGY  (the missing layer — named, selectable)   │
│     hunters | scout-led | light | deep | …              │
│     which slots are filled, with which spec             │
└─────────────────────────────────────────────────────────┘
                         ▲ parameterised by
┌─────────────────────────────────────────────────────────┐
│  3. PROMPT SET  (already exists — directories)          │
│     baseline / arm-a / slice3b-lifecycle-v6-clean / …   │
│     the bytes. Independently A/B'd. Fingerprinted.      │
└─────────────────────────────────────────────────────────┘
```

### Why three layers, not one

A strategy that *owned* the prompt bytes would make every experiment a multi-variable smear: changing wording would look like changing strategy. Project rule 7 forbids that. M6's claim — "both arms ran the same prompt set" — is a prompt-set fact, not a strategy fact.

A prompt set that *owned* the DAG occupancy would make `--scout` a prompt-set change and re-fingerprint hunters that did not move. That is why scout already lives outside `ReviewSpec` (`docs/scout-design.md` §3.7, `PipelineInput.scout`).

The engine DAG is not a strategy either. Scout-before-hunters is a **correctness** constraint (hunters consume leads). It is not an order the operator sets.

### Hunter strategy vs scout strategy

These are two strategies that occupy the same DAG differently:

| id | Spec | Scout slot | What the operator is choosing |
|---|---|---|---|
| `hunters` | `localReviewSpec()` | empty | Today's production review. Control arm. |
| `scout-led` | same spec | on, engine prompt | Hunters still run; scout **biases** them. Treatment arm. |

Scout does **not** replace hunters and does **not** emit findings. That is `docs/scout-design.md` §3.4–§3.5, and it stays. "I pick the scout strategy" means "I pick the recipe whose scout slot is filled," not "I skip hunters."

A scout-only review (no hunters, scout produces the report) is **out of scope**. It cannot satisfy the findings contract, and it is the replace-topology §3.4 refused.

### Deep review

DoorDash's v1 was "more narrow specialists." They abandoned it. C2's write-up already corrected the same mistake (`ROADMAP.md` C2, 2026-08-16): depth is scout-on plus a larger hop budget, **measured**, not assumed.

So `deep` is a third strategy **when we have evidence**, not a fan-out of new roles:

| id | vs `hunters` | vs `scout-led` |
|---|---|---|
| `deep` | scout on, higher `hopBudget` | same scout, more hops |

New specialties (`security`, `performance`) wait on C2. They become new hunter **keys** inside some strategy's spec, not a reason to fork the engine.

### Light review

A valid strategy: drop a hunter (e.g. no lifecycle) and/or drop the refuter. `ReviewSpec` already allows both (`hunterCount >= 1`, `refuterCount <= 1`). That is a registry entry, not an engine change.

---

## Proposed Type (design, not code)

```ts
export interface ReviewStrategy {
  id: string;          // stable, recorded on the run
  label: string;       // plan UI
  spec: ReviewSpec;    // hunters + optional refuter
  scout?: { promptPath: string; model?: string };      // absent = off
  summarizer?: { promptPath: string; model?: string }; // absent = caller default
  hopBudget?: number;  // absent = engine default
  agentsDir?: string;  // optional default; --agents still wins
}
```

A registry is a map `id → ReviewStrategy`. Unknown id fails loud.

Creating a new strategy **from code, today-shaped:**

1. Add one object to the registry.
2. Reuse an existing spec, or write a new `ReviewSpec` literal (keys still inside the v1.0.0 hunter enum).
3. Fill or leave empty the scout / summarizer / hop-budget slots.
4. Point `agentsDir` at a new prompt-set folder if the bytes change; or leave it unset and reuse the current set.

Do not edit `execute()`. Do not add a fifth `PipelineInput` flag for the next idea.

The first entries **name what already exists**, they do not change behaviour:

| id | Meaning today |
|---|---|
| `hunters` | CLI default: `localReviewSpec()`, scout off |
| `lab` | `defaultReviewSpec()` (no lifecycle) — what `runPipeline` uses when no spec is passed |
| `scout-led` | `hunters` + `PipelineInput.scout` set — what `--scout` already does |

---

## Requirements

### Operator

- **R1.** One launch runs exactly one strategy.
- **R2.** Creating strategy B does not mutate strategy A.
- **R3.** The default strategy is byte-identical to today's CLI review (same spec, scout off, same step names, same `per_agent` keys).
- **R4.** Selecting a strategy is one id, not a combination of flags. Phase 2 surface: `--strategy <id>` and config `strategy`.
- **R5.** The plan prints the strategy id. An unknown id is a hard error.

### Experimentation

- **R6.** Prompt set remains an independent variable. Same strategy + different `--agents` is a legal A/B. Same prompt set + different strategy is a legal A/B.
- **R7.** A run artifact records both `strategy.id` and `prompt_set.{name,sha256}`. Neither is inferred from the other.
- **R8.** Two strategies that are meant to isolate one variable (M6: `hunters` vs `scout-led`) must differ by that variable alone. The registry is the place that constraint is visible.

### Creation (code now, CLI later)

- **R9.** Adding a strategy that occupies existing slots is a registry entry. `pipeline.ts` does not change.
- **R10.** A strategy's spec is validated with `validateReviewSpec`. Its `agentsDir` (resolved) must still pass `agentsDirProblems` (every named file present, no extra agent files).
- **R11.** Engine-owned prompts (scout, summarizer) stay out of the prompt-set directory and out of the fingerprint. Unchanged from today.

### Robustness

- **R12.** Isolation flags, `deriveTier`, dedupe, gotchas fail-loud, and schema v1.0.0 are **not** strategy knobs.
- **R13.** Scout-led still cannot emit findings. Leads still bias; they still do not replace the hunter scan (`docs/scout-design.md` §3.4).
- **R14.** Precedence is declared per knob, not "repo wins" by default:

  | Knob | Who wins |
  |---|---|
  | `--strategy` / config `strategy` | flag > config > `hunters` |
  | `--agents` | flag > strategy.agentsDir > config `agents_dir` > env (today's resolve, with strategy inserted) |
  | `--model` | flag wins every step (existing JD rule) |
  | `--hop-budget` | flag > strategy.hopBudget > engine default |
  | `--scout` | Phase 1: kept as sugar for `scout-led`. Phase 2: if both `--strategy` and `--scout` are set and they disagree, fail loud — do not compose |

- **R15.** `lab` vs `hunters` (the two existing specs) become named. Callers stop relying on "forgot to pass spec."

---

## Non-goals

- A DAG editor, YAML workflows, or arbitrary stage order. Scout-before-hunters stays code.
- Running two strategies in one launch (ensemble / A-B inside one PR). One launch, one strategy. Compare across runs.
- Scout-only reviews that skip hunters.
- New hunter keys before C2.
- Putting scout or summarizer into `ReviewSpec.role` (would re-fingerprint prompt sets).
- Implementing in this document's session.

---

## Phasing

| Phase | What lands | What does not |
|---|---|---|
| **0 — this doc** | Requirements, vocabulary, ratification | Code |
| **1 — registry in code** | `ReviewStrategy` map. CLI default **is** `hunters`. `--scout` internally selects `scout-led`. Offline tests: default byte-identical to today | New operator UX |
| **2 — selector** | `--strategy <id>`, config key, plan row, `pipeline.json` field | New stage kinds |
| **3 — more recipes** | `light`, measured `deep`, anything that fits existing slots | C2 keys, new stage kinds |
| **C2 (separate)** | New specialties as new spec keys inside some strategy | Not a strategy-layer problem |

Phase 1 is legal to land during the DoorDash track: it does not change what the engine finds if `hunters` / `scout-led` are exactly today's two behaviours. That is the same class as reporting/infra in `ROADMAP-DOORDASH.md` ("may land at any time"). Phase 2 is operator surface and can wait until after M6 if we want the A/B to keep using `--scout`.

---

## How a new experiment looks

**Prompt wording (one variable):** keep `--strategy hunters`, point `--agents` at a new folder. Old folder untouched.

**Scout vs not (one variable):** same `--agents`, `--strategy hunters` vs `--strategy scout-led`. This **is** M6.

**Cheaper review:** `--strategy light` (fewer hunters). Own experiment, own control — do not mix with a prompt-set change.

**Deeper review (after evidence):** `--strategy deep`. Own experiment. Do not add hunter roles to "make it deep."

---

## Open Questions (need Juanma)

1. **Name.** This doc uses `strategy` because that is the word in the request. Alternatives: `recipe`, `profile`. The CLI flag follows the name.
2. **Scout-led = hunters + scout, not scout instead of hunters.** This doc treats that as load-bearing (aligned with §3.4). Confirm.
3. **Does a strategy pin `agentsDir`?** Recommendation: optional default, `--agents` always wins, so prompt-set A/Bs stay one-variable. Confirm.
4. **When to build.** Recommendation: Phase 1 (registry) whenever; Phase 2 (CLI) after M6 or in parallel as sugar over `--scout`. Confirm relative to launch fundamentals (C4, C5, item 7, canonical store).

---

## Next Step

Ratify the Decision Summary and the four open questions. After that, a separate implementation slice can add the registry without touching `execute()`.
