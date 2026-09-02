import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { BucketScope } from "../execution/bucket-id";
import { deriveBucketId } from "../execution/bucket-id";
import type {
  ObservedModel,
  ProviderCapabilityReport,
  ProviderTerminalProof,
  ProviderTransport,
  TransportFailureCause,
  TransportOutcome,
  TransportRequest,
} from "../execution/contracts";
import type { NormalizedUsage } from "../execution/usage-normalized";
import {
  normalizePartialUsage,
  normalizeUnavailableUsage,
} from "../execution/usage-normalized";
import { spawnModelForClaudeCli } from "../model-routing";
import { CLAUDE_CAPABILITY_STATICS } from "../provider-capabilities";
import { ACTIVE_CHILD_PROCS, type SpawnedProcess } from "../step-runner";

// §9.2 non-secret provider label this transport's route always resolves to
// (the only route it drives is Anthropic-via-Claude-CLI). A per-request
// `route.provider` exists on TransportRequest but capabilities() is called
// before any specific request, so the identity string is this transport's
// own fixed provider — never inferred from a request that may not exist yet.
const BUCKET_IDENTITY_PROVIDER = "anthropic";

// D1-08 PR3 (§9.2): input a caller MAY supply once it has resolved a
// credential's projection and its bucketScope — none does yet (that wiring
// is PR5a's job). Omitting this argument keeps capabilities() byte-identical
// to pre-PR3 behavior: rateLimitBucketId stays undefined.
export interface ClaudeCliCapabilitiesInput {
  readonly credentialFingerprint: string;
  readonly bucketScope?: BucketScope;
  readonly localKey: Uint8Array;
}

// §5.2 CLI/POSIX cascade: SIGTERM -> 5,000 ms grace -> SIGKILL -> reap bound
// 2,000 ms, all inside the harness's 7,500 ms deadline including scheduler
// margin. The numbers are contract, not taste — do not tune them here.
const TERM_GRACE_MS = 5000;
const KILL_REAP_MS = 2000;

export interface PromptFileStatus {
  readonly mode: number;
  readonly isSymbolicLink: boolean;
}

function systemPromptStatus(promptPath: string): PromptFileStatus | undefined {
  try {
    const stats = lstatSync(promptPath);
    return { mode: stats.mode, isSymbolicLink: stats.isSymbolicLink() };
  } catch {
    return undefined;
  }
}

function hashPromptFile(promptPath: string): string {
  return createHash("sha256").update(readFileSync(promptPath)).digest("hex");
}

// A denial before spawn, or a PGID proof failure that refuses to signal a
// child we never trust, is genuine zero cost — no attempt reached the
// provider, so nothing was spent. This is deliberately NOT
// `normalizeUnavailableUsage`: "unavailable" means an attempt ran and its
// cost is unknown, which would misfile a $0 refusal as an unresolved spend
// once PR5's spend ledger reads completeness.
//
// #173, 2026-09-02: `costSource` was `"provider"` here, which was never true
// — no provider was contacted. It has to match the parse arms below for a
// second, mechanical reason: an unclassified failure legacy-classifies as
// "format" (step-runner.ts `classifyFailure`), which has a retry, so a denied
// attempt 1 can be summed with a spawned attempt 2 — and `sumNormalizedUsage`
// collapses `costSource` to "unknown" whenever two attempts disagree. Leaving
// this one behind would have erased the run's cost basis on exactly the retry
// path this transport already supports.
function noSpawnUsage(wallMs: number): NormalizedUsage {
  return {
    wallMs,
    tokens: {},
    completeness: "complete",
    billingMode: "subscription",
    costSource: "subscription",
    cashCostUsd: 0,
  };
}

