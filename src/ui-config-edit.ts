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

const TIME_WINDOW_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
      parsedVal = b;
      currentRepo.summary = {
        ...(typeof currentRepo.summary === "object" &&
        currentRepo.summary !== null
          ? (currentRepo.summary as Record<string, unknown>)
          : {}),
        enabled: b,
      };
    } else if (input.key === "summary.model") {
      if (typeof input.value !== "string" || input.value.trim().length === 0) {
        throw new Error("summary.model must be a non-empty string");
      }
      currentRepo.summary = {
        ...(typeof currentRepo.summary === "object" &&
        currentRepo.summary !== null
          ? (currentRepo.summary as Record<string, unknown>)
          : {}),
        model: input.value.trim(),
      };
    } else if (input.key === "default_base") {
      if (typeof input.value !== "string" || input.value.trim().length === 0) {
        throw new Error("default_base must be a non-empty string");
      }
      currentRepo.default_base = input.value.trim();
    } else if (input.key === "parity_trigger_paths") {
      let paths: string[];
      if (input.value.startsWith("[")) {
        try {
          paths = JSON.parse(input.value);
        } catch {
          throw new Error(
            "parity_trigger_paths must be an array of non-empty strings",
          );
        }
      } else {
        paths = input.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (
        !Array.isArray(paths) ||
        paths.length === 0 ||
        paths.some((p) => typeof p !== "string" || p.trim().length === 0)
      ) {
        throw new Error(
          "parity_trigger_paths must be an array of non-empty strings",
        );
      }
      currentRepo.parity_trigger_paths = paths;
    } else if (input.key === "agents_dir") {
      currentRepo.agents_dir = input.value.trim();
    } else {
      throw new Error(
        `unknown or unsupported key for team configuration: ${input.key}`,
      );
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
        } else if (
          input.key === "summary.enabled" &&
          globalLayer.summary?.enabled !== undefined &&
          merged.effective.summary?.enabled !== parsedVal
        ) {
          annotation = `written: ${parsedVal} — your effective value remains ${merged.effective.summary?.enabled}, capped by your Person layer`;
        }
      } catch {
        // Ignore
      }
    }

    return { status: "ok", annotation };
  }

  if (input.layer === "person") {
    if (
      input.key === "default_base" ||
      input.key === "parity_trigger_paths" ||
      input.key === "suspicion_priors"
    ) {
      throw new Error(
        `${input.key} is a per-repo key; use --team to configure it.`,
      );
    }

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
      if (typeof input.value !== "string" || input.value.trim().length === 0) {
        throw new Error("summary.model must be a non-empty string");
      }
      currentPerson.summary = {
        ...(typeof currentPerson.summary === "object" &&
        currentPerson.summary !== null
          ? (currentPerson.summary as Record<string, unknown>)
          : {}),
        model: input.value.trim(),
      };
    } else if (input.key === "agents_dir") {
      currentPerson.agents_dir = input.value.trim();
    } else {
      throw new Error(
        `unknown or unsupported key for person configuration: ${input.key}`,
      );
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
      if (
        parts.length !== 2 ||
        !parts[0] ||
        !parts[1] ||
        !TIME_WINDOW_RE.test(parts[0]) ||
        !TIME_WINDOW_RE.test(parts[1]) ||
        parts[0] === parts[1]
      ) {
        throw new Error(
          "window must be in format 'HH:MM-HH:MM' with valid 24h times where start != end",
        );
      }
      currentWatch.window = { start: parts[0], end: parts[1] };
    } else {
      throw new Error(
        `unknown or unsupported key for watch configuration: ${input.key}`,
      );
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

  const removeKey = (obj: Record<string, unknown>, key: string) => {
    if (key.startsWith("summary.")) {
      const sub = key.slice("summary.".length);
      if (obj.summary && typeof obj.summary === "object") {
        delete (obj.summary as Record<string, unknown>)[sub];
      }
    } else {
      delete obj[key];
    }
  };

  if (input.layer === "team") {
    if (!input.repoRoot) {
      throw new Error(
        "cannot edit team configuration outside a git repository",
      );
    }
    const repoConfigPath = path.join(input.repoRoot, ".prhero", "config.json");
    if (existsSync(repoConfigPath)) {
      const current = JSON.parse(readFileSync(repoConfigPath, "utf-8"));
      removeKey(current, input.key);
      writeFileSync(repoConfigPath, `${JSON.stringify(current, null, 2)}\n`);
    }
    return { status: "ok" };
  }

  if (input.layer === "person") {
    const personConfigPath = path.join(home, ".prhero", "config.json");
    if (existsSync(personConfigPath)) {
      const current = JSON.parse(readFileSync(personConfigPath, "utf-8"));
      removeKey(current, input.key);
      writeFileSync(personConfigPath, `${JSON.stringify(current, null, 2)}\n`);
    }
    return { status: "ok" };
  }

  if (input.layer === "watch") {
    const watchConfigPath = path.join(home, ".prhero", "watch.json");
    if (existsSync(watchConfigPath)) {
      const current = JSON.parse(readFileSync(watchConfigPath, "utf-8"));
      removeKey(current, input.key);
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
