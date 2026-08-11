import { describe, expect, test } from "bun:test";
import {
  agentsDirProblems,
  assertBasenameOnly,
  assertOutsideRepo,
  CliUsageError,
  DEFAULT_BASE_REF,
  DEFAULT_HOP_BUDGET,
  defaultRunRoot,
  emptyDiffMessage,
  headContainedInBaseMessage,
  initConfigTemplate,
  isFullCommitId,
  localReviewSpec,
  parseArgs,
  parseLocalConfig,
  parseNumstat,
  parseRemoteHead,
  resolveAgentsDirSetting,
  resolveBaseRef,
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
      dryRun: false,
      yes: false,
      post: false,
      twoDot: false,
      onPush: false,
    });
    expect(options.base).toBeUndefined();
  });

  test("init is a command, and unknown commands still fail", () => {
    expect(parseArgs(["init"]).command).toBe("init");
    expect(parseArgs(["init", "--repo", "/tmp/x"]).options.repo).toBe("/tmp/x");
    expect(() => parseArgs(["initialise"])).toThrow(CliUsageError);
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
    expect(options.yes).toBe(true);
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

describe("run dir naming", () => {
  test("the default root is a sibling of the repo", () => {
    expect(defaultRunRoot("/Users/x/Desktop/musive")).toBe(
      "/Users/x/Desktop/musive-prhero-runs",
    );
  });

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
