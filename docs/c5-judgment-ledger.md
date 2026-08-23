# C5 design — Judgment Day ledger, round 1

Frozen target: `docs/c5-global-config-design.md`, 660 lines,
`sha256 d58776040048329c00f665d88060c9ed17f366e7b411d5d05c6d89584881bc75`.
Repository at `e23d806`. Two blind read-only judges (`jd-judge-a`, `jd-judge-b`), identical
scope, launched in parallel 2026-08-23. 30 raw findings → **21 unique**.

Every row marked ✅ was **independently re-verified by the orchestrator** against the working
tree before being written here. The judges' word alone put nothing in this ledger.

Protocol: only findings both judges filed as CRITICAL are eligible for the round-one fix
actor. WARNING and SUGGESTION rows are informational. A single-judge finding is a suspect and
is never auto-fixed, however well evidenced.

---

## Confirmed severe — both judges, both CRITICAL

### JD-1 — §3.5's rename is type-silent and its consumer list is half the blast radius

`PrheroLayout.configPath` keeps its name and its `string` type while being re-pointed from
`~/.prhero/watch.json` to `~/.prhero/config.json`. tsc therefore cannot flag a missed call
site: both are `string`, and `test/home-preflight.test.ts:33` pins only the layout literal,
not one consumer.

✅ Verified: `rg "paths\.configPath" src/watch.ts` returns **19** sites — 172, 174, 180, 679,
773, 776, 815, 816, 835, 841, 867, 868, 872, 877, 880, 881, 894, 896, 907. §3.5 names ten of
them.

The concrete failure both judges reached independently: `watchRemove` (`src/watch.ts:865-882`)
has its guard at `:867` unlisted while `:872` and `:880` in the *same function* are listed. A
partial migration leaves one function reading two different files, and `pr-hero watch remove`
would gate on the presence of the global **review** config — logging `not listed` on a machine
that has a `watch.json` and no global config. `watchStatus` (`:907`) would print the review
config path as the watch config.

Also: §3.5 has no §2 obligation and no §5 named test.

### JD-2 — `ConfigSources` cannot name absence for the two required array keys

`parity_trigger_paths` and `suspicion_priors` are **non-optional** in `LocalConfig`
(`src/preflight.ts:1473-1475` — no `?`), and both `parseLocalConfig` (`:1538`, `:1548`) and
`EMPTY_LOCAL_CONFIG` (`:1498-1501`) materialise them as `[]`. The absence bit is destroyed
before the merge ever runs.

✅ Verified in the interface and in both read sites (`src/cli.ts:516-518`, `:963-965`), which
substitute `EMPTY_LOCAL_CONFIG` when no file exists.

Consequence: on a repo with **no** `.prhero/config.json` at all, the merge must still label a
source for those two keys, and the only truthful answer — `default` — is unreachable. It will
report `repo`. That is a **false per-key provenance in `pipeline.json`**, which D7 calls
non-negotiable and O-6 requires, and in `pr-hero config`, which O-12 requires. §5 row 12's
required case "a key absent from both files (source `default`)" is structurally unreachable
for them.

---

## Confirmed severe in substance — B filed it CRITICAL, A recorded the identical observation

### JD-3 — `mergeConfig`'s signature does not build

§3.3 declares `global: LocalConfig | undefined`. `LocalConfig` **requires**
`parity_trigger_paths` and `suspicion_priors` — the exact two keys §3.2 says
`parseGlobalConfig` must reject by name. So `parseGlobalConfig` cannot return a `LocalConfig`
without fabricating the arrays it just rejected; and if it fabricates them, §3.3's `repo` rule
("a global value cannot exist … the fold has nothing to resolve") is false and the fold needs
a runtime skip the declared type does not express.

Judge B filed this as CRITICAL. Judge A did not file it, but recorded verbatim in its evidence
that "`mergeConfig`'s `global: LocalConfig | undefined` is only nominally satisfiable, since
§3.2 has parseGlobalConfig reject the two keys LocalConfig declares required." Two independent
sweeps reached the same defect; only the filing differs.

✅ Verified: `src/preflight.ts:1473-1475` against §3.2's rejection list.

Same root cause as JD-2 — the design leans on `LocalConfig` as the merge's currency when the
merge needs a shape where every key can be absent.

---

## Confirmed by both, severity split (A: WARNING · B: CRITICAL)

### JD-4 — O-11 cites a stale anchor, and its verdict is wrong

