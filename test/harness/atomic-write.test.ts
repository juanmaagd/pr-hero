import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeJsonAtomically } from "../../src/execution/atomic-write";

async function scratchDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pr-hero-atomic-"));
}

describe("writeJsonAtomically", () => {
  test("creates the missing parent directories of the target path", async () => {
    const dir = await scratchDir();
    const outPath = path.join(dir, "steps", "nested", "artifact.json");
    await writeJsonAtomically(outPath, { ok: true });
    expect(await Bun.file(outPath).text()).toBe('{\n  "ok": true\n}\n');
  });

  test("writes exactly JSON.stringify(value, null, 2) plus a trailing newline", async () => {
    const dir = await scratchDir();
    const outPath = path.join(dir, "artifact.json");
    const value = { pr: 1539, steps: [{ name: "hunter-reliability" }] };
    await writeJsonAtomically(outPath, value);
    expect(await Bun.file(outPath).text()).toBe(
      `${JSON.stringify(value, null, 2)}\n`,
    );
  });

  test("leaves no .tmp file behind", async () => {
    const dir = await scratchDir();
    await writeJsonAtomically(path.join(dir, "artifact.json"), { ok: true });
    expect(await readdir(dir)).toEqual(["artifact.json"]);
  });

  // The tmp+rename guarantee, stated as the failure it prevents: a shorter
  // second payload written in place over a longer first one leaves the tail of
  // the old bytes behind, and a reader parses garbage. rename() swaps the whole
  // file or nothing.
  test("overwriting an existing file replaces it wholly", async () => {
    const dir = await scratchDir();
    const outPath = path.join(dir, "artifact.json");
    await writeJsonAtomically(outPath, {
      padding: "x".repeat(4096),
      steps: [1, 2, 3, 4, 5, 6, 7, 8],
    });
    const shorter = { steps: [] };
    await writeJsonAtomically(outPath, shorter);
    expect(await Bun.file(outPath).text()).toBe(
      `${JSON.stringify(shorter, null, 2)}\n`,
    );
    expect(await readdir(dir)).toEqual(["artifact.json"]);
  });
});
