import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  AsyncEventSink,
  ProviderEvent,
  TransportRequest,
} from "../../src/execution/contracts";
import {
  createOpenCodeClient,
  type OpenCodeSdkLike,
} from "../../src/transports/opencode-client";
import { OpenCodeSdkTransport } from "../../src/transports/opencode-sdk";

const FIXTURE_DIR = path.join(import.meta.dir, "..", "fixtures", "opencode");
const ASSISTANT = JSON.parse(
  readFileSync(path.join(FIXTURE_DIR, "assistant-message.json"), "utf-8"),
) as Record<string, unknown>;

const SESSION_ID = "ses_test";

// The REAL tool surface, read live from `client.tool.ids()` against opencode
// 1.18.23 while diagnosing issue #122. It is transcribed rather than derived:
// the SDK types `tools` as an OPEN `{[key: string]: boolean}` map and
// enumerate nothing, so this list is the only record of what the provider
// actually offers — and of the fact that NONE of it is spelled the way the
// engine's canonical (Claude Code namespace) tool names are.
const OPENCODE_TOOL_IDS = [
  "invalid",
  "question",
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "task",
  "webfetch",
  "todowrite",
  "websearch",
  "skill",
  "apply_patch",
] as const;

interface FakeSdk {
  sdk: OpenCodeSdkLike;
  iterators: () => number;
  promptCalls: () => Array<Record<string, unknown>>;
  abortCalls: () => number;
  subscribedAt: () => number;
  promptedAt: () => number;
  toolIdsCalls: () => Array<Record<string, unknown> | undefined>;
  emit: (event: unknown) => void;
  endStream: () => void;
  setMessages: (messages: unknown[]) => void;
}

function fakeSdk(
  options: {
    promptHangs?: boolean;
    // `undefined` means "the live surface". An Error rejects the call; an
    // array (including an empty one) resolves with exactly those ids.
    toolIds?: readonly string[] | Error;
  } = {},
): FakeSdk {
  const prompts: Array<Record<string, unknown>> = [];
  const toolIdsCalls: Array<Record<string, unknown> | undefined> = [];
  let aborts = 0;
  let order = 0;
  let subscribedAt = 0;
  let promptedAt = 0;
  let messages: unknown[] = [];
  const queue: unknown[] = [];
  let notify: (() => void) | undefined;
  let ended = false;

  let iterators = 0;
  const sdk: OpenCodeSdkLike = {
    createOpencodeClient: () => ({
      tool: {
        ids: async (opts) => {
          toolIdsCalls.push(opts as Record<string, unknown> | undefined);
          if (options.toolIds instanceof Error) throw options.toolIds;
          return { data: [...(options.toolIds ?? OPENCODE_TOOL_IDS)] };
        },
      },
      session: {
        create: async () => ({ data: { id: SESSION_ID } }),
        prompt: async (opts) => {
          promptedAt = ++order;
          prompts.push(opts as Record<string, unknown>);
          if (options.promptHangs) await new Promise(() => {});
          return { data: {} };
        },
        messages: async () => ({ data: messages }),
        abort: async () => {
          aborts += 1;
          return { data: {} };
        },
      },
      event: {
        subscribe: async () => {
          subscribedAt = ++order;
          return {
            stream: {
              async *[Symbol.asyncIterator]() {
                iterators += 1;
                for (;;) {
                  while (queue.length > 0) yield queue.shift();
                  if (ended) return;
                  await new Promise<void>((r) => {
                    notify = r;
                  });
                }
              },
            },
          };
        },
      },
    }),
  };

  return {
    sdk,
    iterators: () => iterators,
    promptCalls: () => prompts,
    abortCalls: () => aborts,
    subscribedAt: () => subscribedAt,
    promptedAt: () => promptedAt,
    toolIdsCalls: () => toolIdsCalls,
    emit: (event) => {
      queue.push(event);
      notify?.();
      notify = undefined;
    },
    endStream: () => {
      ended = true;
      notify?.();
      notify = undefined;
    },
    setMessages: (m) => {
      messages = m;
    },
  };
}

