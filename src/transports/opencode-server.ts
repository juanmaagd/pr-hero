// D1-06: the OpenCode server the SDK client talks to, launched under pr-hero's
// own threat model instead of the SDK's convenience helper.
//
// WHY NOT `createOpencodeServer` from @opencode-ai/sdk. Its implementation is
// `launch("opencode", args, { env: { ...process.env, ... } })`, and both
// halves of that are disqualifying here:
//
//   * it inherits the operator's ENTIRE environment, so the child would see
//     the operator's real HOME and walk straight past the §6.1 credential
//     projection — the projection would exist and protect nothing;
//   * it resolves `opencode` off PATH, while §13 requires preflight and
//     execution to use the same verified absolute binary.
//
// It also defaults to port 4096, a fixed port two concurrent reviews would
// collide on. This module asks for an ephemeral port and reads back the URL
// the server actually prints.

import type { CredentialBroker } from "../security/credential-broker";
import type { SpawnedProcess } from "../step-runner";
import { mcpConfigIsEmpty, type OpenCodeMcpConfig } from "./opencode-mcp";

// The line the server prints on startup, verified live against
// opencode 1.18.23: "opencode server listening on http://127.0.0.1:<port>".
const LISTENING_PREFIX = "opencode server listening";
const LISTENING_URL = /on\s+(https?:\/\/[^\s]+)/;

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
// Same cascade shape as the CLI transport (§5.2): TERM, a bounded grace, then
// KILL. The numbers are smaller because a server that will not stop is not
// holding a paid generation — only a port.
const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_KILL_REAP_MS = 2_000;

// A piped stream nobody reads is a time bomb: the OS pipe buffer fills at
// ~64 KiB and the child BLOCKS in write(), stalling the whole server with no
// signal to the caller. Both pipes therefore keep a reader for the child's
// entire life, not just for startup.
async function drainToNowhere(stream: unknown): Promise<void> {
  try {
    for await (const _chunk of stream as AsyncIterable<Uint8Array>) {
      // Discarded on purpose — the point is to keep the pipe empty.
    }
  } catch {
    // A closed or errored pipe needs no draining.
  }
}

export interface OpenCodeServerHandle {
  readonly url: string;
  readonly pid: number;
  close(): Promise<void>;
}

export interface LaunchOpenCodeServerOptions {
  // Absolute and already verified by the caller. This module refuses a bare
  // name rather than resolving one itself: resolution is where the binary is
  // hashed, and a launcher that quietly accepted "opencode" would reintroduce
  // exactly the PATH lookup §13 forbids.
  readonly verifiedBinaryPath: string;
  // The COMPLETE environment for the child. Passed through untouched — this
  // module never merges process.env into it, which is the whole point. The ONE
  // documented addition is `mcp` below, and it is a value pr-hero computed
  // rather than one inherited from anywhere.
  readonly env: Readonly<Record<string, string>>;
  // #141: the run's MCP registry, translated from the Claude-shaped mcp.json
  // the binding policy already gates. Delivered as `OPENCODE_CONFIG_CONTENT`
  // at SPAWN, so the servers are connected from the server's first byte —
  // there is then no window between "server up" and "MCP connected" for a
  // prompt to fall into (the #128 race class). An empty registry delivers no
  // config at all: parity with claude-code on a repo with no codegraph index,
  // where the hunters run on read/grep/glob and pr-hero makes no claim about
  // the child's tool channels.
  readonly mcp?: OpenCodeMcpConfig;
  readonly spawnFn?: typeof Bun.spawn;
  // Injectable for offline tests; production signals the child by pid. Same
  // shape as ClaudeCodeCliTransport's, so the two shutdown paths read alike.
  readonly killFn?: (pid: number, signal?: string | number) => unknown;
  readonly startupTimeoutMs?: number;
  readonly termGraceMs?: number;
  readonly killReapMs?: number;
  readonly hostname?: string;
}

