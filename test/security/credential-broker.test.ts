import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLAUDE_CREDENTIALS_KEYCHAIN_SERVICE,
  CredentialProjectionError,
  KeychainCredentialBroker,
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
