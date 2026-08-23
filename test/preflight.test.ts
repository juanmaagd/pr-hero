import { describe, expect, test } from "bun:test";
import {
  agentsDirProblems,
  allExcludedMessage,
  assertBasenameOnly,
  assertOutsideRepo,
  CliUsageError,
  DEFAULT_BASE_REF,
  DEFAULT_HOP_BUDGET,
  DEFAULT_MAX_VERIFICATION_STEPS,
  DEFAULT_SUMMARY_MODEL,
  emptyDiffMessage,
  headContainedInBaseMessage,
  initConfigTemplate,
  isFullCommitId,
  listPaths,
  localReviewSpec,
  parseArgs,
  parseLocalConfig,
  parseNumstat,
  parseNumstatFiles,
  parseRemoteHead,
  repoWebUrlFromRemote,
  resolveAgentsDirSetting,
  resolveBaseRef,
  resolveMaxVerificationSteps,
  resolveSummary,
  runDirCandidate,
} from "../src/preflight";
import { validateReviewSpec } from "../src/spec";

describe("parseArgs", () => {
  // `base` is deliberately ABSENT here: resolving the repo's real default
  // branch needs git, parseArgs is pure, so an unset base is the honest
  // answer and cli.ts finishes the job. A literal "main" baked in here is a
  // wrong ref nothing downstream can tell apart from one the user chose.
  test("defaults are the documented ones, and base is left unset", () => {
    const { command, options } = parseArgs(["review"]);
    expect(command).toBe("review");
    expect(options).toEqual({
      repo: ".",
      head: "HEAD",
      hopBudget: DEFAULT_HOP_BUDGET,
      scout: false,
      full: false,
      dryRun: false,
      yes: false,
      post: false,
      twoDot: false,
      onPush: false,
      force: false,
      all: false,
      fixes: false,
      incidents: false,
      issues: false,
      proximity: false,
      threads: false,
    });
    expect(options.base).toBeUndefined();
    // Unset, never 0: 0 DISABLES a size limit, so it cannot double as
    // "not asked for".
    expect(options.maxChangedLines).toBeUndefined();
    expect(options.maxChangedFiles).toBeUndefined();
  });

  test("init is a command, and unknown commands still fail", () => {
    expect(parseArgs(["init"]).command).toBe("init");
    expect(parseArgs(["init", "--repo", "/tmp/x"]).options.repo).toBe("/tmp/x");
    expect(() => parseArgs(["initialise"])).toThrow(CliUsageError);
  });

  test("gc is a command, and --dry-run applies", () => {
    expect(parseArgs(["gc"]).command).toBe("gc");
    expect(parseArgs(["gc", "--dry-run"]).options.dryRun).toBe(true);
    expect(parseArgs(["gc", "--repo", "/tmp/x"]).options.repo).toBe("/tmp/x");
  });

  test("gc install, uninstall and status parse; --interval is install-only", () => {
    expect(parseArgs(["gc", "install"]).options.gc).toBe("install");
    expect(
      parseArgs(["gc", "install", "--interval", "60"]).options.interval,
    ).toBe(60);
    expect(parseArgs(["gc", "uninstall"]).options.gc).toBe("uninstall");
    expect(parseArgs(["gc", "status"]).options.gc).toBe("status");
    expect(() => parseArgs(["gc", "--interval", "60"])).toThrow(CliUsageError);
    expect(() => parseArgs(["gc", "install", "--dry-run"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["install"])).toThrow(CliUsageError);
  });

  // W4 / #23: usage is origin-scoped by default (spec "Origin-Scoped Usage
  // By Default"); --all is the operator-wide escape hatch and is valid on
  // NO other command (spec "--all misused on another command").
  test("usage is a command; --all applies only to usage", () => {
    expect(parseArgs(["usage"]).command).toBe("usage");
    expect(parseArgs(["usage"]).options.all).toBe(false);
    expect(parseArgs(["usage", "--all"]).options.all).toBe(true);
    expect(() => parseArgs(["gc", "--all"])).toThrow(CliUsageError);
    expect(() => parseArgs(["review", "--all"])).toThrow(CliUsageError);
  });

  // Both exist so a tree you cannot add a file to is still reviewable: an
  // in-tree-only gotchas file dirties the checkout (which the clean-tree gate
  // then rightly refuses), and an in-tree-only config silently disables the
  // conditional parity hunter, which looks exactly like parity finding nothing.
  test("gotchas and config can be supplied from outside the repo", () => {
    const { options } = parseArgs([
      "review",
      "--gotchas",
      "/elsewhere/gotchas.md",
      "--config",
      "/elsewhere/config.json",
    ]);
    expect(options.gotchas).toBe("/elsewhere/gotchas.md");
    expect(options.config).toBe("/elsewhere/config.json");
  });

  test("neither is set by default, so the in-repo paths win", () => {
    const { options } = parseArgs(["review"]);
    expect(options.gotchas).toBeUndefined();
    expect(options.config).toBeUndefined();
  });

  test("reads every option", () => {
    const { options } = parseArgs([
      "review",
      "--repo",
      "/tmp/repo",
      "--base",
      "release",
      "--head",
      "feature",
      "--agents",
      "/tmp/agents",
      "--out",
      "/tmp/runs",
      "--model",
      "opus",
      "--hop-budget",
      "4",
      "--two-dot",
      "--dry-run",
      "--summary",
      "--yes",
    ]);
    expect(options.twoDot).toBe(true);
    expect(options.repo).toBe("/tmp/repo");
    expect(options.base).toBe("release");
    expect(options.head).toBe("feature");
    expect(options.agents).toBe("/tmp/agents");
    expect(options.out).toBe("/tmp/runs");
    expect(options.model).toBe("opus");
    expect(options.hopBudget).toBe(4);
    expect(options.dryRun).toBe(true);
    expect(options.summary).toBe(true);
    expect(options.yes).toBe(true);
  });

  test("summary flags are explicit and last flag wins", () => {
    expect(parseArgs(["review", "--summary"]).options.summary).toBe(true);
    expect(parseArgs(["review", "--no-summary"]).options.summary).toBe(false);
    expect(
      parseArgs(["review", "--no-summary", "--summary"]).options.summary,
    ).toBe(true);
  });

  // ROADMAP-DOORDASH M5. The default is the milestone's exit criterion:
  // M6 compares an arm against a control, and a control that quietly grew a
  // stage is not a control.
  test("the scout is OFF unless asked for", () => {
    expect(parseArgs(["review"]).options.scout).toBe(false);
    expect(parseArgs(["review", "--scout"]).options.scout).toBe(true);
    expect(parseArgs(["review", "--scout"]).options.scoutModel).toBeUndefined();
    expect(
      parseArgs(["review", "--scout", "--scout-model", "haiku"]).options
        .scoutModel,
    ).toBe("haiku");
  });

  test("W-cli — --full is OFF unless asked for, and review-only", () => {
    expect(parseArgs(["review"]).options.full).toBe(false);
    expect(parseArgs(["review", "--full"]).options.full).toBe(true);
    expect(() => parseArgs(["watch", "--once", "--full"])).toThrow(
      "only applies to the review command",
    );
    expect(() => parseArgs(["ledger", "--full"])).toThrow(
      "only applies to the review command",
    );
  });

  test("--scout-model without --scout is a loud no-op, not a quiet one", () => {
    expect(() => parseArgs(["review", "--scout-model", "haiku"])).toThrow(
      "requires --scout",
    );
  });

  test("the scout flags belong to review and nothing else", () => {
    // The watcher spawns `review --pr <n> --yes` and never learns these
    // exist; a scout flag on any other verb is an operator believing they
    // changed a run they did not.
    expect(() => parseArgs(["watch", "--once", "--scout"])).toThrow(
      "only apply to the review command",
    );
    expect(() =>
      parseArgs(["ledger", "--scout", "--scout-model", "haiku"]),
    ).toThrow("only apply to the review command");
  });

  // The M5 exit criterion, pinned from the config side: the flag ships alone.
  // `.prhero/config.json` gets a scout seat only after M6 decides whether the
  // stage is worth defaulting on — and until then a config that tries is a
  // loud error, never a silently ignored key.
  test("the config file has no scout seat yet, and says so", () => {
    expect(() => parseLocalConfig('{"scout":{"enabled":true}}')).toThrow(
      "unknown key: scout",
    );
  });

  test("--scout-model never swallows the following flag", () => {
    expect(() =>
      parseArgs(["review", "--scout", "--scout-model", "--yes"]),
    ).toThrow("--scout-model needs a value");
  });

  test("--help wins wherever it appears", () => {
    expect(parseArgs(["--help"]).command).toBe("help");
    expect(parseArgs(["review", "--repo", "/tmp", "--help"]).command).toBe(
      "help",
    );
  });

  // A value flag that swallows the next FLAG is how you end up reviewing the
  // wrong tree while the plan output looks plausible.
  test("a value flag never swallows the following flag", () => {
    expect(() => parseArgs(["review", "--base", "--head", "x"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["review", "--agents"])).toThrow(CliUsageError);
  });

  test("rejects unknown options, unknown commands and no command", () => {
    expect(() => parseArgs(["review", "--nope"])).toThrow(CliUsageError);
    expect(() => parseArgs(["audit"])).toThrow(CliUsageError);
    expect(() => parseArgs([])).toThrow(CliUsageError);
    expect(() => parseArgs(["review", "extra"])).toThrow(CliUsageError);
  });

  test("--hop-budget must be a positive integer", () => {
    expect(() => parseArgs(["review", "--hop-budget", "0"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["review", "--hop-budget", "2.5"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["review", "--hop-budget", "many"])).toThrow(
      CliUsageError,
    );
  });

  // --force answers "is this diff too big to be worth its cost"; --yes
  // answers "do you want to spend this". One flag must never skip two
  // gates, so this is asserted rather than left to reading.
  test("--force does NOT imply --yes", () => {
    const { options } = parseArgs(["review", "--force"]);
    expect(options.force).toBe(true);
    expect(options.yes).toBe(false);
  });

  test("--yes does not imply --force either", () => {
    const { options } = parseArgs(["review", "--yes"]);
    expect(options.yes).toBe(true);
    expect(options.force).toBe(false);
  });

  test("the size-gate limits parse, and 0 survives as 0", () => {
    const { options } = parseArgs([
      "review",
      "--max-changed-lines",
      "800",
      "--max-changed-files",
      "0",
    ]);
    expect(options.maxChangedLines).toBe(800);
    // 0 DISABLES the limit — it must not be confused with "unset".
    expect(options.maxChangedFiles).toBe(0);
  });

  test("the size-gate limits reject negatives and non-integers", () => {
    for (const value of ["-1", "2.5", "many"]) {
      expect(() => parseArgs(["review", "--max-changed-lines", value])).toThrow(
        CliUsageError,
      );
      expect(() => parseArgs(["review", "--max-changed-files", value])).toThrow(
        CliUsageError,
      );
    }
  });

  test("the size-gate limits need a value and never swallow a flag", () => {
    expect(() => parseArgs(["review", "--max-changed-lines"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["review", "--max-changed-lines", "--yes"])).toThrow(
      CliUsageError,
    );
  });
});

describe("parseRemoteHead", () => {
  test("strips the remote prefix", () => {
    expect(parseRemoteHead("refs/remotes/origin/dev\n")).toBe("dev");
    expect(parseRemoteHead("refs/remotes/origin/release/2026-08")).toBe(
      "release/2026-08",
    );
  });

  // A repo whose origin/HEAD was never set answers with nothing, and
  // `symbolic-ref --quiet` exits 1. That is a normal local-only clone, not an
  // error — so it must come back as "no remote head", never as a ref.
  test("anything that is not that shape is no remote head", () => {
    expect(parseRemoteHead("")).toBeUndefined();
    expect(parseRemoteHead("refs/remotes/origin/")).toBeUndefined();
    expect(parseRemoteHead("refs/heads/dev")).toBeUndefined();
    expect(parseRemoteHead("refs/remotes/upstream/main")).toBeUndefined();
  });
});

// The terminal's clickable links stand or fall on this parser, and the whole
// point of deriving the url from the remote (instead of a `gh` call) is that it
// costs nothing on a run without --post. A silent miss here is a run with no
// links at all, so every shape a real github remote takes is pinned.
describe("repoWebUrlFromRemote", () => {
  test("ssh, https and ssh:// all normalise to the same canonical url", () => {
    const canonical = "https://github.com/musive/pr-hero";
    for (const remote of [
      "git@github.com:musive/pr-hero.git",
      "git@github.com:musive/pr-hero",
      "https://github.com/musive/pr-hero.git",
      "https://github.com/musive/pr-hero",
      "https://github.com/musive/pr-hero/",
      "ssh://git@github.com/musive/pr-hero.git",
      "  https://github.com/musive/pr-hero.git\n",
    ]) {
      expect(repoWebUrlFromRemote(remote)).toBe(canonical);
    }
  });

  // A guessed url is strictly worse than none: one 404 teaches the reader to
  // stop trusting every link in the block.
  test("anything not a github repo remote yields NO url, never a guess", () => {
    for (const remote of [
      "",
      "   ",
      "git@gitlab.com:musive/pr-hero.git",
      "https://gitlab.com/musive/pr-hero.git",
      "git@github.example.com:musive/pr-hero.git",
      "https://github.com/musive",
      "https://github.com/",
      "/srv/git/pr-hero.git",
      "not a url at all",
    ]) {
      expect(repoWebUrlFromRemote(remote)).toBeUndefined();
    }
  });

  test("the host check is case-insensitive, the slug is left alone", () => {
    expect(repoWebUrlFromRemote("git@GitHub.com:Musive/PR-Hero.git")).toBe(
      "https://github.com/Musive/PR-Hero",
    );
  });
});

describe("resolveBaseRef", () => {
  test("the flag wins over everything", () => {
    expect(
      resolveBaseRef({
        flag: "release",
        configDefaultBase: "dev",
        remoteHead: "trunk",
      }),
    ).toEqual({ ref: "release", source: "flag" });
  });

  test("then the config, then the remote head", () => {
    expect(
      resolveBaseRef({ configDefaultBase: "dev", remoteHead: "trunk" }),
    ).toEqual({ ref: "dev", source: "config" });
    expect(resolveBaseRef({ remoteHead: "trunk" })).toEqual({
      ref: "trunk",
      source: "remote",
    });
  });

  // "main" is the LAST resort, and it is reported as such: a hardcoded default
  // branch silently reviews the wrong range on any repo that does not use it.
  test("main is the last resort and says so", () => {
    expect(resolveBaseRef({})).toEqual({
      ref: DEFAULT_BASE_REF,
      source: "fallback",
    });
  });

  test("an empty string is not a choice", () => {
    expect(resolveBaseRef({ flag: "", configDefaultBase: "dev" }).ref).toBe(
      "dev",
    );
  });
});

describe("resolveAgentsDirSetting", () => {
  test("the flag wins, resolved against cwd", () => {
    expect(
      resolveAgentsDirSetting({
        flag: "agents",
        configAgentsDir: "/from/config",
        env: "/from/env",
        cwd: "/work",
      }),
    ).toEqual({ dir: "/work/agents", source: "flag" });
  });

  // THE point of the key: the config names a prompt set in a sibling repo, so
  // a relative path travels with the CONFIG FILE. Reading it against cwd would
  // make one config mean different prompt sets depending on which
  // subdirectory the developer happened to be standing in.
  test("a relative config path resolves against the config file's dir", () => {
    expect(
      resolveAgentsDirSetting({
        // Two levels up: the config lives in <repo>/.prhero/, so a sibling
        // repo is `../../` from there, not `../`.
        configAgentsDir: "../../deep-review/agents/clean",
        configDir: "/Users/x/Desktop/musive/.prhero",
        env: "/from/env",
        cwd: "/somewhere/else",
      }),
    ).toEqual({
      dir: "/Users/x/Desktop/deep-review/agents/clean",
      source: "config",
    });
  });

  test("an absolute config path is taken as is", () => {
    expect(
      resolveAgentsDirSetting({
        configAgentsDir: "/abs/agents",
        configDir: "/repo/.prhero",
        cwd: "/work",
      }).dir,
    ).toBe("/abs/agents");
  });

  test("the env var is the last fallback before the hard error", () => {
    expect(resolveAgentsDirSetting({ env: "/from/env", cwd: "/work" })).toEqual(
      { dir: "/from/env", source: "env" },
    );
    expect(() => resolveAgentsDirSetting({ cwd: "/work" })).toThrow(
      CliUsageError,
    );
  });

  test("the error names all three ways to fix it", () => {
    try {
      resolveAgentsDirSetting({ cwd: "/work" });
      throw new Error("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("--agents");
      expect(message).toContain("agents_dir");
      expect(message).toContain("PRHERO_AGENTS_DIR");
    }
  });
});

describe("range messages", () => {
  // The already-merged branch is the case the merge-base default was written
  // for, so its message must name that cause rather than leave a human
  // wondering whether the tool broke.
  test("the contained-in-base message names the cause", () => {
    const message = headContainedInBaseMessage("dev", "feature");
    expect(message).toContain("already contained in base");
    expect(message).toContain("--two-dot");
  });

  test("the empty-diff message reflects which range was used", () => {
    expect(emptyDiffMessage("dev", "HEAD", false)).toContain("dev...HEAD");
    expect(emptyDiffMessage("dev", "HEAD", true)).toContain("dev..HEAD");
  });
});

describe("isFullCommitId", () => {
  test("only a full 40-hex id passes", () => {
    expect(isFullCommitId("a".repeat(40))).toBe(true);
    expect(isFullCommitId(`${"a".repeat(40)}\n`)).toBe(true);
    expect(isFullCommitId("a50594a")).toBe(false);
    expect(isFullCommitId("A".repeat(40))).toBe(false);
    expect(isFullCommitId("main")).toBe(false);
    expect(isFullCommitId("")).toBe(false);
  });
});

describe("parseNumstat", () => {
  test("sums insertions and deletions per file", () => {
    const stat = parseNumstat("10\t2\tsrc/a.ts\n0\t7\tsrc/b.ts\n");
    expect(stat).toEqual({ files: 2, insertions: 10, deletions: 9 });
  });

  // A binary file counts as a changed file but contributes no lines; reading
  // its `-` counters as NaN would poison the cost estimate.
  test("a binary file counts as a file with zero lines", () => {
    const stat = parseNumstat("-\t-\tassets/logo.png\n3\t1\tsrc/a.ts\n");
    expect(stat).toEqual({ files: 2, insertions: 3, deletions: 1 });
  });

  test("empty and malformed lines are ignored", () => {
    expect(parseNumstat("")).toEqual({
      files: 0,
      insertions: 0,
      deletions: 0,
    });
    expect(parseNumstat("\n\ngarbage\n")).toEqual({
      files: 0,
      insertions: 0,
      deletions: 0,
    });
  });
});

describe("parseNumstatFiles", () => {
  test("keeps the path beside the per-file counters", () => {
    expect(parseNumstatFiles("10\t2\tsrc/a.ts\n0\t7\tsrc/b.ts\n")).toEqual([
      { path: "src/a.ts", insertions: 10, deletions: 2, binary: false },
      { path: "src/b.ts", insertions: 0, deletions: 7, binary: false },
    ]);
  });

  test("a binary file is flagged, counted as a file, and worth zero lines", () => {
    expect(parseNumstatFiles("-\t-\tassets/logo.png\n")).toEqual([
      {
        path: "assets/logo.png",
        insertions: 0,
        deletions: 0,
        binary: true,
      },
    ]);
  });

  // Renames arrive in two shapes, and BOTH must resolve to the destination:
  // the path is matched against exclusion globs, so `src/{a => b}/x.min.js`
  // matching nothing would silently un-exclude a generated file.
  test("a whole-path rename resolves to the destination", () => {
    expect(
      parseNumstatFiles("4\t4\told/dir/name.ts => new/dir/name.ts\n")[0]?.path,
    ).toBe("new/dir/name.ts");
  });

  test("a braced rename resolves to the destination", () => {
    expect(parseNumstatFiles("4\t4\tsrc/{old => new}/file.ts\n")[0]?.path).toBe(
      "src/new/file.ts",
    );
  });

  // The one-sided braced forms leave an empty segment behind; the doubled
  // separator must be collapsed or no glob will ever match.
  test("one-sided braced renames collapse the empty segment", () => {
    expect(parseNumstatFiles("1\t1\tsrc/{ => sub}/file.ts\n")[0]?.path).toBe(
      "src/sub/file.ts",
    );
    expect(parseNumstatFiles("1\t1\tsrc/{old => }/file.ts\n")[0]?.path).toBe(
      "src/file.ts",
    );
  });

  test("a renamed lockfile is still recognisable as a lockfile", () => {
    expect(parseNumstatFiles("9\t9\t{ => web}/bun.lock\n")[0]?.path).toBe(
      "web/bun.lock",
    );
  });

  // git C-quotes any non-ASCII path by default (`core.quotepath`), and the
  // quotes alone make every exclusion glob miss. Unquoting must happen AFTER
  // rename resolution, because git quotes only the side that needs it.
  test("a C-quoted path is unquoted to its real name", () => {
    expect(
      parseNumstatFiles('1\t0\t"canci\\303\\263n.min.js"\n')[0]?.path,
    ).toBe("canción.min.js");
  });

  test("a whole-path rename unquotes its quoted destination", () => {
    expect(
      parseNumstatFiles('4\t4\ta.min.js => "canci\\303\\263n.min.js"\n')[0]
        ?.path,
    ).toBe("canción.min.js");
  });

  // git abandons the brace form entirely when either side needs quoting, so
  // this branch is never quoted and the unquote is a harmless no-op.
  test("a braced rename is unaffected by the unquoting", () => {
    expect(
      parseNumstatFiles("4\t4\tsrc/{old => nueva}/f.min.js\n")[0]?.path,
    ).toBe("src/nueva/f.min.js");
  });

  test("an ordinary ASCII path is left exactly as it is", () => {
    expect(parseNumstatFiles("3\t1\tsrc/a.min.js\n")[0]?.path).toBe(
      "src/a.min.js",
    );
  });

  test("blank and malformed lines are ignored", () => {
    expect(parseNumstatFiles("")).toEqual([]);
    expect(parseNumstatFiles("\n\ngarbage\n")).toEqual([]);
  });

  // The aggregate is a pure sum over this, so the two can never disagree.
  test("parseNumstat is the sum of parseNumstatFiles", () => {
    const raw = "10\t2\tsrc/a.ts\n-\t-\tlogo.png\n0\t7\tsrc/{a => b}/c.ts\n";
    const files = parseNumstatFiles(raw);
    expect(parseNumstat(raw)).toEqual({
      files: files.length,
      insertions: files.reduce((n, f) => n + f.insertions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    });
  });
});

describe("run dir naming", () => {
  test("candidates are numbered from the short sha", () => {
    const root = "/Users/x/Desktop/musive-prhero-runs";
    expect(runDirCandidate(root, "a".repeat(40), 1)).toBe(`${root}/aaaaaaaa-1`);
    expect(runDirCandidate(root, "a".repeat(40), 2)).toBe(`${root}/aaaaaaaa-2`);
  });

  // Artifacts inside the reviewed tree show up in the hunters' own Grep
  // results — a review that reads its own prompts is contaminated.
  test("a run dir inside the repo is rejected", () => {
    expect(() => assertOutsideRepo("/repo/runs", "/repo")).toThrow(
      CliUsageError,
    );
    expect(() => assertOutsideRepo("/repo", "/repo")).toThrow(CliUsageError);
    expect(() => assertOutsideRepo("/repo/.prhero/x", "/repo")).toThrow(
      CliUsageError,
    );
  });

  test("a sibling run dir is accepted", () => {
    expect(() =>
      assertOutsideRepo("/repo-prhero-runs/x", "/repo"),
    ).not.toThrow();
    expect(() => assertOutsideRepo("/tmp/runs", "/repo")).not.toThrow();
  });
});

describe("assertBasenameOnly", () => {
  test("plain basenames pass", () => {
    expect(() =>
      assertBasenameOnly("deep-review-reliability.md", 0),
    ).not.toThrow();
  });

  test("anything that could escape agentsDir throws", () => {
    for (const file of [
      "../evil.md",
      "nested/agent.md",
      "/etc/passwd",
      "a\\b.md",
    ]) {
      expect(() => assertBasenameOnly(file, 0)).toThrow(CliUsageError);
    }
  });
});

describe("agentsDirProblems", () => {
  const CLEAN_SET = [
    "deep-review-lifecycle.md",
    "deep-review-parity.md",
    "deep-review-reliability.md",
    "deep-review-resilience.md",
    "review-refuter.md",
  ];

  test("a matching set has no problems", () => {
    expect(agentsDirProblems(CLEAN_SET, CLEAN_SET)).toEqual([]);
  });

  test("a file the spec names but the dir lacks is reported", () => {
    const problems = agentsDirProblems(
      CLEAN_SET,
      CLEAN_SET.filter((f) => f !== "deep-review-parity.md"),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("deep-review-parity.md");
  });

  // THE check: the default 4-agent spec against the 5-file clean set silently
  // drops the lifecycle hunter, and nothing downstream notices.
  test("an unreferenced agent file in the dir is reported", () => {
    const fourAgentSpec = CLEAN_SET.filter(
      (f) => f !== "deep-review-lifecycle.md",
    );
    const problems = agentsDirProblems(fourAgentSpec, CLEAN_SET);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("deep-review-lifecycle.md");
    expect(problems[0]).toContain("would never run");
  });

  test("problems are sorted, so the message is deterministic", () => {
    const problems = agentsDirProblems(["b.md", "a.md"], ["c.md"]);
    expect(problems).toEqual([...problems].sort());
    expect(problems).toHaveLength(3);
  });
});

describe("localReviewSpec", () => {
  test("is valid and carries the lifecycle hunter the default spec omits", () => {
    const spec = validateReviewSpec(localReviewSpec());
    const keys = spec.agents.map((a) => a.key);
    expect(keys).toEqual([
      "reliability",
      "resilience",
      "lifecycle",
      "parity",
      "refuter",
    ]);
    expect(spec.agents.find((a) => a.key === "parity")?.trigger).toBe("input");
    expect(spec.agents.filter((a) => a.role === "refuter")).toHaveLength(1);
  });

  test("every agent file is a plain basename", () => {
    for (const [i, agent] of localReviewSpec().agents.entries()) {
      expect(() => assertBasenameOnly(agent.file, i)).not.toThrow();
    }
  });
});

describe("parseLocalConfig", () => {
  test("both keys are optional", () => {
    expect(parseLocalConfig("{}")).toEqual({
      parity_trigger_paths: [],
      suspicion_priors: [],
    });
  });

  test("reads a full config", () => {
    const config = parseLocalConfig(
      JSON.stringify({
        parity_trigger_paths: ["**/Auth*"],
        suspicion_priors: [
          { path: "src/a.ts", weight: "high", reason: "touched" },
          { path: "src/b.ts", weight: 3, reason: "hot" },
        ],
      }),
    );
    expect(config.parity_trigger_paths).toEqual(["**/Auth*"]);
    expect(config.suspicion_priors).toHaveLength(2);
  });

  test("agents_dir and default_base are read when present", () => {
    const config = parseLocalConfig(
      JSON.stringify({
        agents_dir: "../deep-review/agents/clean",
        default_base: "dev",
      }),
    );
    expect(config.agents_dir).toBe("../deep-review/agents/clean");
    expect(config.default_base).toBe("dev");
  });

  test("both new keys are optional", () => {
    const config = parseLocalConfig("{}");
    expect(config.agents_dir).toBeUndefined();
    expect(config.default_base).toBeUndefined();
  });

  // Same discipline as the array keys: a wrong-typed or blank value read as
  // "absent" is how a config silently stops configuring anything.
  test("a malformed agents_dir or default_base throws", () => {
    expect(() => parseLocalConfig('{"agents_dir": 3}')).toThrow(CliUsageError);
    expect(() => parseLocalConfig('{"agents_dir": "  "}')).toThrow(
      CliUsageError,
    );
    expect(() => parseLocalConfig('{"default_base": ""}')).toThrow(
      CliUsageError,
    );
  });

  // A typo'd key read as "no triggers" is exactly how the parity hunter stops
  // firing without anyone noticing.
  test("malformed shapes throw instead of degrading silently", () => {
    expect(() => parseLocalConfig("not json")).toThrow(CliUsageError);
    expect(() => parseLocalConfig("[]")).toThrow(CliUsageError);
    expect(() =>
      parseLocalConfig('{"parity_trigger_paths": "**/Auth*"}'),
    ).toThrow(CliUsageError);
    expect(() => parseLocalConfig('{"parity_trigger_paths": [""]}')).toThrow(
      CliUsageError,
    );
    expect(() => parseLocalConfig('{"suspicion_priors": [{}]}')).toThrow(
      CliUsageError,
    );
    expect(() =>
      parseLocalConfig('{"suspicion_priors": [{"path":"a","weight":1}]}'),
    ).toThrow(CliUsageError);
  });

  test("summary settings are optional and preserve supplied values", () => {
    expect(parseLocalConfig('{"summary": {}}').summary).toEqual({});
    expect(
      parseLocalConfig(
        JSON.stringify({ summary: { enabled: false, model: "opus" } }),
      ).summary,
    ).toEqual({ enabled: false, model: "opus" });
  });

  test("summary validation is strict, including typos", () => {
    for (const raw of [
      '{"summary": null}',
      '{"summary": []}',
      '{"summary": {"enabled": "false"}}',
      '{"summary": {"model": "  "}}',
      '{"summry": {"enabled": false}}',
      '{"summary": {"enabeld": false}}',
    ]) {
      expect(() => parseLocalConfig(raw)).toThrow(CliUsageError);
    }
  });

  test("summary activation resolves flag over config over default-on", () => {
    const config = parseLocalConfig(
      JSON.stringify({ summary: { enabled: false, model: "opus" } }),
    );
    expect(resolveSummary({}, parseLocalConfig("{}")).enabled).toBe(true);
    expect(resolveSummary({}, config)).toEqual({
      enabled: false,
      model: "opus",
    });
    expect(resolveSummary({ summary: true }, config)).toEqual({
      enabled: true,
      model: "opus",
    });
    expect(resolveSummary({ summary: false }, config)).toEqual({
      enabled: false,
      model: "opus",
    });
    expect(resolveSummary({ model: "sonnet" }, config)).toEqual({
      enabled: false,
      model: "sonnet",
    });
  });

  test("max_verification_steps is optional; absent resolves to the default", () => {
    expect(parseLocalConfig("{}").max_verification_steps).toBeUndefined();
    expect(resolveMaxVerificationSteps(parseLocalConfig("{}"))).toBe(
      DEFAULT_MAX_VERIFICATION_STEPS,
    );
    expect(
      parseLocalConfig('{"max_verification_steps": 3}').max_verification_steps,
    ).toBe(3);
    expect(
      resolveMaxVerificationSteps(
        parseLocalConfig('{"max_verification_steps": 0}'),
      ),
    ).toBe(0);
    expect(() => parseLocalConfig('{"max_verification_steps": -1}')).toThrow(
      CliUsageError,
    );
    expect(() => parseLocalConfig('{"max_verification_steps": 1.5}')).toThrow(
      CliUsageError,
    );
  });
});

describe("initConfigTemplate", () => {
  // A scaffold its own parser rejects is a bug that only shows up on someone
  // else's machine, on their first ever command.
  test("what init writes round-trips through parseLocalConfig", () => {
    const raw = initConfigTemplate({
      agentsDir: "/Users/x/Desktop/deep-review/agents/clean",
      defaultBase: "dev",
    });
    const config = parseLocalConfig(raw);
    expect(config).toEqual({
      agents_dir: "/Users/x/Desktop/deep-review/agents/clean",
      default_base: "dev",
      summary: { enabled: true, model: DEFAULT_SUMMARY_MODEL },
      parity_trigger_paths: [],
      suspicion_priors: [],
    });
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("the written values are what a review would then resolve", () => {
    const config = parseLocalConfig(
      initConfigTemplate({ agentsDir: "/abs/agents", defaultBase: "trunk" }),
    );
    expect(
      resolveAgentsDirSetting({
        configAgentsDir: config.agents_dir,
        configDir: "/repo/.prhero",
        cwd: "/work",
      }).dir,
    ).toBe("/abs/agents");
    expect(resolveBaseRef({ configDefaultBase: config.default_base })).toEqual({
      ref: "trunk",
      source: "config",
    });
  });
});

describe("allExcludedMessage", () => {
  // The all-excluded case is a "nothing to review" exit, not a review of an
  // empty patch — the message has to make it obvious no money moved.
  test("names the excluded paths and that nothing was spent", () => {
    const message = allExcludedMessage(["bun.lock", "go.sum"]);
    expect(message).toContain("bun.lock, go.sum");
    expect(message).toContain("nothing to review");
    expect(message).toContain("nothing was spent");
  });

  test("a long list is truncated rather than dumped", () => {
    const message = allExcludedMessage(
      Array.from({ length: 9 }, (_, i) => `pkg/${i}/bun.lock`),
    );
    expect(message).toContain("+4 more");
    expect(message).not.toContain("pkg/8/bun.lock");
  });
});

describe("listPaths", () => {
  test("short lists are printed whole", () => {
    expect(listPaths(["a", "b"])).toBe("a, b");
  });

  test("the limit is exact", () => {
    expect(listPaths(["a", "b", "c"], 3)).toBe("a, b, c");
    expect(listPaths(["a", "b", "c", "d"], 3)).toBe("a, b, c, +1 more");
  });
});
