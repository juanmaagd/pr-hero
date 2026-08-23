// Read-only MCP server (Fundamentals #6 / observability-canonical-store.md),
// impure half: stdio line reader, JSON-RPC event loop, and store client binding.
//
// Invariant: The MCP server is strictly read-only. All data access routes through
// ProductStoreClient.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { ProductStoreClient } from "./client";
import { prheroLayout } from "./home-preflight";
import { type JsonRpcRequest, processMcpMessage } from "./mcp-preflight";
import { type StoreServerHandle, startProductStoreServer } from "./server";

export interface McpServerOptions {
  socketPath?: string;
  dbPath?: string;
  client?: ProductStoreClient;
}

export async function runMcpServer(
  options: McpServerOptions = {},
): Promise<void> {
  let client = options.client;
  let embeddedServer: StoreServerHandle | null = null;

  if (!client) {
    if (options.socketPath) {
      // Test if an existing store server is already alive on this socket
      const probeClient = new ProductStoreClient({
        socketPath: options.socketPath,
      });
      try {
        await probeClient.health();
        // Socket is alive! Reuse existing server without starting an embedded one or hijacking
        client = probeClient;
      } catch {
        const lockPath = `${options.socketPath}.lock`;
        try {
          fs.openSync(lockPath, "wx");
        } catch {
          // Another process may be starting the server; poll for health
          let healthy = false;
          for (let i = 0; i < 20; i++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            try {
              await probeClient.health();
              healthy = true;
              break;
            } catch {}
          }
          if (healthy) {
            client = probeClient;
          } else {
            // Lock was stale or process died; reclaim lock
            try {
              fs.unlinkSync(lockPath);
            } catch {}
            try {
              fs.openSync(lockPath, "wx");
            } catch {}
          }
        }

        if (!client) {
          // Socket is absent or stale; start embedded server on this socket path
          const layout = prheroLayout(os.homedir());
          const dbPath = options.dbPath ?? layout.prheroDbPath;
          embeddedServer = startProductStoreServer({
            dbPath,
            socketPath: options.socketPath,
          });
          client = probeClient;
        }
      }
    } else {
      // Default: create a dedicated ephemeral socket for this MCP process
      const layout = prheroLayout(os.homedir());
      const socketPath = path.join(
        os.tmpdir(),
        `prhero-mcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`,
      );
      const dbPath = options.dbPath ?? layout.prheroDbPath;
      embeddedServer = startProductStoreServer({
        dbPath,
        socketPath,
      });
      client = new ProductStoreClient({ socketPath });
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const cleanup = () => {
    rl.close();
    if (embeddedServer) {
      try {
        embeddedServer.stop();
      } catch {}
      if (options.socketPath) {
        try {
          fs.unlinkSync(`${options.socketPath}.lock`);
        } catch {}
      }
    }
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const request = JSON.parse(trimmed) as JsonRpcRequest;
      const response = await processMcpMessage(client, request);
      if (response !== null) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (err) {
      const errorResponse = {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${(err as Error).message}`,
        },
      };
      process.stdout.write(`${JSON.stringify(errorResponse)}\n`);
    }
  }

  cleanup();
}
