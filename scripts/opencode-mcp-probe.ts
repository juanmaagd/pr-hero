// LIVE probe (#141): records how the OpenCode server pr-hero actually launches
// receives MCP config, and whether a connected MCP server contributes anything
// the tool allow-map can see. Written because #141 forbids inferring the
// mechanism from the `mcpConfigPath` field that already exists in the
// transport — the same inference class that produced #121, #124 and #127, each
// invisible to the offline suites because the fixtures encoded the code's own
// assumption.
//
//   bun run scripts/opencode-mcp-probe.ts [--out <dir>] [--dir <repo>]
//
// Cost: $0.00. No session is prompted, so no inference is billed. The probe
// only interrogates the server's MCP and tool-registry surfaces.
//
// It launches through pr-hero's OWN launcher, not the SDK's convenience
// helper, because the question is what happens under `--pure` and under an
// exact projected environment — the conditions production actually runs in.
// Probing the SDK helper would measure a server pr-hero never starts.
//
// PASS 1 (recorded, and why the synthetic-home arms below exist): run with the
// operator's real HOME, `mcp.status` reported `codegraph: connected` BEFORE the
// probe added anything. The source was the operator's own
// ~/.config/opencode/opencode.jsonc. Two consequences drive this pass:
//   * `--pure` does not suppress config-file MCP servers, so any arm that
//     carries the real HOME measures the operator's machine, not pr-hero;
//   * production pins HOME/XDG_CONFIG_HOME/XDG_DATA_HOME to a synthetic
//     projection root (src/security/credential-broker.ts:450-456), so the
//     production condition is an EMPTY config home. Every arm below builds one.

import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchOpenCodeServer } from "../src/transports/opencode-server";

const args = Bun.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const repoDir = path.resolve(flag("dir") ?? process.cwd());
const outDir = path.resolve(
  flag("out") ?? path.join(".prhero", "opencode-mcp-probe"),
);

// A name the operator's config cannot also be using. Pass 1 named the server
// `codegraph`, which collides with the operator's own entry — every status
// reading was then ambiguous about which server it described.
const PROBE_SERVER = "prhero-codegraph";

// Both binaries are resolved to a real absolute path up front. The MCP server
// is spawned BY the opencode server, which inherits the exact environment the
// launcher was given — an environment with no PATH in production. A bare
// `codegraph` in the command array would fail to resolve for a reason that has
// nothing to do with the mechanism under test.
function realBinary(name: string): string {
  const decode = (out: Uint8Array): string =>
    new TextDecoder().decode(out).trim();
  const found = decode(Bun.spawnSync(["which", name]).stdout);
  if (!found) throw new Error(`${name} is not on PATH`);
  const resolved = decode(Bun.spawnSync(["readlink", "-f", found]).stdout);
  return resolved || found;
}

const opencodeBin = realBinary("opencode");
const codegraphBin = realBinary("codegraph");

// The Claude-side config re-expressed in OpenCode's Config.mcp shape
// (McpLocalConfig, types.gen.d.ts:946-969): one `command` array instead of
// command+args, and `"local"` instead of `"stdio"`.
const codegraphMcpConfig = {
  type: "local" as const,
  command: [codegraphBin, "serve", "--mcp", "-p", repoDir],
  enabled: true,
};

interface McpSurface {
  status(o?: { query?: { directory?: string } }): Promise<{ data?: unknown }>;
  add(o: {
    body: { name: string; config: unknown };
    query?: { directory?: string };
  }): Promise<{ data?: unknown }>;
  connect(o: {
    path: { name: string };
    query?: { directory?: string };
  }): Promise<{ data?: unknown }>;
}

interface ProbeClient {
  tool: {
    ids(o: { query: { directory: string } }): Promise<{ data?: unknown }>;
    list(o: {
      query: { directory?: string; provider: string; model: string };
    }): Promise<{ data?: unknown }>;
  };
  mcp?: McpSurface;
}

// The SDK's type declarations prove the CLIENT can express these calls; they
// prove nothing about the server answering them. Absence is a finding to
// record, not a crash — every caller runs inside `record`, which captures it.
function mcpOf(client: ProbeClient): McpSurface {
  const mcp = client.mcp;
  if (!mcp) throw new Error("client.mcp is absent on this SDK build");
  return mcp;
}

const SDK = "@opencode-ai/sdk";
let createOpencodeClient: (o: { baseUrl: string }) => ProbeClient;
try {
  ({ createOpencodeClient } = await import(`${SDK}/client`));
} catch {
  console.error(`${SDK} is not resolvable from this package.`);
  process.exit(1);
}