interface RawClaudeCliResult {
  readonly total_cost_usd?: number;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_creation_input_tokens?: number;
    readonly cache_read_input_tokens?: number;
  };
  // #175 half 2. The CLI reports, per model it actually ran, an entry keyed
  // on the exact snapshot. Only the two identity fields are declared:
  // `canonicalModel` (the family) and the key itself.
  //
  // The real block also carries `costUSD`, `costBasis` and token counts. They
  // are deliberately NOT read here. Cost already has ONE parse site
  // (`normalizeClaudeCliUsage`, from `total_cost_usd`) and one filing
  // decision; a second reader of a second cost field is exactly how two
  // numbers for one attempt start disagreeing.
  //
  // #173 closed the `costBasis: "list"` problem this comment used to defer,
  // and closed it WITHOUT reading the field. `costBasis` is in the response,
  // but the FILING decision follows the credential's billing mode rather than
  // the response's label: `normalizeClaudeCliUsage` files `total_cost_usd` as
  // notional on the strength of the route being a subscription, which is true
  // whatever any per-model entry says. Parsing `costBasis` per model would add
  // the second cost reader this paragraph exists to refuse. What is still unread and still
  // wanted is the per-model SPLIT (#173 records it): one `--model sonnet`
  // invocation ran two models, so a single route-level cost is an incomplete
  // provenance claim in the same way a single `modelSnapshot` is.
  readonly modelUsage?: Readonly<
    Record<string, { readonly canonicalModel?: unknown } | null | undefined>
  >;
}

// #175 half 2: which models the provider says it ran, in the order it
// reported them.
//
// Absence over fabrication, three ways: unparseable stdout, no `modelUsage`
// key, and an EMPTY `modelUsage` all answer `undefined`. An empty array would
// assert "we looked and nothing ran", which is a claim about the provider we
// have no basis for — the same distinction `normalizeUnavailableUsage` draws
// between an unknown cost and a zero one.
//
// Parsed separately from `normalizeClaudeCliUsage` rather than folded into
// it: that function's contract is the §8 numeric shape, and its every branch
// is about not fabricating a token count. Identity is a different fact with
// different failure modes, so it gets its own parse and its own honest
// absence.
function observedModelsFromCliResult(
  rawStdout: string,
): readonly ObservedModel[] | undefined {
  let parsed: RawClaudeCliResult;
  try {
    parsed = JSON.parse(rawStdout);
  } catch {
    return undefined;
  }
  const raw = parsed.modelUsage;
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return undefined;
  }
  const observed: ObservedModel[] = [];
  for (const [model, entry] of Object.entries(raw)) {
    if (model.trim().length === 0) continue;
    // A non-string canonicalModel is dropped rather than coerced: the field
    // is a model IDENTITY, and `String(someObject)` would put "[object
    // Object]" into a provenance record that reads as a model name.
    const canonicalModel =
      entry !== null &&
      typeof entry === "object" &&
      typeof entry.canonicalModel === "string" &&
      entry.canonicalModel.trim().length > 0
        ? entry.canonicalModel
        : undefined;
    observed.push({
      model,
      ...(canonicalModel === undefined ? {} : { canonicalModel }),
    });
  }
  return observed.length === 0 ? undefined : observed;
}