function rig(fake: FakeSdk) {
  return createOpenCodeClient({
    loadSdk: async () => fake.sdk,
    launchServer: async () => ({
      url: "http://127.0.0.1:1",
      pid: 1,
      close: async () => {},
    }),
    model: { providerID: "openai", modelID: "test-model" },
    readSystemPrompt: async () => "SYSTEM",
  });
}

// The CANONICAL tool names, verbatim from `BINDING_ALLOWED_TOOLS` and from
// every bundled hunter prompt's `tools:` line. They are Claude Code's
// namespace and OpenCode has never understood a single one of them; this
// fixture used to read ["read", "grep"], a mock shaped to the same guess that
// shipped issue #121, which is why 2818 offline tests stayed green while the
// live map denied nothing and allowed nothing.
const INPUT = {
  cwd: "/tmp/work",
  userPrompt: "review this",
  systemPromptPath: "/tmp/system.md",
  tools: ["Read", "Grep", "Glob", "mcp__codegraph__codegraph_explore"],
};

// What the transport must send for that input against the live surface: EVERY
// enumerated id present, the three translatable allows true, everything else
// explicitly false. No key is absent, so "what does OpenCode do with an absent
// key" stops being a question this transport's safety depends on.
const EXPECTED_TOOL_MAP = {
  invalid: false,
  question: false,
  bash: false,
  read: true,
  glob: true,
  grep: true,
  edit: false,
  write: false,
  task: false,
  webfetch: false,
  todowrite: false,
  websearch: false,
  skill: false,
  apply_patch: false,
};

function messageEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "message.updated",
    properties: {
      sessionID: SESSION_ID,
      info: { ...ASSISTANT, sessionID: SESSION_ID, ...overrides },
    },
  };
}

describe("createOpenCodeClient", () => {
  // THE ordering rule. event.subscribe() is live and unbuffered, so a
  // subscription opened after the prompt silently misses the early events —
  // and those are the ones carrying the first deltas. The contract calls
  // createSession() and streamEvents() as separate steps, so the buffering
  // has to happen inside createSession or the window is unavoidable.
  test("subscribes BEFORE prompting, never after", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    await client.createSession(INPUT);
    expect(fake.subscribedAt()).toBeGreaterThan(0);
    expect(fake.promptedAt()).toBeGreaterThan(0);
    expect(fake.subscribedAt()).toBeLessThan(fake.promptedAt());
  });

  // session.prompt is a BLOCKING call that returns the finished message —
  // the probe measured 4.5s. The ROADMAP forbids completing an attempt from
  // one blocking HTTP call, so it is the TRIGGER and nothing else; a prompt
  // that never returns must not stop the stream from delivering.
  test("a prompt that never returns does not block the session", async () => {
    const fake = fakeSdk({ promptHangs: true });
    const client = rig(fake);
    const session = await Promise.race([
      client.createSession(INPUT),
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error("blocked")), 500),
      ),
    ]);
    expect((session as { id: string }).id).toBe(SESSION_ID);
  });

  test("the prompt carries the system prompt, the tools and the cwd", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    await client.createSession(INPUT);
    const body = fake.promptCalls()[0]?.body as Record<string, unknown>;
    expect(body.system).toBe("SYSTEM");
    expect(body.parts).toEqual([{ type: "text", text: "review this" }]);
    // §6: the tool map is an ALLOWLIST expressed as explicit booleans. A tool
    // the spec did not name must be false, not merely absent — "absent" is a
    // request for the provider's default, and the default is not ours.
    expect(body.tools).toEqual(EXPECTED_TOOL_MAP);
  });
});

