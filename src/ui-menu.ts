import type { MenuItem, RepoContext } from "./menu-context";
import { bold, box, cyan, dim, sanitizeText } from "./ui";

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
  return [cyan(bold("PR-HERO — Multi-Agent PR Review", styles), styles)];
}

export function renderContextBox(
  context: RepoContext,
  width: number,
  styles: boolean,
): string[] {
  const lines: string[] = [];

  if (context.kind === "configured-repo") {
    lines.push(
      `Repository:  ${context.name} (${context.root})`,
      `Base branch: ${context.defaultBase ?? "auto"}`,
    );
  } else if (context.kind === "unconfigured-repo") {
    lines.push(
      `Unconfigured Repository: ${context.name} (${context.root})`,
      "Run 'Initialize repo' to scaffold .prhero/ configuration.",
    );
  } else {
    lines.push(
      `Not inside a repository (${context.cwd})`,
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
