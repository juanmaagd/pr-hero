import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listActiveRuns } from "./activity";
import { runDoctor } from "./doctor";
import {
  getMenuOptions,
  type MenuItem,
  type MenuStatusInfo,
  type RepoContext,
  resolveMenuContext,
} from "./menu-context";
import { bold, box, cyan, dim, sanitizeText, terminalWidth } from "./ui";
import { type KeyReader, parseKey, splitKeys } from "./ui-select";

const SOLID_BANNER_LINES = [
  "██████╗ ██████╗       ██╗  ██╗███████╗██████╗  ██████╗ ",
  "██╔══██╗██╔══██╗      ██║  ██║██╔════╝██╔══██╗██╔═══██╗",
  "██████╔╝██████╔╝█████╗███████║█████╗  ██████╔╝██║   ██║",
  "██╔═══╝ ██╔══██╗╚════╝██╔══██║██╔══╝  ██╔══██╗██║   ██║",
  "██║     ██║  ██║      ██║  ██║███████╗██║  ██║╚██████╔╝",
  "╚═╝     ╚═╝  ╚═╝      ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ",
];

export function renderSolidHeader(width: number, styles: boolean): string[] {
  if (width >= 60) {
    return SOLID_BANNER_LINES.map((line) => cyan(bold(line, styles), styles));
  }
  const title = "PR-HERO — Multi-Agent PR Review";
  const truncated =
    width < title.length ? title.slice(0, Math.max(0, width)) : title;
  return [cyan(bold(truncated, styles), styles)];
}

export function renderContextBox(
  context: RepoContext,
  width: number,
  styles: boolean,
): string[] {
  const lines: string[] = [];

  if (context.kind === "configured-repo") {
    const name = sanitizeText(context.name);
    const root = sanitizeText(context.root);
    const base = context.defaultBase
      ? sanitizeText(context.defaultBase)
      : "auto";
    lines.push(`Repository:  ${name} (${root})`, `Base branch: ${base}`);
  } else if (context.kind === "unconfigured-repo") {
    const name = sanitizeText(context.name);
    const root = sanitizeText(context.root);
    lines.push(
      `Unconfigured Repository: ${name} (${root})`,
      "Run 'Initialize repo' to scaffold .prhero/ configuration.",
    );
  } else {
    const cwd = sanitizeText(context.cwd);
    lines.push(
      `Not inside a repository (${cwd})`,
      "Global commands and configuration are available.",
    );
  }

  return box("Current Context", lines, {
    width,
    styles,
    borderStyle: "double",
  });
}

export function renderMenuCard(
  items: MenuItem[],
  selectedIndex: number,
  width: number,
  styles: boolean,
): string[] {
  const lines: string[] = [];

  items.forEach((item, index) => {
    const isSelected = index === selectedIndex;
    const prefix = isSelected ? "▸ " : "  ";
    const num = `${index + 1}. `;
    const badge = item.badge ? ` (${item.badge})` : "";
    const submenu = item.isSubmenu ? " →" : "";

    const rawLine = `${prefix}${num}${item.label}${badge}${submenu} - ${item.desc}`;
    lines.push(sanitizeText(rawLine));
  });

  return box("Main Menu", lines, {
    width,
    styles,
    borderStyle: "double",
  });
}

export function renderPersistentFooter(
  selectedItem: MenuItem | undefined,
  _width: number,
  styles: boolean,
): string[] {
  const enterAction = selectedItem?.isSubmenu ? "open submenu" : "run";
  const hints = `j/k: move • 1-9: select • enter: ${enterAction} • q: quit`;

  const lines = [dim(hints, styles)];

  if (selectedItem) {
    lines.push(dim(`$ pr-hero ${selectedItem.cliHint}`, styles));
  }

  return lines;
}

