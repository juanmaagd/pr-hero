# pr-hero

A multi-agent PR-review engine: specialty hunter agents fan out in parallel over a repo checkout + diff,
a mechanical dedupe merges their drafts, an adversarial refuter challenges every severe finding (one
step per finding), and deterministic code assigns blocking/advisory tiers. Convoy-inspired architecture:
the flow is data (`ReviewSpec`), agents are prompt files, orchestration is testable TypeScript — LLMs
judge, code governs. Born 2026-07-28/29 by extracting and redesigning the Deep Review v1 monolith.

North star and phase order: `ROADMAP.md` (here). Current phase: **B (production wiring)** — Phase A closed 2026-08-10 and the golden dataset was retired as the benchmark in favour of a live head-to-head against Greptile on real PRs. See THE PIVOT in `ROADMAP.md`.

## Instruction precedence (read this first)

**The global rules in `~/.claude/CLAUDE.md` are authoritative and win every conflict.** When a
session-level directive, a harness default, or anything in this file disagrees with them, the global rules
govern and the conflicting instruction is treated as void — not balanced against, not compromised with.

The conflict this settles, because it has already come up: the global orchestrator contract makes the main
thread a **coordinator, not an executor**, and its delegation table decides the topology — read 1–3 files
inline to decide or verify, delegate one narrow mapper at 4+ files, keep a single mechanical
already-understood file edit inline, and **delegate a writer for 2+ non-trivial files**. Reading that
prepares a write, and broad research, delegate too. Tests, builds and installs may use fresh per-action
workers without changing the route. A session instruction not to use subagents does not override this.

