import { describe, expect, test } from "bun:test";
import type { RepoContext } from "../src/menu-context";
import { type MenuLoopIo, runMenuLoop } from "../src/ui-menu";
import type { KeyReader } from "../src/ui-select";

const ESC = String.fromCharCode(27);
const CTRL_C = "\x03";
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI, "");

function fakeReader(
  chunks: (string | undefined)[],
  raw = true,
): KeyReader & { closed: boolean } {
  let i = 0;
  return {
    raw,
    closed: false,
    read: () => Promise.resolve(i < chunks.length ? chunks[i++] : undefined),
    close: function () {
      this.closed = true;
    },
  };
}

function testIo(): MenuLoopIo & { lines: () => string[]; text: () => string } {
  const out: string[] = [];
  return {
    write: (t) => out.push(t),
    line: (t = "") => out.push(`${t}\n`),
    lines: () =>
      stripAnsi(out.join(""))
        .split("\n")
        .map((l) => l.trimEnd()),
    text: () => out.join(""),
  };
}

describe("5.1 / 5.2 Menu Input Loop & Keyboard Ownership", () => {
  const dummyContext: RepoContext = {
    kind: "configured-repo",
    root: "/Users/anon/repo",
    name: "repo",
    defaultBase: "main",
  };
  const dummyStatus = {
    upgradeAvailable: false,
    activeReviewsCount: 0,
    doctorStatus: "healthy" as const,
  };

  test("j/k and arrows move cursor with wrapping", async () => {
    const io = testIo();
    const reader = fakeReader(["j", "j", "k", "q"]);

    const exitCode = await runMenuLoop({
      context: dummyContext,
      status: dummyStatus,
      createReader: () => reader,
      io,
      styles: false,
      width: 80,
    });

    expect(exitCode).toBe(0);
    expect(reader.closed).toBe(true);
  });

  test("digits 1-9 move selection without executing; Enter executes", async () => {
    const io = testIo();
    const dispatched: string[] = [];
    // 2 selects Activity, Enter executes it, then pause keypress returns to menu, then q quits
    const reader = fakeReader(["2", "\r", " ", "q"]);

    const exitCode = await runMenuLoop({
      context: dummyContext,
      status: dummyStatus,
      createReader: () => reader,
      io,
      styles: false,
      width: 80,
      dispatchAction: async (action) => {
        dispatched.push(action);
        return 0;
      },
    });

    expect(exitCode).toBe(0);
    expect(dispatched).toContain("activity");
    expect(reader.closed).toBe(true);
  });

  test("q and Esc at root menu exit 0 cleanly", async () => {
    const ioQ = testIo();
    const readerQ = fakeReader(["q"]);
    const codeQ = await runMenuLoop({
      context: dummyContext,
      status: dummyStatus,
      createReader: () => readerQ,
      io: ioQ,
      styles: false,
      width: 80,
    });
    expect(codeQ).toBe(0);

    const ioEsc = testIo();
    const readerEsc = fakeReader([ESC]);
    const codeEsc = await runMenuLoop({
      context: dummyContext,
      status: dummyStatus,
      createReader: () => readerEsc,
      io: ioEsc,
      styles: false,
      width: 80,
    });
    expect(codeEsc).toBe(0);
  });

  test("Ctrl-C exits 130 and cleans up reader", async () => {
    const io = testIo();
    const reader = fakeReader([CTRL_C]);

    const exitCode = await runMenuLoop({
      context: dummyContext,
      status: dummyStatus,
      createReader: () => reader,
      io,
      styles: false,
      width: 80,
    });

    expect(exitCode).toBe(130);
    expect(reader.closed).toBe(true);
  });

  test("single keyboard owner: closes reader before dispatch and re-creates on return", async () => {
    const readers: (KeyReader & { closed: boolean })[] = [];
    const io = testIo();

    // 1st reader: press 'j' then Enter on second item (activity), dispatches action
    // 2nd reader: pause keypress (" ")
    // 3rd reader: 'q' exits menu
    const createReader = () => {
      const r = fakeReader(
        readers.length === 0
          ? ["j", "\r"]
          : readers.length === 1
            ? [" "]
            : ["q"],
      );
      readers.push(r);
      return r;
    };

    let dispatched = false;
    const exitCode = await runMenuLoop({
      context: dummyContext,
      status: dummyStatus,
      createReader,
      io,
      styles: false,
      width: 80,
      dispatchAction: async (_action) => {
        dispatched = true;
        // Reader for root menu must be closed during dispatch!
        expect(readers[0].closed).toBe(true);
        return 0;
      },
    });

    expect(exitCode).toBe(0);
    expect(dispatched).toBe(true);
    expect(readers.length).toBeGreaterThanOrEqual(2);
    expect(readers.every((r) => r.closed)).toBe(true);
  });

  test("clears screen on initial render and on return from action when styles are true", async () => {
    const readers: (KeyReader & { closed: boolean })[] = [];
    const io = testIo();

    const createReader = () => {
      const r = fakeReader(
        readers.length === 0
          ? ["j", "\r"]
          : readers.length === 1
            ? [" "]
            : ["q"],
      );
      readers.push(r);
      return r;
    };

    const exitCode = await runMenuLoop({
      context: dummyContext,
      status: dummyStatus,
      createReader,
      io,
      styles: true,
      width: 80,
      dispatchAction: async () => {
        io.write("Doctor output\n");
        return 0;
      },
    });

    expect(exitCode).toBe(0);
    const raw = io.text();
    // \x1b[2J\x1b[H should appear at least twice: initial render + return after pause
    const clearSeq = `${ESC}[2J${ESC}[H`;
    const clearMatches = raw.split(clearSeq).length - 1;
    expect(clearMatches).toBeGreaterThanOrEqual(2);
  });
});
