import { describe, expect, test } from "bun:test";
import type { ExactBindingCapabilityReport } from "../src/execution/contracts";
import {
  CURRENT_ONBOARDING_VERSION,
  createInitialWizardState,
  isMachineOnboarded,
  renderWizardStep,
  runWizard,
  WIZARD_STEPS,
  wizardReducer,
} from "../src/wizard";

// W4 remediation (opencode-production-runtime PR3 verify #4997): the old
// `probeExactBinding` seam returned `{ projectionReady: boolean }` — a
// caller-supplied boolean, not the real ExactBindingCapabilityReport the
// doctor and execution consumers derive readiness from. That let the wizard
// step exercise a shape production code never produces. This fixture
// matches the real report exactly (see test/doctor.test.ts's `exact()`).
function exactBindingReport(
  overrides: Partial<ExactBindingCapabilityReport> = {},
): ExactBindingCapabilityReport {
  return {
    routeKey: "fp",
    backend: "claude-code",
    sdk: { available: true },
    binary: { resolved: true, absolutePath: "/bin/claude", sha256: "aa" },
    auth: {
      kind: "claude_subscription_oauth",
      projectionReady: true,
      probe: "passed",
    },
    environment: { syntheticHome: true, enumeratedPassthrough: false },
    isolation: { workspaceReadBroker: true, codegraphPolicy: false },
    toolsMcp: { allowMapEnforced: true, mcpIntegrityChecked: true },
    protocol: {
      terminalProof: true,
      boundedEvents: false,
      usageMode: "snapshot",
    },
    usage: { normalized: true },
    billing: {
      mode: "subscription",
      pricingApplicability: "not_applicable",
      tokenPricingAvailable: false,
      cashCostAccountingValid: true,
    },
    ...overrides,
  };
}

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

  describe("dependency injection: WizardDeps.exec reaches the tool checks", () => {
    // WizardDeps has always exposed `exec`, and a caller that injects it is
    // entitled to assume NOTHING in the wizard shells out for real. It did not
    // hold: the system_tools step spread only `deps.checkToolsOptions` into
    // `checkSystemTools`, so an injected `exec` was silently dropped and the
    // real `Bun.spawn` fallback ran `gh auth status` — a live network round
    // trip — inside a test that had faked its I/O. That is a leak in the seam,
    // not a slow test: it made `bun test` depend on the network and on GitHub
    // being fast, and it is why test/repo-optional.test.ts's setup test timed
    // out at bun's 5000ms default whenever `gh` was slow to answer.
    // `checkSystemTools` falls back to the real `Bun.which` when no `which` is
    // injected (src/system-tools.ts:96), and it only issues the `gh auth
    // status` exec once `which("gh")` returned a path (:156-168). So a test
    // that injects `exec` but not `which` still depends on the host having
    // `gh` on PATH — which is the exact ambient-state dependency these tests
    // exist to disprove. Found by pr-hero on #118; reproduced by running them
    // with a PATH containing no `gh`.
    const hermeticWhich = { which: (bin: string) => `/usr/local/bin/${bin}` };

    test("an injected exec is used for the system-tool probes, not Bun.spawn", async () => {
      const calls: string[][] = [];
      await runWizard({
        cwd: "/repo",
        home: "/home/user",
        checkToolsOptions: hermeticWhich,
        exec: async (cmd) => {
          calls.push(cmd);
          return { exitCode: 1, stdout: "", stderr: "not a git repository" };
        },
        writeFile: async () => {},
        exists: () => false,
      });

      // The tool preflight asks each installed binary for its version, and
      // `--version` is issued by checkSystemTools alone — the wizard's own
      // git probe is `rev-parse`. So a `--version` command arriving here is
      // the seam being wired, not the pre-existing git call leaking through.
      expect(calls.some((cmd) => cmd.includes("--version"))).toBe(true);
    });

    test("an injected exec keeps the wizard off the network entirely", async () => {
      // The specific spawn that made this expensive was `gh auth status`.
      // Nothing the wizard runs may reach a real binary when exec is injected.
      const calls: string[][] = [];
      await runWizard({
        cwd: "/repo",
        home: "/home/user",
        checkToolsOptions: hermeticWhich,
        exec: async (cmd) => {
          calls.push(cmd);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        writeFile: async () => {},
        exists: () => false,
      });

      // Every command the wizard issued was observed here. If `gh auth status`
      // had gone to the real Bun.spawn fallback instead, this list would not
      // contain it — the assertion is that the probes are visible, i.e. routed
      // through the seam rather than around it.
      expect(calls.some((cmd) => cmd.includes("auth"))).toBe(true);
    });
  });

  describe("exact-binding initialization facts", () => {
    const tools = {
      cwd: "/repo",
      home: "/home/user",
      exists: () => true,
      checkToolsOptions: {
        which: (bin: string) => `/bin/${bin}`,
        exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
        env: { ANTHROPIC_API_KEY: "sk-test" },
      },
    };

    test("system_tools probe and render follow exact-binding projectionReady from a real ExactBindingCapabilityReport (drift, spec scenario 8)", async () => {
      const step = WIZARD_STEPS.find((s) => s.id === "system_tools");
      expect(step).toBeDefined();
      const unavailable = await step?.probe({
        ...tools,
        probeExactBinding: async () => [
          exactBindingReport({
            auth: {
              kind: "claude_subscription_oauth",
              projectionReady: false,
              probe: "failed",
            },
          }),
        ],
      });
      expect(unavailable?.exactBindingProjectionReady).toBe(false);
      expect(unavailable?.exactBindingProbeError).toBeUndefined();
      const down = step?.render(
        { ...createInitialWizardState(), ...unavailable },
        { styles: false, width: 80 },
      );
      expect(
        down?.some((l) => l.includes("auth projection: unavailable")),
      ).toBe(true);

      // Binding drift: the same step, re-probed with fresh facts, reflects
      // CURRENT state — it must not reuse the prior call's success flag.
      const ready = await step?.probe({
        ...tools,
        probeExactBinding: async () => [exactBindingReport()],
      });
      expect(ready?.exactBindingProjectionReady).toBe(true);
      const up = step?.render(
        { ...createInitialWizardState(), ...ready },
        { styles: false, width: 80 },
      );
      expect(up?.some((l) => l.includes("auth projection: ready"))).toBe(true);
    });

    test("a probe/authority failure is recorded distinctly from a genuinely unready projection", async () => {
      const step = WIZARD_STEPS.find((s) => s.id === "system_tools");
      expect(step).toBeDefined();

      // A genuine defect (broker down, transport throw, etc.) must not
      // collapse into the SAME `false` a clean unready report also produces.
      const errored = await step?.probe({
        ...tools,
        probeExactBinding: async () => {
          throw new Error("credential broker unavailable");
        },
      });
      expect(errored?.exactBindingProjectionReady).toBe(false);
      expect(errored?.exactBindingProbeError).toContain(
        "credential broker unavailable",
      );

      const genuinelyUnready = await step?.probe({
        ...tools,
        probeExactBinding: async () => [
          exactBindingReport({
            auth: {
              kind: "claude_subscription_oauth",
              projectionReady: false,
              probe: "failed",
            },
          }),
        ],
      });
      expect(genuinelyUnready?.exactBindingProjectionReady).toBe(false);
      expect(genuinelyUnready?.exactBindingProbeError).toBeUndefined();
    });

    // NEW-1 (verify report #4997 rev7): the probe failure was captured in
    // state but never rendered, so an operator saw the identical
    // "unavailable" line whether the broker threw or the projection was
    // cleanly unready. State-only distinctions help nobody at the terminal.
    test("render distinguishes a probe failure from a cleanly unready projection", () => {
      const step = WIZARD_STEPS.find((s) => s.id === "system_tools");
      expect(step).toBeDefined();

      const base = {
        ...createInitialWizardState(),
        toolStatuses: {
          claude: { name: "claude", installed: true, version: "1.0.0" },
        },
      };

      const cleanlyUnready = step?.render(
        { ...base, exactBindingProjectionReady: false },
        { styles: false, width: 80 },
      ) as string[];
      expect(cleanlyUnready.join("\n")).toContain(
        "auth projection: unavailable",
      );
      expect(cleanlyUnready.join("\n")).not.toContain("probe failed");

      const probeFailed = step?.render(
        {
          ...base,
          exactBindingProjectionReady: false,
          exactBindingProbeError: "credential broker unavailable",
        },
        { styles: false, width: 80 },
      ) as string[];
      const rendered = probeFailed.join("\n");
      expect(rendered).toContain("probe failed");
      expect(rendered).toContain("credential broker unavailable");
      // The two states must not render identically.
      expect(rendered).not.toBe(cleanlyUnready.join("\n"));
    });
  });
});
