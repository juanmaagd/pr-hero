// #182: live free-model discovery. OpenCode free models (backend `opencode`,
// provider `opencode`, e.g. `muse-spark-1.3-contributor-free`) authenticate
// with NOTHING, but without a liveness check they are refused at credential
// projection — there is no kind for "no credential".
//
// NO hardcoded model lists here or in any JSON: free-model identities rotate
// constantly, so discovery is LIVE — `<binaryPath> models <provider>
// --verbose --refresh`, parsed at runtime. The discriminator is what the
// provider itself declares: exact model id present AND status active AND
// input===0 AND output===0 AND cache.read===0 AND cache.write===0.
//
// WHY `--refresh`: the repo's pricing doctrine (src/pricing-catalog.ts:4-31)
// says a stale price is a confident wrong number. A cached all-zero cost
// that has since become metered would admit a paid run as free; offline
// failure must refuse loudly downstream (fail closed → provider_api_token),
// not silently pass.
//
// SCOPE NOTE (residual risk, NOT post-hoc guarded in this slice): between the
// probe and the attempt the provider could flip a model from free to metered
// (stale-cache window). The attempt would then run under an empty projection
// and fail at the provider (loud) rather than silently bill — but there is no
// post-hoc settlement guard proving the $0. Filed as follow-up; see final
// report.

export type FreeModelProbe = (
  provider: string,
  model: string,
) => Promise<boolean>;

export interface FreeModelDiscoveryRunResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface IsFreeModelInput {
  readonly binaryPath: string;
  readonly provider: string;
  readonly model: string;
  // Injectable for offline tests (repo doctrine: `bun test` is fully offline
  // with fake spawn). Production defaults to Bun.spawn. Never throws — any
  // failure returns false through the predicate below.
  readonly run?: (
    argv: readonly string[],
  ) => Promise<FreeModelDiscoveryRunResult>;
}

async function defaultRun(
  argv: readonly string[],
): Promise<FreeModelDiscoveryRunResult> {
  const proc = Bun.spawn([...argv], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  }) as unknown as {
    readonly stdout: unknown;
    readonly exited: Promise<number>;
  };
  const stdout = await new Response(proc.stdout as never).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
}

function isHeaderLine(line: string): boolean {
  if (line.length === 0) return false;
  const first = line[0];
  if (first === " " || first === "\t") return false;
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (
    trimmed.startsWith("{") ||
    trimmed.startsWith("}") ||
    trimmed.startsWith('"') ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("]")
  ) {
    return false;
  }
  return trimmed.includes("/");
}

// The header is `<provider>/<id>`: split on the FIRST "/" so a model id that
// itself contains "/" still matches exactly (remainder may contain "/").
function headerMatches(
  header: string,
  provider: string,
  model: string,
): boolean {
  const slash = header.indexOf("/");
  if (slash <= 0 || slash === header.length - 1) return false;
  return (
    header.slice(0, slash) === provider && header.slice(slash + 1) === model
  );
}

function parseCostBlock(
  stdout: string,
  provider: string,
  model: string,
): unknown {
  const lines = stdout.split("\n");
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!isHeaderLine(line)) continue;
    if (headerMatches(line.trim(), provider, model)) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) return undefined;
  const blockLines: string[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (isHeaderLine(line)) break;
    blockLines.push(line);
  }
  const block = blockLines.join("\n").trim();
  if (block.length === 0) return undefined;
  try {
    return JSON.parse(block);
  } catch {
    return undefined;
  }
}

// Strict predicate: exact `provider/model` header, JSON parses,
// status === "active", all four cost leaves strictly === 0. ANY failure,
// ambiguity, missing field, non-zero leaf, or spawn error returns FALSE
// (fail closed, never throws).
export async function isFreeModel(input: IsFreeModelInput): Promise<boolean> {
  try {
    if (
      input.binaryPath.length === 0 ||
      !input.binaryPath.startsWith("/") ||
      input.provider.length === 0 ||
      input.model.length === 0
    ) {
      return false;
    }
    const run = input.run ?? defaultRun;
    let result: FreeModelDiscoveryRunResult;
    try {
      result = await run([
        input.binaryPath,
        "models",
        input.provider,
        "--verbose",
        "--refresh",
      ]);
    } catch {
      return false;
    }
    if (result.exitCode !== 0) return false;
    const parsed = parseCostBlock(result.stdout, input.provider, input.model);
    if (typeof parsed !== "object" || parsed === null) return false;
    const record = parsed as Record<string, unknown>;
    if (record.status !== "active") return false;
    const cost = record.cost;
    if (typeof cost !== "object" || cost === null) return false;
    const costRecord = cost as Record<string, unknown>;
    if (costRecord.input !== 0 || costRecord.output !== 0) return false;
    const cache = costRecord.cache;
    if (typeof cache !== "object" || cache === null) return false;
    const cacheRecord = cache as Record<string, unknown>;
    if (cacheRecord.read !== 0 || cacheRecord.write !== 0) return false;
    return true;
  } catch {
    return false;
  }
}

// One probe instance per admission: memoised per (provider, model) so the
// plan-level server credential and the per-binding upgrades share ONE verdict
// (the #149 anti-drift rule — two spawns could disagree across a provider
// flip, and the server would then hold a different truth than the binding).
export function createFreeModelProbe(options: {
  readonly binaryPath: string;
  readonly run?: IsFreeModelInput["run"];
}): FreeModelProbe {
  const cache = new Map<string, Promise<boolean>>();
  return (provider: string, model: string) => {
    const key = `${provider}/${model}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const verdict = isFreeModel({
      binaryPath: options.binaryPath,
      provider,
      model,
      ...(options.run === undefined ? {} : { run: options.run }),
    });
    cache.set(key, verdict);
    return verdict;
  };
}
