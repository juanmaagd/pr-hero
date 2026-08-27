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

import type { SpawnedProcess } from "../step-runner";

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
  // module never merges process.env into it, which is the whole point.
  readonly env: Readonly<Record<string, string>>;
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
  } = options;

  if (!verifiedBinaryPath.startsWith("/")) {
    throw new Error(
      `opencode server binary must be an absolute, verified path: ${verifiedBinaryPath}`,
    );
  }

  const proc = spawnFn(openCodeServerArgv(verifiedBinaryPath, hostname), {
    // EXACTLY the projected environment. Never `...process.env`.
    env: env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  }) as SpawnedProcess & { readonly pid: number };

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
      const decoder = new TextDecoder();
      try {
        for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
          if (settled) return;
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
              return;
            }
            finish(() => resolve(match[1]));
            return;
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
