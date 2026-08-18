// The prompt set's IDENTITY, and it exists for one claim: M6's write-up will
// say "both arms ran the same prompt set". Until M5 that was believed —
// findings.ts declared `prompt_set` and nothing ever populated it — and a
// believed claim is what an A/B is least able to survive being wrong about.
//
// The algorithm is the lab's, ported rather than re-invented
// (`../deep-review/runner/session.ts`): sha256 over the concatenated file
// TEXTS in the given order, truncated to 16 hex. Truncation length, hash and
// order are all load-bearing — changing any one silently moves every
// fingerprint recorded on either side of the boundary.

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promptSetFingerprint, promptSetIdentity } from "../src/prompt-set";

async function setDir(
  files: Record<string, string>,
  prefix = "pr-hero-set-",
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  for (const [name, body] of Object.entries(files)) {
    await Bun.write(path.join(dir, name), body);
  }
  return dir;
}

describe("promptSetFingerprint", () => {
  test("is stable for the same bytes and 16 hex chars wide", async () => {
    const dir = await setDir({ "a.md": "alpha", "b.md": "beta" });
    const files = [path.join(dir, "a.md"), path.join(dir, "b.md")];

    const first = await promptSetFingerprint(files);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(await promptSetFingerprint(files)).toBe(first);
  });

  test("ORDER is part of the identity, which is why the caller supplies it", async () => {
    // Same files, different order = different concatenation = different hash.
    // The caller passes the ReviewSpec's declaration order for exactly this
    // reason; a directory listing would make the fingerprint depend on the
    // filesystem.
    const dir = await setDir({ "a.md": "alpha", "b.md": "beta" });
    const a = path.join(dir, "a.md");
    const b = path.join(dir, "b.md");

    expect(await promptSetFingerprint([a, b])).not.toBe(
      await promptSetFingerprint([b, a]),
    );
  });

  test("one changed byte in one file moves it", async () => {
    const before = await setDir({ "a.md": "alpha", "b.md": "beta" });
    const after = await setDir({ "a.md": "alpha", "b.md": "betb" });

    expect(
      await promptSetFingerprint([
        path.join(before, "a.md"),
        path.join(before, "b.md"),
      ]),
    ).not.toBe(
      await promptSetFingerprint([
        path.join(after, "a.md"),
        path.join(after, "b.md"),
      ]),
    );
  });

  test("concatenation is unseparated, matching the lab's hasher exactly", async () => {
    // A separator would be a silent divergence: the same four agent files
    // would fingerprint differently here and there, and the two sides could
    // never be compared again. Pinned against a hand-computed digest.
    const dir = await setDir({ "a.md": "alpha", "b.md": "beta" });
    const expected = new Bun.CryptoHasher("sha256")
      .update("alphabeta")
      .digest("hex")
      .slice(0, 16);

    expect(
      await promptSetFingerprint([
        path.join(dir, "a.md"),
        path.join(dir, "b.md"),
      ]),
    ).toBe(expected);
  });
});

describe("promptSetIdentity", () => {
  test("names the directory and fingerprints the files", async () => {
    const dir = await setDir({ "a.md": "alpha" }, "baseline-");
    const identity = await promptSetIdentity(dir, [path.join(dir, "a.md")]);

    expect(identity.name).toBe(path.basename(dir));
    expect(identity.sha256).toBe(
      await promptSetFingerprint([path.join(dir, "a.md")]),
    );
  });

  test("a trailing slash does not become the name", async () => {
    // `agents/baseline/` and `agents/baseline` are the same set, and a ledger
    // that split them into two rows would be counting one arm twice.
    const dir = await setDir({ "a.md": "alpha" });
    const identity = await promptSetIdentity(`${dir}/`, [
      path.join(dir, "a.md"),
    ]);

    expect(identity.name).toBe(path.basename(dir));
  });
});
