// The live progress panel's pure half: panel state, its transitions under
// the pipeline's event stream, and frame-text assembly. Everything here is
// testable offline; cli.ts owns the I/O half — TTY detection, the tick, and
// the ANSI cursor positioning that redraws the frame in place.
//
// Deliberately NO percentage bar anywhere: step durations are unknowable up
// front, and a fake number invites exactly the Ctrl-C this slice exists to
// cure. The honest signals are a spinner, elapsed time, and per-step
// completions.
//
// The panel is a TREE (ui-tree.ts), not a list of lines, for one reason: the
// refuter runs ONE STEP PER FINDING and those verdicts used to be a counter
// that overwrote itself (`judging F001 (1 of 2)…`), so a run's most expensive
// leg reported a number instead of its results. As leaves they ACCUMULATE and
// can be watched landing. The second level is deliberately not models:
// spec.agents assigns exactly one model per agent, so a model level would
// give every node exactly one child — a list with extra glyphs.

import type { PipelineProgressEvent } from "./pipeline";
import { formatElapsed } from "./report";
import { renderTree, type TreeNode } from "./ui-tree";

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

type PanelHunterStatus = "waiting" | "running" | "done" | "failed";

interface PanelHunter {
  key: string;
  status: PanelHunterStatus;
  durationMs?: number;
  // Resolved model, when the pipeline named it (hunters-started carries the
  // map). Absent is normal, not an error: only the pipeline knows what
  // resolveModel decided, and the panel may render a frame before it says.
  model?: string;
  drafts?: number;
}

// One refuter leaf: a finding submitted to the gate. Every leaf is running
// from the moment the leg starts — the fan-out is parallel, so there is no
// queue to be pending in.
interface PanelRefuterLeaf {
  id: string;
  location?: string;
  status: "running" | "done";
  verdict?: string;
}

export interface PanelState {
  // What the header says is under review: "PR #1682", or "dev..HEAD".
  subject: string;
  startedAtMs: number;
  // Whether the spec wires a refuter at all ("at most one" is spec-legal, and
  // a header promising one that never runs is a lie about the plan).
  hasRefuter: boolean;
  // Stamped by the hunters-started event so running rows show the fan-out's
  // own elapsed, not the panel's.
  huntersStartedAtMs?: number;
  hunters: PanelHunter[];
  dedupe?: { drafts: number; findings: number };
  refuter?: {
    total: number;
    judged: number;
    done: boolean;
    findings: PanelRefuterLeaf[];
  };
}

// Rows are seeded "waiting" from the keys the caller already resolved, so
// the panel has its full shape from the first frame; the hunters-started
// event is authoritative and reconciles the set (a key it names that the
// seed missed is added, never dropped).
export function createPanelState(
  subject: string,
  startedAtMs: number,
  hunterKeys: string[],
  opts: { refuter?: boolean } = {},
): PanelState {
  return {
    subject,
    startedAtMs,
    hasRefuter: opts.refuter ?? true,
    hunters: hunterKeys.map((key) => ({ key, status: "waiting" as const })),
  };
}

