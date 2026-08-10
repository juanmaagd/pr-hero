// Parser tests for the Greptile side of the head-to-head benchmark.
//
// The four large fixtures below are REAL comment bodies captured with
// `gh api repos/musivetech/musive/issues/<n>/comments` on 2026-08-10 and
// inlined verbatim (PR_1677_BODY and PR_1676_BODY are whole bodies; the two
// _BLOCK fixtures are the verbatim `<details>` region of their comment). They
// are the reason this parser is trusted: the shape it handles is the shape
// production actually emits, not the shape a spec described.
//
// They cover the two header formats that coexist in that repo — the new
// "### Issue N" and the pre-~1560 "### Issue N of M" with its preamble — plus
// a body where Greptile reported nothing at all.

import { describe, expect, test } from "bun:test";
import {
  GREPTILE_BOT_LOGIN,
  parseGreptileComment,
  pickGreptileComment,
} from "../src/greptile";

const PR_1677_BODY = `<h3>Greptile Summary</h3>

This PR reduces web lint findings by replacing several chained array passes with equivalent single-pass iterations, optimizing home-library position lookup, and replacing index-based public TrackCard keys.
- Builds uploader cleanup and navigable-file results in one pass.
- Uses a precomputed project-ID position map during library reordering.
- Assigns public TrackCards resource-derived keys on desktop and responsive web.
- Lowers the React Doctor baseline from 387 to 381.

<h3>Confidence Score: 4/5</h3>

The duplicate public-track key regression should be fixed before merging because valid repeated project entries can reconcile to the wrong card state.

The iteration rewrites preserve existing behavior, but the new desktop and mobile TrackCard keys are not unique for repeated resource memberships that the project model and public DTO permit.

**Files Needing Attention:** packages/web/src/components/PublicProject/ProjectHero/DesktopHero.tsx, packages/web/src/components/PublicProject/ProjectHero/MobileHero.tsx

<details><summary><h3>Important Files Changed</h3></summary>




| Filename | Overview |
|----------|----------|
| packages/web/src/components/PublicProject/ProjectHero/DesktopHero.tsx | Replaces unique positional keys with resource-derived keys that collide when a public project repeats a song or nested project. |
| packages/web/src/components/PublicProject/ProjectHero/MobileHero.tsx | Mirrors the desktop key change and therefore has the same duplicate-resource reconciliation defect. |
| packages/web/src/components/FileUploaderInitializer/index.tsx | Direct Set construction preserves the previous uploader cleanup predicate and removal behavior. |
| packages/web/src/hooks/home/useReorderHomeLibrary.ts | Precomputes first positions by ID while preserving findIndex semantics and sequential reorder requests. |
| packages/web/src/utils/buildNavigableFileList.ts | The single-pass loop preserves completed-file filtering, ordering, and metadata construction. |
| packages/web/src/components/Sidebar/StackDrangAndDrop/index.tsx | flatMap produces the same ordered non-public project ID list as the previous filter/map chain. |
| packages/web/react-doctor-baseline.txt | Lowers the lint baseline consistently with the stated six-warning reduction. |

</details>


<!-- greptile_other_comments_section -->

<a href="https://app.greptile.com/ide/claude-code?prompt=%23%23%23%20Issue%201%0Apackages%2Fweb%2Fsrc%2Fcomponents%2FPublicProject%2FProjectHero%2FDesktopHero.tsx%3A255-259%0A**Duplicate%20resource%20keys%20collide**%0A%0AWhen%20a%20public%20project%20contains%20the%20same%20song%20or%20nested%20project%20more%20than%20once%2C%20these%20entries%20receive%20identical%20React%20keys%2C%20causing%20sorting%20or%20filtering%20to%20reuse%20the%20wrong%20%60TrackCard%60%20instance%20and%20carry%20popup%2C%20hover%2C%20playback%2C%20or%20other%20card%20state%20between%20rows.%20The%20responsive%20implementation%20uses%20the%20same%20key%20construction.%0A%0A---%0A%0AFor%20each%20issue%20above%2C%20determine%20whether%20it%20is%20valid%20and%20should%20be%20fixed.%20If%20so%2C%20fix%20it%20directly.&repo=musivetech%2Fmusive&pr=1677&platform=github"><picture><source media="(prefers-color-scheme: dark)" srcset="https://greptile-static-assets.s3.amazonaws.com/badges/FixAllInClaudeDark.svg?v=6"><source media="(prefers-color-scheme: light)" srcset="https://greptile-static-assets.s3.amazonaws.com/badges/FixAllInClaude.svg?v=6"><img alt="Fix All in Claude Code" src="https://greptile-static-assets.s3.amazonaws.com/badges/FixAllInClaude.svg?v=6"></picture></a> <a href="https://app.greptile.com/api/ide/codex?prompt=IMPORTANT%3A%20Work%20in%20the%20repository%20%22musivetech%2Fmusive%22%20on%20the%20existing%20branch%20%22chore%2FMUS-716-web-phase2-tail-2e%22.%20Checkout%20that%20branch%20%E2%80%94%20do%20NOT%20create%20a%20new%20branch%20or%20open%20a%20new%20PR.%20Push%20your%20changes%20to%20%22chore%2FMUS-716-web-phase2-tail-2e%22.%0A%0A%23%23%23%20Issue%201%0Apackages%2Fweb%2Fsrc%2Fcomponents%2FPublicProject%2FProjectHero%2FDesktopHero.tsx%3A255-259%0A**Duplicate%20resource%20keys%20collide**%0A%0AWhen%20a%20public%20project%20contains%20the%20same%20song%20or%20nested%20project%20more%20than%20once%2C%20these%20entries%20receive%20identical%20React%20keys%2C%20causing%20sorting%20or%20filtering%20to%20reuse%20the%20wrong%20%60TrackCard%60%20instance%20and%20carry%20popup%2C%20hover%2C%20playback%2C%20or%20other%20card%20state%20between%20rows.%20The%20responsive%20implementation%20uses%20the%20same%20key%20construction.%0A%0A---%0A%0AFor%20each%20issue%20above%2C%20determine%20whether%20it%20is%20valid%20and%20should%20be%20fixed.%20If%20so%2C%20fix%20it%20directly.&repo=musivetech%2Fmusive&pr=1677&platform=github"><picture><source media="(prefers-color-scheme: dark)" srcset="https://greptile-static-assets.s3.amazonaws.com/badges/FixAllInCodexDark.svg?v=6"><source media="(prefers-color-scheme: light)" srcset="https://greptile-static-assets.s3.amazonaws.com/badges/FixAllInCodex.svg?v=6"><img alt="Fix All in Codex" src="https://greptile-static-assets.s3.amazonaws.com/badges/FixAllInCodex.svg?v=6"></picture></a>

<details><summary>Prompt To Fix All With AI</summary>

\`\`\`\`\`markdown
### Issue 1
packages/web/src/components/PublicProject/ProjectHero/DesktopHero.tsx:255-259
**Duplicate resource keys collide**

When a public project contains the same song or nested project more than once, these entries receive identical React keys, causing sorting or filtering to reuse the wrong \`TrackCard\` instance and carry popup, hover, playback, or other card state between rows. The responsive implementation uses the same key construction.

---

For each issue above, determine whether it is valid and should be fixed. If so, fix it directly.
\`\`\`\`\`

</details>

<sub>Reviews (1): Last reviewed commit: ["chore(MUS-716): phase-2 tail in web — in..."](https://github.com/musivetech/musive/commit/382981e05feea8664aecfe4894598e194c403e42) | [Re-trigger Greptile](https://app.greptile.com/api/retrigger?id=51734378)</sub>
`;

