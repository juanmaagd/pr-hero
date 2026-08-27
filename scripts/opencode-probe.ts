// LIVE probe: records what @opencode-ai/sdk actually emits for one trivial
// prompt, so the D1-06 adapter is written against observed behaviour instead
// of plausible-looking type declarations. Findings live in
// docs/research/opencode-adapter-mapping.md; this script is how they are
// re-derived when the SDK moves.
//
//   bun run scripts/opencode-probe.ts [--out <dir>] [--model <provider/model>]
//
// Cost: one trivial prompt on a connected subscription (~$0). It spawns a
// local OpenCode server on an ephemeral port and closes it before exiting.
//
// The SDK is NOT a dependency of this package — the adapter slice adds it.
// Until then the probe resolves it from wherever it is installed and says so
// plainly rather than failing with a module-resolution stack trace.

import { mkdir } from "node:fs/promises";
import path from "node:path";

const args = Bun.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const outDir = path.resolve(
  flag("out") ?? path.join(".prhero", "opencode-probe"),
);
const [providerID = "openai", modelID = "gpt-5.6-terra-fast"] = (
  flag("model") ?? "openai/gpt-5.6-terra-fast"
).split("/");

let createOpencodeServer: (o: {
  hostname?: string;
  port?: number;
}) => Promise<{ url: string; close(): void }>;
let createOpencodeClient: (o: { baseUrl: string }) => {
  provider: { list(): Promise<{ data: { connected?: string[] } }> };
  session: {
    create(o: { body: { title: string } }): Promise<{ data: { id: string } }>;
    get(o: { path: { id: string } }): Promise<{ data: unknown }>;
    prompt(o: unknown): Promise<{ data: unknown }>;
  };
  event: { subscribe(): Promise<{ stream: AsyncIterable<unknown> }> };
};

// Resolved through a variable specifier on purpose. The SDK is not a
// dependency of this package yet, so a static import would make `tsc` report
// an unresolvable module for a file it is otherwise happy with — a standing
// false alarm in a directory the project gates do not cover anyway
// (CLAUDE.md). The runtime failure below is the real, actionable signal.
const SDK = "@opencode-ai/sdk";
try {
  ({ createOpencodeServer } = await import(`${SDK}/server`));
  ({ createOpencodeClient } = await import(`${SDK}/client`));
} catch {
  console.error(
    "@opencode-ai/sdk is not resolvable from this package.\n" +
      "Install it (`bun add -d @opencode-ai/sdk`) or run the probe from a\n" +
      "directory that has it. The adapter slice makes it a real dependency.",
  );
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
const server = await createOpencodeServer({ hostname: "127.0.0.1", port: 0 });
console.error(`server: ${server.url}`);

try {
  const client = createOpencodeClient({ baseUrl: server.url });

  const providers = (await client.provider.list()).data;
  console.error(`connected: ${JSON.stringify(providers.connected ?? [])}`);

  const session = (
    await client.session.create({ body: { title: "pr-hero d1-06 probe" } })
  ).data;
  console.error(`session: ${session.id}`);

  // Subscribed BEFORE the prompt: the stream is global and unbuffered, so a
  // subscription opened afterwards silently misses the early events — which
  // are exactly the ones that decide the adapter's shape.
  const subscription = await client.event.subscribe();
  const events: unknown[] = [];
  const reader = (async () => {
    for await (const raw of subscription.stream) {
      const payload =
        (raw as { payload?: unknown })?.payload ?? (raw as unknown);
      events.push(payload);
      if ((payload as { type?: string })?.type === "session.idle") return;
      if (events.length > 500) return;
    }
  })();

  const response = await client.session.prompt({
    path: { id: session.id },
    body: {
      model: { providerID, modelID },
      system: "Answer with one word only.",
      // Empty tool map: the probe measures the protocol, not tool use — and
      // this is the same field the adapter's deny floor writes into.
      tools: {},
      parts: [{ type: "text", text: "Reply with exactly: PONG" }],
    },
  });

  // Bounded so a provider that never goes idle cannot hang the probe.
  await Promise.race([
    reader,
    new Promise((resolve) => setTimeout(resolve, 30_000)),
  ]);

  const counts: Record<string, number> = {};
  for (const event of events) {
    const type = (event as { type?: string })?.type ?? "(untyped)";
    counts[type] = (counts[type] ?? 0) + 1;
  }

  await Bun.write(
    path.join(outDir, "events.json"),
    `${JSON.stringify(events, null, 2)}\n`,
  );
  await Bun.write(
    path.join(outDir, "prompt-response.json"),
    `${JSON.stringify(response.data, null, 2)}\n`,
  );
  await Bun.write(
    path.join(outDir, "session-get.json"),
    `${JSON.stringify((await client.session.get({ path: { id: session.id } })).data, null, 2)}\n`,
  );

  console.error(`events: ${events.length}`);
  console.error(JSON.stringify(counts, null, 2));
  console.error(`artifacts: ${outDir}`);
} finally {
  // Always: the server is a spawned child, and leaving it bound outlives the
  // probe and the port.
  server.close();
}
