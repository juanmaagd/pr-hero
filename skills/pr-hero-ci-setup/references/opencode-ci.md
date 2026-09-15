# OpenCode in CI — operator procedure

Read this when the operator wants OpenCode, DeepSeek, mixed Claude+OpenCode, or GitHub `OPENCODE_AUTH_JSON` / `PRHERO_ROUTING`. Full narrative: `docs/github-actions.md` (section **OpenCode in CI**).

Do **not** print, `cat`, or log credential values. Inspect **keys and `type` only**.

## Two GitHub boxes

| GitHub box | Name | Holds |
|---|---|---|
| **Secrets** (hidden) | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | Claude. Unchanged. |
| **Secrets** | `OPENCODE_AUTH_JSON` | One JSON object: the OpenCode `auth.json` store (or a **CI-only** subset). Cap 48 KB. |
| **Variables** (public) | `PRHERO_ROUTING` | Routing object only (`default` / `mappings` / `disabled`). No credentials. Cap 48 KB. Quoted in workflow `with.routing`. |

Do **not** create `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or any other per-provider GitHub secret. The Action has no per-provider inputs. Provider tokens live **inside** `OPENCODE_AUTH_JSON`.

Unset both OpenCode names = Claude-only CI.

## Local store (metadata only)

Default path: `$XDG_DATA_HOME/opencode/auth.json` or `~/.local/share/opencode/auth.json`.

```bash
python3 - <<'PY'
import json, os
p = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share"), "opencode", "auth.json")
print("exists", os.path.isfile(p))
if not os.path.isfile(p):
    raise SystemExit(0)
with open(p) as f:
    data = json.load(f)
print("providers", ",".join(sorted(data)))
for name, rec in data.items():
    t = rec.get("type") if isinstance(rec, dict) else "?"
    print(f"{name} type={t}")
PY
```

If the store is missing, have the operator authenticate the **CI provider** in OpenCode locally first (`opencode` auth/login for that provider). Do not collect the key in chat.

## What may go in the blob

| `auth.json` entry | CI |
|---|---|
| Non-openai `type: "api"` (tested: **deepseek**) | Executable metered path. Default spend ceiling applies. |
| `openai` `type: "api"` | **Refuse.** Engine maps `openai` to ChatGPT OAuth; a pay-as-you-go key is not remapped. |
| `openai` `type: "oauth"` | Do **not** put a personal ChatGPT session in a repository secret. |
| Several OpenCode providers in **one run** | Out of scope (#195). One OpenCode provider per run. |
| `claude-code` + **one** OpenCode provider | Legal. Keep a Claude secret and one OpenCode API record. |

If the personal store has extra providers (ChatGPT OAuth, zai, …), **do not upload it whole**. Write a 0600 temp object with **only** the CI provider, `gh secret set` from that file, delete the temp file.

```bash
# After writing a 0600 CI-only auth.json (deepseek-only). Never cat it.
gh secret set OPENCODE_AUTH_JSON < /path/to/ci-only-auth.json
```

`gh` missing/unauthenticated: Settings → Secrets and variables → Actions. Paste the JSON into secret `OPENCODE_AUTH_JSON`. Never paste it into the workflow YAML or the chat.

## Routing is logical model, not role

`PRHERO_ROUTING` maps **logical model identity** (`sonnet`, `haiku`), not hunter vs refuter.

Default prompt set:

| Step | Logical model |
|---|---|
| Hunters + refuter | `sonnet` |
| Summarizer | `haiku` |

A `sonnet` mapping moves hunters **and** the refuter. DATA cannot send hunters to OpenCode and the refuter to Claude. That split needs a spec/frontmatter change (out of scope here).

OpenCode does not resolve pr-hero aliases. Any `opencode` route for `sonnet`/`haiku` **must** set `modelSnapshot` to the provider model id. Confirm with `opencode models` (optionally `opencode models <provider>`). Do not guess `deepseek-chat` if the CLI lists `deepseek-v4-flash` / `deepseek-v4-pro`.

`gateway`: `"configured"` for OpenCode; `"direct"` for Claude CLI.

Do not wrap the variable in `{"routing": ...}`. Do not put keys in the variable (it is public).

### OpenCode-only (all logicals)

```bash
gh variable set PRHERO_ROUTING --body '{"default":{"backend":"opencode","provider":"deepseek","gateway":"configured","modelSnapshot":"deepseek-v4-flash"}}'
```

Replace `deepseek-v4-flash` with an id `opencode models` actually lists.

### Mixed: OpenCode default + Claude summarizer (legal DATA mix)

Hunters + refuter (`sonnet`) → one OpenCode API provider. Summarizer (`haiku`) → Claude.

```bash
gh variable set PRHERO_ROUTING --body '{"default":{"backend":"opencode","provider":"deepseek","gateway":"configured","modelSnapshot":"deepseek-v4-flash"},"mappings":[{"logical":"haiku","backend":"claude-code","provider":"anthropic","gateway":"direct"}]}'
```

Keep `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) for the Claude mapping. Presence of `OPENCODE_AUTH_JSON` still applies the metered ceiling.

## Workflow

Generated `with:` must keep:

```yaml
routing: "${{ vars.PRHERO_ROUTING }}"
opencode-auth: ${{ secrets.OPENCODE_AUTH_JSON }}
```

Quotes around the routing var are load-bearing (unset → empty string). Re-scaffold with `pr-hero setup --ci --force` if an old template lacks them.

The Action installs OpenCode CLI **1.18.30** in its **own** step when `opencode-auth` is non-empty **or** routing contains `opencode`. Never `latest`. Claude-only (both OpenCode inputs empty / no `opencode` in routing) skips that install.

## Fail-closed edges

- Fork PRs still skip (no secrets).
- OpenCode-only (only `OPENCODE_AUTH_JSON`) **does** start the review job.
- Claude credentials + OpenCode routing **without** `OPENCODE_AUTH_JSON` starts then **fails**.
- Invalid routing/auth JSON fails loud.

## After setting DATA

Open a **same-repo** PR (forks skip). Confirm the review job materializes person-layer `$HOME/.prhero/config.json` and 0600 auth, and that spend notices show metered when the OpenCode file is present.
