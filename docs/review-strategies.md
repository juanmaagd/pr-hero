# Proposal: Named Review Strategies

This document proposes the missing product layer: **one named, selectable review pipeline per launch**, Convoy-shaped but findings-preserving. It is a design, not an implementation plan.

Status: **DEFERRED — future work.** Written 2026-08-18. **Do not implement on the launch / DoorDash track.** Roadmap: After layer in `ROADMAP.md`. Informed by Convoy (`~/Desktop/convoy`, notes in `../deep-review/intel/convoy.md`).

**Frozen this session (Juanma, 2026-08-18):** document it, do not build it now. Obstacle 1 (no registry) is acceptable missing work and sorteable later. Obstacle 3 (closed hunter enum) is a coordinated C2 bump, not a veto — security / React / clean-code hunters are desired. Obstacle 2 (typed findings vs markdown bus) is why this engine exists; a full markdown migration is possible as a later product call; hybrid (keep JSON contracts, attach prior markdown as context) is the only migration that still emits `findings[]`. Per-pipeline, per-step models are in scope when this lands. One launch = one named pipeline.

---

## Decision Summary

| Area | Decision |
|---|---|
| Goal | Approach Convoy’s named pipelines without turning pr-hero into a free workflow engine |
| Invariant | Every review pipeline **must produce findings**. ≥1 hunter. Scout-only is illegal |
| Unit of choice | One **pipeline** per launch (Convoy: `-p`). Never two in one run |
| What we copy from Convoy | Named recipes that coexist; a step list as data; `parallel` for hunter fan-out; fail-loud resolve; frozen plan; selector later |
| What we refuse from Convoy | Markdown as the currency between steps; LLM merge instead of `dedupe.ts`; `reports: all` feeding anything to anything; writable agents in a review; nesting parallel |
| What a pipeline is | A named list of **kinded** steps (`scout`, `hunter`, `refuter`, `summarizer`) plus engine glue that is **not** declared |
| Engine glue (never a YAML step) | Gotchas fail-loud, mechanical dedupe, `deriveTier`. Skipping them cannot be expressed |
| Hunter vs scout | Distinct pipelines. Scout is a kinded step that **biases** hunters, not a findings engine |
| Prompt sets | Independent of pipeline id. `--agents` still wins. Fingerprint recorded separately |
| Default | Byte-identical to today’s CLI: `localReviewSpec()`, scout off |
| Models | First-class per step, per pipeline. Hunters opus in A, grok in B; refuter sonnet — that is a pipeline fact, not a global flag |
| How we don’t break it | Closed kind enum + a resolver that rejects illegal graphs (Convoy’s `checkPipelineResolves` idea) |
| Refactor | None of isolation flags or schema. Additive registry, then a kinded list. `execute()` gains a resolver, not a DAG interpreter |

---

## Problem

pr-hero already runs one pipeline per launch. It does not have a **name** for which pipeline, and it does not let you declare a new one as data.

Convoy does. `hunter`, `review`, `ultra-refine`, `implement` are TS/YAML literals. You pick with `-p`. A project file can add or shadow one. That is the flexibility this doc wants, scoped to **reviews that still emit `findings[]`**.

Copying Convoy blindly would break us: their steps pass markdown files into the next LLM; merge is a judge prompt; there is no schema, no `deriveTier`, no isolation-as-threat-model. We need their *registry and step list*, not their *currency*.

---

## Obstacles (three different kinds — don’t mix them)

There is no single wall. Mixing them is how this looks “impossible.”

### 1. Absence — we never built Convoy’s product layer

Nothing in the runner forbids named recipes, per-step models, or picking one pipeline per launch.

| Missing piece | Where |
|---|---|
| No pipeline registry | CLI always calls `localReviewSpec()` (`cli.ts`) |
| No `-p` / `--strategy` | flags are `--scout`, `--agents`, `--model` instead |
| `execute()` does not read a step list | the occupancy is hardcoded: scout → hunters → dedupe → refuter |
| Scout / summarizer are `PipelineInput` flags | not entries in `ReviewSpec` |

**This is the obstacle for “choose hunters-opus vs scout-led vs grok hunters.”** It is solved by adding a registry, not by changing how findings work. `AgentSpec.model` already exists.

### 2. Contract — the engine is a typed state machine, Convoy is a file bus

Convoy step: run a prompt → write `reports/<step>.md` → the next prompt attaches those files. Any agent can follow any agent. Merge is another prompt (`hunter-report`).

pr-hero step: run a prompt → **parse a typed object** → only that type may enter the next *code* stage.

