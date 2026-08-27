import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLAUDE_CREDENTIALS_KEYCHAIN_SERVICE,
  CredentialProjectionError,
  KeychainCredentialBroker,
  OPENCODE_AUTH_RELATIVE_PATH,
  OpenCodeAuthBroker,
  openCodeProjectionLayout,
} from "../../src/security/credential-broker";

// Obviously-fake tokens only — never a real credential value in a fixture.
const FAKE_STORE = JSON.stringify({
  claudeAiOauth: {
    accessToken: "AT-test-fake",
    expiresAt: "2026-01-01T00:00:00Z",
    refreshToken: "RT-test-fake",
    refreshTokenExpiresAt: "2026-02-01T00:00:00Z",
    scopes: ["user:inference"],
    subscriptionType: "max",
    rateLimitTier: "tier-a",
  },
  mcpOAuth: { "server-a": { accessToken: "AT-mcp-test-fake" } },
  unrelatedBookmark: "keep-out",
});

function brokerWithReader(readerFn: (service: string) => Promise<string>) {
  return new KeychainCredentialBroker({ readerFn });
}

const okReader = async () => FAKE_STORE;

async function project(broker = brokerWithReader(okReader)) {
  return broker.project({
    sessionId: "session-1",
    credentialRef: CLAUDE_CREDENTIALS_KEYCHAIN_SERVICE,
    kind: "claude_subscription_oauth",
    verifiedBinaryPath: "/usr/local/bin/claude",
  });
}

