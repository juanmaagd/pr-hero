import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../src/preflight";
import {
  renderConfigEditCard,
  renderConfigLayerSelection,
  setConfigValue,
  unsetConfigValue,
} from "../src/ui-config-edit";

describe("6.1 & 6.2 & 6.3 Interactive Config Editor & Headless Set/Unset", () => {
  const tmpDir = path.join(
    os.tmpdir(),
    `prhero-config-test-${Math.random().toString(36).slice(2)}`,
  );
  const home = path.join(tmpDir, "home");
  const repo = path.join(tmpDir, "repo");

  mkdirSync(path.join(home, ".prhero"), { recursive: true });
  mkdirSync(path.join(repo, ".prhero"), { recursive: true });

  test("renderers produce zero ANSI bytes with styles off", () => {
    const layerLines = renderConfigLayerSelection(
      ["Person", "Team", "Watch"],
      0,
      80,
      false,
    );
    expect(layerLines.join("\n")).not.toContain("\x1b[");

    const editLines = renderConfigEditCard(
      "Person Configuration",
      [{ key: "summary.enabled", value: "true", desc: "Enable AI summary" }],
      0,
      80,
      false,
    );
    expect(editLines.join("\n")).not.toContain("\x1b[");
  });

  test("setConfigValue for Person layer updates ~/.prhero/config.json with 2-space indentation", async () => {
    const personConfigPath = path.join(home, ".prhero", "config.json");
    writeFileSync(personConfigPath, "{}\n");

    const res = await setConfigValue({
      layer: "person",
      key: "max_verification_steps",
      value: "4",
      home,
    });

    expect(res.status).toBe("ok");
    const content = JSON.parse(readFileSync(personConfigPath, "utf-8"));
    expect(content.max_verification_steps).toBe(4);
  });

  test("setConfigValue for Team layer accepts and annotates over-ceiling capped values", async () => {
    const personConfigPath = path.join(home, ".prhero", "config.json");
    const repoConfigPath = path.join(repo, ".prhero", "config.json");
    writeFileSync(
      personConfigPath,
      JSON.stringify({ max_verification_steps: 3 }, null, 2),
    );
    writeFileSync(repoConfigPath, "{}\n");

    const res = await setConfigValue({
      layer: "team",
      key: "max_verification_steps",
      value: "5",
      home,
      repoRoot: repo,
    });

    expect(res.status).toBe("ok");
    expect(res.annotation).toBeDefined();
    expect(res.annotation).toContain("effective value remains 3");

    const content = JSON.parse(readFileSync(repoConfigPath, "utf-8"));
    expect(content.max_verification_steps).toBe(5);
  });

  test("setConfigValue for Team layer fails when repoRoot is missing", async () => {
    expect(
      setConfigValue({
        layer: "team",
        key: "default_base",
        value: "develop",
        home,
      }),
    ).rejects.toThrow(
      "cannot edit team configuration outside a git repository",
    );
  });

  test("setConfigValue for Watcher layer parses window 'HH:MM-HH:MM' and daily_cap", async () => {
    const watchConfigPath = path.join(home, ".prhero", "watch.json");
    writeFileSync(watchConfigPath, "{}\n");

    await setConfigValue({
      layer: "watch",
      key: "daily_cap",
      value: "10",
      home,
    });
    await setConfigValue({
      layer: "watch",
      key: "window",
      value: "09:00-18:00",
      home,
    });

    const content = JSON.parse(readFileSync(watchConfigPath, "utf-8"));
    expect(content.daily_cap).toBe(10);
    expect(content.window).toEqual({ start: "09:00", end: "18:00" });
  });

  test("unsetConfigValue removes key with 2-space indentation write-back", async () => {
    const watchConfigPath = path.join(home, ".prhero", "watch.json");
    writeFileSync(
      watchConfigPath,
      JSON.stringify(
        { daily_cap: 10, window: { start: "09:00", end: "18:00" } },
        null,
        2,
      ),
    );

    await unsetConfigValue({
      layer: "watch",
      key: "window",
      home,
    });

    const content = JSON.parse(readFileSync(watchConfigPath, "utf-8"));
    expect(content.window).toBeUndefined();
    expect(content.daily_cap).toBe(10);
  });

  test("parseArgs parses config set and unset with flags", () => {
    const parsedSet = parseArgs([
      "config",
      "set",
      "summary.model",
      "claude-3-opus",
      "--person",
    ]);
    expect(parsedSet.command).toBe("config");
    expect(parsedSet.options.configSubcommand).toBe("set");
    expect(parsedSet.options.configKey).toBe("summary.model");
    expect(parsedSet.options.configValue).toBe("claude-3-opus");
    expect(parsedSet.options.configLayer).toBe("person");

    const parsedUnset = parseArgs(["config", "unset", "window", "--watch"]);
    expect(parsedUnset.command).toBe("config");
    expect(parsedUnset.options.configSubcommand).toBe("unset");
    expect(parsedUnset.options.configKey).toBe("window");
    expect(parsedUnset.options.configLayer).toBe("watch");
  });
});