// #173 (§8, docs/multi-runtime-model-diversity-design.md:462): "Subscription
// OAuth may truthfully report `cashCostUsd: 0`; optional catalog cost is
// `notionalCostUsd` and never mixed with cash." This is the one site that
// applies that rule for this transport, and it is applied STATICALLY rather
// than branched on `billingMode`, because this transport's route can only be a
// subscription: `credentialKindForRoute` (runner-authority.ts) returns
// `claude_subscription_oauth` for the claude-code backend unconditionally, so
// a metered branch here would be unreachable code with no way to test it
// honestly. When #161 makes a metered claude-code route real, THIS is the site
// that has to grow the branch — and `billingMode` above it is the field that
// decides which way it goes.
//
// The figure itself is list-basis, verified live 2026-09-02 rather than
// inferred: the CLI's `modelUsage` block labels each model's `costUSD` with
// `"costBasis": "list"`, and `total_cost_usd` is their sum. On a subscription
// nothing is charged, so filing it as cash recorded spend that never happened.
//
// Note the two fields answer to different things. `notionalCostUsd` follows
// the provider: absent when the CLI reported no total, because inventing 0
// there would claim the attempt consumed nothing. `cashCostUsd` follows the
// CREDENTIAL: it is 0 because the subscription charges nothing, whatever the
// CLI said, so it is unconditional.
//
// §8: `--output-format json`'s usage block is already disjoint-additive —
// input_tokens (uncached), cache_read_input_tokens, and
// cache_creation_input_tokens sum to total input (verified against the real
// CLI); this is NOT OpenAI's "total that includes a subset" shape, so the
// leaves are read straight across rather than split from a total via
// `normalizeInclusiveUsage`. Corrupted stdout, and valid JSON carrying no
// `usage` block at all (a safety-blocked or otherwise usage-less response),
// both yield `normalizeUnavailableUsage` — never a fabricated zero leaf, the
// exact "$0 on parse failure" collapse this slice exists to kill.
function normalizeClaudeCliUsage(
  rawStdout: string,
  wallMs: number,
): NormalizedUsage {
  let parsed: RawClaudeCliResult;
  try {
    parsed = JSON.parse(rawStdout);
  } catch {
    return normalizeUnavailableUsage({ wallMs });
  }
  const raw = parsed.usage;
  if (raw === undefined) {
    return normalizeUnavailableUsage({ wallMs });
  }
  const leafValues = [
    raw.input_tokens,
    raw.cache_read_input_tokens,
    raw.cache_creation_input_tokens,
    raw.output_tokens,
  ];
  const allLeavesDefined = leafValues.every((v) => typeof v === "number");
  if (!allLeavesDefined) {
    const providerReportedTotal = leafValues.reduce<number>(
      (sum, v) => sum + (typeof v === "number" ? v : 0),
      0,
    );
    return normalizePartialUsage({
      wallMs,
      providerReportedTotal,
      billingMode: "subscription",
      costSource: "subscription",
      cashCostUsd: 0,
      notionalCostUsd: parsed.total_cost_usd,
    });
  }
  const inputUncached = leafValues[0] as number;
  const inputCacheRead = leafValues[1] as number;
  const inputCacheWrite = leafValues[2] as number;
  const outputVisible = leafValues[3] as number;
  const inputKnown = inputUncached + inputCacheRead + inputCacheWrite;
  return {
    wallMs,
    tokens: {
      inputUncached,
      inputCacheRead,
      inputCacheWrite,
      outputVisible,
      inputKnown,
      outputKnown: outputVisible,
      totalKnown: inputKnown + outputVisible,
      providerReportedTotal: inputKnown + outputVisible,
    },
    completeness: "complete",
    billingMode: "subscription",
    costSource: "subscription",
    cashCostUsd: 0,
    // A genuinely absent `total_cost_usd` stays absent rather than becoming a
    // fabricated $0 — `projectLegacyUsage` already falls back to 0 for the
    // legacy `cost_usd_est` reader, so nothing downstream loses precision.
    notionalCostUsd: parsed.total_cost_usd,
  };
}

type CliProc = SpawnedProcess & { readonly pid: number };

type CascadeResult =
  | { kind: "term" }
  | { kind: "kill" }
  | { kind: "kill_unreaped" }
  | { kind: "signal_failed"; error: unknown };

export interface ClaudeCodeCliTransportOptions {
  readonly spawnFn?: typeof Bun.spawn;
  readonly getPgid?: (pid: number) => number | undefined;
  readonly killFn?: (pid: number, signal?: string | number) => unknown;
  readonly termGraceMs?: number;
  readonly killReapMs?: number;
  // §6.3 pre-spawn prompt verification surface; injectable for offline tests,
  // production defaults lstat + sha256 over the real file.
  readonly promptLstatFn?: (path: string) => PromptFileStatus | undefined;
  readonly promptHashFn?: (path: string) => string | Promise<string>;
}

// Bun does not (yet) expose process.getpgid; when a future runtime grows one we
// use it, otherwise the pgid comes from `ps -o pgid= -p <pid>` on this POSIX host.
const runtimeWithGetpgid = process as typeof process & {
  getpgid?: (pid: number) => number;
};

function systemGetPgid(pid: number): number | undefined {
  if (typeof runtimeWithGetpgid.getpgid === "function") {
    try {
      return runtimeWithGetpgid.getpgid(pid);
    } catch {
      return undefined;
    }
  }
  const probe = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)]);
  if (probe.exitCode !== 0) return undefined;
  const raw = probe.stdout.toString().trim();
  if (raw.length === 0) return undefined;
  const pgid = Number(raw);
  return Number.isInteger(pgid) ? pgid : undefined;
}

// Resolves true when `p` settled first, false once `ms` elapsed first.
function raceExitFirst(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(false), ms);
    p.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

