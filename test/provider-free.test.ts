import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ProviderCapabilityReport,
  RunnerBackend,
} from "../src/execution/contracts";
import { createFreeModelProbe, isFreeModel } from "../src/free-model-discovery";
import {
  createResolvedRoutePlan,
  resolveStepRoute,
} from "../src/model-routing";
import {
  createProductionRuntime,
  d1_11EvidenceFromExactBinding,
  prepareProductionAdmissionContext,
  probeBindingsReadiness,
  productionFallbackRegistry,
  soleOpenCodeCredential,
} from "../src/production-runtime";
import { exactBindingCapabilityIssues } from "../src/provider-capabilities";
import {
  credentialKindBillsMetered,
  credentialKindForRoute,
  openCodeCredentialBroker,
  openCodeCredentialBrokerForKind,
} from "../src/runner-authority";
import {
  CredentialProjectionError,
  OpenCodeApiTokenBroker,
  OpenCodeAuthBroker,
  OpenCodeFreeBroker,
} from "../src/security/credential-broker";
import {
  createDefaultTransportRegistry,
  DefaultTransportRegistry,
  openCodeLaunchServerFor,
} from "../src/transport-registry";

const MACHO_PREFIX = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

async function writeOpenCodeFixture(dir: string) {
  const p = path.join(dir, "opencode");
  const bytes = Buffer.concat([MACHO_PREFIX, Buffer.from("opencode")]);
  await writeFile(p, bytes);
  await chmod(p, 0o755);
  const canonicalPath = await realpath(p);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return { canonicalPath, sha256: hasher.digest("hex") };
}

function freeStdout(
  provider: string,
  model: string,
  overrides: {
    status?: unknown;
    input?: unknown;
    output?: unknown;
    read?: unknown;
    write?: unknown;
    omitCost?: boolean;
    omitCache?: boolean;
  } = {},
): string {
  const cost = overrides.omitCost
    ? ""
    : `,\n  "cost": ${
        overrides.omitCache
          ? `{"input": ${overrides.input ?? 0}, "output": ${overrides.output ?? 0}}`
          : `{"input": ${overrides.input ?? 0}, "output": ${overrides.output ?? 0}, "cache": {"read": ${overrides.read ?? 0}, "write": ${overrides.write ?? 0}}}`
      }`;
  return `${provider}/${model}\n{\n  "id": "${model}",\n  "providerID": "${provider}",\n  "status": ${JSON.stringify(overrides.status ?? "active")}${cost}\n}\n`;
}

function opencodeStep(
  stepKey: string,
  cliModel: string,
  provider: string,
  modelSnapshot: string,
) {
  return resolveStepRoute({
    stepKey,
    role: "hunter",
    cliModel,
    routingConfig: {
      mappings: {
        [cliModel]: {
          backend: "opencode",
          provider,
          modelFamily: modelSnapshot,
          modelSnapshot,
        },
      },
    },
  });
}

function mockOpencodeTransport() {
  return {
    backend: "opencode" as const,
    capabilities: async (): Promise<ProviderCapabilityReport> => ({
      backend: "opencode",
      status: "ready" as const,
      auth: {
        kind: "opencode_chatgpt_oauth" as const,
        projectionReady: true,
        probe: "passed" as const,
      },
      isolation: {
        syntheticHome: true,
        workspaceReadBroker: true,
        codegraphPolicy: true,
      },
      protocol: {
        terminalProof: true,
        boundedEvents: true,
        usageMode: "snapshot" as const,
      },
      cancellation: { deadlineMs: 5000, conformance: "passed" as const },
      billing: { mode: "subscription" as const, pricingReady: true },
      issues: [],
    }),
    execute: async () => {
      throw new Error("not used");
    },
    classifyFailure: () => undefined,
  };
}

