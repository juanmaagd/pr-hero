import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { RunnerBackend } from "../src/execution/contracts";
import { envBillsMetered } from "../src/execution/usage-normalized";
import {
  credentialKindBillsMetered,
  credentialKindForRoute,
  resolveBindingAuthority,
  resolveRunnerAuthority,
} from "../src/runner-authority";
import type { CredentialBroker } from "../src/security/credential-broker";
import {
  KeychainCredentialBroker,
  OpenCodeApiTokenBroker,
  OpenCodeAuthBroker,
} from "../src/security/credential-broker";

describe("resolveRunnerAuthority", () => {
  test("resolves an explicit absolute override to canonical path + sha256 allowlist", async () => {
    const bytes = new TextEncoder().encode("#!/bin/sh\necho hi\n");
    const canonical = "/fake/bin/claude";
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const expectedSha = hasher.digest("hex");

    const result = await resolveRunnerAuthority(
      {
        binaryPath: canonical,
        workspaceRoot: "/fake/ws",
        executableAllowlists: {
          "claude-code": [{ absolutePath: canonical, sha256: expectedSha }],
        },
      },
      {
        existsFn: () => true,
        realpathFn: async (p) => p,
        readFileFn: async () => bytes,
        statFn: () => ({ mode: 0o755 }),
      },
    );

    expect(result.error).toBeUndefined();
    if (result.error !== undefined || result.runnerOptions === undefined)
      return;
    expect(result.runnerOptions.binaryPath).toBe(canonical);
    expect(result.runnerOptions.workspaceRoot).toBe("/fake/ws");
    expect(result.runnerOptions.executableAllowlist).toEqual([
      { absolutePath: canonical, sha256: expectedSha },
    ]);
  });

  test("without an override, searches the injected PATH dirs in order", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const expectedSha = hasher.digest("hex");

    const result = await resolveRunnerAuthority(
      {
        workspaceRoot: "/fake/ws",
        env: { PATH: "/first:/second:/third" },
        executableAllowlists: {
          "claude-code": [
            {
              absolutePath: "/real/second/claude",
              sha256: expectedSha,
            },
          ],
        },
      },
      {
        existsFn: (p) => p === "/second/claude" || p === "/real/second/claude",
        realpathFn: async (p) => `/real${p}`,
        readFileFn: async () => new Uint8Array([1, 2, 3]),
        statFn: () => ({ mode: 0o755 }),
      },
    );

    expect(result.error).toBeUndefined();
    if (result.runnerOptions === undefined) return;
    expect(result.runnerOptions.binaryPath).toBe("/real/second/claude");
    expect(result.runnerOptions.executableAllowlist[0].absolutePath).toBe(
      "/real/second/claude",
    );
  });

  test("without an explicit allowlist derives Claude discovery for CLI compatibility", async () => {
    const bytes = new TextEncoder().encode("#!/bin/sh\necho hi\n");
    const canonical = "/fake/bin/claude";
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const expectedSha = hasher.digest("hex");

    const result = await resolveRunnerAuthority(
      { binaryPath: canonical, workspaceRoot: "/fake/ws" },
      {
        existsFn: () => true,
        realpathFn: async (p) => p,
        readFileFn: async () => bytes,
        statFn: () => ({ mode: 0o755 }),
      },
    );

    expect(result.error).toBeUndefined();
    if (result.runnerOptions === undefined) return;
    expect(result.runnerOptions.executableAllowlist).toEqual([
      { absolutePath: canonical, sha256: expectedSha },
    ]);
  });

  test("existsFn for PATH probing does not bypass executable permission checks", async () => {
    const bytes = new TextEncoder().encode("#!/bin/sh\necho hi\n");
    const canonical = "/fake/bin/claude";
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const expectedSha = hasher.digest("hex");

    const result = await resolveRunnerAuthority(
      {
        binaryPath: canonical,
        workspaceRoot: "/fake/ws",
        executableAllowlists: {
          "claude-code": [{ absolutePath: canonical, sha256: expectedSha }],
        },
      },
      {
        existsFn: () => true,
        realpathFn: async (p) => p,
        readFileFn: async () => bytes,
        statFn: () => ({ mode: 0o644 }),
      },
    );

    expect(result.error).toContain("Missing executable permissions");
  });

  test("missing binary on PATH yields an error", async () => {
    const result = await resolveRunnerAuthority(
      { workspaceRoot: "/fake/ws", env: { PATH: "/empty" } },
      {
        existsFn: () => false,
        realpathFn: async (p) => p,
        readFileFn: async () => new Uint8Array(),
      },
    );

    expect(result.error).toBeDefined();
    expect(result.error).toContain("not found");
  });

  test("relative binary override is rejected", async () => {
    const result = await resolveRunnerAuthority(
      { binaryPath: "bin/claude", workspaceRoot: "/fake/ws" },
      {
        existsFn: () => true,
        realpathFn: async (p) => p,
        readFileFn: async () => new Uint8Array(),
      },
    );

    expect(result.error).toBeDefined();
    expect(result.error).toContain("absolute path");
  });
});

