import crypto from "node:crypto";
import { chmodSync, existsSync, renameSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, type CliOptions } from "#review/preflight";
import { log } from "#ui/primitives";
import { engineIdentity } from "../assets";
import { prheroLayout } from "../home-preflight";
import {
  detectInstallMethod,
  PRHERO_GITHUB_REPO,
  planUpgrade,
  readUpgradeCache,
  reconcileUpgrade,
  writeUpgradeCache,
} from "../updater";

export async function upgradeCommand(options: CliOptions): Promise<number> {
  const home = os.homedir();
  const layout = prheroLayout(home);
  const identity = await engineIdentity();
  const currentVersion = identity.version;

  if (options.reconcile) {
    log("Reconciling agent skills, MCP registrations, and product database...");
    const res = await reconcileUpgrade({ home });
    if (!res.ok) {
      log(
        `warning: reconciliation encountered issues: ${res.errors.join("; ")}`,
      );
      return 1;
    }
    const cache = readUpgradeCache(layout.upgradeCheckPath);
    if (cache) {
      writeUpgradeCache(layout.upgradeCheckPath, {
        ...cache,
        reconciled_version: currentVersion,
      });
    }
    log(
      "✓ Reconciliation complete (skills synced, MCP verified, store ready).",
    );
    return 0;
  }

  const method = detectInstallMethod({
    home,
    execPath: process.execPath,
    version: currentVersion,
  });

  // Query latest release
  let latestVersion = currentVersion;
  let releaseUrl = `https://github.com/${PRHERO_GITHUB_REPO}/releases/latest`;
  let changelog = "";

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${PRHERO_GITHUB_REPO}/releases/latest`,
      {
        headers: { "User-Agent": "pr-hero-cli" },
      },
    );
    if (resp.ok) {
      const data = (await resp.json()) as {
        tag_name?: string;
        html_url?: string;
        body?: string;
      };
      if (data.tag_name) {
        latestVersion = data.tag_name.replace(/^v/, "");
      }
      if (data.html_url) releaseUrl = data.html_url;
      if (data.body) changelog = data.body;

      writeUpgradeCache(layout.upgradeCheckPath, {
        checked_at: new Date().toISOString(),
        current_version: currentVersion,
        latest_version: latestVersion,
        reconciled_version: currentVersion,
        release_url: releaseUrl,
        changelog,
      });
    }
  } catch {
    // Network failure fallback to cache
    const cache = readUpgradeCache(layout.upgradeCheckPath);
    if (cache?.latest_version) {
      latestVersion = cache.latest_version;
    }
  }

  if (options.check) {
    log(`pr-hero version: v${currentVersion}`);
    log(`latest release:  v${latestVersion} (${releaseUrl})`);
    if (currentVersion === latestVersion) {
      log("✓ pr-hero is up to date.");
    } else {
      log(`Update available! Run 'pr-hero upgrade' to update.`);
    }
    return 0;
  }

  const plan = await planUpgrade({
    installMethod: method,
    currentVersion,
    targetVersion: latestVersion,
    home,
  });

  if (plan.action === "noop_source") {
    log(`info: ${plan.message}`);
    log("Running asset reconciliation to keep skills & MCP in sync...");
    await reconcileUpgrade({ home });
    log("✓ Synced skills & MCP registrations.");
    return 0;
  }

  if (plan.action === "up_to_date") {
    log(`✓ pr-hero is already up to date (v${currentVersion}).`);
    log("Running asset reconciliation to keep skills & MCP in sync...");
    await reconcileUpgrade({ home });
    log("✓ Synced skills & MCP registrations.");
    return 0;
  }

  if (options.dryRun) {
    log("Planned upgrade steps (--dry-run):");
    for (const step of plan.steps) {
      log(`  • ${step}`);
    }
    return 0;
  }

  if (plan.action === "upgrade_package_manager") {
    log("pr-hero is installed via global package manager.");
    log(
      `Please run: ${method.kind === "package_manager" ? method.manager : "npm"} install -g pr-hero@latest`,
    );
    return 0;
  }

  if (plan.action === "upgrade_standalone") {
    const downloadUrl = plan.downloadUrl;
    const checksumsUrl = plan.checksumsUrl;
    const tempBinary = plan.tempBinary;
    const targetBinary = plan.targetBinary;
    const bakBinary = plan.bakBinary;

    if (
      !downloadUrl ||
      !checksumsUrl ||
      !tempBinary ||
      !targetBinary ||
      !bakBinary
    ) {
      throw new CliError("Incomplete standalone upgrade plan.");
    }

    log(`Downloading ${downloadUrl}...`);
    const binResp = await fetch(downloadUrl);
    if (!binResp.ok) {
      throw new CliError(
        `Failed to download pr-hero binary from ${downloadUrl}`,
      );
    }
    const binBuffer = await binResp.arrayBuffer();

    log("Verifying SHA256 checksums...");
    const sumsResp = await fetch(checksumsUrl);
    if (!sumsResp.ok) {
      throw new CliError(`Failed to download SHA256SUMS from ${checksumsUrl}`);
    }
    const sumsText = await sumsResp.text();

    const actualHash = crypto
      .createHash("sha256")
      .update(Buffer.from(binBuffer))
      .digest("hex");
    const targetFileName = path.basename(downloadUrl);
    const expectedLine = sumsText
      .split("\n")
      .find((l) => l.includes(targetFileName));
    if (!expectedLine?.startsWith(actualHash)) {
      throw new CliError(
        `SHA256 checksum verification failed for ${targetFileName}!`,
      );
    }

    await Bun.write(tempBinary, binBuffer);
    chmodSync(tempBinary, 0o755);

    if (!existsSync(targetBinary) && existsSync(bakBinary)) {
      renameSync(bakBinary, targetBinary);
    } else if (existsSync(bakBinary)) {
      try {
        unlinkSync(bakBinary);
      } catch {
        // ignore
      }
    }

    if (existsSync(targetBinary)) {
      renameSync(targetBinary, bakBinary);
    }
    renameSync(tempBinary, targetBinary);

    // Smoke test that the upgraded binary can execute before removing backup
    let smokeOk = false;
    try {
      const smokeProc = Bun.spawn([targetBinary, "--help"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const smokeExit = await smokeProc.exited;
      smokeOk = smokeExit === 0;
    } catch {
      smokeOk = false;
    }

    if (!smokeOk) {
      log(
        "warning: upgraded binary failed to execute. Restoring previous version...",
      );
      if (existsSync(bakBinary)) {
        renameSync(bakBinary, targetBinary);
      }
      throw new CliError(
        "Upgrade failed during binary validation and was rolled back.",
      );
    }

    if (existsSync(bakBinary)) {
      unlinkSync(bakBinary);
    }

    log("Running reconciliation via upgraded binary...");
    let exitCode = 0;
    try {
      const proc = Bun.spawn([targetBinary, "upgrade", "--reconcile"], {
        stdout: "inherit",
        stderr: "inherit",
      });
      exitCode = await proc.exited;
    } catch {
      exitCode = 1;
    }

    if (exitCode !== 0) {
      log(
        "warning: reconciliation reported errors. Run 'pr-hero upgrade --reconcile' to retry.",
      );
      return exitCode;
    }

    log(`✓ Successfully upgraded pr-hero to v${latestVersion}!`);
    return 0;
  }

  return 0;
}
