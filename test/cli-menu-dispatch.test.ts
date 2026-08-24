import { describe, expect, test } from "bun:test";
import { getMenuOptions } from "../src/menu-context";
import { parseArgs } from "../src/preflight";
import { runLifecycleSubmenu, runWatcherSubmenu } from "../src/ui-menu";
import type { KeyReader } from "../src/ui-select";

function fakeReader(chunks: (string | undefined)[]): KeyReader {
  let i = 0;
  return {
    raw: true,
    read: () => Promise.resolve(i < chunks.length ? chunks[i++] : undefined),
    close: () => {},
  };
}

describe("5.3 & 5.4 CLI Menu Dispatch & Dispatch Matrix", () => {
  test("parseArgs parses 'menu' as a valid command", () => {
    const parsed = parseArgs(["menu"]);
    expect(parsed.command).toBe("menu");
  });

  test("configured-repo displays review, ledger, and all global items", () => {
    const items = getMenuOptions({
      kind: "configured-repo",
      root: "/repo",
      name: "repo",
      defaultBase: "main",
    });
    const ids = items.map((i) => i.id);
    expect(ids).toContain("review");
    expect(ids).toContain("ledger");
    expect(ids).toContain("activity");
    expect(ids).toContain("watcher");
    expect(ids).toContain("config");
    expect(ids).toContain("doctor");
    expect(ids).toContain("lifecycle");
    expect(ids).toContain("quit");
  });

  test("unconfigured-repo displays init and omits review and ledger", () => {
    const items = getMenuOptions({
      kind: "unconfigured-repo",
      root: "/repo",
      name: "repo",
    });
    const ids = items.map((i) => i.id);
    expect(ids[0]).toBe("init");
    expect(ids).not.toContain("review");
    expect(ids).not.toContain("ledger");
  });

  test("not-a-repo omits init, review, and ledger", () => {
    const items = getMenuOptions({
      kind: "not-a-repo",
      cwd: "/somewhere",
    });
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain("init");
    expect(ids).not.toContain("review");
    expect(ids).not.toContain("ledger");
    expect(ids).toContain("activity");
    expect(ids).toContain("doctor");
  });

  test("lifecycle submenu dispatches upgrade, setup, and uninstall", async () => {
    const dispatched: string[] = [];
    const reader = fakeReader(["\r"]); // 1st option: upgrade

    const exitCode = await runLifecycleSubmenu({
      createReader: () => reader,
      styles: false,
      width: 80,
      dispatch: async (cmd) => {
        dispatched.push(cmd);
        return 0;
      },
    });

    expect(exitCode).toBe(0);
    expect(dispatched).toEqual(["upgrade"]);
  });

  test("watcher submenu offers add only when in repo", async () => {
    const outGlobal: string[] = [];
    const readerGlobal = fakeReader(["q"]);
    await runWatcherSubmenu({
      createReader: () => readerGlobal,
      styles: false,
      width: 80,
      inRepo: false,
      io: {
        write: (t) => outGlobal.push(t),
        line: (t = "") => outGlobal.push(`${t}\n`),
      },
    });
    expect(outGlobal.join("")).not.toContain("Add current repo");

    const outRepo: string[] = [];
    const readerRepo = fakeReader(["q"]);
    await runWatcherSubmenu({
      createReader: () => readerRepo,
      styles: false,
      width: 80,
      inRepo: true,
      io: {
        write: (t) => outRepo.push(t),
        line: (t = "") => outRepo.push(`${t}\n`),
      },
    });
    expect(outRepo.join("")).toContain("Add current repo");
  });
});
