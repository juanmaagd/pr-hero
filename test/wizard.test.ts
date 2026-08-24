import { describe, expect, test } from "bun:test";
import {
  CURRENT_ONBOARDING_VERSION,
  createInitialWizardState,
  isMachineOnboarded,
  renderWizardStep,
  WIZARD_STEPS,
  wizardReducer,
} from "../src/wizard";

describe("Wizard state machine & steps", () => {
  test("5 ordered step descriptors defined", () => {
    expect(WIZARD_STEPS.length).toBe(5);
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual([
      "system_tools",
      "agent_env",
      "skills_mcp",
      "workspace",
      "verification",
    ]);
  });

  test("wizardReducer transitions stepIndex and selectedIndex correctly", () => {
    let state = createInitialWizardState();
    expect(state.stepIndex).toBe(0);

    state = wizardReducer(state, { type: "NEXT_STEP" });
    expect(state.stepIndex).toBe(1);

    state = wizardReducer(state, { type: "SET_SELECTED_INDEX", index: 2 });
    expect(state.selectedIndex).toBe(2);

    state = wizardReducer(state, { type: "PREV_STEP" });
    expect(state.stepIndex).toBe(0);
    expect(state.selectedIndex).toBe(0);
  });

  describe("Step 4 (workspace) apply behavior", () => {
    test("apply writes ~/.prhero/setup.json and NEVER touches ~/.prhero/config.json", async () => {
      const written: Record<string, string> = {};
      const executed: string[][] = [];

      const step = WIZARD_STEPS.find((s) => s.id === "workspace");
      expect(step).toBeDefined();

      const initialState = createInitialWizardState();
      initialState.gotchas = {
        collected: 0,
        informedSkip: true,
        truncatedOnSkip: false,
        entries: [],
      };
      initialState.commitChoice = undefined;

      const deps = {
        cwd: "/repo",
        home: "/home/user",
        exists: (p: string) => Boolean(written[p]),
        readFile: (p: string) => written[p],
        writeFile: async (p: string, c: string) => {
          written[p] = c;
        },
        exec: async (cmd: string[]) => {
          executed.push(cmd);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      };

      const result = await step?.apply(initialState, deps);
      expect(result?.setupStateWritten).toBe(true);

      // Verify setup.json content
      const setupRaw = written["/home/user/.prhero/setup.json"];
      expect(setupRaw).toBeDefined();
      const setup = JSON.parse(setupRaw);
      expect(setup.onboarding_version).toBe(CURRENT_ONBOARDING_VERSION);
      expect(setup.completed_at).toBeDefined();

      // Crucial invariant: never touches ~/.prhero/config.json
      expect(written["/home/user/.prhero/config.json"]).toBeUndefined();

      // Verify skipped gotchas marker
      const gotchasRaw = written["/repo/.prhero/gotchas.md"];
      expect(gotchasRaw).toBeDefined();
      expect(gotchasRaw).toContain(
        "<!-- human-attention-required: zero invariants defined during onboarding -->",
      );
    });

    test("apply with commitChoice 'commit' stages .prhero and creates chore commit", async () => {
      const written: Record<string, string> = {};
      const executed: string[][] = [];

      const step = WIZARD_STEPS.find((s) => s.id === "workspace");
      const initialState = createInitialWizardState();
      initialState.commitChoice = "commit";
      initialState.gotchas = {
        collected: 1,
        informedSkip: false,
        truncatedOnSkip: false,
        entries: ["Do not mutate state without lock."],
      };

      const deps = {
        cwd: "/repo",
        home: "/home/user",
        exists: (p: string) => Boolean(written[p]),
        readFile: (p: string) => written[p],
        writeFile: async (p: string, c: string) => {
          written[p] = c;
        },
        exec: async (cmd: string[]) => {
          executed.push(cmd);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      };

      await step?.apply(initialState, deps);

      expect(executed).toContainEqual(["git", "add", ".prhero"]);
      expect(executed).toContainEqual([
        "git",
        "commit",
        "-m",
        "chore: initialize pr-hero review configuration",
      ]);
    });

    test("apply with commitChoice 'ignore' appends .prhero/ to .gitignore", async () => {
      const written: Record<string, string> = {
        "/repo/.gitignore": "node_modules/\n",
      };
      const executed: string[][] = [];

      const step = WIZARD_STEPS.find((s) => s.id === "workspace");
      const initialState = createInitialWizardState();
      initialState.commitChoice = "ignore";

      const deps = {
        cwd: "/repo",
        home: "/home/user",
        exists: (p: string) => Boolean(written[p]),
        readFile: (p: string) => written[p],
        writeFile: async (p: string, c: string) => {
          written[p] = c;
        },
        exec: async (cmd: string[]) => {
          executed.push(cmd);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      };

      await step?.apply(initialState, deps);

      expect(written["/repo/.gitignore"]).toContain(".prhero/");
    });
  });

  describe("isMachineOnboarded", () => {
    test("returns true when ~/.prhero/setup.json exists with current version", () => {
      const exists = (p: string) => p === "/home/user/.prhero/setup.json";
      const readFile = () => JSON.stringify({ onboarding_version: 1 });
      expect(isMachineOnboarded({ home: "/home/user", exists, readFile })).toBe(
        true,
      );
    });

    test("returns false when setup.json is missing or outdated", () => {
      expect(
        isMachineOnboarded({
          home: "/home/user",
          exists: () => false,
          readFile: () => undefined,
        }),
      ).toBe(false);

      expect(
        isMachineOnboarded({
          home: "/home/user",
          exists: () => true,
          readFile: () => JSON.stringify({ onboarding_version: 0 }),
        }),
      ).toBe(false);
    });
  });

  describe("renderWizardStep", () => {
    test("renders wizard lines with styles: false with zero ANSI bytes", () => {
      const state = createInitialWizardState();
      const lines = renderWizardStep(state, { styles: false, width: 80 });
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain("\x1b");
      }
    });
  });
});
