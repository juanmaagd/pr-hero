// Domain reorg T2 (odd/tasks/domain-reorg.md): the layout ratchet. Structural
// drift here is invisible to `bun test` and `tsc --noEmit` — a file placed
// back at `src/` root, or dropped into a domain directory with the wrong
// name, still compiles and passes every behavioral test (the task doc's
// demonstrated gap: a flat file mixing `child_process`, raw I/O, and a god
// function passes all 3647 tests and typecheck; biome flags only a style
// nit). This is an rg-style filesystem scan, not a behavioral test — it
// polices WHERE files live, not what they do. Same pattern as the transports
// drift guard in `import-boundaries.test.ts`.
//
// Each entry in MIGRATED_DOMAINS is one already-migrated domain. Later
// domain moves (ui, ci, store, model, ...) append one entry here — the two
// assertions below (absence at src/ root, exact presence in the domain dir)
// are generic over the list, so a new domain never needs new test logic.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";

const SRC_DIR = path.join(import.meta.dir, "../../src");

interface MigratedDomain {
  domain: string;
  // Basenames without the .ts extension, as they live in src/<domain>/.
  files: string[];
}

const MIGRATED_DOMAINS: MigratedDomain[] = [
  {
    domain: "rereview",
    files: ["classify", "identity", "plan", "prepare", "state", "verify"],
  },
];

function srcRootFiles(): string[] {
  return readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name);
}

function domainDirFiles(domain: string): string[] {
  return readdirSync(path.join(SRC_DIR, domain))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.replace(/\.ts$/, ""))
    .sort();
}

describe("layout ratchet: migrated domains stay out of src/ root", () => {
  test("no flat <domain>-*.ts file remains at src/ root", () => {
    const rootFiles = srcRootFiles();
    for (const { domain } of MIGRATED_DOMAINS) {
      const prefix = `${domain}-`;
      const stray = rootFiles.filter((name) => name.startsWith(prefix));
      expect(
        stray,
        `src/ root still has flat ${domain}-*.ts file(s): ${stray.join(", ")}`,
      ).toEqual([]);
    }
  });

  // Sanity: the absence check above only proves the specific `<domain>-`
  // prefix is gone from src/ root — it would pass vacuously forever if a
  // domain move silently failed (files never landed in src/<domain>/ at all,
  // or landed with the wrong names) because there would still be nothing at
  // root matching the prefix. This positive half proves the domain directory
  // actually holds exactly the migrated files, so the ratchet discriminates
  // instead of being trivially green.
  test("each migrated domain directory contains exactly its expected files", () => {
    for (const { domain, files } of MIGRATED_DOMAINS) {
      const actual = domainDirFiles(domain);
      const expected = [...files].sort();
      expect(actual, `src/${domain}/ contents`).toEqual(expected);
    }
  });
});
