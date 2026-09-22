import { describe, expect, test } from "bun:test";
import type { RunnerBackend } from "../src/execution/contracts";
import {
  credentialKindForRoute,
  resolveBindingAuthority,
  resolveRunnerAuthority,
} from "../src/runner-authority";
import type { CredentialBroker } from "../src/security/credential-broker";
import {
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