export function applyProgressEvent(
  state: PanelState,
  event: PipelineProgressEvent,
  nowMs: number,
): void {
  switch (event.kind) {
    case "hunters-started": {
      state.huntersStartedAtMs = nowMs;
      for (const key of event.hunters) {
        const row = state.hunters.find((h) => h.key === key);
        const model = event.models?.[key];
        if (row) {
          row.status = "running";
          if (model !== undefined) row.model = model;
        } else {
          state.hunters.push({
            key,
            status: "running",
            ...(model === undefined ? {} : { model }),
          });
        }
      }
      return;
    }
    case "hunter-finished": {
      const row = state.hunters.find((h) => h.key === event.hunter);
      if (!row) return;
      row.status = event.ok ? "done" : "failed";
      row.durationMs = event.durationMs;
      if (event.drafts !== undefined) row.drafts = event.drafts;
      return;
    }
    case "dedupe-finished":
      state.dedupe = { drafts: event.drafts, findings: event.findings };
      return;
    case "refuter-started":
      // The submitted ids, when the pipeline named them, become the leaves up
      // front: the leg's whole shape is then visible from its first frame
      // instead of growing out of nothing. Without them the leaves appear as
      // they settle, which is the same information one step later.
      state.refuter = {
        total: event.severeFindings,
        judged: 0,
        done: false,
        findings: (event.findings ?? []).map((f) => ({
          id: f.id,
          ...(f.location === undefined ? {} : { location: f.location }),
          status: "running" as const,
        })),
      };
      return;
    case "refuter-step-finished": {
      if (!state.refuter) return;
      state.refuter.judged += 1;
      const leaf = state.refuter.findings.find((f) => f.id === event.findingId);
      if (leaf) {
        leaf.status = "done";
        leaf.verdict = event.verdict;
      } else {
        state.refuter.findings.push({
          id: event.findingId,
          status: "done",
          verdict: event.verdict,
        });
      }
      // No explicit refuter-done event exists: the leg is done when every
      // submitted finding has settled.
      if (state.refuter.judged >= state.refuter.total) {
        state.refuter.done = true;
      }
      return;
    }
  }
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

// Sub-columns are aligned by padding here, in the caller, exactly as
// ui-tree.ts's `detail` contract asks: the tree owns nesting, not layout.
function hunterNode(
  hunter: PanelHunter,
  state: PanelState,
  nowMs: number,
  labelWidth: number,
  modelWidth: number,
): TreeNode {
  const label = pad(hunter.key, labelWidth);
  const model = modelWidth === 0 ? "" : pad(hunter.model ?? "", modelWidth);
  const parts: string[] = [];
  if (model.length > 0) parts.push(model);
  switch (hunter.status) {
    case "waiting":
      parts.push("waiting");
      return { label, status: "pending", detail: parts.join("   ") };
    case "running":
      parts.push(
        formatElapsed(nowMs - (state.huntersStartedAtMs ?? state.startedAtMs)),
      );
      return { label, status: "running", detail: parts.join("   ") };
    case "done":
      parts.push(formatElapsed(hunter.durationMs ?? 0));
      if (hunter.drafts !== undefined) {
        parts.push(`${hunter.drafts} draft${hunter.drafts === 1 ? "" : "s"}`);
      }
      return { label, status: "done", detail: parts.join("   ") };
    case "failed":
      // A dead hunter is a partial run, never an abort — the row says so
      // rather than leaving the operator to guess from a red mark.
      parts.push("failed — the run continues");
      return { label, status: "failed", detail: parts.join("   ") };
  }
}

function refuterNode(
  refuter: NonNullable<PanelState["refuter"]>,
  labelWidth: number,
): TreeNode {
  const idWidth = Math.max(
    ...refuter.findings.map((f) => f.id.length),
    "F000".length,
  );
  const children: TreeNode[] = refuter.findings.map((leaf) => {
    const detail = [
      leaf.location === undefined ? "" : leaf.location,
      leaf.verdict === undefined ? "" : leaf.verdict,
    ]
      .filter((part) => part.length > 0)
      .join("   ");
    return {
      label: pad(leaf.id, idWidth),
      status: leaf.status === "done" ? ("done" as const) : ("running" as const),
      ...(detail.length === 0 ? {} : { detail }),
    };
  });
  return {
    label: pad("refuter", labelWidth),
    status: refuter.done ? "done" : "running",
    detail: refuter.done
      ? `${refuter.total} judged`
      : `judging ${refuter.judged} of ${refuter.total}`,
    children,
  };
}

// One frame of the panel as plain lines — no cursor movement, no clearing;
// the shell owns positioning. `frame` indexes SPINNER_FRAMES (the shell's
// tick advances it). `maxLines` bounds the WHOLE panel, header included,
// because the shell's redraw arithmetic is against the count returned here.
export function renderPanelLines(
  state: PanelState,
  nowMs: number,
  frame: number,
  colors: boolean,
  maxLines?: number,
): string[] {
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "";
  const count = state.hunters.length;
  const header =
    `${spinner} reviewing ${state.subject} · ` +
    `${count} hunter${count === 1 ? "" : "s"}` +
    `${state.hasRefuter ? " + refuter" : ""} — ` +
    formatElapsed(nowMs - state.startedAtMs);
  if (maxLines !== undefined && maxLines <= 1) return [header];
  const labelWidth = Math.max(
    ...state.hunters.map((h) => h.key.length),
    "dedupe".length,
    "refuter".length,
  );
  const modelWidth = Math.max(
    0,
    ...state.hunters.map((h) => h.model?.length ?? 0),
  );
  const nodes: TreeNode[] = state.hunters.map((hunter) =>
    hunterNode(hunter, state, nowMs, labelWidth, modelWidth),
  );
  if (state.dedupe) {
    nodes.push({
      label: pad("dedupe", labelWidth),
      status: "done",
      detail:
        `${state.dedupe.drafts} draft${state.dedupe.drafts === 1 ? "" : "s"}` +
        ` → ${state.dedupe.findings} ` +
        `finding${state.dedupe.findings === 1 ? "" : "s"}`,
    });
  }
  if (state.refuter) nodes.push(refuterNode(state.refuter, labelWidth));
  return [
    header,
    ...renderTree(nodes, {
      styles: colors,
      frame: spinner,
      ...(maxLines === undefined ? {} : { maxLines: maxLines - 1 }),
    }),
  ];
}
