// §5.1 typed settlement: every session resolves a SettlementReceipt whose
// termination/resource/remote status, timestamps, warnings and closed
// late-write fence are assembled here — pure and offline-testable, with the
// clock injected so no test ever sleeps to produce a timestamp.
import type { RunnerBackend } from "../provider-capabilities";
import type { ProviderTerminalProof } from "./contracts";

// §5.1 shapes verbatim.
export interface WriteLease {
  readonly id: string;
  readonly valid: boolean;
  invalidate(reason: string): void;
}

export type SettlementOutcome =
  | "completed"
  | "failed"
  | "cancelled_confirmed"
  | "local_fenced_remote_unconfirmed"
  | "local_termination_unconfirmed";

export interface SettlementReceipt {
  readonly sessionId: string;
  readonly attempt: number;
  readonly outcome: SettlementOutcome;
  readonly termination: {
    readonly requested: boolean;
    readonly confirmation:
      | "not_required"
      | "process_group_exited"
      | "sdk_abort_confirmed"
      | "unconfirmed";
    readonly signalCascade?: readonly ("SIGTERM" | "SIGKILL")[];
  };
  readonly resources: {
    readonly localReleased: boolean;
    readonly processGroupAlive: boolean | "unknown" | "not_applicable";
    readonly remoteStatus:
      | "completed"
      | "cancelled"
      | "failed"
      | "unknown_may_continue";
  };
  readonly timestamps: {
    readonly startedAt: string;
    readonly abortRequestedAt?: string;
    readonly leaseInvalidatedAt?: string;
    readonly terminationConfirmedAt?: string;
    readonly settledAt: string;
  };
  readonly lateWriteFence: {
    readonly leaseId: string;
    readonly closed: true;
    readonly rejectedEvents: number;
  };
  readonly warnings: readonly string[];
}

export interface ActiveSession {
  readonly id: string;
  readonly attempt: number;
  readonly controller: AbortController;
  readonly transport: RunnerBackend;
  readonly writeLease: WriteLease;
  readonly cancellationDeadlineMs: number;
  readonly settled: Promise<SettlementReceipt>;
}

export type TerminalOrigin = "provider" | "transport" | "harness";
export type TerminalStatus = "completed" | "failed" | "cancelled";

export const DEFAULT_CANCELLATION_DEADLINE_MS = 7500;

// §5.3 step 4: fixed harness margin over each declared deadline. Injectable in
// the harness so offline tests can exercise grace expiry without sleeping a
// real second; production always uses this value.
export const HARNESS_GRACE_MARGIN_MS = 1000;

const QUARANTINE_WARNING =
  // §5.3 step 6: quarantine the transport/rate-limit bucket on synthesis.
  "no transport terminal arrived before the settlement grace expired; transport/rate-limit bucket quarantined and remote job may continue";

export interface WriteLeaseHooks {
  onInvalidate?: (reason: string) => void;
}

export function createWriteLease(
  id: string,
  hooks?: WriteLeaseHooks,
): WriteLease {
  let isValid = true;
  return {
    get id(): string {
      return id;
    },
    get valid(): boolean {
      return isValid;
    },
    invalidate(reason: string): void {
      // First invalidation wins (§5.3 step 2); repeats are inert so a late
      // sink close cannot resurrect or double-count the fence.
      if (!isValid) return;
      isValid = false;
      hooks?.onInvalidate?.(reason);
    },
  };
}

export interface SettlementOptions {
  // Injectable ISO-timestamp source (§5.1 timestamps must be testable offline).
  readonly now?: () => string;
  readonly leaseId?: string;
}

export interface SettlementReceiptExtras {
  readonly requested?: boolean;
  readonly confirmation?: SettlementReceipt["termination"]["confirmation"];
  readonly signalCascade?: readonly ("SIGTERM" | "SIGKILL")[];
  readonly localReleased?: boolean;
  readonly processGroupAlive?: SettlementReceipt["resources"]["processGroupAlive"];
  readonly remoteStatus?: SettlementReceipt["resources"]["remoteStatus"];
}

export interface AcceptedTerminal {
  readonly origin: TerminalOrigin;
  readonly status: TerminalStatus;
  readonly proof?: ProviderTerminalProof;
}

export interface SettlementSession {
  readonly sessionId: string;
  readonly attempt: number;
  readonly writeLease: WriteLease;
  // §5.1/§5.3 step 5 compare-and-set terminal slot: the first valid terminal
  // wins; later ones are counted (rejectedCount) but never replace it.
  acceptTerminal(
    origin: TerminalOrigin,
    status: TerminalStatus,
    proof?: ProviderTerminalProof,
  ): boolean;
  readonly terminal: AcceptedTerminal | undefined;
  readonly rejectedCount: number;
  rejectDataPlaneEvents(count?: number): void;
  readonly rejectedEvents: number;
  addWarning(warning: string): void;
  readonly warnings: readonly string[];
  markAbortRequested(): void;
  markLeaseInvalidated(): void;
  markTerminationConfirmed(): void;
  close(): void;
  receipt(
    outcome: SettlementOutcome,
    extras?: SettlementReceiptExtras,
  ): SettlementReceipt;
}