// ---------------------------------------------------------------------------
// Issue #122. The map handed to session.prompt was built by writing the
// engine's CANONICAL tool names straight into it — Claude Code's namespace,
// which OpenCode has never spoken. `tools` is an OPEN map, so unknown keys are
// accepted and silently ignored: no error, no warning, nothing in the
// response. Of the five keys sent, only "bash" landed, and only by the
// coincidence that OpenCode happens to spell its shell tool that way.
//
// Two failures in one. The allowlist allowed nothing — the #116 smoke's
// hunters ran ~10s each emitting pure narration ("Inspecting codegraph and
// relevant consumers") about tool use they never performed. And the denylist
// denied nothing beyond bash, leaving write/edit/apply_patch/task/webfetch/
// websearch as ABSENT keys asking for whatever OpenCode's default is. That
// second half is what makes the report a lie rather than a gap:
// production-runtime.ts hardcodes `allowMapOnly: true` and reports it as
// `allowMapEnforced` into the capability report the D1-11 admission gate
// trusts. An isolation control that is silently a no-op while the report
// calls it enforced is worse than an absent one (CLAUDE.md rule 4).
// ---------------------------------------------------------------------------
// The `tools` map as the provider received it. Reads the recorded prompt call
// rather than any client-side state, because "what we intended to send" is the
// claim that was already false.
function sentTools(fake: FakeSdk): Record<string, boolean> {
  const call = fake.promptCalls()[0];
  if (call === undefined) throw new Error("no prompt was sent");
  return (call.body as Record<string, unknown>).tools as Record<
    string,
    boolean
  >;
}

describe("createOpenCodeClient tool-surface translation (#122)", () => {
  test("enumerates the provider surface and denies every id it was not asked to allow", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    await client.createSession(INPUT);

    expect(sentTools(fake)).toEqual(EXPECTED_TOOL_MAP);

    // Enumeration is not optional and not cached from a hardcoded list: the
    // surface is READ from the provider, scoped to the same directory the
    // prompt runs in.
    expect(fake.toolIdsCalls()).toHaveLength(1);
    expect(fake.toolIdsCalls()[0]).toEqual({
      query: { directory: "/tmp/work" },
    });
  });

  test("the sent map carries no key from the engine's canonical namespace", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    await client.createSession(INPUT);

    const keys = Object.keys(sentTools(fake));

    // The exact bug: these were sent verbatim and silently discarded.
    expect(keys).not.toContain("Read");
    expect(keys).not.toContain("Grep");
    expect(keys).not.toContain("Glob");
    expect(keys.filter((key) => key.startsWith("mcp__"))).toEqual([]);
    // Nothing outside the enumerated surface reaches the provider at all.
    expect(keys.sort()).toEqual([...OPENCODE_TOOL_IDS].sort());
  });

  test("every write-capable and escape-hatch tool is explicitly false, by name", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    await client.createSession(INPUT);

    const tools = sentTools(fake);
    for (const denied of [
      "write",
      "edit",
      "apply_patch",
      "task",
      "bash",
      "webfetch",
      "websearch",
    ]) {
      expect(tools[denied]).toBe(false);
    }
  });

  // PARITY, not construction. `mcp__codegraph__codegraph_explore` maps onto no
  // OpenCode built-in, and that is the correct outcome: on claude-code a repo
  // with no codegraph index runs its hunters with the other three tools and an
  // empty mcp.json. Mirroring that means the MCP name is simply absent from a
  // built-in map and the run proceeds. MCP expressibility on OpenCode is a
  // separate open question (#122 q2) — opencode-sdk.ts threads an
  // mcpConfigPath into the request that this client never applies.
  test("an unmappable canonical name is dropped, not invented and not fatal", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    expect(session.id).toBe(SESSION_ID);
    expect(Object.values(sentTools(fake)).filter(Boolean)).toHaveLength(3);
  });

  test("an allow the provider does not offer never appears in the map", async () => {
    // A surface WITHOUT `grep` — a plugin build, an older opencode, a future
    // rename. The allowlist may only ever intersect the real surface;
    // inventing a key would be the absent-key hazard in reverse.
    const fake = fakeSdk({ toolIds: ["read", "glob", "bash", "write"] });
    const client = rig(fake);
    await client.createSession(INPUT);

    expect(sentTools(fake)).toEqual({
      read: true,
      glob: true,
      bash: false,
      write: false,
    });
  });

  test("the resolved map is recorded on the session for the attempt's diagnostics", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    // #116's ledger requires the tools/MCP axis be provable by READING
    // artifacts, not assumed from source. The session carries the map the
    // transport actually sent so the attempt can stamp it into stderrTail.
    expect(session.toolMap).toEqual(EXPECTED_TOOL_MAP);
  });
});