// #133: the credential kind is PROVIDER-keyed, not backend-keyed. Everything
// downstream — the billing mode, the projection payload, the rate-limit
// bucket — reads off this one decision.
describe("credentialKindForRoute", () => {
  test("the truth table", () => {
    expect(credentialKindForRoute("claude-code", "anthropic")).toBe(
      "claude_subscription_oauth",
    );
    // The backend decides for claude-code; the provider is not consulted.
    expect(credentialKindForRoute("claude-code", "openai")).toBe(
      "claude_subscription_oauth",
    );
    expect(credentialKindForRoute("opencode", "openai")).toBe(
      "opencode_chatgpt_oauth",
    );
    for (const provider of ["zai", "zai-coding-plan", "mistral", "google"]) {
      expect(credentialKindForRoute("opencode", provider)).toBe(
        "provider_api_token",
      );
    }
  });

  // Fail-closed: metered is the safe default, so a backend nobody has bound
  // must not silently inherit it. It has no credential authority at all.
  test("an unbound backend is refused rather than defaulted", () => {
    expect(() =>
      credentialKindForRoute("codex" as RunnerBackend, "openai"),
    ).toThrow(/codex/);
  });

  // #161 (corrected 2026-09-24 by Juanma). A claude-code route reads its kind
  // from the env it would see WITHOUT a projection (3rd arg) AND from
  // whether a broker will actually project one BEFORE the child spawns (4th
  // arg, `hasBroker`). Both default to the "nothing is known" case (`{}`,
  // `false`) so every existing call site that never threaded either through
  // keeps today's answer: subscription.
  describe("claude-code reads the env AND broker presence (#161)", () => {
    test("no arguments at all keeps the pre-#161 answer", () => {
      expect(credentialKindForRoute("claude-code", "anthropic")).toBe(
        "claude_subscription_oauth",
      );
    });

    test("a key with no broker resolves the metered kind", () => {
      expect(
        credentialKindForRoute(
          "claude-code",
          "anthropic",
          { ANTHROPIC_API_KEY: "sk-test" },
          false,
        ),
      ).toBe("provider_api_token");
      expect(
        credentialKindForRoute(
          "claude-code",
          "anthropic",
          { ANTHROPIC_AUTH_TOKEN: "bearer-test" },
          false,
        ),
      ).toBe("provider_api_token");
    });

    // THE precedence rule this correction exists for: a broker's presence
    // means the harness WILL strip the key before the child ever sees it
    // (PROJECTION_OWNED_KEYS, execution/harness.ts), so the kind must stay
    // subscription no matter what env carries — the child structurally
    // cannot spend a key it never receives. The first cut of #161 got this
    // backwards (skipped the broker whenever a key was present) and would
    // have silently rebilled a macOS subscription developer's ambient
    // ANTHROPIC_API_KEY as metered.
    test("a key WITH a broker stays the subscription kind — the broker wins", () => {
      expect(
        credentialKindForRoute(
          "claude-code",
          "anthropic",
          { ANTHROPIC_API_KEY: "sk-test" },
          true,
        ),
      ).toBe("claude_subscription_oauth");
      expect(
        credentialKindForRoute(
          "claude-code",
          "anthropic",
          { ANTHROPIC_AUTH_TOKEN: "bearer-test" },
          true,
        ),
      ).toBe("claude_subscription_oauth");
    });

    test("no key in env keeps the subscription kind regardless of broker presence", () => {
      for (const hasBroker of [true, false]) {
        expect(
          credentialKindForRoute("claude-code", "anthropic", {}, hasBroker),
        ).toBe("claude_subscription_oauth");
      }
    });

    // Same trim rule as `envBillsMetered`: a whitespace-only secret (a YAML
    // block scalar that kept its newline, a space-only value) is not a real
    // key.
    test("a whitespace-only key behaves like no key, with no broker", () => {
      expect(
        credentialKindForRoute(
          "claude-code",
          "anthropic",
          { ANTHROPIC_API_KEY: "   ", ANTHROPIC_AUTH_TOKEN: "\n" },
          false,
        ),
      ).toBe("claude_subscription_oauth");
    });
  });

  // The anti-fork guarantee, proven rather than restated: admission
  // (`credentialKindForRoute` -> `credentialKindBillsMetered`, reading the
  // RAW pre-strip env plus `hasBroker`) and usage filing (`envBillsMetered`
  // directly on the child's ACTUAL post-strip env, `claudeCliCostBasis` in
  // the transport) must reach the same billing mode for the same attempt —
  // projection present + key: both subscription; no projection + key: both
  // metered. This builds the post-strip env INDEPENDENTLY (a literal mirror
  // of `PROJECTION_OWNED_KEYS`, execution/harness.ts, not a call into
  // `credentialKindForRoute`'s own reasoning) so the test can actually catch
  // the two disagreeing, rather than restating the implementation back at it.
  describe("admission and usage filing agree (#161 anti-fork guarantee)", () => {
    const PROJECTION_OWNED_KEYS = [
      "HOME",
      "TMPDIR",
      "CLAUDE_CONFIG_DIR",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ] as const;

    function postStripEnv(
      rawEnv: Readonly<Record<string, string | undefined>>,
      hasBroker: boolean,
    ): Record<string, string | undefined> {
      if (!hasBroker) return { ...rawEnv };
      const stripped: Record<string, string | undefined> = { ...rawEnv };
      for (const key of PROJECTION_OWNED_KEYS) delete stripped[key];
      return stripped;
    }

    test("projection present + key: both sides say subscription", () => {
      const rawEnv = { ANTHROPIC_API_KEY: "sk-test" };
      const hasBroker = true;

      const kind = credentialKindForRoute(
        "claude-code",
        "anthropic",
        rawEnv,
        hasBroker,
      );
      expect(credentialKindBillsMetered(kind)).toBe(false);
      expect(envBillsMetered(postStripEnv(rawEnv, hasBroker))).toBe(false);
    });

    test("no projection + key: both sides say metered", () => {
      const rawEnv = { ANTHROPIC_API_KEY: "sk-test" };
      const hasBroker = false;

      const kind = credentialKindForRoute(
        "claude-code",
        "anthropic",
        rawEnv,
        hasBroker,
      );
      expect(credentialKindBillsMetered(kind)).toBe(true);
      expect(envBillsMetered(postStripEnv(rawEnv, hasBroker))).toBe(true);
    });

    test("the two sides agree across every env/broker combination", () => {
      const envs: ReadonlyArray<Readonly<Record<string, string | undefined>>> =
        [
          {},
          { ANTHROPIC_API_KEY: "sk-test" },
          { ANTHROPIC_AUTH_TOKEN: "bearer-test" },
          { ANTHROPIC_API_KEY: "   ", ANTHROPIC_AUTH_TOKEN: "\n" },
          { ANTHROPIC_API_KEY: "sk-a", ANTHROPIC_AUTH_TOKEN: "bearer-b" },
        ];
      for (const env of envs) {
        for (const hasBroker of [true, false]) {
          const kind = credentialKindForRoute(
            "claude-code",
            "anthropic",
            env,
            hasBroker,
          );
          expect(credentialKindBillsMetered(kind)).toBe(
            envBillsMetered(postStripEnv(env, hasBroker)),
          );
        }
      }
    });
  });
});

