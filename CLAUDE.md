# pr-hero

A multi-agent PR-review engine: specialty hunter agents fan out in parallel over a repo checkout + diff,
a mechanical dedupe merges their drafts, an adversarial refuter challenges the severe inferential
findings, and deterministic code assigns blocking/advisory tiers. Convoy-inspired architecture: the flow
is data (`ReviewSpec`), agents are prompt files, orchestration is testable TypeScript — LLMs judge, code
governs. Born 2026-07-28/29 by extracting and redesigning the Deep Review v1 monolith.

North star and phase order: `ROADMAP.md` (here). Current phase: A (graduate the benchmark bar).

## The two sibling folders (load-bearing context)

- **`../deep-review/`** — the LAB. Owns the golden dataset (audited Greptile findings), the bench ledger
  (`bench/METRICS.md`, append-only), the prompt sets (`agents/<set>/`, immutable once scored), the
  scorer, the replay/smoke CLI, and the musive target-repo config. It consumes this engine via
  `"pr-hero": "file:../../pr-hero"` and measures it. Its `CLAUDE.md` gotchas BIND any session that
  touches both repos — above all: **never read `../deep-review/dataset/test.jsonl`** and never edit a
  scored prompt set. Project history: `../deep-review/deep-review-plan.md` + `../deep-review/docs/memory/`.
- **`~/Desktop/convoy`** — the REFERENCE implementation (github.com/Inakitajes/convoy): an orchestration
  harness whose hunter/review pipelines and ops layer are the pattern library for this engine. Study
  notes with file:line refs: `../deep-review/intel/convoy.md`. Read the notes first, the source second.

## Commands

```bash
bun test               # 90 tests, all offline (fake spawn/runner)
bun run typecheck      # tsc --noEmit, strict
bun run check          # biome
bun run fixture-eval   # LIVE: full pipeline vs a planted bug in a disposable repo (~$0.08, ~1 min)
bun run scripts/live-micro-eval.ts   # LIVE: one trivial real spawn (~$0.04)
```

## Architecture (one line per module)

- `src/spec.ts` — `ReviewSpec`/`AgentSpec`: which agents run, their role, trigger, model. THE flow config.
- `src/pipeline.ts` — `runPipeline`: gotchas fail-loud → trigger eval → parallel hunter steps → dedupe →
  refuter batch → `deriveTier` → assembled `SkillOutput` + `pipeline.json` provenance + per-agent usage.
- `src/step-runner.ts` — `StepRunner` interface + `ClaudeCodeRunner` (isolation flags, retry ordering,
  watchdog, atomic artifacts, per-attempt logs). Stage-2 `OpenCodeRunner` obligations documented on the
  interface.
- `src/dedupe.ts` / `src/drafts.ts` — pure: merge/renumber; extraction + draft/refuter validation.
- `src/findings.ts` — schema v1.0.0 (shared meaning with the lab's validator; byte-compatible artifacts).
- `src/prompt-set.ts` — agent-file parsing + `{{PRIORS}}`/`{{GOTCHAS}}` templating.
- `fixtures/` + `scripts/` — the planted-bug eval and live micro-eval.

## Rules that outrank convenience

1. **Design before code.** No slice starts without certainty of what and how — grounded in the real code
   and the convoy reference. When a decision is genuinely open, ask Juanma; never code blind.
2. **Full smokes are milestone-only.** Iterate on the offline suites + fixture eval + surgical
   single-tree replays run from the lab. A smoke is ~1h and real money; a fixture eval is a minute.
3. **Port, don't rewrite.** Load-bearing mechanisms carry their WHY comments (each one encodes a paid-for
   failure: the contamination flags, retry ordering, truncated-draft guard, watchdog numbers).
4. **Isolation flags are a threat model, not preferences.** `--strict-mcp-config` + codegraph-only,
   `--setting-sources ""`, no Write/Task/Bash for agents, driver owns all file writes. Tests assert them;
   weakening one requires explicit justification.
5. **Schema compatibility with the lab is sacred** until a coordinated v1.1 bump (tracked in ROADMAP C2).
   Hunter spec keys are limited to the schema's `reliability|resilience|parity` enum until then.
6. **Every live run costs money → it lands in a ledger** (lab runs in `bench/`; local evals in the
   commit/PR description).
7. **One variable per experiment**; replicates + N-of-M semantics; attribute misses (hunter/merge/
   refuter) before choosing a lever. The lab's variance is HIGH — single runs prove nothing.
