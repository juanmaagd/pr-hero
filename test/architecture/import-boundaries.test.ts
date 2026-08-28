// D1-08 PR5a (§9.2 module boundaries): §1 gives the harness concurrency and
// spend; transports get neither. Structural enforcement is
// `ProviderTransport.execute`'s narrow `{ signal, events }` context
// (contracts.ts) — this test is the DRIFT GUARD: an rg-style scan proving
// no transport file imports the three admission/spend modules, so a future
// edit that reaches for "just import the limiter here" fails loud instead
// of silently reopening the boundary. Same pattern as the m6 floor-table
// drift guard (src/floor-test.ts).
//
// Transports MAY import usage-normalized (they must, to populate leaves)
// and bucket-id (already true as of PR3, for capabilities()'s optional
// rateLimitBucketId population) — the ban is scoped to exactly the three
// admission/spend modules.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const TRANSPORTS_DIR = path.join(import.meta.dir, "../../src/transports");
const BANNED_MODULES = ["spend-limiter", "concurrency-limiter", "admission"];
const ALLOWED_MODULES = ["usage-normalized", "bucket-id"];

function transportFiles(): string[] {
  return readdirSync(TRANSPORTS_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join(TRANSPORTS_DIR, name));
}

function importedModuleSpecifiers(src: string): string[] {
  const specifiers: string[] = [];
  const importRe = /from\s+["']([^"']+)["']/g;
  for (const match of src.matchAll(importRe)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  const dynamicImportRe = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of src.matchAll(dynamicImportRe)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

describe("import boundaries: transports never import admission/spend modules", () => {
  test("no transport file imports spend-limiter, concurrency-limiter, or admission", () => {
    const files = transportFiles();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const specifiers = importedModuleSpecifiers(src);
      for (const banned of BANNED_MODULES) {
        const hit = specifiers.find((specifier) =>
          specifier.endsWith(`/${banned}`),
        );
        expect(
          hit,
          `${path.basename(file)} imports banned module "${banned}" via "${hit}"`,
        ).toBeUndefined();
      }
    }
  });

  // Sanity: the scan targets specific modules, not the whole execution/
  // directory — a ban that also (accidentally) caught usage-normalized or
  // bucket-id would break real, required imports and this test would never
  // have caught it because the assertion above only checks for ABSENCE.
  test("usage-normalized and bucket-id imports remain allowed and present", () => {
    const files = transportFiles();
    for (const allowed of ALLOWED_MODULES) {
      const anyFileImportsIt = files.some((file) => {
        const src = readFileSync(file, "utf8");
        return importedModuleSpecifiers(src).some((specifier) =>
          specifier.endsWith(`/${allowed}`),
        );
      });
      expect(anyFileImportsIt).toBe(true);
    }
  });
});