export async function gatherMenuStatus(
  home: string = os.homedir(),
  cwd: string = process.cwd(),
): Promise<MenuStatusInfo> {
  let upgradeAvailable = false;
  try {
    const upgradeCache = path.join(home, ".prhero", "upgrade-check.json");
    if (existsSync(upgradeCache)) {
      const parsed = JSON.parse(readFileSync(upgradeCache, "utf-8"));
      upgradeAvailable = Boolean(
        parsed.latestVersion && parsed.updateAvailable,
      );
    }
  } catch {
    // Ignore
  }

  let activeReviewsCount = 0;
  try {
    const active = await listActiveRuns({ home });
    activeReviewsCount = active.length;
  } catch {
    // Ignore
  }

  let doctorStatus: MenuStatusInfo["doctorStatus"];
  try {
    const report = await runDoctor({ home, cwd });
    doctorStatus = report.overall;
  } catch {
    // Ignore
  }

  return {
    upgradeAvailable,
    activeReviewsCount,
    doctorStatus,
  };
}

export interface MenuLoopIo {
  write: (text: string) => void;
  line: (text?: string) => void;
}

export interface MenuLoopOptions {
  context?: RepoContext;
  status?: MenuStatusInfo;
  createReader?: () => KeyReader;
  io?: MenuLoopIo;
  styles?: boolean;
  width?: number;
  home?: string;
  cwd?: string;
  dispatchAction?: (
    action: string,
    item?: MenuItem,
  ) => Promise<number | "back">;
}

export function createDefaultStdinReader(): KeyReader {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return {
      raw: false,
      read: async () => undefined,
      close: () => {},
    };
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  const pending: string[] = [];
  let deliver: ((chunk: string) => void) | undefined;
  const onData = (chunk: string): void => {
    if (deliver === undefined) {
      pending.push(chunk);
      return;
    }
    const resolve = deliver;
    deliver = undefined;
    resolve(chunk);
  };
  stdin.on("data", onData);
  return {
    raw: true,
    read: () => {
      const queued = pending.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise<string>((resolve) => {
        deliver = resolve;
      });
    },
    close: () => {
      stdin.off("data", onData);
      stdin.pause();
      try {
        stdin.setRawMode(false);
      } catch {
        // Ignore
      }
    },
  };
}

export async function runMenuLoop(
  options: MenuLoopOptions = {},
): Promise<number> {
  const home = options.home ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const io = options.io ?? {
    write: (t) => process.stderr.write(t),
    line: (t = "") => process.stderr.write(`${t}\n`),
  };
  const styles = options.styles ?? false;
  let width = options.width ?? terminalWidth();

  let context = options.context ?? (await resolveMenuContext(cwd));
  let status = options.status ?? (await gatherMenuStatus(home, cwd));
  let items = getMenuOptions(context, status);
  let cursor = 0;

  const createReader = options.createReader ?? createDefaultStdinReader;

  let isInteractive = true;
  const onResize = () => {
    if (!isInteractive) return;
    width = terminalWidth();
    render();
  };
  process.on("SIGWINCH", onResize);

  const render = () => {
    io.line();
    for (const line of renderSolidHeader(width, styles)) {
      io.line(line);
    }
    io.line();
    for (const line of renderContextBox(context, width, styles)) {
      io.line(line);
    }
    io.line();
    for (const line of renderMenuCard(items, cursor, width, styles)) {
      io.line(line);
    }
    io.line();
    for (const line of renderPersistentFooter(items[cursor], width, styles)) {
      io.line(line);
    }
  };

  try {
    for (;;) {
      render();
      const reader = createReader();
      let chosenItem: MenuItem | undefined;

      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk === undefined) {
            return 0;
          }

          let shouldBreakInner = false;
          for (const rawKey of splitKeys(chunk)) {
            const key = parseKey(rawKey);
            if (
              key.type === "escape" ||
              (key.type === "char" && key.char === "q")
            ) {
              return 0;
            }
            if (key.type === "ctrl-c") {
              return 130;
            }
            if (
              key.type === "up" ||
              (key.type === "char" && key.char === "k")
            ) {
              cursor = (cursor - 1 + items.length) % items.length;
              render();
              continue;
            }
            if (
              key.type === "down" ||
              (key.type === "char" && key.char === "j")
            ) {
              cursor = (cursor + 1) % items.length;
              render();
              continue;
            }
            if (key.type === "char" && /^[1-9]$/.test(key.char)) {
              const numIdx = Number(key.char) - 1;
              if (numIdx >= 0 && numIdx < items.length) {
                cursor = numIdx;
                render();
              }
              continue;
            }
            if (key.type === "enter") {
              chosenItem = items[cursor];
              shouldBreakInner = true;
              break;
            }
          }

          if (shouldBreakInner) break;
        }
      } finally {
        reader.close();
      }

      if (!chosenItem) continue;
      if (chosenItem.id === "quit") return 0;

      // Dispatch action
      if (options.dispatchAction) {
        isInteractive = false;
        let exit: number | "back";
        try {
          exit = await options.dispatchAction(chosenItem.id, chosenItem);
        } finally {
          isInteractive = true;
        }
        if (exit === "back") {
          context = await resolveMenuContext(cwd);
          status = await gatherMenuStatus(home, cwd);
          items = getMenuOptions(context, status);
          cursor = Math.min(cursor, items.length - 1);
          continue;
        }
        if (
          typeof exit === "number" &&
          (chosenItem.id === "review" || chosenItem.id === "lifecycle")
        ) {
          return exit;
        }
      } else {
        io.line(`\n[Action: ${chosenItem.label}]`);
      }

      // Pause before returning to menu
      io.line();
      io.line(dim("Press any key to return to menu...", styles));
      const pauseReader = createReader();
      try {
        await pauseReader.read();
      } finally {
        pauseReader.close();
      }

      // Refresh context and status on return
      context = await resolveMenuContext(cwd);
      status = await gatherMenuStatus(home, cwd);
      items = getMenuOptions(context, status);
      cursor = Math.min(cursor, items.length - 1);
    }
  } finally {
    process.off("SIGWINCH", onResize);
  }
}

