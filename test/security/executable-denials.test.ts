import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ProviderTransport,
  StepAdmissionGate,
  TransportRequest,
} from "../../src/execution/contracts";
import { StepExecutionHarness } from "../../src/execution/harness";
import {
  type ExecutableAllowlistEntry,
  verifyExecutableAuthority,
} from "../../src/provider-capabilities";
import type { StepSpec } from "../../src/step-runner";

// Mach-O 64-bit little-endian magic: makes verifyExecutableAuthority treat
// the fixture as a binary so its bytes go through the snapshot path.
const MACHO_PREFIX = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

async function writeBinaryFixture(
  filePath: string,
  body: string,
): Promise<{ canonicalPath: string; sha256: string }> {
  const bytes = Buffer.concat([MACHO_PREFIX, Buffer.from(body)]);
  await writeFile(filePath, bytes);
  await chmod(filePath, 0o755);
  const canonicalPath = await realpath(filePath);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return { canonicalPath, sha256: hasher.digest("hex") };
}

describe("Executable authority & deceptive fixtures denials", () => {
  let tempDir: string;
  const fixturesDir = path.resolve(__dirname, "fixtures");

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "pr-hero-exec-test-"));
    tempDir = await realpath(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test("deceptive executable fixtures are all denied with executable_not_approved and zero admission/transport calls", async () => {
    const fixtureNames = [
      "requirements.txt",
      "CMakeLists.txt",
      "executable.md",
      "executable.mdx",
      "README.sh",
    ];

    for (const name of fixtureNames) {
      const src = path.join(fixturesDir, name);
      const dest = path.join(tempDir, name);
      await copyFile(src, dest);

      if (
        name.endsWith(".md") ||
        name.endsWith(".mdx") ||
        name.endsWith(".sh")
      ) {
        await chmod(dest, 0o755);
      }

      let admissionCount = 0;
      let transportCount = 0;

      const admissionGate: StepAdmissionGate = {
        admit: async () => {
          admissionCount++;
        },
      };

      const transport: ProviderTransport = {
        backend: "claude-code",
        capabilities: async () => ({
          backend: "claude-code",
          status: "ready",
          auth: {
            kind: "claude_subscription_oauth",
            projectionReady: true,
            probe: "passed",
          },
          isolation: {
            syntheticHome: true,
            workspaceReadBroker: true,
            codegraphPolicy: true,
          },
          protocol: {
            terminalProof: true,
            boundedEvents: true,
            usageMode: "snapshot",
          },
          cancellation: { deadlineMs: 7500, conformance: "passed" },
          billing: { mode: "subscription", pricingReady: true },
          issues: [],
        }),
        execute: async () => {
          transportCount++;
          return {
            completion: "success",
            protocolIntegrity: "verified",
            finalText: '{"findings":[]}',
            usage: {
              wall_ms: 10,
              tokens_in: 0,
              tokens_out: 0,
              tokens_total: 0,
              cost_usd_est: 0,
            },
            stderrTail: "",
          };
        },
        classifyFailure: () => undefined,
      };

      const configuredAllowlist: ExecutableAllowlistEntry[] = [
        {
          absolutePath: "/usr/local/bin/claude",
          sha256:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      ];

      const harness = new StepExecutionHarness({
        workspaceRoot: tempDir,
        executableAllowlist: configuredAllowlist,
        binaryPath: dest,
        admissionGate,
        transport,
      });

      const step: StepSpec = {
        name: `test-fixture-${name}`,
        systemPromptPath: path.join(tempDir, "system.md"),
        prompt: "Review diff",
        tools: ["Read"],
        mcpConfigPath: path.join(tempDir, "mcp.json"),
        model: "claude-sonnet-4-5",
        cwd: tempDir,
        outPath: path.join(tempDir, `out-${name}.json`),
        timeoutMs: 5000,
        maxAttempts: 2,
        parse: (text) => JSON.parse(text),
      };

      await writeFile(step.systemPromptPath, "prompt");
      await writeFile(step.mcpConfigPath, "{}");

      const result = await harness.run(step);

      expect(result.status).toBe("failed");
      expect(result.denialCode).toBe("executable_not_approved");
      expect(admissionCount).toBe(0);
      expect(transportCount).toBe(0);
    }
  });

  test("positive executable authority: absolute path + valid hash + permissions reaches transport and spawn", async () => {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const claudePath = path.join(binDir, "claude");

    const deterministicBytes = Buffer.from(
      '#!/bin/sh\necho \'{"result":"{\\"findings\\":[]}"}\'\n',
    );
    await writeFile(claudePath, deterministicBytes);
    await chmod(claudePath, 0o755);

    const canonicalPath = await realpath(claudePath);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(deterministicBytes);
    const expectedDigest = hasher.digest("hex");

    const allowlist: ExecutableAllowlistEntry[] = [
      {
        absolutePath: canonicalPath,
        sha256: expectedDigest,
      },
    ];

    let admissionCount = 0;
    let transportCount = 0;
    let executedBinary = "";

    const admissionGate: StepAdmissionGate = {
      admit: async () => {
        admissionCount++;
      },
    };

    const transport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => ({
        backend: "claude-code",
        status: "ready",
        auth: {
          kind: "claude_subscription_oauth",
          projectionReady: true,
          probe: "passed",
        },
        isolation: {
          syntheticHome: true,
          workspaceReadBroker: true,
          codegraphPolicy: true,
        },
        protocol: {
          terminalProof: true,
          boundedEvents: true,
          usageMode: "snapshot",
        },
        cancellation: { deadlineMs: 7500, conformance: "passed" },
        billing: { mode: "subscription", pricingReady: true },
        issues: [],
      }),
      execute: async (req: TransportRequest) => {
        transportCount++;
        executedBinary = req.isolation.verifiedBinaryPath;
        return {
          completion: "success",
          protocolIntegrity: "verified",
          finalText: '{"findings":[]}',
          usage: {
            wall_ms: 10,
            tokens_in: 0,
            tokens_out: 0,
            tokens_total: 0,
            cost_usd_est: 0,
          },
          stderrTail: "",
        };
      },
      classifyFailure: () => undefined,
    };

    const harness = new StepExecutionHarness({
      workspaceRoot: tempDir,
      executableAllowlist: allowlist,
      binaryPath: canonicalPath,
      admissionGate,
      transport,
    });

    const step: StepSpec = {
      name: "hunter-reliability",
      systemPromptPath: path.join(tempDir, "system.md"),
      prompt: "Review diff",
      tools: ["Read"],
      mcpConfigPath: path.join(tempDir, "mcp.json"),
      model: "claude-sonnet-4-5",
      cwd: tempDir,
      outPath: path.join(tempDir, "out.json"),
      timeoutMs: 5000,
      maxAttempts: 2,
      parse: (text) => JSON.parse(text),
    };

    await writeFile(step.systemPromptPath, "prompt");
    await writeFile(step.mcpConfigPath, "{}");

    const result = await harness.run(step);

    expect(result.status).toBe("ok");
    expect(admissionCount).toBe(1);
    expect(transportCount).toBe(1);
    expect(executedBinary).toBeDefined();
    expect(executedBinary.length).toBeGreaterThan(0);
  });

  test("adjacent denial: hash mismatch", async () => {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const claudePath = path.join(binDir, "claude");

    const deterministicBytes = Buffer.from('#!/bin/sh\necho "test"\n');
    await writeFile(claudePath, deterministicBytes);
    await chmod(claudePath, 0o755);

    const canonicalPath = await realpath(claudePath);
    const allowlist: ExecutableAllowlistEntry[] = [
      {
        absolutePath: canonicalPath,
        sha256:
          "0000000000000000000000000000000000000000000000000000000000000000",
      },
    ];

    const result = await verifyExecutableAuthority({
      candidatePath: canonicalPath,
      allowlist,
    });

    expect(result.approved).toBe(false);
    expect(result.code).toBe("executable_not_approved");
  });

  test("adjacent denial: missing executable permission", async () => {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const claudePath = path.join(binDir, "claude");

    const deterministicBytes = Buffer.from('#!/bin/sh\necho "test"\n');
    await writeFile(claudePath, deterministicBytes);
    await chmod(claudePath, 0o644); // NOT executable

    const canonicalPath = await realpath(claudePath);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(deterministicBytes);
    const expectedDigest = hasher.digest("hex");

    const allowlist: ExecutableAllowlistEntry[] = [
      {
        absolutePath: canonicalPath,
        sha256: expectedDigest,
      },
    ];

    const result = await verifyExecutableAuthority({
      candidatePath: canonicalPath,
      allowlist,
    });

    expect(result.approved).toBe(false);
    expect(result.code).toBe("executable_not_approved");
  });

  test("adjacent denial: relative executable candidate path", async () => {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const claudePath = path.join(binDir, "claude");

    const deterministicBytes = Buffer.from('#!/bin/sh\necho "test"\n');
    await writeFile(claudePath, deterministicBytes);
    await chmod(claudePath, 0o755);

    const allowlist: ExecutableAllowlistEntry[] = [
      {
        absolutePath: claudePath,
        sha256: "some-hash",
      },
    ];

    const result = await verifyExecutableAuthority({
      candidatePath: "./bin/claude",
      allowlist,
    });

    expect(result.approved).toBe(false);
    expect(result.code).toBe("executable_not_approved");
  });

  test("adjacent denial: relative allowlist entry path is rejected", async () => {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const claudePath = path.join(binDir, "claude");

    const deterministicBytes = Buffer.from('#!/bin/sh\necho "test"\n');
    await writeFile(claudePath, deterministicBytes);
    await chmod(claudePath, 0o755);

    const canonicalPath = await realpath(claudePath);

    const allowlist: ExecutableAllowlistEntry[] = [
      {
        absolutePath: "./bin/claude", // Relative entry in allowlist
        sha256: "some-hash",
      },
    ];

    const result = await verifyExecutableAuthority({
      candidatePath: canonicalPath,
      allowlist,
    });

    expect(result.approved).toBe(false);
    expect(result.code).toBe("executable_not_approved");
    expect(result.reason).toContain("relative");
  });

  test("adjacent denial: executable not present in configured allowlist", async () => {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const claudePath = path.join(binDir, "claude");

    const deterministicBytes = Buffer.from('#!/bin/sh\necho "test"\n');
    await writeFile(claudePath, deterministicBytes);
    await chmod(claudePath, 0o755);

    const canonicalPath = await realpath(claudePath);
    const allowlist: ExecutableAllowlistEntry[] = [
      {
        absolutePath: "/other/path/claude",
        sha256: "some-hash",
      },
    ];

    const result = await verifyExecutableAuthority({
      candidatePath: canonicalPath,
      allowlist,
    });

    expect(result.approved).toBe(false);
    expect(result.code).toBe("executable_not_approved");
  });

  test("TOCTOU protection: replacing executable after verification does not mutate executed bytes", async () => {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const claudePath = path.join(binDir, "claude");

    const { canonicalPath, sha256 } = await writeBinaryFixture(
      claudePath,
      'echo "ORIGINAL_VERIFIED_OUTPUT"\n',
    );

    const allowlist: ExecutableAllowlistEntry[] = [
      {
        absolutePath: canonicalPath,
        sha256,
      },
    ];

    // 1. Verify executable authority (creates verified execution snapshot bound to goodBytes)
    const verifyResult = await verifyExecutableAuthority({
      candidatePath: canonicalPath,
      allowlist,
    });

    expect(verifyResult.approved).toBe(true);
    if (!verifyResult.approved) return;
    expect(verifyResult.executable.kind).toBe("binary");

    // 2. Malicious actor replaces candidate binary on disk after verification
    await writeFile(
      canonicalPath,
      Buffer.from('echo "MALICIOUS_REPLACED_OUTPUT"\n'),
    );

    // 3. Inspect verified snapshot content: verified snapshot contains original goodBytes
    const snapshotBytes = await readFile(
      verifyResult.executable.verifiedExecutionPath,
    );
    expect(snapshotBytes.toString()).toContain("ORIGINAL_VERIFIED_OUTPUT");
    expect(snapshotBytes.toString()).not.toContain("MALICIOUS_REPLACED_OUTPUT");
  });

  test("pre-created symlink at the legacy predictable snapshot path can no longer redirect the write", async () => {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const claudePath = path.join(binDir, "claude");

    const { canonicalPath, sha256 } = await writeBinaryFixture(
      claudePath,
      'echo "hi"\n',
    );
    const digest = sha256;

    // The pre-hardening layout was <snapshotDir>/<digest16>/claude — an
    // attacker could predict it and plant a symlink there.
    const snapBase = path.join(tempDir, "snaps");
    const legacyDir = path.join(snapBase, digest.slice(0, 16));
    await mkdir(legacyDir, { recursive: true });
    const victimPath = path.join(tempDir, "victim.txt");
    await writeFile(victimPath, "VICTIM");
    await symlink(victimPath, path.join(legacyDir, "claude"));

    const result = await verifyExecutableAuthority({
      candidatePath: canonicalPath,
      allowlist: [{ absolutePath: canonicalPath, sha256: digest }],
      snapshotDir: snapBase,
    });

    expect(result.approved).toBe(true);
    if (!result.approved) return;

    // The write landed in a fresh unique dir; the symlink is untouched.
    expect(path.dirname(result.executable.verifiedExecutionPath)).not.toBe(
      legacyDir,
    );
    expect(await readFile(victimPath, "utf8")).toBe("VICTIM");
  });

  test("two sequential verifications produce different snapshot directories", async () => {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const claudePath = path.join(binDir, "claude");

    const { canonicalPath, sha256 } = await writeBinaryFixture(
      claudePath,
      'echo "hi"\n',
    );
    const allowlist: ExecutableAllowlistEntry[] = [
      { absolutePath: canonicalPath, sha256 },
    ];
    const snapBase = path.join(tempDir, "snaps-unique");

    const first = await verifyExecutableAuthority({
      candidatePath: canonicalPath,
      allowlist,
      snapshotDir: snapBase,
    });
    const second = await verifyExecutableAuthority({
      candidatePath: canonicalPath,
      allowlist,
      snapshotDir: snapBase,
    });

    expect(first.approved).toBe(true);
    expect(second.approved).toBe(true);
    if (first.approved && second.approved) {
      expect(first.executable.verifiedExecutionPath).not.toBe(
        second.executable.verifiedExecutionPath,
      );
    }
  });

  test("shebang launcher with sibling relative import is approved as script-launcher executing from its realpath", async () => {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const launcherPath = path.join(binDir, "launcher");

    const launcherBytes = Buffer.from(
      '#!/bin/sh\n. "$(dirname "$0")/dep.sh"\necho "$DEP_VALUE"\n',
    );
    await writeFile(launcherPath, launcherBytes);
    await chmod(launcherPath, 0o755);

    const canonicalPath = await realpath(launcherPath);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(launcherBytes);
    const sha256 = hasher.digest("hex");

    const result = await verifyExecutableAuthority({
      candidatePath: canonicalPath,
      allowlist: [{ absolutePath: canonicalPath, sha256 }],
      snapshotDir: path.join(tempDir, "snaps-script"),
    });

    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.executable.kind).toBe("script-launcher");
    expect(result.executable.verifiedExecutionPath).toBe(canonicalPath);
  });

  test("failure during snapshot creation denies and leaves no leftover directories", async () => {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const claudePath = path.join(binDir, "claude");

    const { canonicalPath, sha256 } = await writeBinaryFixture(
      claudePath,
      'echo "hi"\n',
    );
    const snapBase = path.join(tempDir, "snaps-fail");
    mkdirSync(snapBase, { mode: 0o700 });
    chmodSync(snapBase, 0o500); // leaf creation inside will fail

    try {
      const result = await verifyExecutableAuthority({
        candidatePath: canonicalPath,
        allowlist: [{ absolutePath: canonicalPath, sha256 }],
        snapshotDir: snapBase,
      });

      expect(result.approved).toBe(false);
      if (result.approved) return;
      expect(result.code).toBe("executable_not_approved");
    } finally {
      chmodSync(snapBase, 0o700);
    }

    const leftovers = await readdir(snapBase);
    expect(leftovers).toHaveLength(0);
  });
});
