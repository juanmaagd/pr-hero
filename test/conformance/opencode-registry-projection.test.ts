import { describe, expect, test } from "bun:test";
import type { CredentialBroker } from "../../src/security/credential-broker";
import { defaultOpenCodeLaunchServer } from "../../src/transport-registry";

// #149: the registry built the default launcher with `env: merged.env ?? {}`,
// and nothing on the review path supplied `env`. A server handed `{}` resolves
// the OPERATOR's real home for config (their MCP servers) and data (their
// auth.json), so the per-attempt credential projection was built, never read,
// and destroyed. These tests pin the launcher the registry hands out.
describe("the registry's default opencode launcher (#149)", () => {
  const PROJECTION_ENV = {
    HOME: "/tmp/proj-home",
    TMPDIR: "/tmp/proj-home/tmp",
    XDG_DATA_HOME: "/tmp/proj-home/.local/share",
    XDG_CONFIG_HOME: "/tmp/proj-home/.config",
  } as const;

  function fakeBroker(): { broker: CredentialBroker; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      broker: {
        project: async () => {
          calls += 1;
          return {
            projectionId: "cred-fake",
            kind: "opencode_chatgpt_oauth" as const,
            syntheticHome: PROJECTION_ENV.HOME,
            syntheticConfigHome: PROJECTION_ENV.XDG_CONFIG_HOME,
            syntheticTmp: PROJECTION_ENV.TMPDIR,
            env: { ...PROJECTION_ENV },
            files: [],
            destroy: async () => {},
          };
        },
      },
    };
  }

  function fakeSpawn(): {
    spawnFn: typeof Bun.spawn;
    env: () => Record<string, string> | undefined;
  } {
    let env: Record<string, string> | undefined;
    const encoder = new TextEncoder();
    const spawnFn = ((
      _cmd: string[],
      opts?: { env?: Record<string, string> },
    ) => {
      env = opts?.env;
      return {
        pid: 4242,
        stdout: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              encoder.encode(
                "opencode server listening on http://127.0.0.1:1234\n",
              ),
            );
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(c) {
            c.close();
          },
        }),
        exited: new Promise<number>(() => {}),
        kill() {},
      };
    }) as unknown as typeof Bun.spawn;
    return { spawnFn, env: () => env };
  }

  test("it launches under the projection, never under the operator's env", async () => {
    const spawn = fakeSpawn();
    const broker = fakeBroker();
    const launch = defaultOpenCodeLaunchServer({
      verifiedBinaryPath: "/opt/homebrew/bin/opencode",
      broker: broker.broker,
      baseEnv: {
        PATH: "/usr/bin",
        HOME: "/Users/operator",
        // In the harness's ENV_PASSTHROUGH, and measured live to CONNECT the
        // provider it names. The server's allowlist must not carry it.
        ANTHROPIC_API_KEY: "sk-ant-must-not-reach-the-server",
      },
      spawnFn: spawn.spawnFn,
      killFn: () => {},
    });

    await launch();

    expect(broker.calls()).toBe(1);
    expect(spawn.env()).toEqual({ PATH: "/usr/bin", ...PROJECTION_ENV });
  });

  test("it forwards the run's MCP registry to the spawn", async () => {
    const spawn = fakeSpawn();
    const broker = fakeBroker();
    const launch = defaultOpenCodeLaunchServer({
      verifiedBinaryPath: "/opt/homebrew/bin/opencode",
      broker: broker.broker,
      baseEnv: { PATH: "/usr/bin" },
      spawnFn: spawn.spawnFn,
      killFn: () => {},
    });

    await launch({
      codegraph: {
        type: "local",
        command: ["/usr/local/bin/codegraph", "serve", "--mcp"],
        enabled: true,
      },
    });

    // #141's delivery mechanism must survive the projection change: the
    // registry rides the spawn, so there is no window between "server up" and
    // "MCP connected" for a prompt to fall into.
    const delivered = spawn.env()?.OPENCODE_CONFIG_CONTENT;
    expect(delivered).toBeDefined();
    expect(JSON.parse(delivered as string).mcp.codegraph.enabled).toBe(true);
  });
});