const PR_1676_BODY = `<h3>Greptile Summary</h3>

The PR memoizes 32 React context provider values in the web application to prevent unnecessary consumer rerenders.
- Adds \`useMemo\` around provider value objects with dependencies covering their changing state and callback bindings.
- Preserves stable React setters and refs without unnecessary dependencies.
- Lowers the React Doctor baseline from 419 to 387 to record the 32 resolved diagnostics.

<h3>Confidence Score: 5/5</h3>

The PR appears safe to merge, with the memoized provider values remaining synchronized with every changing context field.

The new memoization is unconditional, uses supported React APIs, and includes every dependency whose value or identity can change; the baseline adjustment matches the resolved provider-value diagnostics.

<details><summary><h3>Important Files Changed</h3></summary>




| Filename | Overview |
|----------|----------|
| packages/web/src/components/Project/PublishSlider/index.tsx | Memoizes the local publish-slider context value using its sole changing state field; the state setter has stable identity. |
| packages/web/src/context/FilesDropableContext.tsx | Memoizes the upload-action context using all three callback identities, preserving updates when any callback dependency changes. |
| packages/web/src/context/NotificationsContext.tsx | Memoizes notification state and actions with all changing state and callback identities represented. |
| packages/web/src/context/OwnUserContext.tsx | Memoizes user state and session actions while correctly omitting only the stable state setter. |
| packages/web/src/context/ProjectViewRefContext.tsx | Memoizes the wrapper around a component-lifetime-stable ref object without affecting mutable ref contents. |
| packages/web/src/context/PublicProjectViewRefContext.tsx | Applies the same correct stable-ref memoization to the public project view. |
| packages/web/src/context/WebVersionSyncContext.tsx | Memoizes a context value derived from the module-scope web-version constant. |
| packages/web/react-doctor-baseline.txt | Records the exact 32-diagnostic reduction produced by memoizing the 32 provider values. |

</details>


<!-- greptile_other_comments_section -->

<sub>Reviews (1): Last reviewed commit: ["chore(MUS-716): memoize context provider..."](https://github.com/musivetech/musive/commit/b27b94c933a79f26a6b0af031f98f14079523969) | [Re-trigger Greptile](https://app.greptile.com/api/retrigger?id=51734364)</sub>
`;

