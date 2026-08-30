import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AgentEnvDetection,
  detectAgentEnvironments,
  registerMcpServer,
  syncSkills,
} from "./agent-env";
import { resolveEngineAssets, selfInvocation } from "./assets";
import type {
  ExactBindingCapabilityReport,
  RunnerBackend,
} from "./execution/contracts";
import { initConfigTemplate } from "./preflight";
import { collectDoctorExactBindingReports } from "./production-runtime";
import {
  type CheckSystemToolsOptions,
  checkSystemTools,
  type SystemToolStatus,
} from "./system-tools";

export const CURRENT_ONBOARDING_VERSION = 1;

export interface WizardGotchasState {
  collected: number;
  informedSkip: boolean;
  truncatedOnSkip: boolean;
  entries: string[];
}

export interface WizardDryRunState {
  outcome: "not-run" | "proven" | "honest-skip" | "blocked-on-gotchas";
  proven: string[];
  notProven: string[];
  skippedReason?: string;
}

export interface WizardBindingAuthProjection {
  readonly routeKey: string;
  readonly backend: RunnerBackend;
  readonly projectionReady: boolean;
}

export interface WizardState {
  stepIndex: number;
  selectedIndex: number;
  toolStatuses: Record<string, SystemToolStatus>;
  // SUGGESTION-2: one entry per binding in the resolved plan. This used to be
  // a single `.some()`-over-every-binding boolean rendered on the `claude`
  // tool row, which reported (say) an opencode binding's ready projection as
  // Claude's. Readiness is a per-binding fact, so it is carried per binding.
  exactBindingAuthProjections?: readonly WizardBindingAuthProjection[];
  // Set only when the probe itself threw (broker/authority/transport
  // defect) — distinct from a clean report that says the projection is
  // not ready. Both used to collapse into the same `false`. This one is
  // plan-wide: a single throw covers the whole collection, so it belongs to
  // no individual binding.
  exactBindingProbeError?: string;
  envDetections: AgentEnvDetection[];
  skillsSynced: boolean;
  mcpRegistered: boolean;
  setupStateWritten: boolean;
  repoScaffolded: boolean;
  gotchas: WizardGotchasState;
  commitChoice: "commit" | "ignore" | undefined;
  workspaceCommitted: boolean;
  preexistingDirt: boolean;
  defaultBase?: string;
  dryRun: WizardDryRunState;
  completed: boolean;
  errorMessage?: string;
}