interface Call {
  label: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

// Every call is recorded whether it succeeds or not: a rejection here is the
// finding, not an incident.
async function record(
  label: string,
  fn: () => Promise<unknown>,
): Promise<Call> {
  try {
    const value = await fn();
    console.error(`  ok   ${label}`);
    return { label, ok: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  FAIL ${label}: ${message}`);
    return { label, ok: false, error: message };
  }
}

function idsOf(response: unknown): string[] {
  const data = (response as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : ((entry as { id?: unknown })?.id as string | undefined),
    )
    .filter((id): id is string => typeof id === "string")
    .sort();
}

// A synthetic config/data home, empty, mirroring what the credential broker
// projects in production. Nothing the operator configured is reachable from
// it — which is the point: an arm carrying the real HOME cannot tell pr-hero's
// behaviour apart from the operator's machine settings.
async function syntheticHome(): Promise<{
  home: string;
  env: Record<string, string>;
}> {
  const home = await mkdtemp(path.join(os.tmpdir(), "prhero-mcp-probe-"));
  await mkdir(path.join(home, ".config"), { recursive: true });
  await mkdir(path.join(home, ".local", "share"), { recursive: true });
  await mkdir(path.join(home, "tmp"), { recursive: true });
  return {
    home,
    env: {
      HOME: home,
      // Pinned because the cited projection pins it. The launcher passes its
      // env through with no merge from process.env, so a key omitted here is
      // a key the child simply does not have — and a probe whose child differs
      // from the production condition in an undocumented way is measuring
      // something other than what it claims to.
      TMPDIR: path.join(home, "tmp"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      // The ONE deliberate deviation from that projection, called out rather
      // than left to be discovered: PATH is carried so a failure here is
      // about MCP rather than about process spawning. Production projects
      // none, which is exactly why every command array above is absolute.
      PATH: process.env.PATH ?? "",
    },
  };
}

interface ArmResult {
  arm: string;
  note: string;
  envKeys: string[];
  mcpSurfacePresent?: boolean;
  toolIds?: string[];
  toolIdsAfter?: string[];
  newToolIds?: string[];
  toolListIds?: string[];
  calls: Call[];
}

// Every arm runs the same interrogation so the readings are comparable; only
// the environment and the delivery mechanism change. One variable per arm.
async function runArm(
  arm: string,
  note: string,
  env: Record<string, string>,
  deliver?: (client: ProbeClient, arm: ArmResult) => Promise<void>,
): Promise<ArmResult> {
  console.error(`\n=== ${arm}: ${note}`);
  const result: ArmResult = { arm, note, envKeys: Object.keys(env), calls: [] };
  const server = await launchOpenCodeServer({
    verifiedBinaryPath: opencodeBin,
    env,
  });
  console.error(`  server ${server.url} (pid ${server.pid})`);
  try {
    const client = createOpencodeClient({ baseUrl: server.url });
    result.mcpSurfacePresent = typeof client.mcp?.add === "function";

    const before = await record("mcp.status (at launch)", () =>
      mcpOf(client).status({ query: { directory: repoDir } }),
    );
    result.calls.push(before);

    const ids = await record("tool.ids (at launch)", () =>
      client.tool.ids({ query: { directory: repoDir } }),
    );
    result.calls.push(ids);
    result.toolIds = idsOf(ids.value);

    if (deliver) await deliver(client, result);

    const after = await record("tool.ids (after delivery)", () =>
      client.tool.ids({ query: { directory: repoDir } }),
    );
    result.calls.push(after);
    result.toolIdsAfter = idsOf(after.value);
    const baseline = new Set(result.toolIds);
    result.newToolIds = result.toolIdsAfter.filter((id) => !baseline.has(id));

    // `tool.ids` is `/experimental/tool/ids`; `tool.list` is the model-scoped
    // surface (`/experimental/tool`). Pass 1 showed a CONNECTED MCP server
    // contributing nothing to `tool.ids`, so the allow-map's enumeration
    // source may simply not be where MCP tools live. This is the second place
    // to look, and the only other one the SDK exposes.
    const listed = await record("tool.list (openai/gpt-5.6-luna)", () =>
      client.tool.list({
        query: {
          directory: repoDir,
          provider: "openai",
          model: "gpt-5.6-luna",
        },
      }),
    );
    result.calls.push(listed);
    result.toolListIds = idsOf(listed.value);
  } finally {
    await server.close();
  }
  return result;
}

await mkdir(outDir, { recursive: true });
console.error(`opencode:  ${opencodeBin}`);
console.error(`codegraph: ${codegraphBin}`);
console.error(`directory: ${repoDir}`);

const results: ArmResult[] = [];

// Arm A — the production condition itself: synthetic config home, no MCP
// delivered by anything. Establishes the baseline every other arm is read
// against, and confirms that pass 1's `codegraph: connected` came from the
// operator's config rather than from the server's own defaults.
{
  const { env } = await syntheticHome();
  results.push(
    await runArm("A/baseline", "synthetic config home, no MCP delivered", env),
  );
}

// Arm B — OPENCODE_CONFIG_CONTENT, the route the SDK's own createOpencodeServer
// uses (dist/server.js:15), under `--pure` and an empty config home.
{
  const { env } = await syntheticHome();
  results.push(
    await runArm("B/config-env", "OPENCODE_CONFIG_CONTENT under --pure", {
      ...env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        mcp: { [PROBE_SERVER]: codegraphMcpConfig },
      }),
    }),
  );
}

// Arm C — a config FILE inside the synthetic config home. The projection
// already owns XDG_CONFIG_HOME, so if the server reads it this is the cheapest
// mechanism: pr-hero writes one file into a directory it already controls.
{
  const { home, env } = await syntheticHome();
  await mkdir(path.join(home, ".config", "opencode"), { recursive: true });
  await Bun.write(
    path.join(home, ".config", "opencode", "opencode.json"),
    `${JSON.stringify({ mcp: { [PROBE_SERVER]: codegraphMcpConfig } }, null, 2)}\n`,
  );
  results.push(
    await runArm("C/config-file", "opencode.json in XDG_CONFIG_HOME", env),
  );
}

// Arm D — the runtime API, on a server started with nothing configured.
{
  const { env } = await syntheticHome();
  results.push(
    await runArm(
      "D/runtime-api",
      "client.mcp.add + connect after launch",
      env,
      async (client, arm) => {
        arm.calls.push(
          await record("mcp.add", () =>
            mcpOf(client).add({
              body: { name: PROBE_SERVER, config: codegraphMcpConfig },
              query: { directory: repoDir },
            }),
          ),
        );
        arm.calls.push(
          await record("mcp.connect", () =>
            mcpOf(client).connect({
              path: { name: PROBE_SERVER },
              query: { directory: repoDir },
            }),
          ),
        );
        arm.calls.push(
          await record("mcp.status (after add)", () =>
            mcpOf(client).status({ query: { directory: repoDir } }),
          ),
        );
      },
    ),
  );
}

// Arm E — the directory-scope question, and the reason it is an ARM rather
// than a comment. `assertMcpConnected` reads the connected set back with
// `query.directory` set to the review target, while the server inherits
// pr-hero's own cwd and never the worktree — so in PR mode those two paths
// always differ. #127 is the precedent that makes this worth measuring:
// session.status returned {} for a BUSY session given a directory the server
// was not started in, which is why pollStatus omits the parameter. If
// mcp.status scoped the same way, the readback would abort every PR-mode step.
//
// A comment asserting it does not would be exactly the kind of claim this
// repo has already paid for four times. This runs by default so a provider
// that starts scoping it fails the probe instead of the reviews.
{
  const { home, env } = await syntheticHome();
  const arm: ArmResult = {
    arm: "E/directory-scope",
    note: "mcp.status read from directories the server was not started in",
    envKeys: [],
    calls: [],
  };
  console.error(`\n=== ${arm.arm}: ${arm.note}`);
  const server = await launchOpenCodeServer({
    verifiedBinaryPath: opencodeBin,
    env: {
      ...env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        mcp: { [PROBE_SERVER]: codegraphMcpConfig },
      }),
    },
  });
  console.error(`  server ${server.url} (pid ${server.pid})`);
  console.error(`  server process cwd: ${process.cwd()}`);
  try {
    const client = createOpencodeClient({ baseUrl: server.url });
    // Three GENUINELY distinct directories plus the omitted case. `repoDir`
    // defaults to the process cwd, so listing it alongside `process.cwd()`
    // would have compared a value against itself and called the agreement
    // evidence — the shape of a test that cannot fail.
    for (const dir of [repoDir, home, "/tmp", undefined]) {
      arm.calls.push(
        await record(`mcp.status directory=${dir ?? "(omitted)"}`, () =>
          mcpOf(client).status(dir ? { query: { directory: dir } } : {}),
        ),
      );
    }
  } finally {
    await server.close();
  }
  const connected = arm.calls.map((c) =>
    JSON.stringify((c.value as { data?: unknown })?.data ?? c.error),
  );
  const agree = new Set(connected).size === 1;
  console.error(`  all readings agree: ${agree}`);
  for (const [i, c] of arm.calls.entries()) {
    console.error(`    ${c.label} => ${connected[i]}`);
  }
  if (!agree) {
    console.error(
      "  ⚠️  mcp.status IS directory-scoped on this build — the readback in " +
        "opencode-client.ts will abort PR-mode steps. See #141.",
    );
  }
  results.push(arm);
}

const outPath = path.join(outDir, "mcp-probe.json");
await Bun.write(
  outPath,
  `${JSON.stringify(
    { opencodeBin, codegraphBin, repoDir, probeServer: PROBE_SERVER, results },
    (_k, v) => (v === undefined ? null : v),
    2,
  )}\n`,
);

console.error("\n=== Summary");
for (const arm of results) {
  console.error(`${arm.arm}`);
  // `n/a` rather than 0: the directory-scope arm takes no tool readings at
  // all, and a zero would read as "the surface was empty" — a measurement it
  // never made.
  if (arm.toolIds === undefined) {
    console.error("  tool readings:       n/a (directory-scope arm)");
    continue;
  }
  console.error(`  tool.ids at launch:  ${arm.toolIds.length}`);
  console.error(
    `  NEW after delivery:  ${JSON.stringify(arm.newToolIds ?? [])}`,
  );
  console.error(`  tool.list ids:       ${(arm.toolListIds ?? []).length}`);
  const mcpish = (arm.toolListIds ?? []).filter(
    (id) => id.includes(PROBE_SERVER) || id.includes("codegraph"),
  );
  console.error(`  tool.list MCP-ish:   ${JSON.stringify(mcpish)}`);
}
console.error(`\nwrote ${outPath}`);
