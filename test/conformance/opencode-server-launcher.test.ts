import { describe, expect, test } from "bun:test";
import type { CredentialBroker } from "../../src/security/credential-broker";
import {
  composeOpenCodeServerEnv,
  launchOpenCodeServer,
  launchProjectedOpenCodeServer,
} from "../../src/transports/opencode-server";

const BIN = "/opt/homebrew/bin/opencode";
const PID = 515151;

interface FakeServer {
  spawnFn: typeof Bun.spawn;
  argv: () => string[];
  env: () => Record<string, string> | undefined;
  emit: (line: string) => void;
  killFn: (pid: number, signal?: string | number) => void;
  stdoutPulls: () => number;
  stderrRead: () => boolean;
  signals: () => Array<string | number | undefined>;
  finish: (code: number) => void;
}

function fakeServer(options: { pid?: number } = {}): FakeServer {
  let argv: string[] = [];
  let env: Record<string, string> | undefined;
  let push!: (chunk: string) => void;
  let closeOut!: () => void;
  const signals: Array<string | number | undefined> = [];
  let releaseExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    releaseExit = resolve;
  });
  const encoder = new TextEncoder();

  let stderrRead = false;
  // `pull` fires only when a consumer is actually taking chunks. If the
  // reader returned after startup, this counter stops moving — which is
  // exactly the defect under test.
  let pulls = 0;
  const stdout = new ReadableStream<Uint8Array>({
    pull() {
      pulls += 1;
    },
    start(controller) {
      push = (chunk) => controller.enqueue(encoder.encode(chunk));
      closeOut = () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
    },
  });

  const spawnFn = ((cmd: string[], opts?: { env?: Record<string, string> }) => {
    argv = cmd;
    env = opts?.env;
    return {
      pid: options.pid ?? PID,
      stdout,
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          stderrRead = true;
          c.close();
        },
      }),
      exited,
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;

  return {
    spawnFn,
    killFn: (_pid: number, signal?: string | number) => {
      signals.push(signal);
    },
    argv: () => argv,
    env: () => env,
    stdoutPulls: () => pulls,
    stderrRead: () => stderrRead,
    emit: (line) => push(line),
    signals: () => signals,
    finish: (code) => {
      closeOut();
      releaseExit(code);
    },
  };
}

const LISTENING = "opencode server listening on http://127.0.0.1:51234\n";

