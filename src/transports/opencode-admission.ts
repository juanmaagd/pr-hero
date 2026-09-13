import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface OpenCodeObservedIdentity {
  readonly sdkVersion: string;
  readonly serverVersion: string;
  readonly executablePath: string;
  readonly executableSha256: string;
}
export interface OpenCodeExecutableIdentity {
  readonly absolutePath: string;
  readonly verifiedExecutionPath: string;
  readonly sha256: string;
}
export type OpenCodeIdentityObserver = (
  executable: OpenCodeExecutableIdentity,
  signal?: AbortSignal,
) => Promise<OpenCodeObservedIdentity>;

// Independently derived from anomalyco/opencode tag v1.18.30, commit
// 3104c1428ec91f809e5ab86631300de41eb6952e, packages/sdk/openapi.json.
// Source SHA256 00502bd13e9c86f3ca9e765e99a57e06fa9f434ca16f2a714766d1444f8d37f3.
// Same consumed projection independently matches SDK 1.18.25. This is a
// qualification policy, never a digest manufactured from the running server.
export const OPENCODE_CONSUMED_CONTRACT_SHA256 =
  "0126721f557bfb0fcbeed3567392416394921d0c5d38798392608ffd8f63e95d";
const operations: Record<string, readonly string[]> = {
  "/global/health": ["get"],
  "/session": ["post"],
  "/session/{sessionID}/message": ["get", "post"],
  "/session/status": ["get"],
  "/session/{sessionID}/abort": ["post"],
  "/experimental/tool/ids": ["get"],
  "/mcp": ["get"],
  "/event": ["get"],
};
const events = [
  "EventMessageUpdated",
  "EventMessageRemoved",
  "EventMessagePartUpdated",
  "EventMessagePartRemoved",
  "EventMessagePartDelta",
  "EventSessionError",
  "EventSessionStatus",
  "EventSessionIdle",
  "EventServerConnected",
];
const annotations = new Set([
  "description",
  "summary",
  "title",
  "examples",
  "example",
  "x-codeSamples",
  "tags",
]);
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("OpenCode contract object missing");
  return value as Record<string, unknown>;
}
function normalize(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    const values = value.map((item) => normalize(item));
    return [
      "required",
      "enum",
      "anyOf",
      "oneOf",
      "allOf",
      "parameters",
    ].includes(key)
      ? values.sort((a, b) =>
          JSON.stringify(a) < JSON.stringify(b)
            ? -1
            : JSON.stringify(a) > JSON.stringify(b)
              ? 1
              : 0,
        )
      : values;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(record(value))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([name]) => key === "properties" || !annotations.has(name))
        .map(([name, item]) => [name, normalize(item, name)]),
    );
  }
  return value;
}
export function consumedOpenCodeContractDigest(document: unknown): string {
  const root = record(document);
  const allPaths = record(root.paths);
  const sourceSchemas = record(record(root.components).schemas);
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};
  for (const [path, methods] of Object.entries(operations)) {
    paths[path] = Object.fromEntries(
      methods.map((method) => {
        const operation = record(allPaths[path])[method];
        if (operation === undefined)
          throw new Error(`OpenCode contract lacks ${method} ${path}`);
        return [method, operation];
      }),
    );
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = record(value);
    if (typeof node.$ref === "string") {
      if (!node.$ref.startsWith("#/components/schemas/"))
        throw new Error("Unsupported OpenCode contract reference");
      const name = node.$ref.slice("#/components/schemas/".length);
      if (name in schemas) return;
      let schema = record(sourceSchemas[name]);
      if (name === "Event") {
        const branches = schema.anyOf;
        if (!Array.isArray(branches))
          throw new Error("OpenCode Event union unavailable");
        const refs = new Set(branches.map((branch) => record(branch).$ref));
        if (events.some((event) => !refs.has(`#/components/schemas/${event}`)))
          throw new Error("OpenCode consumed Event branch missing");
        schema = {
          anyOf: events.map((event) => ({
            $ref: `#/components/schemas/${event}`,
          })),
        };
      }
      schemas[name] = schema;
      visit(schema);
    } else for (const item of Object.values(node)) visit(item);
  };
  visit(paths);
  return createHash("sha256")
    .update(JSON.stringify(normalize({ paths, components: { schemas } })))
    .digest("hex");
}

