import { describe, expect, test } from "bun:test";
import { launchOpenCodeServer } from "../../src/transports/opencode-server";

const BIN = "/opt/homebrew/bin/opencode";
const PID = 515151;

interface FakeServer {
  spawnFn: typeof Bun.spawn;
  argv: () => string[];
  env: () => Record<string, string> | undefined;
  emit: (line: string) => void;
  killFn: (pid: number, signal?: string | number) => void;
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

  const stdout = new ReadableStream<Uint8Array>({
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
    });
    await expect(pending).rejects.toThrow(/did not announce|timed out/i);
    expect(fake.signals().length).toBeGreaterThan(0);
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
