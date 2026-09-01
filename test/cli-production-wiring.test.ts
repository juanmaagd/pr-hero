import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveProductionRoutePlanAtConfirm } from "../src/cli";
import type { ExactBindingCapabilityReport } from "../src/execution/contracts";
import {
  createResolvedRoutePlan,
  resolveStepRoute,
} from "../src/model-routing";
import {
  d1_11EvidenceFromExactBinding,
  prepareProductionAdmissionContext,
} from "../src/production-runtime";
import {
  admitRoutePlan,
  type DefaultTransportRegistry,
} from "../src/transport-registry";

const mockLoadSdk = async () =>
  ({
    createOpencodeClient: () => ({
      session: {},
      event: {},
    }),
  }) as unknown as import("../src/transports/opencode-client").OpenCodeSdkLike;

const MACHO_PREFIX = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

async function writeExecutable(
  dir: string,
  name: string,
  body: string,
): Promise<{ canonicalPath: string; sha256: string }> {
  const filePath = path.join(dir, name);
  const bytes = Buffer.concat([MACHO_PREFIX, Buffer.from(body)]);
  await writeFile(filePath, bytes);
  await chmod(filePath, 0o755);
  const canonicalPath = await realpath(filePath);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return { canonicalPath, sha256: hasher.digest("hex") };
}

function fixtureDeps(
  tmpDir: string,
  claude: { canonicalPath: string },
  opencode: { canonicalPath: string },
) {
  return {
    existsFn: (p: string) =>
      p === claude.canonicalPath ||
      p === opencode.canonicalPath ||
      p.startsWith(tmpDir),
    realpathFn: async (p: string) => p,
  };
}

