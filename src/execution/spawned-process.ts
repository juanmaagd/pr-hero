// The registry of live child processes a transport has spawned, and the
// emergency kill-switch over it (cli.ts's shutdown path calls
// killAllChildProcesses so a Ctrl-C never leaves an orphaned `claude` CLI
// process running).
//
// Split out of review/step-runner.ts (architecture guard C2):
// transports/claude-code-cli.ts is the spawner and needs this registry, but
// review/step-runner.ts itself depends on execution/harness.ts (via
// StepExecutionHarness), which depends on transport-registry.ts, which
// depends on transports/claude-code-cli.ts — so claude-code-cli.ts importing
// this registry FROM step-runner.ts closed a value-import cycle back through
// harness.ts. This file has no imports of its own — a true leaf every side
// can depend on one-way.

export interface SpawnedProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export const ACTIVE_CHILD_PROCS = new Set<SpawnedProcess>();

export function killAllChildProcesses(): void {
  for (const proc of ACTIVE_CHILD_PROCS) {
    try {
      proc.kill();
    } catch {
      // Swallowed — process may have already exited
    }
  }
  ACTIVE_CHILD_PROCS.clear();
}