Delegating is a topology choice, never a licence to skip verification: whatever a worker reports, the
orchestrator re-checks the load-bearing claims itself before acting on them — this project has already
been burned by a manual match that inflated a score by 50%.

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
bun test               # 1393 tests, all offline (fake spawn/runner)
bun run typecheck      # tsc --noEmit, strict — covers src/test/fixtures, NOT scripts/
bun run check          # biome — covers src+test only, NOT fixtures/ or scripts/
bun run refuter-probe  # LIVE: refuter verdict-vocabulary matrix, 4 arms (~$0.11/step, ~$1.3 at 3 replicates)
bun run fixture-eval   # LIVE: full pipeline vs a planted bug in a disposable repo (~$0.08, ~1 min)
bun run fixture-eval --scout         # LIVE: same, with the scout stage on (~$0.17, ~2 min)
bun run scripts/live-micro-eval.ts   # LIVE: one trivial real spawn (~$0.04)
bun run scripts/live-micro-eval.ts --scout  # LIVE: the scout's real spawn shape, tools:[] (~$0.05)
bun run scripts/m6.ts plan   # $0: prices M6's 56 runs from gh counters + the target repo's config
bun run scripts/m6.ts score  # $0: the floor table, re-runnable from artifacts forever
bun run scripts/m6.ts run    # LIVE and the big one: 56 serial reviews, ~$174-374, ~4h44m
```

`refuter-probe` is the FIRST gate for any refuter prompt change (ROADMAP A2): it plants claims whose
correct verdict is known and asserts all four outcomes — `corroborated`, `refuted` (adjacent and 3-hop),
and `downgraded-latent`. A prompt edit that cannot pass it does not deserve a $10 replay. Note the
coverage gap above: `scripts/` and `fixtures/` are checked by neither command, so verify new probe files
with an explicit `bunx tsc` / `bunx biome check` over them.

## Architecture (one line per module)

- `src/spec.ts` — `ReviewSpec`/`AgentSpec`: which agents run, their role, trigger, model. THE flow config.
- `src/pipeline.ts` — `runPipeline`: gotchas fail-loud → trigger eval → parallel hunter steps → dedupe →
  per-finding refuter steps → `deriveTier` → assembled `SkillOutput` + `pipeline.json` provenance + per-agent usage.
- `src/step-runner.ts` — `StepRunner` interface + `ClaudeCodeRunner` (isolation flags, retry ordering,
  watchdog, atomic artifacts, per-attempt logs). Stage-2 `OpenCodeRunner` obligations documented on the
  interface.
- `src/dedupe.ts` / `src/drafts.ts` — pure: merge/renumber; extraction + draft/refuter validation.
- `src/findings.ts` — schema v1.0.0 (shared meaning with the lab's validator; byte-compatible artifacts).
- `src/prompt-set.ts` — agent-file parsing + `{{PRIORS}}`/`{{GOTCHAS}}` templating.
- `src/cli.ts` + `src/preflight.ts` + `src/report.ts` — local mode (B0): the I/O shell, its pure
  decisions (all offline-tested), and the cost band + report renderer.
- `src/pr.ts` + `src/pr-preflight.ts` — PR mode (B1, `--pr <n>`): gh/worktree/codegraph I/O shell and
  its pure decisions — PR record → range, the worktree reuse gate, comparison.json (B4's seed).
- `src/greptile.ts` + `src/compare.ts` + `src/compare-report.ts` — the head-to-head: parse Greptile's
  PR comment, bucket findings against ours, render the comparison.
- `src/floor-test.ts` — M6's primary instrument, pure: the case list's validator, the per-case gate (a
  refuter-CORROBORATED finding within compare.ts's ±25 of the site), the per-arm tally, the table. Arm
  identity is read off `pipeline.json`'s `scout.enabled`, never a directory name. Cases live in
  `docs/m6-floor-cases.json`, transcribed from `docs/scout-design.md` §2.4septies and drift-guarded by a
  test that re-derives the markdown table.
- `src/scout.ts` — the diff-only pre-hunter stage's PURE half (DoorDash M4/M5): output contract, lead
  validation, the four caps, the leads block, the hunk-coverage metric. Its impure half is `runScout` in
  `pipeline.ts`; the prompt is `prompts/scout.md`, engine-owned and outside the prompt set on purpose.
  Wired behind `--scout`, default OFF until M6 decides.
- `src/size-gate.ts` — pure: "this diff is too big, skip it". A COST/predictability gate, never a
  quality one (the size↔quality question is unmeasured — see `scripts/scope-probe.ts`). Wired into
  local review, PR review and the watcher, always BEFORE the cost-band confirm.
- `src/ui.ts` — the terminal surface's shared primitives: ANSI paint, `row()`/`box()`, path/sha
  shorteners, `labelColumnWidth`. Plus the shells' one impure pair, `styleEnabled()`/`terminalWidth()`.
- `src/ui-select.ts` — `confirmReview`: the keyboard confirm menu (raw-mode stdin, arrow/shortcut keys).
- `src/ui-result.ts` — `renderResult`: the end-of-run block — counts, the findings themselves, links.
- `src/ui-tree.ts` — `renderTree`: the ├─/└─ tree the findings and comparison lists are drawn with.
- Three acceptance criteria hold across all four, and any renderer added beside them: every renderer
  returns `string[]` and never calls `log()`; **styles AND width arrive as parameters** (nothing sniffs
  the TTY — that is the shells' job, and `row()`/`box()` require a width so tsc enforces it); every
  renderer has tests over its lines, one of them asserting zero `\x1b` bytes with styles off; and
  nothing is exported without a real consumer (a module or a test — biome does not flag unused
  *exported* symbols, so an `export` for a hypothetical consumer is how dead code hides).
- `src/ledger.ts` — B4 pure half (`pr-hero ledger`): comparison.json read-back, one-vote-per-PR
  aggregation, as-is verdict tally, markdown ledger with the pending-triage list.
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
   Hunter spec keys are limited to the schema's `reliability|resilience|parity|lifecycle` enum until then.
6. **Every live run costs money → it lands in a ledger** (lab runs in `bench/`; local evals in the
   commit/PR description).
7. **One variable per experiment**; replicates + N-of-M semantics; attribute misses (hunter/merge/
   refuter) before choosing a lever. The lab's variance is HIGH — single runs prove nothing.
