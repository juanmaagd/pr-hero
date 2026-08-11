// Pure-decision tests for the watcher (ROADMAP B3): the watch CLI surface,
// the config parser, the window/cap gates, the eligibility matrix and FIFO
// pick, the marker-head parse (the cross-machine guard), the attempts
// counter, the log round-trip that IS the daily-cap counter, the plist
// render, and the notification args. All offline, literal in → literal out.

import { describe, expect, test } from "bun:test";
import { CliUsageError, parseArgs } from "../src/preflight";
import { DEFAULT_SIZE_GATE } from "../src/size-gate";
import {
  contractTilde,
  countAttempts,
  countLaunchedToday,
  DEFAULT_DAILY_CAP,
  decideTick,
  expandTilde,
  findingsTierCounts,
  insideWindow,
  lastLogActivity,
  latestRunDirName,
  launchedLine,
  localIsoTimestamp,
  logLine,
  MAX_WATCH_ATTEMPTS,
  markerCommentSeen,
  markerDeclaredHeads,
  osascriptNotifyArgs,
  outcomeLine,
  outcomeNotificationText,
  parseLockPid,
  parseMarkerHead,
  parsePipelineMeta,
  parsePlistInterval,
  parsePrFiles,
  parsePrList,
  parseWatchConfig,
  prheroHomePaths,
  removeWatchRepo,
  renderWatchPlist,
  renderWatchStatus,
  skipLine,
  type TickInput,
  type TickRepoFacts,
  tickGate,
  upsertWatchRepo,
  WATCH_LAUNCHD_LABEL,
  type WatchPrCandidate,
} from "../src/watch-preflight";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);