describe("KeychainCredentialBroker", () => {
  test("extracts ONLY claudeAiOauth — mcpOAuth and unknown keys never land in the projection", async () => {
    const projection = await project();
    try {
      const filePath = path.join(
        projection.syntheticHome,
        ".claude",
        ".credentials.json",
      );
      const written = JSON.parse(await Bun.file(filePath).text());
      expect(Object.keys(written)).toEqual(["claudeAiOauth"]);
      expect(written.claudeAiOauth.accessToken).toBe("AT-test-fake");
      expect(JSON.stringify(written)).not.toContain("mcpOAuth");
      expect(JSON.stringify(written)).not.toContain("unrelatedBookmark");
    } finally {
      await projection.destroy();
    }
  });

  test("layout: root/.claude/tmp are 0700, credentials file is 0600", async () => {
    const projection = await project();
    try {
      expect(statSync(projection.syntheticHome).mode & 0o777).toBe(0o700);
      expect(statSync(projection.syntheticConfigHome).mode & 0o777).toBe(0o700);
      expect(statSync(projection.syntheticTmp).mode & 0o777).toBe(0o700);
      expect(statSync(projection.files[0].path).mode & 0o777).toBe(0o600);
    } finally {
      await projection.destroy();
    }
  });

  // pr-hero F001 on PR #80. The create list had seven entries and the lstat
  // walk had six: xdgConfigHome, opencodeConfigDir and syntheticTmp were
  // built and then handed to the child as XDG_CONFIG_HOME, syntheticConfigHome
  // and TMPDIR without ever being checked — while the module's own comment
  // promised EVERY component was. Two hand-maintained lists of the same paths
  // is the defect; this test pins the single list they now share.
  test("every path the layout declares is created AND checked", () => {
    const layout = openCodeProjectionLayout("/tmp/root");
    expect(layout.directories.length).toBeGreaterThan(0);
    // Everything the child is handed must appear among the guarded paths.
    for (const handed of [
      layout.syntheticHome,
      layout.syntheticConfigHome,
      layout.syntheticTmp,
      layout.xdgDataHome,
      layout.authFile,
    ]) {
      expect(layout.guarded).toContain(handed);
    }
    for (const dir of layout.directories) {
      expect(layout.guarded).toContain(dir);
    }
  });

  test("no component of the projection is a symlink (§6.1 lstat defense)", async () => {
    const projection = await project();
    try {
      for (const component of [
        path.dirname(projection.syntheticHome),
        projection.syntheticHome,
        projection.syntheticConfigHome,
        projection.files[0].path,
        projection.syntheticTmp,
      ]) {
        expect(lstatSync(component).isSymbolicLink()).toBe(false);
      }
    } finally {
      await projection.destroy();
    }
  });

  test("files[] carries exactly path/mode/sha256 and the sha256 matches the written bytes", async () => {
    const projection = await project();
    try {
      expect(projection.files.length).toBe(1);
      const file = projection.files[0];
      expect(Object.keys(file).sort()).toEqual(["mode", "path", "sha256"]);
      expect(file.mode).toBe(0o600);
      const bytes = new Uint8Array(await Bun.file(file.path).bytes());
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(bytes);
      expect(file.sha256).toBe(hasher.digest("hex"));
      expect(await Bun.file(file.path).text()).not.toContain(
        "AT-mcp-test-fake",
      );
    } finally {
      await projection.destroy();
    }
  });

  test("env is exactly HOME+TMPDIR pointing at synthetic locations", async () => {
    const projection = await project();
    try {
      expect(projection.env).toEqual({
        HOME: projection.syntheticHome,
        TMPDIR: projection.syntheticTmp,
      });
    } finally {
      await projection.destroy();
    }
  });

  test("destroy removes the tree and is idempotent", async () => {
    const projection = await project();
    const root = projection.syntheticHome;
    expect(existsSync(root)).toBe(true);
    await projection.destroy();
    expect(existsSync(root)).toBe(false);
    await projection.destroy();
    expect(existsSync(root)).toBe(false);
  });

  test("reader failure produces a clean classed error with no source content", async () => {
    const broker = brokerWithReader(async () => {
      throw new Error("SecKeychainSearchCopyNext failed AT-test-fake");
    });
    let caught: unknown;
    try {
      await project(broker);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CredentialProjectionError);
    const projectionError = caught as CredentialProjectionError;
    expect(projectionError.failureClass).toBe("source_read_failed");
    expect(projectionError.message).not.toContain("AT-test-fake");
    expect(projectionError.message).not.toContain("SecKeychainSearchCopyNext");
  });

  test("malformed JSON produces a clean classed error without echoing the payload", async () => {
    const broker = brokerWithReader(
      async () => '{"claudeAiO":{"accessToken":"AT-test-fake"',
    );
    let caught: unknown;
    try {
      await project(broker);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CredentialProjectionError);
    const projectionError = caught as CredentialProjectionError;
    expect(projectionError.failureClass).toBe("malformed_payload");
    expect(projectionError.message).not.toContain("AT-test-fake");
    expect(projectionError.message).not.toContain("{");
  });

  test("store missing the subscription record fails loud", async () => {
    const broker = brokerWithReader(async () => '{"mcpOAuth":{}}');
    let caught: unknown;
    try {
      await project(broker);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CredentialProjectionError);
    expect((caught as CredentialProjectionError).failureClass).toBe(
      "missing_subscription_record",
    );
  });

  test("unsupported kinds fail loud naming the kind", async () => {
    const broker = brokerWithReader(okReader);
    for (const kind of [
      "opencode_chatgpt_oauth",
      "provider_api_token",
    ] as const) {
      let message = "";
      try {
        await broker.project({
          sessionId: "s",
          credentialRef: "ref",
          kind,
          verifiedBinaryPath: "/bin/true",
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(kind);
    }
  });

  test("production construction requires the pinned security binary", () => {
    expect(
      () =>
        new KeychainCredentialBroker({
          securityBinPath: path.join(
            mkdtempSync(path.join(tmpdir(), "prhero-broker-")),
            "absent-security",
          ),
        }),
    ).toThrow(/pinned security binary/i);
    const scratch = mkdtempSync(path.join(tmpdir(), "prhero-broker-"));
    rmSync(scratch, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// D1-06b: the OpenCode/ChatGPT OAuth route (§6.1). Empirically grounded —
// `opencode auth list` under a synthetic HOME reads
// <syntheticHome>/.local/share/opencode/auth.json and reports exactly the
// projected credential (verified 2026-08-27).
// ---------------------------------------------------------------------------

// Obviously-fake tokens only — never a real credential value in a fixture.
// The zai entries are the point of the exclusion test: they are unrelated
// provider secrets that share the store and must never travel.
const FAKE_OPENCODE_STORE = JSON.stringify({
  "zai-coding-plan": { key: "ZAI-KEY-test-fake", type: "api" },
  zai: { key: "ZAI-KEY-2-test-fake", type: "api" },
  openai: {
    type: "oauth",
    access: "AT-openai-test-fake",
    refresh: "RT-openai-test-fake",
    accountId: "acct-test-fake",
    expires: 1_788_000_000_000,
  },
});

function openCodeBroker(readerFn: () => Promise<string>) {
  return new OpenCodeAuthBroker({ readerFn });
}

async function projectOpenCode(
  broker = openCodeBroker(async () => FAKE_OPENCODE_STORE),
) {
  return broker.project({
    sessionId: "session-1",
    credentialRef: OPENCODE_AUTH_RELATIVE_PATH,
    kind: "opencode_chatgpt_oauth",
    verifiedBinaryPath: "/opt/homebrew/bin/opencode",
  });
}

function projectedAuthPath(syntheticHome: string): string {
  return path.join(syntheticHome, ".local", "share", "opencode", "auth.json");
}

describe("OpenCodeAuthBroker", () => {
  // The load-bearing one. OpenCode's auth.json is a SHARED store: every
  // provider the operator ever logged into lives in the same file. Copying it
  // wholesale would hand an OpenAI-routed step the operator's Z.ai keys.
  test("carries ONLY the openai record — sibling provider secrets never travel", async () => {
    const projection = await projectOpenCode();
    try {
      const raw = await Bun.file(
        projectedAuthPath(projection.syntheticHome),
      ).text();
      expect(Object.keys(JSON.parse(raw))).toEqual(["openai"]);
      expect(raw).not.toContain("ZAI-KEY-test-fake");
      expect(raw).not.toContain("ZAI-KEY-2-test-fake");
      expect(raw).not.toContain("zai");
    } finally {
      await projection.destroy();
    }
  });

  // The record travels WHOLE. The access token expires (~10 days on the
  // observed store) and the child rotates it with the refresh token;
  // projecting only `access` would hand it a credential it cannot renew.
  test("the whole record travels, refresh token included", async () => {
    const projection = await projectOpenCode();
    try {
      const written = JSON.parse(
        await Bun.file(projectedAuthPath(projection.syntheticHome)).text(),
      );
      expect(Object.keys(written.openai).sort()).toEqual([
        "access",
        "accountId",
        "expires",
        "refresh",
        "type",
      ]);
      expect(written.openai.refresh).toBe("RT-openai-test-fake");
    } finally {
      await projection.destroy();
    }
  });

  test("layout: root and every created level are 0700, auth.json is 0600", async () => {
    const projection = await projectOpenCode();
    try {
      for (const dir of [
        projection.syntheticHome,
        path.join(projection.syntheticHome, ".local"),
        path.join(projection.syntheticHome, ".local", "share"),
        path.join(projection.syntheticHome, ".local", "share", "opencode"),
        projection.syntheticTmp,
      ]) {
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }
      expect(
        statSync(projectedAuthPath(projection.syntheticHome)).mode & 0o777,
      ).toBe(0o600);
    } finally {
      await projection.destroy();
    }
  });

  test("no component of the projection is a symlink (§6.1 lstat defense)", async () => {
    const projection = await projectOpenCode();
    try {
      let cursor = projectedAuthPath(projection.syntheticHome);
      while (cursor.startsWith(projection.syntheticHome)) {
        expect(lstatSync(cursor).isSymbolicLink()).toBe(false);
        cursor = path.dirname(cursor);
      }
    } finally {
      await projection.destroy();
    }
  });

  // The isolation claim must not rest on the harness's env allowlist staying
  // XDG-free. OpenCode resolves its store through XDG_DATA_HOME first, so an
  // inherited value would silently defeat the synthetic home.
  test("env pins XDG so an inherited value cannot escape the projection", async () => {
    const projection = await projectOpenCode();
    try {
      expect(projection.env.HOME).toBe(projection.syntheticHome);
      expect(projection.env.XDG_DATA_HOME).toBe(
        path.join(projection.syntheticHome, ".local", "share"),
      );
      expect(projection.env.XDG_CONFIG_HOME).toBe(
        path.join(projection.syntheticHome, ".config"),
      );
      expect(projection.env.TMPDIR).toBe(projection.syntheticTmp);
    } finally {
      await projection.destroy();
    }
  });

  test("files[] carries the projected path and a sha256 of the real bytes", async () => {
    const projection = await projectOpenCode();
    try {
      expect(projection.files).toHaveLength(1);
      const entry = projection.files[0];
      expect(entry.path).toBe(projectedAuthPath(projection.syntheticHome));
      expect(entry.mode).toBe(0o600);
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(
        new TextEncoder().encode(await Bun.file(entry.path).text()),
      );
      expect(entry.sha256).toBe(hasher.digest("hex"));
    } finally {
      await projection.destroy();
    }
  });

  test("destroy removes the tree and is idempotent", async () => {
    const projection = await projectOpenCode();
    const root = projection.syntheticHome;
    await projection.destroy();
    expect(existsSync(root)).toBe(false);
    await projection.destroy();
    expect(existsSync(root)).toBe(false);
  });

  test("reader failure produces a clean classed error with no source content", async () => {
    const broker = openCodeBroker(async () => {
      throw new Error("/Users/someone/.local/share/opencode/auth.json ENOENT");
    });
    await expect(projectOpenCode(broker)).rejects.toThrow(
      CredentialProjectionError,
    );
    try {
      await projectOpenCode(broker);
    } catch (error) {
      const err = error as CredentialProjectionError;
      expect(err.failureClass).toBe("source_read_failed");
      expect(err.message).not.toContain("/Users/someone");
    }
  });

  test("malformed JSON produces a clean classed error without echoing it", async () => {
    const broker = openCodeBroker(async () => '{"openai": AT-leaked-value');
    try {
      await projectOpenCode(broker);
      throw new Error("expected a projection failure");
    } catch (error) {
      const err = error as CredentialProjectionError;
      expect(err.failureClass).toBe("malformed_payload");
      expect(err.message).not.toContain("AT-leaked-value");
    }
  });

  test("a store with no openai record fails loud", async () => {
    const broker = openCodeBroker(async () =>
      JSON.stringify({ zai: { key: "ZAI-KEY-test-fake", type: "api" } }),
    );
    try {
      await projectOpenCode(broker);
      throw new Error("expected a projection failure");
    } catch (error) {
      expect((error as CredentialProjectionError).failureClass).toBe(
        "missing_subscription_record",
      );
    }
  });

  // The kind claims ChatGPT OAuth. An `openai` entry holding a pay-as-you-go
  // API key is a different credential with different billing, and projecting
  // it under this kind would make the capability report's
  // `billing.mode: "subscription"` a lie.
  test("an openai API key is not the OAuth record this kind promises", async () => {
    const broker = openCodeBroker(async () =>
      JSON.stringify({ openai: { key: "sk-test-fake", type: "api" } }),
    );
    try {
      await projectOpenCode(broker);
      throw new Error("expected a projection failure");
    } catch (error) {
      expect((error as CredentialProjectionError).failureClass).toBe(
        "missing_subscription_record",
      );
    }
  });

  test("unsupported kinds fail loud naming the kind", async () => {
    const broker = openCodeBroker(async () => FAKE_OPENCODE_STORE);
    await expect(
      broker.project({
        sessionId: "s",
        credentialRef: OPENCODE_AUTH_RELATIVE_PATH,
        kind: "claude_subscription_oauth",
        verifiedBinaryPath: "/opt/homebrew/bin/opencode",
      }),
    ).rejects.toThrow(/claude_subscription_oauth/);
  });
});

// D1-08 PR3 task 3.9 (§9.2): CredentialProjection.bucketScope. Neither
// shipped broker populates it yet — claude_subscription_oauth has no
// account/project/rateLimitGroup to report — but the field must exist so a
// future broker can, and an absent bucketScope must feed deriveBucketId
// (execution/bucket-id.ts) identically to an explicit all-unknown one.
describe("CredentialProjection.bucketScope", () => {
  test("today's Keychain projection carries no bucketScope (honest, not populated)", async () => {
    const projection = await project();
    expect(projection.bucketScope).toBeUndefined();
  });

  test("an absent bucketScope and an explicit all-undefined one derive the identical bucketId", async () => {
    const { deriveBucketId } = await import("../../src/execution/bucket-id");
    const key = Buffer.from("c".repeat(64), "hex");
    const projection = await project();
    const withoutScope = deriveBucketId(
      {
        provider: "anthropic",
        credentialFingerprint: projection.projectionId,
        scope: projection.bucketScope,
      },
      key,
    );
    const withExplicitUnknownScope = deriveBucketId(
      {
        provider: "anthropic",
        credentialFingerprint: projection.projectionId,
        scope: {
          account: undefined,
          project: undefined,
          rateLimitGroup: undefined,
        },
      },
      key,
    );
    expect(withoutScope).toBe(withExplicitUnknownScope);
  });

  test("a projection MAY carry a populated bucketScope (type accepts it) and it changes the derived bucket", async () => {
    const { deriveBucketId } = await import("../../src/execution/bucket-id");
    const key = Buffer.from("d".repeat(64), "hex");
    const base = await project();
    const scoped: typeof base = { ...base, bucketScope: { account: "acct-9" } };
    const bucketWithoutScope = deriveBucketId(
      {
        provider: "anthropic",
        credentialFingerprint: base.projectionId,
        scope: base.bucketScope,
      },
      key,
    );
    const bucketWithScope = deriveBucketId(
      {
        provider: "anthropic",
        credentialFingerprint: scoped.projectionId,
        scope: scoped.bucketScope,
      },
      key,
    );
    expect(bucketWithScope).not.toBe(bucketWithoutScope);
  });
});
