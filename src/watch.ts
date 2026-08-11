// The watcher's I/O shell (ROADMAP B3): config read, git/gh calls, the
// runs-root scan, the comment fetch, the lockfile, the append-only log, the
// review spawn, the macOS notification, and launchd install/uninstall —
// every side effect `pr-hero watch` needs. Same contract as cli.ts and
// pr.ts: untested by construction, and every decision it acts on is a pure
// function in watch-preflight.ts (or ledger.ts), where the tests live.
//
// The tick never daemonizes. launchd (or cron) is the supervisor and the
// scheduler; one invocation is one pass over the configured repos, at most
// one spawned review, then exit.

import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseComparisonJson } from "./ledger";
import { fetchPrComments, ghPrList } from "./pr";
import {
  CliError,
  type CliOptions,
  CliUsageError,
  DEFAULT_WATCH_INTERVAL_MIN,
  defaultRunRoot,
} from "./preflight";
import {
  countAttempts,
  countLaunchedToday,
  decideTick,
  expandTilde,
  findingsTierCounts,
  latestRunDirName,
  launchedLine,
  localIsoTimestamp,
  logLine,
  markerDeclaredHeads,
  osascriptNotifyArgs,
  outcomeLine,
  outcomeNotificationText,
  type PrheroHomePaths,
  parseLockPid,
  parsePipelineMeta,
  parsePrList,
  parseWatchConfig,
  prheroHomePaths,
  type ReviewOutcome,
  type RunDirFact,
  renderWatchPlist,
  skipLine,
  type TickDecision,
  type TickRepoFacts,
  tickGate,
  WATCH_LAUNCHD_LABEL,
  type WatchConfig,
} from "./watch-preflight";

function log(line = ""): void {
  process.stderr.write(`${line}\n`);
}

// Third copy of the tiny git runner (cli.ts and pr.ts each carry their own,
// deliberately, so no shell imports another shell). The WHY carries over
// verbatim: args as an ARRAY, never an interpolated shell string.
async function git(
  repo: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}

async function run(
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}

// The entry pr-hero itself is running from, resolved to ABSOLUTE paths for
// re-spawning: under launchd there is no user PATH, so a bare `pr-hero`
// (or a bare `bun`) resolves in every terminal and in nothing launchd
// starts. process.execPath is the running bun binary; cli.ts sits next to
// this file by construction (both live in src/).
function cliEntryPath(): string {
  return path.join(import.meta.dir, "cli.ts");
}

const WATCH_CONFIG_EXAMPLE = `{
  "repos": [{ "path": "~/Desktop/your-repo", "post": true }],
  "daily_cap": 5,
  "window": { "start": "09:00", "end": "19:00" }
}`;

export async function watchCommand(options: CliOptions): Promise<number> {
  if (options.watch === "install") {
    return watchInstall(options.interval ?? DEFAULT_WATCH_INTERVAL_MIN);
  }
  if (options.watch === "uninstall") return watchUninstall();
  return watchOnce(options.dryRun);
}

// ---------------------------------------------------------------------------
// The tick.

interface WatchedRepoFacts extends TickRepoFacts {
  // TickRepoFacts.path is the resolved toplevel; the runs root rides along
  // for the post-run outcome scan.
  runsRoot: string;
}

async function watchOnce(dryRun: boolean): Promise<number> {
  const paths = prheroHomePaths(os.homedir());
  if (!existsSync(paths.configPath)) {
    throw new CliError(
      `no watch config at ${paths.configPath} — the watcher reviews (and ` +
        "spends money on) exactly the repos listed there, so it refuses to " +
        "guess. Create it, for example:\n" +
        WATCH_CONFIG_EXAMPLE,
    );
  }
  const config = parseWatchConfig(await Bun.file(paths.configPath).text());

  const now = new Date();
  const ts = localIsoTimestamp(now);
  const dayPrefix = ts.slice(0, 10);
  const localMinutes = now.getHours() * 60 + now.getMinutes();
  const logText = existsSync(paths.logPath)
    ? await Bun.file(paths.logPath).text()
    : "";
  const gateInput = {
    window: config.window,
    localMinutes,
    dailyCap: config.dailyCap,
    launchedToday: countLaunchedToday(logText, dayPrefix),
  };

  // The real tick checks the gate BEFORE any git or gh call: a closed
  // window or a spent cap must cost nothing, because launchd fires this
  // every N minutes all day. The dry run deliberately keeps going — its
  // whole point is the full picture.
  if (!dryRun) {
    const gate = tickGate(gateInput);
    if (gate !== "open") {
      await mkdir(paths.dir, { recursive: true });
      await appendLog(
        paths.logPath,
        logLine(
          ts,
          gate === "window-closed"
            ? `tick idle reason=window-closed window=${config.window?.start}-${config.window?.end}`
            : `tick idle reason=cap-reached launched=${gateInput.launchedToday} cap=${config.dailyCap}`,
        ),
      );
      return 0;
    }
    // The lockfile — advisory, PID-holding, stolen when dead. launchd is
    // already single-instance per label; this covers cron and hand-run
    // ticks overlapping a slow review.
    const holder = await lockHolder(paths.lockPath);
    if (holder !== null) {
      await mkdir(paths.dir, { recursive: true });
      await appendLog(
        paths.logPath,
        logLine(ts, `tick skipped reason=lock-held pid=${holder}`),
      );
      return 0;
    }
    await mkdir(paths.dir, { recursive: true });
    await Bun.write(paths.lockPath, `${process.pid}\n`);
  }

  try {
    const repos = await gatherRepoFacts(config, os.homedir());
    const decision = decideTick({ ...gateInput, repos });
    if (dryRun) {
      printDryRun(paths, config, gateInput.launchedToday, decision, repos);
      return 0;
    }
    return await runTick(paths, decision, repos);
  } finally {
    if (!dryRun) await rm(paths.lockPath, { force: true });
  }
}