async function boundedText(
  pending: Promise<string>,
  ms: number,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  const value = await Promise.race([pending, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return value;
}

export class ClaudeCodeCliTransport implements ProviderTransport {
  readonly backend = "claude-code";
  private readonly spawnFn: typeof Bun.spawn;
  private readonly getPgid: (pid: number) => number | undefined;
  private readonly killFn: (pid: number, signal?: string | number) => unknown;
  private readonly termGraceMs: number;
  private readonly killReapMs: number;
  private readonly promptLstatFn: (
    path: string,
  ) => PromptFileStatus | undefined;
  private readonly promptHashFn: (path: string) => string | Promise<string>;

  constructor(options: ClaudeCodeCliTransportOptions = {}) {
    this.spawnFn = options.spawnFn ?? Bun.spawn;
    this.getPgid = options.getPgid ?? systemGetPgid;
    this.killFn = options.killFn ?? process.kill;
    this.termGraceMs = options.termGraceMs ?? TERM_GRACE_MS;
    this.killReapMs = options.killReapMs ?? KILL_REAP_MS;
    this.promptLstatFn = options.promptLstatFn ?? systemPromptStatus;
    this.promptHashFn = options.promptHashFn ?? hashPromptFile;
  }

  // §6.3: system prompts are 0600, non-symlink files whose hashes are checked
  // immediately before spawn. Returns the denial reason, or undefined when
  // verification holds.
  private async verifyPromptIntegrity(
    request: TransportRequest,
  ): Promise<string | undefined> {
    const status = await this.promptLstatFn(request.systemPromptPath);
    if (status === undefined) {
      return `system prompt unreadable: ${request.systemPromptPath}`;
    }
    if (status.isSymbolicLink) {
      return `system prompt is a symlink: ${request.systemPromptPath}`;
    }
    // Raw lstat mode carries file-type bits; only the permission bits must be
    // exactly 0600.
    if ((status.mode & 0o777) !== 0o600) {
      return `system prompt mode is ${(status.mode & 0o777).toString(8)}, expected 600`;
    }
    const actualSha256 = await this.promptHashFn(request.systemPromptPath);
    if (actualSha256 !== request.systemPromptSha256) {
      return "system prompt hash mismatch against request.systemPromptSha256";
    }
    return undefined;
  }

  // §11/D1-09: static report built from the SAME constants the report
  // producer reads (CLAUDE_CAPABILITY_STATICS), so transport and producer can
  // never contradict each other. projectionReady/syntheticHome are
  // contractual here, not probed: every execute() request must carry an
  // IsolationProjection (credentialProjectionId + syntheticHome) or admission
  // denies it. Unproven features are claimed false with a
  // non-blocking issue, never assumed green: no bounded event sink is wired
  // yet, no dedicated codegraph policy is enforced, and no pricing table
  // exists — hence status "degraded", not "ready".
  async capabilities(
    input?: ClaudeCliCapabilitiesInput,
  ): Promise<ProviderCapabilityReport> {
    return {
      backend: "claude-code",
      status: "degraded",
      auth: {
        kind: CLAUDE_CAPABILITY_STATICS.authKind,
        projectionReady: true,
        probe: "not_run",
      },
      isolation: {
        syntheticHome: true,
        workspaceReadBroker: CLAUDE_CAPABILITY_STATICS.workspaceReadBroker,
        codegraphPolicy: false,
      },
      protocol: {
        terminalProof: CLAUDE_CAPABILITY_STATICS.terminalProof,
        boundedEvents: false,
        usageMode: CLAUDE_CAPABILITY_STATICS.usageMode,
      },
      cancellation: {
        deadlineMs: CLAUDE_CAPABILITY_STATICS.cancellationDeadlineMs,
        conformance: CLAUDE_CAPABILITY_STATICS.cancellationConformance,
      },
      billing: {
        mode: CLAUDE_CAPABILITY_STATICS.billingMode,
        // D1-08 PR3 does not touch pricing readiness: a per-model pricing
        // table is explicitly out of scope for the whole D1-08 change (the
        // proposal's Out of Scope list) and unrelated to bucketScope — a
        // bucket ID says WHICH rate-limit pool a credential shares, not
        // whether its cost can be priced. Still `false`, tracked by the
        // pre-existing "pricing_table_missing" issue below.
        //
        // #137 shipped that table and still leaves this `false`: no model id
        // is in scope here. capabilities() takes only a credential
        // fingerprint and bucket scope, it is called before any specific
        // request (see the BUCKET_IDENTITY_PROVIDER note above), and the
        // registry's claude-code factory forwards only `spawnFn` — the
        // transport never receives `options.route`. Honest default.
        //
        // 2026-09-02: NOT the case the OpenCode transport's `true` covers.
        // That claim is PROVIDER COST — the OpenCode SDK reports a
        // non-optional `cost` on every assistant message, which needs no
        // model id and no table. The Claude CLI reports no per-request cash
        // cost, so the rate table really is this transport's only pricing
        // path and this stays `false`.
        pricingReady: false,
      },
      ...(input !== undefined
        ? {
            rateLimitBucketId: deriveBucketId(
              {
                provider: BUCKET_IDENTITY_PROVIDER,
                credentialFingerprint: input.credentialFingerprint,
                scope: input.bucketScope,
              },
              input.localKey,
            ),
          }
        : {}),
      issues: [
        {
          code: "codegraph_policy_unenforced",
          message:
            "no dedicated codegraph sensitive-file policy is enforced yet; isolation relies on --strict-mcp-config with a codegraph-only mcp.json",
          blocking: false,
        },
        {
          code: "bounded_events_sink_missing",
          message:
            "bounded event streaming is not wired: the event sink is currently a no-op and usage arrives as a final snapshot",
          blocking: false,
        },
        {
          code: "pricing_table_missing",
          message:
            "a versioned Anthropic pricing table is bundled, but capabilities() carries no route, so this transport cannot name the model to price; the runtime binding prices per route",
          blocking: false,
        },
      ],
    };
  }

  private runCascade(
    proc: CliProc,
    pgid: number | undefined,
  ): Promise<CascadeResult> {
    const deliver = (signal: string): boolean => {
      let delivered = false;
      if (pgid !== undefined) {
        // Negative-pgid signaling reaches every descendant the CLI spawned; a
        // bare proc.kill() would orphan its subprocesses. Only reachable once
        // the dedicated-PGID proof held.
        try {
          this.killFn(-pgid, signal);
          delivered = true;
        } catch {
          void signal;
        }
      }
      // Direct line to the leader itself: redundant for a live child (it is in
      // the group) but it unblocks offline doubles whose kill() settles their
      // streams, and it is the only delivery possible when no kernel pid
      // exists to prove a group for.
      try {
        proc.kill();
        delivered = true;
      } catch {
        void signal;
      }
      return delivered;
    };

    return (async (): Promise<CascadeResult> => {
      // §5.2: SIGTERM to -pgid, then a 5,000 ms grace window before escalation.
      if (!deliver("SIGTERM")) {
        return { kind: "signal_failed", error: new Error("SIGTERM failed") };
      }
      const exitedDuringGrace = await raceExitFirst(
        proc.exited,
        this.termGraceMs,
      );
      if (exitedDuringGrace) return { kind: "term" };
      if (!deliver("SIGKILL")) {
        return { kind: "signal_failed", error: new Error("SIGKILL failed") };
      }
      const reaped = await raceExitFirst(proc.exited, this.killReapMs);
      return reaped ? { kind: "kill" } : { kind: "kill_unreaped" };
    })();
  }

  async execute(
    request: TransportRequest,
    context: {
      readonly signal: AbortSignal;
      readonly events?: import("../execution/contracts").AsyncEventSink;
    },
  ): Promise<TransportOutcome> {
    const args = [
      request.isolation.verifiedBinaryPath,
      "-p",
      request.userPrompt,
      "--append-system-prompt-file",
      request.systemPromptPath,
      "--output-format",
      "json",
    ];

    if (request.mcpConfigPath) {
      args.push("--mcp-config", request.mcpConfigPath, "--strict-mcp-config");
    }

    args.push(
      "--setting-sources",
      "",
      "--tools",
      request.tools.join(","),
      "--permission-mode",
      "bypassPermissions",
      "--model",
      spawnModelForClaudeCli(request.route, request.executionModel),
    );

    const start = performance.now();

    // §6.3: hash/mode/symlink verification happens immediately before spawn;
    // a failed check never reaches the provider.
    const promptDenial = await this.verifyPromptIntegrity(request);
    if (promptDenial !== undefined) {
      return {
        completion: "failed",
        protocolIntegrity: "unverified",
        finalText: "",
        usage: noSpawnUsage(Math.round(performance.now() - start)),
        stderrTail: `[pr-hero] prompt integrity denied: ${promptDenial}; no spawn`,
      };
    }

    // detached: Bun maps this to setsid() on POSIX, so the child starts a new
    // session and leads its own process group — the precondition for §5.2's
    // negative-PGID cascade to be safe at all.
    const proc = this.spawnFn(args, {
      cwd: request.cwd,
      env: request.isolation.env,
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    }) as unknown as CliProc;

    ACTIVE_CHILD_PROCS.add(proc);

    let cascadePromise: Promise<CascadeResult> | undefined;
    let provenPgid: number | undefined;
    let notifyCascadeStart: (value: "cascade") => void = () => {};
    const cascadeStarted = new Promise<"cascade">((resolve) => {
      notifyCascadeStart = resolve;
    });
    const startCascade = () => {
      // Only reachable past the PGID proof below: negative-pgid signaling is
      // armed exclusively after the child was proven to lead its own group
      // (or is an offline double with no group to signal at all).
      if (cascadePromise) return;
      cascadePromise = this.runCascade(proc, provenPgid);
      notifyCascadeStart("cascade");
    };
    const onAbort = () => {
      startCascade();
    };

    try {
      // §5.2: proof that pid == pgid must hold BEFORE any negative-PGID signal
      // path is armed. Failure means we never signal — a wrong guess could kill
      // the host's own group instead of the child's. A child without a kernel
      // pid is an offline test double: no group exists to prove or signal.
      const rawPid = (proc as { pid?: unknown }).pid;
      const kernelPid =
        typeof rawPid === "number" && Number.isInteger(rawPid) && rawPid > 1
          ? rawPid
          : undefined;
      let provenGroup: number | undefined;
      if (kernelPid !== undefined) {
        const pgid = this.getPgid(kernelPid);
        if (pgid === undefined || pgid !== kernelPid) {
          return {
            completion: "failed",
            protocolIntegrity: "unverified",
            finalText: "",
            usage: noSpawnUsage(Math.round(performance.now() - start)),
            stderrTail:
              pgid === undefined
                ? `[pr-hero] PGID proof failed: could not read pgid for pid ${kernelPid}; no signal sent`
                : `[pr-hero] PGID proof failed: pid ${kernelPid} has pgid ${pgid}, expected ${kernelPid}; no signal sent`,
          };
        }
        provenGroup = pgid;
      }

      provenPgid = provenGroup;

      const stdoutPending = new Response(proc.stdout).text();
      const stderrPending = new Response(proc.stderr).text();

      // Per-attempt step timeout is harness-owned (StepSpec.timeoutMs → watchdog
      // → AbortSignal). Transports react only to the supplied signal.

      if (context.signal.aborted) {
        onAbort();
      } else {
        context.signal.addEventListener("abort", onAbort, { once: true });
      }

      let exitCode: number | undefined;
      let stdout: string;
      let stderr: string;
      let unreaped = false;
      let escalatedToKill = false;

      const natural = Promise.all([stdoutPending, stderrPending, proc.exited]);

      // The ladder can be armed by the timeout while we are mid-await on the
      // natural path; race it so an unkillable group cannot hang us forever.
      const route = await Promise.race([
        natural.then((): "natural" => "natural"),
        cascadeStarted,
      ]);

      if (route === "natural") {
        [stdout, stderr, exitCode] = await natural;
        if (cascadePromise !== undefined) {
          const late = await cascadePromise;
          escalatedToKill =
            late.kind === "kill" || late.kind === "kill_unreaped";
        }
      } else {
        if (cascadePromise === undefined) {
          throw new Error("cascade route taken without an armed cascade");
        }
        const cascade = await cascadePromise;
        escalatedToKill =
          cascade.kind === "kill" || cascade.kind === "kill_unreaped";
        if (
          cascade.kind === "term" ||
          cascade.kind === "kill" ||
          cascade.kind === "signal_failed"
        ) {
          [stdout, stderr, exitCode] = await natural;
        } else {
          // The group survived SIGKILL past the 2,000 ms reap bound: stop
          // waiting, take whatever output landed, and record it rather than
          // hang the harness past its 7,500 ms deadline.
          unreaped = true;
          stdout = (await boundedText(stdoutPending, this.killReapMs)) ?? "";
          stderr = (await boundedText(stderrPending, this.killReapMs)) ?? "";
        }
      }

      const wallMs = Math.round(performance.now() - start);

      let fullResult = "";
      try {
        const parsed = JSON.parse(stdout) as { result?: string };
        fullResult = parsed.result ?? "";
      } catch {
        // non-json stdout
      }

      const usage = normalizeClaudeCliUsage(stdout, wallMs);
      const observedModels = observedModelsFromCliResult(stdout);

      let stderrTail = stderr.slice(-4096);
      if (unreaped) {
        stderrTail =
          `${stderrTail}\n[pr-hero] child process group -${provenPgid ?? "(unproven)"} was not reaped within ${this.killReapMs}ms after SIGKILL`.slice(
            -4096,
          );
      }

      const terminalProof: ProviderTerminalProof | undefined =
        exitCode === undefined
          ? undefined
          : {
              eventId: `${request.sessionId}-${request.attempt}-terminal`,
              providerStatus: exitCode === 0 ? "completed" : "failed",
              providerObservedAt: new Date().toISOString(),
              exitCode,
              ...(escalatedToKill ? { signal: "SIGKILL" } : {}),
            };

      const isCancelled = context.signal.aborted;
      const completion: TransportOutcome["completion"] = isCancelled
        ? "cancelled"
        : exitCode === 0 && fullResult && terminalProof !== undefined
          ? "success"
          : "failed";

      if (terminalProof === undefined && !isCancelled) {
        stderrTail =
          `${stderrTail}\n[pr-hero] no terminal proof observed; refusing success`.slice(
            -4096,
          );
      }

      return {
        completion,
        protocolIntegrity:
          unreaped || terminalProof === undefined
            ? "unverified"
            : stdout
              ? "verified"
              : "unverified",
        ...(terminalProof !== undefined ? { terminalProof } : {}),
        finalText: fullResult,
        usage,
        stderrTail,
        ...(observedModels === undefined ? {} : { observedModels }),
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
    } finally {
      ACTIVE_CHILD_PROCS.delete(proc);
      context.signal.removeEventListener("abort", onAbort);
    }
  }

  classifyFailure(
    outcome: TransportOutcome,
  ): TransportFailureCause | undefined {
    const witness = `${outcome.stderrTail}\n${outcome.finalText}`;
    // The child's stderr, with no model output mixed in — see the two-witness
    // note on the backpressure branch below.
    const diagnostics = outcome.stderrTail;
    if (/Not logged in\s*[·.]\s*Please run \/login/i.test(witness)) {
      return "auth_invalid";
    }
    // Backpressure is tested BEFORE the generic network witness, and the
    // order is load-bearing: the real CLI string for an overload is
    // "API Error: 529 overloaded_error", which matches both. Tested second,
    // rate_limit would never fire for the exact witness it exists to catch.
    //
    // §7 gives these two causes different dispositions on purpose —
    // rate_limit waits (validated Retry-After or capped exponential),
    // network_transient retries immediately. Retrying instantly against a
    // server that just said it is saturated deepens the saturation and burns
    // the entire transient budget in milliseconds.
    //
    // Backpressure is read from TWO witnesses, because the two channels do
    // not carry the same kind of text. `finalText` is
    // `JSON.parse(stdout).result` — mixed: the CLI's own error text AND the
    // model's final message. pr-hero's model output is code-review prose
    // about exactly these failure modes ("this endpoint has no rate limit",
    // "consider returning 429"), so an English phrase or a bare status code
    // read from there matches the tool's own subject matter and routes a
    // healthy failure into a backoff it never earned. `stderrTail` is the
    // child's diagnostics channel and carries no model prose at all.
    //
    // So: provider error TYPES are machine tokens no reviewer writes in a
    // sentence, and are trusted from either channel — this is what keeps the
    // real witness "API Error: 529 overloaded_error" classified even when the
    // CLI surfaces it through `result`.
    if (/rate_limit_error|overloaded_error/i.test(witness)) {
      return "rate_limit";
    }
    // Everything prose-shaped — bare phrases and bare status codes — is read
    // from diagnostics ONLY. Word boundaries keep a token count like 15291 or
    // a job id like 1429 from being read as a status.
    if (
      /\b429\b|\b529\b|\b503\b|overloaded|rate[ _-]?limit|too many requests|service unavailable/i.test(
        diagnostics,
      )
    ) {
      return "rate_limit";
    }
    // Connection-level only. Nothing upstream asked us to slow down, and
    // waiting out a reset socket buys nothing. 502 stays here: a bad gateway
    // is a proxy failure, not a capacity signal.
    if (
      /API Error|Connection closed|ECONNRESET|socket hang up|timed out|\b502\b/i.test(
        witness,
      )
    ) {
      return "network_transient";
    }
    return undefined;
  }
}