The obligation whose own text ends *"a design that fixes stale citations and creates one in
the same commit has fixed nothing"* cites `ROADMAP.md:150` for "pillar 2's launch-config
table".

✅ Verified: `ROADMAP.md:148-150` is **pillar 1 prose**. The table is at `:157-165`, and the
`.prhero/config.json` row that lists `summary.model` is `:161`.

Judge B extends it, correctly: "needs no change" is also wrong. The table's axis is **Where**,
and it already gives `~/.prhero/watch.json` its own row — so C5's new `~/.prhero/config.json`
layer must appear there, or the table understates the launch config surface after the slice.
B further notes `:161` already omits `max_verification_steps`, a pre-existing staleness the
"needs no change" verdict would freeze in place.

---

## Suspects — one judge each. Orchestrator-verified, NOT auto-fixed.

### JD-5 (A, CRITICAL) — `default_base` as a `person` key defeats remote-head autodetection

The most dangerous row in this ledger, and only one judge saw it.

✅ Verified, `src/preflight.ts:1170-1175`: `resolveBaseRef` checks `configDefaultBase`
**before** `remoteHead`. So a config value preempts autodetection — that is today's behaviour
and it is correct for a per-repo file.

Make it a `person` key and invite the operator to hoist it globally (§3.8 does exactly that),
and every quiet repo whose default branch differs from the global value reviews the **wrong
commit range** — spending money on a diff nobody asked for, with a plausible branch name on
the plan card. `src/preflight.ts:32-37`'s own WHY comment names this failure class: *"a wrong
answer with a plausible face."*

D4's justification for the classification — "costs nothing, widens no trust" — is false for
the range it selects. No obligation and no test covers a global `default_base` against a repo
with a different remote head.

### JD-6 (B, WARNING) — shared validators hardcode the repo file's name

✅ Verified: `src/preflight.ts:1518`, `:1522`, `:1535`, `:1590`, `:1595-1597`, `:1624-1626`,
`:1656-1658` all embed the literal `.prhero/config.json`. §3.2 says `parseGlobalConfig` shares
those validators; §3.7 says every rejection names the file it is in. Both cannot hold: a
malformed `~/.prhero/config.json` would send the operator to edit the wrong file.

### JD-7 (B, WARNING) — §4's m6 divergence names a key m6 never reads