const PR_1592_BLOCK = `<details><summary>Prompt To Fix All With AI</summary>

\`\`\`\`\`markdown
### Issue 1
packages/app/components/FileUploaderInitializer/index.tsx:126
**Successful completions skip refetch**

When every private file upload succeeds, workers leave their rows at \`progress: 1\`, so the list length never decreases and this condition never schedules the confirming refetch. Completed cards therefore keep hiding their server rows until the ten-second backstop removes them, while the selected containers and library totals remain stale.

### Issue 2
packages/app/components/FileUploaderInitializer/index.tsx:144-149
**Debounce restores stale selection**

When the user selects another project or version during the debounce window, the pending callback still fetches the captured IDs. Those fetch methods write their results into \`selectedProject\` and \`selectedVersion\`, replacing the newly selected view with data from the view the user left.

---

For each issue above, determine whether it is valid and should be fixed. If so, fix it directly.
\`\`\`\`\`

</details>
`;

const PR_1509_BLOCK = `<details><summary>Prompt To Fix All With AI</summary>

\`\`\`\`\`markdown
Fix the following 3 code review issues. Work through them one at a time, proposing concise fixes.

---

### Issue 1 of 3
packages/web/src/hooks/home/homeQueryKeys.ts:40-44
**Project Cache Survives Logout**

The \`['project', id]\` cache still has active writers in \`useProjectTreeQuery\` and the sidebar drag-and-drop paths, but this change stops removing it during logout. If another account can open the same shared project within the 60-second stale window, TanStack Query can render the previous account's full cached tree before refetching, exposing data fetched under the wrong session.

\`\`\`suggestion
export const SESSION_PURGE_QUERY_KEY_PREFIXES = [
  HOME_QUERY_KEY,
  SAVED_TRACKS_QUERY_KEY,
  COLLABORATIVE_TRACKS_QUERY_KEY,
  ["project"],
] as const;
\`\`\`

### Issue 2 of 3
packages/web/src/hooks/home/homeQueryKeys.ts:40-44
**Search Results Cross Sessions**

\`useHomeLibrarySearchQuery\` still writes \`['home', 'search', term]\`, while the shared QueryClient remains alive across logout and this prefix is no longer purged. When the next account enters a term previously used by another account, it can receive that account's cached matching project IDs instead of results fetched with its own permissions.

\`\`\`suggestion
export const SESSION_PURGE_QUERY_KEY_PREFIXES = [
  HOME_QUERY_KEY,
  SAVED_TRACKS_QUERY_KEY,
  COLLABORATIVE_TRACKS_QUERY_KEY,
  ["home", "search"],
] as const;
\`\`\`

### Issue 3 of 3
packages/web/src/hooks/home/useRenameProjectOrSong.ts:52
**Expanded Tree Keeps Old Name**

When a currently expanded top-level project is renamed from the home view, the optimistic update changes \`['home']\` and \`selectedProject\` but leaves its live \`['project', id]\` query unchanged. The expanded sidebar can therefore continue rendering the old project name until that query becomes stale or is re-enabled.


\`\`\`\`\`

</details>
`;

