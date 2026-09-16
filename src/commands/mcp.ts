import { runMcpServer } from "#mcp/mcp";
import type { CliOptions } from "#review/preflight";

export async function mcpCommand(options: CliOptions): Promise<number> {
  await runMcpServer({
    socketPath: options.socket,
    dbPath: options.db,
  });
  return 0;
}
