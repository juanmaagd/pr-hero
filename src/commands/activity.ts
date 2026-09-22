import os from "node:os";
import type { CliOptions } from "#review/preflight";
import {
  getWatcherSpend,
  killActiveRun,
  listActiveRuns,
  queryRecentRuns,
} from "#store/activity";
import { renderActivityScreen } from "#ui/activity";
import { log, styleEnabled, terminalWidth } from "#ui/primitives";
import { CliError } from "../errors";

export async function activityCommand(options: CliOptions): Promise<number> {
  const home = os.homedir();

  if (options.kill !== undefined) {
    const pid = options.kill;
    if (!options.yes) {
      if (!process.stdin.isTTY) {
        throw new CliError(
          "--yes is required to terminate a review in non-interactive mode",
        );
      }
      process.stderr.write(`Terminate review process (PID ${pid})? [y/N] `);
      const reader = process.stdin[Symbol.asyncIterator]();
      const chunk = (await reader.next()).value;
      const answer = chunk ? chunk.toString().trim().toLowerCase() : "";
      if (answer !== "y" && answer !== "yes") {
        log("Aborted.");
        return 0;
      }
    }

    const res = await killActiveRun(pid, { home });
    if (res.status === "not_found") {
      log(`error: ${res.message}`);
      return 1;
    }
    if (res.status === "identity_mismatch") {
      log(`error: ${res.message}`);
      return 1;
    }
    if (res.status === "terminated") {
      log(`✓ Terminated review process ${res.pid} (${res.signal}).`);
      if (res.warning) {
        log(`warning: ${res.warning}`);
      }
      return 0;
    }
    return 0;
  }

  const runs = await listActiveRuns({ home });
  const spend = await getWatcherSpend({ home });
  const history = await queryRecentRuns({ home, limit: 10 });

  const lines = renderActivityScreen(
    { runs, spend, history },
    { styles: styleEnabled(), width: terminalWidth() },
  );

  for (const line of lines) {
    log(line);
  }

  return 0;
}
