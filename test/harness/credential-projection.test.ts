import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ProviderTransport,
  TransportOutcome,
  TransportRequest,
} from "../../src/execution/contracts";
import { StepExecutionHarness } from "../../src/execution/harness";
import { envBillsMetered } from "../../src/execution/usage-normalized";
import type {
  CredentialBroker,
  CredentialProjection,
} from "../../src/security/credential-broker";
import { CredentialProjectionError } from "../../src/security/credential-broker";

// In-memory broker over a real temp dir so destroy() is observable on disk.
class FakeBroker implements CredentialBroker {
  projectCalls = 0;
  destroyCalls = 0;
  lastProjection?: CredentialProjection;

  constructor(private readonly error?: CredentialProjectionError) {}

  async project(_input: {
    readonly sessionId: string;
    readonly credentialRef: string;
    readonly kind: string;
    readonly verifiedBinaryPath: string;
  }): Promise<CredentialProjection> {
    this.projectCalls++;
    if (this.error) throw this.error;
    const home = await mkdtemp(path.join(tmpdir(), "pr-hero-fake-proj-"));
    const projection: CredentialProjection = {
      projectionId: `cred-fake-${this.projectCalls}`,
      kind: "claude_subscription_oauth",
      syntheticHome: home,
      syntheticConfigHome: path.join(home, ".claude"),
      syntheticTmp: path.join(home, "tmp"),
      env: { HOME: home, TMPDIR: path.join(home, "tmp") },
      files: [],
      destroy: async () => {
        this.destroyCalls++;
        await rm(home, { recursive: true, force: true });
      },
    };
    this.lastProjection = projection;
    return projection;
  }
}

function recordingTransport(requests: TransportRequest[]): ProviderTransport {
  return {
    backend: "claude-code",
    capabilities: async () => {
      throw new Error("not used");
    },
    classifyFailure: () => undefined,
    async execute(request) {
      requests.push(request);
      return {
        completion: "success",
        protocolIntegrity: "verified",
        finalText: "{}",
        usage: {
          wallMs: 0,
          tokens: {},
          completeness: "complete",
          billingMode: "subscription",
          costSource: "provider",
          cashCostUsd: 0,
        },
        stderrTail: "",
      } satisfies TransportOutcome;
    },
  };
}

function makeHarness(transport: ProviderTransport, broker?: CredentialBroker) {
  return new StepExecutionHarness({
    transport,
    // Marks the harness as offline-test (skips the production allowlist gate).
    spawnFn: (() => ({
      exited: Promise.resolve(0),
    })) as unknown as typeof Bun.spawn,
    // Injected, never read off the real environment: these arms turn on
    // whether an AMBIENT credential survives into the child, so a test that
    // consulted `process.env` would pass or fail by whatever the operator
    // happened to have exported.
    childEnv: {
      HOME: "/Users/juanma-real-home",
      USER: "juanma",
      TMPDIR: "/var/folders/real-tmp",
      CLAUDE_CONFIG_DIR: "/Users/juanma-real-home/.claude",
      PATH: "/usr/bin:/bin",
      ANTHROPIC_API_KEY: "sk-ambient-operator-key",
      ANTHROPIC_AUTH_TOKEN: "ambient-operator-bearer",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-ambient",
      ANTHROPIC_BASE_URL: "https://gateway.operator.example",
    },
    credentialBroker: broker,
  });
}

async function runStep(
  harness: StepExecutionHarness,
  parse: (text: string) => unknown = (text) => JSON.parse(text),
) {
  const promptDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cred-probe-"));
  const systemPromptPath = path.join(promptDir, "system.md");
  await Bun.write(systemPromptPath, "system prompt");
  return harness.run({
    name: "cred-probe",
    systemPromptPath,
    prompt: "p",
    tools: [],
    model: "sonnet",
    cwd: "/tmp/ws",
    outPath: `/tmp/cred-probe-${Date.now()}.json`,
    mcpConfigPath: "/tmp/mcp.json",
    timeoutMs: 1000,
    maxAttempts: 1,
    parse,
  });
}

