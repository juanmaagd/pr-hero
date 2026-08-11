// The live progress panel's pure half: panel state, its transitions under
// the pipeline's event stream, and frame-text assembly. Everything here is
// testable offline; cli.ts owns the I/O half — TTY detection, the tick, and
// the ANSI cursor positioning that redraws the frame in place.
//
// Deliberately NO percentage bar anywhere: step durations are unknowable up
// front, and a fake number invites exactly the Ctrl-C this slice exists to
// cure. The honest signals are a spinner, elapsed time, and per-step
// completions.

import type { PipelineProgressEvent } from "./pipeline";
import { formatElapsed } from "./report";

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

export type PanelHunterStatus = "waiting" | "running" | "done" | "failed";

export interface PanelHunter {
  key: string;
  status: PanelHunterStatus;
  durationMs?: number;
}

export interface PanelState {
  // What the header says is under review: "PR #1682", or "dev..HEAD".
  subject: string;
  startedAtMs: number;
  // Stamped by the hunters-started event so running rows show the fan-out's
  // own elapsed, not the panel's.
  huntersStartedAtMs?: number;
  hunters: PanelHunter[];
  dedupe?: { drafts: number; findings: number };
  refuter?: {
    total: number;
    judged: number;
    lastFindingId?: string;
    done: boolean;
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
): PanelState {
  return {
    subject,
    startedAtMs,
    hunters: hunterKeys.map((key) => ({ key, status: "waiting" })),
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
        if (row) row.status = "running";
        else state.hunters.push({ key, status: "running" });
      }
      return;
    }
    case "hunter-finished": {
      const row = state.hunters.find((h) => h.key === event.hunter);
      if (!row) return;
      row.status = event.ok ? "done" : "failed";
      row.durationMs = event.durationMs;
      return;
    }
    case "dedupe-finished":
      state.dedupe = { drafts: event.drafts, findings: event.findings };
      return;
    case "refuter-started":
      state.refuter = { total: event.severeFindings, judged: 0, done: false };
      return;
    case "refuter-step-finished": {
      if (!state.refuter) return;
      state.refuter.judged += 1;
      state.refuter.lastFindingId = event.findingId;
      // No explicit refuter-done event exists: the leg is done when every
      // submitted finding has settled.
      if (state.refuter.judged >= state.refuter.total) {
        state.refuter.done = true;
      }
      return;
    }
  }
}

// NO_COLOR convention: color only when the caller decided the stream is a
// TTY AND the NO_COLOR env var is unset — that decision is the shell's; here
// it arrives as one boolean.
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function paint(text: string, code: string, colors: boolean): string {
  return colors ? `${code}${text}${RESET}` : text;
}

// One frame of the panel as plain lines — no cursor movement, no clearing;
// the shell owns positioning. `frame` indexes SPINNER_FRAMES (the shell's
// tick advances it).
export function renderPanelLines(
  state: PanelState,
  nowMs: number,
  frame: number,
  colors: boolean,
): string[] {
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const lines: string[] = [
    `${spinner} reviewing ${state.subject} — ` +
      formatElapsed(nowMs - state.startedAtMs),
  ];
  for (const hunter of state.hunters) {
    lines.push(hunterLine(hunter, state, nowMs, spinner, colors));
  }
  if (state.dedupe) {
    lines.push(
      `${paint("✓", GREEN, colors)} hunters done — ${state.dedupe.drafts} ` +
        `draft${state.dedupe.drafts === 1 ? "" : "s"} -> ` +
        `${state.dedupe.findings} finding` +
        `${state.dedupe.findings === 1 ? "" : "s"}`,
    );
  }
  if (state.refuter) {
    lines.push(refuterLine(state.refuter, spinner, colors));
  }
  return lines;
}

function hunterLine(
  hunter: PanelHunter,
  state: PanelState,
  nowMs: number,
  spinner: string,
  colors: boolean,
): string {
  switch (hunter.status) {
    case "waiting":
      return paint(`· ${hunter.key} waiting`, DIM, colors);
    case "running":
      return (
        `${spinner} ${hunter.key} running… ` +
        formatElapsed(nowMs - (state.huntersStartedAtMs ?? state.startedAtMs))
      );
    case "done":
      return (
        `${paint("✓", GREEN, colors)} ${hunter.key} done ` +
        formatElapsed(hunter.durationMs ?? 0)
      );
    case "failed":
      return `${paint("✗", RED, colors)} ${hunter.key} failed (the run continues)`;
  }
}

function refuterLine(
  refuter: NonNullable<PanelState["refuter"]>,
  spinner: string,
  colors: boolean,
): string {
  if (refuter.done) {
    return `${paint("✓", GREEN, colors)} refuter — ${refuter.total} judged`;
  }
  // Before the first step settles there is no finding id to name — the
  // events report settles, not starts — so the counter alone carries it.
  return refuter.lastFindingId === undefined
    ? `${spinner} refuter — judging (0 of ${refuter.total})…`
    : `${spinner} refuter — judging ${refuter.lastFindingId} ` +
        `(${refuter.judged} of ${refuter.total})…`;
}
