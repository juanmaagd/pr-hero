// Offline tests for the head-to-head ledger (ROADMAP B4): the command
// token, the comparison.json reader, the one-PR-one-vote aggregation, and
// the markdown rendering. Literal in → literal out; nothing touches the fs.
//
// PR_1682_COMPARISON mirrors the FIRST real artifact field-for-field:
// captured (read-only) 2026-08-10 from
// /Users/juanma/Desktop/musive/musive-s3-prhero-runs/pr-1682-e3ab386a-1/
// comparison.json. That file predates the generated_at stamp — the ABSENCE
// of the field is part of the fixture.

import { describe, expect, test } from "bun:test";
import {
  aggregateLedger,
  parseComparisonJson,
  renderLedger,
  type StoredComparison,
  type StoredComparisonRow,
} from "../src/ledger";
import { CliUsageError, parseArgs } from "../src/preflight";

const PR_1682_COMPARISON = {
  pr: 1682,
  head_sha: "e3ab386a63020c6f5c21d814d176ff33849eef8d",
  diff_from_sha: "0f055e97192e67dc44e93ee473cd03e388f44231",
  run_dir:
    "/Users/juanma/Desktop/musive/musive-s3-prhero-runs/pr-1682-e3ab386a-1",
  run_status: "complete",
  greptile: { found: true },
  rows: [
    {
      bucket: "greptile_only",
      greptile: {
        index: 1,
        path: "packages/app/hooks/useUpdateUserIp.ts",
        start_line: 13,
        end_line: 17,
        title: "Promise-chain status handling",
        description:
          "The new response-status handling extends the existing `.then()` chain, contrary to the repository requirement to prefer async/await. Keeping fetch, parsing, backend update, and error handling split across callbacks makes this flow harder to follow and maintain.",
      },
      prhero: null,
      verdict: null,
      reasoning: null,
    },
    {
      bucket: "prhero_only",
      greptile: null,
      prhero: {
        id: "F001",
        path: "packages/app/components/MovePickedItemsSliderModal/index.tsx",
        line: 174,
        claim:
          "The `Move` Button in MovePickedItemsSliderModal never receives `isLoading`, only `isDisabled={!modalSelectedItem}` — Button.tsx only blocks onPress when `isDisabled || isLoading`, and isLoading defaults to false when the prop isn't passed. handleMove has no own re-entrancy guard, so a double-tap while the first batchMoveProjectOrSong call is in flight fires a second concurrent call with the same payload. Backend MoveProjectOrSongUseCase.execute wraps each move in its own SERIALIZABLE transaction with no idempotency key; the second call racing the first will either serialization-conflict or find the item already relocated (EntityNotFound), returning err() and surfacing a spurious 'failed to move' danger toast for a move that actually succeeded, plus duplicate HOME_QUERY_KEY invalidations. This diff touches this exact function's catch block (adding the isLoading reset) without wiring the Button correctly, unlike the sibling ConfirmDeleteProjectSlider/RenameSlider fixes in the same PR which do pass isLoading/enabled to gate their buttons.",
        tier: "blocking",
      },
      verdict: null,
      reasoning: null,
    },
    {
      bucket: "prhero_only",
      greptile: null,
      prhero: {
        id: "F002",
        path: "packages/app/components/ConfirmDeleteProjectSlider/index.tsx",
        line: 33,
        claim:
          "ConfirmDeleteProjectSlider's isLoading latch is armed by handleDelete but never reset when the shared, page-hoisted instance is retargeted to a different project mid-request (switch mode): only `value` is reset on close (deps [isOpen]), so swipe-dismissing the sheet during an in-flight delete and reopening it for another row leaves the Delete button stuck disabled/spinning for the new project until the stale request settles.",
        tier: "blocking",
      },
      verdict: null,
      reasoning: null,
    },
    {
      bucket: "prhero_only",
      greptile: null,
      prhero: {
        id: "F003",
        path: "packages/app/components/RenameSlider/index.tsx",
        line: 39,
        claim:
          "RenameSlider's isLoading latch is armed by handleRename but never reset when the shared, page-hoisted instance is retargeted to a different project mid-request (switch mode): only `newName` is resynced on isOpen's rising edge, so swipe-dismissing during an in-flight rename and reopening for another row leaves the Rename control stuck disabled/spinning for the new project until the stale request settles.",
        tier: "blocking",
      },
      verdict: null,
      reasoning: null,
    },
    {
      bucket: "prhero_only",
      greptile: null,
      prhero: {
        id: "F004",
        path: "packages/app/components/MovePickedItemsSliderModal/index.tsx",
        line: 86,
        claim:
          "handleMove's isLoading latch has no timeout/backstop bounding the awaited network call (stall mode): if the move request's connection is accepted but never answered, the shared JSON `post()` client used by batchMoveProjectOrSong never resolves or rejects, so isLoading stays armed and the Move button/spinner stays stuck indefinitely.",
        tier: "blocking",
      },
      verdict: null,
      reasoning: null,
    },
  ],
};

