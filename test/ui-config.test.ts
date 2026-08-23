// Offline tests for `pr-hero config`'s renderer (C5 O-12, §5 row 12): one
// case per direction, the cap-narrowed value that must read `capped` and not
// `repo`, the key absent from both files that must read `default`, and the
// zero-`\x1b` companion CLAUDE.md requires of every renderer beside
// ui-result/ui-tree/ui-select.
//
// Every case feeds the renderer `mergeConfig`'s REAL output rather than a
// hand-written `sources` record. Hand-written provenance would prove the
// renderer can print the word `capped`; only the fold can prove a cap
// actually produces it, and that is the fact the command exists to report.

import { describe, expect, test } from "bun:test";
import {
  CONFIG_DIRECTION,
  type ConfigLayer,
  mergeConfig,
} from "../src/preflight";
import {
  type ConfigViewInput,
  configRows,
  renderConfig,
} from "../src/ui-config";

const PATHS = {
  repoConfigPath: "/repo/.prhero/config.json",
  globalConfigPath: "/home/me/.prhero/config.json",
} as const;

function render(
  global: ConfigLayer | undefined,
  repo: ConfigLayer,
  overrides: { repoPresent?: boolean; globalPresent?: boolean } = {},
): string[] {
  return renderConfig({
    ...mergeConfig(global, repo),
    ...PATHS,
    repoPresent: overrides.repoPresent ?? true,
    globalPresent: overrides.globalPresent ?? global !== undefined,
    styles: false,
    // Pinned, never sniffed: these renderers were the reason `bun test` in a
    // narrow pane could fail on a wrap point no test could stub.
    width: 100,
  });
}

// The row for `key`, as its whitespace-collapsed tokens.
function rowFor(lines: string[], key: string): string {
  const line = lines.find((l) => l.trimStart().startsWith(`${key} `));
  if (line === undefined) throw new Error(`no row for ${key}: ${lines}`);
  return line.trim().replace(/\s+/g, " ");
}

describe("pr-hero config names the layer behind every value", () => {
  test("one case per direction: global, repo, capped and default", () => {
    const lines = render(
      {
        agents_dir: "/home/me/agents/clean",
        summary: { enabled: false },
        max_verification_steps: 4,
      },
      {
        default_base: "dev",
        summary: { enabled: true, model: "haiku" },
        max_verification_steps: 12,
      },
    );

    // global — only the global file named it.
    expect(rowFor(lines, "agents_dir")).toBe(
      "agents_dir global /home/me/agents/clean",
    );
    // repo — only the repo file named it, and `default_base` can never be
    // anything else: it is a `repo` key and parseGlobalConfig rejects it.
    expect(rowFor(lines, "default_base")).toBe("default_base repo dev");
    // capped, NOT repo. The repo asked for 12, the global ceiling of 4 took
    // it away, and a listing that said `repo` here would name the layer whose
    // value is not on screen.
    expect(rowFor(lines, "max_verification_steps")).toBe(
      "max_verification_steps capped 4 ← narrowed by the global ceiling",
    );
    expect(rowFor(lines, "summary.enabled")).toBe(
      "summary.enabled capped false ← narrowed by the global ceiling",
    );
    // default — neither file named it. §5 row 12's "a key absent from both
    // files", and the whole reason §3.2 stopped the parser materialising the
    // two arrays.
    expect(rowFor(lines, "parity_trigger_paths")).toBe(
      "parity_trigger_paths default (unset)",
    );
    expect(rowFor(lines, "suspicion_priors")).toBe(
      "suspicion_priors default (unset)",
    );
  });

  test("a value a cap did NOT narrow keeps its own layer and no marker", () => {
    // Same shape as above with the inequality reversed: the repo is already
    // the narrower side, so nothing was taken away and `capped` would be a
    // narrowing the operator could not find by deleting the global file.
    const lines = render(
      { summary: { enabled: true }, max_verification_steps: 12 },
      { summary: { enabled: false }, max_verification_steps: 4 },
    );
    expect(rowFor(lines, "max_verification_steps")).toBe(
      "max_verification_steps repo 4",
    );
    expect(rowFor(lines, "summary.enabled")).toBe("summary.enabled repo false");
    expect(lines.join("\n")).not.toContain("narrowed by the global ceiling");
  });

  test("an explicitly empty list is not the same row as an unset one", () => {
    // The distinction §3.2's parser change bought: `"parity_trigger_paths":
    // []` is a repo deliberately disarming the parity hunter, and printing it
    // as `(unset)` would hide a decision someone made on purpose.
    const lines = render(undefined, {
      parity_trigger_paths: [],
      suspicion_priors: [
        { path: "src/pipeline.ts", weight: "high", reason: "" },
      ],
    });
    expect(rowFor(lines, "parity_trigger_paths")).toBe(
      "parity_trigger_paths repo (empty)",
    );
    expect(rowFor(lines, "suspicion_priors")).toBe(
      "suspicion_priors repo src/pipeline.ts (high)",
    );
  });
});