```text
hunter  → HunterDraft     → (code) mergeAndDedupe
refuter → RefuterOutcome  → (code) deriveTier
scout   → ScoutLead[]     → string block on the hunter prompt
                          → never findings[]
```

`execute()` is not an interpreter of “whatever the YAML said next.” It is the only place those arrows exist. That is why a Convoy `reports: all` graph cannot be dropped in: there is no socket that means “this markdown becomes a finding.”

**Why we did it this way** (not taste — consumers and paid failures):

- **Tiers are code.** Blocking vs advisory is `deriveTier` over fields. A markdown paragraph cannot block a merge unless another LLM (or a brittle parser) re-derives the same decision. The AudioTrimmer incident is why severity/evidence/verdict live in data: a prompt-only filter left the refuter idle on 26/26 blocking findings.
- **The lab scores structure.** `findings.json` is byte-talk with `deep-review`’s validator and scorer. Path, line, hunter, claim, `dedupe_key` are how a miss is attributed. Markdown has none of that unless we compile it back into the same schema — at which point we still have obstacle 2, just later.
- **The driver owns writes.** Agents cannot Write. The JSON object is what the runner `parse`s before anything hits disk. A “visible output is the report” Convoy step skips that gate.
- **Isolation and attribution.** The driver stamps `hunter` on every draft. A self-reported name in prose is how attribution dies.

**Is a markdown migration possible?** Yes. It is a product migration, not a flag.

| Move | What you get | What you pay |
|---|---|---|
| **Full Convoy bus** | Any step feeds any step via files | New merge, new “what is a finding”, new comparison/ledger/scorer, or those tools go away |
| **Hybrid (recommended if we move)** | Keep the JSON contract at hunter/refuter/scout. Optionally attach prior step markdown as *context* (scout leads already do this) | Authoring looks more like Convoy; findings stay typed |
| **Stay** | Current guarantees | Step list must be kinded so it only expresses this machine |

Full markdown is viable in the same sense Convoy is viable: you are building their product. Hybrid is the only migration that does not throw away `findings[]`.

### 3. Schema lock — hunter keys are a closed enum (C2)

This is **not** a philosophy that forbids security / React / clean-code hunters. Those specialties are exactly what C2 is for, and they are a good reason to do the bump.

What C2 actually is: a **coordinated v1.1** so four copies of the enum stay in sync (`src/findings.ts` type + runtime `HUNTERS`, `src/spec.ts` `SCHEMA_HUNTER_KEYS`, and the lab mirrors in `deep-review/runner/findings.ts`). Until that bump, a finding with `hunter: "security"` fails validation on both sides and old artifacts/scorer rows disagree with new ones. Rule 5 is lab compatibility, not “we will never have more hunters.”

**Sorteable, with a bump, not a rewrite:**

- New keys (`security`, `react`, `clean-code`, …) → open the enum both repos, migrate the validator, then those hunters are just `AgentSpec` entries in a pipeline.
- Dual-model *same* key in one run (`reliability` on opus and grok) → still needs a second key (`reliability-b` or a `models: []` field) plus a merge rule: two copies of the same prompt agreeing is **not** independent corroboration (`ROADMAP.md` C2). That rule is the real design work; the enum is the mechanical lock.

DoorDash’s warning is separate: **do not use “more specialists” as the definition of a deep review.** Having a React hunter is fine. Assuming depth = fan-out width is what they measured and abandoned.

The earlier write-up overstated this as an impassable wall. It is a version gate. It should not block designing named pipelines that will grow new keys the day C2 lands.

A related but smaller lock: putting scout *inside* `ReviewSpec.role` would re-fingerprint the prompt set (M6’s one-variable rule). Scout stays a pipeline slot outside the agents dir — same as today — so this does not block named pipelines.

### What to solventar vs what to keep

| If the idea is… | The real obstacle | Move |
|---|---|---|
| Pick / create recipes, pin models | **#1 Absence** | Registry + selector. Sorteable now |
| Security / React / clean-code hunters | **#3 Schema** | C2 bump both repos. Sorteable; not a veto |
| Same hunter, two models, one run | **#3** + merge semantics | C2 + an explicit corroboration rule |
| Markdown instead of typed findings | **#2 Contract** | Possible as a product migration; hybrid if we still want `findings[]` |
| Any step wired to any step | **#2** | Kinded list + resolver, or full Convoy (see table above) |

---

## What Convoy actually is (so we copy the right thing)

