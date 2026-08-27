import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createOpenCodeClient,
  type OpenCodeSdkLike,
} from "../../src/transports/opencode-client";

const FIXTURE_DIR = path.join(import.meta.dir, "..", "fixtures", "opencode");
const ASSISTANT = JSON.parse(
  readFileSync(path.join(FIXTURE_DIR, "assistant-message.json"), "utf-8"),
) as Record<string, unknown>;

const SESSION_ID = "ses_test";

interface FakeSdk {
  sdk: OpenCodeSdkLike;
  promptCalls: () => Array<Record<string, unknown>>;
  abortCalls: () => number;
  subscribedAt: () => number;
  promptedAt: () => number;
  emit: (event: unknown) => void;
  endStream: () => void;
  setMessages: (messages: unknown[]) => void;
}

function fakeSdk(options: { promptHangs?: boolean } = {}): FakeSdk {
  const prompts: Array<Record<string, unknown>> = [];
  let aborts = 0;
  let order = 0;
  let subscribedAt = 0;
  let promptedAt = 0;
  let messages: unknown[] = [];
  const queue: unknown[] = [];
  let notify: (() => void) | undefined;
  let ended = false;

  const sdk: OpenCodeSdkLike = {
    createClient: () => ({
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
    promptCalls: () => prompts,
    abortCalls: () => aborts,
    subscribedAt: () => subscribedAt,
    promptedAt: () => promptedAt,
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

const INPUT = {
  cwd: "/tmp/work",
  userPrompt: "review this",
  systemPromptPath: "/tmp/system.md",
  tools: ["read", "grep"],
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
    expect(body.tools).toEqual({ read: true, grep: true, bash: false });
  });

  test("buffered events survive the gap between createSession and streamEvents", async () => {
    const fake = fakeSdk();
    const client = rig(fake);
    const session = await client.createSession(INPUT);
    fake.emit({
      type: "message.part.delta",
      properties: {
        sessionID: SESSION_ID,
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
