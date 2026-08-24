import { type CliOptions, DEFAULT_HOP_BUDGET } from "./preflight";
import { bold, box, cyan, dim, sanitizeText } from "./ui";
import { type KeyReader, parseKey, splitKeys } from "./ui-select";

export interface ReviewMenuState {
  target: "branch" | "pr";
  head: string;
  base: string;
  pr?: number | "current";
  post: boolean;
  scout: boolean;
  force: boolean;
  full: boolean;
  dryRun: boolean;
}

export interface ReviewMenuIo {
  write: (text: string) => void;
  line: (text?: string) => void;
}

export function renderReviewMenuCard(
  state: ReviewMenuState,
  cursor: number,
  width: number,
  styles: boolean,
): string[] {
  const targetLabel =
    state.target === "branch"
      ? "Local Branch"
      : state.pr
        ? `PR #${state.pr}`
        : "Current PR";
  const items = [
    `Target: ${targetLabel}`,
    `Base: ${state.base} · Head: ${state.head}`,
    "Start Review",
    `Post to PR: ${state.post ? "Yes" : "No"}`,
    `Scout stage: ${state.scout ? "Enabled" : "Disabled"}`,
    `Force review: ${state.force ? "Yes" : "No"}`,
    `Full verification: ${state.full ? "Yes" : "No"}`,
    `Dry run: ${state.dryRun ? "Yes" : "No"}`,
  ];

  const lines = items.map((item, idx) => {
    const isSelected = idx === cursor;
    const prefix = isSelected ? "▸ " : "  ";
    const line = sanitizeText(`${prefix}${item}`);
    return isSelected ? bold(cyan(line, styles), styles) : line;
  });

  return box("Review PR Configuration", lines, {
    width,
    styles,
    borderStyle: "double",
  });
}

export type ReviewMenuOutcome =
  | { action: "launch"; options: CliOptions }
  | { action: "back" };

export async function runReviewMenu(
  deps: {
    createReader?: () => KeyReader;
    io?: ReviewMenuIo;
    styles?: boolean;
    width?: number;
    defaultBase?: string;
  } = {},
): Promise<ReviewMenuOutcome> {
  const state: ReviewMenuState = {
    target: "branch",
    head: "HEAD",
    base: deps.defaultBase ?? "main",
    post: false,
    scout: false,
    force: false,
    full: false,
    dryRun: false,
  };

  const io = deps.io ?? {
    write: (t) => process.stderr.write(t),
    line: (t = "") => process.stderr.write(`${t}\n`),
  };
  const styles = deps.styles ?? false;
  const width = deps.width ?? 80;

  const createReader =
    deps.createReader ??
    (() => {
      const stdin = process.stdin;
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
    });

  let cursor = 0;
  const itemCount = 8;

  const render = () => {
    io.line();
    for (const l of renderReviewMenuCard(state, cursor, width, styles)) {
      io.line(l);
    }
    io.line(
      dim("j/k: move • space/enter: toggle / start • q/esc: back", styles),
    );
  };

  const reader = createReader();
  try {
    render();
    for (;;) {
      const chunk = await reader.read();
      if (chunk === undefined) return { action: "back" };

      for (const raw of splitKeys(chunk)) {
        const key = parseKey(raw);
        if (
          key.type === "escape" ||
          key.type === "ctrl-c" ||
          (key.type === "char" && key.char === "q")
        ) {
          return { action: "back" };
        }
        if (key.type === "up" || (key.type === "char" && key.char === "k")) {
          cursor = (cursor - 1 + itemCount) % itemCount;
          render();
          continue;
        }
        if (key.type === "down" || (key.type === "char" && key.char === "j")) {
          cursor = (cursor + 1) % itemCount;
          render();
          continue;
        }
        if (key.type === "enter" || (key.type === "char" && key.char === " ")) {
          if (cursor === 2) {
            // Start Review
            const options: CliOptions = {
              repo: ".",
              head: state.head,
              base: state.base,
              pr: state.target === "pr" ? (state.pr ?? "current") : undefined,
              post: state.post,
              scout: state.scout,
              force: state.force,
              full: state.full,
              dryRun: state.dryRun,
              hopBudget: DEFAULT_HOP_BUDGET,
              yes: false,
              twoDot: false,
              onPush: false,
              all: false,
              fixes: false,
              incidents: false,
              issues: false,
              proximity: false,
              threads: false,
            };
            return { action: "launch", options };
          }
          if (cursor === 0) {
            state.target = state.target === "branch" ? "pr" : "branch";
            if (state.target === "branch") state.post = false;
          } else if (cursor === 3 && state.target === "pr") {
            state.post = !state.post;
          } else if (cursor === 4) {
            state.scout = !state.scout;
          } else if (cursor === 5) {
            state.force = !state.force;
          } else if (cursor === 6) {
            state.full = !state.full;
          } else if (cursor === 7) {
            state.dryRun = !state.dryRun;
          }
          render();
        }
      }
    }
  } finally {
    reader.close();
  }
}