async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // The promise may have been constructed by the caller before cancellation.
  // Observe its rejection even when the pre-aborted branch wins immediately.
  void work.catch(() => {});
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () =>
          reject(signal.reason ?? new Error("OpenCode observation aborted"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function boundedText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await withAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw new Error("OpenCode observation byte limit exceeded");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}

export async function observeOpenCodeExecutable(
  executable: OpenCodeExecutableIdentity,
  signal?: AbortSignal,
  dependencies: {
    spawn?: typeof Bun.spawn;
    sdkVersion?: () => Promise<string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<OpenCodeObservedIdentity> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("OpenCode version observation deadline")),
    dependencies.timeoutMs ?? 2_000,
  );
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  const kill = () => {
    try {
      proc?.kill("SIGKILL");
    } catch {}
  };
  controller.signal.addEventListener("abort", kill, { once: true });
  try {
    const bytes = await withAbort(
      readFile(executable.absolutePath, { signal: controller.signal }),
      controller.signal,
    );
    if (createHash("sha256").update(bytes).digest("hex") !== executable.sha256)
      throw new Error("OpenCode executable changed before version observation");
    controller.signal.throwIfAborted();
    proc = (dependencies.spawn ?? Bun.spawn)(
      [executable.verifiedExecutionPath, "--version"],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {} },
    );
    const [stdout, , code] = await withAbort(
      Promise.all([
        boundedText(
          proc.stdout as ReadableStream<Uint8Array>,
          4096,
          controller.signal,
        ),
        boundedText(
          proc.stderr as ReadableStream<Uint8Array>,
          4096,
          controller.signal,
        ),
        proc.exited,
      ]),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    const serverVersion = stdout.trim();
    if (code !== 0 || !/^\d+\.\d+\.\d+$/.test(serverVersion))
      throw new Error("OpenCode version observation malformed");
    const sdkVersion = await withAbort(
      Promise.resolve(dependencies.sdkVersion?.()),
      controller.signal,
    );
    if (sdkVersion !== "1.18.25" || serverVersion !== "1.18.30")
      throw new Error(
        `Unsupported observed OpenCode pair: ${sdkVersion}/${serverVersion}`,
      );
    return Object.freeze({
      sdkVersion,
      serverVersion,
      executablePath: executable.absolutePath,
      executableSha256: executable.sha256,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", kill);
    controller.abort();
    kill();
    if (proc !== undefined) {
      let reapTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          proc.exited.catch(() => {}),
          new Promise<void>((resolve) => {
            reapTimer = setTimeout(resolve, 100);
          }),
        ]);
      } finally {
        if (reapTimer !== undefined) clearTimeout(reapTimer);
      }
    }
  }
}

export async function qualifyOpenCodeServer(
  url: string,
  expected: OpenCodeObservedIdentity,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<{
  serverVersion: string;
  consumedContractSha256: string;
  openApiDocumentSha256: string;
}> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("OpenCode health/doc deadline")),
    2_000,
  );
  const get = async (path: string) => {
    const response = await withAbort(
      fetcher(new URL(path, url), { signal: controller.signal }),
      controller.signal,
    );
    if (!response.ok || response.body === null)
      throw new Error(`OpenCode qualification unavailable: ${path}`);
    return JSON.parse(
      await boundedText(response.body, 2 * 1024 * 1024, controller.signal),
    );
  };
  try {
    const health = record(await get("/global/health"));
    if (health.healthy !== true || health.version !== expected.serverVersion)
      throw new Error(
        "OpenCode serving version differs from observed executable",
      );
    const document = await get("/doc");
    const consumedContractSha256 = consumedOpenCodeContractDigest(document);
    if (
      expected.sdkVersion !== "1.18.25" ||
      expected.serverVersion !== "1.18.30" ||
      consumedContractSha256 !== OPENCODE_CONSUMED_CONTRACT_SHA256
    )
      throw new Error("OpenCode served contract is not qualified");
    return {
      serverVersion: String(health.version),
      consumedContractSha256,
      openApiDocumentSha256: createHash("sha256")
        .update(JSON.stringify(document))
        .digest("hex"),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
