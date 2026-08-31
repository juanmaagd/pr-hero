// LIVE probe (#141, turn 2): measures the literal tool id OpenCode gives a
// connected MCP server's tool, and whether that id — written into
// `session.prompt`'s `tools` map — actually gates it.
//
//   bun run scripts/opencode-mcp-toolid-probe.ts [--model <provider/model>]
//
// Cost: $0.00 cash on the subscription route (the #116 ledger's measured
// billing arm). Two turns.
//
// WHY a live turn is the only instrument. The $0 surface probe
// (scripts/opencode-mcp-probe.ts) established that a CONNECTED MCP server
// contributes nothing to `tool.ids()` or `tool.list()`, so no enumeration
// endpoint can name its tool. OpenCode's docs state the contract as
// `<server>_<tool>` with non-alphanumerics normalised to `_`, but the `tools`
// field is an OPEN `{[key: string]: boolean}` map: a wrong key is swallowed
// without error. That is exactly #122, whose whole cost was a plausible tool
// id accepted silently. Documented is not measured.
//
// It runs with the operator's real HOME on purpose: the credential projection
// is not under test here, and the operator's own config already has codegraph
// connected, which is the condition being measured.

import path from "node:path";
import { launchOpenCodeServer } from "../src/transports/opencode-server";

const args = Bun.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const [providerID = "openai", modelID = "gpt-5.6-luna"] = (
  flag("model") ?? "openai/gpt-5.6-luna"
).split("/");
const repoDir = path.resolve(flag("dir") ?? process.cwd());

function realBinary(name: string): string {
  const decode = (out: Uint8Array): string =>
    new TextDecoder().decode(out).trim();
  const found = decode(Bun.spawnSync(["which", name]).stdout);
  if (!found) throw new Error(`${name} is not on PATH`);
  return decode(Bun.spawnSync(["readlink", "-f", found]).stdout) || found;
}

const SDK = "@opencode-ai/sdk";
// biome-ignore lint/suspicious/noExplicitAny: probe-local narrowing of an SDK
// surface whose exact generics are irrelevant to what is being measured.
const { createOpencodeClient } = (await import(`${SDK}/client`)) as any;

// Every tool name seen anywhere in the event stream. Collected by walking the
// raw payloads rather than by reaching for a field this probe expects to
// exist: assuming the shape is the failure mode #124 was made of.
function collectToolNames(payload: unknown, into: Set<string>): void {
  if (payload === null || typeof payload !== "object") return;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.tool === "string") into.add(obj.tool);
  if (obj.type === "tool" && typeof obj.name === "string") into.add(obj.name);
  for (const value of Object.values(obj)) collectToolNames(value, into);
}

interface TurnResult {
  label: string;
  tools: Record<string, boolean>;
  toolNamesSeen: string[];
  finalText: string;
  eventCount: number;
}

// biome-ignore lint/suspicious/noExplicitAny: see above.
async function turn(
  client: any,
  label: string,
  tools: Record<string, boolean>,
  userText: string,
): Promise<TurnResult> {
  console.error(`\n=== ${label}`);
  console.error(`  tools map: ${JSON.stringify(tools)}`);
  const session = (
    await client.session.create({ body: { title: `pr-hero #141 ${label}` } })
  ).data;

  // Subscribed BEFORE the prompt: the stream is global and unbuffered, so a
  // subscription opened afterwards silently misses the early events.
  const subscription = await client.event.subscribe();
  const seen = new Set<string>();
  let eventCount = 0;
  let stop = false;
  const reader = (async () => {
    for await (const raw of subscription.stream) {
      if (stop) return;
      const payload =
        (raw as { payload?: unknown })?.payload ?? (raw as unknown);
      eventCount += 1;
      collectToolNames(payload, seen);
      if (eventCount > 2000) return;
    }
  })().catch(() => {
    // A stream that dies mid-probe is data, not a crash.
  });

  const response = await client.session.prompt({
    path: { id: session.id },
    query: { directory: repoDir },
    body: {
      model: { providerID, modelID },
      system:
        "You are probing tool availability. Follow the instruction exactly. " +
        "Do not explain, do not summarise, do not narrate a plan.",
      tools,
      parts: [{ type: "text", text: userText }],
    },
  });
  stop = true;
  await reader;

  const parts = (response.data as { parts?: unknown[] })?.parts ?? [];
  collectToolNames(parts, seen);
  const finalText = parts
    .filter(
      (p): p is { type: string; text: string } =>
        (p as { type?: string })?.type === "text" &&
        typeof (p as { text?: unknown })?.text === "string",
    )
    .map((p) => p.text)
    .join("")
    .trim();

  const toolNamesSeen = [...seen].sort();
  console.error(`  events: ${eventCount}`);
  console.error(`  tool names seen: ${JSON.stringify(toolNamesSeen)}`);
  console.error(`  final text: ${finalText.slice(0, 300)}`);
  return { label, tools, toolNamesSeen, finalText, eventCount };
}

const opencodeBin = realBinary("opencode");
const server = await launchOpenCodeServer({
  verifiedBinaryPath: opencodeBin,
  env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
});
console.error(`server ${server.url} (pid ${server.pid})`);

const results: TurnResult[] = [];
try {
  const client = createOpencodeClient({ baseUrl: server.url });
  const status = (await client.mcp.status({ query: { directory: repoDir } }))
    .data;
  console.error(`mcp.status: ${JSON.stringify(status)}`);

  // Turn 1 — an EMPTY tools map, which OpenCode documents as "all tools
  // enabled". Whatever the MCP tool is called, the model can reach it, and the
  // stream records the name the provider actually used.
  results.push(
    await turn(
      client,
      "turn-1: empty tools map, force an MCP call",
      {},
      "Call the codegraph MCP tool exactly once, with the query 'runPipeline', " +
        "then reply with only the literal name of the tool you called.",
    ),
  );

  // Turn 2 — the same instruction with every id the probe learned written
  // explicitly false, plus the built-ins false. If the map key is the real id,
  // the call is refused; if the key is a name OpenCode does not recognise, the
  // model calls the tool anyway and the map was decorative — the #122 failure.
  const learned = results[0].toolNamesSeen.filter((n) =>
    n.includes("codegraph"),
  );
  const denyMap: Record<string, boolean> = {};
  for (const id of [
    "read",
    "grep",
    "glob",
    "bash",
    "edit",
    "write",
    "task",
    "webfetch",
    "websearch",
    "todowrite",
    "skill",
    "apply_patch",
    "question",
    "invalid",
    ...learned,
  ]) {
    denyMap[id] = false;
  }
  results.push(
    await turn(
      client,
      `turn-2: every id false (learned: ${JSON.stringify(learned)})`,
      denyMap,
      "Call the codegraph MCP tool exactly once, with the query 'runPipeline'. " +
        "If you cannot call it, reply with only: REFUSED",
    ),
  );
} finally {
  await server.close();
}

const outPath = path.join(".prhero", "opencode-mcp-probe", "toolid-probe.json");
await Bun.write(
  outPath,
  `${JSON.stringify({ providerID, modelID, repoDir, results }, null, 2)}\n`,
);
console.error(`\nwrote ${outPath}`);