A Convoy pipeline is **sequential batches**. A batch is one agent, or `parallel: [agents]`. Wiring is `reports: previous | all | none | [names]`. Constraints already exist: no nested parallel, no human inside parallel, no forward `reports`, fail at resolve not mid-run.

It is **not** GitHub Actions. It is a list with one optional fan-out per batch.

pr-hero today is one of those recipes, hardcoded in `execute()`: optional scout → parallel hunters → (code: dedupe) → optional refuter → (code: tiers). Scout and summarizer are extra flags, not list entries. There is no `-p`.

---

## Target: Convoy’s shape, pr-hero’s contracts

```text
operator picks one id
        │
        v
┌───────────────────────────────────────────────┐
│  PIPELINE (data, named, coexists)             │
│  steps: scout? → parallel hunters → refuter?  │
│  + optional summarizer                        │
└───────────────────────────────────────────────┘
        │ resolve (fail loud if illegal)
        v
┌───────────────────────────────────────────────┐
│  ENGINE GLUE (code, not declarable)           │
│  gotchas → … → dedupe → … → deriveTier        │
│  isolation flags, schema v1.0.0               │
└───────────────────────────────────────────────┘
        │
        v
   findings.json   (always)
```

### Kinded steps (closed enum)

| kind | Output contract | Parallel? | May be omitted? |
|---|---|---|---|
| `scout` | `ScoutLead[]`, never a finding | no (one) | yes |
| `hunter` | `HunterDraft` → stamped into drafts | **yes, with other hunters** | **no: ≥1 required** |
| `refuter` | per-finding verdict | no (one, after merge) | yes |
| `summarizer` | `RunSummary`, cosmetic | with hunters, as today | yes |

A new kind (`counsel`, `advisor`, re-review adjudicator) is an **engine change once**: new output type, new validator, one new resolver rule. After that, pipelines just turn the slot on. That is how scout landed. It is not a YAML free-for-all.

Convoy’s `advisor` is **not** a pipeline step. It is a side consult during a writing phase. If we ever want that, it is a per-step flag, not a reason to open the kind enum.

### Engine glue — why findings survive

These cannot appear in a pipeline list, so they cannot be forgotten:

1. **Gotchas** — fail-loud before any step.
2. **Dedupe** — always between hunters and refuter. Drafts do not skip it via `reports:`.
3. **`deriveTier`** — always after refuter (or after hunters if no refuter). Blocking vs advisory stays code.

That is the load-bearing difference from Convoy. Their next step *reads files*. Ours next step *consumes typed output*. Hunters always feed dedupe. Dedupe always feeds refuter-or-tiers. No pipeline author can rewire that.

### Resolver rules (illegal graphs fail before spend)

Same job as Convoy’s `checkPipelineResolves`:

- ≥1 `hunter`. Zero hunters = not a review.
- If `scout` is present, it is before every hunter.
- `parallel` contains only `hunter` kinds.
- At most one `scout`, one `refuter`, one `summarizer`.
- If `refuter` is present, it is after all hunters. The engine inserts dedupe in between; the list cannot name dedupe.
- Unknown kind, unknown hunter key (until C2), dangling prompt file: fail at load.
- No nested parallel. No forward wiring.

A pipeline that wants “scout instead of hunters” does not resolve. Findings stay undefeated.

### Models (per pipeline, per step)

This is already in the engine, unused as a recipe knob. `AgentSpec.model` and the scout/summarizer slots already take a model. Precedence today (`pipeline.ts` `resolveModel`):

```text
CLI --model  >  step/spec model  >  prompt frontmatter
```

Named pipelines make that the interesting layer: **the pipeline pins models**. Two pipelines can share the same hunter files and differ only by who runs on opus, grok, or sonnet.

| Want | How | Blocked? |
|---|---|---|
| Pipeline `hunters-opus`: all hunters opus, refuter sonnet | each hunter `model: "opus"`, refuter `model: "sonnet"` | no |
| Pipeline `hunters-grok`: same spec, grok hunters, sonnet refuter | another registry entry, different `model` fields | no |
| Scout haiku, hunters sonnet, refuter opus | each kind’s `model` field | no |
| **One run**, reliability on sonnet **and** grok (Convoy `models: [a, b]`) | needs two hunter keys (`reliability`, `reliability-b`) | **yes, until C2** |

The last row is Convoy’s dual-model fan-out *inside one pipeline*. Distinct from “this pipeline vs that pipeline use different models.” We want the second now; the first waits on schema v1.1 and a merge-semantics decision (two models on the same prompt are not independent corroboration — `ROADMAP.md` C2).