describe("resolveBindingAuthority credential identity", () => {
  const bytes = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
  const canonical = "/fake/bin/opencode";
  const sha256 = (() => {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    return hasher.digest("hex");
  })();

  const deps = {
    existsFn: () => true,
    realpathFn: async (p: string) => p,
    readFileFn: async () => bytes,
    statFn: () => ({ mode: 0o755 }),
  };

  async function bind(provider: string) {
    const result = await resolveBindingAuthority(
      "opencode",
      provider,
      {
        workspaceRoot: "/fake/ws",
        openCodeBinaryPath: canonical,
        executableAllowlists: {
          opencode: [{ absolutePath: canonical, sha256 }],
        },
      },
      deps,
    );
    if (result.binding === undefined) {
      throw new Error(result.error ?? "no binding");
    }
    return result.binding;
  }

  test("the opencode OAuth route keeps its kind and names its provider", async () => {
    const binding = await bind("openai");
    expect(binding.credentialKind).toBe("opencode_chatgpt_oauth");
    expect(binding.credentialRef).toBe("opencode-auth:openai");
  });

  // The credentialRef is half of `credentialFingerprint`
  // (production-runtime.ts), which is what separates rate-limit buckets. Two
  // providers on one backend are two different credentials, so a shared ref
  // would pool their quota into one bucket.
  test("two providers on the same backend get distinct credential refs", async () => {
    const zai = await bind("zai");
    const plan = await bind("zai-coding-plan");
    expect(zai.credentialKind).toBe("provider_api_token");
    expect(zai.credentialRef).toBe("opencode-auth:zai");
    expect(plan.credentialRef).toBe("opencode-auth:zai-coding-plan");
    expect(plan.credentialRef).not.toBe(zai.credentialRef);
  });

  // The default broker must MATCH the kind. Handing an api-token route the
  // OAuth broker would fail at projection time, deep inside a live run.
  test("the default broker matches the resolved kind", async () => {
    const oauth = await bind("openai");
    const token = await bind("zai");
    expect(oauth.credentialBroker).toBeInstanceOf(OpenCodeAuthBroker);
    expect(token.credentialBroker).toBeInstanceOf(OpenCodeApiTokenBroker);
  });

  test("an injected broker still overrides both kinds", async () => {
    const fake: CredentialBroker = {
      project: async () => {
        throw new Error("never projected in this test");
      },
    };
    for (const provider of ["openai", "zai"]) {
      const result = await resolveBindingAuthority(
        "opencode",
        provider,
        {
          workspaceRoot: "/fake/ws",
          openCodeBinaryPath: canonical,
          executableAllowlists: {
            opencode: [{ absolutePath: canonical, sha256 }],
          },
          credentialBrokers: { opencode: fake },
        },
        deps,
      );
      expect(result.binding?.credentialBroker).toBe(fake);
    }
  });
});

