import { describe, expect, test } from "bun:test";
import path from "node:path";
import { prheroLayout } from "../src/home-preflight";
import {
  detectInstallMethod,
  detectShadowInstalls,
  isCheckCacheFresh,
  PRHERO_GITHUB_REPO,
  planUpgrade,
  readUpgradeCache,
  reconcileUpgrade,
  type UpgradeCheckCache,
  writeUpgradeCache,
} from "../src/updater";

describe("updater (lifecycle foundations)", () => {
  const home = "/home/user";
  const layout = prheroLayout(home);
  const standaloneBin = path.join(home, ".prhero", "bin", "pr-hero");

  test("1.4 Canonical repo constant is pinned to juanmaagd/pr-hero", () => {
    expect(PRHERO_GITHUB_REPO).toBe("juanmaagd/pr-hero");
  });

  describe("1.1 Install method detection and shadow-installs", () => {
    test("detects standalone binary when execPath is in ~/.prhero/bin", () => {
      const method = detectInstallMethod({
        execPath: standaloneBin,
        home,
        version: "1.0.0",
      });
      expect(method.kind).toBe("standalone");
      if (method.kind === "standalone") {
        expect(method.binaryPath).toBe(standaloneBin);
      }
    });

    test("detects source checkout when version is dev or running from source repo", () => {
      const method = detectInstallMethod({
        execPath: "/usr/local/bin/bun",
        home,
        version: "dev",
        isDev: true,
      });
      expect(method.kind).toBe("source");
    });

    test("detects npm/bun global installation otherwise", () => {
      const method = detectInstallMethod({
        execPath: "/usr/local/bin/node",
        home,
        version: "1.0.0",
        isDev: false,
      });
      expect(method.kind).toBe("package_manager");
      if (method.kind === "package_manager") {
        expect(method.manager).toBe("npm");
      }
    });

    test("detects shadow installs without mutating them", async () => {
      const shadows = await detectShadowInstalls({
        currentBinary: standaloneBin,
        which: async (bin) => {
          if (bin === "pr-hero")
            return ["/usr/local/bin/pr-hero", standaloneBin];
          return [];
        },
      });
      expect(shadows).toContain("/usr/local/bin/pr-hero");
      expect(shadows).not.toContain(standaloneBin);
    });
  });

  describe("1.1 & 1.2 Upgrade planning, sibling temp, and .bak lifecycle", () => {
    test("source checkout yields informative no-op plan", async () => {
      const plan = await planUpgrade({
        installMethod: { kind: "source" },
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
        home,
      });
      expect(plan.action).toBe("noop_source");
      expect(plan.steps).toHaveLength(0);
      expect(plan.message).toContain("source checkout");
    });

    test("standalone binary plans download to sibling temp, sha256 check, and .bak rename", async () => {
      const plan = await planUpgrade({
        installMethod: { kind: "standalone", binaryPath: standaloneBin },
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
        home,
        platform: "darwin",
        arch: "arm64",
      });

      expect(plan.action).toBe("upgrade_standalone");
      expect(plan.targetBinary).toBe(standaloneBin);
      expect(plan.tempBinary).toMatch(/\.tmp\.[a-z0-9]+$/);
      expect(path.dirname(plan.tempBinary || "")).toBe(
        path.dirname(standaloneBin),
      );
      expect(plan.bakBinary).toBe(`${standaloneBin}.bak`);
      expect(plan.downloadUrl).toContain("v1.1.0/pr-hero-darwin-arm64");
      expect(plan.checksumsUrl).toContain("v1.1.0/SHA256SUMS");
    });

    test("already up-to-date standalone plan yields up_to_date action", async () => {
      const plan = await planUpgrade({
        installMethod: { kind: "standalone", binaryPath: standaloneBin },
        currentVersion: "1.1.0",
        targetVersion: "1.1.0",
        home,
      });
      expect(plan.action).toBe("up_to_date");
    });
  });

  describe("1.3 Upgrade check cache and TTL", () => {
    test("reads and writes upgrade cache to upgradeCheckPath", () => {
      const cache: UpgradeCheckCache = {
        checked_at: "2026-08-24T12:00:00.000Z",
        current_version: "1.0.0",
        latest_version: "1.1.0",
        reconciled_version: "1.0.0",
        release_url: "https://github.com/juanmaagd/pr-hero/releases/tag/v1.1.0",
      };

      const storage: Record<string, string> = {};
      writeUpgradeCache(layout.upgradeCheckPath, cache, {
        writeFile: (p, content) => {
          storage[p] = content;
        },
      });

      const read = readUpgradeCache(layout.upgradeCheckPath, {
        readFile: (p) => storage[p],
      });

      expect(read).toEqual(cache);
    });

    test("isCheckCacheFresh enforces 24h TTL", () => {
      const now = new Date("2026-08-24T12:00:00.000Z").getTime();
      const fresh = {
        checked_at: new Date(now - 12 * 3600 * 1000).toISOString(),
        current_version: "1.0.0",
        latest_version: "1.1.0",
      };
      const stale = {
        checked_at: new Date(now - 25 * 3600 * 1000).toISOString(),
        current_version: "1.0.0",
        latest_version: "1.1.0",
      };

      expect(isCheckCacheFresh(fresh, now)).toBe(true);
      expect(isCheckCacheFresh(stale, now)).toBe(false);
      expect(isCheckCacheFresh(undefined, now)).toBe(false);
    });
  });

  describe("1.5 Reconcile step execution", () => {
    test("reconcileUpgrade runs skills sync, MCP verification, migrations, and doctor check", async () => {
      let skillsSynced = false;
      let mcpVerified = false;
      let storeMigrated = false;
      let daemonsReloaded = false;

      const result = await reconcileUpgrade({
        home,
        syncSkills: async () => {
          skillsSynced = true;
          return { synced: ["SKILL.md"], errors: [] };
        },
        verifyMcp: async () => {
          mcpVerified = true;
          return { ok: true };
        },
        migrateStore: async () => {
          storeMigrated = true;
          return { ok: true, version: 3 };
        },
        reloadDaemons: async () => {
          daemonsReloaded = true;
          return { reloaded: ["watch"] };
        },
        runDoctorCheck: async () => ({ overall: "healthy" }),
      });

      expect(result.ok).toBe(true);
      expect(skillsSynced).toBe(true);
      expect(mcpVerified).toBe(true);
      expect(storeMigrated).toBe(true);
      expect(daemonsReloaded).toBe(true);
    });
  });
});
