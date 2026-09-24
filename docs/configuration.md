# Configuration, Routing and Credentials

An operator guide: where config lives, how to route a model to a backend and provider, which
credentials pr-hero reads and from where, and how to check all of it without spending money.
For the architecture and the reasoning behind these rules, see
[`docs/multi-runtime-model-diversity-design.md`](multi-runtime-model-diversity-design.md). For the
day-to-day config keys and the two-layer merge rule, see the README's
[Configuration — two layers](../README.md#configuration--two-layers) section first — this document
covers the two things that section does not: `routing` and credentials.

## Quick path

1. `pr-hero config` — every key's effective value and which layer it came from. Read-only, $0.
2. `pr-hero doctor` — probes the *real* binding: binary, credential, isolation, billing mode. Read-only, $0.
3. `pr-hero review --dry-run` — resolves the plan and prints the cost band without spawning anything. $0.

## Where a key belongs, and the two traps

| Layer | File | Holds |
| --- | --- | --- |
| Global / per-person | `~/.prhero/config.json` | `routing`, personal caps (`max_verification_steps`, `max_changed_lines`, `max_changed_files`) |
| Repo | `<repo>/.prhero/config.json` | `agents_dir`, `default_base`, `parity_trigger_paths`, `suspicion_priors`, gotchas |

`routing` is a **person-layer-only** key. Put it in a repo file and the parser refuses it by name:

```
.prhero/config.json: routing is a per-person key — put it in ~/.prhero/config.json
```

The reverse also throws (a repo-only key in the global file gets ` is a per-repo key — put it in
<repo>/.prhero/config.json`). Run `pr-hero config` to see, per key, which of the two files actually
spoke.

**`--config <file>` replaces the repo layer only.** There is no flag that repoints the global one —
it is always read from `os.homedir()`. Pointing `--config` at a file that contains `routing` hits the
same per-person rejection above, because `--config` still parses as a repo-layer file.

## CI: routing is a GitHub Actions variable, not an environment variable

Nothing in the engine reads a `PRHERO_ROUTING` environment variable directly. `PRHERO_ROUTING` is the
*repository variable name* the scaffolded workflow uses to fill the action's `routing:` input
(`vars.PRHERO_ROUTING`). The action passes that input to its setup step as the `ROUTING_INPUT`
environment variable, which then gets parsed and written to `$HOME/.prhero/config.json` on the
runner — the same global layer described above, never the repo file. Full wiring (secrets, the
`opencode-auth` input, pinned OpenCode CLI version, budget ceilings) is in
[`docs/github-actions.md`](github-actions.md#opencode-in-ci); scaffolding it is
[`skills/pr-hero-ci-setup/SKILL.md`](../skills/pr-hero-ci-setup/SKILL.md).

## Routing

`routing` in the global config maps a **logical model name** to a backend, provider and (optionally)
a pinned model id:

```ts
interface RouteMapping {
  logical?: string;        // which name this mapping answers to
  backend: "claude-code" | "opencode" | "antigravity" | "codex";
  provider: string;
  gateway?: "configured" | "direct" | "openrouter";
  modelFamily?: string;
  modelSnapshot?: string;   // the id sent to the provider/SDK
  modelVariant?: string;
  disabled?: boolean;
  allowSpend?: boolean;
}

interface RoutingConfig {
  default?: RouteMapping;
  mappings?: RouteMapping[] | Record<string, RouteMapping>;
  disabled?: boolean;
}
```

### How `logical` matches

A mapping's `logical` (or its object key, in the record form) matches a lookup against **four**
forms of the requested model identity: its canonical name, the raw string the caller passed, its
alias, and the alias's reverse form. In practice this means `"sonnet"` — the bare name the bundled
hunter prompts declare — is a valid key, and so is `"anthropic/sonnet"`.

**Two mappings that both match the same request is an error, not first-wins:**

```
Ambiguous model routing: found 2 duplicate mappings for "anthropic/sonnet"
```

### `disabled` and `allowSpend`

- `routing.disabled: true` disables the whole routing config; every lookup fails closed.
- A single mapping's `disabled: true` or `allowSpend: false` refuses spend for *that* mapping only.

Both raise `UnauthorizedRouteError`, not a silent fallback — a route that should not spend never
spends by accident.

### `modelFamily` / `modelSnapshot`

`modelFamily` always has a fallback (the parsed model segment), so it is never strictly required.
`modelSnapshot` is required in exactly one case: an **alias** (`sonnet`/`opus`/`haiku`) routed
anywhere other than the Claude CLI reached directly (`backend: "claude-code"`,
`gateway: "direct"`). Every other combination forwards the identity verbatim, so the operator
supplying a full provider/model identity (slash grammar, e.g. `openai/gpt-5`) needs no extra field —
but that also means there is no catalog to catch a typo: the bundled model catalog
(`config/models/anthropic.json`) only holds Anthropic aliases, so an OpenAI (or any other
non-Anthropic) model must be spelled out in full, and a wrong id fails at the provider, not at
pr-hero. Routing an alias to a non-direct backend without `modelSnapshot` fails loud instead:

```
Model alias "sonnet" is routed to backend "opencode" over the "configured" gateway by the routing
mapping, which supplies no "modelSnapshot". Only the Claude CLI reached over the "direct" gateway
resolves a bare alias; every other gateway forwards the model identity verbatim to an endpoint that
never registered pr-hero's aliases, so this route has no provider model id to send. Add an explicit
"modelSnapshot" naming the provider's model id to that routing mapping, or set its "gateway" to
"direct" if the Claude CLI really is resolving this alias.
```

### A working example

Written to `~/.prhero/config.json` and validated against the engine's own parser and resolver
(`parseRoutingConfig` + `resolveModelRoute`, offline, $0):

```json
{
  "routing": {
    "mappings": {
      "sonnet": {
        "backend": "opencode",
        "provider": "anthropic",
        "modelSnapshot": "claude-sonnet-5"
      },
      "openai/gpt-5": {
        "backend": "opencode",
        "provider": "openai",
        "modelFamily": "gpt-5",
        "modelSnapshot": "gpt-5"
      }
    }
  }
}
```

This resolves `"sonnet"` (what the bundled prompts declare) onto OpenCode's Anthropic route, and
routes an explicit `openai/gpt-5` identity onto OpenCode's OpenAI route. Mixing more than one
OpenCode provider in a single run is refused — see [Credentials](#credentials) below.

## Credentials

**pr-hero never stores a credential.** It reads them from wherever they already live and projects
a minimal, ephemeral copy into the child process's isolated environment. Four credential kinds
exist today:

| Kind | Source | Backend | Billing |
| --- | --- | --- | --- |
| `claude_subscription_oauth` | macOS Keychain item `Claude Code-credentials` (via `/usr/bin/security`) | `claude-code` | subscription (quota, `$0.00` cash) |
| `provider_api_token` | ambient `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` (claude-code), or the named key in OpenCode's `auth.json` (opencode) | `claude-code`, `opencode` | metered (real invoice) |
| `opencode_chatgpt_oauth` | the `openai` entry in `~/.local/share/opencode/auth.json` (or `$XDG_DATA_HOME/opencode/auth.json`), which must be `type: "oauth"` | `opencode` | subscription |
| `provider_free` | nothing — the provider's own catalog declares the model free at runtime (`opencode models <provider> --verbose --refresh`, every cost leaf `0`, status active) | `opencode` | free (not metered) |

### The one trap worth naming twice

An operator can run `opencode auth login` for several providers, see all of them in `opencode
models`, and have exactly one of them resolve to a subscription: the broker for
`opencode_chatgpt_oauth` reads the literal `openai` key in `auth.json` and requires that record's
`type` to be `"oauth"`. An `openai` entry holding a pay-as-you-go API key instead is refused —
loudly, at credential projection — rather than silently billed as if it were the ChatGPT
subscription. Every other provider (DeepSeek, Z.ai, etc.) resolves to `provider_api_token`
regardless of what it is named.

Only **one** OpenCode provider is admitted per run — mixing a `provider_free` route with a metered
one, or two different metered providers, is refused (`#195`): the OpenCode server holds one
credential for its whole life.

### claude-code: macOS vs. everywhere else

On macOS with `/usr/bin/security` present, a Keychain broker projects the subscription OAuth
record into the child and **strips** `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from its
environment — so an exported key on a macOS developer's shell does not silently make a `claude-code`
route metered; it still runs on the projected subscription record. Without that broker (Linux, CI,
or a macOS box that never authenticated `claude`), no projection happens: if `ANTHROPIC_API_KEY` or
`ANTHROPIC_AUTH_TOKEN` is set in the ambient environment, the route binds `provider_api_token` and
bills metered. This is why CI (which has no Keychain) always binds metered when an Anthropic API key
secret is set.

One known exception: if the Keychain item exists but the CLI moved its OAuth record out of the
expected shape, projection can fail in a way the harness degrades rather than kills — the route
still reports subscription, but an ambient key was not fenced. Tracked in `#279`, not fixed as of
this writing.

## Verifying at $0

### `pr-hero config`

```
$ pr-hero config
  repo   <repo>/.prhero/config.json (absent)
  global ~/.prhero/config.json (present)

  agents_dir                default (unset)
  routing                   default (unset)
  max_changed_lines         global  3000
  post                      global  true
  ...

  repo beats global, except on a capped key — there the NARROWER value wins, so
  a committed file can spend less of your money but never more. capped means the
  repo asked for the wider value and the global ceiling took it away; default
  means neither file named the key, and the resolver's own fallback decides at
  run time.
```

### `pr-hero doctor`

The exact-binding probe: which binary, which credential kind, whether its projection is ready, and
what isolation actually holds — not a generic "is claude installed" check.

```
$ pr-hero doctor
  [✓] claude: Claude Code CLI is installed and authenticated (2.1.281 (Claude Code))
  [!] provider:codegraph_policy_unenforced: no dedicated codegraph sensitive-file policy is
      enforced yet; isolation relies on --strict-mcp-config with a codegraph-only mcp.json
  ...
Environment is operational, but some optional tools or configurations are degraded.
```

### `pr-hero review --dry-run` — two caveats

- **It returns before route admission.** Local and PR dry-run both print the plan and the cost band
  from the diff and the config alone, before any credential is projected or route bound. A plan that
  would die immediately at admission (a missing `modelSnapshot`, a refused credential, an unmapped
  route) can still print a clean dry-run.
- **The cost band ignores billing mode.** It is a diff-size-and-agent-count estimate, calibrated from
  measured runs, not derived from a live route. It prints the same non-zero range on a `$0.00`
  subscription route as on a metered one — read it as "how big is this diff", not "what will this
  cost".

## What is proven for OpenCode, and what is not

OpenCode has completed real, end-to-end reviews — not a mock, not a fixture — but on narrow slices,
each ledgered live with real cost accounted:

- A subscription-style smoke (`#116`): one provider, one model, a 7-line diff, three hunters. All
  six conformance axes (auth, tools/MCP, terminal, usage, cleanup, provenance) verified live, at
  $0.00 cash. The refuter, scout, summarizer, parity hunter and codegraph/MCP integration were **not**
  exercised.
- The refuter on OpenCode (`#142`, item 1): closed — it ran, found the planted defect, and typed it
  correctly. It also returned `inconclusive` on a deterministic, 0-hop finding with two fabricated
  file citations — a real gap, but in `proof_refs` validation generally, not specific to OpenCode.
- A metered provider (`deepseek`) ran a real self-review at $0.06 and found a real issue the Claude
  arm on the same diff missed.
- A `provider_free` route completed a full PR-sized review (20 files, +365/−1987) at $0, wiring
  proven end to end — but it did roughly 1/17th the reading (input tokens) of a Claude control arm
  on the same diff and reported the same "nothing found" answer, which is weak evidence on a diff
  with no planted defect, not proof of equivalent quality.
- `zai` is code-path-identical to the proven `deepseek` route but unrun — no credential was
  available to prove it. `zai-coding-plan` is refused today (`#169`, flat-fee API key classified
  metered with no pricing table).
- Codegraph/MCP integration on a target that actually has an index, and a fully parity-hunter- and
  scout-exercised run, remain unverified.

OpenCode is not a default backend. Treat it as proven for the slices above and unproven elsewhere.