describe("parseGreptileComment — real captured bodies", () => {
  test("PR 1677: one finding, whole real body including badge links", () => {
    const findings = parseGreptileComment(PR_1677_BODY);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      index: 1,
      path: "packages/web/src/components/PublicProject/ProjectHero/DesktopHero.tsx",
      startLine: 255,
      endLine: 259,
      title: "Duplicate resource keys collide",
      description:
        "When a public project contains the same song or nested project more than once, these entries receive identical React keys, causing sorting or filtering to reuse the wrong `TrackCard` instance and carry popup, hover, playback, or other card state between rows. The responsive implementation uses the same key construction.",
    });
  });

  test("PR 1677: the trailing fix-instruction is not parsed as a finding", () => {
    const findings = parseGreptileComment(PR_1677_BODY);
    for (const finding of findings) {
      expect(finding.description).not.toContain("For each issue above");
    }
  });

  test("PR 1677: the percent-encoded copy inside the badge hrefs is inert", () => {
    // The "Fix All in Claude Code" / "Fix All in Codex" anchors embed the SAME
    // issue text URL-encoded. If it ever leaked into the parse we would double
    // count every finding, so assert the count stays at the fenced block's one.
    expect(PR_1677_BODY).toContain("%23%23%23%20Issue%201");
    expect(parseGreptileComment(PR_1677_BODY)).toHaveLength(1);
  });

  test("PR 1676: a clean review parses to no findings, not an error", () => {
    expect(PR_1676_BODY).not.toContain("Prompt To Fix All With AI");
    expect(parseGreptileComment(PR_1676_BODY)).toEqual([]);
  });

  test("PR 1592: two findings, one single line and one range", () => {
    const findings = parseGreptileComment(PR_1592_BLOCK);
    expect(findings).toHaveLength(2);
    expect(findings[0].index).toBe(1);
    expect(findings[0].path).toBe(
      "packages/app/components/FileUploaderInitializer/index.tsx",
    );
    // Single line: endLine mirrors startLine.
    expect(findings[0].startLine).toBe(126);
    expect(findings[0].endLine).toBe(126);
    expect(findings[0].title).toBe("Successful completions skip refetch");
    expect(findings[1].startLine).toBe(144);
    expect(findings[1].endLine).toBe(149);
    expect(findings[1].title).toBe("Debounce restores stale selection");
    expect(findings[1].description).not.toContain("For each issue above");
  });

  test("PR 1509: old 'Issue N of M' format, preamble discarded", () => {
    const findings = parseGreptileComment(PR_1509_BLOCK);
    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.index)).toEqual([1, 2, 3]);
    // The old format opens with "Fix the following N code review issues" and a
    // bare `---`; both sit before the first header and must be dropped.
    expect(PR_1509_BLOCK).toContain("Fix the following 3 code review issues");
    for (const finding of findings) {
      expect(finding.description).not.toContain("Fix the following");
    }
  });

  test("PR 1509: an inner ```suggestion fence does not close the outer block", () => {
    // The whole reason the fence scanner tracks backtick WIDTH. A parser that
    // closed on the first ``` would report 1 finding here instead of 3 and
    // silently understate Greptile's recall.
    const findings = parseGreptileComment(PR_1509_BLOCK);
    expect(findings).toHaveLength(3);
    expect(findings[0].description).toContain("```suggestion");
    expect(findings[0].description).toContain(
      "SESSION_PURGE_QUERY_KEY_PREFIXES",
    );
  });

  test("PR 1509: two distinct findings may share one location", () => {
    const findings = parseGreptileComment(PR_1509_BLOCK);
    expect(findings[0].path).toBe(findings[1].path);
    expect(findings[0].startLine).toBe(findings[1].startLine);
    expect(findings[0].title).not.toBe(findings[1].title);
  });
});

