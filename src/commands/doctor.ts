import os from "node:os";
import { loadEffectiveConfig, resolveOptionalRepoRoot } from "#config/config";
import type { RoutingConfig } from "#model/routing";
import type { CliOptions } from "#review/preflight";
import { styleEnabled, terminalWidth } from "#ui/primitives";
import {
  type DoctorCheckItem,
  type DoctorReport,
  evaluateDoctorReport,
  renderDoctorReport,
  runDoctor,
} from "../doctor";
import { collectDoctorExactBindingReports } from "../production-runtime";

// W3 remediation (opencode-production-runtime PR3 verify #4997): doctor
// exists to diagnose a broken setup, so it must not die on the very
// misconfiguration it is asked to report. loadEffectiveConfig throws a
// CliError on a missing --config file, and delegates to parseLocalConfig,
// which throws on malformed repo config.json — either used to abort
// doctorCommand before a single check ran. A config-load failure is now one
// blocking DoctorCheckItem prepended to the report; every other diagnostic
// still runs and still renders, and the exit code stays nonzero.
export async function runDoctorCommand(input: {
  repoRoot?: string | undefined;
  workspaceRoot: string;
  home: string;
  configFlag?: string | undefined;
  styles: boolean;
  width: number;
  // Injectable for tests: production always uses the real runDoctor, which
  // shells out to git/claude/gh/codegraph. Tests stub this to prove the
  // config-failure wiring without depending on host tool availability.
  runDoctorFn?: typeof runDoctor;
}): Promise<{ report: DoctorReport; lines: string[] }> {
  let routingConfig: RoutingConfig | undefined;
  let configCheck: DoctorCheckItem | undefined;
  try {
    const loaded = await loadEffectiveConfig({
      root: input.repoRoot,
      home: input.home,
      configFlag: input.configFlag,
    });
    routingConfig = loaded.effective.routing;
  } catch (error) {
    configCheck = {
      name: "config",
      severity: "blocking",
      message: `configuration failed to load: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const runDoctorFn = input.runDoctorFn ?? runDoctor;
  const doctorReport = await runDoctorFn({
    repoRoot: input.repoRoot,
    cwd: input.repoRoot,
    probeExactBindings: () =>
      collectDoctorExactBindingReports({
        workspaceRoot: input.workspaceRoot,
        routingConfig,
      }),
  });
  const report =
    configCheck === undefined
      ? doctorReport
      : evaluateDoctorReport([configCheck, ...doctorReport.checks]);
  const lines = renderDoctorReport(report, {
    styles: input.styles,
    width: input.width,
  });
  return { report, lines };
}

export async function doctorCommand(options: CliOptions): Promise<number> {
  const repoRoot = await resolveOptionalRepoRoot(options);
  const { report, lines } = await runDoctorCommand({
    repoRoot: repoRoot ?? undefined,
    workspaceRoot: repoRoot ?? process.cwd(),
    home: os.homedir(),
    configFlag: options.config,
    styles: styleEnabled(process.stdout),
    width: terminalWidth(),
  });
  process.stdout.write(`${lines.join("\n")}\n`);
  return report.exitCode;
}