`--model` remains a **deliberate smear**: it overrides every step. Use it to force a whole run onto one model for a cost test. Do not use it as how recipes declare mix-and-match; that lives on the pipeline.

`pipeline.json` / findings telemetry already have per-agent model via `resolveModel`. Phase 1 must record the pipeline-pinned models so an A/B of `hunters-opus` vs `hunters-grok` is attributable.

### First named pipelines (today’s behaviour, named)

| id | Steps | Notes |
|---|---|---|
| `hunters` | parallel local hunters + refuter | CLI default. Scout off |
| `lab` | `defaultReviewSpec()` (no lifecycle) | what `runPipeline` uses if no spec is passed |
| `scout-led` | scout → same hunters + refuter | today’s `--scout` |

Creating a new one, Convoy-style, is adding another list that still passes the resolver — not editing `execute()` for each idea.

---

## Steal / refuse

| Convoy | pr-hero |
|---|---|
| `-p hunter` selector | later `--strategy` / `--pipeline` (name TBD) |
| `pipelines:` in config, shadow built-ins | yes, after the registry exists |
| `parallel: []` | hunters only |
| `reports: previous\|all\|none\|[names]` | **no.** Typed contracts + engine glue |
| Markdown report as step output | JSON contracts we already have |
| LLM consensus (`hunter-report`) | `dedupe.ts` + refuter + `deriveTier` |
| Any agent in any slot | closed kinds |
| Writable fixer pipelines (`ultra-refine`) | out of scope for this engine (read-only review) |
| Frozen run plan, resume from reports on disk | we already freeze artifacts; keep it |

---

## Proposed types (design, not code)

Phase 1 occupancy (does not change `execute()` control flow):

```ts
export interface ReviewPipeline {
  id: string;
  label: string;
  spec: ReviewSpec; // hunters + optional refuter
  scout?: { promptPath: string; model?: string };
  summarizer?: { promptPath: string; model?: string };
  hopBudget?: number;
  agentsDir?: string; // optional default; --agents wins
}
```

Phase 2 kinded list (Convoy-shaped, resolver-enforced). Equivalent occupancy, authorable as steps:

```ts
type ReviewStep =
  | { kind: "scout"; promptPath: string; model?: string }
  | { kind: "hunter"; key: string; file: string; model?: string }
  | { kind: "parallel"; steps: Extract<ReviewStep, { kind: "hunter" }>[] }
  | { kind: "refuter"; file: string; model?: string }
  | { kind: "summarizer"; promptPath: string; model?: string };

type ReviewPipelineV2 = { id: string; label: string; steps: ReviewStep[] };
```

Phase 1 **is** the first three rows of the table above encoded as occupancy. Phase 2 is the same facts written as a list, so a fourth pipeline does not add a fourth `PipelineInput` flag. Both phases keep findings.

Do not start at V2. A resolver over a kinded list is the piece that can saturate `execute()` if we invent it before the registry even names today’s two modes.

---

## Requirements

### Operator

- **R1.** One launch runs exactly one pipeline.
- **R2.** Creating B does not mutate A.
- **R3.** Default is byte-identical to today’s CLI review.
- **R4.** Selection is one id. Later surface: flag + config. Flag > config > `hunters`.
- **R5.** Unknown id is a hard error. The plan prints the id.

### Findings invariant

- **R16.** Resolve fails unless the pipeline contains ≥1 hunter kind.
- **R17.** Scout output cannot enter `findings[]`. Refuter cannot mint findings. Summarizer cannot mint findings.
- **R18.** Dedupe and `deriveTier` are not expressible as steps and always run.

### Experimentation

- **R6.** Prompt set is independent. Same pipeline + different `--agents` is a legal A/B.
- **R7.** Artifacts record `pipeline.id` (or `strategy.id`) **and** `prompt_set.{name,sha256}`.
- **R8.** `hunters` vs `scout-led` differ only by the scout step (M6’s one variable).
- **R20.** A pipeline may pin `model` on any kinded step. Two pipelines may share prompts and differ only by models. Creating that pair is a registry entry, not an engine change.
- **R21.** Dual-model fan-out of the *same* hunter key in one run is out of scope until C2.

### Creation

- **R9.** Phase 1: add a registry entry. `pipeline.ts` control flow unchanged.
- **R10.** Spec + agents dir still pass `validateReviewSpec` + `agentsDirProblems`.
- **R11.** Scout/summarizer prompts stay engine-owned, outside the prompt-set fingerprint.
- **R19.** Phase 2: a new pipeline is a kinded list that the resolver accepts. Illegal lists never spawn.

### Robustness