// #161: an API-key claude-code route binds as metered — a different
// credential kind, no default Keychain broker (it projects only the
// subscription record and throws for anything else, credential-broker.ts),
// and its own rate-limit bucket — while a no-key route stays byte-identical
// to the pre-#161 shape.
describe("resolveBindingAuthority claude-code credential kind (#161)", () => {
  const bytes = new TextEncoder().encode("#!/bin/sh\necho hi\n");
  const canonical = "/fake/bin/claude";
  const sha256 = (() => {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    return hasher.digest("hex");
  })();

  const deps = {
    existsFn: () => true,
    realpathFn: async (p: string) => p,
    readFileFn: async () => bytes,
    statFn: () => ({ mode: 0o755 }),
  };

  async function bindClaude(
    env: Readonly<Record<string, string | undefined>>,
    credentialBrokers?: { readonly "claude-code": CredentialBroker },
  ) {
    const result = await resolveBindingAuthority(
      "claude-code",
      "anthropic",
      {
        binaryPath: canonical,
        workspaceRoot: "/fake/ws",
        executableAllowlists: {
          "claude-code": [{ absolutePath: canonical, sha256 }],
        },
        env,
        ...(credentialBrokers === undefined ? {} : { credentialBrokers }),
      },
      deps,
    );
    if (result.binding === undefined) {
      throw new Error(result.error ?? "no binding");
    }
    return result.binding;
  }

  // Whether THIS host would actually offer the real default (darwin +
  // /usr/bin/security) is orthogonal to what #161 changes, but it decides
  // which arms below can exercise the FULL resolveBindingAuthority path
  // deterministically: injecting a fake broker is always deterministic
  // (proves the "a broker IS present" arm on every host); proving "NO broker
  // at all" end to end needs a host whose default genuinely resolves to
  // undefined, which this darwin sandbox's real Keychain does not. That arm's
  // platform-independent proof is `credentialKindForRoute`'s own describe
  // block above ("a key with no broker resolves the metered kind") — this
  // block's own copy is `skipIf`'d here and runs for real on CI's
  // ubuntu-latest.
  function darwinKeychainAvailable(): boolean {
    return process.platform === "darwin" && existsSync("/usr/bin/security");
  }

  test("no key: unchanged — subscription kind, the platform-gated Keychain default, and the claude-code bucket", async () => {
    const binding = await bindClaude({});
    expect(binding.credentialKind).toBe("claude_subscription_oauth");
    expect(credentialKindBillsMetered(binding.credentialKind)).toBe(false);
    expect(binding.bucketId).toBe("claude-code");
    if (darwinKeychainAvailable()) {
      expect(binding.credentialBroker).toBeInstanceOf(KeychainCredentialBroker);
    } else {
      expect(binding.credentialBroker).toBeUndefined();
    }
  });

  // #161 (corrected 2026-09-24). THE precedence test: a key alongside a
  // broker must stay subscription — the broker is going to strip that key
  // before the child ever spawns (PROJECTION_OWNED_KEYS, harness.ts), so
  // billing the developer as metered would charge for spend the child
  // structurally cannot incur. The fake broker makes this deterministic on
  // every host, unlike the real Keychain default.
  test("a key WITH a broker: subscription kind, the broker still attaches, the claude-code bucket", async () => {
    const fake: CredentialBroker = {
      project: async () => {
        throw new Error("never projected in this test");
      },
    };
    const binding = await bindClaude(
      { ANTHROPIC_API_KEY: "sk-test" },
      { "claude-code": fake },
    );
    expect(binding.credentialKind).toBe("claude_subscription_oauth");
    expect(credentialKindBillsMetered(binding.credentialKind)).toBe(false);
    expect(binding.credentialBroker).toBe(fake);
    expect(binding.bucketId).toBe("claude-code");
  });

  test("ANTHROPIC_AUTH_TOKEN with a broker: same precedence as ANTHROPIC_API_KEY", async () => {
    const fake: CredentialBroker = {
      project: async () => {
        throw new Error("never projected in this test");
      },
    };
    const binding = await bindClaude(
      { ANTHROPIC_AUTH_TOKEN: "bearer-test" },
      { "claude-code": fake },
    );
    expect(binding.credentialKind).toBe("claude_subscription_oauth");
    expect(binding.credentialBroker).toBe(fake);
    expect(binding.bucketId).toBe("claude-code");
  });

  // The full path for "a key, no broker at all" — only exercisable end to
  // end on a host whose default Keychain broker genuinely resolves to
  // undefined (CI's ubuntu-latest). On this darwin sandbox it is skipped in
  // favour of the deterministic, platform-independent proof in
  // `credentialKindForRoute`'s own describe block.
  test.skipIf(darwinKeychainAvailable())(
    "a key with no broker at all: metered kind, no broker, the API bucket",
    async () => {
      const binding = await bindClaude({ ANTHROPIC_API_KEY: "sk-test" });
      expect(binding.credentialKind).toBe("provider_api_token");
      expect(credentialKindBillsMetered(binding.credentialKind)).toBe(true);
      expect(binding.credentialBroker).toBeUndefined();
      expect(binding.bucketId).toBe("claude-code-api");
      expect(binding.bucketId).not.toBe("claude-code");
    },
  );

  test("whitespace-only key behaves like no key, whether or not a broker is present", async () => {
    const withoutBroker = await bindClaude({ ANTHROPIC_API_KEY: "   " });
    expect(withoutBroker.credentialKind).toBe("claude_subscription_oauth");
    expect(withoutBroker.bucketId).toBe("claude-code");

    const fake: CredentialBroker = {
      project: async () => {
        throw new Error("never projected in this test");
      },
    };
    const withBroker = await bindClaude(
      { ANTHROPIC_API_KEY: "   " },
      { "claude-code": fake },
    );
    expect(withBroker.credentialKind).toBe("claude_subscription_oauth");
    expect(withBroker.credentialBroker).toBe(fake);
  });
});
