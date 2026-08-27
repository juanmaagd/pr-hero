# OpenCode SDK → `OpenCodeClientLike`: the observed mapping

**Status:** design input for the D1-06 adapter slice. Written 2026-08-27 from a
live probe run, not from the SDK's type declarations alone.

`src/transports/opencode-sdk.ts` was deliberately built against a narrow
injectable contract — its own comment says "No assumption about the real SDK's
API is encoded here." This document is what happens when you go and look. It
records what `@opencode-ai/sdk@1.18.23` actually emits, so the adapter is
written against observed behaviour rather than plausible-looking types.

Re-run the probe with `bun run scripts/opencode-probe.ts` (LIVE, one trivial
prompt, ~$0 on a connected subscription).

## Why a probe and not just the `.d.ts`

The declared `Event` union has 32 members and reveals none of the four things
that actually decide the adapter's shape: which event means "the turn is
finished", where usage lives, whether the stream is per-session, and whether a
terminal *proof* is constructible at all. Three of the four answers were
surprising.

## Call mapping

| contract method | SDK call |
|---|---|
| `createSession` | `createOpencodeServer({hostname,port})` → `createOpencodeClient({baseUrl})` → `client.session.create({body:{title}})` |
| *(trigger)* | `client.session.prompt({path:{id}, body:{model:{providerID,modelID}, system, tools, parts}})` |
| `streamEvents` | `client.event.subscribe()` → `{stream}` |
| `pollStatus` | `client.session.get({path:{id}})` |
| `abort` | `client.session.abort()` |

The `prompt` body maps 1:1 onto `OpenCodeCreateSessionInput`: `system` takes
the system prompt's contents, `parts` the user prompt, `query.directory` the
cwd — and `tools: {[name]: boolean}` is where the tool allowlist **and** the
§6 bash deny floor live. That last one is not a workaround; it is the SDK's
own per-request tool gate.

## Event mapping

| our event | observed OpenCode event | payload |
|---|---|---|
| `delta` | `message.part.delta` | `{sessionID, messageID, partID, field:"text", delta}` |
| `usage` | `session.updated` | `properties.info.{cost, tokens:{input,output,reasoning,cache}}` |
| `heartbeat` | `session.status` | `{sessionID, status:{type:"busy"}}` |
| `terminal` | **not** `session.idle` — see below | |

One trivial prompt produced 71 events: `plugin.added` ×45, `message.updated`
×5, `message.part.updated` ×5, `session.status` ×4, `session.updated` ×3,
`message.part.delta` ×2, and one each of `session.diff`, `session.idle`,
`server.connected`, `reference.updated`, `integration.updated`,
`catalog.updated` ×2.

### Trap 1 — the stream is global

`event.subscribe()` is not scoped to a session, and 45 of those 71 events were
`plugin.added`. Every event the adapter cares about carries
`properties.sessionID`; the noise does not. Filter on it or drown.

### Trap 2 — `message.part.updated` fires for the *user* message

The observed one carried `part.text = "Reply with exactly: PONG"` — the prompt
itself. An adapter that treated every text part as a delta would echo the
prompt back into `finalText` and then hand it to `StepSpec.parse`. Deltas come
from `message.part.delta`, never from `message.part.updated`.

### Trap 3 — `session.idle` is not a proof

Its entire payload is `{sessionID}`. `ProviderTerminalProof` needs an
`eventId`, a `providerStatus` and a `providerObservedAt`, and none of them are
in there. Synthesising a proof from it would mean the transport issuing its own
proof and then letting it win the §197 slot — which is precisely what that
slot exists to prevent.

## Where the real proof lives

The **assistant message** carries a provider-issued completion record:

```jsonc
{
  "id": "msg_041ddb5ac001...",              // → proof.eventId
  "role": "assistant",
  "finish": "stop",                          // → proof.providerStatus
  "time": { "created": …, "completed": … },  // → proof.providerObservedAt
  "error": null,
  "cost": 0,
  "tokens": { "total": 24018, "input": 24012, "output": 6, "reasoning": 0, "cache": {…} }
}
```

So a **verified** proof is constructible, and both of §197's observers can
reach it independently:

- **stream** — the `message.updated` whose `info.role === "assistant"` and
  whose `info.time.completed` is set;
- **poll** — `session.get` / `session.messages` for the same message.

`session.idle` keeps a job, just not that one: it is the signal that the
session stopped working, i.e. the cue to stop polling. It never enters the
slot.

## Usage is snapshot, not delta

`session.updated.info.tokens` and `.cost` are **session totals**, restated on
every update. That is `usageMode: "snapshot"` in §4.2's vocabulary — the
transport must REPLACE its counters, and accumulating them would multiply the
attempt's reported spend. The assistant message's own `tokens.total` is the
per-message figure and is the honest per-attempt number.

## Two findings that reach past this adapter

**`SessionStatus` has a `retry` arm.**

```ts
type SessionStatus =
  | { type: "idle" } | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number }
```

`next` is a timestamp. That is a real, provider-issued backoff hint — the
validated `Retry-After` that `decideRetryDisposition` has accepted as an
optional `retryAfterMs` since D1-07 and that no transport has ever been able to
supply. The CLI transport cannot: it reads the child's stdout and never sees an
HTTP header. This one can.

**`AssistantMessage.error` is a typed union**, not prose:

```ts
error?: ProviderAuthError | UnknownError | MessageOutputLengthError
      | MessageAbortedError | ApiError
```

That maps onto `TransportFailureCause` structurally — `ProviderAuthError` →
`auth_invalid`, `MessageOutputLengthError` → `output_limit_exceeded`,
`MessageAbortedError` → a cancellation. It is the answer to the defect pr-hero
found as F003 on PR #74 and again in the CLI transport: a classifier reading a
typed error field cannot mistake a code reviewer's prose about rate limiting
for a rate limit.

## Credential scope, checked against PR #80

Providers reported `connected` on the probe machine: `zai`, `amazon-bedrock`,
`openai`, `zai-coding-plan`, `opencode`. Only three of those are in
`auth.json` — `amazon-bedrock` and `opencode` are credentialed elsewhere. The
`OpenCodeAuthBroker` projection is correct for the ChatGPT/OpenAI route it
claims, and it must not be described as isolating every provider OpenCode can
reach.

## Open decision for the adapter slice

`finish` is declared `finish?: string`, so its value space is not enumerated by
the SDK. `"stop"` was observed. The adapter needs a rule for mapping the rest
onto `completion` — and, per §3.2, an unrecognised `finish` should not silently
become `success`.