describe("#182 provider_free kind", () => {
  test("credentialKindBillsMetered is false for provider_free (explicit pin, not metered)", () => {
    expect(credentialKindBillsMetered("provider_free")).toBe(false);
    expect(credentialKindBillsMetered("provider_api_token")).toBe(true);
    expect(credentialKindBillsMetered("opencode_chatgpt_oauth")).toBe(false);
    expect(credentialKindBillsMetered("claude_subscription_oauth")).toBe(false);
  });

  test("kind-based broker selection: free/api/oauth", () => {
    expect(
      openCodeCredentialBrokerForKind("provider_free", "opencode"),
    ).toBeInstanceOf(OpenCodeFreeBroker);
    expect(
      openCodeCredentialBrokerForKind("provider_api_token", "zai"),
    ).toBeInstanceOf(OpenCodeApiTokenBroker);
    expect(
      openCodeCredentialBrokerForKind("opencode_chatgpt_oauth", "openai"),
    ).toBeInstanceOf(OpenCodeAuthBroker);
  });

  test("provider-keyed default still resolves opencode provider to metered pre-probe; #169 zai-coding-plan untouched", () => {
    expect(credentialKindForRoute("opencode", "opencode")).toBe(
      "provider_api_token",
    );
    expect(credentialKindForRoute("opencode", "zai-coding-plan")).toBe(
      "provider_api_token",
    );
    expect(credentialKindForRoute("opencode", "zai")).toBe(
      "provider_api_token",
    );
    expect(credentialKindForRoute("opencode", "openai")).toBe(
      "opencode_chatgpt_oauth",
    );
    expect(openCodeCredentialBroker("zai-coding-plan")).toBeInstanceOf(
      OpenCodeApiTokenBroker,
    );
  });
});