export async function runLifecycleSubmenu(deps: {
  createReader?: () => KeyReader;
  io?: MenuLoopIo;
  styles?: boolean;
  width?: number;
  dispatch?: (cmd: string) => Promise<number>;
}): Promise<number | "back"> {
  const io = deps.io ?? {
    write: (t) => process.stderr.write(t),
    line: (t = "") => process.stderr.write(`${t}\n`),
  };
  const styles = deps.styles ?? false;
  const width = deps.width ?? 80;
  const createReader = deps.createReader ?? createDefaultStdinReader;

  const items = [
    {
      id: "upgrade",
      label: "Upgrade & sync",
      desc: "Upgrade pr-hero and reconcile skills",
      isTerminal: true,
    },
    {
      id: "setup",
      label: "Sync skills & MCP",
      desc: "Reconcile installed skills and MCP registrations",
      isTerminal: false,
    },
    {
      id: "uninstall",
      label: "Managed uninstall",
      desc: "Remove daemon, skills and registrations",
      isTerminal: true,
    },
    {
      id: "back",
      label: "Back",
      desc: "Return to main menu",
      isTerminal: false,
    },
  ];

  let cursor = 0;
  const render = () => {
    io.line();
    const lines = items.map((item, idx) => {
      const prefix = idx === cursor ? "▸ " : "  ";
      return `${prefix}${idx + 1}. ${item.label} - ${item.desc}`;
    });
    for (const l of box("Lifecycle & Maintenance", lines, {
      width,
      styles,
      borderStyle: "double",
    })) {
      io.line(l);
    }
    io.line(dim("j/k: move • enter: select • q/esc: back", styles));
  };

  for (;;) {
    render();
    const reader = createReader();
    let chosen: (typeof items)[0] | undefined;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk === undefined) return "back";
        let done = false;
        for (const raw of splitKeys(chunk)) {
          const key = parseKey(raw);
          if (
            key.type === "escape" ||
            key.type === "ctrl-c" ||
            (key.type === "char" && key.char === "q")
          ) {
            return "back";
          }
          if (key.type === "up" || (key.type === "char" && key.char === "k")) {
            cursor = (cursor - 1 + items.length) % items.length;
            render();
            continue;
          }
          if (
            key.type === "down" ||
            (key.type === "char" && key.char === "j")
          ) {
            cursor = (cursor + 1) % items.length;
            render();
            continue;
          }
          if (key.type === "char" && /^[1-4]$/.test(key.char)) {
            cursor = Number(key.char) - 1;
            render();
            continue;
          }
          if (key.type === "enter") {
            chosen = items[cursor];
            done = true;
            break;
          }
        }
        if (done) break;
      }
    } finally {
      reader.close();
    }

    if (!chosen || chosen.id === "back") return "back";
    if (deps.dispatch) {
      const code = await deps.dispatch(chosen.id);
      if (chosen.isTerminal) return code;
    }
  }
}

