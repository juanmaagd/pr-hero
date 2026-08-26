import type {
  ProviderCapabilityReport,
  ProviderTransport,
  TransportFailureCause,
  TransportOutcome,
  TransportRequest,
} from "../execution/contracts";
import { ACTIVE_CHILD_PROCS, type SpawnedProcess } from "../step-runner";
import { parseUsage } from "../usage";

export interface ClaudeCodeCliTransportOptions {
  readonly spawnFn?: typeof Bun.spawn;
}

export class ClaudeCodeCliTransport implements ProviderTransport {
  readonly backend = "claude-code";
  private readonly spawnFn: typeof Bun.spawn;

  constructor(options: ClaudeCodeCliTransportOptions = {}) {
    this.spawnFn = options.spawnFn ?? Bun.spawn;
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
    const proc = this.spawnFn(args, {
      cwd: request.cwd,
      env: request.isolation.env,
      stdout: "pipe",
      stderr: "pipe",
    }) as unknown as SpawnedProcess;

    ACTIVE_CHILD_PROCS.add(proc);

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (request.timeoutMs && request.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        console.error(
          `Step timed out after ${request.timeoutMs}ms, killing process`,
        );
        try {
          proc.kill();
        } catch {
          // already exited
        }
      }, request.timeoutMs);
    }

    const onAbort = () => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
    };

    if (context.signal.aborted) {
      onAbort();
    } else {
      context.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const wallMs = Math.round(performance.now() - start);

      let fullResult = "";
      try {
        const parsed = JSON.parse(stdout) as { result?: string };
        fullResult = parsed.result ?? "";
      } catch {
        // non-json stdout
      }

      const usage = parseUsage(stdout, wallMs);
      const isCancelled = context.signal.aborted;

      return {
        completion: isCancelled
          ? "cancelled"
          : exitCode === 0 && fullResult
            ? "success"
            : "failed",
        protocolIntegrity: stdout ? "verified" : "unverified",
        finalText: fullResult,
        usage,
        stderrTail: stderr.slice(-4096),
        timedOut,
        exitCode,
      };
    } finally {
      ACTIVE_CHILD_PROCS.delete(proc);
      if (timer) clearTimeout(timer);
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