describe("launchOpenCodeServer", () => {
  test("resolves the URL the server prints, not a guessed one", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: { HOME: "/tmp/proj" },
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;
    expect(server.url).toBe("http://127.0.0.1:51234");
    fake.finish(0);
    await server.close();
  });

  // The SDK's own createOpencodeServer defaults to port 4096, a FIXED port —
  // two concurrent reviews would collide on it. An ephemeral port plus reading
  // back the real URL is the only shape that survives parallel hunters.
  test("always asks for an ephemeral port", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: {},
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;
    const argv = fake.argv();
    expect(argv[0]).toBe(BIN);
    expect(argv).toContain("serve");
    const portIndex = argv.indexOf("--port");
    expect(portIndex).toBeGreaterThan(0);
    expect(argv[portIndex + 1]).toBe("0");
    fake.finish(0);
    await server.close();
  });

  // --pure runs the server without external plugins. Two reasons, and the
  // second is the one that matters: it drops the plugin.added flood the probe
  // recorded (45 of 71 events), AND it keeps third-party plugin code out of a
  // process that holds a projected credential (§6 threat model).
  test("runs without external plugins", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: {},
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;
    expect(fake.argv()).toContain("--pure");
    fake.finish(0);
    await server.close();
  });

  // THE isolation test. The SDK's helper does
  // `launch("opencode", args, {env: {...process.env, …}})` — inheriting the
  // operator's whole environment, which would hand the child the operator's
  // real HOME and walk straight past the §6.1 credential projection.
  test("passes EXACTLY the projected environment, never process.env", async () => {
    const fake = fakeServer();
    const projected = {
      HOME: "/tmp/projection",
      XDG_DATA_HOME: "/tmp/projection/.local/share",
    };
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: projected,
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;
    expect(fake.env()).toEqual(projected);
    fake.finish(0);
    await server.close();
  });

  // #141 §D: MCP arrives in the child's ENVIRONMENT at spawn, so the servers
  // are connected from the server's first byte. Nothing is added to a running
  // server after the fact, which is what leaves no window between "server up"
  // and "MCP connected" — the #128 race class.
  test("carries the MCP registry in OPENCODE_CONFIG_CONTENT at spawn", async () => {
    const fake = fakeServer();
    const projected = { HOME: "/tmp/projection" };
    const mcp = {
      codegraph: {
        type: "local" as const,
        command: ["/opt/homebrew/bin/codegraph", "serve", "--mcp", "-p", "/w"],
        enabled: true as const,
      },
    };
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: projected,
      mcp,
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;

    const env = fake.env();
    expect(env?.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify({ mcp }));
    // The projection is still passed through in full; the config is the ONE
    // documented addition, never a merge of process.env.
    expect(env?.HOME).toBe("/tmp/projection");
    expect(Object.keys(env ?? {}).sort()).toEqual([
      "HOME",
      "OPENCODE_CONFIG_CONTENT",
    ]);
    fake.finish(0);
    await server.close();
  });

  // Parity with claude-code on a repo with no codegraph index: pr-hero writes
  // {"mcpServers":{}} and the hunters run on read/grep/glob. An empty `mcp`
  // object delivered as config would be a claim about the child's tool
  // channels that pr-hero is not making.
  test("delivers no config at all when there is no MCP to deliver", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: { HOME: "/tmp/projection" },
      mcp: {},
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;
    expect(fake.env()).toEqual({ HOME: "/tmp/projection" });
    fake.finish(0);
    await server.close();
  });

  test("refuses a binary path that was never resolved to an absolute one", async () => {
    const fake = fakeServer();
    await expect(
      launchOpenCodeServer({
        verifiedBinaryPath: "opencode",
        env: {},
        spawnFn: fake.spawnFn,
        killFn: fake.killFn,
      }),
    ).rejects.toThrow(/absolute/i);
    // §13: nothing may spawn before the binary is verified.
    expect(fake.argv()).toEqual([]);
  });

  test("a server that never announces itself is killed, not awaited forever", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: {},
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
      startupTimeoutMs: 5,
      // Bounded on purpose. The startup timer fires `void close()` and
      // rejects immediately, so with the 2s production defaults this test
      // would return while ~4s of real timer-driven cascade kept running
      // against the shared fake, after the suite had already reported.
      termGraceMs: 5,
      killReapMs: 5,
    });
    await expect(pending).rejects.toThrow(/did not announce|timed out/i);
    // Let the fire-and-forget cascade finish INSIDE the test that started it.
    fake.finish(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.signals()).toContain("SIGTERM");
  });

  test("a server that exits during startup fails loud", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: {},
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.finish(1);
    await expect(pending).rejects.toThrow(/exited/i);
  });

  // The line arrives split across chunks in practice; a parser that only
  // inspects whole chunks drops the announcement and then times out on a
  // server that started perfectly well.
  test("the announcement is found even when it arrives in pieces", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: {},
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit("opencode server li");
    fake.emit("stening on http://127.0.0.1:6");
    fake.emit("1234\n");
    const server = await pending;
    expect(server.url).toBe("http://127.0.0.1:61234");
    fake.finish(0);
    await server.close();
  });

  // pr-hero F002 on this PR. The reader returned once the URL was parsed, so
  // nothing drained proc.stdout for the rest of the child's life — and the
  // handle exposes no way to resume. A server that logs after startup fills
  // the ~64 KiB pipe buffer and BLOCKS in write(), stalling with no signal to
  // the caller. stderr was worse: piped and never read at all.
  test("both pipes keep a reader after startup", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: {},
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    const server = await pending;

    const pullsAfterStartup = fake.stdoutPulls();
    // Post-startup chatter must still be consumed, not left in the pipe.
    for (let i = 0; i < 64; i += 1) fake.emit(`request ${i} served\n`);
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.stdoutPulls()).toBeGreaterThan(pullsAfterStartup);
    expect(fake.stderrRead()).toBe(true);

    fake.finish(0);
    await server.close();
  });

  test("close escalates TERM then KILL and is idempotent", async () => {
    const fake = fakeServer();
    const pending = launchOpenCodeServer({
      verifiedBinaryPath: BIN,
      env: {},
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
      termGraceMs: 5,
    });
    fake.emit(LISTENING);
    const server = await pending;

    const closing = server.close();
    // The child ignores TERM; the cascade must escalate rather than hang.
    await new Promise((r) => setTimeout(r, 30));
    fake.finish(0);
    await closing;

    expect(fake.signals()).toContain("SIGTERM");
    expect(fake.signals()).toContain("SIGKILL");
    const before = fake.signals().length;
    await server.close();
    expect(fake.signals().length).toBe(before);
  });
});