describe("parseArgs watch", () => {
  test("watch --once, order-blind", () => {
    expect(parseArgs(["watch", "--once"]).command).toBe("watch");
    expect(parseArgs(["watch", "--once"]).options.watch).toBe("once");
    expect(parseArgs(["--once", "watch"]).options.watch).toBe("once");
  });

  test("watch --once --dry-run parses", () => {
    const { options } = parseArgs(["watch", "--once", "--dry-run"]);
    expect(options.watch).toBe("once");
    expect(options.dryRun).toBe(true);
  });

  test("watch install, with and without --interval", () => {
    expect(parseArgs(["watch", "install"]).options.watch).toBe("install");
    const { options } = parseArgs(["watch", "install", "--interval", "5"]);
    expect(options.watch).toBe("install");
    expect(options.interval).toBe(5);
  });

  test("watch uninstall parses", () => {
    expect(parseArgs(["watch", "uninstall"]).options.watch).toBe("uninstall");
  });

  // A bare `pr-hero watch` has no daemon mode to fall into — it must name
  // the three actions instead of silently doing nothing.
  test("bare watch fails naming the actions", () => {
    try {
      parseArgs(["watch"]);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain("--once");
      expect((error as Error).message).toContain("install");
      expect((error as Error).message).toContain("uninstall");
    }
  });

  test("--once conflicts with install/uninstall", () => {
    expect(() => parseArgs(["watch", "install", "--once"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["watch", "--once", "uninstall"])).toThrow(
      CliUsageError,
    );
  });

  test("--dry-run only applies to --once", () => {
    expect(() => parseArgs(["watch", "install", "--dry-run"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["watch", "uninstall", "--dry-run"])).toThrow(
      CliUsageError,
    );
  });

  test("--interval only applies to install", () => {
    expect(() => parseArgs(["watch", "--once", "--interval", "5"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["review", "--interval", "5", "--yes"])).toThrow(
      CliUsageError,
    );
  });

  test("--interval must be a positive integer", () => {
    for (const value of ["0", "-3", "2.5", "soon"]) {
      expect(() =>
        parseArgs(["watch", "install", "--interval", value]),
      ).toThrow(CliUsageError);
    }
  });

  test("--once outside watch fails", () => {
    expect(() => parseArgs(["review", "--once"])).toThrow(CliUsageError);
  });

  test("install without watch stays an unknown command", () => {
    expect(() => parseArgs(["install"])).toThrow(CliUsageError);
  });
});

describe("parseWatchConfig", () => {
  test("minimal config gets every default", () => {
    const config = parseWatchConfig('{"repos":[{"path":"~/Desktop/x"}]}');
    expect(config).toEqual({
      repos: [
        {
          path: "~/Desktop/x",
          post: false,
          onPush: false,
          // Missing size keys fall back to the shipped defaults, so every
          // config written before the size gate landed keeps working.
          maxChangedLines: DEFAULT_SIZE_GATE.maxChangedLines,
          maxChangedFiles: DEFAULT_SIZE_GATE.maxChangedFiles,
        },
      ],
      dailyCap: DEFAULT_DAILY_CAP,
      window: null,
    });
  });

  test("full config round-trips", () => {
    const config = parseWatchConfig(
      JSON.stringify({
        repos: [
          {
            path: "~/Desktop/musive-s3",
            post: true,
            on_push: true,
            max_changed_lines: 800,
            max_changed_files: 40,
          },
        ],
        daily_cap: 3,
        window: { start: "09:00", end: "19:00" },
      }),
    );
    expect(config).toEqual({
      repos: [
        {
          path: "~/Desktop/musive-s3",
          post: true,
          onPush: true,
          maxChangedLines: 800,
          maxChangedFiles: 40,
        },
      ],
      dailyCap: 3,
      window: { start: "09:00", end: "19:00" },
    });
  });

  // Old config files predate the size gate entirely and must keep working
  // untouched — the whole point of falling back rather than requiring keys.
  test("a legacy entry without size keys keeps working on the defaults", () => {
    const config = parseWatchConfig(
      '{"repos":[{"path":"~/x","post":true,"on_push":true}]}',
    );
    expect(config.repos[0]?.maxChangedLines).toBe(
      DEFAULT_SIZE_GATE.maxChangedLines,
    );
    expect(config.repos[0]?.maxChangedFiles).toBe(
      DEFAULT_SIZE_GATE.maxChangedFiles,
    );
  });

  // 0 is the documented "disable this limit" value, exactly like the
  // daily_cap pause switch — so the floor is 0, not 1.
  test("a zero size limit is legal and survives", () => {
    const config = parseWatchConfig(
      '{"repos":[{"path":"~/x","max_changed_lines":0,"max_changed_files":0}]}',
    );
    expect(config.repos[0]?.maxChangedLines).toBe(0);
    expect(config.repos[0]?.maxChangedFiles).toBe(0);
  });

  test("a bad size limit names itself and its value", () => {
    for (const raw of [
      '{"repos":[{"path":"~/x","max_changed_lines":-1}]}',
      '{"repos":[{"path":"~/x","max_changed_lines":"800"}]}',
      '{"repos":[{"path":"~/x","max_changed_files":2.5}]}',
    ]) {
      expect(() => parseWatchConfig(raw)).toThrow(CliUsageError);
    }
    try {
      parseWatchConfig('{"repos":[{"path":"~/x","max_changed_lines":-1}]}');
    } catch (error) {
      expect((error as Error).message).toContain("max_changed_lines");
      expect((error as Error).message).toContain("-1");
    }
  });

  // "daily_cap": 0 is the pause switch — legal, launches nothing.
  test("a zero cap is legal", () => {
    expect(parseWatchConfig('{"repos":[],"daily_cap":0}').dailyCap).toBe(0);
  });

  test("invalid JSON and non-objects fail loud", () => {
    expect(() => parseWatchConfig("not json")).toThrow(CliUsageError);
    expect(() => parseWatchConfig("[]")).toThrow(CliUsageError);
    expect(() => parseWatchConfig("null")).toThrow(CliUsageError);
  });

  test("every failing field names itself and its got-value", () => {
    const cases: [string, string][] = [
      ["{}", "repos"],
      ['{"repos":"x"}', "repos"],
      ['{"repos":[42]}', "repos[0]"],
      ['{"repos":[{}]}', "repos[0].path"],
      ['{"repos":[{"path":""}]}', "repos[0].path"],
      ['{"repos":[{"path":"/x","post":"yes"}]}', "repos[0].post"],
      ['{"repos":[{"path":"/x","on_push":"yes"}]}', "repos[0].on_push"],
      ['{"repos":[{"path":"/x","on_push":1}]}', "repos[0].on_push"],
      ['{"repos":[],"daily_cap":-1}', "daily_cap"],
      ['{"repos":[],"daily_cap":2.5}', "daily_cap"],
      ['{"repos":[],"window":"office"}', "window"],
      ['{"repos":[],"window":{"start":"9:00","end":"19:00"}}', "window.start"],
      ['{"repos":[],"window":{"start":"09:00"}}', "window.end"],
      ['{"repos":[],"window":{"start":"09:00","end":"24:00"}}', "window.end"],
    ];
    for (const [raw, field] of cases) {
      try {
        parseWatchConfig(raw);
        throw new Error(`should have thrown for ${raw}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CliUsageError);
        expect((error as Error).message).toContain(field);
      }
    }
  });

  // start === end would be an always-closed window with a plausible face;
  // "no window" is spelled null.
  test("a degenerate window is rejected", () => {
    expect(() =>
      parseWatchConfig('{"repos":[],"window":{"start":"09:00","end":"09:00"}}'),
    ).toThrow(CliUsageError);
  });
});

describe("expandTilde", () => {
  const HOME = "/Users/juanma";

  test("expands ~ and ~/", () => {
    expect(expandTilde("~", HOME)).toBe(HOME);
    expect(expandTilde("~/Desktop/x", HOME)).toBe("/Users/juanma/Desktop/x");
  });

  test("leaves absolute paths and ~user alone", () => {
    expect(expandTilde("/opt/repo", HOME)).toBe("/opt/repo");
    expect(expandTilde("~other/repo", HOME)).toBe("~other/repo");
  });
});

describe("insideWindow", () => {
  const at = (hhmm: string): number =>
    Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

  test("null means always", () => {
    expect(insideWindow(null, 0)).toBe(true);
    expect(insideWindow(null, 23 * 60 + 59)).toBe(true);
  });

  // Start-inclusive, end-exclusive: back-to-back windows neither overlap
  // nor gap.
  test("a day window: inclusive start, exclusive end", () => {
    const window = { start: "09:00", end: "19:00" };
    expect(insideWindow(window, at("08:59"))).toBe(false);
    expect(insideWindow(window, at("09:00"))).toBe(true);
    expect(insideWindow(window, at("12:00"))).toBe(true);
    expect(insideWindow(window, at("18:59"))).toBe(true);
    expect(insideWindow(window, at("19:00"))).toBe(false);
  });

  // start > end is an overnight window, not an error.
  test("an overnight window wraps midnight", () => {
    const window = { start: "22:00", end: "06:00" };
    expect(insideWindow(window, at("21:59"))).toBe(false);
    expect(insideWindow(window, at("22:00"))).toBe(true);
    expect(insideWindow(window, at("23:30"))).toBe(true);
    expect(insideWindow(window, at("00:00"))).toBe(true);
    expect(insideWindow(window, at("05:59"))).toBe(true);
    expect(insideWindow(window, at("06:00"))).toBe(false);
    expect(insideWindow(window, at("12:00"))).toBe(false);
  });
});

describe("parsePrList", () => {
  test("reads the open-PR candidates", () => {
    expect(
      parsePrList(
        `[{"number":5,"headRefOid":"${HEAD_A}","isDraft":false,` +
          `"additions":10,"deletions":2,"changedFiles":3},` +
          `{"number":7,"headRefOid":"${HEAD_B}","isDraft":true,` +
          `"additions":0,"deletions":0,"changedFiles":0}]`,
      ),
    ).toEqual([
      cand(5, HEAD_A, false, {
        additions: 10,
        deletions: 2,
        changedFiles: 3,
      }),
      cand(7, HEAD_B, true),
    ]);
  });

  test("an empty list is a valid state of the world", () => {
    expect(parsePrList("[]")).toEqual([]);
  });

  test("invalid JSON and non-arrays fail loud", () => {
    expect(() => parsePrList("not json")).toThrow(CliUsageError);
    expect(() => parsePrList("{}")).toThrow(CliUsageError);
  });

  test("a failing field names itself", () => {
    const SIZE = '"additions":0,"deletions":0,"changedFiles":0';
    const cases: [string, string][] = [
      [`[{"headRefOid":"x","isDraft":false,${SIZE}}]`, "number"],
      [
        `[{"number":0,"headRefOid":"${HEAD_A}","isDraft":false,${SIZE}}]`,
        "number",
      ],
      [
        `[{"number":5,"headRefOid":"abc123","isDraft":false,${SIZE}}]`,
        "headRefOid",
      ],
      [`[{"number":5,"headRefOid":"${HEAD_A}",${SIZE}}]`, "isDraft"],
      // The size counters are validated just as loudly: a counter silently
      // read as 0 would wave a monster PR straight past the gate.
      [
        `[{"number":5,"headRefOid":"${HEAD_A}","isDraft":false,` +
          `"deletions":0,"changedFiles":0}]`,
        "additions",
      ],
    ];
    for (const [raw, field] of cases) {
      try {
        parsePrList(raw);
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(CliUsageError);
        expect((error as Error).message).toContain(field);
      }
    }
  });
});

describe("parsePrFiles", () => {
  // Projected into the SAME NumstatFile shape the git path produces, so one
  // evaluateSizeGate serves both and the two can never drift.
  test("projects gh's file list into numstat files", () => {
    expect(
      parsePrFiles(
        '{"files":[{"path":"src/a.ts","additions":10,"deletions":2,' +
          '"changeType":"MODIFIED"},' +
          '{"path":"bun.lock","additions":900,"deletions":80,' +
          '"changeType":"MODIFIED"}]}',
      ),
    ).toEqual([
      { path: "src/a.ts", insertions: 10, deletions: 2, binary: false },
      { path: "bun.lock", insertions: 900, deletions: 80, binary: false },
    ]);
  });

  test("an empty file list is a valid shape", () => {
    expect(parsePrFiles('{"files":[]}')).toEqual([]);
  });

  test("invalid JSON, wrong shapes and bad fields all fail loud", () => {
    expect(() => parsePrFiles("not json")).toThrow(CliUsageError);
    expect(() => parsePrFiles("[]")).toThrow(CliUsageError);
    expect(() => parsePrFiles('{"files":"x"}')).toThrow(CliUsageError);
    expect(() =>
      parsePrFiles('{"files":[{"additions":1,"deletions":1}]}'),
    ).toThrow(CliUsageError);
    expect(() =>
      parsePrFiles('{"files":[{"path":"a","deletions":1}]}'),
    ).toThrow(CliUsageError);
  });
});

describe("parseMarkerHead", () => {
  test("reads the declared head off a new-format comment", () => {
    expect(
      parseMarkerHead(`<!-- pr-hero-report head=${HEAD_A} -->\n\n## review`),
    ).toBe(HEAD_A);
  });

  test("a marker-only body with no newline still parses", () => {
    expect(parseMarkerHead(`<!-- pr-hero-report head=${HEAD_A} -->`)).toBe(
      HEAD_A,
    );
  });

  // THE eligibility rule: an old-format marker declares NO head, so it
  // covers none — the PR stays eligible and the next post upgrades the
  // comment in place.
  test("the legacy headless marker declares no head", () => {
    expect(parseMarkerHead("<!-- pr-hero-report -->\n\n## review")).toBeNull();
  });

  test("malformed declarations never parse and never throw", () => {
    expect(parseMarkerHead("<!-- pr-hero-report head=abc123 -->")).toBeNull();
    expect(
      parseMarkerHead(`<!-- pr-hero-report head=${HEAD_A.toUpperCase()} -->`),
    ).toBeNull();
    expect(parseMarkerHead("<!-- pr-hero-report head= -->")).toBeNull();
  });

  // Foreign comment bodies are arbitrary text; the guard must shrug, not
  // crash — this is the never-throw contract.
  test("foreign bodies are null", () => {
    expect(parseMarkerHead("LGTM")).toBeNull();
    expect(parseMarkerHead("")).toBeNull();
    expect(parseMarkerHead("<!-- linear-linkback -->")).toBeNull();
    expect(parseMarkerHead("<!-- pr-hero-reporter -->")).toBeNull();
    expect(
      parseMarkerHead(`quoted:\n<!-- pr-hero-report head=${HEAD_A} -->`),
    ).toBeNull();
  });

  test("markerDeclaredHeads collects only real declarations", () => {
    expect(
      markerDeclaredHeads([
        { body: "LGTM" },
        { body: `<!-- pr-hero-report head=${HEAD_A} -->\nbody` },
        { body: "<!-- pr-hero-report -->\nold format" },
        { body: `<!-- pr-hero-report head=${HEAD_B} -->` },
      ]),
    ).toEqual([HEAD_A, HEAD_B]);
  });

  // The two marker facts differ exactly on the legacy headless marker: it
  // declares no head (heads stay empty) yet proves a review happened
  // (markerSeen true) — the fact the one-review-per-PR default consumes.
  test("markerCommentSeen sees any marker, headless included", () => {
    expect(
      markerCommentSeen([{ body: "<!-- pr-hero-report -->\nold format" }]),
    ).toBe(true);
    expect(
      markerCommentSeen([
        { body: `<!-- pr-hero-report head=${HEAD_A} -->\nbody` },
      ]),
    ).toBe(true);
    expect(
      markerCommentSeen([
        { body: "LGTM" },
        { body: "<!-- linear-linkback -->" },
        { body: "<!-- pr-hero-reporter -->" },
        { body: `quoted:\n<!-- pr-hero-report head=${HEAD_A} -->` },
      ]),
    ).toBe(false);
    expect(markerCommentSeen([])).toBe(false);
  });
});

describe("attempts counting", () => {
  test("parsePipelineMeta reads pr and head_sha", () => {
    expect(
      parsePipelineMeta(`{"pr":5,"head_sha":"${HEAD_A}","steps":[]}`),
    ).toEqual({ pr: 5, head_sha: HEAD_A });
  });

  // pr 0 is local mode's schema-legal "not a PR" — it parses (the artifact
  // is fine) and simply never matches a real PR number.
  test("parsePipelineMeta accepts local-mode pr 0", () => {
    expect(parsePipelineMeta(`{"pr":0,"head_sha":"${HEAD_A}"}`)).toEqual({
      pr: 0,
      head_sha: HEAD_A,
    });
  });

  // Tolerant by design (see the WHY on countAttempts): a corrupt artifact
  // falls back to the dir-name count instead of bricking the watcher.
  test("parsePipelineMeta is null on anything malformed, never a throw", () => {
    expect(parsePipelineMeta("not json")).toBeNull();
    expect(parsePipelineMeta("[]")).toBeNull();
    expect(parsePipelineMeta('{"pr":"5","head_sha":"x"}')).toBeNull();
    expect(parsePipelineMeta(`{"pr":5,"head_sha":"abc123"}`)).toBeNull();
    expect(parsePipelineMeta(`{"head_sha":"${HEAD_A}"}`)).toBeNull();
  });

  test("parsed pipeline fields are the preferred source", () => {
    const dirs = [
      // Counted: meta matches, regardless of what the name says.
      { name: "whatever-1", pipelineMeta: { pr: 5, head_sha: HEAD_A } },
      // NOT counted: parsed fields win over a matching dir name.
      {
        name: `pr-5-${HEAD_A.slice(0, 8)}-2`,
        pipelineMeta: { pr: 6, head_sha: HEAD_B },
      },
    ];
    expect(countAttempts(dirs, 5, HEAD_A)).toBe(1);
  });

  // The fallback exists for runs that died before the pipeline wrote
  // anything: the dir NAME still encodes pr + sha8.
  test("a dir without pipeline.json counts by its name", () => {
    const dirs = [
      { name: `pr-5-${HEAD_A.slice(0, 8)}-1`, pipelineMeta: null },
      { name: `pr-5-${HEAD_A.slice(0, 8)}-2`, pipelineMeta: null },
      { name: `pr-5-${HEAD_B.slice(0, 8)}-1`, pipelineMeta: null },
      { name: `pr-6-${HEAD_A.slice(0, 8)}-1`, pipelineMeta: null },
      { name: `${HEAD_A.slice(0, 8)}-1`, pipelineMeta: null },
      { name: "notes", pipelineMeta: null },
    ];
    expect(countAttempts(dirs, 5, HEAD_A)).toBe(2);
  });

  test("the two sources mix", () => {
    const dirs = [
      {
        name: `pr-5-${HEAD_A.slice(0, 8)}-1`,
        pipelineMeta: { pr: 5, head_sha: HEAD_A },
      },
      { name: `pr-5-${HEAD_A.slice(0, 8)}-2`, pipelineMeta: null },
    ];
    expect(countAttempts(dirs, 5, HEAD_A)).toBe(2);
  });

  test("latestRunDirName picks the highest suffix", () => {
    const names = [
      `pr-5-${HEAD_A.slice(0, 8)}-1`,
      `pr-5-${HEAD_A.slice(0, 8)}-3`,
      `pr-5-${HEAD_A.slice(0, 8)}-2`,
      `pr-5-${HEAD_B.slice(0, 8)}-9`,
    ];
    expect(latestRunDirName(names, 5, HEAD_A)).toBe(
      `pr-5-${HEAD_A.slice(0, 8)}-3`,
    );
    expect(latestRunDirName(names, 7, HEAD_A)).toBeNull();
  });

  test("findingsTierCounts splits blocking from the rest", () => {
    expect(
      findingsTierCounts({
        findings: [
          { tier: "blocking" },
          { tier: "advisory" },
          { tier: "advisory" },
        ],
      }),
    ).toEqual({ blocking: 1, advisory: 2 });
    expect(findingsTierCounts({ findings: [] })).toEqual({
      blocking: 0,
      advisory: 0,
    });
    expect(findingsTierCounts(null)).toBeNull();
    expect(findingsTierCounts({ findings: "x" })).toBeNull();
    expect(findingsTierCounts({ findings: [null] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The tick decision.

// Size counters default to 0 (a trivially small PR): the size gate is
// evaluated by the SHELL and handed in through TickRepoFacts.tooLarge, so
// these fields only matter to the parser's own tests.
function cand(
  pr: number,
  head: string,
  isDraft = false,
  size: Partial<
    Pick<WatchPrCandidate, "additions" | "deletions" | "changedFiles">
  > = {},
): WatchPrCandidate {
  return {
    pr,
    head,
    isDraft,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    ...size,
  };
}

function repo(overrides: Partial<TickRepoFacts> = {}): TickRepoFacts {
  return {
    path: "/x/musive",
    post: false,
    // The config default: one review per PR. Tests of the re-arm behavior
    // opt in explicitly, mirroring what an operator must do.
    onPush: false,
    prs: [],
    localReviews: [],
    remoteHeads: [],
    attempts: [],
    tooLarge: [],
    ...overrides,
  };
}

function tick(overrides: Partial<TickInput> = {}): TickInput {
  return {
    repos: [],
    dailyCap: 5,
    launchedToday: 0,
    window: null,
    localMinutes: 12 * 60,
    ...overrides,
  };
}

describe("tickGate", () => {
  test("window closes before the cap is even consulted", () => {
    expect(
      tickGate({
        window: { start: "09:00", end: "19:00" },
        localMinutes: 8 * 60,
        dailyCap: 5,
        launchedToday: 5,
      }),
    ).toBe("window-closed");
  });

  // The cap boundary: 4 of 5 still runs, 5 of 5 does not.
  test("the cap boundary is exact", () => {
    const base = { window: null, localMinutes: 0 };
    expect(tickGate({ ...base, dailyCap: 5, launchedToday: 4 })).toBe("open");
    expect(tickGate({ ...base, dailyCap: 5, launchedToday: 5 })).toBe(
      "cap-reached",
    );
  });

  test("a zero cap never opens", () => {
    expect(
      tickGate({
        window: null,
        localMinutes: 0,
        dailyCap: 0,
        launchedToday: 0,
      }),
    ).toBe("cap-reached");
  });
});

describe("decideTick", () => {
  test("the eligibility matrix, one candidate each", () => {
    const decision = decideTick(
      tick({
        repos: [
          repo({
            prs: [
              cand(1, HEAD_A, true),
              cand(2, HEAD_A, false),
              cand(3, HEAD_A, false),
              cand(4, HEAD_A, false),
              cand(5, HEAD_A, false),
            ],
            localReviews: [{ pr: 2, head: HEAD_A }],
            remoteHeads: [{ pr: 3, heads: [HEAD_A], markerSeen: true }],
            attempts: [{ pr: 4, head: HEAD_A, count: MAX_WATCH_ATTEMPTS }],
          }),
        ],
      }),
    );
    expect(decision.gate).toBe("open");
    expect(decision.skips).toEqual([
      { repo: "/x/musive", pr: 1, head: HEAD_A, reason: "draft" },
      { repo: "/x/musive", pr: 2, head: HEAD_A, reason: "reviewed-local" },
      { repo: "/x/musive", pr: 3, head: HEAD_A, reason: "reviewed-remote" },
      { repo: "/x/musive", pr: 4, head: HEAD_A, reason: "attempts-exhausted" },
    ]);
    expect(decision.launch).toEqual({
      repo: "/x/musive",
      post: false,
      pr: 5,
      head: HEAD_A,
    });
  });

  // The re-arm policy, both modes over the SAME facts (a PR reviewed at an
  // old head, pushed to a new one). Under on_push a new push mints a new
  // (pr, head) key and every guard keyed on the old head releases — with
  // auto-post the comment tracks the live head. Under the default each PR
  // is reviewed once: the very same prior review now blocks as
  // reviewed-prior-head, and a push never re-bills.
  test("a new head re-arms the PR only under on_push", () => {
    const facts = {
      prs: [cand(2, HEAD_B, false)],
      localReviews: [{ pr: 2, head: HEAD_A }],
      remoteHeads: [{ pr: 2, heads: [HEAD_A], markerSeen: true }],
      attempts: [{ pr: 2, head: HEAD_A, count: 2 }],
    };
    const rearmed = decideTick(
      tick({ repos: [repo({ ...facts, onPush: true })] }),
    );
    expect(rearmed.skips).toEqual([]);
    expect(rearmed.launch?.pr).toBe(2);
    expect(rearmed.launch?.head).toBe(HEAD_B);

    const once = decideTick(tick({ repos: [repo(facts)] }));
    expect(once.launch).toBeNull();
    expect(once.skips).toEqual([
      { repo: "/x/musive", pr: 2, head: HEAD_B, reason: "reviewed-prior-head" },
    ]);
  });

  // ---------------------------------------------------------------------
  // The size gate's skip. It is a COST skip, and the three properties below
  // are what keep it from behaving like a review or a failure.

  test("a too-large candidate is skipped, never launched", () => {
    const decision = decideTick(
      tick({
        repos: [repo({ prs: [cand(4, HEAD_A)], tooLarge: [4] })],
      }),
    );
    expect(decision.skips).toEqual([
      { repo: "/x/musive", pr: 4, head: HEAD_A, reason: "too-large" },
    ]);
    expect(decision.eligible).toEqual([]);
    expect(decision.launch).toBeNull();
  });

  test("only the listed PR is skipped; the rest of the queue still runs", () => {
    const decision = decideTick(
      tick({
        repos: [
          repo({ prs: [cand(4, HEAD_A), cand(6, HEAD_B)], tooLarge: [4] }),
        ],
      }),
    );
    expect(decision.skips.map((s) => s.pr)).toEqual([4]);
    expect(decision.launch?.pr).toBe(6);
  });

  // Ordering: an already-reviewed PR reads as reviewed, not as too-large —
  // the reason a human sees in the log must be the one that actually
  // settled it, and "reviewed" is the more informative of the two.
  test("a reviewed PR keeps its reviewed reason even when oversized", () => {
    expect(
      decideTick(
        tick({
          repos: [
            repo({
              prs: [cand(4, HEAD_A)],
              localReviews: [{ pr: 4, head: HEAD_A }],
              tooLarge: [4],
            }),
          ],
        }),
      ).skips[0]?.reason,
    ).toBe("reviewed-local");
  });

  // (a) It must NOT consume an attempt. MAX_WATCH_ATTEMPTS is the poison-PR
  // guard; an oversized PR is not a failing review, and a skip that ate an
  // attempt would permanently retire a PR after two ticks.
  test("(a) a too-large skip does not consume an attempt", () => {
    const facts = { prs: [cand(4, HEAD_A)], tooLarge: [4] };
    // Ticking it again and again never moves the reason toward exhaustion,
    // because decideTick reads attempts and never writes them.
    for (let i = 0; i < MAX_WATCH_ATTEMPTS + 3; i++) {
      const decision = decideTick(tick({ repos: [repo(facts)] }));
      expect(decision.skips[0]?.reason).toBe("too-large");
    }
    // And the attempts guard, when it does apply, is untouched by the gate:
    // the same PR under the attempts cap still reads as exhausted.
    expect(
      decideTick(
        tick({
          repos: [
            repo({
              prs: [cand(4, HEAD_A)],
              attempts: [{ pr: 4, head: HEAD_A, count: MAX_WATCH_ATTEMPTS }],
            }),
          ],
        }),
      ).skips[0]?.reason,
    ).toBe("attempts-exhausted");
  });

  // (b) It writes no review marker, so a force-push that SHRINKS the PR
  // makes it eligible again on the very next tick. The verdict lives only
  // in tooLarge, which the shell recomputes from live counters each tick.
  test("(b) a shrunk PR becomes eligible again with no state to clear", () => {
    const prs = [cand(4, HEAD_A)];
    expect(
      decideTick(tick({ repos: [repo({ prs, tooLarge: [4] })] })).launch,
    ).toBeNull();
    // Next tick, same PR, same head, now under the limits: nothing had to
    // be forgotten for it to run.
    expect(
      decideTick(tick({ repos: [repo({ prs, tooLarge: [] })] })).launch?.pr,
    ).toBe(4);
  });

  // (c) It does not arm the on_push "one review per PR" state. That state
  // is armed by a comparison.json or a marker comment — both of which only
  // a review that RAN produces — so under the default policy a previously
  // skipped PR is still a first review, not a repeat.
  test("(c) a too-large skip never arms the one-review-per-PR state", () => {
    // The skip leaves no local review and no marker behind…
    const after = repo({
      prs: [cand(4, HEAD_A)],
      localReviews: [],
      remoteHeads: [],
      tooLarge: [],
    });
    const decision = decideTick(tick({ repos: [after] }));
    // …so on the default (on_push: false) policy it launches, rather than
    // reading as reviewed-prior-head.
    expect(after.onPush).toBe(false);
    expect(decision.skips).toEqual([]);
    expect(decision.launch?.pr).toBe(4);
  });

  // The local half alone also blocks under the default: any comparison.json
  // with the same PR number, whatever head it reviewed.
  test("a local prior-head review blocks without on_push, by itself", () => {
    const facts = {
      prs: [cand(7, HEAD_B, false)],
      localReviews: [{ pr: 7, head: HEAD_A }],
    };
    expect(decideTick(tick({ repos: [repo(facts)] })).skips[0]?.reason).toBe(
      "reviewed-prior-head",
    );
    expect(
      decideTick(tick({ repos: [repo({ ...facts, onPush: true })] })).launch
        ?.pr,
    ).toBe(7);
  });

  // The same-head reasons stay themselves under the default: prior-head is
  // only the DIFFERENT-head verdict, never a relabeling of same-head.
  test("same-head reasons win over reviewed-prior-head", () => {
    const local = decideTick(
      tick({
        repos: [
          repo({
            prs: [cand(2, HEAD_A, false)],
            localReviews: [{ pr: 2, head: HEAD_A }],
          }),
        ],
      }),
    );
    expect(local.skips[0]?.reason).toBe("reviewed-local");
    const remote = decideTick(
      tick({
        repos: [
          repo({
            prs: [cand(3, HEAD_A, false)],
            remoteHeads: [{ pr: 3, heads: [HEAD_A], markerSeen: true }],
          }),
        ],
      }),
    );
    expect(remote.skips[0]?.reason).toBe("reviewed-remote");
  });

  // THE legacy-headless-marker asymmetry: it declares no head, so it can
  // never prove THIS head was covered (on_push keeps it non-blocking, as
  // always) — but it does prove the PR was reviewed, which is all the
  // one-review-per-PR default asks.
  test("a headless legacy marker blocks only without on_push", () => {
    const facts = {
      prs: [cand(9, HEAD_A, false)],
      remoteHeads: [{ pr: 9, heads: [], markerSeen: true }],
    };
    const rearmed = decideTick(
      tick({ repos: [repo({ ...facts, onPush: true })] }),
    );
    expect(rearmed.launch?.pr).toBe(9);

    const once = decideTick(tick({ repos: [repo(facts)] }));
    expect(once.launch).toBeNull();
    expect(once.skips[0]?.reason).toBe("reviewed-prior-head");
  });

  // No prior review anywhere: the default is exactly as eager as on_push.
  test("an unreviewed PR is eligible in both modes", () => {
    for (const onPush of [false, true]) {
      const decision = decideTick(
        tick({
          repos: [
            repo({
              onPush,
              prs: [cand(11, HEAD_A, false)],
              remoteHeads: [{ pr: 11, heads: [], markerSeen: false }],
            }),
          ],
        }),
      );
      expect(decision.launch?.pr).toBe(11);
    }
  });

  test("one attempt left still runs; the guard is a maximum of two", () => {
    const decision = decideTick(
      tick({
        repos: [
          repo({
            prs: [cand(4, HEAD_A, false)],
            attempts: [{ pr: 4, head: HEAD_A, count: 1 }],
          }),
        ],
      }),
    );
    expect(decision.launch?.pr).toBe(4);
  });

  test("FIFO: the lowest PR number wins across repos", () => {
    const decision = decideTick(
      tick({
        repos: [
          repo({
            path: "/x/alpha",
            prs: [cand(12, HEAD_A, false)],
          }),
          repo({
            path: "/x/beta",
            post: true,
            prs: [cand(3, HEAD_B, false), cand(8, HEAD_C, false)],
          }),
        ],
      }),
    );
    expect(decision.launch).toEqual({
      repo: "/x/beta",
      post: true,
      pr: 3,
      head: HEAD_B,
    });
    expect(decision.eligible.map((e) => e.pr)).toEqual([3, 8, 12]);
  });

  // Two repos can share a PR number; the stable sort makes config order the
  // tie-break — the operator's own priority order.
  test("a PR-number tie breaks by config order", () => {
    const decision = decideTick(
      tick({
        repos: [
          repo({
            path: "/x/first",
            prs: [cand(5, HEAD_A, false)],
          }),
          repo({
            path: "/x/second",
            prs: [cand(5, HEAD_B, false)],
          }),
        ],
      }),
    );
    expect(decision.launch?.repo).toBe("/x/first");
  });

  // The gate nulls the launch but never hides the picture: the $0 dry run
  // still shows what would have run.
  test("a closed gate keeps skips and eligible visible", () => {
    const decision = decideTick(
      tick({
        window: { start: "09:00", end: "19:00" },
        localMinutes: 20 * 60,
        repos: [
          repo({
            prs: [cand(1, HEAD_A, true), cand(2, HEAD_B, false)],
          }),
        ],
      }),
    );
    expect(decision.gate).toBe("window-closed");
    expect(decision.launch).toBeNull();
    expect(decision.skips).toHaveLength(1);
    expect(decision.eligible.map((e) => e.pr)).toEqual([2]);
  });

  test("cap-reached also nulls the launch", () => {
    const decision = decideTick(
      tick({
        dailyCap: 5,
        launchedToday: 5,
        repos: [repo({ prs: [cand(2, HEAD_B, false)] })],
      }),
    );
    expect(decision.gate).toBe("cap-reached");
    expect(decision.launch).toBeNull();
    expect(decision.eligible).toHaveLength(1);
  });

  test("no candidates anywhere is an open gate with a null launch", () => {
    const decision = decideTick(tick({ repos: [repo()] }));
    expect(decision.gate).toBe("open");
    expect(decision.launch).toBeNull();
    expect(decision.skips).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The log — builders and the counter that reads them back.

describe("watch log", () => {
  test("localIsoTimestamp is local ISO-8601 with a numeric offset", () => {
    const d = new Date(2026, 7, 11, 14, 3, 22); // local components in, local out
    const ts = localIsoTimestamp(d);
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(ts.startsWith("2026-08-11T14:03:22")).toBe(true);
  });

  test("launchedLine carries pr, repo and the 8-char head", () => {
    expect(launchedLine("2026-08-11T14:03:22+02:00", 5, "musive", HEAD_A)).toBe(
      `2026-08-11T14:03:22+02:00 launched pr=5 repo=musive head=${HEAD_A.slice(0, 8)}`,
    );
  });

  // The round-trip that makes the log the cap counter: builder-written
  // lines count, and ONLY today's.
  test("countLaunchedToday counts only today's launched lines", () => {
    const logText = [
      logLine("2026-08-10T23:59:00+02:00", "tick start"),
      launchedLine("2026-08-10T23:59:01+02:00", 4, "musive", HEAD_A),
      logLine("2026-08-11T09:00:00+02:00", "tick start"),
      launchedLine("2026-08-11T09:00:01+02:00", 5, "musive", HEAD_A),
      skipLine("2026-08-11T09:15:00+02:00", "musive", 6, HEAD_B, "draft"),
      launchedLine("2026-08-11T10:00:01+02:00", 6, "musive", HEAD_B),
      outcomeLine("2026-08-11T10:20:00+02:00", "musive", {
        pr: 6,
        ok: true,
        exitCode: 0,
        counts: { blocking: 1, advisory: 0 },
      }),
      "garbage line that parses as nothing",
      "",
    ].join("\n");
    expect(countLaunchedToday(logText, "2026-08-11")).toBe(2);
    expect(countLaunchedToday(logText, "2026-08-10")).toBe(1);
    expect(countLaunchedToday(logText, "2026-08-12")).toBe(0);
    expect(countLaunchedToday("", "2026-08-11")).toBe(0);
  });

  // Only the literal `launched` token after the timestamp counts — a free
  // text line that merely mentions the word must not inflate the cap.
  test("non-launched events never count", () => {
    const logText = [
      logLine("2026-08-11T09:00:00+02:00", "tick idle reason=window-closed"),
      logLine("2026-08-11T09:10:00+02:00", "note: launched nothing today"),
      logLine("2026-08-11T09:20:00+02:00", "tick end launched=0 skipped=2"),
    ].join("\n");
    expect(countLaunchedToday(logText, "2026-08-11")).toBe(0);
  });

  test("skip and outcome lines carry their fields", () => {
    expect(skipLine("T", "musive", 7, HEAD_B, "reviewed-remote")).toBe(
      `T skip repo=musive pr=7 head=${HEAD_B.slice(0, 8)} reason=reviewed-remote`,
    );
    expect(
      outcomeLine("T", "musive", {
        pr: 7,
        ok: true,
        exitCode: 0,
        counts: { blocking: 2, advisory: 1 },
      }),
    ).toBe("T outcome pr=7 repo=musive status=ok blocking=2 advisory=1");
    expect(
      outcomeLine("T", "musive", {
        pr: 7,
        ok: false,
        exitCode: 3,
        counts: null,
      }),
    ).toBe("T outcome pr=7 repo=musive status=failed exit=3");
  });
});

describe("parseLockPid", () => {
  test("a bare PID parses, anything else is null", () => {
    expect(parseLockPid("12345\n")).toBe(12345);
    expect(parseLockPid("  67  ")).toBe(67);
    expect(parseLockPid("")).toBeNull();
    expect(parseLockPid("0")).toBeNull();
    expect(parseLockPid("-3")).toBeNull();
    expect(parseLockPid("pid 12")).toBeNull();
  });
});

describe("renderWatchPlist", () => {
  const input = {
    runtimePath: "/Users/x/.bun/bin/bun",
    entryPath: "/Users/x/Desktop/pr-hero/src/cli.ts",
    intervalSeconds: 900,
    logPath: "/Users/x/.prhero/launchd.log",
    pathEnv: "/opt/homebrew/bin:/usr/bin:/bin",
  };

  test("program arguments are absolute runtime + entry + watch --once", () => {
    const plist = renderWatchPlist(input);
    expect(plist).toContain(`<string>${WATCH_LAUNCHD_LABEL}</string>`);
    expect(plist).toContain(
      "    <string>/Users/x/.bun/bin/bun</string>\n" +
        "    <string>/Users/x/Desktop/pr-hero/src/cli.ts</string>\n" +
        "    <string>watch</string>\n" +
        "    <string>--once</string>",
    );
    expect(plist).toContain("<integer>900</integer>");
    expect(plist.endsWith("\n")).toBe(true);
  });

  // The launchd trap this file exists to disarm: gh/codegraph/claude/bun
  // are not on launchd's default PATH, so the captured PATH ships in the
  // plist, and process output goes to the SEPARATE launchd.log so watch.log
  // stays a parseable cap counter.
  test("the captured PATH and the separate process log are wired in", () => {
    const plist = renderWatchPlist(input);
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<string>/opt/homebrew/bin:/usr/bin:/bin</string>");
    const stdoutKey = plist.indexOf("<key>StandardOutPath</key>");
    const stderrKey = plist.indexOf("<key>StandardErrorPath</key>");
    expect(stdoutKey).toBeGreaterThan(-1);
    expect(stderrKey).toBeGreaterThan(-1);
    expect(plist).toContain("<string>/Users/x/.prhero/launchd.log</string>");
  });

  test("XML-hostile characters in paths are escaped", () => {
    const plist = renderWatchPlist({
      ...input,
      pathEnv: "/a&b:/c<d>:/usr/bin",
    });
    expect(plist).toContain("<string>/a&amp;b:/c&lt;d&gt;:/usr/bin</string>");
  });
});

describe("notification", () => {
  test("osascript args escape AppleScript string hazards", () => {
    expect(
      osascriptNotifyArgs("pr-hero", 'PR #5: 1 blocking, "quoted"'),
    ).toEqual([
      "osascript",
      "-e",
      'display notification "PR #5: 1 blocking, \\"quoted\\"" with title "pr-hero"',
    ]);
    expect(osascriptNotifyArgs("t", "back\\slash")).toEqual([
      "osascript",
      "-e",
      'display notification "back\\\\slash" with title "t"',
    ]);
  });

  test("outcome text: counts, countless success, failure", () => {
    expect(
      outcomeNotificationText({
        pr: 5,
        ok: true,
        exitCode: 0,
        counts: { blocking: 1, advisory: 2 },
      }),
    ).toBe("PR #5: 1 blocking, 2 advisory");
    expect(
      outcomeNotificationText({ pr: 5, ok: true, exitCode: 0, counts: null }),
    ).toBe("PR #5 reviewed (counts unavailable)");
    expect(
      outcomeNotificationText({ pr: 5, ok: false, exitCode: 3, counts: null }),
    ).toBe("PR #5 review failed (exit 3)");
  });
});

describe("prheroHomePaths", () => {
  test("every watcher path hangs off one home", () => {
    const paths = prheroHomePaths("/Users/x");
    expect(paths).toEqual({
      dir: "/Users/x/.prhero",
      configPath: "/Users/x/.prhero/watch.json",
      logPath: "/Users/x/.prhero/watch.log",
      lockPath: "/Users/x/.prhero/watch.lock",
      launchdLogPath: "/Users/x/.prhero/launchd.log",
      plistPath: `/Users/x/Library/LaunchAgents/${WATCH_LAUNCHD_LABEL}.plist`,
    });
  });
});

// ---------------------------------------------------------------------------
// Config management (watch add/remove/status).

describe("parseArgs watch add/remove/status", () => {
  test("the three verbs parse", () => {
    expect(parseArgs(["watch", "add"]).options.watch).toBe("add");
    expect(parseArgs(["watch", "remove"]).options.watch).toBe("remove");
    expect(parseArgs(["watch", "status"]).options.watch).toBe("status");
  });

  test("add takes --post and --repo", () => {
    const { options } = parseArgs(["watch", "add", "--post", "--repo", "/x"]);
    expect(options.watch).toBe("add");
    expect(options.post).toBe(true);
    expect(options.repo).toBe("/x");
  });

  test("--post defaults to false on add", () => {
    expect(parseArgs(["watch", "add"]).options.post).toBe(false);
  });

  test("--on-push parses on add and defaults to false", () => {
    expect(parseArgs(["watch", "add", "--on-push"]).options.onPush).toBe(true);
    expect(parseArgs(["watch", "add"]).options.onPush).toBe(false);
    const both = parseArgs(["watch", "add", "--post", "--on-push"]).options;
    expect(both.post).toBe(true);
    expect(both.onPush).toBe(true);
  });

  // Same silently-dropped-intention rule as --post: --on-push means
  // something only on the add path.
  test("--on-push is rejected everywhere else, naming watch add", () => {
    for (const argv of [
      ["watch", "--once", "--on-push"],
      ["watch", "remove", "--on-push"],
      ["watch", "status", "--on-push"],
      ["watch", "install", "--on-push"],
      ["review", "--on-push"],
    ]) {
      try {
        parseArgs(argv);
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(CliUsageError);
        expect((error as Error).message).toContain("--on-push");
        expect((error as Error).message).toContain("watch add");
      }
    }
  });

  // --post configures the repo being added; anywhere else in the watch
  // surface it would be a silently dropped intention.
  test("--post is rejected on every other watch action", () => {
    for (const action of ["--once", "remove", "status", "install"]) {
      try {
        parseArgs(["watch", action, "--post"]);
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(CliUsageError);
        expect((error as Error).message).toContain("--post");
        expect((error as Error).message).toContain("add");
      }
    }
  });

  // The review-side contract is untouched: --post still requires --pr.
  test("review --post still requires --pr", () => {
    expect(() => parseArgs(["review", "--post"])).toThrow(CliUsageError);
  });

  test("remove takes --repo", () => {
    expect(parseArgs(["watch", "remove", "--repo", "/x"]).options.repo).toBe(
      "/x",
    );
  });

  test("--dry-run is rejected on the config verbs", () => {
    for (const action of ["add", "remove", "status"]) {
      expect(() => parseArgs(["watch", action, "--dry-run"])).toThrow(
        CliUsageError,
      );
    }
  });

  test("the verbs conflict with --once and each other", () => {
    expect(() => parseArgs(["watch", "add", "--once"])).toThrow(CliUsageError);
    expect(() => parseArgs(["watch", "add", "status"])).toThrow(CliUsageError);
  });

  test("the verbs are not commands of their own", () => {
    for (const word of ["add", "remove", "status"]) {
      expect(() => parseArgs([word])).toThrow(CliUsageError);
    }
  });
});

describe("contractTilde", () => {
  const HOME = "/Users/juanma";

  test("contracts home and its children", () => {
    expect(contractTilde("/Users/juanma", HOME)).toBe("~");
    expect(contractTilde("/Users/juanma/Desktop/x", HOME)).toBe("~/Desktop/x");
  });

  test("leaves foreign paths and lookalikes alone", () => {
    expect(contractTilde("/opt/repo", HOME)).toBe("/opt/repo");
    // A sibling that merely shares the prefix must not contract.
    expect(contractTilde("/Users/juanmartin/x", HOME)).toBe(
      "/Users/juanmartin/x",
    );
  });

  test("round-trips through expandTilde", () => {
    for (const p of ["/Users/juanma", "/Users/juanma/Desktop/musive-s3"]) {
      expect(expandTilde(contractTilde(p, HOME), HOME)).toBe(p);
    }
  });
});

describe("upsertWatchRepo", () => {
  const HOME = "/Users/juanma";
  const REPO = "/Users/juanma/Desktop/musive-s3";
  const FLAGS = {
    post: true,
    onPush: false,
    maxChangedLines: DEFAULT_SIZE_GATE.maxChangedLines,
    maxChangedFiles: DEFAULT_SIZE_GATE.maxChangedFiles,
  };
  const SIZE_KEYS = {
    max_changed_lines: DEFAULT_SIZE_GATE.maxChangedLines,
    max_changed_files: DEFAULT_SIZE_GATE.maxChangedFiles,
  };

  test("no config yet: creates one with the shipped defaults", () => {
    const result = upsertWatchRepo(null, REPO, FLAGS, HOME);
    expect(result.action).toBe("added");
    expect(result.storedPath).toBe("~/Desktop/musive-s3");
    expect(JSON.parse(result.config)).toEqual({
      repos: [
        {
          path: "~/Desktop/musive-s3",
          post: true,
          on_push: false,
          ...SIZE_KEYS,
        },
      ],
      daily_cap: DEFAULT_DAILY_CAP,
      window: null,
    });
    expect(result.config.endsWith("\n")).toBe(true);
    // The created file must satisfy its own parser — same round-trip rule
    // as initConfigTemplate.
    expect(() => parseWatchConfig(result.config)).not.toThrow();
  });

  test("appends to an existing config, everything else untouched", () => {
    const raw = JSON.stringify({
      repos: [{ path: "~/other", post: true }],
      daily_cap: 3,
      window: { start: "09:00", end: "19:00" },
    });
    const result = upsertWatchRepo(
      raw,
      REPO,
      { ...FLAGS, post: false, onPush: true },
      HOME,
    );
    expect(result.action).toBe("added");
    expect(JSON.parse(result.config)).toEqual({
      repos: [
        { path: "~/other", post: true },
        {
          path: "~/Desktop/musive-s3",
          post: false,
          on_push: true,
          ...SIZE_KEYS,
        },
      ],
      daily_cap: 3,
      window: { start: "09:00", end: "19:00" },
    });
  });

  // Idempotency: `~/x` in the file and a resolved `/Users/juanma/x` are the
  // same repo — the flags update in place, never a duplicate entry. An
  // absent flag RESETS (the command line states the whole intent), so a
  // re-add without --on-push turns the re-arm off — disclosed semantics,
  // same as --post.
  test("re-adding a listed repo updates both flags in place", () => {
    const raw = JSON.stringify({
      repos: [{ path: "~/Desktop/musive-s3", post: false, on_push: true }],
    });
    const result = upsertWatchRepo(raw, REPO, FLAGS, HOME);
    expect(result.action).toBe("updated");
    expect(result.storedPath).toBe("~/Desktop/musive-s3");
    expect(JSON.parse(result.config)).toEqual({
      repos: [
        {
          path: "~/Desktop/musive-s3",
          post: true,
          on_push: false,
          ...SIZE_KEYS,
        },
      ],
    });
  });

  // A legacy entry that predates on_push gains the key on update.
  test("updating a legacy entry stamps on_push explicitly", () => {
    const raw = JSON.stringify({
      repos: [{ path: "~/Desktop/musive-s3", post: true }],
    });
    const result = upsertWatchRepo(
      raw,
      REPO,
      { ...FLAGS, post: true, onPush: true },
      HOME,
    );
    expect(JSON.parse(result.config)).toEqual({
      repos: [
        {
          path: "~/Desktop/musive-s3",
          post: true,
          on_push: true,
          ...SIZE_KEYS,
        },
      ],
    });
  });

  // parseWatchConfig tolerates unknown keys, so the rewrite must PRESERVE
  // them — top-level and per-repo alike; a canonical re-projection would be
  // silent data loss.
  test("unknown keys survive the rewrite, at both levels", () => {
    const raw = JSON.stringify({
      repos: [{ path: "~/Desktop/musive-s3", post: false, note: "prod" }],
      daily_cap: 5,
      future_key: { keep: "me" },
    });
    const result = upsertWatchRepo(raw, REPO, FLAGS, HOME);
    expect(result.action).toBe("updated");
    expect(JSON.parse(result.config)).toEqual({
      repos: [
        {
          path: "~/Desktop/musive-s3",
          post: true,
          on_push: false,
          ...SIZE_KEYS,
          note: "prod",
        },
      ],
      daily_cap: 5,
      future_key: { keep: "me" },
    });
  });

  test("a repo outside home stays absolute", () => {
    const result = upsertWatchRepo(
      null,
      "/opt/repo",
      { ...FLAGS, post: false, onPush: false },
      HOME,
    );
    expect(result.storedPath).toBe("/opt/repo");
  });

  // A malformed config fails loud instead of being "repaired" into loss.
  test("a malformed existing config is never rewritten", () => {
    expect(() => upsertWatchRepo("not json", REPO, FLAGS, HOME)).toThrow(
      CliUsageError,
    );
    expect(() => upsertWatchRepo('{"repos":"x"}', REPO, FLAGS, HOME)).toThrow(
      CliUsageError,
    );
  });
});

describe("removeWatchRepo", () => {
  const HOME = "/Users/juanma";
  const REPO = "/Users/juanma/Desktop/musive-s3";

  test("removes the entry however the config spells it", () => {
    const raw = JSON.stringify({
      repos: [
        { path: "~/Desktop/musive-s3", post: true },
        { path: "~/other", post: false },
      ],
      daily_cap: 2,
    });
    const result = removeWatchRepo(raw, REPO, HOME);
    expect(result.action).toBe("removed");
    expect(JSON.parse(result.config as string)).toEqual({
      repos: [{ path: "~/other", post: false }],
      daily_cap: 2,
    });
  });

  // Removing the last repo leaves repos: [] — a valid "watch nothing"
  // state; the cap and window settings survive.
  test("removing the last repo keeps the config, empty", () => {
    const raw = JSON.stringify({
      repos: [{ path: "~/Desktop/musive-s3", post: true }],
      daily_cap: 2,
      window: null,
    });
    const result = removeWatchRepo(raw, REPO, HOME);
    expect(result.action).toBe("removed");
    const parsed = JSON.parse(result.config as string);
    expect(parsed.repos).toEqual([]);
    expect(parsed.daily_cap).toBe(2);
    expect(() => parseWatchConfig(result.config as string)).not.toThrow();
  });

  // Idempotent: not listed is an answer, not an error — and config: null
  // means the caller does not even rewrite (reformat) the file.
  test("a repo that is not listed reports not-listed and changes nothing", () => {
    const raw = JSON.stringify({ repos: [{ path: "~/other", post: false }] });
    const result = removeWatchRepo(raw, REPO, HOME);
    expect(result.action).toBe("not-listed");
    expect(result.config).toBeNull();
  });

  test("a malformed config fails loud", () => {
    expect(() => removeWatchRepo("not json", REPO, HOME)).toThrow(
      CliUsageError,
    );
  });
});

describe("watch status pure pieces", () => {
  test("parsePlistInterval round-trips renderWatchPlist", () => {
    const plist = renderWatchPlist({
      runtimePath: "/b/bun",
      entryPath: "/x/cli.ts",
      intervalSeconds: 900,
      logPath: "/x/l.log",
      pathEnv: "/usr/bin",
    });
    expect(parsePlistInterval(plist)).toBe(900);
  });

  // Tolerant by contract: a hand-edited or foreign plist reads as
  // "unreadable", never a throw.
  test("parsePlistInterval is null on anything else", () => {
    expect(parsePlistInterval("")).toBeNull();
    expect(parsePlistInterval("<plist></plist>")).toBeNull();
    expect(
      parsePlistInterval("<key>StartInterval</key>\n<string>soon</string>"),
    ).toBeNull();
    expect(
      parsePlistInterval("<key>StartInterval</key>\n<integer>0</integer>"),
    ).toBeNull();
  });

  test("lastLogActivity returns the FINAL launched and outcome lines", () => {
    const logText = [
      launchedLine("2026-08-10T09:00:00+02:00", 4, "musive", HEAD_A),
      outcomeLine("2026-08-10T09:20:00+02:00", "musive", {
        pr: 4,
        ok: false,
        exitCode: 1,
        counts: null,
      }),
      logLine("2026-08-11T09:00:00+02:00", "tick start"),
      launchedLine("2026-08-11T09:00:01+02:00", 5, "musive", HEAD_B),
      outcomeLine("2026-08-11T09:25:00+02:00", "musive", {
        pr: 5,
        ok: true,
        exitCode: 0,
        counts: { blocking: 1, advisory: 2 },
      }),
    ].join("\n");
    expect(lastLogActivity(logText)).toEqual({
      launched: launchedLine("2026-08-11T09:00:01+02:00", 5, "musive", HEAD_B),
      outcome: outcomeLine("2026-08-11T09:25:00+02:00", "musive", {
        pr: 5,
        ok: true,
        exitCode: 0,
        counts: { blocking: 1, advisory: 2 },
      }),
    });
  });

  test("an empty or eventless log yields nulls", () => {
    expect(lastLogActivity("")).toEqual({ launched: null, outcome: null });
    expect(
      lastLogActivity(logLine("2026-08-11T09:00:00+02:00", "tick start")),
    ).toEqual({ launched: null, outcome: null });
  });
});

describe("renderWatchStatus", () => {
  const BASE = {
    configPath: "/Users/x/.prhero/watch.json",
    config: {
      repos: [
        {
          path: "~/Desktop/musive-s3",
          post: true,
          onPush: false,
          maxChangedLines: DEFAULT_SIZE_GATE.maxChangedLines,
          maxChangedFiles: DEFAULT_SIZE_GATE.maxChangedFiles,
        },
      ],
      dailyCap: 5,
      window: { start: "09:00", end: "19:00" },
    },
    configError: null,
    launchedToday: 2,
    plistPath: "/Users/x/Library/LaunchAgents/io.prhero.watch.plist",
    installed: true,
    intervalSeconds: 900,
    lockPid: null,
    lastLaunched: "T launched pr=5 repo=musive head=bbbbbbbb",
    lastOutcome: "T outcome pr=5 repo=musive status=ok blocking=1 advisory=2",
  };

  test("the full healthy picture", () => {
    const text = renderWatchStatus(BASE).join("\n");
    expect(text).toContain("/Users/x/.prhero/watch.json");
    expect(text).toContain("~/Desktop/musive-s3 post=true on_push=false");
    expect(text).toContain("2 of 5 launches used");
    expect(text).toContain("09:00-19:00");
    expect(text).toContain("installed — one tick every 15 min");
    expect(text).toContain("lock         free");
    expect(text).toContain("T launched pr=5");
    expect(text).toContain("T outcome pr=5");
  });

  test("no config points at watch add and still counts the log", () => {
    const text = renderWatchStatus({
      ...BASE,
      config: null,
      launchedToday: 1,
    }).join("\n");
    expect(text).toContain("none (/Users/x/.prhero/watch.json)");
    expect(text).toContain("watch add");
    expect(text).toContain("1 launched");
  });

  // A broken config is REPORTED, never thrown over — status is the tool
  // for looking at broken setups.
  test("an invalid config renders as INVALID with the parse error", () => {
    const text = renderWatchStatus({
      ...BASE,
      config: null,
      configError: 'watch.json "repos" must be an array, got: "x"',
    }).join("\n");
    expect(text).toContain("INVALID");
    expect(text).toContain('"repos" must be an array');
  });

  test("zero watched repos names the empty state", () => {
    const text = renderWatchStatus({
      ...BASE,
      config: { repos: [], dailyCap: 5, window: null },
    }).join("\n");
    expect(text).toContain("no repos watched");
    expect(text).toContain("always");
  });

  test("launchd states: not installed, unreadable interval", () => {
    expect(
      renderWatchStatus({
        ...BASE,
        installed: false,
        intervalSeconds: null,
      }).join("\n"),
    ).toContain('not installed — run "pr-hero watch install"');
    expect(
      renderWatchStatus({ ...BASE, intervalSeconds: null }).join("\n"),
    ).toContain("interval unreadable");
  });

  test("a held lock and an empty history are named", () => {
    const text = renderWatchStatus({
      ...BASE,
      lockPid: 4242,
      lastLaunched: null,
      lastOutcome: null,
    }).join("\n");
    expect(text).toContain("held by pid 4242");
    expect(text).toContain("none recorded");
  });
});

// The empty-repos tolerance, pinned on both halves: the parser accepts it
// and a tick over zero repos is an open gate with nothing to do.
describe("empty repos is a valid watch-nothing state", () => {
  test("parseWatchConfig accepts repos: []", () => {
    expect(parseWatchConfig('{"repos":[]}').repos).toEqual([]);
  });

  test("decideTick over zero repos launches nothing, loudly-nothing", () => {
    const decision = decideTick(tick({ repos: [] }));
    expect(decision.gate).toBe("open");
    expect(decision.skips).toEqual([]);
    expect(decision.eligible).toEqual([]);
    expect(decision.launch).toBeNull();
  });
});
