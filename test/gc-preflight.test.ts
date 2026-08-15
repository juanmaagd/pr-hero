import { describe, expect, test } from "bun:test";
import {
  decideGc,
  parseGhPrState,
  parseWorktreePr,
  worktreeRemoveArgs,
} from "../src/gc-preflight";
import { GC_TTL_HOURS } from "../src/home-preflight";

const NOW = Date.parse("2026-08-15T12:00:00Z");
const HOUR = 60 * 60 * 1000;

describe("decideGc", () => {
  test("open and fresh is kept", () => {
    expect(
      decideGc({
        prState: "open",
        lastReviewAtMs: NOW - 1 * HOUR,
        dirMtimeMs: NOW - 1 * HOUR,
        nowMs: NOW,
        inFlight: false,
      }),
    ).toEqual({ action: "keep", reason: "open and within TTL" });
  });

  test("open and idle 73h is collected", () => {
    const decision = decideGc({
      prState: "open",
      lastReviewAtMs: NOW - (GC_TTL_HOURS + 1) * HOUR,
      dirMtimeMs: NOW - (GC_TTL_HOURS + 1) * HOUR,
      nowMs: NOW,
      inFlight: false,
    });
    expect(decision.action).toBe("collect");
    expect(decision.reason).toContain("72h");
  });

  test("merged an hour ago is collected even though TTL would keep it", () => {
    expect(
      decideGc({
        prState: "merged",
        lastReviewAtMs: NOW - 1 * HOUR,
        dirMtimeMs: NOW - 1 * HOUR,
        nowMs: NOW,
        inFlight: false,
      }),
    ).toEqual({ action: "collect", reason: "PR is merged" });
  });

  test("closed is collected the same way as merged", () => {
    expect(
      decideGc({
        prState: "closed",
        lastReviewAtMs: NOW - 1 * HOUR,
        dirMtimeMs: NOW - 1 * HOUR,
        nowMs: NOW,
        inFlight: false,
      }).action,
    ).toBe("collect");
  });

  test("in-flight is kept even when merged", () => {
    expect(
      decideGc({
        prState: "merged",
        lastReviewAtMs: NOW - 100 * HOUR,
        dirMtimeMs: NOW - 100 * HOUR,
        nowMs: NOW,
        inFlight: true,
      }),
    ).toEqual({ action: "keep", reason: "in-flight (live lock)" });
  });

  test("unknown state (gh failed) still applies TTL", () => {
    expect(
      decideGc({
        prState: "unknown",
        lastReviewAtMs: NOW - 1 * HOUR,
        dirMtimeMs: NOW - 1 * HOUR,
        nowMs: NOW,
        inFlight: false,
      }).action,
    ).toBe("keep");
    expect(
      decideGc({
        prState: "unknown",
        lastReviewAtMs: NOW - 80 * HOUR,
        dirMtimeMs: NOW - 80 * HOUR,
        nowMs: NOW,
        inFlight: false,
      }).action,
    ).toBe("collect");
  });

  test("missing stamp falls back to mtime, then expires", () => {
    expect(
      decideGc({
        prState: "open",
        lastReviewAtMs: null,
        dirMtimeMs: NOW - 1 * HOUR,
        nowMs: NOW,
        inFlight: false,
      }).action,
    ).toBe("keep");
    expect(
      decideGc({
        prState: "open",
        lastReviewAtMs: null,
        dirMtimeMs: NOW - 80 * HOUR,
        nowMs: NOW,
        inFlight: false,
      }).action,
    ).toBe("collect");
    expect(
      decideGc({
        prState: "open",
        lastReviewAtMs: null,
        dirMtimeMs: null,
        nowMs: NOW,
        inFlight: false,
      }).reason,
    ).toContain("no stamp, no mtime");
  });
});

describe("parseWorktreePr", () => {
  test("reads pr-N and rejects everything else", () => {
    expect(parseWorktreePr("pr-1724")).toBe(1724);
    expect(parseWorktreePr("pr-1")).toBe(1);
    expect(parseWorktreePr("pr-1724.lock")).toBeNull();
    expect(parseWorktreePr("pr-")).toBeNull();
    expect(parseWorktreePr("1724")).toBeNull();
    expect(parseWorktreePr(".stamps")).toBeNull();
  });
});

describe("worktreeRemoveArgs", () => {
  test("hands over worktree remove --force, never rm -rf", () => {
    const args = worktreeRemoveArgs(
      "/Users/x/.prhero/repos/github.com/a/b/worktrees/pr-1",
    );
    expect(args).toEqual([
      "worktree",
      "remove",
      "--force",
      "/Users/x/.prhero/repos/github.com/a/b/worktrees/pr-1",
    ]);
    expect(args.join(" ")).not.toContain("rm");
  });
});

describe("parseGhPrState", () => {
  test("maps gh's state field, and garbage is unknown not a throw", () => {
    expect(parseGhPrState(`{"state":"OPEN"}`)).toBe("open");
    expect(parseGhPrState(`{"state":"MERGED"}`)).toBe("merged");
    expect(parseGhPrState(`{"state":"CLOSED"}`)).toBe("closed");
    expect(parseGhPrState("not json")).toBe("unknown");
    expect(parseGhPrState(`{"state":"DRAFT"}`)).toBe("unknown");
  });
});
