import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceReadBroker } from "../../src/security/workspace-read-broker";

interface CapturedSpawn {
  argv: string[];
  env?: Record<string, string>;
}

function capturingSpawn(registry: CapturedSpawn[]): typeof Bun.spawn {
  const encoder = new TextEncoder();
  return ((
    _argv: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ) => {
    registry.push({ argv: _argv, env: opts?.env });
    return {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("ok\n"));
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      exited: Promise.resolve(0),
    };
  }) as unknown as typeof Bun.spawn;
}

describe("WorkspaceReadBroker authorization", () => {
  let rootDir: string;
  let outsideDir: string;
  let broker: WorkspaceReadBroker;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "pr-hero-ws-root-"));
    outsideDir = await mkdtemp(path.join(tmpdir(), "pr-hero-ws-outside-"));

    rootDir = await realpath(rootDir);
    outsideDir = await realpath(outsideDir);

    await mkdir(path.join(rootDir, "src", "nested"), { recursive: true });
    await writeFile(
      path.join(rootDir, "src", "index.ts"),
      "export const x = 1;",
    );
    await writeFile(
      path.join(rootDir, "src", "nested", "deep.ts"),
      "export const deep = true;",
    );
    await writeFile(path.join(outsideDir, "secret.txt"), "classified");

    broker = new WorkspaceReadBroker({ workspaceRoot: rootDir });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
  });

  test("relative and absolute in-root aliases normalize to the same canonical path", async () => {
    const target = path.join(rootDir, "src", "index.ts");
    const canonicalTarget = await realpath(target);

    const relResult = broker.authorizePath("src/index.ts");
    const dotRelResult = broker.authorizePath("./src/index.ts");
    const absResult = broker.authorizePath(target);
    const complexResult = broker.authorizePath(
      path.join(rootDir, "src", "nested", "..", "index.ts"),
    );

    expect(relResult.approved).toBe(true);
    expect(dotRelResult.approved).toBe(true);
    expect(absResult.approved).toBe(true);
    expect(complexResult.approved).toBe(true);

    if (
      relResult.approved &&
      dotRelResult.approved &&
      absResult.approved &&
      complexResult.approved
    ) {
      expect(relResult.canonicalPath).toBe(canonicalTarget);
      expect(dotRelResult.canonicalPath).toBe(canonicalTarget);
      expect(absResult.canonicalPath).toBe(canonicalTarget);
      expect(complexResult.canonicalPath).toBe(canonicalTarget);
    }
  });

  test("absolute paths outside the repository are rejected with path_not_approved", async () => {
    const outsideFile = path.join(outsideDir, "secret.txt");
    const result = broker.authorizePath(outsideFile);

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.code).toBe("path_not_approved");
    }
  });

  test("relative traversal whose realpath escapes the repository is rejected", async () => {
    const escapingRelPath = `../${path.basename(outsideDir)}/secret.txt`;
    const result = broker.authorizePath(escapingRelPath);

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.code).toBe("path_not_approved");
    }
  });

  test("an in-repository symlink pointing outside is rejected", async () => {
    const symlinkPath = path.join(rootDir, "src", "leak-link");
    await symlink(outsideDir, symlinkPath);

    const result = broker.authorizePath("src/leak-link/secret.txt");

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.code).toBe("path_not_approved");
    }
  });

  test("git -C <outside> is rejected and produces zero process spawns", async () => {
    let spawnCount = 0;
    const fakeSpawn = (() => {
      spawnCount++;
      return {
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    const result = broker.authorizeGitArgs(["-C", outsideDir, "status"]);
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.code).toBe("path_not_approved");
    }

    const execRes = await broker.execGit(["-C", outsideDir, "status"], {
      spawnFn: fakeSpawn,
    });
    expect(execRes.exitCode).toBe(1);
    expect(execRes.stderr).toContain("path_not_approved");
    expect(spawnCount).toBe(0);
  });

  test("nested git -C inside -C ../../outside is rejected and produces zero spawns", async () => {
    let spawnCount = 0;
    const fakeSpawn = (() => {
      spawnCount++;
      return {
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    const gitArgs = [
      "-C",
      "src",
      "-C",
      `../../${path.basename(outsideDir)}`,
      "status",
    ];
    const result = broker.authorizeGitArgs(gitArgs);

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.code).toBe("path_not_approved");
    }

    const execRes = await broker.execGit(gitArgs, { spawnFn: fakeSpawn });
    expect(execRes.exitCode).toBe(1);
    expect(execRes.stderr).toContain("path_not_approved");
    expect(spawnCount).toBe(0);
  });

  test("valid in-repository git -C executes through broker and calls spawn once", async () => {
    let spawnCount = 0;
    let spawnedCwd: string | undefined;

    const encoder = new TextEncoder();
    const fakeSpawn = ((_argv: string[], opts?: { cwd?: string }) => {
      spawnCount++;
      spawnedCwd = opts?.cwd;
      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("On branch main\n"));
          controller.close();
        },
      });
      const stderr = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    const gitArgs = ["-C", "src", "status"];
    const execRes = await broker.execGit(gitArgs, { spawnFn: fakeSpawn });

    expect(execRes.exitCode).toBe(0);
    expect(execRes.stdout).toBe("On branch main\n");
    expect(spawnCount).toBe(1);
    expect(spawnedCwd).toBe(path.join(rootDir, "src"));
  });

  test("repo-redirection and config-injection git flags are denied by name", () => {
    const deniedArgs = [
      "--git-dir",
      "--work-tree",
      "--super-prefix",
      "--namespace",
      "--exec-path",
      "-c",
    ];
    for (const flag of deniedArgs) {
      const result = broker.authorizeGitArgs([flag, "status"]);
      expect(result.approved).toBe(false);
      if (!result.approved) {
        expect(result.reason).toContain(flag);
      }
    }
  });

  test("every --config-env spelling is denied", async () => {
    for (const arg of [
      "--config-env",
      "--config-env=core.editor=vim",
      "--config-env-foo=bar",
    ]) {
      const result = broker.authorizeGitArgs(["status", arg]);
      expect(result.approved).toBe(false);
      if (!result.approved) {
        expect(result.reason).toContain(arg);
      }
    }

    let spawnCount = 0;
    const fakeSpawn = (() => {
      spawnCount++;
      return {
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    const execRes = await broker.execGit(["--config-env=x=y", "status"], {
      spawnFn: fakeSpawn,
    });
    expect(execRes.exitCode).toBe(1);
    expect(execRes.stderr).toContain("path_not_approved");
    expect(spawnCount).toBe(0);
  });

  test("spawned git environment strips GIT_DIR and GIT_WORK_TREE from process.env", async () => {
    const priorGitDir = process.env.GIT_DIR;
    const priorWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = "/evil/repo.git";
    process.env.GIT_WORK_TREE = "/evil/tree";
    const spawns: CapturedSpawn[] = [];

    try {
      const execRes = await broker.execGit(["status"], {
        spawnFn: capturingSpawn(spawns),
      });
      expect(execRes.exitCode).toBe(0);
    } finally {
      if (priorGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = priorGitDir;
      if (priorWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = priorWorkTree;
    }

    expect(spawns).toHaveLength(1);
    const env = spawns[0].env ?? {};
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(Object.keys(env).some((k) => /^GIT_/i.test(k))).toBe(false);
  });

  test("gitPath override is honored verbatim as argv[0]", async () => {
    const overrideGit = path.join(rootDir, "fake-git");
    await writeFile(overrideGit, "#!/bin/sh\nexit 0\n");
    const spawns: CapturedSpawn[] = [];

    const execRes = await broker.execGit(["status"], {
      spawnFn: capturingSpawn(spawns),
      gitPath: overrideGit,
    });

    expect(execRes.exitCode).toBe(0);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].argv[0]).toBe(overrideGit);
  });

  test("without an override, git resolves through pinned absolute paths only", async () => {
    const spawns: CapturedSpawn[] = [];

    const execRes = await broker.execGit(["status"], {
      spawnFn: capturingSpawn(spawns),
    });

    expect(execRes.exitCode).toBe(0);
    expect(spawns).toHaveLength(1);
    expect(path.isAbsolute(spawns[0].argv[0])).toBe(true);
    expect(spawns[0].argv[0]).not.toBe("git");
  });
});
