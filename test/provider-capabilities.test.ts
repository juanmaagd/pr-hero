import { describe, expect, test } from "bun:test";
import type { ExactBindingCapabilityReport } from "../src/execution/contracts";
import {
  CLAUDE_CAPABILITY_STATICS,
  type ClaudeCanonicalBinary,
  capabilityGateDecision,
  claudeCredentialProjectionReady,
  exactBindingCapabilityGate,
  exactBindingCapabilityIssues,
  produceClaudeCapabilityReport,
  resolveClaudeCanonicalBinary,
} from "../src/provider-capabilities";
import { ClaudeCodeCliTransport } from "../src/transports/claude-code-cli";

const GREEN_BINARY = {
  existsFn: (p: string) => p === "/bin/claude" || p === "/usr/bin/security",
  realpathFn: async (p: string) => p,
  readFileFn: async () => new Uint8Array([1, 2, 3]),
};

function greenOptions() {
  return {
    env: { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    platform: "darwin" as NodeJS.Platform,
    home: "/home/user",
    authProbe: () => "passed" as const,
    ...GREEN_BINARY,
  };
}

describe("resolveClaudeCanonicalBinary", () => {
  test("resolves override through realpath and hashes bytes", async () => {
    const resolved: ClaudeCanonicalBinary = await resolveClaudeCanonicalBinary(
      { binaryPath: "/bin/claude", env: { PATH: "" } },
      GREEN_BINARY,
    );
    expect(resolved.error).toBeUndefined();
    if (resolved.error !== undefined) return;
    expect(resolved.canonicalPath).toBe("/bin/claude");
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(new Uint8Array([1, 2, 3]));
    expect(resolved.sha256).toBe(hasher.digest("hex"));
  });

  test("searches PATH in order and reports the canonical miss", async () => {
    const resolved = await resolveClaudeCanonicalBinary(
      { env: { PATH: "/a:/b" } },
      {
        existsFn: (p) => p === "/b/claude",
        realpathFn: async (p) => p,
        readFileFn: async () => new Uint8Array([9]),
      },
    );
    expect(resolved.error).toBeUndefined();
    if (resolved.error !== undefined) return;
    expect(resolved.canonicalPath).toBe("/b/claude");

    const missing = await resolveClaudeCanonicalBinary(
      { env: { PATH: "/empty" } },
      { existsFn: () => false },
    );
    expect(missing.error).toContain("not found on PATH");
  });
});

describe("claudeCredentialProjectionReady", () => {
  test("darwin with /usr/bin/security is ready; linux or missing security is not", () => {
    expect(
      claudeCredentialProjectionReady({
        platform: "darwin",
        existsFn: (p) => p === "/usr/bin/security",
      }),
    ).toBe(true);
    expect(
      claudeCredentialProjectionReady({
        platform: "linux",
        existsFn: () => true,
      }),
    ).toBe(false);
    expect(
      claudeCredentialProjectionReady({
        platform: "darwin",
        existsFn: () => false,
      }),
    ).toBe(false);
  });
});

describe("produceClaudeCapabilityReport", () => {
  test("green darwin environment yields degraded status with only known non-blocking gaps", async () => {
    const report = await produceClaudeCapabilityReport(greenOptions());
    expect(report.backend).toBe("claude-code");
    expect(report.status).toBe("degraded");
    expect(report.binary?.absolutePath).toBe("/bin/claude");
    expect(report.auth.kind).toBe(CLAUDE_CAPABILITY_STATICS.authKind);
    expect(report.auth.projectionReady).toBe(true);
    expect(report.auth.probe).toBe("passed");
    expect(report.isolation.syntheticHome).toBe(true);
    expect(report.isolation.workspaceReadBroker).toBe(true);
    expect(report.isolation.codegraphPolicy).toBe(false);
    expect(report.protocol.terminalProof).toBe(true);
    expect(report.protocol.boundedEvents).toBe(false);
    expect(report.billing.pricingReady).toBe(false);
    expect(report.cancellation.deadlineMs).toBe(7500);
    expect(report.cancellation.conformance).toBe("passed");
    expect(report.issues.map((i) => i.code).sort()).toEqual([
      "bounded_events_sink_missing",
      "codegraph_policy_unenforced",
      "pricing_table_missing",
    ]);
    expect(report.issues.every((i) => !i.blocking)).toBe(true);
  });

  test("missing binary produces a blocking issue, blocking status, and no binary field", async () => {
    const report = await produceClaudeCapabilityReport({
      ...greenOptions(),
      existsFn: () => false,
    });
    expect(report.status).toBe("blocking");
    expect(report.binary).toBeUndefined();
    const issue = report.issues.find((i) => i.code === "binary_unresolved");
    expect(issue?.blocking).toBe(true);
    expect(issue?.message).toContain("not found on PATH");
  });

  test("failed auth probe produces a blocking issue and blocking status", async () => {
    const report = await produceClaudeCapabilityReport({
      ...greenOptions(),
      authProbe: () => "failed" as const,
    });
    expect(report.status).toBe("blocking");
    const issue = report.issues.find((i) => i.code === "auth_failed");
    expect(issue?.blocking).toBe(true);
  });

  test("default auth probe mirrors system-tools predicate without spawning", async () => {
    const tokenReport = await produceClaudeCapabilityReport({
      ...greenOptions(),
      authProbe: undefined,
      env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk" },
      keychainProbe: () => false,
    });
    expect(tokenReport.auth.probe).toBe("passed");

    const sessionReport = await produceClaudeCapabilityReport({
      ...greenOptions(),
      authProbe: undefined,
      env: { PATH: "/bin" },
      home: "/home/user",
      existsFn: (p) => p === "/home/user/.claude.json",
      keychainProbe: () => false,
    });
    expect(sessionReport.auth.probe).toBe("passed");

    // §6.1's Linux-style credentials file is a valid session signal.
    const fileReport = await produceClaudeCapabilityReport({
      ...greenOptions(),
      authProbe: undefined,
      env: { PATH: "/bin" },
      home: "/home/user",
      existsFn: (p) => p === "/home/user/.claude/.credentials.json",
      keychainProbe: () => false,
    });
    expect(fileReport.auth.probe).toBe("passed");

    // macOS subscription route: no files at all, but the Keychain item exists
    // (metadata-only check, never -w — proven non-interactive).
    const keychainReport = await produceClaudeCapabilityReport({
      ...greenOptions(),
      authProbe: undefined,
      env: { PATH: "/bin" },
      home: "/home/user",
      keychainProbe: () => true,
    });
    expect(keychainReport.auth.probe).toBe("passed");

    const failedReport = await produceClaudeCapabilityReport({
      ...greenOptions(),
      authProbe: undefined,
      env: { PATH: "/bin" },
      home: "/home/user",
      keychainProbe: () => false,
    });
    expect(failedReport.auth.probe).toBe("failed");
    expect(failedReport.status).toBe("blocking");
  });

  test("non-darwin platforms report projection not ready and synthetic home off, non-blocking", async () => {
    const report = await produceClaudeCapabilityReport({
      ...greenOptions(),
      platform: "linux",
    });
    expect(report.auth.projectionReady).toBe(false);
    expect(report.isolation.syntheticHome).toBe(false);
    expect(report.status).toBe("degraded");
    const issue = report.issues.find(
      (i) => i.code === "credential_projection_unavailable",
    );
    expect(issue?.blocking).toBe(false);
  });
});

describe("capabilityGateDecision", () => {
  test("any blocking issue fails the gate with the codes named", async () => {
    const report = await produceClaudeCapabilityReport({
      ...greenOptions(),
      existsFn: () => false,
      authProbe: () => "failed" as const,
    });
    const decision = capabilityGateDecision(report);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain("binary_unresolved");
    expect(decision.reason).toContain("auth_failed");
  });

  test("degraded-only reports pass the gate", async () => {
    const report = await produceClaudeCapabilityReport(greenOptions());
    expect(capabilityGateDecision(report)).toEqual({ ok: true });
  });
});

describe("exactBindingCapabilityGate", () => {
  function greenBindingReport(
    overrides: Partial<ExactBindingCapabilityReport> = {},
  ): ExactBindingCapabilityReport {
    return {
      routeKey: "fp1",
      backend: "claude-code",
      sdk: { available: true },
      binary: {
        resolved: true,
        absolutePath: "/bin/claude",
        sha256: "a".repeat(64),
      },
      auth: {
        kind: "claude_subscription_oauth",
        projectionReady: true,
        probe: "passed",
      },
      environment: {
        syntheticHome: true,
        enumeratedPassthrough: false,
      },
      isolation: {
        workspaceReadBroker: true,
        codegraphPolicy: false,
      },
      toolsMcp: {
        allowMapEnforced: true,
        mcpIntegrityChecked: true,
      },
      protocol: {
        terminalProof: true,
        boundedEvents: false,
        usageMode: "snapshot",
      },
      usage: { normalized: true },
      billing: {
        mode: "subscription",
        pricingApplicability: "not_applicable",
        tokenPricingAvailable: false,
        cashCostAccountingValid: true,
      },
      ...overrides,
    };
  }

  test("subscription binding passes without token pricing when not applicable", () => {
    expect(exactBindingCapabilityGate(greenBindingReport())).toEqual({
      ok: true,
    });
  });

  test("metered binding fails when token pricing is required but unavailable", () => {
    const decision = exactBindingCapabilityGate(
      greenBindingReport({
        billing: {
          mode: "metered",
          pricingApplicability: "required",
          tokenPricingAvailable: false,
          cashCostAccountingValid: false,
        },
      }),
    );
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain("pricing_table_missing");
  });

  test("metered binding passes when token pricing is available", () => {
    expect(
      exactBindingCapabilityGate(
        greenBindingReport({
          billing: {
            mode: "metered",
            pricingApplicability: "required",
            tokenPricingAvailable: true,
            cashCostAccountingValid: true,
          },
        }),
      ).ok,
    ).toBe(true);
  });

  test("issues include non-blocking degraded gaps", () => {
    const issues = exactBindingCapabilityIssues(greenBindingReport());
    expect(issues.some((i) => i.code === "codegraph_policy_unenforced")).toBe(
      true,
    );
    expect(issues.every((i) => i.blocking === false)).toBe(true);
  });

  // Production-reachable since FOLLOW-UP-1: the producer
  // (FrozenRuntimeBinding.capabilities()) derives cashCostAccountingValid
  // from the ORIGINAL three-state legacy billing mode, so a legacy report
  // with `mode: "unknown"` emits exactly this combination — narrowed to
  // "subscription" with pricingApplicability "not_applicable" and
  // cashCostAccountingValid false. The producer-path proof lives in
  // test/production-runtime.test.ts ("an unknown legacy billing mode blocks
  // the exact-binding gate through the real producer"); this one keeps the
  // gate's own contract honest for any producer.
  test("subscription binding fails when cash-cost accounting is invalid", () => {
    const decision = exactBindingCapabilityGate(
      greenBindingReport({
        billing: {
          mode: "subscription",
          pricingApplicability: "not_applicable",
          tokenPricingAvailable: false,
          cashCostAccountingValid: false,
        },
      }),
    );
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain("cash_cost_accounting_invalid");
  });
});

describe("transport/producer parity (§11)", () => {
  test("transport.capabilities() matches the producer's static fields", async () => {
    const transport = new ClaudeCodeCliTransport();
    const fromTransport = await transport.capabilities();
    const fromProducer = await produceClaudeCapabilityReport(greenOptions());

    expect(fromTransport.auth.kind).toBe(fromProducer.auth.kind);
    expect(fromTransport.auth.kind).toBe(CLAUDE_CAPABILITY_STATICS.authKind);
    expect(fromTransport.isolation.workspaceReadBroker).toBe(
      fromProducer.isolation.workspaceReadBroker,
    );
    expect(fromTransport.protocol.terminalProof).toBe(
      fromProducer.protocol.terminalProof,
    );
    expect(fromTransport.protocol.boundedEvents).toBe(
      fromProducer.protocol.boundedEvents,
    );
    expect(fromTransport.protocol.usageMode).toBe(
      fromProducer.protocol.usageMode,
    );
    expect(fromTransport.cancellation.deadlineMs).toBe(
      fromProducer.cancellation.deadlineMs,
    );
    expect(fromTransport.cancellation.conformance).toBe(
      fromProducer.cancellation.conformance,
    );
    expect(fromTransport.billing.mode).toBe(fromProducer.billing.mode);
    // No contradictions on the honest gaps either.
    expect(fromTransport.isolation.codegraphPolicy).toBe(
      fromProducer.isolation.codegraphPolicy,
    );
    expect(fromTransport.billing.pricingReady).toBe(
      fromProducer.billing.pricingReady,
    );
    const producerCodes = new Set(fromProducer.issues.map((i) => i.code));
    for (const issue of fromTransport.issues) {
      expect(producerCodes.has(issue.code)).toBe(true);
      expect(issue.blocking).toBe(false);
    }
  });

  // The parity assertion above is FIXTURE-DEPENDENT, not structural, and that
  // is a landmine rather than an oversight: greenOptions() authenticates with
  // CLAUDE_CODE_OAUTH_TOKEN and no API key, so a producer that DERIVED its
  // billing mode would still answer "subscription" there and leave the whole
  // suite green while contradicting the static transport in every API-key
  // environment. Nothing else in this file asserts the constant's value at
  // all. These two tests close that hole.
  test("billingMode is a deliberate static, and stays one until pricing exists", async () => {
    // Pinning the value, not endorsing it. CLAUDE_CAPABILITY_STATICS declares
    // "fields every claude-code route claims independent of host environment",
    // and for billing that claim is knowingly false: an ANTHROPIC_API_KEY user
    // is billed per token and is reported as a subscription anyway.
    //
    // It is left false ON PURPOSE, because deriving it today fails CLOSED in
    // the worst direction. Verified in the code, not assumed:
    //
    //   billing.mode "metered"
    //     -> pricingApplicability "required"        production-runtime.ts:263
    //     -> tokenPricingAvailable = pricingReady   production-runtime.ts:322
    //     -> pricingReady is hardcoded false in every transport
    //        (provider-capabilities.ts:555, claude-code-cli.ts:323,
    //         opencode-sdk.ts:373, transport-registry.ts:421)
    //     -> pricing_table_missing, blocking: true  provider-capabilities.ts:629-637
    //
    // A metered claude-code route would be refused ADMISSION outright, so an
    // API-key user would go from "review skipped at the budget ceiling" to
    // "review never runs". config/models/anthropic.json is a model-alias
    // catalogue with no prices in it, so pricingReady cannot become true by
    // reading what already ships.
    //
    // If this test just went red: you are on the right track and the
    // prerequisite is issue #137 (a real per-provider pricing catalogue), not
    // this constant. Land pricing first, then derive, then delete this test.
    // Issue #156's CI budget ceiling deliberately does NOT read this field --
    // see deriveCiBillingMode in src/ci-gates.ts, which answers the narrower
    // "should CI impose a spend ceiling?" and reaches nothing but the ceiling.
    expect(CLAUDE_CAPABILITY_STATICS.billingMode).toBe("subscription");

    const withApiKey = await produceClaudeCapabilityReport({
      ...greenOptions(),
      env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-test" },
    });
    expect(withApiKey.billing.mode).toBe("subscription");
    expect(withApiKey.billing.pricingReady).toBe(false);
  });

  test("the transport contradicts the producer in no environment", async () => {
    // The structural half of the parity claim: same assertion, run under an
    // API-key environment the green fixture never exercises. A derived
    // producer breaks HERE, which is the point -- the contradiction becomes a
    // red test instead of a production admission refusal.
    const transport = new ClaudeCodeCliTransport();
    const fromTransport = await transport.capabilities();
    const fromProducer = await produceClaudeCapabilityReport({
      ...greenOptions(),
      env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-test" },
    });
    expect(fromTransport.billing.mode).toBe(fromProducer.billing.mode);
  });
});