describe("#182 OpenCodeFreeBroker", () => {
  test("projects an empty projection with no auth file", async () => {
    const broker = new OpenCodeFreeBroker();
    const projection = await broker.project({
      sessionId: "s",
      credentialRef: "opencode-auth:opencode",
      kind: "provider_free",
      verifiedBinaryPath: "/fake/opencode",
    });
    try {
      expect(projection.kind).toBe("provider_free");
      expect(projection.files).toEqual([]);
      expect(projection.env.HOME).toBe(projection.syntheticHome);
      expect(projection.env.TMPDIR).toBe(projection.syntheticTmp);
      expect(projection.env.XDG_DATA_HOME).toContain(projection.syntheticHome);
      expect(projection.env.XDG_CONFIG_HOME).toContain(
        projection.syntheticHome,
      );
      const authFile = path.join(
        projection.syntheticHome,
        ".local",
        "share",
        "opencode",
        "auth.json",
      );
      expect(existsSync(authFile)).toBe(false);
    } finally {
      await projection.destroy();
    }
    expect(existsSync(projection.syntheticHome)).toBe(false);
  });

  test("refuses any other kind by name", async () => {
    const broker = new OpenCodeFreeBroker();
    for (const kind of [
      "provider_api_token",
      "opencode_chatgpt_oauth",
      "claude_subscription_oauth",
    ] as const) {
      let error: unknown;
      try {
        await broker.project({
          sessionId: "s",
          credentialRef: "opencode-auth:opencode",
          kind,
          verifiedBinaryPath: "/fake/opencode",
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(kind);
      expect((error as Error).message).toContain("OpenCodeFreeBroker");
      // Never the degrading class: harness.ts degrades exactly
      // missing_subscription_record to operator env.
      if (error instanceof CredentialProjectionError) {
        expect(error.failureClass).not.toBe("missing_subscription_record");
      }
    }
  });
});

describe("#182 isFreeModel strict predicate (live shape, fake spawn)", () => {
  test("true for all-zero active; argv carries --refresh", async () => {
    let seenArgv: readonly string[] = [];
    const ok = await isFreeModel({
      binaryPath: "/fake/opencode",
      provider: "opencode",
      model: "muse-spark-1.3-contributor-free",
      run: async (argv) => {
        seenArgv = argv;
        return {
          exitCode: 0,
          stdout: freeStdout("opencode", "muse-spark-1.3-contributor-free"),
        };
      },
    });
    expect(ok).toBe(true);
    expect([...seenArgv]).toEqual([
      "/fake/opencode",
      "models",
      "opencode",
      "--verbose",
      "--refresh",
    ]);
  });

  test("false for paid leaves (zai/glm-4.5 shape)", async () => {
    const ok = await isFreeModel({
      binaryPath: "/fake/opencode",
      provider: "zai",
      model: "glm-4.5",
      run: async () => ({
        exitCode: 0,
        stdout:
          `zai/glm-4.5\n` +
          JSON.stringify({
            id: "glm-4.5",
            providerID: "zai",
            status: "active",
            cost: { input: 0.6, output: 2.2, cache: { read: 0.11, write: 0 } },
          }),
      }),
    });
    expect(ok).toBe(false);
  });

  test("false for every single non-zero leaf, inactive status, missing fields", async () => {
    const base = {
      binaryPath: "/fake/opencode",
      provider: "opencode",
      model: "m",
    } as const;
    for (const overrides of [
      { input: 0.01 },
      { output: 0.01 },
      { read: 0.01 },
      { write: 0.01 },
      { status: "inactive" },
      { omitCost: true },
      { omitCache: true },
    ]) {
      const ok = await isFreeModel({
        ...base,
        run: async () => ({
          exitCode: 0,
          stdout: freeStdout("opencode", "m", overrides),
        }),
      });
      expect(ok).toBe(false);
    }
  });

  test("fail closed: spawn error, non-zero exit, bad JSON, missing header, relative binary", async () => {
    expect(
      await isFreeModel({
        binaryPath: "/fake/opencode",
        provider: "opencode",
        model: "m",
        run: async () => {
          throw new Error("no binary");
        },
      }),
    ).toBe(false);
    expect(
      await isFreeModel({
        binaryPath: "/fake/opencode",
        provider: "opencode",
        model: "m",
        run: async () => ({ exitCode: 1, stdout: "" }),
      }),
    ).toBe(false);
    expect(
      await isFreeModel({
        binaryPath: "/fake/opencode",
        provider: "opencode",
        model: "m",
        run: async () => ({
          exitCode: 0,
          stdout: "opencode/m\n{ not json",
        }),
      }),
    ).toBe(false);
    expect(
      await isFreeModel({
        binaryPath: "/fake/opencode",
        provider: "opencode",
        model: "wanted",
        run: async () => ({
          exitCode: 0,
          stdout: freeStdout("opencode", "other"),
        }),
      }),
    ).toBe(false);
    expect(
      await isFreeModel({
        binaryPath: "relative/opencode",
        provider: "opencode",
        model: "m",
        run: async () => ({
          exitCode: 0,
          stdout: freeStdout("opencode", "m"),
        }),
      }),
    ).toBe(false);
  });

  test("header splits on FIRST slash so model ids containing / match exactly", async () => {
    const ok = await isFreeModel({
      binaryPath: "/fake/opencode",
      provider: "opencode",
      model: "a/b",
      run: async () => ({
        exitCode: 0,
        stdout: freeStdout("opencode", "a/b"),
      }),
    });
    expect(ok).toBe(true);
    const wrongProvider = await isFreeModel({
      binaryPath: "/fake/opencode",
      provider: "other",
      model: "a/b",
      run: async () => ({
        exitCode: 0,
        stdout: freeStdout("opencode", "a/b"),
      }),
    });
    expect(wrongProvider).toBe(false);
  });

  test("createFreeModelProbe memoises per (provider, model)", async () => {
    let calls = 0;
    const probe = createFreeModelProbe({
      binaryPath: "/fake/opencode",
      run: async () => {
        calls++;
        return { exitCode: 0, stdout: freeStdout("opencode", "m") };
      },
    });
    expect(await probe("opencode", "m")).toBe(true);
    expect(await probe("opencode", "m")).toBe(true);
    expect(calls).toBe(1);
    expect(await probe("opencode", "other")).toBe(false);
    expect(calls).toBe(2);
  });
});

describe("#182 wiring: bindings, server, gates", () => {
  test("free binding: kind, broker, pricing not_applicable, evidence, no blocking issue", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-"));
    try {
      const opencode = await writeOpenCodeFixture(tmpDir);
      const step = opencodeStep(
        "hunter",
        "opencode/muse-spark-1.3-contributor-free",
        "opencode",
        "muse-spark-1.3-contributor-free",
      );
      const plan = createResolvedRoutePlan([step]);
      const registry = new DefaultTransportRegistry({ mode: "conformance" });
      registry.register("opencode", mockOpencodeTransport());
      const probe = await probeBindingsReadiness({
        workspaceRoot: tmpDir,
        plan,
        openCodeBinaryPath: opencode.canonicalPath,
        executableAllowlists: {
          opencode: [
            { absolutePath: opencode.canonicalPath, sha256: opencode.sha256 },
          ],
        },
        registry,
        mode: "conformance",
        freeModelProbe: async (provider, model) =>
          provider === "opencode" &&
          model === "muse-spark-1.3-contributor-free",
      });
      try {
        expect(probe.decision.ok).toBe(true);
        const binding = probe.bindings.get(step.routeFingerprint);
        if (!binding) throw new Error("missing binding");
        expect(binding.credential.kind).toBe("provider_free");
        expect(binding.credential.broker).toBeInstanceOf(OpenCodeFreeBroker);
        const report = await binding.capabilities();
        expect(report.auth.kind).toBe("provider_free");
        expect(report.billing.pricingApplicability).toBe("not_applicable");
        expect(report.billing.mode).toBe("subscription");
        expect(report.billing.cashCostAccountingValid).toBe(true);
        const evidence = d1_11EvidenceFromExactBinding(report, true);
        expect(evidence.credentialAuthority).toBe(true);
        expect(evidence.pricingReady).toBe(true);
        const blocking = exactBindingCapabilityIssues(report).filter(
          (i) => i.blocking,
        );
        expect(blocking).toEqual([]);
      } finally {
        await probe.dispose();
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("registry stamps free for the free kind (settlement guard reads it)", async () => {
    const fakeClient = {
      createSession: async () => ({ id: "s" }),
      async *streamEvents() {},
      pollStatus: async () => ({ kind: "pending" }) as const,
      abort: async () => {},
    };
    const registry = createDefaultTransportRegistry({
      mode: "conformance",
      openCodeClient: fakeClient as never,
      credentialKind: "provider_free",
    });
    const transport = registry.get("opencode", {
      routeFingerprint: "fp",
      route: {
        backend: "opencode",
        provider: "opencode",
        modelFamily: "muse-spark",
        modelSnapshot: "muse-spark-1.3-contributor-free",
      },
      credentialKind: "provider_free",
    }) as unknown as { usageBillingMode: string };
    // #182 follow-up: "free", not "subscription" — `settlementFromUsage`'s
    // free-nonzero rule keys on this stamp, and a subscription badge would
    // settle a flipped attempt's priced cost as a truthful zero.
    expect(transport.usageBillingMode).toBe("free");
  });

  test("admission: all-free plan resolves free server credential with the shared broker instance", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-adm-"));
    try {
      const step = opencodeStep(
        "hunter",
        "opencode/muse-spark-1.3-contributor-free",
        "opencode",
        "muse-spark-1.3-contributor-free",
      );
      const plan = createResolvedRoutePlan([step]);
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan,
        loadSdk: async () =>
          ({
            createOpencodeClient: () => ({ session: {}, event: {} }),
          }) as never,
        freeModelProbe: async () => true,
      });
      if ("error" in admission) throw new Error(admission.error);
      expect(admission.registry.openCodeCredentialKind).toBe("provider_free");
      expect(
        admission.authorityOptions.credentialBrokers?.opencode,
      ).toBeInstanceOf(OpenCodeFreeBroker);
      expect(admission.registry.openCodeCredentialBroker).toBe(
        admission.authorityOptions.credentialBrokers?.opencode,
      );
      expect(admission.freeModelProbe).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("admission: mixed free/metered plan is refused loudly, never silently OAuth", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-mix-"));
    try {
      const plan = createResolvedRoutePlan([
        opencodeStep("hunter", "opencode/free-model", "opencode", "free-model"),
        opencodeStep(
          "refuter",
          "opencode/paid-model",
          "opencode",
          "paid-model",
        ),
      ]);
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan,
        loadSdk: async () =>
          ({
            createOpencodeClient: () => ({ session: {}, event: {} }),
          }) as never,
        freeModelProbe: async (_p, m) => m === "free-model",
      });
      expect("error" in admission).toBe(true);
      if ("error" in admission) {
        expect(admission.error).toContain("mixed");
        expect(admission.error).toContain("free-model");
        expect(admission.error).toContain("paid-model");
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("runtime fallback with probe: all-free plan binds free end to end", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-rt-"));
    try {
      const opencode = await writeOpenCodeFixture(tmpDir);
      const step = opencodeStep(
        "hunter",
        "opencode/muse-spark-1.3-contributor-free",
        "opencode",
        "muse-spark-1.3-contributor-free",
      );
      const plan = createResolvedRoutePlan([step]);
      // No registry: exercises productionFallbackRegistry with the
      // soleCredentialOverride (the real fallback path, not a mock).
      const runtime = await createProductionRuntime({
        workspaceRoot: tmpDir,
        plan,
        openCodeBinaryPath: opencode.canonicalPath,
        executableAllowlists: {
          opencode: [
            { absolutePath: opencode.canonicalPath, sha256: opencode.sha256 },
          ],
        },
        mode: "conformance",
        freeModelProbe: async () => true,
      });
      try {
        const binding = runtime.bindings.get(step.routeFingerprint);
        expect(binding?.credential.kind).toBe("provider_free");
        expect(
          (runtime.registry as DefaultTransportRegistry).openCodeCredentialKind,
        ).toBe("provider_free");
      } finally {
        await runtime.dispose();
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("runtime refuses loudly when the server is free but bindings never probed", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-div-"));
    try {
      const step = opencodeStep(
        "hunter",
        "opencode/muse-spark-1.3-contributor-free",
        "opencode",
        "muse-spark-1.3-contributor-free",
      );
      const plan = createResolvedRoutePlan([step]);
      // Admission WITH probe decides free for the server…
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan,
        loadSdk: async () =>
          ({
            createOpencodeClient: () => ({ session: {}, event: {} }),
          }) as never,
        freeModelProbe: async () => true,
      });
      if ("error" in admission) throw new Error(admission.error);
      // …but the runtime is built WITHOUT the probe, so bindings stay
      // metered behind a free server. That divergence must refuse, never
      // silently serve metered routes from an empty projection.
      let error: unknown;
      try {
        await createProductionRuntime({
          ...admission.authorityOptions,
          plan,
          workspaceRoot: tmpDir,
          registry: admission.registry,
          mode: "conformance",
        });
      } catch (e) {
        error = e;
      }
      expect(String((error as Error)?.message ?? error)).toMatch(
        /freeModelProbe|empty projection|free/,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("soleOpenCodeCredential stays provider-based (free needs the async probe)", () => {
    const plan = createResolvedRoutePlan([
      opencodeStep("h", "opencode/m", "opencode", "m"),
    ]);
    expect(soleOpenCodeCredential(plan)).toEqual({
      kind: "provider_api_token",
      provider: "opencode",
    });
  });

  test("openCodeLaunchServerFor default stays OAuth; free kind always travels explicitly", async () => {
    // Kind-less callers get the OAuth pair — the fallback, never free.
    const launcher = openCodeLaunchServerFor({});
    expect(typeof launcher).toBe("function");
    const fallback = productionFallbackRegistry({ mode: "conformance" });
    expect(
      (fallback as DefaultTransportRegistry).openCodeCredentialKind,
    ).toBeUndefined();
    // A free binding forwards its kind explicitly on acquire().
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-free-exp-"));
    try {
      const opencode = await writeOpenCodeFixture(tmpDir);
      const step = opencodeStep(
        "hunter",
        "opencode/muse-spark-1.3-contributor-free",
        "opencode",
        "muse-spark-1.3-contributor-free",
      );
      const plan = createResolvedRoutePlan([step]);
      const seen: string[] = [];
      const recordingRegistry = {
        get(_backend: RunnerBackend, opts?: { credentialKind?: string }) {
          if (opts?.credentialKind) seen.push(opts.credentialKind);
          return mockOpencodeTransport() as never;
        },
        has: () => true,
        getCapabilityReport: async () => mockOpencodeTransport().capabilities(),
        getAllCapabilityReports: async () => new Map(),
      };
      const probe = await probeBindingsReadiness({
        workspaceRoot: tmpDir,
        plan,
        openCodeBinaryPath: opencode.canonicalPath,
        executableAllowlists: {
          opencode: [
            { absolutePath: opencode.canonicalPath, sha256: opencode.sha256 },
          ],
        },
        registry: recordingRegistry as never,
        mode: "conformance",
        freeModelProbe: async () => true,
      });
      try {
        const binding = probe.bindings.get(step.routeFingerprint);
        if (!binding) throw new Error("missing binding");
        await binding.acquire(
          {
            credentialProjectionId: "x",
            env: {},
            syntheticHome: "",
            syntheticConfigHome: "",
            syntheticTmp: "",
            verifiedBinaryPath: opencode.canonicalPath,
          },
          recordingRegistry as never,
        );
        expect(seen).toContain("provider_free");
      } finally {
        await probe.dispose();
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