describe("pr-hero config names both files, present or not", () => {
  test("an absent file still gets its path printed", () => {
    const lines = render(undefined, {}, { repoPresent: false });
    expect(lines).toContain("  repo   /repo/.prhero/config.json (absent)");
    expect(lines).toContain("  global /home/me/.prhero/config.json (absent)");
  });

  test("a present pair says so", () => {
    const lines = render({}, {});
    expect(lines).toContain("  repo   /repo/.prhero/config.json (present)");
    expect(lines).toContain("  global /home/me/.prhero/config.json (present)");
  });

  test("the flag caveat is always printed", () => {
    // Judgment ledger JD-10: ConfigSource has no `flag` member, so no row can
    // ever attribute a flag-decided value to a layer. §3.10's "what it prints
    // cannot drift from what actually runs" is only honest while the output
    // says which decisions happen after this merge.
    // Whitespace-normalised: the caveat is wrapped to the terminal width, so
    // a raw substring would pin the wrap points rather than the sentence.
    const prose = render(undefined, {}).join(" ").replace(/\s+/g, " ");
    expect(prose).toContain(
      "Flags (--base, --model, --agents, --no-summary) and PRHERO_AGENTS_DIR " +
        "are applied after this merge, by the resolvers, so no row above can " +
        "say flag.",
    );
  });
});

describe("pr-hero config styling", () => {
  test("zero \\x1b bytes with styles off", () => {
    const lines = render(
      { agents_dir: "/a", summary: { enabled: false, model: "haiku" } },
      { summary: { enabled: true }, max_verification_steps: 2 },
    );
    expect(lines.join("\n")).not.toContain("\x1b");
  });

  test("and real escapes with styles on, so the test above is not vacuous", () => {
    // Annotated rather than inferred, so ConfigViewInput has a real consumer:
    // an exported type nothing imports is how dead code hides in a module
    // whose contract is its input shape.
    const input: ConfigViewInput = {
      ...mergeConfig({ agents_dir: "/a" }, { default_base: "dev" }),
      ...PATHS,
      repoPresent: true,
      globalPresent: true,
      styles: true,
      width: 100,
    };
    expect(renderConfig(input).join("\n")).toContain("\x1b[");
  });
});

describe("configRows", () => {
  // Iterated off CONFIG_DIRECTION, the type-locked table that IS the known-key
  // set — not a hand-written fixture. A fixture can only enumerate what its
  // author remembered (judgment ledger JD-19); the table cannot gain a key
  // without tsc noticing, so this witnesses the real union.
  test("covers every key CONFIG_DIRECTION declares", () => {
    const merged = mergeConfig(undefined, {});
    const rows = configRows(merged.effective, merged.sources);
    const keys = rows.map((r) => r.key);
    for (const key of Object.keys(CONFIG_DIRECTION)) {
      if (key === "summary") {
        // The one nested key, expanded per field because its two fields have
        // different directions and one row cannot name two layers.
        expect(keys).toContain("summary.enabled");
        expect(keys).toContain("summary.model");
        continue;
      }
      expect(keys).toContain(key);
    }
    expect(keys).toHaveLength(Object.keys(CONFIG_DIRECTION).length + 1);
  });
});
