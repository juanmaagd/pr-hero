// §7 (docs/multi-runtime-model-diversity-design.md lines 370-422): cause
// answers WHAT happened; disposition answers WHAT the harness may do. They
// are separate types and this pure module is the only place that maps one
// onto the other — LLMs judge, code governs.

import type { FailureClass } from "../step-runner";
import type { TransportFailureCause } from "./contracts";

export type { TransportFailureCause };

// §7 lines 390-395, verbatim.
export type HarnessFailureCause =
  | "format_violation"
  | "watchdog_timeout"
  | "pipeline_cancelled"
  | "user_cancelled"
  | "settlement_unconfirmed";

// §7 line 397, verbatim.
export type FailureCause = TransportFailureCause | HarnessFailureCause;

// §7 lines 399-402, verbatim.
export interface RetryState {
  readonly transientAttemptsUsed: number;
  readonly formatRetriesUsed: number;
}

// §7 lines 404-408, verbatim.
export type RetryDisposition =
  | { action: "retry_now"; budget: "transient" }
  | { action: "retry_after"; budget: "transient"; delayMs: number }
  | { action: "retry_format_reminder"; budget: "format" }
  | { action: "terminal" };

// One failed outcome reduced to policy input. The `legacy_terminal` arm
// carries a stop ruling that has no §7 cause behind it — see the bridge
// comment below for WHY it must stay cause-less.
export type CauseResolution =
  | { readonly kind: "cause"; readonly cause: FailureCause }
  | { readonly kind: "legacy_terminal" };

const DEFAULT_MAX_TRANSIENT_ATTEMPTS = 3;
const DEFAULT_MAX_RETRY_AFTER_DELAY_MS = 60_000;
const DEFAULT_MAX_FORMAT_RETRIES = 1;
// Base of the §7 line 416 capped exponential backoff: doubles per
// transientAttemptsUsed, hard-capped at maxRetryAfterDelayMs.
const RATE_LIMIT_BACKOFF_BASE_MS = 1_000;

export function decideRetryDisposition(
  cause: FailureCause,
  state: RetryState,
  options: {
    readonly maxTransientAttempts?: number;
    readonly maxRetryAfterDelayMs?: number;
    readonly maxFormatRetries?: number;
    // §7 line 416: a VALIDATED Retry-After hint (positive, finite, ≤
    // maxRetryAfterDelayMs) is honored verbatim; an absent or invalid one
    // falls back to the capped exponential. Optional because
    // TransportOutcome carries no Retry-After fact yet — the harness wires
    // the hint through here when a transport ships one.
    readonly retryAfterMs?: number;
  } = {},
): RetryDisposition {
  const maxTransientAttempts =
    options.maxTransientAttempts ?? DEFAULT_MAX_TRANSIENT_ATTEMPTS;
  const maxRetryAfterDelayMs =
    options.maxRetryAfterDelayMs ?? DEFAULT_MAX_RETRY_AFTER_DELAY_MS;
  const maxFormatRetries =
    options.maxFormatRetries ?? DEFAULT_MAX_FORMAT_RETRIES;

  // §7 line 417: the format reminder answers to its OWN budget alone, so it
  // is decided before any transient arithmetic can touch it (§13 line 759).
  if (cause === "format_violation") {
    return state.formatRetriesUsed < maxFormatRetries
      ? { action: "retry_format_reminder", budget: "format" }
      : { action: "terminal" };
  }

  const transientBudgetLeft =
    state.transientAttemptsUsed < maxTransientAttempts;

  switch (cause) {
    case "network_transient":
    case "protocol_truncation":
    case "watchdog_timeout":
      return transientBudgetLeft
        ? { action: "retry_now", budget: "transient" }
        : { action: "terminal" };
    case "rate_limit": {
      if (!transientBudgetLeft) return { action: "terminal" };
      const hint = options.retryAfterMs;
      const delayMs =
        hint !== undefined &&
        Number.isFinite(hint) &&
        hint > 0 &&
        hint <= maxRetryAfterDelayMs
          ? hint
          : Math.min(
              RATE_LIMIT_BACKOFF_BASE_MS * 2 ** state.transientAttemptsUsed,
              maxRetryAfterDelayMs,
            );
      return { action: "retry_after", budget: "transient", delayMs };
    }
    default:
      // §7 lines 418-420: every remaining cause — auth/quota/context/output/
      // safety/config/runtime, protocol conformance failures, cancellations
      // and unconfirmed settlements/aborts — is terminal.
      return { action: "terminal" };
  }
}

// WHY legacy "terminal" becomes a disposition, not a cause: §7 lines 375-397
// freeze the cause vocabulary verbatim, and "the transport said stop" carries
// stop authority without causal content — inventing a union member would
// drift the frozen schema, so the bridge hands the harness a direct terminal
// ruling instead. The transient/format budget separation (§13 line 759) is
// untouched either way.
export function causeFromLegacyFailureClass(
  legacy: FailureClass,
): CauseResolution {
  switch (legacy) {
    case "transient":
      return { kind: "cause", cause: "network_transient" };
    case "format":
      return { kind: "cause", cause: "format_violation" };
    case "terminal":
      return { kind: "legacy_terminal" };
  }
}