describe("CLI production wiring (verify C1/C3)", () => {
  test("prepareProductionAdmissionContext admits OpenCode with D1-11 evidence", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-prod-"));
    try {
      const claude = await writeExecutable(
        tmpDir,
        "claude",
        "#!/bin/sh\necho ok\n",
      );
      const opencode = await writeExecutable(tmpDir, "opencode", "opencode");
      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "openai/gpt-4o",
        routingConfig: {
          mappings: {
            "openai/gpt-4o": {
              backend: "opencode",
              provider: "openai",
              modelFamily: "gpt-4o",
              modelSnapshot: "gpt-4o",
            },
          },
        },
      });
      const plan = createResolvedRoutePlan([step]);
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan,
        env: { PATH: tmpDir },
        loadSdk: mockLoadSdk,
        authorityDeps: fixtureDeps(tmpDir, claude, opencode),
      });
      if ("error" in admission) {
        throw new Error(admission.error);
      }
      expect(admission.evidence.get("opencode")?.sdkAvailable).toBe(true);
      await expect(
        admitRoutePlan(plan, admission.registry, {
          mode: "production",
          evidence: admission.evidence,
        }),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // #149 follow-up: the fix forwards `credentialBrokers.opencode` into the
  // transport registry so the server launcher and the binding authority share
  // ONE broker. That forwarding was dead on the production path — the input
  // type carried no `credentialBrokers`, so the value was always undefined
  // and each side independently constructed its own OpenCodeAuthBroker.
  test("the opencode credential broker is resolved once and shared", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-broker-"));
    try {
      const claude = await writeExecutable(
        tmpDir,
        "claude",
        "#!/bin/sh\necho ok\n",
      );
      const opencode = await writeExecutable(tmpDir, "opencode", "opencode");
      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "openai/gpt-4o",
        routingConfig: {
          mappings: {
            "openai/gpt-4o": {
              backend: "opencode",
              provider: "openai",
              modelFamily: "gpt-4o",
              modelSnapshot: "gpt-4o",
            },
          },
        },
      });
      const plan = createResolvedRoutePlan([step]);
      const injected = {
        project: async () => {
          throw new Error("not called in this test");
        },
      };
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan,
        env: { PATH: tmpDir },
        loadSdk: mockLoadSdk,
        authorityDeps: fixtureDeps(tmpDir, claude, opencode),
        credentialBrokers: { opencode: injected },
      });
      if ("error" in admission) {
        throw new Error(admission.error);
      }
      // Identity, not shape: a second OpenCodeAuthBroker would satisfy a
      // shape assertion while being exactly the divergence under test.
      expect(admission.authorityOptions.credentialBrokers?.opencode).toBe(
        injected,
      );
      // The registry that launches the server holds the SAME object, not a
      // second one built from the same config.
      expect(
        (admission.registry as DefaultTransportRegistry)
          .openCodeCredentialBroker,
      ).toBe(injected);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("an uninjected opencode broker is still resolved once, not per consumer", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-broker2-"));
    try {
      const claude = await writeExecutable(
        tmpDir,
        "claude",
        "#!/bin/sh\necho ok\n",
      );
      const opencode = await writeExecutable(tmpDir, "opencode", "opencode");
      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "openai/gpt-4o",
        routingConfig: {
          mappings: {
            "openai/gpt-4o": {
              backend: "opencode",
              provider: "openai",
              modelFamily: "gpt-4o",
              modelSnapshot: "gpt-4o",
            },
          },
        },
      });
      const plan = createResolvedRoutePlan([step]);
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan,
        env: { PATH: tmpDir },
        loadSdk: mockLoadSdk,
        authorityDeps: fixtureDeps(tmpDir, claude, opencode),
      });
      if ("error" in admission) {
        throw new Error(admission.error);
      }
      // Defined even with nothing injected: the ONE instance both the binding
      // authority and the transport registry are handed.
      expect(
        admission.authorityOptions.credentialBrokers?.opencode,
      ).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("resolveProductionRoutePlanAtConfirm wires mixed Claude/OpenCode production admission", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-route-"));
    try {
      const claude = await writeExecutable(
        tmpDir,
        "claude",
        "#!/bin/sh\necho ok\n",
      );
      const opencode = await writeExecutable(tmpDir, "opencode", "opencode");
      const claudeStep = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const openStep = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "openai/gpt-4o",
        routingConfig: {
          mappings: {
            "openai/gpt-4o": {
              backend: "opencode",
              provider: "openai",
              modelFamily: "gpt-4o",
              modelSnapshot: "gpt-4o",
            },
          },
        },
      });
      const plan = createResolvedRoutePlan([claudeStep, openStep]);
      const routed = await resolveProductionRoutePlanAtConfirm({
        routingConfigured: true,
        workspaceRoot: tmpDir,
        buildRoutePlan: async () => plan,
        env: { PATH: tmpDir },
        loadSdk: mockLoadSdk,
        authorityDeps: fixtureDeps(tmpDir, claude, opencode),
      });
      expect(routed?.routePlan).toBe(plan);
      expect(
        routed?.productionAdmission.authorityOptions.executableAllowlists
          ?.opencode?.[0]?.sha256,
      ).toBe(opencode.sha256);
      expect(
        routed?.productionAdmission.authorityOptions.executableAllowlists?.[
          "claude-code"
        ]?.[0]?.sha256,
      ).toBe(claude.sha256);
      expect(routed?.productionAdmission.evidence.has("opencode")).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("d1_11EvidenceFromExactBinding keeps subscription pricing non-blocking", () => {
    const report: ExactBindingCapabilityReport = {
      routeKey: "k",
      backend: "claude-code",
      sdk: { available: true },
      binary: { resolved: true, absolutePath: "/bin/claude", sha256: "abc" },
      auth: {
        kind: "claude_subscription_oauth",
        projectionReady: true,
        probe: "passed",
      },
      environment: { syntheticHome: true, enumeratedPassthrough: false },
      isolation: {
        workspaceReadBroker: true,
        codegraphPolicy: false,
      },
      toolsMcp: { allowMapEnforced: true, mcpIntegrityChecked: true },
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
    };
    expect(d1_11EvidenceFromExactBinding(report).pricingReady).toBe(true);
  });
});