// #149: the server launched with `env: {}` resolved the OPERATOR's real home
// for both config (their MCP servers) and data (their auth.json), so every
// OpenCode inference authenticated against their credential store while the
// per-attempt projection was built, never read, and destroyed. These tests
// pin the fix: the server runs under a projection whose lifetime is the
// server's, composed from an allowlist that is deliberately NOT the harness's.
describe("projected server launch (#149)", () => {
  interface FakeProjection {
    broker: CredentialBroker;
    destroys: () => number;
    projects: () => number;
  }

  const PROJECTION_ENV = {
    HOME: "/tmp/proj-home",
    TMPDIR: "/tmp/proj-home/tmp",
    XDG_DATA_HOME: "/tmp/proj-home/.local/share",
    XDG_CONFIG_HOME: "/tmp/proj-home/.config",
  } as const;

  function fakeBroker(
    options: { failWith?: Error; onDestroy?: () => void } = {},
  ): FakeProjection {
    let destroys = 0;
    let projects = 0;
    const broker: CredentialBroker = {
      project: async () => {
        projects += 1;
        if (options.failWith !== undefined) throw options.failWith;
        return {
          projectionId: "cred-fake",
          kind: "opencode_chatgpt_oauth",
          syntheticHome: PROJECTION_ENV.HOME,
          syntheticConfigHome: PROJECTION_ENV.XDG_CONFIG_HOME,
          syntheticTmp: PROJECTION_ENV.TMPDIR,
          env: { ...PROJECTION_ENV },
          files: [],
          destroy: async () => {
            destroys += 1;
            options.onDestroy?.();
          },
        };
      },
    };
    return { broker, destroys: () => destroys, projects: () => projects };
  }

  test("the spawn env is the server allowlist plus the projection, exactly", async () => {
    const fake = fakeServer();
    const proj = fakeBroker();
    const pending = launchProjectedOpenCodeServer({
      verifiedBinaryPath: BIN,
      broker: proj.broker,
      baseEnv: {
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
        // Measured live on opencode 1.18.23: an ambient provider key
        // CONNECTS that provider. Both of these are in the harness's
        // ENV_PASSTHROUGH, which is why the server cannot reuse that list —
        // composing from it would reintroduce this exact leak through the fix.
        ANTHROPIC_API_KEY: "sk-ant-must-not-reach-the-server",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-the-server",
        // The operator's real identity: pinned over by the projection.
        HOME: "/Users/operator",
        TMPDIR: "/var/folders/operator",
        // Not on any allowlist.
        EDITOR: "vim",
      },
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    await pending;

    expect(fake.env()).toEqual({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      ...PROJECTION_ENV,
    });
  });

  test("the projection wins over an allowlisted key of the same name", () => {
    // No overlap exists today (the allowlist is operational, the projection is
    // identity), so the launch tests above cannot exercise this. It is a
    // forward guard, and an untested one would be decoration: a broker that
    // later pinned PATH must not be silently overridden by pr-hero own.
    expect(
      composeOpenCodeServerEnv(
        { PATH: "/inherited/bin", LANG: "en_US.UTF-8" },
        { HOME: "/tmp/proj", PATH: "/projected/bin" },
      ),
    ).toEqual({
      PATH: "/projected/bin",
      LANG: "en_US.UTF-8",
      HOME: "/tmp/proj",
    });
  });

  test("close() destroys the projection", async () => {
    const fake = fakeServer();
    const proj = fakeBroker();
    const pending = launchProjectedOpenCodeServer({
      verifiedBinaryPath: BIN,
      broker: proj.broker,
      baseEnv: { PATH: "/usr/bin" },
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
      termGraceMs: 5,
    });
    fake.emit(LISTENING);
    const server = await pending;

    const closing = server.close();
    fake.finish(0);
    await closing;

    expect(proj.destroys()).toBe(1);
  });

  test("the projection outlives the process it authenticates", async () => {
    const fake = fakeServer();
    const order: string[] = [];
    const proj = fakeBroker({ onDestroy: () => order.push("destroy") });
    const pending = launchProjectedOpenCodeServer({
      verifiedBinaryPath: BIN,
      broker: proj.broker,
      baseEnv: { PATH: "/usr/bin" },
      spawnFn: fake.spawnFn,
      killFn: (_pid, signal) => {
        order.push(String(signal));
      },
      termGraceMs: 5,
    });
    fake.emit(LISTENING);
    const server = await pending;

    const closing = server.close();
    fake.finish(0);
    await closing;

    // Destroying the auth store while the server still holds it would pull
    // the credential out from under a live process. The shutdown cascade runs
    // first; the projection goes last.
    expect(order).toEqual(["SIGTERM", "destroy"]);
  });

  test("a failed launch destroys the projection instead of leaking it", async () => {
    const proj = fakeBroker();
    await expect(
      launchProjectedOpenCodeServer({
        verifiedBinaryPath: BIN,
        broker: proj.broker,
        baseEnv: { PATH: "/usr/bin" },
        spawnFn: (() => {
          throw new Error("spawn refused");
        }) as unknown as typeof Bun.spawn,
      }),
    ).rejects.toThrow("spawn refused");

    expect(proj.projects()).toBe(1);
    expect(proj.destroys()).toBe(1);
  });

  test("a projection failure fails the launch closed, with no spawn", async () => {
    const fake = fakeServer();
    const proj = fakeBroker({ failWith: new Error("no oauth record") });
    await expect(
      launchProjectedOpenCodeServer({
        verifiedBinaryPath: BIN,
        broker: proj.broker,
        baseEnv: { PATH: "/usr/bin" },
        spawnFn: fake.spawnFn,
      }),
    ).rejects.toThrow("no oauth record");

    // Degrading to the operator's environment here is precisely the bug.
    expect(fake.argv()).toEqual([]);
  });

  test("the projection is asked for the opencode credential the authority binds", async () => {
    const fake = fakeServer();
    let seen: { kind: string; verifiedBinaryPath: string } | undefined;
    const broker: CredentialBroker = {
      project: async (input) => {
        seen = {
          kind: input.kind,
          verifiedBinaryPath: input.verifiedBinaryPath,
        };
        return {
          projectionId: "cred-fake",
          kind: input.kind,
          syntheticHome: PROJECTION_ENV.HOME,
          syntheticConfigHome: PROJECTION_ENV.XDG_CONFIG_HOME,
          syntheticTmp: PROJECTION_ENV.TMPDIR,
          env: { ...PROJECTION_ENV },
          files: [],
          destroy: async () => {},
        };
      },
    };
    const pending = launchProjectedOpenCodeServer({
      verifiedBinaryPath: BIN,
      broker,
      baseEnv: { PATH: "/usr/bin" },
      spawnFn: fake.spawnFn,
      killFn: fake.killFn,
    });
    fake.emit(LISTENING);
    await pending;

    expect(seen).toEqual({
      kind: "opencode_chatgpt_oauth",
      verifiedBinaryPath: BIN,
    });
  });
});