// Reads everything the pure decision needs, per configured repo. Read-only
// throughout (gh api GETs, git rev-parse, artifact reads) — safe for the
// dry run by construction.
async function gatherRepoFacts(
  config: WatchConfig,
  home: string,
): Promise<WatchedRepoFacts[]> {
  const repos: WatchedRepoFacts[] = [];
  for (const entry of config.repos) {
    const expanded = expandTilde(entry.path, home);
    const toplevel = await git(expanded, ["rev-parse", "--show-toplevel"]);
    if (!toplevel.ok) {
      throw new CliError(
        `watch.json repo ${entry.path} is not a git repository ` +
          `(${expanded}): ${toplevel.stderr.trim()}`,
      );
    }
    const repoRoot = toplevel.stdout.trim();
    const runsRoot = defaultRunRoot(repoRoot);
    const runDirs = await scanRunDirs(runsRoot);
    const prs = parsePrList(await ghPrList(repoRoot));

    // The remote guard costs one gh call per PR, so it only runs for
    // candidates the free checks (draft, reviewed-local) have not already
    // killed — the pure decision treats an unfetched PR as unguarded.
    const remoteHeads: { pr: number; heads: string[] }[] = [];
    for (const candidate of prs) {
      if (candidate.isDraft) continue;
      const reviewedLocally = runDirs.localReviews.some(
        (r) => r.pr === candidate.pr && r.head === candidate.head,
      );
      if (reviewedLocally) continue;
      const comments = await fetchPrComments(repoRoot, candidate.pr);
      remoteHeads.push({
        pr: candidate.pr,
        heads: markerDeclaredHeads(comments),
      });
    }

    repos.push({
      path: repoRoot,
      post: entry.post,
      prs,
      localReviews: runDirs.localReviews,
      remoteHeads,
      attempts: prs.map((candidate) => ({
        pr: candidate.pr,
        head: candidate.head,
        count: countAttempts(runDirs.facts, candidate.pr, candidate.head),
      })),
      runsRoot,
    });
  }
  return repos;
}

// One level deep, like the ledger scan: run dirs are flat children of the
// runs root. comparison.json is read through the LEDGER's loud parser — the
// reviewed-local set must come from parsed artifact fields (pr + head_sha),
// never from directory names — while pipeline.json feeds the tolerant
// attempts counter (see the WHY on countAttempts in watch-preflight.ts).
async function scanRunDirs(runsRoot: string): Promise<{
  facts: RunDirFact[];
  localReviews: { pr: number; head: string }[];
}> {
  const facts: RunDirFact[] = [];
  const localReviews: { pr: number; head: string }[] = [];
  if (!existsSync(runsRoot)) return { facts, localReviews };
  for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsRoot, entry.name);
    const comparisonPath = path.join(dir, "comparison.json");
    if (existsSync(comparisonPath)) {
      try {
        const comparison = parseComparisonJson(
          await Bun.file(comparisonPath).text(),
        );
        localReviews.push({ pr: comparison.pr, head: comparison.head_sha });
      } catch (error) {
        // The pure parser names the field; only the shell knows the file —
        // the same wrap ledgerCommand uses. Loud on purpose: a mis-read
        // comparison.json would silently re-review (and re-bill) a PR.
        if (error instanceof CliUsageError) {
          throw new CliError(`${comparisonPath}: ${error.message}`);
        }
        throw error;
      }
    }
    const pipelinePath = path.join(dir, "pipeline.json");
    facts.push({
      name: entry.name,
      pipelineMeta: existsSync(pipelinePath)
        ? parsePipelineMeta(await Bun.file(pipelinePath).text())
        : null,
    });
  }
  return { facts, localReviews };
}