- **R12.** Isolation flags, schema v1.0.0, gotchas fail-loud are not pipeline knobs.
- **R13.** Scout biases; it does not replace the hunter scan (`docs/scout-design.md` §3.4).
- **R14.** Precedence as in the table below. `--scout` vs `--pipeline scout-led`: Phase 1 sugar; Phase 2 disagree → fail loud.
- **R15.** `lab` vs `hunters` become named. Callers stop relying on “forgot to pass spec.”

| Knob | Who wins |
|---|---|
| pipeline id | flag > config > `hunters` |
| `--agents` | flag > pipeline.agentsDir > config > env |
| `--model` | one-shot experiment override of **every** step (existing JD rule). A pipeline that pins per-step models is the recipe; `--model` smears them on purpose |
| `--hop-budget` | flag > pipeline.hopBudget > engine default |

---

## Non-goals

- GitHub Actions / arbitrary `needs:` graphs.
- Convoy’s markdown `reports:` bus inside a review.
- Replacing mechanical dedupe with an LLM judge.
- Scout-only or advisor-only “reviews.”
- Writable fixer loops (`ultra-refine`). Different product.
- New hunter keys before C2.
- New kinds (`counsel`) in the first slices — they need a contract first.
- Implementing in this session.

---

## Phasing (so we don’t saturate)

| Phase | Lands | Risk |
|---|---|---|
| **0 — this doc** | Ratification | none |
| **1 — registry** | Name today’s recipes. `--scout` = `scout-led`. Tests: default byte-identical | low; no `execute()` rewrite |
| **2 — selector** | `--pipeline` / `--strategy`, config, `pipeline.json` | low; operator surface |
| **3 — more occupancy** | `light`, measured `deep`, drop-refuter | low; still slots |
| **4 — kinded list** | Convoy step list + resolver. First consumer: the same recipes rewritten as lists, golden-equal to Phase 1 | medium; this is the only phase that touches `execute()` shape |
| **C2 (separate)** | New hunter keys as hunter steps | schema, not pipeline layer |

Phase 1–2 are the Convoy *selector*. Phase 4 is the Convoy *authoring model*, with kinds instead of free agents. Skipping to Phase 4 before 1 is how this saturates the system.

Phase 1 may land during DoorDash if `hunters` / `scout-led` are exactly today’s two behaviours. Phase 4 waits until after M6: it can change spawn shape even when occupancy is equal, and M6 is one-variable.

---

**How a new pipeline is scored (2026-08-19):** n-vs-n on Martian’s public 50, not musive-only. Protocol,
isolation, cost, and the Cal.com-first slice (10 PRs, Surface A scored): `docs/martian-bench.md`. One
pipeline id per arm (this doc’s unit of choice). Run via `skills/martian-bench/SKILL.md`. Do not start a new arm from this file.

---

## How a new experiment looks

**Against Martian (when authorised):** same 50 public PRs, one pipeline id, their judge + stored
vendor reviews. See `docs/martian-bench.md`. Still one variable.

**Prompt wording:** same pipeline id, new `--agents` folder.

**Scout vs not:** `--pipeline hunters` vs `--pipeline scout-led`. M6.

**No refuter / light:** a new list that the resolver still accepts (hunters remain). Own experiment.

**Models only:** same steps and prompt set, different per-step `model`. Own experiment (one variable: model mix). Do not combine with a prompt-set change in the same A/B.

**A genuinely new job (counsel):** first write its output contract and one resolver rule (engine). Then it is just another kind pipelines may include. Not a YAML escape hatch.

---

## Open Questions (parked — answer when the slice is picked up)

1. **Name.** Convoy uses `pipeline`. This conversation used `strategy`. The flag should match (`-p` vs `--strategy`).
2. **Scout-led = hunters + scout, not scout instead of hunters.** Treated as load-bearing in this doc (aligned with `docs/scout-design.md` §3.4). Re-confirm at implementation time.
3. **`--agents` always wins** over a pipeline default, so prompt-set A/Bs stay one-variable.
4. **Authoring depth on first build.** Recommendation: registry + selector first; kinded step list later. Whole item is post-launch as of 2026-08-18.
5. **Kinded-list cap:** only `scout | hunter | refuter | summarizer`, no `reports:` field, no second hunter wave — unless a later product call chooses the markdown bus (Obstacle 2).

---

## Next Step

Nothing in this document is scheduled. When it comes off the After layer: re-read the Decision Summary and Obstacles, then a separate implementation slice for Phase 1 (registry) with default behaviour byte-identical to today's CLI.