describe("harness with a CredentialBroker", () => {
  test("child env uses synthetic HOME/TMPDIR and drops the real HOME and CLAUDE_CONFIG_DIR", async () => {
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker();
    const harness = makeHarness(recordingTransport(requests), broker);
    const result = await runStep(harness);
    expect(result.status).toBe("ok");

    expect(broker.projectCalls).toBe(1);
    const projection = broker.lastProjection;
    if (projection === undefined) throw new Error("projection missing");
    const isolation = requests[0].isolation;
    expect(isolation.credentialProjectionId).toBe(projection.projectionId);
    expect(isolation.syntheticHome).toBe(projection.syntheticHome);
    expect(isolation.syntheticConfigHome).toBe(projection.syntheticConfigHome);
    expect(isolation.syntheticTmp).toBe(projection.syntheticTmp);
    expect(isolation.env.HOME).toBe(projection.syntheticHome);
    expect(isolation.env.TMPDIR).toBe(projection.syntheticTmp);
    expect(JSON.stringify(isolation.env)).not.toContain("juanma-real-home");
    expect(isolation.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(existsSync(projection.syntheticHome)).toBe(false);

    // Non-credential passthrough keys survive the overlay.
    expect(isolation.env.PATH).toBe("/usr/bin:/bin");
    expect(isolation.env.USER).toBe("juanma");
  });

  // 2026-09-02, #177 follow-up: the projection owns the CREDENTIAL, not only
  // HOME/TMPDIR. An ambient ANTHROPIC_API_KEY riding the enumerated
  // passthrough used to survive the overlay untouched on exactly the path
  // whose purpose is handing the child one freshly projected subscription
  // record — and #177 made that leak observable, because the billing basis is
  // now read off this same env.
  test("a projection strips the ambient credentials the passthrough carried", async () => {
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker();
    const harness = makeHarness(recordingTransport(requests), broker);
    const result = await runStep(harness);
    expect(result.status).toBe("ok");

    const env = requests[0].isolation.env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("ambient");
    // The other half of the defect, and the reason it stopped being inert:
    // this env is what decides how the attempt's money is filed. A leaked key
    // billed a subscription run as metered cash.
    expect(envBillsMetered(env)).toBe(false);

    // EXCLUDED on purpose, and asserted so the exclusion is a decision rather
    // than an oversight: ANTHROPIC_BASE_URL is not a credential. It sits in
    // the passthrough beside HTTP(S)_PROXY/SSL_CERT_* as network-routing
    // config, and the projection supplies no endpoint — stripping it would
    // silently send the projection path somewhere the no-projection path
    // does not go.
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.operator.example");
  });

  // The no-projection path is CI, and it is the one that already cost a real
  // failure: dropping CLAUDE_CODE_OAUTH_TOKEN lost pr-hero's first CI
  // self-review (2026-08-27) to "Not logged in". Credential projection needs
  // darwin + /usr/bin/security (runner-authority.ts `claudeCredentialBroker`),
  // so every CI runner lands here with no projection at all, and the strip
  // above must not reach it.
  test("without a projection the ambient credentials still reach the child", async () => {
    const requests: TransportRequest[] = [];
    const harness = makeHarness(recordingTransport(requests));
    const result = await runStep(harness);
    expect(result.status).toBe("ok");

    const env = requests[0].isolation.env;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ambient-operator-key");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ambient-operator-bearer");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-ambient");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.operator.example");
    // #177's own arm: a key with no projection is a real per-token spend and
    // must keep filing as cash.
    expect(envBillsMetered(env)).toBe(true);
    // And the projection-owned trio is untouched too — there is no projection
    // to own it.
    expect(env.HOME).toBe("/Users/juanma-real-home");
    expect(env.TMPDIR).toBe("/var/folders/real-tmp");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/juanma-real-home/.claude");
  });

  test("destroy runs after success AND after failed steps", async () => {
    for (const parse of [
      (text: string) => JSON.parse(text),
      (): unknown => {
        throw new Error("never delivered");
      },
    ]) {
      const requests: TransportRequest[] = [];
      const broker = new FakeBroker();
      const harness = makeHarness(recordingTransport(requests), broker);
      const result = await runStep(harness, parse);
      expect(broker.destroyCalls).toBe(1);
      if (result.status === "failed") {
        expect(result.stderrTail).not.toContain("destroy failed");
      }
      expect(
        existsSync(broker.lastProjection?.syntheticHome ?? "/nonexistent"),
      ).toBe(false);
    }
  });

  test("projection failure degrades to operator env with a stated warning instead of killing the step", async () => {
    let admitted = false;
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker(
      new CredentialProjectionError("missing_subscription_record"),
    );
    const harness = new StepExecutionHarness({
      transport: recordingTransport(requests),
      spawnFn: (() => ({
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn,
      childEnv: { HOME: "/Users/juanma-real-home" },
      admissionGate: {
        admit: () => {
          admitted = true;
        },
      },
      credentialBroker: broker,
    });
    const result = await runStep(harness);
    // Deliberate degradation (2026-08-26): reviews must keep working when the
    // CLI's credential store moves; the fallback is the pre-D1-05 enumerated
    // environment, loudly announced.
    expect(result.stderrTail).toContain("missing_subscription_record");
    expect(result.stderrTail).toContain("child runs with operator environment");
    expect(result.stderrTail).not.toContain("AT-");
    // The child saw the operator HOME, not a synthetic one.
    expect(requests.length).toBe(1);
    expect(requests[0]?.isolation.env.HOME).toBe("/Users/juanma-real-home");
    // The isolation record describes what ACTUALLY ran — no false synthetic
    // identity (§6.1 invariant env.HOME === syntheticHome).
    expect(requests[0]?.isolation.credentialProjectionId).toBe(
      "operator-env-fallback",
    );
    expect(requests[0]?.isolation.syntheticHome).toBe(
      "/Users/juanma-real-home",
    );
    expect(admitted).toBe(true);
    expect(broker.destroyCalls).toBe(0);
  });

  test("attack-signal projection failures still fail closed before admission", async () => {
    let admitted = false;
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker(
      new CredentialProjectionError("projection_layout_invalid"),
    );
    const harness = new StepExecutionHarness({
      transport: recordingTransport(requests),
      spawnFn: (() => ({
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn,
      childEnv: { HOME: "/Users/juanma-real-home" },
      admissionGate: {
        admit: () => {
          admitted = true;
        },
      },
      credentialBroker: broker,
    });
    const result = await runStep(harness);
    // A symlinked projection layout is an attack signal, not a moved store:
    // running an adversarial-diff agent with operator credentials precisely
    // when the defense tripped would be worse than no review.
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(0);
    expect(admitted).toBe(false);
    expect(requests.length).toBe(0);
    expect(result.stderrTail).toContain("projection_layout_invalid");
    expect(result.stderrTail).not.toContain("operator environment");
  });

  // #133: `missing_provider_record` is the metered kind's own failure class,
  // and it must NOT join the one-class degradation above. The degrade exists
  // because Claude's subscription store MOVED, which is an environment fact;
  // an absent provider API token is not, and running the step anyway would
  // hand an adversarial-diff agent the operator's ambient provider keys on a
  // route that bills real cash.
  test("a missing provider record fails closed instead of degrading", async () => {
    let admitted = false;
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker(
      new CredentialProjectionError("missing_provider_record"),
    );
    const harness = new StepExecutionHarness({
      transport: recordingTransport(requests),
      spawnFn: (() => ({
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn,
      childEnv: { HOME: "/Users/juanma-real-home" },
      admissionGate: {
        admit: () => {
          admitted = true;
        },
      },
      credentialBroker: broker,
    });
    const result = await runStep(harness);
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(0);
    expect(admitted).toBe(false);
    expect(requests.length).toBe(0);
    expect(result.stderrTail).toContain("missing_provider_record");
    expect(result.stderrTail).not.toContain("operator environment");
  });

  test("hanging credential projection fails before spawn within the projection budget", async () => {
    const requests: TransportRequest[] = [];
    const hangingBroker: CredentialBroker = {
      project: () => new Promise(() => {}),
    };
    const harness = new StepExecutionHarness({
      transport: recordingTransport(requests),
      spawnFn: (() => ({
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn,
      childEnv: {
        HOME: "/Users/juanma-real-home",
        PATH: "/usr/bin:/bin",
      },
      credentialBroker: hangingBroker,
      credentialProjectionTimeoutMs: 25,
    });
    const result = await runStep(harness);
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(0);
    expect(requests).toHaveLength(0);
    expect(result.stderrTail).toContain("broker_error");
  });

  test("late credential projection after timeout is destroyed instead of leaked", async () => {
    const requests: TransportRequest[] = [];
    let resolveLate: ((projection: CredentialProjection) => void) | undefined;
    let destroyCalls = 0;
    const slowBroker: CredentialBroker = {
      project: async () =>
        new Promise<CredentialProjection>((resolve) => {
          resolveLate = resolve;
        }),
    };
    const harness = new StepExecutionHarness({
      transport: recordingTransport(requests),
      spawnFn: (() => ({
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn,
      childEnv: {
        HOME: "/Users/juanma-real-home",
        PATH: "/usr/bin:/bin",
      },
      credentialBroker: slowBroker,
      credentialProjectionTimeoutMs: 25,
    });

    const resultPromise = runStep(harness);
    const result = await resultPromise;
    expect(result.status).toBe("failed");
    expect(requests).toHaveLength(0);

    const home = await mkdtemp(path.join(tmpdir(), "pr-hero-late-proj-"));
    const lateProjection: CredentialProjection = {
      projectionId: "late-projection",
      kind: "claude_subscription_oauth",
      syntheticHome: home,
      syntheticConfigHome: path.join(home, ".claude"),
      syntheticTmp: path.join(home, "tmp"),
      env: { HOME: home },
      files: [],
      destroy: async () => {
        destroyCalls++;
        await rm(home, { recursive: true, force: true });
      },
    };
    resolveLate?.(lateProjection);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(destroyCalls).toBe(1);
  });

  test("destroy failure is appended to stderrTail instead of thrown or replacing the outcome", async () => {
    const requests: TransportRequest[] = [];
    const broker = new FakeBroker();
    const harness = makeHarness(recordingTransport(requests), broker);
    // Sabotage destroy AFTER projection succeeds.
    const originalProject = broker.project.bind(broker);
    broker.project = async (input) => {
      const projection = await originalProject(input);
      projection.destroy = async () => {
        broker.destroyCalls++;
        throw new Error("EBUSY sabotage");
      };
      return projection;
    };
    const result = await runStep(harness);
    expect(result.status).toBe("ok");
    expect(broker.destroyCalls).toBe(1);
    expect(result.stderrTail).toContain(
      "[pr-hero] credential projection destroy failed",
    );
  });
});
