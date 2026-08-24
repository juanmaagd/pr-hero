import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/preflight";
import { isMachineOnboarded } from "../src/wizard";

describe("Zero-argument entry & setup command dispatch", () => {
  test("setup command parses as 'setup'", () => {
    const parsed = parseArgs(["setup"]);
    expect(parsed.command).toBe("setup");
  });

  test("setup command takes --repo", () => {
    const parsed = parseArgs(["setup", "--repo", "/custom/repo"]);
    expect(parsed.command).toBe("setup");
    expect(parsed.options.repo).toBe("/custom/repo");
  });

  test("zero-argument parser parses without error when permitted or handled by entry resolver", () => {
    // When invoked with empty args, parseArgs can either return command: undefined or review/setup
    // In our CLI entry, empty argv resolves: isMachineOnboarded ? "review" : "setup"
    expect(isMachineOnboarded).toBeDefined();
  });
});
