# Domain reorganization

## Objective

Make the latent architecture structural: move `src/`'s 93 flat files into domain
directories, and replace deep relative imports with Node subpath imports (`#domain/file`).

## Problem

`src/` holds 93 files flat at its root. Nine files exceed 1500 lines (`cli.ts` is 7823,
with 122 functions and 66 imports). The architecture is not absent — it is invisible:

- A real pure core already exists: 12 `*-preflight.ts` files, 10,105 lines, zero
  `node:fs|child_process|net|http` imports. The apparent `process.env` hits inside
  `preflight.ts` are comments explaining why those are deliberately NOT hidden dependencies.
- Ports-and-adapters is already carved into `transports/`, `execution/contracts.ts`,
  and `ProviderTransport.execute`.
- An architecture drift-guard already exists at `test/architecture/import-boundaries.test.ts`.

The rules live in a naming convention and in the team's head, not in the filesystem.
So anything without an obvious home lands in the largest file.

The filenames already encode the directories — the hyphen is the slash:
`ui-*` (8), `rereview-*` (6), `ci-*` (6), `*-preflight` (12), `triage-*` (2), `model-*` (2).

## Why subpath imports and not tsconfig `paths`

This package publishes raw TypeScript: `exports["."].import` is `./src/index.ts`, and
`bin/pr-hero.js` imports `../src/cli.ts` directly. The `../deep-review/runner` lab consumes
it via `file:` with its own tsconfig, which has no `paths`.

Verified against all gates with a scratch package plus a `file:` consumer using the lab's
verbatim tsconfig (Bun 1.3.14, tsc 5.x):

| gate | tsconfig `paths` | package.json `imports` (`#`) |
| --- | --- | --- |
| `tsc` inside the repo | pass | pass |
| consumer runtime (`bun run`) | pass | pass |
| **consumer `tsc` (lab tsconfig verbatim)** | **TS2307** | pass |
| `bun build --target=bun` | not applicable | pass, inlined, 0 unresolved |
| `bun build --compile` (release.yml) | not applicable | pass |
| `biome check` / organizeImports | not applicable | stable sort group |

`paths` fails only in the consumer's typecheck — green locally and green at runtime. That
is the same silent, delayed failure mode as the `bunx biome check` gate documented in
CLAUDE.md. The `@` prefix is also rejected outright by the `imports` field: the spec
requires `#`, because `@` already denotes an npm scope.

Wildcard targets must carry the extension: `"#rereview/*": "./src/rereview/*.ts"`.
Without it resolution fails even inside the package itself.

## Scope

Authorized: file moves, the package.json `imports` map, import-specifier updates, and the
layout ratchet test. One domain per PR, each targeting `dev`.

Out of scope: logic changes, new abstractions, per-domain barrel files (they invite import
cycles that Bun tolerates at runtime and that surface as `undefined` at module init).
`src/index.ts` remains the only barrel — it is the contract the lab consumes.

## Constraints

- Moves only. `git mv`, zero logic diff, verified with `git diff -M` showing renames.
- `src/index.ts` keeps its exact public surface. The lab imports only from `"pr-hero"`.
- Internal imports use `#domain/file` — deep and explicit, never a domain barrel.
- Every PR targets `dev` and runs the pr-hero self-review.

## Applicable checks

TDD mode: OFF for this feature, by explicit user decision — a move-only refactor changes no
behavior, so a red-green cycle has nothing to discriminate (`bun test` passes identically
before and after a correct move). Verification is the existing suite plus the ratchet.

Runner: `bun test` (3647 tests, ~33s, 89.80% coverage), `bun run typecheck`, `bun run check`.

Demonstrated gap that motivates the ratchet: a file placed in `src/` root mixing
`child_process`, raw I/O, and a god function passes all 3647 tests and `tsc --noEmit`;
`biome` flags only a string-concatenation style nit. Coverage measures behavior and is
orthogonal to layout, so it cannot detect or prevent this drift.

## Tasks

