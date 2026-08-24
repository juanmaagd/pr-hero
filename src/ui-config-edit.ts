import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeConfig, parseGlobalConfig, parseLocalConfig } from "./preflight";
import { bold, box, cyan, dim, sanitizeText } from "./ui";
import type { KeyReader } from "./ui-select";

export interface ConfigEntry {
  key: string;
  value: string;
  desc: string;
}

export function renderConfigLayerSelection(
  layers: string[],
  cursor: number,
  width: number,
  styles: boolean,
): string[] {
  const lines = layers.map((layer, idx) => {
    const isSelected = idx === cursor;
    const prefix = isSelected ? "▸ " : "  ";
    const line = sanitizeText(`${prefix}${idx + 1}. ${layer}`);
    return isSelected ? bold(cyan(line, styles), styles) : line;
  });

  return box("Select Configuration Layer", lines, {
    width,
    styles,
    borderStyle: "double",
  });
}

export function renderConfigEditCard(
  title: string,
  entries: ConfigEntry[],
  cursor: number,
  width: number,
  styles: boolean,
): string[] {
  const lines = entries.map((entry, idx) => {
    const isSelected = idx === cursor;
    const prefix = isSelected ? "▸ " : "  ";
    const rawLine = `${prefix}${entry.key}: ${entry.value} — ${entry.desc}`;
    const sanitized = sanitizeText(rawLine);
    return isSelected ? bold(cyan(sanitized, styles), styles) : sanitized;
  });

  return box(title, lines, {
    width,
    styles,
    borderStyle: "double",
  });
}

export async function setConfigValue(input: {
  layer: "person" | "team" | "watch";
  key: string;
  value: string;
  home?: string;
  repoRoot?: string;
}): Promise<{ status: "ok"; annotation?: string }> {
  const home = input.home ?? os.homedir();

  if (input.layer === "team") {
    if (!input.repoRoot) {
      throw new Error(
        "cannot edit team configuration outside a git repository",
      );
    }
    const repoConfigPath = path.join(input.repoRoot, ".prhero", "config.json");
    let currentRepo: Record<string, unknown> = {};
    if (existsSync(repoConfigPath)) {
      try {
        currentRepo = JSON.parse(readFileSync(repoConfigPath, "utf-8"));
      } catch {
        currentRepo = {};
      }
    }

    let parsedVal: unknown = input.value;
    if (input.key === "max_verification_steps") {
      const num = Number.parseInt(input.value, 10);
      if (Number.isNaN(num) || num < 0) {
        throw new Error(
          "max_verification_steps must be a non-negative integer",
        );
      }
      parsedVal = num;
      currentRepo.max_verification_steps = num;
    } else if (input.key === "summary.enabled") {
      const b = input.value.toLowerCase() === "true";
      currentRepo.summary = {
        ...(typeof currentRepo.summary === "object" &&
        currentRepo.summary !== null
          ? (currentRepo.summary as Record<string, unknown>)
          : {}),
        enabled: b,
      };
    } else if (input.key === "default_base") {
      currentRepo.default_base = input.value;
    } else {
      currentRepo[input.key] = input.value;
    }

    writeFileSync(repoConfigPath, `${JSON.stringify(currentRepo, null, 2)}\n`);

    // Check annotation from mergeConfig
    let annotation: string | undefined;
    const personConfigPath = path.join(home, ".prhero", "config.json");
    if (existsSync(personConfigPath)) {
      try {
        const globalLayer = parseGlobalConfig(
          readFileSync(personConfigPath, "utf-8"),
        );
        const repoLayer = parseLocalConfig(
          readFileSync(repoConfigPath, "utf-8"),
        );
        const merged = mergeConfig(globalLayer, repoLayer);
        if (
          input.key === "max_verification_steps" &&
          globalLayer.max_verification_steps !== undefined &&
          parsedVal !== merged.effective.max_verification_steps
        ) {
          annotation = `written: ${parsedVal} — your effective value remains ${merged.effective.max_verification_steps}, capped by your Person layer`;
        }
      } catch {
        // Ignore
      }
    }

    return { status: "ok", annotation };
  }

  if (input.layer === "person") {
    const personConfigPath = path.join(home, ".prhero", "config.json");
    let currentPerson: Record<string, unknown> = {};
    if (existsSync(personConfigPath)) {
      try {
        currentPerson = JSON.parse(readFileSync(personConfigPath, "utf-8"));
      } catch {
        currentPerson = {};
      }
    }

    if (input.key === "max_verification_steps") {
      const num = Number.parseInt(input.value, 10);
      if (Number.isNaN(num) || num < 0) {
        throw new Error(
          "max_verification_steps must be a non-negative integer",
        );
      }
      currentPerson.max_verification_steps = num;
    } else if (input.key === "summary.enabled") {
      const b = input.value.toLowerCase() === "true";
      currentPerson.summary = {
        ...(typeof currentPerson.summary === "object" &&
        currentPerson.summary !== null
          ? (currentPerson.summary as Record<string, unknown>)
          : {}),
        enabled: b,
      };
    } else if (input.key === "summary.model") {
      currentPerson.summary = {
        ...(typeof currentPerson.summary === "object" &&
        currentPerson.summary !== null
          ? (currentPerson.summary as Record<string, unknown>)
          : {}),
        model: input.value,
      };
    } else if (input.key === "agents_dir") {
      currentPerson.agents_dir = input.value;
    } else {
      currentPerson[input.key] = input.value;
    }

    writeFileSync(
      personConfigPath,
      `${JSON.stringify(currentPerson, null, 2)}\n`,
    );
    return { status: "ok" };
  }

  if (input.layer === "watch") {
    const watchConfigPath = path.join(home, ".prhero", "watch.json");
    let currentWatch: Record<string, unknown> = {};
    if (existsSync(watchConfigPath)) {
      try {
        currentWatch = JSON.parse(readFileSync(watchConfigPath, "utf-8"));
      } catch {
        currentWatch = {};
      }
    }

    if (input.key === "daily_cap") {
      const num = Number.parseInt(input.value, 10);
      if (Number.isNaN(num) || num <= 0) {
        throw new Error("daily_cap must be a positive integer");
      }
      currentWatch.daily_cap = num;
    } else if (input.key === "window") {
      const parts = input.value.split("-");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error("window must be in format 'HH:MM-HH:MM'");
      }
      currentWatch.window = { start: parts[0], end: parts[1] };
    } else {
      currentWatch[input.key] = input.value;
    }

    writeFileSync(
      watchConfigPath,
      `${JSON.stringify(currentWatch, null, 2)}\n`,
    );
    return { status: "ok" };
  }

  return { status: "ok" };
}