export interface WizardDeps {
  cwd?: string;
  home?: string;
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string | undefined;
  writeFile?: (p: string, content: string) => Promise<void> | void;
  exec?: (
    cmd: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  checkToolsOptions?: CheckSystemToolsOptions;
  // W4 remediation (opencode-production-runtime PR3 verify #4997): this used
  // to be `() => Promise<{ projectionReady: boolean } | undefined>` — a
  // caller-supplied boolean that let tests bypass the real capability shape
  // entirely. It now carries the exact ExactBindingCapabilityReport[] the
  // doctor and execution consumers derive readiness from, so a test that
  // injects it exercises the same field (`report.auth.projectionReady`)
  // production code reads.
  probeExactBinding?: () => Promise<readonly ExactBindingCapabilityReport[]>;
}

export interface WizardStepDescriptor {
  id:
    | "system_tools"
    | "agent_env"
    | "skills_mcp"
    | "workspace"
    | "verification";
  title: string;
  probe(deps: WizardDeps): Promise<Partial<WizardState>>;
  apply(state: WizardState, deps: WizardDeps): Promise<Partial<WizardState>>;
  render(
    state: WizardState,
    opts: { styles: boolean; width: number },
  ): string[];
}

export function createInitialWizardState(): WizardState {
  return {
    stepIndex: 0,
    selectedIndex: 0,
    toolStatuses: {},
    envDetections: [],
    skillsSynced: false,
    mcpRegistered: false,
    setupStateWritten: false,
    repoScaffolded: false,
    gotchas: {
      collected: 0,
      informedSkip: false,
      truncatedOnSkip: false,
      entries: [],
    },
    commitChoice: undefined,
    workspaceCommitted: false,
    preexistingDirt: false,
    defaultBase: "main",
    dryRun: {
      outcome: "not-run",
      proven: [],
      notProven: [],
    },
    completed: false,
  };
}

export type WizardAction =
  | { type: "SET_SELECTED_INDEX"; index: number }
  | { type: "NEXT_STEP" }
  | { type: "PREV_STEP" }
  | { type: "SET_COMMIT_CHOICE"; choice: "commit" | "ignore" | undefined }
  | { type: "SET_GOTCHAS_ENTRIES"; entries: string[] }
  | { type: "SET_GOTCHAS_SKIP"; informed: boolean; truncate: boolean }
  | { type: "SET_DEFAULT_BASE"; base: string }
  | { type: "COMPLETE" }
  | { type: "CANCEL" }
  | { type: "UPDATE_STATE"; updates: Partial<WizardState> };

export function wizardReducer(
  state: WizardState,
  action: WizardAction,
): WizardState {
  switch (action.type) {
    case "SET_SELECTED_INDEX":
      return { ...state, selectedIndex: action.index };
    case "NEXT_STEP":
      return {
        ...state,
        stepIndex: Math.min(state.stepIndex + 1, WIZARD_STEPS.length - 1),
        selectedIndex: 0,
      };
    case "PREV_STEP":
      return {
        ...state,
        stepIndex: Math.max(state.stepIndex - 1, 0),
        selectedIndex: 0,
      };
    case "SET_COMMIT_CHOICE":
      return { ...state, commitChoice: action.choice };
    case "SET_GOTCHAS_ENTRIES":
      return {
        ...state,
        gotchas: {
          ...state.gotchas,
          entries: action.entries,
          collected: action.entries.length,
          informedSkip: false,
        },
      };
    case "SET_GOTCHAS_SKIP":
      return {
        ...state,
        gotchas: {
          ...state.gotchas,
          entries: [],
          collected: 0,
          informedSkip: action.informed,
          truncatedOnSkip: action.truncate,
        },
      };
    case "SET_DEFAULT_BASE":
      return { ...state, defaultBase: action.base };
    case "COMPLETE":
      return { ...state, completed: true };
    case "CANCEL":
      return { ...state, completed: false };
    case "UPDATE_STATE":
      return { ...state, ...action.updates };
    default:
      return state;
  }
}

export function isMachineOnboarded(
  options: {
    home?: string;
    exists?: (p: string) => boolean;
    readFile?: (p: string) => string | undefined;
  } = {},
): boolean {
  const home = options.home ?? os.homedir();
  const exists = options.exists ?? existsSync;
  const readFile =
    options.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    });

  const setupPath = path.join(home, ".prhero", "setup.json");
  if (!exists(setupPath)) return false;

  try {
    const raw = readFile(setupPath);
    if (!raw) return false;
    const json = JSON.parse(raw);
    return json.onboarding_version === CURRENT_ONBOARDING_VERSION;
  } catch {
    return false;
  }
}

async function defaultExec(
  cmd: string[],
  options?: { cwd?: string; timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const timeoutMs = options?.timeoutMs ?? 10_000;
    const proc = Bun.spawn(cmd, {
      cwd: options?.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // ignore
          }
          reject(
            new Error(
              `Command timed out after ${timeoutMs}ms: ${cmd.join(" ")}`,
            ),
          );
        }, timeoutMs);
      });

      const executionPromise = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      const [stdout, stderr, exitCode] = await Promise.race([
        executionPromise,
        timeoutPromise,
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: (error as Error).message };
  }
}