const PR_1682_RAW = JSON.stringify(PR_1682_COMPARISON, null, 2);

function mutated(change: (record: Record<string, unknown>) => void): string {
  const record = JSON.parse(PR_1682_RAW) as Record<string, unknown>;
  change(record);
  return JSON.stringify(record);
}

function prheroRow(
  over: Partial<StoredComparisonRow> = {},
): StoredComparisonRow {
  return {
    bucket: "prhero_only",
    greptile: null,
    prhero: {
      id: "F001",
      path: "src/a.ts",
      line: 10,
      claim: "the latch never resets",
      tier: "blocking",
    },
    verdict: null,
    reasoning: null,
    actor: null,
    ...over,
  };
}

function greptileRow(
  over: Partial<StoredComparisonRow> = {},
): StoredComparisonRow {
  return {
    bucket: "greptile_only",
    greptile: {
      index: 1,
      path: "src/g.ts",
      start_line: 5,
      end_line: 9,
      title: "Stale cache",
      description: "never invalidated",
    },
    prhero: null,
    verdict: null,
    reasoning: null,
    actor: null,
    ...over,
  };
}

function stored(
  over: Partial<StoredComparison> & { pr: number },
): StoredComparison {
  return {
    head_sha: "a".repeat(40),
    diff_from_sha: "b".repeat(40),
    run_dir: `/x/runs/pr-${over.pr}`,
    run_status: "complete",
    greptile: { found: true },
    rows: [],
    ...over,
  };
}

describe("parseArgs ledger", () => {
  test("ledger is a command", () => {
    const { command, options } = parseArgs(["ledger"]);
    expect(command).toBe("ledger");
    expect(options.runs).toBeUndefined();
  });

  test("reads --runs, --repo and --out", () => {
    const { options } = parseArgs([
      "ledger",
      "--repo",
      "/tmp/repo",
      "--runs",
      "/tmp/runs",
      "--out",
      "/tmp/ledger.md",
    ]);
    expect(options.repo).toBe("/tmp/repo");
    expect(options.runs).toBe("/tmp/runs");
    expect(options.out).toBe("/tmp/ledger.md");
  });

  test("--runs never swallows the following flag", () => {
    expect(() => parseArgs(["ledger", "--runs", "--out", "x"])).toThrow(
      CliUsageError,
    );
    expect(() => parseArgs(["ledger", "--runs"])).toThrow(CliUsageError);
  });
});

