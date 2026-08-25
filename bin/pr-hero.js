#!/usr/bin/env bun
// Thin wrapper for npm/`bun install -g`. This file is always reached via
// `import`, so `import.meta.main` inside cli.ts is always false here — we
// must invoke the exported runCli() ourselves instead of relying on cli.ts's
// own `if (import.meta.main)` guard, which only fires for a directly
// executed entry file (e.g. `bun run src/cli.ts`).
import { runCli } from "../src/cli.ts";

await runCli();