✅ Verified: `scripts/m6.ts` reads `resolveSummary` (`:154`) and `parity_trigger_paths`
(`:161`, `:219`). It never reads `max_verification_steps`. The real divergence is that a
global `summary.enabled: false` would be invisible to `m6 plan`, which would then price the
summarizer on — verbatim the failure `scripts/m6.ts:145-149` exists to prevent ("over-price
all 56 runs by a full agent seat"). The bullet warns about a key with no pricing effect and
stays silent on the one that has it.

### JD-8 (A, WARNING) — O-11 leaves two stale *facts* in the C5 entry

✅ Verified: `ROADMAP.md:1411-1412` says the config has **"four keys"** (§0.1 establishes six),
and `:1413-1414` says `~/.prhero/` **"belongs entirely to the watcher"** — which §6 Q3, ratified
by Juanma this session, declares the opposite of. O-11 scopes itself to line anchors and would
leave both wrong.

### JD-9 (A, WARNING) — a global `agents_dir` silently preempts `PRHERO_AGENTS_DIR`

✅ Verified by chain order (`src/preflight.ts:1194-1218`): flag → config → env. §4 claims the
env var "keeps its existing last-resort seat", but the merged config now supplies
`configAgentsDir` for every quiet repo, so an exported env var stops taking effect where it
used to work.

### JD-10 (B, SUGGESTION) — `ConfigSource` has no `flag` member

So the record cannot name a flag-supplied value, which makes §3.10's "what it prints cannot
drift from what actually runs" an overclaim for any run using `--agents` / `--base` /
`--model` / `--no-summary`.

### JD-11 (B, SUGGESTION) — no test for a malformed global config

After C5 that file is read on every review in both modes, so one bad global file fails every
repo on the machine. §3.2 and §3.7 specify its error vocabulary; §5 tests none of it.

### JD-12 (B, SUGGESTION) — D2's central mechanism has no gate

"That table IS the known-key set" is the design's headline enforcement claim, yet O-3's test
asserts against a hardcoded pre-C5 key list — it passes whether or not `parseLocalConfig`
derives its keys from `CONFIG_DIRECTION`. The existing `Set` (`src/preflight.ts:1525-1537`) can
survive the slice and the table can drift from the parser with no gate firing.

### JD-19 (A, SUGGESTION) — §5 row 1's "runtime witness" cannot witness

`Object.keys` over a hand-written fixture enumerates only what the fixture author wrote, so a
`LocalConfig` member the fixture omits is invisible. The obligation is satisfied by the
`Record` type; the named test adds nothing.

### JD-20 (A, SUGGESTION) — the `capped` tie case has no defined source label

When both layers set the same value, nothing was "narrowed away" yet the global equally
determined the result. Two conforming implementations would print different layers.

### JD-21 (A, SUGGESTION) — O-7 and §3.6 disagree about `default`

O-7 requires tagging any value that did not come from the repo file — which includes
`default`. §3.6 tags only global-sourced and cap-narrowed values.

---

## Confirmed by both — informational (WARNING / SUGGESTION)

| ID | Finding | A | B |
|---|---|---|---|
| JD-13 | D9's "the six resolvers do not change" is contradicted by §3.4 and §3.6 in the same document: `AgentsDirSource` loses its `"config"` member and the resolver must learn *which* layer won. B adds that four of the six never receive a `LocalConfig` at all. | W | W |
| JD-14 | The one runtime-load-bearing use of the source record — resolving a relative `agents_dir` against the **winning** layer's directory — has no obligation and no test. `resolveAgentsDirSetting` takes a single `configDir`. | W | W |
| JD-15 | `CONFIG_DIRECTION.summary = "capped"` violates D3's own rule that `capped` applies only where "narrower" is definable. A `SummaryConfig` object has no ordering; only §3.3's prose special-case prevents `a && b` over two objects silently adopting the repo's whole block. | W | S |
| JD-16 | `--config` stops being hermetic: today it fully determines the run's config, after C5 it merges whatever global file the machine happens to have, with no suppression flag. §5's "baselines stay comparable" argues only from `promptSetFingerprint` and never addresses config-sourced inputs. | W | W |
| JD-17 | O-9 has no §3 mechanism and an under-scoped test. `initConfigTemplate` (`src/preflight.ts:1667-1682`) also seeds `default_base` and `summary.model` (`"haiku"`) and hardcodes `summary.enabled: true` — the value `capped` forbids the team from raising. | W | W |
| JD-18 | Internal cross-references that do not resolve, in a document that makes unresolvable citations its stated defect class: the header's roadmap range, §0.9's attribution of `SUGGESTED_AGENTS_DIR` to §0.1, and §3.6's attribution of the item-7/scout provenance blocks to `src/pipeline.ts:129` (which is the C4 block). | S | S |

---

## Contradictions between judges

**None.** The two sweeps overlap or differ in coverage; they never assert opposing facts.

## What both judges could not verify

Neither judge has shell access, so §0.5's byte-identical measurement, §0.8's
`git ls-files .prhero/` and commit `523f97c21`, and §0.4's `~/.prhero/` listing were recorded
as unverified rather than judged. Judge B independently re-derived §0.5 and §0.10 through file
reads and confirmed both. The orchestrator produced all four originally by shell and they
stand.

---

## Round-1 state

| | |
|---|---|
| target_identity | `d58776040048329c00f665d88060c9ed17f366e7b411d5d05c6d89584881bc75` |
| round | 1 |
| confirmed severe | JD-1, JD-2 (both CRITICAL by both judges); JD-3 (CRITICAL by B, corroborated in A's evidence); JD-4 (CRITICAL by B, WARNING by A) |
| suspect | JD-5, JD-6, JD-7, JD-8, JD-9, JD-10, JD-11, JD-12, JD-19, JD-20, JD-21 |
| contradictions | none |
| info | JD-13, JD-14, JD-15, JD-16, JD-17, JD-18 |
| fix_work_units | *pending — the protocol requires asking before round-one correction* |
| scoped_rejudgment | not_run |
| terminal_state | *pending* |
| skill_resolution | none — no project skill matched this target |

---

# Scoped re-judgment of round 1

Corrected target: 780 lines, `sha256 82a496ed2f746bb17f39669839cbd19347d423a4f67463b9da6c582ed362b2c6`
(was 660 lines, `d5877604…`). Delta: 347 diff lines. Both judges re-ran **scoped** — frozen
ledger plus the immutable fix delta only, with JD-6..JD-21 explicitly out of scope.

Round 1 discharged JD-1, JD-4 (first limb) and JD-5 cleanly. It did **not** fully discharge
JD-2/JD-3, and it introduced four blemishes of its own.

## RJ-1 — CRITICAL, confirmed by both judges. Round 1's own fix was inert.

§3.2 as corrected says `parseLocalConfig`'s *"return type widens to `ConfigLayer` and nothing
else moves — the keys it admits, the validators it runs and the errors it throws are
byte-identical."* That sentence makes the fix a no-op.

✅ Orchestrator-verified at `src/preflight.ts:1575-1584`: the return object writes
`parity_trigger_paths: triggers as string[]` and `suspicion_priors: priors as SuspicionPrior[]`
**unconditionally**, while its four siblings use conditional spreads. A return-type widening
changes no runtime value.

So for a repo `.prhero/config.json` that exists but omits an array key — legal today — the
repo layer still carries `[]`, the merge sees the team layer speak, and provenance says `repo`
where the truth is `default`. **JD-2 survives for the repo-file-present case.** §5 row 14
cannot catch it: it covers only "no global file AND no repo file", which §3.4 routes through
the absent-layer path, bypassing the parser entirely.

## RJ-2 — WARNING, judge B only. Orchestrator-verified. The same change breaks `scripts/m6.ts`.

✅ Verified: `scripts/m6.ts:151-153` assigns `parseLocalConfig`'s result, then dereferences
`config.parity_trigger_paths.length` **unguarded** at `:161` and `:219`, and passes it at
`:154` to `resolveSummary(options, config: LocalConfig)`. Once the parser stops materialising,
those two lines throw — and `scripts/` is covered by **neither** `bun run typecheck` **nor**
`bun run check`.

Filed by one judge, but **not treated as a suspect**: it is not an independent finding, it is
the other half of RJ-1's fix. Repairing RJ-1 without it ships a broken script.

B further notes §4's bullet names `max_verification_steps` as the m6 divergence — a key m6
never reads (that was JD-7, and round 1 left it in scope-respecting silence).

## RJ-3 — confirmed by both. O-11's second limb still open. (A: WARNING · B: WARNING)

The rewrite fixed the `:150` anchor and reversed the main verdict, but still blesses
`ROADMAP.md:161` as "stays correct". ✅ Verified: that row omits `max_verification_steps`, a
real repo key (`src/preflight.ts:1485`, admitted `:1531`), under a caption at `:157` reading
"existing knobs only".

## RJ-4..RJ-6 — confirmed by both, informational. All in text round 1 wrote.

| ID | Finding | A | B |
|---|---|---|---|
| RJ-4 | §3.8 calls `agents_dir` and `summary` "the **person** lines". `summary` is `capped` in both `CONFIG_DIRECTION` and D4. In a document whose central mechanism is a direction table, the migration section mislabels a direction. | W | S |
| RJ-5 | §3.5 and §5 row 13 cite `test/watch-preflight.test.ts:1374-1380`; the `toEqual` literal runs `:1374-1383`, so the range excludes `metricsDbPath` and `plistPath`. The companion citation in the same sentence is exact. | W | S |
| RJ-6 | §3.2's rejection bullet now covers three `repo` keys but keeps one hardcoded example naming `parity_trigger_paths`, contradicting §3.7's rule that a rejection names its own key. | S | — |

## RJ-7 — judge B only, SUGGESTION. The gap §3.5 names but does not oblige.

§3.5 correctly identifies `WatchStatusFacts.configPath` (`src/watch-preflight.ts:1166`) as the
one consumer the identifier retirement provably cannot catch — a different type's field, so
`src/watch.ts:907` becomes `configPath: paths.watchConfigPath` and keeps compiling. O-13 is
scoped to `PrheroLayout` and §5 row 13 tests only the two layout literals, so every acceptance
criterion can pass while the outcome §3.5 calls wrong survives. Impact is naming hygiene:
`renderWatchStatus` prints the label `config`, never the field name.

## Contradictions between judges

**None**, in either round.

## Round-2 state

| | |
|---|---|
| target_identity | `82a496ed2f746bb17f39669839cbd19347d423a4f67463b9da6c582ed362b2c6` |
| round | 2 — **final**; the protocol has no third |
| confirmed severe | RJ-1 (CRITICAL by both) |
| carried into the same work unit | RJ-2 — one judge, but the other half of RJ-1's fix, not an independent finding |
| also corrected | RJ-3, RJ-4, RJ-5, RJ-6, RJ-7 — cheap, and all but RJ-3 sit in text round 1 introduced |
| still out of scope | JD-6..JD-21, untouched by design in both rounds |
| contradictions | none |
| fix_work_units | WU-6 (RJ-1 + RJ-2), WU-7 (RJ-3), WU-8 (RJ-4/5/6), WU-9 (RJ-7), WU-10 hygiene |

---

# Final scoped re-judgment, and the terminal verdict

Target: 872 lines, `sha256 26bf8a9ee6d209cedfb82991780699c93eb93a3c4c549cdb3370df8e63cc9dd7`
(was 780, `82a496ed…`). Delta: 302 diff lines. Both judges re-ran scoped, JD-6..JD-21 still
out of scope.

**Both judges independently record RJ-1 through RJ-7 as discharged.** Judge A walked the
`ConfigLayer` edit to the return object and confirmed absence now survives for all six keys, so
`source: "default"` is reachable; both confirmed §5 row 14 case (b) *would* detect the residue
that killed round 1, because case (a) never reaches the parser. Neither judge filed a CRITICAL.

Round 2 introduced no severe defect. It did leave three informational rows, and the first two
are confirmed by both judges and verified by the orchestrator.

## RES-1 — confirmed by both, WARNING. D9's blast radius understates itself by two resolvers.

Round 2 added to D9: *"One signature-only amendment … scoped to a caller outside the engine …
No resolver body moves."* All three clauses are wrong, and the two judges found different
halves of it.

✅ Verified:
- `resolveMaxVerificationSteps(config: LocalConfig)` (`src/preflight.ts:1631`) is a **second**
  resolver needing the same parameter widening (judge B).
- `resolveAgentsDirSetting` returns `source: "config"` at `src/preflight.ts:1207`, a member
  §3.6 drops from `AgentsDirSource` — so a **third** resolver's *body* must move, along with its
  error text at `:1213-1217` (judge A).
- "Outside the engine" is false: `test/preflight.test.ts:832` and `:853` hand raw
  `parseLocalConfig(...)` straight to those resolvers.

## RES-2 — confirmed by both, WARNING. One existing test breaks, unnamed.

✅ Verified at `test/preflight.test.ts:737-742`:

```
test("both keys are optional", () => {
  expect(parseLocalConfig("{}")).toEqual({
    parity_trigger_paths: [],
    suspicion_priors: [],
  });
});
```

The behavioural edit makes the parser return `{}`, so this goes red. The design enumerates
every pinned literal the *rename* touches (§5 row 13 names three) but names none for the
*parser* change. Judge B's severity reasoning is why this is not CRITICAL: it cannot ship
green — `bun test` and `bun run typecheck` both catch it, and §5 already prescribes them. It is
a gap in guidance, not a silent defect.

## RES-3 / RES-4 — judge B only, SUGGESTION.

§4 quotes D9's *retired* wording ("the six resolvers do not change"), which round 2 replaced in
the same delta — an internal self-citation that no longer resolves, in the document whose own
thesis is that unresolvable citations hide wrong premises. And §0.5:155-156 still calls
`summary.enabled` a "property of the person" while §3.8's new sentence condemns exactly that
label.

## Verdict

| | |
|---|---|
| target_identity | `26bf8a9ee6d209cedfb82991780699c93eb93a3c4c549cdb3370df8e63cc9dd7` |
| round | 2 of 2 — the protocol's budget is exhausted |
| confirmed severe remaining | **none** — no CRITICAL filed by either judge in the final re-judgment |
| suspect | none new |
| contradictions | none, across all four judge runs |
| info | RES-1, RES-2 (both judges); RES-3, RES-4 (one judge) |
| fix_work_units | round 1: WU-1..WU-5. round 2: WU-6..WU-10. All reported `fixed`. |
| scoped_rejudgment | **approved** |
| terminal_state | **approved** |
| skill_resolution | none — no project skill matched this target |

**JUDGMENT: APPROVED ✅**

Two caveats this verdict does not paper over. **JD-6 through JD-21 were never in scope** for
either fix round — eleven suspects and six both-confirmed informational rows are still open in
this ledger, deliberately, and they remain the design's known debt. And **RES-1/RES-2 are real**:
whoever implements should correct D9's blast radius and enumerate `test/preflight.test.ts:737-742`
before writing code, or trip over both on day one.