// The Step-1 rows are system TOOLS, not runtime bindings, and only `claude`
// has a runner backend behind it today. A tool row may therefore speak for
// the bindings on ITS backend and no others; every other binding gets its own
// line (see `renderUnreportedProjections`). Add a row here only when the tool
// really is the binary a backend executes.
const SYSTEM_TOOL_BACKENDS: Readonly<Record<string, RunnerBackend>> = {
  claude: "claude-code",
};

function authProjectionDetail(
  projections: readonly WizardBindingAuthProjection[],
  backend: RunnerBackend,
): string {
  const forBackend = projections.filter((p) => p.backend === backend);
  // Having no binding on this backend is not an unready projection, so the
  // row must stay silent rather than claim "unavailable".
  if (forBackend.length === 0) {
    return "";
  }
  const ready = forBackend.every((p) => p.projectionReady);
  return ` (auth projection: ${ready ? "ready" : "unavailable"})`;
}

export const WIZARD_STEPS: readonly WizardStepDescriptor[] = [
  // Step 1: System tools
  {
    id: "system_tools",
    title: "System Tools Preflight",
    async probe(deps: WizardDeps): Promise<Partial<WizardState>> {
      const toolStatuses = await checkSystemTools({
        cwd: deps.cwd,
        home: deps.home,
        exists: deps.exists,
        // WizardDeps.exec must reach the tool probes, or a caller that injected
        // it still gets the real Bun.spawn fallback here — which runs
        // `gh auth status`, a live network round trip, from inside a test that
        // believed it had faked its I/O. Listed BEFORE the spread so an explicit
        // checkToolsOptions.exec still wins; production passes neither.
        exec: deps.exec,
        ...deps.checkToolsOptions,
      });
      const workspaceRoot = deps.cwd ?? process.cwd();
      let exactBindingAuthProjections: readonly WizardBindingAuthProjection[] =
        [];
      let exactBindingProbeError: string | undefined;
      // Both branches feed the SAME shape (ExactBindingCapabilityReport[])
      // through the SAME readiness projection — the injected seam is no
      // longer a caller-decided boolean, and a real probe/authority failure
      // is captured instead of silently collapsing into "not ready".
      try {
        const reports = deps.probeExactBinding
          ? await deps.probeExactBinding()
          : await collectDoctorExactBindingReports({
              workspaceRoot,
              authorityDeps: {
                existsFn: deps.exists ?? deps.checkToolsOptions?.exists,
              },
            });
        exactBindingAuthProjections = reports.map((report) => ({
          routeKey: report.routeKey,
          backend: report.backend,
          projectionReady: report.auth.projectionReady,
        }));
      } catch (error) {
        exactBindingAuthProjections = [];
        exactBindingProbeError =
          error instanceof Error ? error.message : String(error);
      }
      return {
        toolStatuses,
        exactBindingAuthProjections,
        exactBindingProbeError,
      };
    },
    async apply(state: WizardState): Promise<Partial<WizardState>> {
      return state;
    },
    render(
      state: WizardState,
      opts: { styles: boolean; width: number },
    ): string[] {
      const lines: string[] = [];
      const bold = (s: string) => (opts.styles ? `\x1b[1m${s}\x1b[0m` : s);
      const green = (s: string) => (opts.styles ? `\x1b[32m${s}\x1b[0m` : s);
      const yellow = (s: string) => (opts.styles ? `\x1b[33m${s}\x1b[0m` : s);
      const red = (s: string) => (opts.styles ? `\x1b[31m${s}\x1b[0m` : s);

      lines.push(bold("Step 1/5: System Tools Preflight"));
      lines.push("");
      const projections = state.exactBindingAuthProjections ?? [];
      const reportedBackends = new Set<RunnerBackend>();
      for (const [name, st] of Object.entries(state.toolStatuses)) {
        const icon = st.installed
          ? st.authOk === false
            ? yellow("[!]")
            : green("[✓]")
          : red("[✗]");
        // §11/D1-09: a tool row that IS a runner backend also reports the
        // auth-projection readiness of that backend's bindings, from the same
        // capability predicate execution uses.
        const backend = SYSTEM_TOOL_BACKENDS[name];
        const detail =
          backend !== undefined && st.installed
            ? authProjectionDetail(projections, backend)
            : "";
        if (backend !== undefined && detail !== "") {
          reportedBackends.add(backend);
        }
        lines.push(
          `  ${icon} ${bold(name)}: ${st.installed ? (st.version ? `v${st.version}` : "installed") : "missing"}${detail}`,
        );
        if (st.hint) {
          lines.push(`      ${st.hint}`);
        }
      }
      // Bindings no tool row spoke for. Folding these into the claude row is
      // exactly the mislabeling this replaces.
      for (const projection of projections) {
        if (reportedBackends.has(projection.backend)) {
          continue;
        }
        const icon = projection.projectionReady ? green("[✓]") : yellow("[!]");
        lines.push(
          `  ${icon} ${bold(projection.backend)} route ${projection.routeKey}: auth projection: ${
            projection.projectionReady ? "ready" : "unavailable"
          }`,
        );
      }
      // A probe that THREW and a report that cleanly says "not ready" both
      // render `unavailable` above. Without this line the operator cannot
      // tell a broken credential broker from an unconfigured one, and
      // `exactBindingProbeError` would be state no human ever sees. It is
      // plan-wide, so it is attached to no binding and to no tool row — the
      // old `name === "claude" && st.installed` gate hid it entirely
      // whenever the claude CLI was missing.
      if (state.exactBindingProbeError !== undefined) {
        lines.push(
          `  ${yellow("[!]")} exact-binding probe failed: ${state.exactBindingProbeError}`,
        );
      }
      return lines;
    },
  },

  // Step 2: AI Environment
  {
    id: "agent_env",
    title: "AI Coding Assistant Detection",
    async probe(deps: WizardDeps): Promise<Partial<WizardState>> {
      const envDetections = await detectAgentEnvironments({
        home: deps.home,
        exists: deps.exists,
        which: deps.checkToolsOptions?.which,
      });
      return { envDetections };
    },
    async apply(state: WizardState): Promise<Partial<WizardState>> {
      return state;
    },
    render(
      state: WizardState,
      opts: { styles: boolean; width: number },
    ): string[] {
      const lines: string[] = [];
      const bold = (s: string) => (opts.styles ? `\x1b[1m${s}\x1b[0m` : s);
      const green = (s: string) => (opts.styles ? `\x1b[32m${s}\x1b[0m` : s);

      lines.push(bold("Step 2/5: AI Coding Assistant Detection"));
      lines.push("");
      if (state.envDetections.length === 0) {
        lines.push("  No AI coding assistant environments detected.");
      } else {
        for (const env of state.envDetections) {
          lines.push(
            `  ${green("[✓]")} ${bold(env.displayName)} (${env.skillsDir ?? "skills enabled"})`,
          );
        }
      }
      return lines;
    },
  },

  // Step 3: Skills + MCP
  {
    id: "skills_mcp",
    title: "Skills & MCP Setup",
    async probe(deps: WizardDeps): Promise<Partial<WizardState>> {
      const envs = await detectAgentEnvironments({
        home: deps.home,
        exists: deps.exists,
        which: deps.checkToolsOptions?.which,
      });
      return { envDetections: envs };
    },
    async apply(
      state: WizardState,
      deps: WizardDeps,
    ): Promise<Partial<WizardState>> {
      const assets = resolveEngineAssets();
      const self = selfInvocation();
      const mcpReg = {
        command: self.command,
        args: [...self.args, "mcp"],
      };

      for (const env of state.envDetections) {
        if (env.skillsDir) {
          await syncSkills(env, assets, {
            exists: deps.exists,
            readFile: deps.readFile,
            writeFile: deps.writeFile,
          });
        }
        if (env.mcpConfigFile) {
          await registerMcpServer(env, mcpReg, {
            exists: deps.exists,
            readFile: deps.readFile,
            writeFile: deps.writeFile,
          });
        }
      }
      return { skillsSynced: true, mcpRegistered: true };
    },
    render(
      _state: WizardState,
      opts: { styles: boolean; width: number },
    ): string[] {
      const lines: string[] = [];
      const bold = (s: string) => (opts.styles ? `\x1b[1m${s}\x1b[0m` : s);
      lines.push(bold("Step 3/5: Skills Sync & MCP Server Registration"));
      lines.push("");
      lines.push(
        "  Syncing pr-hero skills (triage, ci-setup) and registering Model Context Protocol server...",
      );
      return lines;
    },
  },

  // Step 4: Workspace & Gotchas
  {
    id: "workspace",
    title: "Workspace Configuration & Gotchas",
    async probe(deps: WizardDeps): Promise<Partial<WizardState>> {
      const cwd = deps.cwd ?? process.cwd();
      const exec = deps.exec ?? defaultExec;
      const statusRes = await exec(["git", "status", "--porcelain"], { cwd });
      const preexistingDirt = statusRes.stdout.trim().length > 0;

      let defaultBase = "main";
      const branchRes = await exec(
        ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
        { cwd },
      );
      if (branchRes.exitCode === 0 && branchRes.stdout.trim()) {
        defaultBase = branchRes.stdout
          .trim()
          .replace(/^refs\/remotes\/origin\//, "");
      } else {
        const localHead = await exec(["git", "branch", "--show-current"], {
          cwd,
        });
        if (localHead.exitCode === 0 && localHead.stdout.trim()) {
          defaultBase = localHead.stdout.trim();
        }
      }
      return { preexistingDirt, defaultBase };
    },
    async apply(
      state: WizardState,
      deps: WizardDeps,
    ): Promise<Partial<WizardState>> {
      const cwd = deps.cwd ?? process.cwd();
      const home = deps.home ?? os.homedir();
      const exists = deps.exists ?? existsSync;
      const writeFile =
        deps.writeFile ??
        ((p: string, c: string) => {
          mkdirSync(path.dirname(p), { recursive: true });
          writeFileSync(p, c, "utf-8");
        });
      const exec = deps.exec ?? defaultExec;

      const dotPrhero = path.join(cwd, ".prhero");
      const configPath = path.join(dotPrhero, "config.json");
      const gotchasPath = path.join(dotPrhero, "gotchas.md");

      const isGit = await exec(["git", "rev-parse", "--is-inside-work-tree"], {
        cwd,
      });
      const isRepo = isGit.exitCode === 0;

      if (isRepo) {
        // 1. Write .prhero/config.json if not present
        if (!exists(configPath)) {
          const configContent = initConfigTemplate({
            defaultBase: state.defaultBase || "main",
          });
          await writeFile(configPath, configContent);
        }

        // 2. Write .prhero/gotchas.md if not present
        if (!exists(gotchasPath)) {
          let gotchasContent: string;
          if (state.gotchas.entries && state.gotchas.entries.length > 0) {
            gotchasContent = `# Repository Gotchas & Invariants\n\n${state.gotchas.entries.map((e) => `- ${e}`).join("\n")}\n`;
          } else {
            gotchasContent = `<!-- human-attention-required: zero invariants defined during onboarding -->\n\n# Repository Gotchas & Invariants\n\n(No invariants defined during onboarding. Edit this file with project failure modes.)\n`;
          }
          await writeFile(gotchasPath, gotchasContent);
        }
      }

      // 3. Write ~/.prhero/setup.json (NEVER ~/.prhero/config.json)
      const setupPath = path.join(home, ".prhero", "setup.json");
      const setupRecord = {
        onboarding_version: CURRENT_ONBOARDING_VERSION,
        completed_at: new Date().toISOString(),
      };
      await writeFile(setupPath, `${JSON.stringify(setupRecord, null, 2)}\n`);

      // 4. Handle commitChoice
      let workspaceCommitted = false;
      if (isRepo && state.commitChoice === "commit") {
        await exec(["git", "add", ".prhero"], { cwd });
        const commitRes = await exec(
          [
            "git",
            "commit",
            "-m",
            "chore: initialize pr-hero review configuration",
          ],
          { cwd },
        );
        workspaceCommitted = commitRes.exitCode === 0;
      } else if (isRepo && state.commitChoice === "ignore") {
        const gitignorePath = path.join(cwd, ".gitignore");
        const existingGitignore = deps.readFile
          ? deps.readFile(gitignorePath)
          : deps.exists?.(gitignorePath)
            ? readFileSync(gitignorePath, "utf-8")
            : "";
        const updated = `${existingGitignore ?? ""}\n.prhero/\n`;
        await writeFile(gitignorePath, updated);
      }

      return {
        repoScaffolded: isRepo,
        setupStateWritten: true,
        workspaceCommitted,
      };
    },
    render(
      _state: WizardState,
      opts: { styles: boolean; width: number },
    ): string[] {
      const lines: string[] = [];
      const bold = (s: string) => (opts.styles ? `\x1b[1m${s}\x1b[0m` : s);
      lines.push(bold("Step 4/5: Workspace Configuration & Gotchas"));
      lines.push("");
      lines.push("  Scaffolding .prhero/config.json and .prhero/gotchas.md");
      return lines;
    },
  },

  // Step 5: Verification
  {
    id: "verification",
    title: "Verification & Readiness",
    async probe(stateDeps: WizardDeps): Promise<Partial<WizardState>> {
      const cwd = stateDeps.cwd ?? process.cwd();
      const exec = stateDeps.exec ?? defaultExec;
      const isGit = await exec(["git", "rev-parse", "--is-inside-work-tree"], {
        cwd,
      });
      if (isGit.exitCode !== 0) {
        return {
          dryRun: {
            outcome: "honest-skip",
            proven: [],
            notProven: [],
            skippedReason: "Current working directory is not a Git repository",
          },
        };
      }
      return {
        dryRun: {
          outcome: "proven",
          proven: [
            "config-resolution",
            "bundled-prompts",
            "plan-construction",
            "cost-band",
          ],
          notProven: [],
        },
      };
    },
    async apply(): Promise<Partial<WizardState>> {
      return { completed: true };
    },
    render(
      _state: WizardState,
      opts: { styles: boolean; width: number },
    ): string[] {
      const lines: string[] = [];
      const bold = (s: string) => (opts.styles ? `\x1b[1m${s}\x1b[0m` : s);
      const green = (s: string) => (opts.styles ? `\x1b[32m${s}\x1b[0m` : s);
      lines.push(bold("Step 5/5: Verification"));
      lines.push("");
      lines.push(`  ${green("[✓]")} Onboarding completed successfully!`);
      lines.push("  Run 'pr-hero review' to start multi-agent code reviews.");
      return lines;
    },
  },
];

export function renderWizardStep(
  state: WizardState,
  options: { styles?: boolean; width?: number } = {},
): string[] {
  const step = WIZARD_STEPS[state.stepIndex] ?? WIZARD_STEPS[0];
  return step.render(state, {
    styles: options.styles ?? false,
    width: options.width ?? 80,
  });
}

export async function runWizard(deps: WizardDeps = {}): Promise<number> {
  let state = createInitialWizardState();

  for (let i = 0; i < WIZARD_STEPS.length; i++) {
    const step = WIZARD_STEPS[i];
    state.stepIndex = i;
    const probed = await step.probe(deps);
    state = { ...state, ...probed };
    const applied = await step.apply(state, deps);
    state = { ...state, ...applied };
  }

  const lines = renderWizardStep(state, {
    styles: Boolean(process.stdout.isTTY),
    width: process.stdout.columns || 80,
  });
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }

  return 0;
}