export async function unsetConfigValue(input: {
  layer: "person" | "team" | "watch";
  key: string;
  home?: string;
  repoRoot?: string;
}): Promise<{ status: "ok" }> {
  const home = input.home ?? os.homedir();

  if (input.layer === "team") {
    if (!input.repoRoot) {
      throw new Error(
        "cannot edit team configuration outside a git repository",
      );
    }
    const repoConfigPath = path.join(input.repoRoot, ".prhero", "config.json");
    if (existsSync(repoConfigPath)) {
      const current = JSON.parse(readFileSync(repoConfigPath, "utf-8"));
      delete current[input.key];
      writeFileSync(repoConfigPath, `${JSON.stringify(current, null, 2)}\n`);
    }
    return { status: "ok" };
  }

  if (input.layer === "person") {
    const personConfigPath = path.join(home, ".prhero", "config.json");
    if (existsSync(personConfigPath)) {
      const current = JSON.parse(readFileSync(personConfigPath, "utf-8"));
      delete current[input.key];
      writeFileSync(personConfigPath, `${JSON.stringify(current, null, 2)}\n`);
    }
    return { status: "ok" };
  }

  if (input.layer === "watch") {
    const watchConfigPath = path.join(home, ".prhero", "watch.json");
    if (existsSync(watchConfigPath)) {
      const current = JSON.parse(readFileSync(watchConfigPath, "utf-8"));
      delete current[input.key];
      writeFileSync(watchConfigPath, `${JSON.stringify(current, null, 2)}\n`);
    }
    return { status: "ok" };
  }

  return { status: "ok" };
}

export async function runConfigEditor(
  deps: {
    home?: string;
    repoRoot?: string;
    width?: number;
    styles?: boolean;
    createReader?: () => KeyReader;
    io?: { write: (t: string) => void; line: (t?: string) => void };
  } = {},
): Promise<number> {
  const styles = deps.styles ?? false;
  const io = deps.io ?? {
    write: (t) => process.stderr.write(t),
    line: (t = "") => process.stderr.write(`${t}\n`),
  };

  io.line();
  io.line(bold("Interactive Configuration Editor", styles));
  io.line(dim("Person layer: ~/.prhero/config.json", styles));
  if (deps.repoRoot) {
    io.line(
      dim(
        `Team layer: ${path.join(deps.repoRoot, ".prhero", "config.json")}`,
        styles,
      ),
    );
  } else {
    io.line(dim("Team layer: (disabled outside git repository)", styles));
  }
  io.line(dim("Watcher layer: ~/.prhero/watch.json", styles));
  io.line();
  io.line(
    "Use 'pr-hero config set <key> <value> [--person|--team|--watch]' to modify configuration.",
  );
  return 0;
}