describe("parseGreptileComment — tolerated variations", () => {
  const minimal = [
    "<details><summary>Prompt To Fix All With AI</summary>",
    "",
    "`````markdown",
    "### Issue 1",
    "src/a.ts:10-12",
    "**Something broke**",
    "",
    "A description.",
    "",
    "---",
    "",
    "For each issue above, determine whether it is valid and should be fixed. If so, fix it directly.",
    "`````",
    "",
    "</details>",
  ].join("\n");

  test("CRLF line endings", () => {
    const findings = parseGreptileComment(minimal.replace(/\n/g, "\r\n"));
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toBe("A description.");
    expect(findings[0].title).toBe("Something broke");
  });

  test("missing <details> wrapper", () => {
    const bare = minimal
      .replace("<details><summary>Prompt To Fix All With AI</summary>", "")
      .replace("</details>", "");
    const findings = parseGreptileComment(bare);
    expect(findings).toHaveLength(1);
    expect(findings[0].path).toBe("src/a.ts");
  });

  test("a three-backtick fence instead of five", () => {
    const findings = parseGreptileComment(minimal.replace(/`````/g, "```"));
    expect(findings).toHaveLength(1);
    expect(findings[0].startLine).toBe(10);
    expect(findings[0].endLine).toBe(12);
  });

  test("no fence at all", () => {
    const findings = parseGreptileComment(
      ["### Issue 1", "src/a.ts:7", "**Title**", "", "Body."].join("\n"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].startLine).toBe(7);
    expect(findings[0].endLine).toBe(7);
  });

  test("extra prose around the block is ignored", () => {
    const findings = parseGreptileComment(
      `<h3>Greptile Summary</h3>\n\nSome prose.\n\n${minimal}\n\n<sub>Reviews (1)</sub>`,
    );
    expect(findings).toHaveLength(1);
  });

  test("a missing bold title degrades to an empty title, not a skip", () => {
    const findings = parseGreptileComment(
      ["### Issue 1", "src/a.ts:7", "", "Body without a title."].join("\n"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe("");
    expect(findings[0].description).toBe("Body without a title.");
  });

  test("an unparseable location skips that issue and keeps the rest", () => {
    const findings = parseGreptileComment(
      [
        "### Issue 1",
        "not a location at all",
        "**Skipped**",
        "",
        "Body.",
        "### Issue 2",
        "src/b.ts:42",
        "**Kept**",
        "",
        "Body.",
      ].join("\n"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].index).toBe(2);
    expect(findings[0].title).toBe("Kept");
  });
});

describe("parseGreptileComment — malformed input returns [] rather than throwing", () => {
  const junk: unknown[] = [
    "",
    "   ",
    "no findings here at all",
    "### Issue",
    "### Issue 1",
    "`````markdown\n`````",
    "<details><summary>Prompt To Fix All With AI</summary>",
    "`````markdown\n### Issue 1\n",
    null,
    undefined,
    42,
    { body: "nope" },
  ];

  for (const [i, input] of junk.entries()) {
    test(`input #${i} parses to [] and does not throw`, () => {
      expect(() => parseGreptileComment(input as string)).not.toThrow();
      expect(parseGreptileComment(input as string)).toEqual([]);
    });
  }
});

describe("pickGreptileComment", () => {
  test("picks the bot's comment out of a mixed thread", () => {
    const picked = pickGreptileComment([
      { user: "juanma", body: "lgtm" },
      { user: GREPTILE_BOT_LOGIN, body: "greptile body" },
      { user: "someone-else[bot]", body: "ci passed" },
    ]);
    expect(picked).toBe("greptile body");
  });

  test("picks the newest when the bot commented several times", () => {
    // "Newest" is positional — GitHub returns issue comments in ascending
    // creation order, so the LAST match is the re-review.
    const picked = pickGreptileComment([
      { user: GREPTILE_BOT_LOGIN, body: "first review" },
      { user: "juanma", body: "pushed a fix" },
      { user: GREPTILE_BOT_LOGIN, body: "second review" },
    ]);
    expect(picked).toBe("second review");
  });

  test("returns null when the bot never commented", () => {
    expect(pickGreptileComment([{ user: "juanma", body: "lgtm" }])).toBeNull();
    expect(pickGreptileComment([])).toBeNull();
  });

  test("tolerates malformed entries", () => {
    expect(() =>
      pickGreptileComment([
        { user: 1, body: "x" } as unknown as { user: string; body: string },
        null as unknown as { user: string; body: string },
        { user: GREPTILE_BOT_LOGIN, body: 7 } as unknown as {
          user: string;
          body: string;
        },
      ]),
    ).not.toThrow();
    expect(
      pickGreptileComment(null as unknown as { user: string; body: string }[]),
    ).toBeNull();
  });

  test("the picked body feeds the parser end to end", () => {
    const picked = pickGreptileComment([
      { user: "juanma", body: "### Issue 1\nsrc/decoy.ts:1\n**Decoy**\n\nNo." },
      { user: GREPTILE_BOT_LOGIN, body: PR_1677_BODY },
    ]);
    expect(picked).not.toBeNull();
    const findings = parseGreptileComment(picked as string);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe("Duplicate resource keys collide");
  });
});