describe("parseComparisonJson", () => {
  test("reads the real 1682 artifact shape back", () => {
    const comparison = parseComparisonJson(PR_1682_RAW);
    expect(comparison.pr).toBe(1682);
    expect(comparison.head_sha).toBe(
      "e3ab386a63020c6f5c21d814d176ff33849eef8d",
    );
    expect(comparison.diff_from_sha).toBe(
      "0f055e97192e67dc44e93ee473cd03e388f44231",
    );
    expect(comparison.run_status).toBe("complete");
    expect(comparison.greptile.found).toBe(true);
    expect(comparison.rows).toHaveLength(5);
    expect(comparison.rows[0].bucket).toBe("greptile_only");
    expect(comparison.rows[1].prhero?.id).toBe("F001");
    // The first paid run predates the stamp: absence is tolerated, and the
    // I/O layer supplies mtime instead.
    expect(comparison.generated_at).toBeUndefined();
  });

  test("a missing field names itself", () => {
    try {
      parseComparisonJson(
        mutated((record) => {
          delete record.head_sha;
        }),
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain("head_sha");
    }
  });

  test("an abbreviated sha is rejected, naming the field", () => {
    try {
      parseComparisonJson(
        mutated((record) => {
          record.diff_from_sha = "0f055e97";
        }),
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain("diff_from_sha");
    }
  });

  test("a bad bucket names its row", () => {
    try {
      parseComparisonJson(
        mutated((record) => {
          (record.rows as Record<string, unknown>[])[0].bucket = "greptile";
        }),
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain("rows[0].bucket");
    }
  });

  test("a non-string verdict is rejected", () => {
    expect(() =>
      parseComparisonJson(
        mutated((record) => {
          (record.rows as Record<string, unknown>[])[1].verdict = 7;
        }),
      ),
    ).toThrow(CliUsageError);
  });

  test("a triaged row (verdict + reasoning strings) parses", () => {
    const comparison = parseComparisonJson(
      mutated((record) => {
        const row = (record.rows as Record<string, unknown>[])[1];
        row.verdict = "real";
        row.reasoning = "verified in the code by hand";
      }),
    );
    expect(comparison.rows[1].verdict).toBe("real");
    expect(comparison.rows[1].reasoning).toBe("verified in the code by hand");
  });

  // ROADMAP B6c: actor gets the same loud per-field validation verdict and
  // reasoning already have — a closed enum, "agent" | "human" | null —
  // plus back-compat: files written before `actor` existed have no such
  // key at all, and absence must fold to explicit `null`, never throw (the
  // same fallback shape `generated_at` already gets).
  test.each(["agent", "human", null])("actor: %p parses", (value) => {
    const comparison = parseComparisonJson(
      mutated((record) => {
        (record.rows as Record<string, unknown>[])[1].actor = value;
      }),
    );
    expect(comparison.rows[1].actor).toBe(value);
  });

  test("a missing actor field (legacy artifact) folds to null, not undefined", () => {
    expect(parseComparisonJson(PR_1682_RAW).rows[0].actor).toBeNull();
  });

  test("an unknown actor string is rejected, naming the row", () => {
    try {
      parseComparisonJson(
        mutated((record) => {
          (record.rows as Record<string, unknown>[])[1].actor = "robot";
        }),
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain("rows[1].actor");
    }
  });

  test("a present generated_at must be a non-empty string", () => {
    const stamped = parseComparisonJson(
      mutated((record) => {
        record.generated_at = "2026-08-10T18:00:00.000Z";
      }),
    );
    expect(stamped.generated_at).toBe("2026-08-10T18:00:00.000Z");
    expect(() =>
      parseComparisonJson(
        mutated((record) => {
          record.generated_at = "";
        }),
      ),
    ).toThrow(CliUsageError);
    expect(() =>
      parseComparisonJson(
        mutated((record) => {
          record.generated_at = 5;
        }),
      ),
    ).toThrow(CliUsageError);
  });

  test("invalid JSON and non-objects fail loud", () => {
    expect(() => parseComparisonJson("not json")).toThrow(CliUsageError);
    expect(() => parseComparisonJson("[]")).toThrow(CliUsageError);
    expect(() => parseComparisonJson("null")).toThrow(CliUsageError);
  });
});

describe("aggregateLedger", () => {
  test("the latest run is picked by generated_at, not mtime", () => {
    const older = stored({
      pr: 7,
      head_sha: "c".repeat(40),
      generated_at: "2026-08-10T10:00:00.000Z",
      rows: [prheroRow()],
    });
    const newer = stored({
      pr: 7,
      head_sha: "d".repeat(40),
      generated_at: "2026-08-11T10:00:00.000Z",
      rows: [],
    });
    // The OLDER run carries the NEWER mtime (a cp or restore rewrote it):
    // the stamp must still win.
    const ledger = aggregateLedger([
      { comparison: older, mtimeMs: 9_999_999 },
      { comparison: newer, mtimeMs: 1 },
    ]);
    expect(ledger.prs).toHaveLength(1);
    expect(ledger.prs[0].runCount).toBe(2);
    expect(ledger.prs[0].latest.headSha).toBe("d".repeat(40));
    expect(ledger.prs[0].latest.totalRows).toBe(0);
  });

  test("runs without the stamp fall back to mtime", () => {
    const first = stored({ pr: 7, head_sha: "c".repeat(40) });
    const second = stored({ pr: 7, head_sha: "d".repeat(40) });
    const ledger = aggregateLedger([
      { comparison: first, mtimeMs: 2000 },
      { comparison: second, mtimeMs: 1000 },
    ]);
    expect(ledger.prs[0].latest.headSha).toBe("c".repeat(40));
  });

  test("one PR, one vote: totals count only the latest run", () => {
    const stale = stored({
      pr: 7,
      generated_at: "2026-08-10T10:00:00.000Z",
      rows: [prheroRow(), prheroRow(), prheroRow()],
    });
    const latest = stored({
      pr: 7,
      generated_at: "2026-08-11T10:00:00.000Z",
      rows: [prheroRow()],
    });
    const other = stored({ pr: 9, rows: [greptileRow()] });
    const ledger = aggregateLedger([
      { comparison: stale, mtimeMs: 1 },
      { comparison: latest, mtimeMs: 2 },
      { comparison: other, mtimeMs: 3 },
    ]);
    expect(ledger.totals.prCount).toBe(2);
    // 1, never the stale run's 3: a re-reviewed PR must not vote twice.
    expect(ledger.totals.buckets.prheroOnly).toBe(1);
    expect(ledger.totals.buckets.greptileOnly).toBe(1);
    expect(ledger.totals.prsWithPrHeroFindings).toBe(1);
    expect(ledger.prs.map((entry) => entry.pr)).toEqual([7, 9]);
  });

  test("verdict tallies count triage strings as-is and merge across PRs", () => {
    const a = stored({
      pr: 1,
      rows: [
        prheroRow({ verdict: "real", reasoning: "verified in code" }),
        prheroRow({ verdict: "real", reasoning: "reproduced" }),
        prheroRow(),
      ],
    });
    const b = stored({
      pr: 2,
      rows: [greptileRow({ verdict: "fp", reasoning: "style only" })],
    });
    const ledger = aggregateLedger([
      { comparison: a, mtimeMs: 1 },
      { comparison: b, mtimeMs: 2 },
    ]);
    expect(ledger.totals.verdictTally).toEqual({ real: 2, fp: 1 });
    expect(ledger.totals.triaged).toBe(3);
    expect(ledger.totals.totalRows).toBe(4);
    expect(ledger.prs[0].latest.pending).toHaveLength(1);
    expect(ledger.prs[1].latest.pending).toHaveLength(0);
  });

  // ROADMAP B6c: "the agent decides, and it is audited" — the split must be
  // visible in the tally, merged across PRs the same way verdictTally is.
  test("actor tallies split agent/human and merge across PRs", () => {
    const a = stored({
      pr: 1,
      rows: [
        prheroRow({ verdict: "applied", actor: "agent" }),
        prheroRow({ verdict: "dismissed/upheld", actor: "agent" }),
        prheroRow({ verdict: "misclassified/rejected", actor: "human" }),
      ],
    });
    const b = stored({
      pr: 2,
      rows: [greptileRow({ verdict: "real", actor: "agent" })],
    });
    const ledger = aggregateLedger([
      { comparison: a, mtimeMs: 1 },
      { comparison: b, mtimeMs: 2 },
    ]);
    // Asymmetric on purpose (3 agent, 1 human): a swap of the two buckets
    // must fail this test, not slip through on a symmetric fixture.
    expect(ledger.totals.actorTally).toEqual({ agent: 3, human: 1 });
    expect(ledger.totals.triaged).toBe(4);
  });

  // Two null-adjacent edges in one test: (1) a verdict with no recorded
  // actor (legacy artifact, or a human hand-editing the JSON) counts toward
  // `triaged` but is NOT guessed into either actor bucket — undercounting
  // the split is more honest than inventing an actor. (2) an `inconclusive`
  // adjudication (6c: "actor set with verdict null means adjudicated,
  // could not settle") stays Pending, never triaged, even though actor IS
  // written on that row.
  test("actor: null on a triaged row is uncounted; verdict: null with actor set stays Pending", () => {
    const comparison = stored({
      pr: 1,
      rows: [
        prheroRow({ verdict: "real", actor: null }),
        prheroRow({ verdict: null, actor: "agent" }),
      ],
    });
    const ledger = aggregateLedger([{ comparison, mtimeMs: 1 }]);
    expect(ledger.totals.triaged).toBe(1);
    expect(ledger.totals.actorTally).toEqual({ agent: 0, human: 0 });
    expect(ledger.prs[0].latest.pending).toHaveLength(1);
    expect(ledger.prs[0].latest.pending[0].actor).toBe("agent");
  });
});

describe("renderLedger", () => {
  test("the real 1682 artifact renders end to end", () => {
    const markdown = renderLedger(
      aggregateLedger([
        { comparison: parseComparisonJson(PR_1682_RAW), mtimeMs: 1 },
      ]),
    );
    expect(markdown).toContain(
      "| PR | head | Greptile-only | Both | pr-hero-only | run | triaged | runs |",
    );
    expect(markdown).toContain(
      "| 1682 | `e3ab386a` | 1 | 0 | 4 | complete | 0/5 | 1 |",
    );
    expect(markdown).toContain("pr-hero found something on 1 of 1 PRs");
    expect(markdown).toContain("0 of 5 rows triaged");
    expect(markdown).toContain("No verdicts recorded yet");
    // Nothing triaged yet: the split line reads all-zero, not omitted.
    expect(markdown).toContain("0 verdicts · 0 by agent · 0 by human.");
    expect(markdown).toContain(
      "- PR 1682 · greptile_only · G1 `packages/app/hooks/useUpdateUserIp.ts:13`",
    );
    expect(markdown).toContain(
      "- PR 1682 · prhero_only · F001 `packages/app/components/MovePickedItemsSliderModal/index.tsx:174`",
    );
    // The closing line routes verdicts back into the artifact itself.
    expect(markdown).toContain("comparison.json");
    expect(markdown).toContain("reasoning");
  });

  test("recorded verdicts replace the empty-tally line", () => {
    const markdown = renderLedger(
      aggregateLedger([
        {
          comparison: stored({
            pr: 1,
            rows: [
              prheroRow({
                verdict: "real",
                reasoning: "verified",
                actor: "agent",
              }),
              greptileRow({
                verdict: "fp",
                reasoning: "style",
                actor: "human",
              }),
            ],
          }),
          mtimeMs: 1,
        },
      ]),
    );
    expect(markdown).toContain("- fp: 1");
    expect(markdown).toContain("- real: 1");
    expect(markdown).not.toContain("No verdicts recorded yet");
    expect(markdown).toContain("Nothing pending");
    expect(markdown).toContain("2 of 2 rows triaged");
    expect(markdown).toContain("2 verdicts · 1 by agent · 1 by human.");
  });

  test("a pending both-row is identified by its pr-hero side", () => {
    const markdown = renderLedger(
      aggregateLedger([
        {
          comparison: stored({
            pr: 3,
            rows: [
              prheroRow({
                bucket: "both",
                greptile: {
                  index: 2,
                  path: "src/a.ts",
                  start_line: 8,
                  end_line: 12,
                  title: "Same spot",
                  description: "location overlap",
                },
              }),
            ],
          }),
          mtimeMs: 1,
        },
      ]),
    );
    expect(markdown).toContain("- PR 3 · both · F001 `src/a.ts:10`");
  });
});