export async function runWatcherSubmenu(deps: {
  createReader?: () => KeyReader;
  io?: MenuLoopIo;
  styles?: boolean;
  width?: number;
  inRepo?: boolean;
  dispatch?: (subcommand: string) => Promise<number>;
}): Promise<number | "back"> {
  const io = deps.io ?? {
    write: (t) => process.stderr.write(t),
    line: (t = "") => process.stderr.write(`${t}\n`),
  };
  const styles = deps.styles ?? false;
  const width = deps.width ?? 80;
  const inRepo = deps.inRepo ?? false;
  const createReader = deps.createReader ?? createDefaultStdinReader;

  const items = [
    {
      id: "status",
      label: "Watcher status",
      desc: "View watcher daemon status and enrolled repos",
    },
    {
      id: "install",
      label: "Install launchd daemon",
      desc: "Enable background background daemon",
    },
    {
      id: "uninstall",
      label: "Uninstall launchd daemon",
      desc: "Disable background daemon",
    },
    ...(inRepo
      ? [
          {
            id: "add",
            label: "Add current repo to watcher",
            desc: "Enroll this repository in background watcher",
          },
          {
            id: "add-on-push",
            label: "Add repo with on-push re-reviews",
            desc: "Enroll repository and trigger review on each push",
          },
        ]
      : []),
    {
      id: "remove",
      label: "Remove repo from watcher",
      desc: "Unenroll a repository",
    },
    { id: "back", label: "Back", desc: "Return to main menu" },
  ];

  let cursor = 0;
  const render = () => {
    io.line();
    const lines = items.map((item, idx) => {
      const prefix = idx === cursor ? "▸ " : "  ";
      return `${prefix}${idx + 1}. ${item.label} - ${item.desc}`;
    });
    for (const l of box("Watcher Daemon Submenu", lines, {
      width,
      styles,
      borderStyle: "double",
    })) {
      io.line(l);
    }
    io.line(dim("j/k: move • enter: select • q/esc: back", styles));
  };

  for (;;) {
    render();
    const reader = createReader();
    let chosen: (typeof items)[0] | undefined;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk === undefined) return "back";
        let done = false;
        for (const raw of splitKeys(chunk)) {
          const key = parseKey(raw);
          if (
            key.type === "escape" ||
            key.type === "ctrl-c" ||
            (key.type === "char" && key.char === "q")
          ) {
            return "back";
          }
          if (key.type === "up" || (key.type === "char" && key.char === "k")) {
            cursor = (cursor - 1 + items.length) % items.length;
            render();
            continue;
          }
          if (
            key.type === "down" ||
            (key.type === "char" && key.char === "j")
          ) {
            cursor = (cursor + 1) % items.length;
            render();
            continue;
          }
          if (key.type === "char" && /^[1-9]$/.test(key.char)) {
            const idx = Number(key.char) - 1;
            if (idx >= 0 && idx < items.length) {
              cursor = idx;
              render();
            }
            continue;
          }
          if (key.type === "enter") {
            chosen = items[cursor];
            done = true;
            break;
          }
        }
        if (done) break;
      }
    } finally {
      reader.close();
    }

    if (!chosen || chosen.id === "back") return "back";
    if (deps.dispatch) {
      await deps.dispatch(chosen.id);
    }
  }
}
