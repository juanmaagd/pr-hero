import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyExecutableAuthority } from "../../src/provider-capabilities";

describe("realistic script launcher compatibility", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "pr-hero-launcher-"));
    tempDir = await realpath(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test("approved launcher executes from its realpath and keeps sibling relative imports working", async () => {
    const launcherPath = path.join(tempDir, "launcher");
    const helperPath = path.join(tempDir, "helper.sh");

    await writeFile(
      launcherPath,
      '#!/bin/sh\ndir="$(cd "$(dirname "$0")" && pwd)"\nexec "$dir/helper.sh"\n',
    );
    await writeFile(helperPath, "#!/bin/sh\necho HELPER_OUTPUT\n");
    await chmod(launcherPath, 0o755);
    await chmod(helperPath, 0o755);

    const canonicalLauncher = await realpath(launcherPath);
    const bytes = new Uint8Array(await Bun.file(canonicalLauncher).bytes());
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const sha256 = hasher.digest("hex");

    const result = await verifyExecutableAuthority({
      candidatePath: canonicalLauncher,
      allowlist: [{ absolutePath: canonicalLauncher, sha256 }],
      snapshotDir: path.join(tempDir, "snaps"),
    });

    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.executable.kind).toBe("script-launcher");
    expect(result.executable.verifiedExecutionPath).toBe(canonicalLauncher);

    // A snapshot copy would break the dirname("$0") resolution above; running
    // the real launcher proves execution from its own location still works.
    const proc = Bun.spawn([result.executable.verifiedExecutionPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(output).toContain("HELPER_OUTPUT");
  });
});