export function createSettlement(
  sessionId: string,
  attempt: number,
  options?: SettlementOptions,
): SettlementSession {
  const now = options?.now ?? (() => new Date().toISOString());
  const writeLease = createWriteLease(
    options?.leaseId ?? `${sessionId}-lease`,
    {
      onInvalidate: () => {
        if (leaseInvalidatedAt === undefined) leaseInvalidatedAt = now();
      },
    },
  );

  const startedAt = now();
  let abortRequestedAt: string | undefined;
  let leaseInvalidatedAt: string | undefined;
  let terminationConfirmedAt: string | undefined;

  let terminal: AcceptedTerminal | undefined;
  let rejectedCount = 0;
  let rejectedEvents = 0;
  const warnings: string[] = [];
  let closed = false;

  const invalidateLease = (reason: string): void => {
    if (!writeLease.valid) return;
    writeLease.invalidate(reason);
  };

  const session: SettlementSession = {
    sessionId,
    attempt,
    writeLease,
    acceptTerminal(origin, status, proof) {
      // §4.4/§5.3 step 5: compare-and-set — first valid terminal wins; once
      // the fence is closed nothing may win at all, only be counted.
      if (closed || terminal !== undefined) {
        rejectedCount++;
        return false;
      }
      terminal = { origin, status, proof };
      if (proof !== undefined && terminationConfirmedAt === undefined) {
        terminationConfirmedAt = now();
      }
      return true;
    },
    get terminal(): AcceptedTerminal | undefined {
      return terminal;
    },
    get rejectedCount(): number {
      return rejectedCount;
    },
    rejectDataPlaneEvents(count = 1): void {
      rejectedEvents += count;
    },
    get rejectedEvents(): number {
      return rejectedEvents;
    },
    addWarning(warning: string): void {
      warnings.push(warning);
    },
    get warnings(): readonly string[] {
      return warnings;
    },
    markAbortRequested(): void {
      if (abortRequestedAt === undefined) abortRequestedAt = now();
    },
    markLeaseInvalidated(): void {
      invalidateLease("lease invalidated (§5.3 step 2)");
    },
    markTerminationConfirmed(): void {
      if (terminationConfirmedAt === undefined) terminationConfirmedAt = now();
    },
    close(): void {
      closed = true;
      invalidateLease("settlement closed");
    },
    receipt(outcome, extras) {
      // A receipt always implies a closed fence (§13 line 738).
      closed = true;
      invalidateLease(`receipt issued for outcome ${outcome}`);
      if (
        extras?.confirmation === "process_group_exited" ||
        extras?.confirmation === "sdk_abort_confirmed"
      ) {
        session.markTerminationConfirmed();
      }
      const requested =
        extras?.requested ??
        (abortRequestedAt !== undefined ||
          outcome === "cancelled_confirmed" ||
          outcome === "local_fenced_remote_unconfirmed" ||
          outcome === "local_termination_unconfirmed");
      const confirmation =
        extras?.confirmation ??
        (outcome === "cancelled_confirmed"
          ? terminal?.proof
            ? "process_group_exited"
            : "sdk_abort_confirmed"
          : outcome === "completed" || outcome === "failed"
            ? terminal?.proof
              ? "process_group_exited"
              : "not_required"
            : "unconfirmed");
      const remoteStatus =
        extras?.remoteStatus ??
        (outcome === "completed"
          ? "completed"
          : outcome === "failed"
            ? "failed"
            : outcome === "cancelled_confirmed"
              ? "cancelled"
              : "unknown_may_continue");
      return {
        sessionId,
        attempt,
        outcome,
        termination: {
          requested:
            requested ||
            outcome === "cancelled_confirmed" ||
            outcome === "local_fenced_remote_unconfirmed" ||
            outcome === "local_termination_unconfirmed",
          confirmation,
          ...(extras?.signalCascade
            ? { signalCascade: extras.signalCascade }
            : {}),
        },
        resources: {
          localReleased: extras?.localReleased ?? true,
          processGroupAlive: extras?.processGroupAlive ?? "unknown",
          remoteStatus,
        },
        timestamps: {
          startedAt,
          ...(abortRequestedAt !== undefined ? { abortRequestedAt } : {}),
          ...(leaseInvalidatedAt !== undefined ? { leaseInvalidatedAt } : {}),
          ...(terminationConfirmedAt !== undefined
            ? { terminationConfirmedAt }
            : {}),
          settledAt: now(),
        },
        lateWriteFence: {
          leaseId: writeLease.id,
          closed: true,
          rejectedEvents,
        },
        warnings: [...warnings],
      };
    },
  };

  return session;
}

// §5.3 step 6: no transport terminal before grace expiry — synthesize an
// unconfirmed receipt, record the quarantine note, keep remote status honest.
export function synthesizeUnconfirmed(
  settlement: SettlementSession,
  extras?: {
    readonly processGroupAlive?: SettlementReceipt["resources"]["processGroupAlive"];
    readonly warning?: string;
    readonly outcome?:
      | "local_termination_unconfirmed"
      | "local_fenced_remote_unconfirmed";
  },
): SettlementReceipt {
  settlement.addWarning(extras?.warning ?? QUARANTINE_WARNING);
  return settlement.receipt(
    extras?.outcome ?? "local_termination_unconfirmed",
    {
      confirmation: "unconfirmed",
      processGroupAlive: extras?.processGroupAlive ?? "unknown",
      remoteStatus: "unknown_may_continue",
    },
  );
}

// §5.1: settled always resolves to a receipt — programmer/invariant failures
// convert to local_termination_unconfirmed with an internal warning so
// collection cannot hang.
export function synthesizeInternalFailure(
  settlement: SettlementSession,
  cause: unknown,
): SettlementReceipt {
  const message = cause instanceof Error ? cause.message : String(cause);
  return synthesizeUnconfirmed(settlement, {
    warning: `internal settlement invariant failure converted per §5.1: ${message}`,
  });
}
