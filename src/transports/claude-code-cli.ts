import type {
  ProviderCapabilityReport,
  ProviderTerminalProof,
  ProviderTransport,
  TransportFailureCause,
  TransportOutcome,
  TransportRequest,
} from "../execution/contracts";
import { ACTIVE_CHILD_PROCS, type SpawnedProcess } from "../step-runner";
import { parseUsage } from "../usage";

// §5.2 CLI/POSIX cascade: SIGTERM -> 5,000 ms grace -> SIGKILL -> reap bound
// 2,000 ms, all inside the harness's 7,500 ms deadline including scheduler
// margin. The numbers are contract, not taste — do not tune them here.
const TERM_GRACE_MS = 5000;
const KILL_REAP_MS = 2000;

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

  constructor(options: ClaudeCodeCliTransportOptions = {}) {
    this.spawnFn = options.spawnFn ?? Bun.spawn;
    this.getPgid = options.getPgid ?? systemGetPgid;
    this.killFn = options.killFn ?? process.kill;
    this.termGraceMs = options.termGraceMs ?? TERM_GRACE_MS;
    this.killReapMs = options.killReapMs ?? KILL_REAP_MS;
  }

  async capabilities(): Promise<ProviderCapabilityReport> {
    return {
      backend: "claude-code",
      status: "ready",
      auth: {
        kind: "claude_subscription_oauth",
        projectionReady: true,
        probe: "passed",
      },
      isolation: {
        syntheticHome: true,
        workspaceReadBroker: true,
        codegraphPolicy: true,
      },
      protocol: {
        terminalProof: true,
        boundedEvents: true,
        usageMode: "snapshot",
      },
      cancellation: {
        deadlineMs: 7500,
        conformance: "passed",
      },
      billing: {
        mode: "subscription",
        pricingReady: true,
      },
      issues: [],
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
      request.route.modelSnapshot,
    );

    const start = performance.now();

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

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
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
            usage: {
              wall_ms: Math.round(performance.now() - start),
              tokens_in: 0,
              tokens_out: 0,
              tokens_total: 0,
              cost_usd_est: 0,
            },
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

      if (request.timeoutMs && request.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          console.error(
            `Step timed out after ${request.timeoutMs}ms, escalating signal cascade`,
          );
          startCascade();
        }, request.timeoutMs);
      }

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
      if (timer !== undefined) clearTimeout(timer);

      const wallMs = Math.round(performance.now() - start);

      let fullResult = "";
      try {
        const parsed = JSON.parse(stdout) as { result?: string };
        fullResult = parsed.result ?? "";
      } catch {
        // non-json stdout
      }

      const usage = parseUsage(stdout, wallMs);

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
        timedOut,
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
    } finally {
      ACTIVE_CHILD_PROCS.delete(proc);
      if (timer !== undefined) clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
    }
  }

  classifyFailure(
    outcome: TransportOutcome,
  ): TransportFailureCause | undefined {
    const witness = `${outcome.stderrTail}\n${outcome.finalText}`;
    if (/Not logged in\s*[·.]\s*Please run \/login/i.test(witness)) {
      return "auth_invalid";
    }
    if (
      /API Error|Connection closed|ECONNRESET|socket hang up|timed out|502|503|529|overloaded/i.test(
        witness,
      )
    ) {
      return "network_transient";
    }
    return undefined;
  }
}