export function openCodeServerArgv(
  binaryPath: string,
  hostname: string,
): string[] {
  return [
    binaryPath,
    "serve",
    // No external plugins. Two reasons, and the second is the one that
    // matters: it drops the plugin.added flood the probe recorded (45 of 71
    // events for one prompt), and it keeps third-party plugin code out of a
    // process holding a projected credential.
    "--pure",
    "--hostname",
    hostname,
    // Ephemeral, always. The URL is read back from stdout.
    "--port",
    "0",
  ];
}

export async function launchOpenCodeServer(
  options: LaunchOpenCodeServerOptions,
): Promise<OpenCodeServerHandle> {
  const {
    verifiedBinaryPath,
    env,
    spawnFn = Bun.spawn,
    killFn = process.kill,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    termGraceMs = DEFAULT_TERM_GRACE_MS,
    killReapMs = DEFAULT_KILL_REAP_MS,
    hostname = "127.0.0.1",
    mcp,
  } = options;

  if (!verifiedBinaryPath.startsWith("/")) {
    throw new Error(
      `opencode server binary must be an absolute, verified path: ${verifiedBinaryPath}`,
    );
  }

  // The projection, plus the run's own MCP registry when there is one. The
  // config is READ from `OPENCODE_CONFIG_CONTENT` at startup, which is the
  // mechanism the SDK's own helper uses (dist/server.js:15) and the one
  // measured to work under `--pure` (#141 fact 1). Written here rather than by
  // the caller so the "exactly the projected environment" rule keeps a single
  // enforcement point.
  const childEnv: Record<string, string> =
    mcp === undefined || mcpConfigIsEmpty(mcp)
      ? { ...env }
      : { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp }) };

  const proc = spawnFn(openCodeServerArgv(verifiedBinaryPath, hostname), {
    // EXACTLY the projected environment. Never `...process.env`.
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  }) as SpawnedProcess & { readonly pid: number };

  // stderr is never parsed, so it is drained from the very first byte. It was
  // piped and then never read at all, which is the same pipe-full stall as
  // stdout with none of the startup logic to disguise it.
  void drainToNowhere(proc.stderr);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      killFn(proc.pid, "SIGTERM");
    } catch {
      // Already gone; nothing to escalate to.
    }
    const escalated = await Promise.race([
      proc.exited.then(() => "exited" as const),
      new Promise<"grace">((resolve) =>
        setTimeout(() => resolve("grace"), termGraceMs),
      ),
    ]);
    if (escalated === "grace") {
      try {
        killFn(proc.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      // BOUNDED reap. A child that does not die to SIGKILL is unreapable from
      // here — it is stuck in uninterruptible state or already a zombie whose
      // parent is elsewhere — and waiting on it forever would hang the
      // caller's shutdown on a process nothing can influence. Same reasoning
      // as the CLI transport's reap bound (§5.2).
      await Promise.race([
        proc.exited,
        new Promise<void>((resolve) => setTimeout(resolve, killReapMs)),
      ]);
    }
  };

  const url = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        void close();
        reject(
          new Error(
            `opencode server did not announce a listening URL within ${startupTimeoutMs}ms`,
          ),
        );
      });
    }, startupTimeoutMs);

    void proc.exited.then((code) => {
      finish(() => {
        reject(
          new Error(`opencode server exited during startup (code ${code})`),
        );
      });
    });

    void (async () => {
      // Accumulated across chunks on purpose: the announcement arrives split
      // in practice, and a parser that only inspected whole chunks would miss
      // a server that started perfectly well and then time out on it.
      let buffered = "";
      let announced = false;
      const decoder = new TextDecoder();
      try {
        for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
          // Once the URL is out, this loop stops PARSING but keeps READING:
          // the server logs for the rest of its life, and a pipe with no
          // reader fills and blocks the child in write().
          if (announced) continue;
          if (settled) {
            announced = true;
            continue;
          }
          buffered += decoder.decode(chunk, { stream: true });
          // COMPLETE lines only. A partial one can match both the prefix and
          // the URL pattern while the port is still arriving — "…127.0.0.1:6"
          // parses cleanly and points the client at port 6. The trailing
          // fragment stays buffered until its newline lands.
          const lines = buffered.split("\n");
          const complete = lines.slice(0, -1);
          buffered = lines[lines.length - 1] ?? "";
          for (const line of complete) {
            if (!line.startsWith(LISTENING_PREFIX)) continue;
            const match = line.match(LISTENING_URL);
            if (match === null) {
              finish(() => {
                void close();
                reject(
                  new Error(
                    `opencode server announced a line with no parseable URL: ${line}`,
                  ),
                );
              });
              announced = true;
              break;
            }
            finish(() => resolve(match[1]));
            announced = true;
            break;
          }
        }
      } catch {
        finish(() => {
          void close();
          reject(new Error("opencode server stdout ended before startup"));
        });
      }
    })();
  });

  return { url, pid: proc.pid, close };
}

