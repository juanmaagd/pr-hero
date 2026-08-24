# C5 — global config with per-repo override. Design.

Status: **RATIFIED** (Juanma, 2026-08-23), **corrected round 1** (2026-08-23) on four points
that would not have survived implementation: the layout rename now retires the name
`configPath` instead of reusing it (§3.5, O-13), the merge folds over a `ConfigLayer` in which
absence is representable (§3.2, §3.3, O-14), O-11's own citation and its verdict are fixed, and
`default_base` is back to a `repo` key (D4).

**Corrected round 2** (2026-08-23) on four more, the first of which is round 1's own residue:
the `ConfigLayer` fix was inert until `parseLocalConfig` **stopped materialising** the two arrays
— a return-type widening moves no runtime value — which forces two `?? []` lines in
`scripts/m6.ts` and touches three resolvers (§3.2, §4, D9, O-14, §5 row 14); O-11 now also fixes
`ROADMAP.md:161`'s omission of `max_verification_steps`; O-13 now obliges the one consumer its
own mechanism cannot catch (§3.5); and §3.8 no longer calls `summary` a person key. All three §6
calls remain closed.

**Judgment Day: APPROVED** (2026-08-23) — two full judge sweeps, two correction rounds, two
scoped re-judgments, no severe finding surviving and no contradiction between judges across all
four runs. Ledger: `docs/c5-judgment-ledger.md`. Four informational rows the verdict left
standing were then corrected here as post-verdict hygiene: D9's blast radius understated itself
by two resolvers (RES-1), the one existing test the parser change breaks was unnamed (RES-2),
§4 quoted a D9 sentence round 2 had already retired (RES-3), and §0.5 still called
`summary.enabled` a person key (RES-4).

**Known debt the verdict does NOT cover:** ledger rows JD-6 through JD-21 were deliberately
out of scope in both rounds — eleven suspects and six both-confirmed informational rows, most of
them missing obligations or tests rather than wrong decisions. Read them before implementing the
section they touch.

Implementable as written; everything is grounded in §0.

**Two layers, decided by Juanma 2026-08-23.** The question was raised as "does this work at
team scale, `.claude`-style — user rules global, project override?" The answer is yes, and it
reframed the design: the repo layer **is the team layer** (§0.8), which closed Q1 on its own.
A third `.claude`-style layer (`config.local.json` — mine, this repo, gitignored) was
considered and **deferred**: not enough value today. §4 records exactly what it would have
solved, so nobody re-litigates it from scratch.

Roadmap seat: THE LAUNCH LINE → Fundamentals #5, and the load-bearing half of distribution
pillar 1 (a published package must default `agents_dir` to a bundled prompt set, and that
default is a *person* key with nowhere to live today). Roadmap entry: `ROADMAP.md:1409-1428`.

House pattern: same shape as `docs/c4-preamble-design.md` and `docs/item7-rereview-design.md`
— terrain verified first, decisions second, one named test per obligation at the end.

---

## 0. The terrain, verified 2026-08-23 — read this before disagreeing with §3

Every line reference below was read this session, in this tree, at `e23d806`.

### 0.0 The roadmap's own citations no longer resolve

`ROADMAP.md:1409-1426` cites `preflight.ts:999`, `watch-preflight.ts:31` and
`watch-preflight.ts:50`. All three have drifted:

| Cited in ROADMAP | Actual today |
|---|---|
| `parseLocalConfig` — `preflight.ts:999` | `src/preflight.ts:1512` |
| `~/.prhero/` layout — `watch-preflight.ts:31` | `prheroLayout` — `src/home-preflight.ts:32-43` (the watcher's `prheroHomePaths` at `src/watch-preflight.ts:29-40` only *extends* it with the plist) |
| the spend rule — `watch-preflight.ts:50` | comment block `src/watch-preflight.ts:43-47` (`:49` is `DEFAULT_DAILY_CAP = 5`) |

Fixing those anchors is part of this slice (O-11) — a design entry whose evidence does not
resolve is how a wrong premise survives a re-read.

### 0.1 Six keys, one parser, unknown keys are fatal

`parseLocalConfig` (`src/preflight.ts:1512-1585`) returns `LocalConfig`
(`src/preflight.ts:1473-1486`). Its known-key set is exactly six; anything else throws
`.prhero/config.json unknown key: <key>` (`:1535`). `summary` has its own strict sub-parser
(`parseSummaryConfig` `:1587-1617`), which rejects typos by name (`:1596`).

| Key | Shape | Default when absent | Reaches the pipeline as |
|---|---|---|---|
| `agents_dir` | `string?`, non-empty; **relative resolves against the config file's dir** (`:1190-1193`) | falls to `PRHERO_AGENTS_DIR`, then hard error (`:1213-1217`) | `PipelineInput.agentsDir` (`src/pipeline.ts:99`) |
| `default_base` | `string?`, non-empty | remote head → `DEFAULT_BASE_REF = "main"` (`src/preflight.ts:37`) | `PipelineInput.baseSha` (`src/pipeline.ts:88`) |
| `parity_trigger_paths` | `string[]` | `[]` → parity hunter never fires | `PipelineInput.parityTriggerPaths` (`src/pipeline.ts:112`) |
| `suspicion_priors` | `{path, weight, reason}[]` (`src/prompt-set.ts:68-74`) | `[]` | `PipelineInput.suspicionPriors` (`src/pipeline.ts:113`) → `{{PRIORS}}` (`src/prompt-set.ts:96-108`) |
| `summary.enabled` | `boolean?` | **`true`** — `resolveSummary` `:1641` | `PipelineInput.summarizer` (`src/pipeline.ts:120`) |
| `summary.model` | `string?` | omitted; `prompts/summarizer.md` frontmatter governs | same |
| `max_verification_steps` | non-negative int, `0` legal (pause) | `DEFAULT_MAX_VERIFICATION_STEPS = 8` (`:1619`) | `PipelineInput.maxVerificationSteps` (`src/pipeline.ts:168`) |

`summary.enabled`'s default carries its own WHY at `src/preflight.ts:1509-1511`: *"it is the
first defaulted setting that spends money, and a silent opt-out would make a normal review's
bill differ from the plan."* That sentence is the seed of this design's whole capped
direction — the property it protects is that **the plan must not lie about the bill**.

There is deliberately **no** `scout` key (`src/preflight.ts:81-87`), pinned loud by
`test/preflight.test.ts:214-218`.

### 0.2 The engine has exactly two read sites, and one of them already draws the trust boundary

```
src/cli.ts:512   local review  →  path.join(repoRoot,      ".prhero", "config.json")
src/cli.ts:959   PR review     →  path.join(operatorRoot,  ".prhero", "config.json")
```

Both: `--config` if given (missing → `CliError`), else the path above, else
`EMPTY_LOCAL_CONFIG` (`src/preflight.ts:1498-1501`). The complete list of `".prhero"` path
joins in `src/` is five lines — `cli.ts:512`, `:606` (gotchas), `:959`, `:996` (gotchas),
`:3018` (init) — plus `home-preflight.ts:33`. Outside `src/` there is one more:
`scripts/m6.ts:150` reads a target repo's config to price its runs at $0 (§4 disposes of it).

`src/cli.ts:914-917`, verbatim:

```
//   - the OPERATOR root: --repo's toplevel. cwd for gh and for .prhero/
//     config+gotchas. Config is NEVER read from the worktree — the operator
//     checkout is the trust anchor, and a reviewed PR's tree must not
//     influence engine config. Dirtiness here is irrelevant.
```

**Consequence for C5, and it is the reason this design is short on security caveats:** the
global file will be read from `os.homedir()`, which is even further from the PR author's
reach than the operator checkout already is. C5 cannot weaken this boundary; it can only
add a source that a PR author has strictly less access to.

### 0.3 The spend rule, verbatim (`src/watch-preflight.ts:43-47`)

```
// ~/.prhero/watch.json — the explicit opt-in. A repo is watched ONLY if
// listed here; nothing in a repo's own .prhero/ can subscribe it to
// automatic spend. Parsed loudly, ledger-style: every failing field names
// itself and its got-value, because a silently mis-read config either burns
// money on the wrong repo or silently watches nothing.
```

Read it precisely. It is **directional**: the danger is the *repo* enlarging the *operator's*
bill, never the reverse. That asymmetry is the whole reason precedence here cannot be a
uniform "repo wins", and it generalises past the watcher — `summary.enabled` and
`max_verification_steps` are two more ways a repo can spend the operator's money.

### 0.4 `~/.prhero/` is the PRODUCT's home, and `configPath` is already taken

`prheroLayout(home)` — `src/home-preflight.ts:32-43` — owns seven paths:

```
dir, reposDir, configPath → watch.json, logPath, lockPath, launchdLogPath, metricsDbPath
```

`configPath` points at **`watch.json`** (`:37`), pinned by `test/home-preflight.test.ts:33`.
The name is already misleading today and would be actively wrong the moment a real global
config exists.

The ownership question is already answered in code — `src/home-preflight.ts:7-12`: *"The
product home now owns ephemeral machine state; the watcher is one tenant. Per-repo trust
(config, gotchas) stays in `<checkout>/.prhero/`."* A global review config is the product's
tenant, not the watcher's.

Observed on this machine: `gc-launchd.log`, `launchd.log`, `metrics.db(+shm/wal)`,
`pr-create-hook.log`, `repos/`, `watch.json`, `watch.log`. No `config.json`.

### 0.5 The pain, measured rather than asserted

`musive-s1`, `musive-s2` and `musive-s3` each carry a `.prhero/config.json` of **212 bytes,
byte-identical**:

```json
{
  "agents_dir": "/Users/juanma/Desktop/deep-review/agents/slice3b-lifecycle-v6-clean",
  "default_base": "dev",
  "parity_trigger_paths": [],
  "suspicion_priors": [],
  "summary": { "enabled": false }
}
```

100% duplication across every repo on the machine — but duplication and **hoistability** are
different properties, and reading this corpus as if they were the same is what put
`default_base` on the wrong side of D4 in the first draft. Two of the repeated keys hoist
cleanly — `agents_dir`, which is `person`, and `summary.enabled`, which is `capped` and whose
`false` here is a narrowing the cap allows either way (naming it a "person" key, as an earlier
draft did, is the mislabel §3.8 warns about). `default_base`
repeats only because all three repos are siblings of one org that ships from `dev`; it stays
per-repo (D4), because the first sibling on `main` would silently inherit `dev` and be reviewed
against the wrong range. The two array keys are empty in all three — they have never yet
earned their per-repo seat, but that is an accident of this corpus, not an argument.

### 0.6 There is no global fallback anywhere, and six precedence chains that share nothing

Verified by reading every resolver:

| Chain | file:line | Order |
|---|---|---|
| `resolveAgentsDirSetting` | `src/preflight.ts:1247-1271` | flag (`--agents`) → config (relative to config dir) → env `PRHERO_AGENTS_DIR` → bundled default |
| `resolveBaseRef` | `src/preflight.ts:1165-1176` | flag (`--base`) → config → remote head → `"main"` |
| `resolveSummary` | `src/preflight.ts:1635-1644` | flag (`--summary`/`--no-summary`, `--model`) → config → default-on |
| `resolveMaxVerificationSteps` | `src/preflight.ts:1631-1633` | config → `8` |
| `sizeGateConfig` | `src/size-gate.ts:489-500` | flag → `DEFAULT_SIZE_GATE`; **no config seat at all** |
| watch per-repo | `src/watch-preflight.ts:127-149` | per-repo key → `DEFAULT_SIZE_GATE` / `DEFAULT_DAILY_CAP` |

Two structural asymmetries a merge has to survive:

1. `parseLocalConfig` **rejects** unknown keys (`src/preflight.ts:1533-1536`);
   `parseWatchConfig` **tolerates** them, and `upsertWatchRepo`'s rewrite depends on that
   (`test/watch-preflight.test.ts:1617`). Two files, two opposite contracts, both correct for
   their job. C5 must not homogenise them.
2. Review-time and init-time `agents_dir` precedence deliberately differ
   (`src/cli.ts:3021-3025`).

### 0.7 The untested seam this slice inherits

`rg "EMPTY_LOCAL_CONFIG" test/` returns **zero hits**. Nothing exercises `src/cli.ts:510-518`
/ `:957-965` — the `existsSync → parseLocalConfig → EMPTY_LOCAL_CONFIG` fallback, nor the
`--config`-missing → `CliError` branch. C5 rewrites exactly that seam, so it inherits the
obligation to cover it (O-5).

### 0.8 The repo layer is already the TEAM layer, and one commit proves it hurts

`.prhero/` is **committed** in `musive-s1` — `git ls-files .prhero/` returns both
`config.json` and `gotchas.md`, and `.gitignore` says nothing about `prhero`. So the per-repo
layer is not "my settings for this checkout"; it is *the team's settings, shared through git*,
and has been all along without being named that.

The cost of not naming it is on the record. `523f97c21` — **`chore(prhero): turn off the
summary roll-up comment`** — is a *personal* preference (`summary.enabled: false`) committed
into the team's file, because there was nowhere else to put it. One layer doing two jobs.

Three consequences this design absorbs:

1. A committed `agents_dir` is a **team standardising its reviewer**, which is the use case,
   not the attack. It closes §6 Q1 — see there.
2. `gotchas.md` being committed, required and human-signed is the same shape as a committed
   `CLAUDE.md`: the team's shared context. Consistent, not accidental.
3. The spend rule (§0.3) reads more sharply under this framing. It protects me from **my own
   team's committed file**, not from a stranger. That is exactly what `capped` is for, and
   exactly why `watch.json` stays global-only.

### 0.9 Two different things get cloned, and only one of them is a repository

Stated because the previous draft of §1 D4 conflated them (Juanma, 2026-08-23):

- **pr-hero itself is never cloned.** It is *installed* — `npm i -g` or a brew binary — and
  configured through `pr-hero init` and the TUI (distribution pillars 1 and 2). There is no
  "clone the engine and point at its prompts" onboarding, and no design here may assume one.
  Concretely: `SUGGESTED_AGENTS_DIR` (§0.1) pointing into a sibling checkout on one laptop is
  not a rough edge to polish, it is a **shape that stops existing** at launch.
- **The reviewed repository IS cloned**, by every teammate, and it carries the committed
  `.prhero/` of §0.8. That is the only clone the team layer depends on.

So the onboarding sentence for a teammate is *install, `init`, run* — never *clone and go*.
The one thing the bundled prompt set buys is that `agents_dir` becomes **optional**: absent
from both layers, the engine still has a set to run. (Pre-S1 its absence was a hard error
at `src/preflight.ts:1265-1270`).

### 0.10 `agents_dir` is the biggest spend lever in the file, and the team already holds it

Verified 2026-08-23. Every agent file in the current set declares its own model in
frontmatter — all five of
`/Users/juanma/Desktop/deep-review/agents/slice3b-lifecycle-v6-clean/*.md` say
`model: sonnet` — and `resolveModel` (`src/pipeline.ts:1743-1756`) resolves
`--model` > `AgentSpec.model` > **frontmatter**.

So `agents_dir` does not merely choose *which* hunters run: through the frontmatter it
chooses **what model each of them runs on**. A committed `agents_dir` pointing at a set whose
frontmatter says `opus` buys four hunters plus one refuter per severe finding at opus — an
order of magnitude past anything `summary.model`'s single cosmetic spawn could cost.

**Consequence, and it corrected this design.** An earlier draft closed `summary.model`'s team
seat on spend grounds while leaving `agents_dir` open on team-standardisation grounds
(§6 Q1). That is incoherent: it guards the small door and leaves the large one open. The
coherent position, taken here, is that **the team may choose models** — through the set and
through `summary.model` alike — because the operator sees the cost band and confirm menu
before an attended run, and `watch.json`'s `daily_cap` bounds the unattended one. What stays
`capped` is only what can run away as a *multiplier* under the watcher
(`max_verification_steps`) or silently switch spend on (`summary.enabled`).

---

## 1. Decisions

**D1. The global file is `~/.prhero/config.json`.** Same JSON dialect, same key names, same
validators as the repo file. Not a new format, not TOML, not env-only. `PrheroLayout`'s
existing `configPath` field is renamed `watchConfigPath`, the global review config arrives as a
**new and differently named** `reviewConfigPath`, and the name `configPath` is retired from the
layout entirely (§3.5).

**D2. Direction is declared per key, in ONE table, and that table IS the known-key set.**
Both parsers and the merge read it. A key added without a direction is a **compile** error
(the table is a `Record` over the key union), not a silent default. This is the roadmap's
"each key gets its direction declared explicitly, in the parser, next to the key" taken
literally, plus the only mechanism that can enforce it.

**D3. ONE precedence rule, plus two exception lists.** Stated in a sentence, because a
precedence model nobody can recite is a precedence model nobody will respect:

> **The more specific layer wins — except where the less specific one is protecting the
> operator's money or trust.**

Base order, uniform for every key: `flag` > `<repo>/.prhero/config.json` (team) >
`~/.prhero/config.json` (person) > built-in default. That is `.claude`'s model, and §0.8 says
the layers already mean the same things.

The direction table (§3.1) therefore does **not** define per-key orderings. It declares only
the two exceptions to the sentence above:

| Direction | The exception it declares |
|---|---|
| `person` | none — pure specificity. Both layers may set it; team wins. |
| `repo` | **placement**: no global answer can be right. Either the key is meaningless outside one repository (the two path lists), or a global answer would preempt a per-repo one that is already better — `default_base` sits ahead of remote-head autodetection in the chain (D4). Either way the global file rejects it loudly rather than accepting a value that could never apply. |
| `capped` | **widening**: the team layer may only make the value *narrower* than the person's. Team may spend less of my money, never more. |

**`capped` applies exactly where "narrower" is definable, and nowhere else.** A boolean has an
ordering (`false` is narrower); a count of spawns has one (fewer is narrower); a model string
does **not**. A key with no ordering cannot be capped, so it takes plain specificity — the
principle, not a compromise, and it is what settles `summary.model` (§0.10).

`capped` is what the spend rule (§0.3) requires and what pure specificity cannot express.
Pure "team wins" would let a committed file raise my bill; pure "person wins" would forbid a
team from being *more* frugal — and would break all three configs on disk today, which set
`summary.enabled: false`, a narrowing (§0.5).

**D3b. Two layers, not three.** Juanma, 2026-08-23. `.claude`'s third layer
(`settings.local.json` — mine, this repo, gitignored) is deferred, not rejected; §4 records
what it would solve so the deferral can be revisited on evidence rather than re-argued. The
merge is written as a fold over an ordered layer list, so a third layer is later a list entry
and a row in the direction table — not a rewrite.

**D4. The per-key direction:**

| Key | Direction | Why |
|---|---|---|
| `agents_dir` | `person` | my global is the default for every repo that stays quiet; a **team** that commits one is standardising which hunters review its codebase (§0.8), which is the point of the key. After pillar 1 the global default becomes the bundled set shipped inside the installed package, so the key is optional rather than mandatory (§0.9). Escape hatch without a local layer: `--agents`. |
| `default_base` | `repo` | it selects the **commit range**, and `resolveBaseRef` (`src/preflight.ts:1170-1175`) checks the config value *before* the remote head — so a global value would sit ahead of an autodetection that already solves the common case for free. Every quiet repo whose default branch differs would then review the wrong range and spend real money on a diff nobody asked for, with a plausible branch name on the plan card: verbatim the failure `src/preflight.ts:32-37` names *"a wrong answer with a plausible face"*. And the call was already made — `ROADMAP.md:1418-1419`: *"The rest — `default_base`, `parity_trigger_paths`, `suspicion_priors`, gotchas — is irreducibly per-repo and must stay there."* An earlier draft of this design classified it `person` on "costs nothing, widens no trust" grounds; that is false for the range it selects, and it overrode a prior decision without saying so. |
| `parity_trigger_paths` | `repo` | the value is a list of paths **inside this repository**. A global value is meaningless everywhere else and would silently arm or disarm the parity hunter across repos. |
| `suspicion_priors` | `repo` | same — the paths and the reasons are facts about one codebase. |
| `summary.enabled` | `capped` (boolean AND) | it spends money, and its own WHY comment says the plan must not lie about the bill. The team file may turn it **off**; it may not turn it **on** over a global `false`. `523f97c21` (§0.8) is a real narrowing and stays legal. |
| `summary.model` | `person` | settable in **both** layers, team wins by specificity, `--model` is the per-run escape. An earlier draft made it global-only for spend reasons; §0.10 killed that — the team already picks every hunter's model through `agents_dir`, which is a far bigger lever, so closing this seat guarded the small door and left the large one open. No breaking change: today's seat stays exactly as it is. |
| `max_verification_steps` | `capped` (`min` wins) | every verification step is a real spawn (`src/pipeline.ts:965`). The team file may lower it, including to `0`; it may not raise it above my ceiling. |

**D5. Flags stay on top and MAY exceed a cap.** A flag is the operator typing an intent at
the moment of spend, in front of the cost band and the confirm menu
(`src/ui-select.ts`). The cap protects the operator from the *repo*, never from themselves.

**D6. The cap is opt-in, and its absence is not a hole.** With no global value there is no
ceiling, and the repo value stands alone — which is byte-for-byte today's behaviour. C5
introduces no new restriction on anyone who never writes a global file.

**D7. The effective config and its per-key source land in `pipeline.json`.** A global file is
a new **invisible input to every run**. M6 is the standing lesson: the pilot's 12 runs became
unpoolable because `RUNTIME_PREAMBLE` entered the system prompt unconditionally with nothing
in the artifact to discriminate the builds (`ROADMAP.md` Fundamentals #2). A config value
that changes hunter input and leaves no trace in the artifact would reproduce that failure
one layer up, and it would do it to the Martian baselines that are supposed to stay
re-readable at $0. Non-negotiable.

**D8. Zero new keys, and `watch.json` is not touched.** One variable per experiment. The
size gate does not gain a config seat; scout does not gain one; watch keeps its own file, its
own tolerant parser, and its sole ownership of automatic spend.

**D9. The merge happens BEFORE the six resolvers, and none of them changes how it DECIDES.**
They keep receiving one `LocalConfig` on the engine path; it is now the *effective* one, and
the precedence each of them applies is untouched. That is the whole of D9's promise, and the
promise it is easy to overclaim past — an earlier draft of this line said "one signature-only
amendment … no resolver body moves", which the final judgment falsified on three counts
(RES-1). The honest blast radius:

| Resolver | What C5 does to it | Why |
|---|---|---|
| `resolveSummary` (`src/preflight.ts:1635`) | parameter widens to a shape `ConfigLayer` also satisfies | it reads only `config.summary` (`:1639`, `:1641`); `scripts/m6.ts:154` **and** `test/preflight.test.ts:832` hand it a raw parsed layer |
| `resolveMaxVerificationSteps` (`:1631`) | same parameter widening | same reason — `test/preflight.test.ts:853` hands it a raw layer too |
| `resolveAgentsDirSetting` (`:1194-1218`) | **body moves**: `AgentsDirSource` drops `"config"` for `"repo"`/`"global"` (§3.6), so the `source: "config"` return at `:1207` and the hard-error text at `:1213-1217` both change | the plan card has to name *which* layer won (O-7), which the old three-member union cannot express |
| `resolveBaseRef`, `sizeGateConfig`, the watch per-repo chain | untouched | they never see a layer |

Three resolvers, not one, and one of them is not signature-only. Two of the raw-layer callers
live in `test/`, so "scoped to a caller outside the engine" was wrong as well.

**D10. `pr-hero config` ships WITH the merge, read-only.** Two layers that cannot be
inspected are worse DX than one layer that can: the first question a teammate asks is "why is
this value what it is", and today the answer is "read two files and know the rules". The
command prints the effective config with the layer each value came from, and marks any value
a cap narrowed. It is the operator-facing half of the `sources` record D7 already requires —
the data exists either way, so this is a renderer, not a mechanism. Editing config from menus
stays distribution pillar 2.

---

## 2. Obligations — the acceptance criteria this is checked against

- **O-1** A config key that exists without a declared direction does not compile.
- **O-2** The global file rejects a `repo` key by name, and the error names the fix
  (`put parity_trigger_paths in <repo>/.prhero/config.json`).
- **O-3** The team file's admitted key set is **unchanged** from today — C5 adds no rejection
  there, and every config that parses before the change parses after it (§3.9).
- **O-4** A `capped` key narrows from the repo and never widens: `min` for the number,
  boolean AND for `summary.enabled`, in both orders and with either side absent.
- **O-5** With no `~/.prhero/config.json`, every resolved value is identical to today's —
  including the no-repo-file path that `EMPTY_LOCAL_CONFIG` covers today (§3.3 changes what
  produces that shape, never what it resolves to) and the `--config`-missing `CliError`, both
  of which §0.7 shows are currently untested.
- **O-6** `pipeline.json` records the effective config and, per key, which layer produced it.
- **O-7** The plan card names the source of any value that did **not** come from the repo
  file, so the operator is never surprised by a value they cannot see in the checkout.
- **O-8** Config is still never read from the review worktree; the global file is read from
  `os.homedir()` in both local and PR mode, and PR mode still reads the repo file from the
  operator root.
- **O-9** `init` does not write a `person` key — `agents_dir` or `summary.model` (D4) — into the
  repo file when the global file already supplies it; otherwise C5 ships the duplication it
  exists to delete.
- **O-10** The three `musive` configs of §0.5 keep parsing and resolve to the same effective
  values they do today.
- **O-11** `ROADMAP.md` tells the truth after this slice: the C5 entry's stale anchors resolve
  (§0.0), and pillar 2's launch-config table — `ROADMAP.md:157-165` — needs **two** changes, not
  one.
  1. A new `~/.prhero/config.json` row. The table's axis is *Where*, and it already gives
     `~/.prhero/watch.json` a row of its own (`:163`), so a new global layer with no row would
     leave the table understating the launch config surface.
  2. `max_verification_steps` added to the `.prhero/config.json` row (`:161`). That row lists
     five knobs today and omits a key that is repo-settable *right now* — declared at
     `src/preflight.ts:1485`, admitted by the parser at `:1531` — under a caption that reads
     "existing knobs only" (`:157`). C5 does not create that gap, but an obligation headlined
     "`ROADMAP.md` tells the truth after this slice" cannot bless a row that understates the
     surface it is enumerating. The row also keeps `summary.model`, which stays correct (§3.9).

  A design that fixes stale citations and creates one in the same commit has fixed nothing —
  which is what this obligation itself did until round one, when it cited `:150` (the last line
  of pillar 1's prose, `:148-150`) for a table that begins at `:157`; and until round two, when
  it still called `:161` correct as written.
- **O-12** `pr-hero config` prints every key's effective value and its layer, and says so for
  a value a cap narrowed. Read-only: it never writes either file.
- **O-13** After the rename, no identifier named `configPath` survives on `PrheroLayout`. Every
  consumer therefore reads `watchConfigPath` or `reviewConfigPath`, or it fails to compile —
  the only mitigation that covers all 19 call sites in `src/watch.ts` without enumerating them
  (§3.5). **And the one consumer that mitigation cannot reach is renamed by hand:**
  `WatchStatusFacts.configPath` (`src/watch-preflight.ts:1166`) becomes `watchConfigPath`, with
  its three render sites (`:1189`, `:1195`, `:1200`) and `src/watch.ts:907` following. It is a
  different type's field, so it keeps compiling either way — an implementer could satisfy every
  other criterion here and still leave the outcome §3.5 calls wrong.
- **O-14** A key no layer named reports `source: "default"` — whether both files are missing or
  a file exists and simply omits the key, and including `parity_trigger_paths` and
  `suspicion_priors`. Their absence survives because `parseLocalConfig` **stops materialising**
  them (§3.2); `ConfigLayer` only makes that legal to express. The type change alone satisfies
  nothing, which is why §5 row 14 tests the omitted-key case and not just the missing-file one.

---

## 3. Mechanisms

### 3.1 The direction table — one source of truth

Lives in `src/preflight.ts`, immediately above `LocalConfig`, because "next to the key" is
the roadmap's wording and the only place a reader will look.

```ts
export type ConfigDirection = "person" | "repo" | "capped";

// Declared per key, and this table IS the known-key set for both parsers and
// the merge. A key added to LocalConfig without a row here fails tsc — the
// roadmap's "an undeclared key is a bug, not a default", enforced rather than
// asked for. The `capped` rows exist because watch-preflight.ts:43-47's spend
// rule is DIRECTIONAL: the danger is a repo enlarging the operator's bill.
export const CONFIG_DIRECTION: Record<keyof LocalConfig, ConfigDirection> = {
  agents_dir: "person",
  default_base: "repo",
  parity_trigger_paths: "repo",
  suspicion_priors: "repo",
  summary: "capped",            // per-field below — the two fields differ
  max_verification_steps: "capped",
};

export const SUMMARY_DIRECTION: Record<keyof SummaryConfig, ConfigDirection> = {
  enabled: "capped",
  model: "person",
};
```

`summary` is the one key whose two fields disagree, so the merge descends into it (§3.3).
That is the entire justification for the second table — no other key is nested.

The table keeps ranging over `keyof LocalConfig` even though the parsers now return a
`ConfigLayer` (§3.2), because `ConfigLayer` is a mapped type over `LocalConfig` and
`keyof ConfigLayer` is therefore the identical key union: optionality lives on the property,
never on the key. One table, one union, and adding a key to `LocalConfig` still fails tsc
until it has a row — for both parsers and the merge alike.

### 3.2 `ConfigLayer` and `parseGlobalConfig`

The parsers do **not** return `LocalConfig`. They return a layer:

```ts
// What a layer SAID, not what the engine will use. Every key optional,
// including the two arrays that LocalConfig declares required
// (src/preflight.ts:1473-1475) — because a merge whose currency cannot
// represent absence has already destroyed the fact it needs to fold on, and
// would report `repo` for a key no repo ever set.
export type ConfigLayer = Partial<LocalConfig>;
```

This type change is forced rather than chosen. `parseLocalConfig`'s return object
(`src/preflight.ts:1575-1584`) writes `parity_trigger_paths` and `suspicion_priors`
**unconditionally** (`:1576-1577`) because `LocalConfig` requires them, and
`EMPTY_LOCAL_CONFIG` (`:1498-1501`) does the same for a missing file. Under that shape a global
parser that *rejects* those two keys cannot return a `LocalConfig` without fabricating exactly
what it rejected, and `source: "default"` is unreachable for them forever. A `ConfigLayer` keeps
absence alive until the fold is done with it; §3.3 materialises the arrays once, at the end.

`parseGlobalConfig` is then a sibling of `parseLocalConfig`, sharing every field validator
(`optionalString`, `parseSummaryConfig`'s field checks, `parseMaxVerificationSteps`) and
differing only in the admitted key set and the error vocabulary:

- admits keys whose direction is `person` or `capped`;
- rejects each of the three `repo` keys — `default_base`, `parity_trigger_paths`,
  `suspicion_priors` — with a message templated over the offending key, never a fixed example:
  `~/.prhero/config.json: <key> is a per-repo key — put it in <repo>/.prhero/config.json`. §3.7
  requires every rejection to name the key it is about, and one hardcoded key name across three
  rejections would send two of the three operators looking for the wrong line;
- rejects a genuinely unknown key exactly as the local parser does.

`parseLocalConfig` gains **no** new rejection: after §0.10 no key is global-only, so the team
file's admitted set is unchanged from today. The keys it admits, the validators it runs and the
error text it throws are byte-identical. That asymmetry is deliberate: the global file rejects
the keys no global answer could get right (D3's `repo` row), while the team file rejects nothing
new.

**But its return type widening to `ConfigLayer` is not the change — it is only the permission to
make it.** Widening a return type moves no runtime value: `:1576-1577` would keep writing
`parity_trigger_paths: triggers as string[]` and `suspicion_priors: priors as SuspicionPrior[]`
on every parse, so a repo file that *exists and omits an array key* would still hand the merge a
materialised `[]`, the fold would still see the repo layer speak, and provenance would still
report `repo` where the truth is `default`. A merge whose input cannot represent absence cannot
produce truthful provenance, and O-14 would be unsatisfied by a change that type-checks
perfectly.

So the required edit is behavioural: `parseLocalConfig` **stops materialising the two arrays**.
Both become conditional spreads, exactly like the four siblings already beside them at
`:1578-1583` (`...optionalString(config, "agents_dir")`, the `summary` spread, the
`max_verification_steps` spread) — present in the returned layer only when the file named them.
The `?? []` locals at `:1538` and `:1548` stay exactly as they are: they feed the validators, and
validating an absent key against the empty array is what keeps the error text byte-identical.
Absence then survives the parse for all six keys, which is the property §3.3 folds on and the
only reason `source: "default"` is reachable.

**One existing test pins the shape this edit changes, and it is the only one** (RES-2). At
`test/preflight.test.ts:737-742`, `parseLocalConfig admits both keys as optional` asserts
`toEqual({ parity_trigger_paths: [], suspicion_priors: [] })` against `parseLocalConfig("{}")`.
The changed parser returns `{}`, so that test goes red and must be re-pointed at the new
contract — an absent key is absent, not empty. It is named here because §3.5 enumerates every
pinned literal the *rename* touches and the *parser* change deserves the same courtesy; the
final judgment recorded its omission. Nothing else in `test/` asserts the returned shape —
the other `parseLocalConfig` tests read individual keys or assert throws.

Both stay **strict**. `parseWatchConfig`'s tolerance (§0.6) is not copied here: it exists
because `upsertWatchRepo` rewrites that file programmatically, and nothing rewrites these.

### 3.3 `mergeConfig` — pure

```ts
// Which layer produced each effective value. "capped" means the repo spoke and
// a global ceiling narrowed it away — distinct from "global", because the
// operator needs to see that a cap BOUND, not merely that a global existed.
// "default" means neither file spoke and the downstream resolver's own fallback
// decides.
export type ConfigSource = "global" | "repo" | "capped" | "default";

// `summary` gets an explicit per-field seat rather than one entry, because its
// two fields have DIFFERENT directions (§3.1) and a flat
// `Record<keyof LocalConfig, ConfigSource>` cannot say
// `{ enabled: "capped", model: "global" }`. It is the only nested key, so this
// is one seat, not a pattern.
export type ConfigSources = Record<
  Exclude<keyof LocalConfig, "summary">,
  ConfigSource
> & {
  summary: Record<keyof SummaryConfig, ConfigSource>;
};

export function mergeConfig(
  global: ConfigLayer | undefined,
  repo: ConfigLayer,
): { effective: LocalConfig; sources: ConfigSources };
```

**The fold's currency is `ConfigLayer`; only its result is a `LocalConfig`.** That asymmetry is
the whole point of §3.2's type. Inside the fold every key can be absent, so "neither layer
spoke" is a state the merge can observe and label; the `[]` that `LocalConfig` requires for
`parity_trigger_paths` and `suspicion_priors` is materialised **once, at the end**, when the
effective config is assembled. Downstream is untouched — on the engine path the six resolvers
still receive one `LocalConfig`, exactly as D9 promises, and they cannot tell how it was built.

The consequence is the one D7 and O-6 need: `source: "default"` is reachable for **every** key,
including the two arrays. Two cases, and the second is the one that only §3.2's parser change
buys: a repo with no `.prhero/config.json` and no global file reports `default` for all six
rather than claiming `repo` for two of them; and a repo whose file **exists and omits** an array
key reports `default` for it too, instead of `repo` for a value that file never named. That is
what §5 row 12's "a key absent from both files" case already assumes and what `pr-hero config`
(O-12) would otherwise print as a lie.

`EMPTY_LOCAL_CONFIG` changes role rather than disappearing. It is no longer what a missing file
hands the merge — a missing file yields an absent `ConfigLayer`, which is the point — it is the
effective-config shape produced when no layer spoke at all. Same bytes reaching the resolvers,
a different thing said about them.

The signature takes the two layers by name today, but the body is a **fold over an ordered
layer list**, least specific first. D3b's deferred `config.local.json` is then one entry
appended to that list plus its column in the direction table — not a rewrite of the merge.

Rules, one per direction, applied as each layer folds in:

- `person` — the more specific layer wins if it spoke; else the previous one stands.
- `repo` — only the team layer may speak. The key is optional in `ConfigLayer` and §3.2
  guarantees `parseGlobalConfig` rejected it at parse time, so a global value cannot exist and
  the fold has nothing to resolve.
- `capped` — both absent → absent. One present → that one. Both present → the **narrower**:
  `Math.min` for `max_verification_steps`, `a && b` for `summary.enabled`. When the team's
  value was narrowed away, the source is `"capped"`, not `"repo"` — the operator has to be
  able to see that a cap bound, which is the whole point of O-12.

No deep merge anywhere else: arrays and objects are replaced whole. `summary` is descended
into per-field and reassembled; every other key is a scalar.

### 3.4 `loadEffectiveConfig` — the impure shell

```ts
loadEffectiveConfig({ root, home, configFlag })
  → { effective, sources, repoConfigPath, globalConfigPath, globalPresent }
```

`globalPresent` is a **fifth field and not a redundancy** — corrected during implementation. It
is not derivable from `sources`: a global file that exists and says `{}` leaves every key at
`repo` or `default`, indistinguishable from no file at all, and O-6's `global_present` has to
tell those apart. The parameter is `root`, not `repoRoot`, because in PR mode it is the
operator root and `repoRoot` reads as the reviewed repo.

Replaces the duplicated block at `src/cli.ts:510-518` and `:957-965`. In PR mode `root`
is the **operator** root, unchanged (O-8). `--config` overrides the repo path only; the
global file is never overridden by a flag, because a flag pointing the global layer somewhere
else is a footgun with no use case.

One behavioural detail those two blocks lose in the move, and it is the shell half of §3.2's
type change: a file that does not exist yields an **absent layer**, not a substituted
`EMPTY_LOCAL_CONFIG`. Today `src/cli.ts:518` and `:965` substitute the constant, which is where
absence dies; here the constant is never handed to the merge, and `mergeConfig` decides what an
all-silent run resolves to. The `--config`-missing `CliError` (`src/cli.ts:513-515`, `:960-962`)
is unchanged: an explicitly named file that is not there is still an error, not an absent layer.

`agents_dir`'s relative-path rule (§0.1) travels with the file that named it: relative in the
global file resolves against `~/.prhero/`, relative in the repo file resolves against
`<repo>/.prhero/` exactly as today. `resolveAgentsDirSetting` therefore needs the `configDir`
of the *winning* layer — the one place the merge's source record is load-bearing at runtime
rather than for display.

### 3.5 The layout rename, and why nothing is called `configPath` afterwards

`PrheroLayout.configPath` → `watchConfigPath`, and the global review config arrives as a new
field with a **different name**: `reviewConfigPath` = `~/.prhero/config.json`. The name
`configPath` is retired from the layout; no field on `PrheroLayout` carries it after this
slice.

That retirement is the mechanism, not a naming preference: **an identifier reused for a
different file of the same type cannot be caught by tsc; an identifier that no longer exists
can.** Re-pointing `configPath` from `watch.json` to `config.json` would keep both the name and
the `string` type, so every un-migrated call site would compile and silently read the wrong
file. Delete the name and every un-migrated `paths.configPath` is a compile error instead —
which is the only mitigation that actually works here, because there is no test that can
enumerate call sites the way the type checker can.

The blast radius, counted rather than sampled: `rg "paths\.configPath" src/watch.ts` returns
**19** sites — `:172`, `:174`, `:180`, `:679`, `:773`, `:776`, `:815`, `:816`, `:835`, `:841`,
`:867`, `:868`, `:872`, `:877`, `:880`, `:881`, `:894`, `:896`, `:907`. Every one of them means
`watch.json` and every one becomes `watchConfigPath`; under the retired name, missing one does
not build.

`watchRemove` (`src/watch.ts:861-883`) is why sampling a subset is not good enough. Its
existence guard at `:867` sits in the *same body* as the read at `:872` and the write at
`:880`. Migrate the read and the write, miss the guard, and one function reads two different
files: `pr-hero watch remove` would gate on the presence of the global **review** config and
log `not listed` on a machine that has a `watch.json` and no `config.json`. `watchStatus`
(`src/watch.ts:889-925`) has the same shape across `:894`, `:896` and `:907`.

Two consumers live outside `src/watch.ts`, and they are not symmetrical:

- `WatchStatusFacts.configPath` (`src/watch-preflight.ts:1166`), rendered at `:1189`, `:1195`
  and `:1200` and fed from `src/watch.ts:907`, is a **different type's** field. It keeps
  compiling after the retirement — `src/watch.ts:907` merely becomes
  `configPath: paths.watchConfigPath` and tsc is satisfied — so it is the one consumer O-13's
  mechanism provably cannot catch. It has to be renamed `watchConfigPath` **by hand**, along with
  its three render sites and the `renderWatchStatus` fixture that pins it
  (`test/watch-preflight.test.ts:1780`). O-13 carries that hand-rename explicitly, because a
  mechanism that cannot enforce a rule has to be paired with an obligation that states it.

  The impact is naming hygiene, not a runtime defect, and it is worth saying so plainly so nobody
  over-reads this bullet: `renderWatchStatus` prints the hardcoded **label** `config` — the first
  argument of `row(…)`, at `:1189`, `:1194` and `:1200` — and never the field name, which it only
  ever reads (`facts.configPath` at `:1189`, `:1195`, `:1200`). The operator's status output is
  therefore byte-identical either way. What is at stake is the next reader of `WatchStatusFacts`,
  who would find a bare `configPath` in a codebase where that name has been deliberately retired
  as ambiguous — the exact ambiguity §3.5 exists to delete.
- The pinned layout literals fail loudly, which is the point. `test/home-preflight.test.ts:30-38`
  asserts the whole `prheroLayout` object with `toEqual` (`configPath` at `:33`), and
  `test/watch-preflight.test.ts:1374-1383` does the same for `prheroHomePaths` (`configPath` at
  `:1377`, the literal closing after `metricsDbPath` and `plistPath` at `:1381-1382`). The rename
  is a rename, not an addition, and those pinned literals are what stop a silent reinterpretation
  of an existing field.

### 3.6 Provenance: `pipeline.json` and the plan card

`PipelineInput` gains one optional field, in the same style as the item-7 and scout
provenance blocks already there (`src/pipeline.ts:129`):

```jsonc
"config": {
  "effective": { /* the merged LocalConfig, as resolved */ },
  "sources":   { "agents_dir": "global", "default_base": "repo", ... },
  "global_present": true
}
```

Optional, so every existing artifact stays valid. `AgentsDirSource` (`src/preflight.ts:1207`)
widens from `"flag" | "config" | "env"` to `"flag" | "repo" | "global" | "env" | "default"` so the plan
card can say *where*, and `resolveAgentsDirSetting` resolves the bundled default.

Plan card (O-7): a value that came from the global layer, or that a cap narrowed, is tagged.
A value from the repo file is not — that is the unsurprising case and the card is already
dense. Renderers keep the three acceptance criteria from `CLAUDE.md`: `string[]`, styles and
width as parameters, a test asserting zero `\x1b` bytes with styles off.

### 3.7 Error vocabulary

Every rejection names three things: the file it is in, the key, and the file it belongs in.
This follows `parseWatchConfig`'s ledger-style discipline (§0.3) for the same reason — a
mis-read config either burns money in the wrong place or silently does nothing.

### 3.8 Migration: none

The three configs of §0.5 parse unchanged and resolve unchanged (O-10). A person who wants the
ergonomic win writes `~/.prhero/config.json` once and deletes the **hoistable** lines from each
repo; nothing forces them to. Those are `agents_dir` (`person`) and the `summary` block, whose
two fields hoist for different reasons: `summary.model` is a `person` key that a global value
simply supplies, while `summary.enabled` is `capped`, so hoisting a global `false` is a ceiling
the repo file no longer has to restate. Naming the block "the person lines" would be wrong about
`summary.enabled`'s direction (D4, `SUMMARY_DIRECTION` in §3.1), and in a design whose central
mechanism is a per-key direction table, mislabelling a direction in the migration note is how the
table stops being believed.

`default_base` is deliberately not on that list even though §0.5 shows it duplicated. It is a
`repo` key (D4), the global file rejects it by name (§3.2), and hoisting it is precisely the
wrong-range failure the classification exists to prevent. The three configs keep their
`"default_base": "dev"` and stay legal, which is why O-10's fixture still resolves unchanged.

`init`'s change (O-9) means new repos never acquire the person-key duplication in the first
place.

### 3.9 There is no breaking change

Retired 2026-08-23. This section previously removed `summary.model`'s team seat; §0.10 killed
that reasoning and Juanma kept the feature in both layers. Every key that parses today parses
after C5, with the same meaning. The only new rejections are in the *global* file, and only for
the three `repo` keys, which no global file could have answered correctly (§3.2, D4) — that
file does not exist today, so nothing on disk can start failing. Kept as a heading so the
change of mind is visible rather than silently rewritten.

Historical note, since it is the one number that mattered: zero configs on this machine set
`summary.model` (§0.5), `DEFAULT_SUMMARY_MODEL` is only a plan label
(`src/preflight.ts:40-43`) and an init-template seed (`:1675`), and `--model` covers the
per-run case. That made removal *cheap*, never *right*.


### 3.10 `pr-hero config` — the read-only surface (O-12)

A new verb beside `ledger` / `triage` / `gc` / `reverts` / `corpus`. It resolves both layers
exactly as a review would — the same `loadEffectiveConfig`, so what it prints cannot drift
from what actually runs — and renders one row per key: value, layer, and a marker when a cap
narrowed it. It names both file paths whether or not they exist, because "where do I even
write this" is the other half of the question a teammate is asking.

A pure renderer over `{ effective, sources }`, so it inherits `CLAUDE.md`'s renderer criteria
without exception: returns `string[]`, never calls `log()`, takes styles and width as
parameters, and carries a test asserting zero `\x1b` bytes with styles off.

Not in scope: writing, prompting, menus. `pr-hero config` answers; it does not edit.

---

## 4. What C5 does NOT do

- **No new keys.** No config seat for the size gate (`src/size-gate.ts:489-500` stays
  flag-or-default), none for scout (`src/preflight.ts:81-87` stays a loud rejection).
- **`watch.json` is untouched** — same file, same tolerant parser, same sole ownership of
  automatic spend. C5 adds a *sibling* under `~/.prhero/`; it does not merge with it.
- **The six resolvers are not unified.** They keep their independent chains. C5 changes what
  they are handed, not how they decide.
- **No third layer** (`<repo>/.prhero/config.local.json` — mine, this repo, gitignored).
  Deferred by Juanma 2026-08-23: not enough value today. Recorded here so the deferral is
  revisited on evidence rather than re-argued from zero — what it would have solved:
  (a) `523f97c21`'s exact shape (§0.8), a personal preference with nowhere to live but the
  team's committed file; (b) overriding a team's `agents_dir` or `summary.model` on one
  machine without typing `--agents` / `--model` every run — with two layers the team wins
  those by specificity and a flag is the only per-run exit. The trigger to revisit is the
  first time a second person's preference has to be committed to a shared file. D3b keeps
  the merge a fold over an ordered layer list so this stays an entry, not a rewrite.
- **No wizard, no TUI, no menus** — distribution pillar 2. `pr-hero config` (§3.10) reads;
  it never writes.
- **No org- or remote-level configuration.** A config server, org policy across repos, or
  anything that resolves over the network is a different product, not a later C5.
- **No bundled prompt set** — distribution pillar 1. C5 is what makes that bundled path
  expressible as a default; shipping it is that pillar's work.
- **No new env vars.** `PRHERO_AGENTS_DIR` keeps its existing last-resort seat.
- **No config-driven model routing.** Per-hunter model picking stays Phase D.
- **`scripts/` does not gain the merge — but it does need two forced lines, and it keeps one
  known divergence.** Three separate things, and the first is not optional.

  1. **Required, because §3.2's parser change breaks it.** `scripts/m6.ts:151-153` assigns
     `parseLocalConfig`'s result and then dereferences `config.parity_trigger_paths.length`
     **unguarded** at `:161` and at `:219`. The moment the parser stops materialising that array
     (§3.2), both lines throw a `TypeError` on any target repo whose config omits the key — and
     CLAUDE.md records that `scripts/` is covered by **neither** `bun run typecheck` **nor**
     `bun run check`, so nothing in the offline gates catches it. Both sites take `?? []`. Two
     lines, in the same commit as the parser change, or `m6 plan` is broken silently.
  2. **Two resolver signatures widen with it, and the callers are not only in `scripts/`.**
     `:154` passes that same value to `resolveSummary(options, config: LocalConfig)`
     (`src/preflight.ts:1635-1638`), which a `ConfigLayer` no longer satisfies;
     `resolveMaxVerificationSteps(config: LocalConfig)` (`:1631-1633`) has the same problem via
     `test/preflight.test.ts:853`, and `resolveSummary` is handed a raw layer at
     `test/preflight.test.ts:832`. Both read one property, so widening each parameter to a shape
     `LocalConfig` and `ConfigLayer` both satisfy is sufficient and no logic moves. D9's table
     carries the full picture — including the third resolver, `resolveAgentsDirSetting`, whose
     body genuinely does move for a reason unrelated to this bullet.
  3. **The divergence that remains, and it is not the one this bullet used to name.** m6 never
     reads `max_verification_steps` at all — `rg` over `scripts/m6.ts` returns zero hits — so
     the old claim about a global ceiling was about a key with no pricing effect. The real
     divergence is `summary.enabled`: `:154` resolves the summarizer from the target repo's file
     alone, so a global `summary.enabled: false` is invisible to `m6 plan`, which would price the
     summarizer **on** for all 56 runs. That is verbatim the failure `scripts/m6.ts:145-149`
     exists to prevent — *"an assumed default-on summarizer would over-price all 56 runs by a
     full agent seat"*. Accepted deliberately: M6 is decided and its 56-run reopening is a
     separate, budgeted decision (`ROADMAP.md` Fundamentals #2), and wiring `loadEffectiveConfig`
     into a directory neither gate checks buys an unverifiable change. Whoever reopens M6 reads
     this bullet first and passes the operator's global layer in deliberately.

---

## 5. Done-checklist — one named test per obligation

| # | Obligation | Test |
|---|---|---|
| 1 | O-1 | `CONFIG_DIRECTION covers every LocalConfig key` — iterates `Object.keys` of a fully-populated `LocalConfig` fixture against the table; the type-level guard is the `Record`, this is the runtime witness. |
| 2 | O-2 | `parseGlobalConfig rejects a repo key and names the repo file` — one case per `repo` key, so the table covers all three: `parity_trigger_paths`, `suspicion_priors` and `default_base` (D4). |
| 3 | O-3 | `parseLocalConfig admits the same keys it does today` — including `summary.model`, asserted against the pre-C5 key list so a future narrowing has to be deliberate. |
| 4 | O-4 | `mergeConfig narrows capped keys in both directions` — `min` for `max_verification_steps` (incl. repo `0` beating global `8`), boolean AND for `summary.enabled` (all four combinations), and each with the other side absent. |
| 5 | O-5 | `loadEffectiveConfig with no global file resolves exactly as today` — table-driven over all six keys, plus `no repo config resolves to the EMPTY_LOCAL_CONFIG shape` (reached through an absent layer now, §3.3) and `--config pointing at a missing file throws CliError` (the §0.7 gap, closed). |
| 6 | O-6 | `pipeline.json records effective config and per-key sources` — asserted at artifact level over a real run dir, the way C4's preamble test does. |
| 7 | O-7 | `plan card tags a global-sourced value and a capped one` — over `string[]`, with a companion asserting zero `\x1b` bytes with styles off. |
| 8 | O-8 | `PR mode reads the repo config from the operator root and the global from home` — fake fs with a decoy `config.json` inside the head worktree that must be ignored. |
| 9 | O-9 | `init omits agents_dir from the repo template when the global supplies it`. |
| 10 | O-10 | `the three musive-shaped configs resolve unchanged` — the §0.5 bytes as a fixture. |
| 11 | O-11 | not a test: `ROADMAP.md`'s C5 entry re-anchored, and pillar 2's launch-config table (`:157-165`) given **both** edits — a `~/.prhero/config.json` row beside the `~/.prhero/watch.json` one it already has (`:163`), and `max_verification_steps` added to the `.prhero/config.json` row (`:161`), which omits it today. All three verified by re-reading the cited lines. |
| 12 | O-12 | `pr-hero config names the layer behind every value` — one case per direction, including a value a cap narrowed (source `capped`, not `repo`) and a key absent from both files (source `default`); plus the zero-`\x1b` companion. |
| 13 | O-13 | `prheroLayout exposes watchConfigPath and reviewConfigPath and no configPath` — the `toEqual` literal at `test/home-preflight.test.ts:30-38` updated to the new field list, and the same pin on `prheroHomePaths` (`test/watch-preflight.test.ts:1374-1383`). Plus `WatchStatusFacts names watchConfigPath` — the `renderWatchStatus` fixture (`test/watch-preflight.test.ts:1780`) updated to the renamed field, which is the only witness for the hand-rename O-13's mechanism cannot catch; its rendered lines must not move, since the label is `config` either way. The 19 `src/watch.ts` call sites need no test: under the retired name they are a `bun run typecheck` failure, which is the mechanism. |
| 14 | O-14 | `absence survives the parsers and reports default` — two cases, because only the second can detect the residue. (a) No global file and no repo file: `source: "default"` for all six keys, while the effective config still hands the resolvers `[]` for `parity_trigger_paths` and `suspicion_priors`. (b) A repo `.prhero/config.json` that **exists and omits** `parity_trigger_paths`: it must report `source: "default"`, not `repo`. Case (a) alone passes against an unfixed parser, because §3.4 routes a missing file through the absent-layer path and never calls `parseLocalConfig` at all; only (b) proves the parser stopped materialising (§3.2). |

Offline gates as usual (`bun test`, `bun run typecheck`, `bun run check`) — **plus one gate they
do not give you**. §4's `scripts/m6.ts` change lives in a directory neither `typecheck` nor
`check` covers (CLAUDE.md records the gap), so it needs an explicit typecheck and lint over
`scripts/m6.ts` — **not with `bunx`, and this design said `bunx` in an earlier draft**:
`bunx biome check` resolves to an abandoned package that checks nothing and exits 0 (this repo's
own corpus, `docs/scout-design.md:344`, records a CI gate green for 18 days on exactly that), and
`bunx tsc --noEmit <file>` drops out of project mode and ignores `tsconfig.json`. Use
`./node_modules/.bin/biome`, reconstruct tsc's project flags, and validate the recipe against an
unchanged sibling first. Then a `bun run scripts/m6.ts plan` against a target repo
whose config omits `parity_trigger_paths`. Without that, the two `?? []` lines are the one part
of this slice that can ship broken with every gate green.

No live spend is required to close C5 — it changes no prompt, so `promptSetFingerprint` does not
move and the frozen Martian/Cal.com baselines stay comparable. `m6 plan` is $0 by construction.
One `fixture-eval` at the end is a cheap witness that the two rewritten read sites still feed a
real run.

---

## 6. The calls — Juanma's, not a session's. All three closed 2026-08-23.

**Q1 — CLOSED 2026-08-23, by the team requirement rather than by opinion.**

The question was whether `agents_dir` should be global-only, because `.prhero/` can be
committed and a relative `agents_dir` resolves against the config file's directory
(`src/preflight.ts:1190-1193`) — so a committed `"agents_dir": "./prompts"` makes whoever
pushes to that repo the author of the reviewer's prompt set.

It is closed by §0.8: the repo layer **is** the team layer, and a team standardising which
hunters review its codebase is the use case the key exists for. Global-only would forbid it.

Two supports. First, the concern is not about the PR author — §0.2 keeps them out entirely,
and the global file is read from `os.homedir()`, further still. It is about a committed file
in the operator's own checkout. Second, `gotchas.md` is equally powerful, lives in the same
directory, is equally committable, and is injected into every prompt **by design** —
`src/pipeline.ts:641-646` makes it *required*, fail-loud (`ROADMAP.md`'s C6 entry still cites
the stale `:379`). The doctrine already grants the team checkout this class of power
deliberately; singling out `agents_dir` would be inconsistent, not safer.

What survives as a separate question, for both keys and not as a C5 side effect: *may a
committed `.prhero/` steer the reviewer at all?* Today's answer is yes, on purpose. Whoever
reopens it reopens it for `gotchas.md` too.

**Q2 — CLOSED 2026-08-23. `summary.model` keeps its team seat and gains a global one.**

Asked as "remove the repo seat outright, or deprecate?" Juanma: *"es una feature, vamos a
dejarla"*, and separately confirmed it may also be configured globally. Both layers, then.

The reason removal was wrong is §0.10, not the preference: the team already picks every
hunter's model through `agents_dir`'s frontmatter, which dwarfs one cosmetic summary spawn.
Guarding the small door while the large one stands open is not a safety posture. §3.9 is now
"there is no breaking change".

**Q3 — CLOSED 2026-08-23. `~/.prhero/` is the product's home.**

Juanma, verbatim: *"`.prhero` es la casa del producto, allí vive todo tipo de config incluido
watcher entre otras cosas."* That ratifies D1 and §3.5's rename: the watcher is a tenant, not
the landlord, so the layout's `configPath` field may stop being the watcher's. In §3.5 it
becomes `watchConfigPath` and the bare name is retired rather than re-pointed — the file it
named is unchanged, only its seat in the layout is.

What it does **not** authorise, so nobody reads it as a mandate later: merging `watch.json`
into the new file. One home, separate files, unchanged in this slice (D8) — `watch.json` has
a tolerant parser that `upsertWatchRepo`'s rewrite depends on (§0.6) and sole ownership of
unattended spend (§0.3), and folding it in would be a second variable. A future consolidation
is now *thinkable* under this ratification; it is not part of C5.

---

**Nothing else is open.** With Q1, Q2 and Q3 closed, this design is ratified and
implementable as written.