async function runTick(
  paths: PrheroHomePaths,
  decision: TickDecision,
  repos: WatchedRepoFacts[],
): Promise<number> {
  await appendLog(
    paths.logPath,
    logLine(localIsoTimestamp(new Date()), "tick start"),
  );
  for (const skip of decision.skips) {
    await appendLog(
      paths.logPath,
      skipLine(
        localIsoTimestamp(new Date()),
        path.basename(skip.repo),
        skip.pr,
        skip.head,
        skip.reason,
      ),
    );
  }
  const launch = decision.launch;
  if (launch === null) {
    await appendLog(
      paths.logPath,
      logLine(
        localIsoTimestamp(new Date()),
        `tick end launched=0 skipped=${decision.skips.length}`,
      ),
    );
    return 0;
  }

  const repoBase = path.basename(launch.repo);
  // Append-BEFORE-spawn, the fail-safe direction: if the tick crashes with
  // the review in flight, the launch must already be on the books — an
  // over-counted cap skips one review, an under-counted cap is unbounded
  // spend. This line is also what makes preflight-failing spawns (which
  // leave no run dir for the attempts guard to see) cost at most
  // daily_cap launches a day.
  await appendLog(
    paths.logPath,
    launchedLine(
      localIsoTimestamp(new Date()),
      launch.pr,
      repoBase,
      launch.head,
    ),
  );

  const proc = Bun.spawn(
    [
      process.execPath,
      cliEntryPath(),
      "review",
      "--pr",
      String(launch.pr),
      "--yes",
      ...(launch.post ? ["--post"] : []),
    ],
    {
      cwd: launch.repo,
      stdin: "ignore",
      // Inherit, explicitly: the review's progress goes wherever the tick's
      // own stderr goes (launchd.log under launchd), and an unread pipe
      // would fill and stall a long review. watch.log stays append-only by
      // construction — nothing streams into it.
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await proc.exited;

  const outcome: ReviewOutcome = {
    pr: launch.pr,
    ok: exitCode === 0,
    exitCode,
    counts:
      exitCode === 0
        ? await readTierCounts(
            repos.find((r) => r.path === launch.repo)?.runsRoot,
            launch.pr,
            launch.head,
          )
        : null,
  };
  await appendLog(
    paths.logPath,
    outcomeLine(localIsoTimestamp(new Date()), repoBase, outcome),
  );
  await notify("pr-hero", outcomeNotificationText(outcome));
  await appendLog(
    paths.logPath,
    logLine(
      localIsoTimestamp(new Date()),
      `tick end launched=1 skipped=${decision.skips.length}`,
    ),
  );
  return 0;
}

// The finding counts for the notification — cosmetic by contract, so every
// failure path degrades to null and the notification says "counts
// unavailable" instead of the tick dying over decoration.
async function readTierCounts(
  runsRoot: string | undefined,
  pr: number,
  headSha: string,
): Promise<{ blocking: number; advisory: number } | null> {
  try {
    if (runsRoot === undefined || !existsSync(runsRoot)) return null;
    const names = (await readdir(runsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const latest = latestRunDirName(names, pr, headSha);
    if (latest === null) return null;
    const parsed: unknown = await Bun.file(
      path.join(runsRoot, latest, "findings.json"),
    ).json();
    return findingsTierCounts(parsed);
  } catch {
    return null;
  }
}

async function notify(title: string, text: string): Promise<void> {
  // macOS only; elsewhere the notification is silently skipped (the log
  // line above already carries the outcome).
  if (process.platform !== "darwin") return;
  try {
    await run(osascriptNotifyArgs(title, text));
  } catch {
    // Cosmetic by contract — a broken osascript must never fail the tick.
  }
}

async function appendLog(logPath: string, line: string): Promise<void> {
  await appendFile(logPath, `${line}\n`);
}

// The PID in the lockfile if it names a LIVE process, else null (no file,
// unreadable, or dead holder — all mean "take the lock"). EPERM means the
// process exists but is not ours: alive.
async function lockHolder(lockPath: string): Promise<number | null> {
  if (!existsSync(lockPath)) return null;
  const pid = parseLockPid(await Bun.file(lockPath).text());
  if (pid === null) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : null;
  }
}

function printDryRun(
  paths: PrheroHomePaths,
  config: WatchConfig,
  launchedToday: number,
  decision: TickDecision,
  repos: WatchedRepoFacts[],
): void {
  log("pr-hero watch — dry run (nothing spawned, logged, or locked)");
  log();
  log(
    `  config     ${paths.configPath} — ${config.repos.length} repo(s), ` +
      `daily cap ${config.dailyCap}, window ` +
      (config.window === null
        ? "always"
        : `${config.window.start}-${config.window.end}`),
  );
  log(`  today      ${launchedToday} of ${config.dailyCap} launches used`);
  log(`  gate       ${decision.gate}`);
  for (const repo of repos) {
    log();
    log(`  ${repo.path}`);
    if (repo.prs.length === 0) {
      log("    no open PRs");
      continue;
    }
    for (const candidate of repo.prs) {
      const skip = decision.skips.find(
        (s) =>
          s.repo === repo.path &&
          s.pr === candidate.pr &&
          s.head === candidate.head,
      );
      log(
        `    pr ${candidate.pr} head ${candidate.head.slice(0, 8)} — ` +
          (skip === undefined ? "eligible" : `skip: ${skip.reason}`),
      );
    }
  }
  log();
  if (decision.launch !== null) {
    log(
      `  would launch: pr ${decision.launch.pr} in ${decision.launch.repo}` +
        ` (review --pr ${decision.launch.pr} --yes` +
        `${decision.launch.post ? " --post" : ""})`,
    );
  } else if (decision.gate !== "open") {
    log(`  would launch: nothing — gate is ${decision.gate}`);
  } else {
    log("  would launch: nothing — no eligible (pr, head)");
  }
  if (decision.eligible.length > 1) {
    log(
      "  waiting behind it: " +
        decision.eligible
          .slice(1)
          .map((e) => `pr ${e.pr} (${path.basename(e.repo)})`)
          .join(", "),
    );
  }
}

// ---------------------------------------------------------------------------
// launchd install/uninstall (macOS). Both idempotent, both loud about what
// they did; the plist body itself is pure (renderWatchPlist).

async function watchInstall(intervalMin: number): Promise<number> {
  if (process.platform !== "darwin") {
    throw new CliError(
      "watch install renders a macOS launchd agent. On other systems run " +
        "`pr-hero watch --once` from cron — the lockfile covers overlap.",
    );
  }
  const paths = prheroHomePaths(os.homedir());
  await mkdir(paths.dir, { recursive: true });
  await mkdir(path.dirname(paths.plistPath), { recursive: true });
  const plist = renderWatchPlist({
    runtimePath: process.execPath,
    entryPath: cliEntryPath(),
    intervalSeconds: intervalMin * 60,
    logPath: paths.launchdLogPath,
    pathEnv: process.env.PATH ?? "",
  });
  // Unload first so a re-install refreshes the running definition; launchd
  // ignores rewrites of a loaded plist until the next load.
  if (existsSync(paths.plistPath)) {
    const unloaded = await run(["launchctl", "unload", "-w", paths.plistPath]);
    log(
      unloaded.ok
        ? `unloaded previous ${WATCH_LAUNCHD_LABEL}`
        : "previous plist present but not loaded (fine, replacing it)",
    );
  }
  await Bun.write(paths.plistPath, plist);
  const loaded = await run(["launchctl", "load", "-w", paths.plistPath]);
  if (!loaded.ok) {
    throw new CliError(
      `launchctl load -w ${paths.plistPath} failed: ${loaded.stderr.trim()}`,
    );
  }
  log(`wrote  ${paths.plistPath}`);
  log(`loaded ${WATCH_LAUNCHD_LABEL} — one tick every ${intervalMin} min`);
  log(`tick output: ${paths.launchdLogPath}`);
  log(`event log:   ${paths.logPath}`);
  if (!existsSync(paths.configPath)) {
    log();
    log(
      `NOTE: no ${paths.configPath} yet — ticks will fail until it exists. ` +
        "Example:",
    );
    log(WATCH_CONFIG_EXAMPLE);
  }
  return 0;
}

async function watchUninstall(): Promise<number> {
  if (process.platform !== "darwin") {
    throw new CliError(
      "watch uninstall manages a macOS launchd agent; there is nothing to " +
        "uninstall on this system.",
    );
  }
  const paths = prheroHomePaths(os.homedir());
  if (!existsSync(paths.plistPath)) {
    log(`nothing installed (no ${paths.plistPath})`);
    return 0;
  }
  const unloaded = await run(["launchctl", "unload", "-w", paths.plistPath]);
  log(
    unloaded.ok
      ? `unloaded ${WATCH_LAUNCHD_LABEL}`
      : `plist present but not loaded: ${unloaded.stderr.trim() || "(no detail)"}`,
  );
  await rm(paths.plistPath, { force: true });
  log(`removed ${paths.plistPath}`);
  return 0;
}