- [x] **T1** — `rereview/` pilot: 6 files, 2173 lines, 24 referencing files. Not exported
      from `src/index.ts`, so the lab surface is untouched. Validates the mechanism end to end.
- [x] **T2** — Layout ratchet test (`test/architecture/layout.test.ts`), asserting only the
      domains migrated so far. Lands at the end of T1; each later PR appends its domain.
- [x] **T3** — `ui/` (9 files — one more than originally scoped: `ui.ts` itself,
      renamed to `primitives.ts`, was the domain's un-hyphenated 9th member).
- [ ] **T4** — `ci/` (6 files)
- [ ] **T5** — `store/` (store, backfill, gc, metrics, activity + their preflights)
- [ ] **T6** — `model/` (catalog, routing, free-discovery, capabilities, usage, transport-registry)
- [ ] **T7** — `triage/`, `watch/`, `corpus/`, `mcp/`, `compare/`
- [ ] **T8** — `review/` core (pipeline, dedupe, drafts, findings, scout, spec, step-runner…)
- [ ] **T9** — `pr/` (pr, preflight, inline, reverts)
- [ ] **T10** — Split `cli.ts` into a dispatcher plus `commands/<verb>.ts`, `config/`, `ci/`.
      Last, so the pattern is already established.

## Acceptance criteria

- Flat files at `src/` root: 93 today, target ~5.
- Files over 1500 lines: 9 today, target 0.
- Decision modules importing I/O: 0 today — must stay 0.
- The lab (`../deep-review/runner`) typechecks unchanged against the moved engine.

## Progress

T1 and T2 complete on `feat/domain-reorg-01-rereview`, branched from `dev` at ee97552.

### Verified outcomes (T1)

- 12 `git mv` renames confirmed by `git diff --cached -M --summary` at 97-99% similarity:
  6 modules to `src/rereview/`, 6 tests to `test/rereview/`.
- `bun test`: 3649 pass, 0 fail. Baseline was 3647; the +2 are exactly the two ratchet tests.
- `bun run typecheck`: exit 0. `bun run check`: exit 0 over 291 files.
- `bun run build`: succeeds, and `rg '#rereview' dist/*.js` returns 0 — the bundler
  inlines subpath imports. The built `dist/cli.js` runs and prints its usage banner.

### Verified outcomes (T2)

The ratchet was mutation-tested rather than merely observed passing — a test that asserts
nothing also passes. Three mutations, each reverted:

| mutation | result |
| --- | --- |
| `src/rereview-colado.ts` placed back at `src/` root | RED (absence half) |
| `src/rereview/verify.ts` removed | RED (presence half) |
| `src/rereview/intruso.ts` added to the domain | RED (presence half) |
| all reverted | 2 pass, 0 fail |

### Lab compatibility (the acceptance criterion)

`src/index.ts` is byte-identical — `git diff` against it is empty, and `rereview` was never
part of the public surface. The lab's `node_modules/pr-hero` is a stale copy from Aug 29, so
typechecking the lab in place would have proven nothing, and its `bun.lock` is committed, so
it was not reinstalled. Instead the contract was replicated in a scratch consumer: the lab's
verbatim `tsconfig.json`, its exact import surface, and the real package installed fresh via
`file:`. Both gates pass — runtime resolves `pr-hero` to `index.ts` to `pipeline` to
`#rereview/*` (4 agents, 12 conformance cases), and `tsc --noEmit` exits 0.

### Notes for the next domain

- Biome sorts `#domain/*` ahead of `./`, so each move needs
  `./node_modules/.bin/biome check --write src test` before `bun run check` passes.
- Moving a domain strands WHY-comment references to the old paths. 16 were retargeted here.
  These comments are load-bearing in this repo, so the retarget belongs in the move's PR;
  skipping it would accumulate roughly 200 dangling references by T10.
- zsh does not word-split unquoted parameters, so a `for f in $FILES` loop hands the whole
  list to one `sd` invocation. Use a bun script for multi-file edits and verify with
  `git diff --stat`.

### Pre-existing issue found, deliberately not fixed here

Six files cite `docs/item7-rereview-design.md`, which does not exist in this repo or in
`../deep-review`. The reference predates this move and is out of scope for a move-only PR.

### Verified outcomes (T3)

- 19 `git mv` renames confirmed by `git diff --cached -M --stat`: 9 modules to `src/ui/`
  (`ui.ts` deliberately renamed to `primitives.ts` — the domain's shared terminal
  primitives; never `index.ts`, a domain barrel is explicitly banned), 10 tests to
  `test/ui/` (`menu-loop.test.ts` has no matching source module — it tests `menu.ts`).
- `bun test`: 3650 pass, 0 fail. Baseline was 3649; the +1 is the new absence-of-bare-file
  ratchet test added below. `bun run typecheck`: exit 0. `bun run check`: exit 0 over 291
  files (after `biome check --write src test`, expected per T1's note).
- The `activity`/`menu-context` collision the task doc warned about: `src/ui-activity.ts`
  and `test/ui-activity.test.ts` both imported the ROOT `src/activity.ts` (a different,
  non-migrating module) — correctly rewritten to `../activity` / `../../src/activity`
  rather than the sibling `#ui/activity` or `./activity`. Same treatment for
  `src/ui-menu.ts`'s and `test/ui-menu.test.ts`'s imports of `src/menu-context.ts`.
  `src/activity.ts`, `test/activity.test.ts`, `src/menu-context.ts`, and
  `test/menu-context.test.ts` are byte-identical (`git diff` empty).
- ~20 stale WHY-comment path references retargeted across `src/report.ts`,
  `src/progress.ts`, `src/watch.ts`, `src/cli.ts`, `src/metrics-preflight.ts`,
  `src/execution/{harness,spend-limiter}.ts`, `src/ci-reporter.ts`, and several
  non-migrating test files, using the domain-qualified sibling convention T1
  established (e.g. `ui/primitives.ts formats, ui/select.ts asks`, not the bare
  basename, even for comments now living inside `src/ui/` itself).

### Verified outcomes (T3 ratchet extension)

The prefix-only absence check (`<domain>-*.ts`) would pass vacuously forever if a bare
`<domain>.ts` were left at `src/` root — `rereview` (T1) never exposed this because it had
no bare `rereview.ts`; `ui` does (`src/ui.ts` itself). Added a second absence assertion,
generic over `MIGRATED_DOMAINS`, and mutation-tested all four cases:

| mutation | result |
| --- | --- |
| bare `src/ui.ts` touched at root | RED (new bare-file absence half) |
| stray `src/ui-foo.ts` added | RED (existing prefix absence half) |
| `src/ui/tree.ts` removed | RED (existing presence half) |
| all reverted | 3 pass, 0 fail |

### Gotcha found during T3, for T4 onward

Grepping by the domain's own name pattern (`rg 'ui[-.]'` or similar) is NOT sufficient to
find every non-domain sibling import that needs its relative depth adjusted after a move —
`test/ui-menu.test.ts`'s import of `../src/menu-context` doesn't match a `ui`-shaped
pattern, so the targeted sweep missed it; only `bun run typecheck` caught the resulting
`TS2307`. For each moved file, audit its FULL import list (not just domain-pattern
matches), and always run `bun run typecheck` before declaring the move done — don't rely
on the sweep alone.

### Pre-existing issue found, deliberately not fixed here (T3)

`CLAUDE.md` and `AGENTS.md`'s "Architecture (one line per module)" sections still list
`src/ui.ts`, `src/ui-select.ts`, `src/ui-result.ts`, and `src/ui-tree.ts` by their old
pre-move paths. Out of this task's authorized scope (file moves, `package.json` imports,
import-specifier updates, the layout ratchet — and the sweep command the task doc gives
is explicitly scoped to `src test scripts fixtures`, not root docs). Left for a follow-up.

## Next step

Open the PR against `dev`, triage the pr-hero self-review, then start T4 (`ci/`, 6 files).