// ---------------------------------------------------------------------------
// Fail closed. A session whose tool surface cannot be established is the
// runtime being unavailable — there is no partial map and no hardcoded
// fallback, because either one would re-create the exact "we believe this is
// enforced" claim the defect was made of.
// ---------------------------------------------------------------------------
describe("createOpenCodeClient tool-surface failure (#122)", () => {
  test("a rejecting tool.ids aborts the session before any prompt is sent", async () => {
    const fake = fakeSdk({ toolIds: new Error("boom") });
    const client = rig(fake);

    await expect(client.createSession(INPUT)).rejects.toThrow(/tool/i);
    expect(fake.promptCalls()).toHaveLength(0);
  });

  test("an empty surface is refused rather than treated as 'deny nothing'", async () => {
    const fake = fakeSdk({ toolIds: [] });
    const client = rig(fake);

    await expect(client.createSession(INPUT)).rejects.toThrow(/tool/i);
    expect(fake.promptCalls()).toHaveLength(0);
  });

  test("the transport classifies an unestablishable surface as runtime_unavailable", async () => {
    const fake = fakeSdk({ toolIds: new Error("boom") });
    const transport = new OpenCodeSdkTransport({ client: rig(fake) });
    const sink: AsyncEventSink = {
      push: async (_event: ProviderEvent) => "accepted" as const,
      close: async () => {},
    };
    const request: TransportRequest = {
      sessionId: "oc-sess-122",
      attempt: 1,
      route: {
        backend: "opencode",
        provider: "openai",
        modelFamily: "gpt",
        modelSnapshot: "gpt-test-snapshot",
      },
      executionModel: "gpt-test-snapshot",
      systemPromptPath: "/tmp/system.md",
      systemPromptSha256: "deadbeef",
      userPrompt: "review this",
      cwd: "/tmp/work",
      tools: INPUT.tools,
      isolation: {
        credentialProjectionId: "proj-1",
        env: {},
        syntheticHome: "/tmp/home",
        syntheticConfigHome: "/tmp/config",
        syntheticTmp: "/tmp/tmp",
        verifiedBinaryPath: "/usr/bin/true",
      },
    };

    const outcome = await transport.execute(request, {
      signal: new AbortController().signal,
      events: sink,
    });

    expect(outcome.completion).toBe("failed");
    // Terminal, and NOT a format_violation: the model never saw the attempt,
    // so spending the format-reminder budget on it is the issue-#121 mistake.
    expect(transport.classifyFailure(outcome)).toBe("runtime_unavailable");
    expect(fake.promptCalls()).toHaveLength(0);
  });
});