// #149: the environment the server may inherit from pr-hero's own process.
//
// This list is deliberately NOT the harness's ENV_PASSTHROUGH, and the
// difference is the whole point. That list serves a claude-code child and
// carries ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN.
// opencode reads ambient provider keys as credential SOURCES — measured live
// on 1.18.23: launching with an otherwise-projected env plus a fake
// ANTHROPIC_API_KEY connected the `anthropic` provider, and plus a fake
// OPENAI_API_KEY connected `openai`. Composing the server's env from the
// harness's list would therefore reintroduce, through the fix, the very leak
// #149 is about.
//
// So: operational keys only. Nothing here can name a credential or a home.
const SERVER_ENV_PASSTHROUGH: readonly string[] = [
  // Not optional: the projection carries no PATH, and the measured-clean
  // configuration included it. `{HOME}` alone was never measured.
  "PATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

export function composeOpenCodeServerEnv(
  base: Readonly<Record<string, string | undefined>>,
  projectionEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const composed: Record<string, string> = {};
  for (const key of SERVER_ENV_PASSTHROUGH) {
    const value = base[key];
    if (value !== undefined) composed[key] = value;
  }
  // Last, and unconditionally: HOME/TMPDIR/XDG_* are the projection's to own.
  // An inherited value surviving here is the defect, not a fallback.
  return { ...composed, ...projectionEnv };
}

export interface LaunchProjectedOpenCodeServerOptions
  extends Omit<LaunchOpenCodeServerOptions, "env"> {
  // The credential authority's broker for this backend. Defaulting one here
  // would be a second source of truth beside runner-authority.ts, so the
  // caller supplies the same instance the binding was resolved with.
  readonly broker: CredentialBroker;
  // pr-hero's own environment, filtered through SERVER_ENV_PASSTHROUGH.
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}

// The server's env is its ENTIRE environment, and the server outlives every
// individual step, so the projection it runs under must outlive them too:
// one projection per SERVER, destroyed by the handle's close(). Handing the
// shared server a per-step projection would leave its HOME pointing at a
// directory deleted when that step settled, while siblings still used it.
export async function launchProjectedOpenCodeServer(
  options: LaunchProjectedOpenCodeServerOptions,
): Promise<OpenCodeServerHandle> {
  const { broker, baseEnv = {}, ...launchOptions } = options;

  const projection = await broker.project({
    // Three of these four are voided by the OpenCode broker; `kind` is the one
    // it reads, and it is the kind runner-authority.ts binds for this backend.
    sessionId: "opencode-server",
    credentialRef: "opencode-auth",
    kind: "opencode_chatgpt_oauth",
    verifiedBinaryPath: launchOptions.verifiedBinaryPath,
  });

  let handle: OpenCodeServerHandle;
  try {
    handle = await launchOpenCodeServer({
      ...launchOptions,
      env: composeOpenCodeServerEnv(baseEnv, projection.env),
    });
  } catch (error) {
    // The client resets its launch promise on failure and will project again,
    // so a projection abandoned here is a credential left on disk per retry.
    await projection.destroy();
    throw error;
  }

  return {
    url: handle.url,
    pid: handle.pid,
    close: async () => {
      try {
        await handle.close();
      } finally {
        await projection.destroy();
      }
    },
  };
}
