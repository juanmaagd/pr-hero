#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  requiresExplicitLiveAuthorization,
  scoreBenchmarkRuns,
  validateBenchmarkPlan,
} from "../src/diversity/benchmark";

const mode = Bun.argv[2];
if (!mode || !["plan", "check", "run", "score"].includes(mode)) {
  console.error(
    "usage: bun run scripts/d3.ts plan|check|run|score [--plan <file>]",
  );
  process.exit(1);
}

function arg(name: string): string | undefined {
  const at = Bun.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : Bun.argv[at + 1];
}

const planPath =
  arg("plan") ??
  path.join(import.meta.dir, "..", "docs", "benchmarks", "d3-musive-plan.json");
const raw = readFileSync(planPath, "utf8");
const plan = validateBenchmarkPlan(JSON.parse(raw));

if (mode === "plan") {
  console.log(
    JSON.stringify(
      {
        planId: plan.planId,
        target: plan.target,
        replicates: plan.treatmentArm.replicates,
        maxCashUsd: plan.maxCashUsd,
        liveAuthorizationRequired: requiresExplicitLiveAuthorization(),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (mode === "check") {
  console.log(`d3: plan ${plan.planId} is valid (offline check only)`);
  process.exit(0);
}

if (mode === "score") {
  const report = scoreBenchmarkRuns([]);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.error(
  "d3: run requires separate live authorization; refusing to execute paid work",
);
process.exit(2);