describe("createOpenCodeClient", () => {
  test("buffered events survive the gap between createSession and streamEvents", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);
    // #124: a delta names a part, and a part is only an answer channel once
    // `message.part.updated` has announced it under an assistant message.
    // These two events are the stream's preamble, not its subject.
    fake.emit({
      type: "message.updated",
      properties: {
        sessionID: SESSION_ID,
        info: { id: "msg_a", role: "assistant", time: { created: 1 } },
      },
    });
    fake.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESSION_ID,
        part: {
          id: "prt_answer",
          messageID: "msg_a",
          type: "text",
          text: "",
        },
        time: 1,
      },
    });
    fake.emit({
      type: "message.part.delta",
      properties: {
        sessionID: SESSION_ID,
        partID: "prt_answer",
        field: "text",
        delta: "early",
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    fake.endStream();

    const seen: string[] = [];
    for await (const event of client.streamEvents(session)) {
      if (event.kind === "delta") seen.push(event.text);
    }
    expect(seen).toEqual(["early"]);
  });

  test("the stream stops at the terminal and yields the provider's proof", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);
    fake.emit(messageEvent());
    fake.endStream();

    const kinds: string[] = [];
    for await (const event of client.streamEvents(session)) {
      kinds.push(event.kind);
      if (event.kind === "terminal") {
        expect(event.proof.eventId).toBe(ASSISTANT.id as string);
        // Normalised, not the raw finish reason — see PR #82's BLOCKER.
        expect(event.proof.providerStatus).toBe("completed");
      }
    }
    expect(kinds).toContain("terminal");
  });

  test("poll reports pending until an assistant message completes", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    fake.setMessages([{ info: { role: "user" }, parts: [] }]);
    expect((await client.pollStatus(session)).kind).toBe("pending");

    fake.setMessages([
      { info: { role: "user" }, parts: [] },
      { info: { ...ASSISTANT, time: { created: 1 } }, parts: [] },
    ]);
    expect((await client.pollStatus(session)).kind).toBe("pending");

    fake.setMessages([
      { info: { role: "user" }, parts: [] },
      { info: ASSISTANT, parts: [] },
    ]);
    const done = await client.pollStatus(session);
    expect(done.kind).toBe("terminal");
    if (done.kind !== "terminal") throw new Error("unreachable");
    // The SAME proof the stream produces. §197 needs two INDEPENDENT
    // observers of one fact, not two facts that happen to look alike — so
    // both paths run through terminalProofFromAssistant.
    expect(done.proof.eventId).toBe(ASSISTANT.id as string);
  });

  // pr-hero F002/F003 on this PR, both BLOCKER, and both right — they are the
  // same defect seen twice. The background pump and streamEvents() iterated
  // the SAME subscription.stream. Two consumers on one async iterator race:
  // the pump consumed the event that flipped `drained` and then dropped it,
  // and its for-await exit fires an implicit .return() on the SHARED
  // generator, which can end it under the real consumer. This repo documented
  // that exact hazard in opencode-sdk.ts and then walked into it.
  //
  // Downstream it is worse than a dropped event: execute() builds finalText
  // from the deltas the STREAM saw, so if the poll recovers the terminal
  // instead, the attempt is reported success with silently truncated output.
  test("no event is lost at the buffered-to-live handoff", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);

    const delta = (text: string) => ({
      type: "message.part.delta",
      properties: {
        sessionID: SESSION_ID,
        partID: "prt_answer",
        field: "text",
        delta: text,
      },
    });

    // #124: a delta names a part, and a part is only an answer channel once
    // `message.part.updated` has announced it under an assistant message.
    // These two events are the stream's preamble, not its subject.
    fake.emit({
      type: "message.updated",
      properties: {
        sessionID: SESSION_ID,
        info: { id: "msg_a", role: "assistant", time: { created: 1 } },
      },
    });
    fake.emit({
      type: "message.part.updated",
      properties: {
        sessionID: SESSION_ID,
        part: {
          id: "prt_answer",
          messageID: "msg_a",
          type: "text",
          text: "",
        },
        time: 1,
      },
    });

    // Two before anyone calls streamEvents (the buffered window)...
    fake.emit(delta("a"));
    fake.emit(delta("b"));
    await new Promise((r) => setTimeout(r, 10));

    const seen: string[] = [];
    const consuming = (async () => {
      for await (const event of client.streamEvents(session)) {
        if (event.kind === "delta") seen.push(event.text);
      }
    })();

    // ...and more arriving exactly across the switch to live.
    await new Promise((r) => setTimeout(r, 5));
    fake.emit(delta("c"));
    fake.emit(delta("d"));
    await new Promise((r) => setTimeout(r, 10));
    fake.endStream();
    await consuming;

    expect(seen.join("")).toBe("abcd");
  });

  test("the subscription has exactly ONE consumer", () => {
    // The structural guarantee behind the test above: a second for-await on
    // the same stream is the bug, so the count is the invariant.
    const fake = fakeSdk();
    const client = rig(fake);
    return (async () => {
      const session = await client.createSession(INPUT);
      fake.emit({
        type: "message.part.delta",
        properties: { sessionID: SESSION_ID, field: "text", delta: "x" },
      });
      await new Promise((r) => setTimeout(r, 5));
      fake.endStream();
      for await (const _event of client.streamEvents(session)) {
        // drain
      }
      expect(fake.iterators()).toBe(1);
    })();
  });

  // pr-hero F005. readSystemPrompt was awaited AFTER the server was
  // launched, the remote session created and the state registered — so a
  // throw there left a running server, a live remote session and a pump
  // behind, with the caller never given the id needed to abort any of it.
  //
  // The best unwind is the one with nothing to unwind: the prompt read is the
  // single step that fails on the operator's own filesystem, so it now runs
  // before anything is spawned at all.
  test("an unreadable system prompt never spawns anything", async () => {
    const fake = fakeSdk();
    let launched = 0;
    const client = createOpenCodeClient({
      loadSdk: async () => fake.sdk,
      launchServer: async () => {
        launched += 1;
        return { url: "http://127.0.0.1:1", pid: 1, close: async () => {} };
      },
      model: { providerID: "openai", modelID: "test-model" },
      readSystemPrompt: async () => {
        throw new Error("system prompt unreadable");
      },
    });
    await expect(client.createSession(INPUT)).rejects.toThrow(/unreadable/);
    expect(launched).toBe(0);
  });

  // And for the failures that CAN only happen after the server is up, the
  // unwind has to actually run.
  test("a failure after launch closes the server it started", async () => {
    const fake = fakeSdk();
    let closed = 0;
    const broken: OpenCodeSdkLike = {
      createOpencodeClient: () => ({
        ...fake.sdk.createOpencodeClient({ baseUrl: "" }),
        session: {
          ...fake.sdk.createOpencodeClient({ baseUrl: "" }).session,
          create: async () => {
            throw new Error("remote session refused");
          },
        },
      }),
    };
    const client = createOpenCodeClient({
      loadSdk: async () => broken,
      launchServer: async () => ({
        url: "http://127.0.0.1:1",
        pid: 1,
        close: async () => {
          closed += 1;
        },
      }),
      model: { providerID: "openai", modelID: "test-model" },
      readSystemPrompt: async () => "SYSTEM",
    });
    await expect(client.createSession(INPUT)).rejects.toThrow(/refused/);
    expect(closed).toBe(1);
  });

  // Issue #121, second half. The SDK's `RequestResult` has TWO arms under the
  // default `ThrowOnError = false`: `{ data, error: undefined }` and
  // `{ data: undefined, error }`. The local interface declared only the first,
  // so an API error — a rejected model, a bad body, a 500 — reached
  // `created.data.id` with `data` undefined and became a TypeError. A
  // TypeError carries none of the provider's diagnosis and, being unmapped,
  // was classified a FORMAT violation and burned a format retry.
  test("a session.create error response fails with a diagnosable error", async () => {
    const fake = fakeSdk();
    const base = fake.sdk.createOpencodeClient({ baseUrl: "" });
    const erroring: OpenCodeSdkLike = {
      createOpencodeClient: () => ({
        ...base,
        session: {
          ...base.session,
          create: async () => ({
            data: undefined,
            error: { message: "model not found" },
          }),
        },
      }),
    };
    const client = createOpenCodeClient({
      loadSdk: async () => erroring,
      launchServer: async () => ({
        url: "http://127.0.0.1:1",
        pid: 1,
        close: async () => {},
      }),
      model: { providerID: "openai", modelID: "test-model" },
      readSystemPrompt: async () => "SYSTEM",
    });

    // The provider's own words must survive into the message: they are the
    // whole reason the operator can tell an infrastructure failure from a
    // model one.
    await expect(client.createSession(INPUT)).rejects.toThrow(
      /session\.create.*model not found/s,
    );
  });

  // pr-hero F004. A server per SESSION means every attempt leaves a spawned
  // process behind, released only by a whole-client close() that is not even
  // part of OpenCodeClientLike. One server hosts many sessions; that is what
  // the API is for.
  test("one server hosts every session of a client", async () => {
    const fake = fakeSdk();
    let launches = 0;
    const client = createOpenCodeClient({
      loadSdk: async () => fake.sdk,
      launchServer: async () => {
        launches += 1;
        return {
          url: "http://127.0.0.1:1",
          pid: 1,
          close: async () => {},
        };
      },
      model: { providerID: "openai", modelID: "test-model" },
      readSystemPrompt: async () => "SYSTEM",
    });
    await client.createSession(INPUT);
    await client.createSession(INPUT);
    expect(launches).toBe(1);
  });

  // pr-hero's re-review on this PR, and it is a regression the PREVIOUS fix
  // introduced: sharing one server across sessions created a cross-session
  // teardown that per-session servers could not have. `states.set` happens
  // only after session.create AND event.subscribe both succeed, so a sibling
  // still mid-establishment is invisible to `states.size === 0` — and a
  // failing call would SIGTERM the server that healthy sibling is using.
  test("a failing session never kills a sibling's server", async () => {
    const fake = fakeSdk();
    let closed = 0;
    let firstCreate = true;
    let releaseSecondCreate!: () => void;
    const secondCreateBlocked = new Promise<void>((r) => {
      releaseSecondCreate = r;
    });

    const base = fake.sdk.createOpencodeClient({ baseUrl: "" });
    const sdk: OpenCodeSdkLike = {
      createOpencodeClient: () => ({
        ...base,
        session: {
          ...base.session,
          create: async () => {
            if (firstCreate) {
              firstCreate = false;
              throw new Error("remote session refused");
            }
            // The sibling is parked exactly in the pre-states.set window.
            await secondCreateBlocked;
            return { data: { id: SESSION_ID } };
          },
        },
      }),
    };
    const client = createOpenCodeClient({
      loadSdk: async () => sdk,
      launchServer: async () => ({
        url: "http://127.0.0.1:1",
        pid: 1,
        close: async () => {
          closed += 1;
        },
      }),
      model: { providerID: "openai", modelID: "test-model" },
      readSystemPrompt: async () => "SYSTEM",
    });

    const failing = client.createSession(INPUT);
    const sibling = client.createSession(INPUT);
    await expect(failing).rejects.toThrow(/refused/);
    // The failure has already unwound; the sibling has not registered yet.
    expect(closed).toBe(0);

    releaseSecondCreate();
    await sibling;
    expect(closed).toBe(0);
  });

  // The other half of the same unwind: a remote session that WAS created
  // before the failure is real work on the provider's side, and dropping the
  // local map entry does not release it.
  test("the unwind releases a remote session it already created", async () => {
    const fake = fakeSdk();
    const base = fake.sdk.createOpencodeClient({ baseUrl: "" });
    const sdk: OpenCodeSdkLike = {
      createOpencodeClient: () => ({
        ...base,
        event: {
          subscribe: async () => {
            throw new Error("subscribe failed");
          },
        },
      }),
    };
    const client = createOpenCodeClient({
      loadSdk: async () => sdk,
      launchServer: async () => ({
        url: "http://127.0.0.1:1",
        pid: 1,
        close: async () => {},
      }),
      model: { providerID: "openai", modelID: "test-model" },
      readSystemPrompt: async () => "SYSTEM",
    });
    await expect(client.createSession(INPUT)).rejects.toThrow(/subscribe/);
    expect(fake.abortCalls()).toBe(1);
  });

  test("abort reaches the provider", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);
    await client.abort(session);
    expect(fake.abortCalls()).toBe(1);
  });

  // pr-hero ships with ZERO runtime dependencies; the SDK is an optional
  // peer. A Claude-only install that never routes here must not break, and
  // one that DOES route here must be told what to install rather than
  // handed a module-resolution stack trace.
  test("a missing SDK fails with an actionable message", async () => {
    const client = createOpenCodeClient({
      loadSdk: async () => {
        throw new Error("Cannot find module '@opencode-ai/sdk'");
      },
      launchServer: async () => ({
        url: "http://127.0.0.1:1",
        pid: 1,
        close: async () => {},
      }),
      model: { providerID: "openai", modelID: "test-model" },
      readSystemPrompt: async () => "SYSTEM",
    });
    await expect(client.createSession(INPUT)).rejects.toThrow(
      /@opencode-ai\/sdk/,
    );
  });
});
