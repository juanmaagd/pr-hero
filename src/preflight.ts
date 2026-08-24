// Everything local mode (ROADMAP B0) must decide BEFORE it is allowed to
// spend money, expressed as pure functions so it is all testable offline.
// The CLI in cli.ts is the I/O shell around these; nothing here touches the
// filesystem, git, or the network — a preflight that needs a live repo to be
// tested is a preflight that gets tested once, live, at $10 a go.

import path from "node:path";
import { resolveEngineAssets } from "./assets";
import type { SuspicionPrior } from "./prompt-set";
// size-gate.ts imports only a TYPE from here, so this is not a runtime
// cycle — the type import is erased and size-gate has no load-time
// dependency on this module.
import { DEFAULT_SIZE_GATE, unquotePath } from "./size-gate";
import type { ReviewSpec } from "./spec";
import { ADJUDICATED_TAGS, type TriageTag, type TriageVerdict } from "./triage";

// The lab's production value. Also the single biggest per-hunter cost lever
// in the whole engine: every hop is another round of tool calls against the
// tree, and hunter cost scales with hops far more sharply than with diff
// size. The fixture eval runs at 4 precisely because 12 is not cheap.
export const DEFAULT_HOP_BUDGET = 12;

// watch install's default StartInterval, in minutes. 15 keeps a fresh PR's
// wait bounded by the tick while staying far below GitHub's rate-limit radar
// (a tick is one `pr list` per repo plus a comments read per candidate).
export const DEFAULT_WATCH_INTERVAL_MIN = 15;

// gc install's default StartInterval, in minutes. The 72h TTL only
// evaluates when GC actually runs; 6h is frequent enough that a merged PR
// does not sit until tomorrow, and cheap (gh view per tree, no LLM).
export const DEFAULT_GC_INTERVAL_MIN = 360;

// The LAST resort only. WHY it is not simply "the default": a hardcoded
// default branch silently reviews the wrong range on every repo that does not
// use `main` — musive's default branch is `dev`, so "main" there is not a
// sensible fallback, it is a wrong answer with a plausible face. See
// resolveBaseRef for the order that reaches this constant.
export const DEFAULT_BASE_REF = "main";
export const DEFAULT_HEAD_REF = "HEAD";

// Keep this in sync with prompts/summarizer.md. The prompt remains the source
// of truth for execution when no model override is configured; this value is
// only the honest model label shown in a preflight plan.
export const DEFAULT_SUMMARY_MODEL = "haiku";

export class CliUsageError extends Error {}

// Runtime failure (git, gh, the filesystem) as opposed to a usage error.
// Defined here rather than in a shell so both I/O shells (cli.ts, pr.ts)
// can throw the same class without importing each other.
export class CliError extends Error {}

export interface CliOptions {
  // Relative on purpose: parseArgs is pure, so "resolve against cwd" is the
  // caller's job, not a hidden dependency on process.cwd() in a pure function.
  repo: string;
  // UNSET when no --base was given, never pre-filled with a literal branch
  // name. Resolving the real default branch needs git (the remote head), and
  // parseArgs must stay pure — so the shell in cli.ts finishes the job via
  // resolveBaseRef. A default baked in here would be a wrong ref that nothing
  // downstream can tell apart from one the user asked for.
  base?: string;
  head: string;
  agents?: string;
  out?: string;
  // Gotchas describe the REPO, not the commit under review, so they must be
  // supplyable from outside the reviewed tree — see the note in cli.ts. The
  // same is true of the config: parity triggers and priors are properties of
  // the project, and requiring them in-tree silently disables the conditional
  // parity hunter on any tree you cannot add a file to.
  gotchas?: string;
  config?: string;
  model?: string;
  // Summary activation is tri-state at parse time: undefined means no flag,
  // so review can apply flag > config > the default-on setting.
  summary?: boolean;
  // The scout (ROADMAP-DOORDASH M5). A plain boolean, NOT the summary's
  // tri-state, because there is no config seat to resolve against yet: the
  // milestone ships the flag alone, default OFF, and `.prhero/config.json`
  // stays closed to it until M6 says whether the scout is worth defaulting
  // on. `parseLocalConfig` rejects unknown keys, so a `scout` key added to a
  // config today fails loudly rather than being silently ignored.
  scout: boolean;
  // Independent model knob (§3.7), and NOT exercised by M6 — the whole
  // control corpus is sonnet, so ratifying this is ratifying a flag, not a
  // second variable. `--model` still outranks it (the JD override rule).
  scoutModel?: string;
  // Item 7: widen discovery to full B..H on a re-review. Default OFF — a
  // second push is delta-scoped unless asked otherwise. Verification,
  // triage, and classification still run (R2-C5). Review-only, like --scout.
  full: boolean;
  hopBudget: number;
  dryRun: boolean;
  yes: boolean;
  // PR mode (ROADMAP B1). Set only by --pr: head and base both come from the
  // PR record itself, so parseArgs rejects --base/--head/--two-dot beside it
  // — a hand-picked endpoint would silently contradict the PR's own range.
  // "current" is bare `--pr`: resolve the PR from the operator checkout's
  // current branch at run time (the shell owns that gh call). Absent means
  // local mode.
  pr?: number | "current";
  // Publish the review as ONE marked PR comment (ROADMAP B2) — created the
  // first time, updated in place after, never stacked. Explicit and never a
  // default: posting is a public side effect. Requires --pr (parseArgs
  // enforces it): a comment needs a PR to land on.
  post: boolean;
  // ledger only (ROADMAP B4): the runs root to scan for comparison.json
  // files. Unset means defaultRunRoot(home, repoId) — the shell resolves it,
  // because the default needs origin + ~/.prhero and parseArgs stays pure.
  runs?: string;
  // post/triage only (ROADMAP B6/B6c): the run dir to read findings.json +
  // diff.patch (post) or comparison.json (triage) from, instead of
  // producing a new run — the `ledger` verb's precedent (read run artifacts
  // off disk) applied to publishing/triaging instead of aggregating.
  // Required by both; parseArgs enforces it.
  from?: string;
  // The escape hatch for change 3's default. See resolveDiffRange's WHY: the
  // three-dot (merge-base) range is right almost always, and this flag exists
  // for the rare caller who genuinely wants the literal two-point diff.
  twoDot: boolean;
  // watch only (ROADMAP B3): which watch action was asked for. "once" is one
  // tick (the launchd unit of work), install/uninstall manage the launchd
  // agent, add/remove/status manage and inspect the watch config so nobody
  // hand-edits JSON. Required for `watch` — a bare `pr-hero watch` has no
  // daemon mode to fall into, so it fails loud instead of hanging.
  watch?: "once" | "install" | "uninstall" | "add" | "remove" | "status";
  // gc install/uninstall/status manage a SEPARATE launchd agent from the
  // watcher: it runs `pr-hero gc` (no reviews, no watch.json, no window/cap).
  // Unset means the collector itself.
  gc?: "install" | "uninstall" | "status";
  // watch install and gc install: launchd StartInterval, in minutes.
  interval?: number;
  // watch add only: record on_push: true for the repo, so every new push
  // re-arms its PRs. The default (false) reviews each PR once — see the
  // re-arm policy note on candidateSkipReason in watch-preflight.ts.
  onPush: boolean;
  // Bypass the size gate for THIS run (see size-gate.ts). Deliberately does
  // NOT imply --yes: --force answers "is this diff too big to be worth its
  // cost", and the cost band's own confirmation answers "do you want to
  // spend this" — collapsing them would let one flag skip two gates.
  force: boolean;
  // usage only (W4 / #23): show every repo_id instead of the current
  // checkout's origin-scoped view (spec "Operator-Wide View Via --all").
  // Valid on no other command — a size-gate-style boolean, not a value
  // flag, so `usage --all` and `usage` are the whole surface.
  all: boolean;
  // Size-gate overrides. UNSET means "use DEFAULT_SIZE_GATE"; 0 is a real,
  // distinct value that DISABLES the limit, so these cannot default to 0.
  maxChangedLines?: number;
  maxChangedFiles?: number;
  // `triage reply` sub-word (W1). Unset means the existing bind-ledger
  // `triage` verb. Same pattern as watch's sub-words: `reply` is not its
  // own command, so `pr-hero reply` still fails as unknown.
  triage?: "reply";
  finding?: string;
  tag?: TriageTag;
  bodyFile?: string;
  verdict?: TriageVerdict;
  issue?: number;
  // reverts only (GitHub #41): the `git log --since=` window to mine for
  // reverted/hotfixed PRs. A string, not a date, because git's own date
  // parser accepts "24 months ago" as readily as "2025-01-01" and reusing it
  // beats re-implementing it here. Unset means DEFAULT_REVERTS_SINCE — the
  // shell applies it, so parseArgs stays pure and "the operator asked for a
  // window" stays distinguishable from "nobody said".
  since?: string;
  // corpus only (GitHub #43/#44): the five candidate sources. At least one is
  // REQUIRED (enforced post-loop, where the whole set is visible) — a bare
  // `pr-hero corpus` would be a $0 no-op that looks like a scan. --proximity
  // IMPLIES --fixes (proximity suspects are computed over the fix set),
  // applied here so the shell never re-derives the implication. --issues
  // upgrades a classified set and does NOT imply --fixes; it requires
  // --fixes and/or --incidents (--proximity already implies --fixes).
  fixes: boolean;
  incidents: boolean;
  issues: boolean;
  proximity: boolean;
  threads: boolean;
  // corpus only: the proximity window in days, kept VERBATIM like --since —
  // validateProximityDays in corpus-preflight.ts owns the 1..90 rule where
  // the join that consumes it is tested. Unset means DEFAULT_PROXIMITY_DAYS.
  proximityDays?: string;
  // corpus only: csv of issue labels that mark a referenced issue as a bug.
  // Unset means DEFAULT_BUG_LABELS. GitHub labels are case-sensitive, so the
  // split (splitBugLabels) never lowercases. Requires --issues — a value
  // flag of a source that is not on would be a silently dropped intention.
  bugLabels?: string;
  // mcp only (Canonical Store / MCP): optional socket or db path overrides.
  socket?: string;
  db?: string;
  // upgrade & uninstall only
  purge?: boolean;
  check?: boolean;
  reconcile?: boolean;
  // activity only
  kill?: number;
  // config only
  configSubcommand?: "set" | "unset" | "edit";
  configKey?: string;
  configValue?: string;
  configLayer?: "person" | "team" | "watch";
  edit?: boolean;
  repoExplicit?: boolean;
}

export interface ParsedCli {
  command:
    | "review"
    | "init"
    | "setup"
    | "doctor"
    | "menu"
    | "activity"
    | "ledger"
    | "watch"
    | "post"
    | "triage"
    | "gc"
    | "usage"
    | "reverts"
    | "corpus"
    | "config"
    | "mcp"
    | "upgrade"
    | "uninstall"
    | "help";
  options: CliOptions;
}

export const HELP_TEXT = `pr-hero — multi-agent review of a real repo + branch

Usage:
  pr-hero [options]          Open interactive terminal user interface (TTY)
  pr-hero menu [options]     Open interactive terminal user interface
  pr-hero review [options]   Review a branch (zero flags inside a configured repo)
  pr-hero init [options]     Scaffold <repo>/.prhero/ (config.json + gotchas.md)
  pr-hero setup [options]    Run interactive onboarding wizard
  pr-hero doctor [options]   Check system tools and environment readiness
  pr-hero activity [options] View currently running reviews and recent store history
  pr-hero activity --kill <pid> [--yes]
                             Safely terminate a running review (checks process identity)
  pr-hero upgrade [options]  Upgrade pr-hero to latest version & sync agent assets
  pr-hero uninstall [opts]   Remove pr-hero daemons, MCP registrations & skills
  pr-hero ledger [options]   Accumulate every run's comparison.json into one
                             markdown ledger (the three buckets as a rate)
  pr-hero mcp [options]      Start the read-only Model Context Protocol (MCP)
                             server over stdio for AI coding assistants. Read-only, $0
  pr-hero post --pr <n> --from <run-dir> [--dry-run]
                             Publish a PREVIOUSLY RUN review's findings.json
                             to PR <n>, reading it (and diff.patch) off disk
                             instead of running a fresh review — the same
                             fetch → match → post flow --pr --post uses.
                             --dry-run renders the planned comment set at $0
                             and posts nothing (the only way to preview a
                             plan, since --pr --dry-run returns before any
                             findings exist)
  pr-hero triage --pr <n> --from <run-dir> [--dry-run]
                             Read the PR's reply threads, bind every triage
                             reply (ROADMAP B6b's marker) to its finding's
                             row in that run's comparison.json, and write
                             verdict/reasoning/actor back — the ledger's two
                             null columns, filled from the loop instead of by
                             hand. --dry-run reports what would be bound and
                             writes nothing
  pr-hero triage reply --pr <n> --from <run-dir> --finding <id> --tag <tag>
                   --body-file <path> [--verdict <v>] [--issue <n>] [--dry-run]
                             Post one triage reply. The driver resolves the
                             parent from the posted <!-- pr-hero-finding
                             marker (never path/line), renders the marker +
                             badge, posts, and resolves the inline review
                             thread. --body-file is reasoning prose only.
                             --dry-run prints the parent and posts nothing
  pr-hero reverts [options]  Mine the repo's default branch for PRs that were
                             later reverted or hotfixed, and write them as
                             markdown CANDIDATES for human confirmation. Runs
                             git log + gh api only: no review, no scoring, no
                             labelling of what the defect was, $0
  pr-hero corpus [options]   Widen the known-bad corpus beyond reverts with
                             five candidate sources, gated by their flags:
                             --fixes (fix-shaped merged PRs, blame-resolved
                             to their likely introducer), --incidents
                             (incident/outage keywords in title/body),
                             --issues (upgrade classified PRs that reference
                             a bug-labelled GitHub issue), --proximity
                             (prior PRs on the same files when the introducer
                             did not resolve), --threads (defects review DID
                             catch, from resolved review threads). At least
                             one source is required; --issues needs --fixes
                             and/or --incidents. All output is CANDIDATES
                             for human confirmation. git log + gh api only:
                             no review, no scoring, $0
  pr-hero watch --once       Run ONE watcher tick over ~/.prhero/watch.json:
                             pick the next unreviewed open PR across the
                             configured repos and review it. launchd (or cron)
                             is the scheduler; this never daemonizes
  pr-hero watch add          Opt the current repo (or --repo) into the watch
                             config; --post makes its reviews publish to the
                             PR, --on-push re-reviews on every push,
                             --max-changed-lines/--max-changed-files set the
                             repo's size gate.
                             Idempotent — re-adding updates the flags
  pr-hero watch remove       Remove the current repo (or --repo) from the
                             watch config (idempotent)
  pr-hero watch status       Read-only: config summary, today's launch count
                             vs the cap, launchd state, lock, last activity
  pr-hero watch install      Install the macOS launchd agent that runs
                             "watch --once" every --interval minutes
  pr-hero watch uninstall    Unload and remove that launchd agent
  pr-hero gc [--dry-run] [--repo <dir>]
                             Collect review worktrees under ~/.prhero/repos
                             that are merged/closed or idle >72h. --dry-run
                             prints the table and removes nothing. --repo
                             scopes to one origin; default is the whole home
  pr-hero gc install         Install the macOS launchd agent that runs
                             "pr-hero gc" every --interval minutes (default
                             ${DEFAULT_GC_INTERVAL_MIN} = 6h). No reviews,
                             no watch.json — the $0 sweeper so trees do not
                             wait for a review or the watcher
  pr-hero gc uninstall       Unload and remove that launchd agent
  pr-hero gc status          Read-only: whether the GC agent is installed
  pr-hero usage [--all]      Print the observability store's per-run rows
                             (cost, tokens, findings) for the current
                             checkout's origin — every review, local and
                             PR, auto-ingests into it. --all shows every
                             origin instead of just this one. Read-only, $0
  pr-hero config [options]   Print every config key's effective value and the
                             LAYER it came from — global (~/.prhero/config.json),
                             repo (<repo>/.prhero/config.json), capped (the
                             global ceiling narrowed the repo's value away) or
                             default (neither file spoke). Names both file
                             paths whether or not they exist. Resolves through
                             the same merge a review does, so it cannot drift
                             from what actually runs. Read-only — it never
                             writes either file. $0

Options:
  --repo <dir>        Repository to review (default: current directory)
  --pr [n]            Review GitHub PR #n — or, with no number, the PR that
                      belongs to the current branch. head and base come from
                      gh, the review runs in a detached worktree with its
                      own codegraph index, and the result is compared
                      against Greptile's comment on the PR. Excludes --base,
                      --head and --two-dot
  --post              With --pr only: publish the review to the PR as one
                      marked comment — created the first time, updated in
                      place on re-runs, never stacked. Explicit, never a
                      default. With watch add: record post: true, so the
                      watcher-launched reviews of that repo publish
  --base <ref>        Base branch or sha. Default, in order: the config's
                      default_base, then the remote head
                      (refs/remotes/origin/HEAD), then ${DEFAULT_BASE_REF}
  --head <ref>        Head branch or sha (default: ${DEFAULT_HEAD_REF})
  --agents <dir>      Prompt-set directory. Default, in order: the config's
                      agents_dir (relative paths resolve against the config
                      file), then PRHERO_AGENTS_DIR
  --out <dir>         Run directory; must live OUTSIDE the reviewed repo
                      (default: ~/.prhero/repos/<origin>/runs/<sha>-<n>).
                      For ledger, reverts and corpus: the file to write
                      instead of stdout
  --since <git-date>  reverts and corpus only: how far back to scan the
                      default branch, in any form git's --since accepts
                      ("6 months ago", "2025-01-01"). Default: 24 months ago
  --fixes             corpus only: mine fix-shaped merged PRs (anchored
                      conventional fix/bugfix subject) and blame-resolve each
                      to the PR that last touched the fixed lines
  --incidents         corpus only: mine merged PRs whose title or body carry
                      incident keywords (incident, outage, sentry,
                      crashlytics)
  --issues            corpus only: upgrade classified PRs that reference a
                      GitHub issue labelled as a bug. Requires --fixes
                      and/or --incidents — issue refs do not enter alone
  --proximity         corpus only: for fix PRs whose introducer did not
                      resolve, list prior PRs on the same files within
                      --proximity-days. Implies --fixes — proximity is
                      computed over the fix set
  --threads           corpus only: mine resolved review threads a later push
                      plausibly addressed — the defects review DID catch
  --proximity-days <n>
                      corpus only: the proximity window in days, an integer
                      between 1 and 90. Default: 7
  --bug-labels <csv>  corpus only: with --issues, issue labels that mark a
                      referenced issue as a bug (comma-separated,
                      case-sensitive). Default: bug
  --runs <dir>        ledger only: the runs root to scan for comparison.json
                      files (default: ~/.prhero/repos/<origin>/runs)
  --from <dir>        post/triage only: the run dir to read findings.json and
                      diff.patch (post and triage reply) or comparison.json
                      (triage bind) from (required). triage reply maps
                      --finding F00N onto the posted marker via the same
                      post-line remapping post uses
  --finding <id>      triage reply only: the finding id in that run's
                      findings.json (F001, …). The driver maps it to the
                      posted comment; do not pass a GitHub comment id
  --tag <tag>         triage reply only: applied, dismissed, deferred, or
                      misclassified
  --body-file <path>  triage reply only: reasoning prose. The driver prepends
                      the triage marker and the visible badge
  --verdict <word>    triage reply only: upheld, rejected, or inconclusive.
                      Required for dismissed/deferred/misclassified;
                      forbidden for applied
  --issue <n>         triage reply only: optional GitHub issue number on
                      deferred. Not required — deferred is a tag plus
                      reasoning; the coding agent decides whether an issue
                      exists
  --gotchas <file>    Repo gotchas file (default: <repo>/.prhero/gotchas.md);
                      supply it from outside to review a tree you cannot dirty
  --config <file>     Local config (default: <repo>/.prhero/config.json) with
                      agents_dir, default_base, parity_trigger_paths and
                      suspicion_priors, optional summary settings, and
                      optional max_verification_steps (re-review verify cap;
                      default 8; 0 pauses verification)
  --model <model>     Override every agent's model
  --summary           Enable the engine-owned PR summary (default)
  --no-summary        Disable the engine-owned PR summary
  --scout             review only: run the diff-only scout stage before the
                      hunters, biasing their scan with unverified leads.
                      EXPERIMENTAL and off by default — the A/B that decides
                      whether it earns its cost has not run yet
  --scout-model <m>   Model for the scout stage (default: the run's model).
                      Requires --scout
  --full              review only: on a re-review, widen discovery to the
                      full PR range (B..H). Verification and triage still
                      run; the recorded case does not change
  --hop-budget <n>    Hops per hunter (default: ${DEFAULT_HOP_BUDGET}); the biggest
                      per-hunter cost lever there is
  --two-dot           Diff the literal <base>..<head> two-point range instead
                      of from the merge base. Rarely what you want: when base
                      has moved on, its newer commits show up REVERSED in the
                      review
  --once              watch only: run one tick and exit (launchd's unit of
                      work). Required — watch has no daemon mode
  --on-push           watch add only: re-review the repo's PRs on every new
                      push. Default: each PR is reviewed ONCE — a push does
                      not re-bill; re-review manually with review --pr <n>
  --interval <min>    watch install and gc install: minutes between launchd
                      ticks (watch default: ${DEFAULT_WATCH_INTERVAL_MIN};
                      gc default: ${DEFAULT_GC_INTERVAL_MIN})
  --dry-run           Resolve, preflight, print the plan and the cost band,
                      then exit without spawning anything. For watch --once:
                      print what would be skipped/launched and why, touching
                      nothing
  --max-changed-lines <n>
                      Size gate: skip the review when the diff has more than
                      n effective changed lines (insertions + deletions,
                      generated files like lockfiles and minified bundles
                      excluded). Default ${DEFAULT_SIZE_GATE.maxChangedLines}; 0 disables the limit.
                      With watch add: record the threshold for the repo
  --max-changed-files <n>
                      Size gate: same, on the effective changed-FILE count.
                      Default ${DEFAULT_SIZE_GATE.maxChangedFiles}; 0 disables the limit
  --force             Review the diff even when the size gate would skip it.
                      An interactive TTY already offers the same choice as a
                      menu; this flag is the unattended hatch. Does NOT imply
                      --yes — the cost band still asks
  --all               usage only: show every origin's rows instead of just
                      the current checkout's
  --yes               Skip the confirmation prompt
  --help              Show this text

By default the diff runs from the MERGE BASE of base and head (the three-dot
range), so only what this branch adds is reviewed. The plan prints both the
base ref you asked for and the merge-base sha it actually used.

Every run costs real money. --dry-run costs nothing and answers most
questions; use it first.

The size gate is a COST gate, not a quality gate: past its limits a diff bills
several times more with a much wider spread, so pr-hero skips it unattended
rather than guess at the bill. An interactive run asks first. It says nothing
about how well a large diff reviews.`;

const VALUE_FLAGS = new Set([
  "--repo",
  "--base",
  "--head",
  "--agents",
  "--out",
  "--runs",
  "--from",
  "--gotchas",
  "--config",
  "--model",
  "--scout-model",
  "--hop-budget",
  "--interval",
  "--max-changed-lines",
  "--max-changed-files",
  "--finding",
  "--tag",
  "--body-file",
  "--verdict",
  "--issue",
  "--since",
  "--proximity-days",
  "--bug-labels",
  "--socket",
  "--db",
  "--kill",
]);

export function parseArgs(argv: string[]): ParsedCli {
  const options: CliOptions = {
    repo: ".",
    head: DEFAULT_HEAD_REF,
    hopBudget: DEFAULT_HOP_BUDGET,
    // Default OFF is the milestone's exit criterion, not a preference: M6
    // compares an arm against a control, and a control that quietly grew a
    // stage is not a control.
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
  };
  let command:
    | "review"
    | "init"
    | "setup"
    | "doctor"
    | "menu"
    | "activity"
    | "ledger"
    | "watch"
    | "post"
    | "triage"
    | "gc"
    | "usage"
    | "reverts"
    | "corpus"
    | "config"
    | "mcp"
    | "upgrade"
    | "uninstall"
    | "help"
    | undefined;
  // --head carries a baked-in default, so "was it explicitly given" cannot
  // be read off options afterwards — and the --pr exclusion below must fire
  // on an explicit --head even when its value equals that default.
  let headExplicit = false;
  // --once is watch's tick switch; folded into options.watch after the loop
  // so flag order (watch --once vs --once watch) cannot matter.
  let once = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") return { command: "help", options };
    // --pr takes an OPTIONAL value. A digit-LEADING next token is consumed
    // and validated — digit-leading on purpose, not full-match: garbage like
    // "12abc" must still reach the validator and fail loudly, never silently
    // become branch-mode. Anything else (nothing, a flag, a word — including
    // the command token, which the non-digit rule protects) is left alone
    // and the sentinel says "resolve the PR from the current branch".
    if (arg === "--pr") {
      const value = argv[i + 1];
      if (value !== undefined && /^\d/.test(value)) {
        i++;
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new CliUsageError(
            `--pr must be a positive integer, got: ${value}`,
          );
        }
        options.pr = parsed;
      } else {
        options.pr = "current";
      }
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      // A flag swallowing the NEXT flag as its value is the classic way to
      // end up reviewing the wrong tree: `--base --head foo` would otherwise
      // resolve base to "--head".
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(`${arg} needs a value`);
      }
      i++;
      if (arg === "--head") headExplicit = true;
      if (arg === "--repo") options.repoExplicit = true;
      applyValueFlag(options, arg, value);
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--summary") {
      options.summary = true;
      continue;
    }
    if (arg === "--no-summary") {
      options.summary = false;
      continue;
    }
    // No `--no-scout`: the flag is off unless asked for, so the negation
    // would only ever restate the default.
    if (arg === "--scout") {
      options.scout = true;
      continue;
    }
    if (arg === "--full") {
      options.full = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      options.yes = true;
      continue;
    }
    if (arg === "--post") {
      options.post = true;
      continue;
    }
    if (arg === "--two-dot") {
      options.twoDot = true;
      continue;
    }
    if (arg === "--once") {
      once = true;
      continue;
    }
    if (arg === "--on-push") {
      options.onPush = true;
      continue;
    }
    // NOT folded into --yes: --force overrides the size gate only. See the
    // WHY on CliOptions.force.
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    if (arg === "--purge") {
      options.purge = true;
      continue;
    }
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--reconcile") {
      options.reconcile = true;
      continue;
    }
    // The five corpus sources, size-gate-style booleans — no values, and the
    // post-loop corpus block owns their cross-command rules (required-set,
    // --proximity implies --fixes, --issues needs a classified-set source).
    if (arg === "--fixes") {
      options.fixes = true;
      continue;
    }
    if (arg === "--incidents") {
      options.incidents = true;
      continue;
    }
    if (arg === "--issues") {
      options.issues = true;
      continue;
    }
    if (arg === "--proximity") {
      options.proximity = true;
      continue;
    }
    if (arg === "--threads") {
      options.threads = true;
      continue;
    }
    if (arg === "--person") {
      options.configLayer = "person";
      continue;
    }
    if (arg === "--team") {
      options.configLayer = "team";
      continue;
    }
    if (arg === "--watch") {
      options.configLayer = "watch";
      continue;
    }
    if (arg === "--edit") {
      options.edit = true;
      options.configSubcommand = "edit";
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CliUsageError(`unknown option: ${arg}`);
    }
    // install/uninstall/add/remove/status are watch's sub-words, not
    // commands of their own: they only parse AFTER `watch`, so `pr-hero
    // install` still fails with the unknown-command list instead of
    // silently touching launchd.
    if (
      command === "watch" &&
      options.watch === undefined &&
      (arg === "install" ||
        arg === "uninstall" ||
        arg === "add" ||
        arg === "remove" ||
        arg === "status")
    ) {
      options.watch = arg;
      continue;
    }
    if (command === "config" && options.configSubcommand === undefined) {
      if (arg === "set") {
        options.configSubcommand = "set";
        const key = argv[++i];
        if (!key || key.startsWith("-")) {
          throw new CliUsageError("config set requires <key> and <value>");
        }
        const val = argv[++i];
        if (!val || val.startsWith("--")) {
          throw new CliUsageError("config set requires <key> and <value>");
        }
        options.configKey = key;
        options.configValue = val;
        continue;
      }
      if (arg === "unset") {
        options.configSubcommand = "unset";
        const key = argv[++i];
        if (!key || key.startsWith("-")) {
          throw new CliUsageError("config unset requires <key>");
        }
        options.configKey = key;
        continue;
      }
      if (arg === "edit") {
        options.configSubcommand = "edit";
        continue;
      }
    }
    if (
      command === "gc" &&
      options.gc === undefined &&
      (arg === "install" || arg === "uninstall" || arg === "status")
    ) {
      options.gc = arg;
      continue;
    }
    if (
      command === "triage" &&
      options.triage === undefined &&
      arg === "reply"
    ) {
      options.triage = "reply";
      continue;
    }
    if (command !== undefined) {
      throw new CliUsageError(`unexpected argument: ${arg}`);
    }
    if (
      arg !== "review" &&
      arg !== "init" &&
      arg !== "setup" &&
      arg !== "doctor" &&
      arg !== "menu" &&
      arg !== "activity" &&
      arg !== "ledger" &&
      arg !== "watch" &&
      arg !== "post" &&
      arg !== "triage" &&
      arg !== "gc" &&
      arg !== "usage" &&
      arg !== "reverts" &&
      arg !== "corpus" &&
      arg !== "config" &&
      arg !== "mcp" &&
      arg !== "upgrade" &&
      arg !== "update" &&
      arg !== "uninstall"
    ) {
      throw new CliUsageError(
        `unknown command: ${arg} (the commands are "menu", "review", "init", "setup", "doctor", ` +
          '"activity", "ledger", "watch", "post", "triage", "gc", "usage", ' +
          '"reverts", "corpus", "config", "mcp", "upgrade" and "uninstall")',
      );
    }
    command = arg === "update" ? "upgrade" : arg;
  }
  if (command === undefined) {
    throw new CliUsageError(
      'no command given (did you mean "pr-hero review"?)',
    );
  }
  // --pr derives the whole range from the PR record — head from GitHub, base
  // from the merge commit's parent or the base branch — so a hand-picked
  // endpoint or range shape beside it would silently contradict what the PR
  // actually contains. Checked after the loop so flag order cannot matter.
  if (options.pr !== undefined) {
    if (options.base !== undefined) {
      throw new CliUsageError(
        "--pr resolves base from the PR itself, so it cannot be combined " +
          "with --base",
      );
    }
    if (headExplicit) {
      throw new CliUsageError(
        "--pr reviews the PR's own head commit, so it cannot be combined " +
          "with --head",
      );
    }
    if (options.twoDot) {
      throw new CliUsageError(
        "--pr always diffs the PR from its merge base, so it cannot be " +
          "combined with --two-dot",
      );
    }
  }
  // Also after the loop, for the same flag-order reason: posting publishes a
  // PR comment, and only --pr names a PR to publish to. `watch` is excused —
  // there --post is `watch add`'s flag, validated in the watch block below.
  // `post` (the command) is ALSO excused: it always targets a PR via its own
  // required --pr, so it needs no --post flag at all — see the "post" block
  // below.
  if (
    options.post &&
    options.pr === undefined &&
    command !== "watch" &&
    command !== "post"
  ) {
    throw new CliUsageError(
      "--post publishes the review as a PR comment, so it requires --pr",
    );
  }
  // The scout is a `review` stage and nothing else reads either flag.
  // Rejected elsewhere rather than ignored, the --from guard's reasoning: a
  // flag that parses and then does nothing is an operator believing they
  // changed a run they did not.
  if (command !== "review" && (options.scout || options.scoutModel)) {
    throw new CliUsageError(
      "--scout and --scout-model only apply to the review command",
    );
  }
  if (command !== "review" && options.full) {
    throw new CliUsageError("--full only applies to the review command");
  }
  // A model for a stage that will not run is the same silent no-op, one level
  // down — and the likeliest way to produce it is believing the model flag
  // turns the stage on.
  if (options.scoutModel !== undefined && !options.scout) {
    throw new CliUsageError(
      "--scout-model sets the model for the scout stage, so it requires --scout",
    );
  }
  // `post` (ROADMAP B6) and `triage` (ROADMAP B6c) share the same shape:
  // both read a PRIOR run's artifacts, named by --from, and act on the PR
  // named by --pr. Both flags required for either — a command with neither
  // has nothing to read and nowhere to bind it, and guessing either would
  // silently act on the wrong run or the wrong PR.
  if (command === "post" || command === "triage") {
    if (options.pr === undefined) {
      throw new CliUsageError(`${command} requires --pr <n>`);
    }
    if (options.from === undefined) {
      throw new CliUsageError(`${command} requires --from <run-dir>`);
    }
  } else if (options.from !== undefined) {
    throw new CliUsageError(
      "--from only applies to the post and triage commands",
    );
  }
  // --since names the `git log` window `reverts` and `corpus` mine, and
  // nothing else reads it. Rejected elsewhere rather than ignored: a flag
  // that parses and then does nothing is an operator believing they scoped a
  // command they did not — the same reasoning as the --from guard above.
  if (
    options.since !== undefined &&
    command !== "reverts" &&
    command !== "corpus"
  ) {
    throw new CliUsageError(
      "--since only applies to the reverts and corpus commands",
    );
  }
  // The corpus source flags and their two value flags are corpus-only, same
  // reasoning as the --since guard: each names the source it enables, and on
  // any other command it would be a silently dropped intention.
  if (command !== "corpus") {
    if (options.fixes) {
      throw new CliUsageError("--fixes only applies to the corpus command");
    }
    if (options.incidents) {
      throw new CliUsageError("--incidents only applies to the corpus command");
    }
    if (options.issues) {
      throw new CliUsageError("--issues only applies to the corpus command");
    }
    if (options.proximity) {
      throw new CliUsageError("--proximity only applies to the corpus command");
    }
    if (options.threads) {
      throw new CliUsageError("--threads only applies to the corpus command");
    }
    if (options.proximityDays !== undefined) {
      throw new CliUsageError(
        "--proximity-days only applies to the corpus command",
      );
    }
    if (options.bugLabels !== undefined) {
      throw new CliUsageError(
        "--bug-labels only applies to the corpus command",
      );
    }
  } else {
    // Checked after the loop, where the whole flag set is visible at once:
    // corpus with NO source would be a $0 no-op that looks like a scan, and
    // the error names all five so the fix is one copy-paste away.
    if (
      !options.fixes &&
      !options.incidents &&
      !options.issues &&
      !options.proximity &&
      !options.threads
    ) {
      throw new CliUsageError(
        "corpus needs at least one source: --fixes, --incidents, " +
          "--issues, --proximity or --threads",
      );
    }
    // Proximity suspects are computed over the fix set, so a --proximity run
    // IS a --fixes run. Applied here rather than in the shell so the
    // implication is one pure, tested rule instead of an I/O re-derivation.
    if (options.proximity) options.fixes = true;
    // --bug-labels is the value flag of --issues. Passing it without the
    // source would silently configure a walk that never consults the labels.
    if (options.bugLabels !== undefined && !options.issues) {
      throw new CliUsageError("--bug-labels requires --issues");
    }
    // Issue refs upgrade a classified set; they do not enter on their own.
    // --proximity has already implied --fixes, so --issues --proximity is
    // valid. --issues --threads is not: threads do not populate `working`.
    if (options.issues && !options.fixes && !options.incidents) {
      throw new CliUsageError(
        "--issues upgrades classified PRs; pass --fixes and/or --incidents",
      );
    }
  }
  // spec "--all misused on another command": --all is usage's own
  // operator-wide escape hatch, and valid on nothing else.
  if (options.all && command !== "usage") {
    throw new CliUsageError("--all only applies to usage");
  }
  if (options.kill !== undefined && command !== "activity") {
    throw new CliUsageError("--kill only applies to the activity command");
  }
  // The watch surface, validated after the loop for the same order-blindness.
  if (command === "watch") {
    if (once && options.watch !== undefined) {
      throw new CliUsageError(
        `--once cannot be combined with "${options.watch}"`,
      );
    }
    if (once) options.watch = "once";
    if (options.watch === undefined) {
      throw new CliUsageError(
        'watch needs an action: --once (one tick), "add", "remove", ' +
          '"status", "install" or "uninstall"',
      );
    }
    if (options.dryRun && options.watch !== "once") {
      throw new CliUsageError(
        `--dry-run only applies to watch --once, not "${options.watch}"`,
      );
    }
    // On watch, --post configures the repo being added — anywhere else in
    // the watch surface it would be a silently dropped intention.
    if (options.post && options.watch !== "add") {
      throw new CliUsageError(
        `--post with watch only applies to "watch add", not "${options.watch}"`,
      );
    }
    // Same rule for --on-push, for the same silently-dropped reason.
    if (options.onPush && options.watch !== "add") {
      throw new CliUsageError(
        `--on-push only applies to "watch add", not "${options.watch}"`,
      );
    }
  } else {
    if (once) {
      throw new CliUsageError("--once only applies to the watch command");
    }
    if (options.onPush) {
      throw new CliUsageError('--on-push only applies to "watch add"');
    }
  }
  if (options.interval !== undefined) {
    const allowed =
      (command === "watch" && options.watch === "install") ||
      (command === "gc" && options.gc === "install");
    if (!allowed) {
      throw new CliUsageError(
        "--interval only applies to watch install and gc install",
      );
    }
  }
  if (command === "gc" && options.gc !== undefined && options.dryRun) {
    throw new CliUsageError(
      `--dry-run only applies to bare gc, not "gc ${options.gc}"`,
    );
  }
  if (options.triage === "reply") {
    if (options.finding === undefined) {
      throw new CliUsageError("triage reply requires --finding <id>");
    }
    if (options.tag === undefined) {
      throw new CliUsageError("triage reply requires --tag <tag>");
    }
    if (options.bodyFile === undefined) {
      throw new CliUsageError("triage reply requires --body-file <path>");
    }
    if (ADJUDICATED_TAGS.has(options.tag) && options.verdict === undefined) {
      throw new CliUsageError(
        `triage reply --tag ${options.tag} requires --verdict ` +
          "(upheld, rejected, or inconclusive)",
      );
    }
    if (options.tag === "applied" && options.verdict !== undefined) {
      throw new CliUsageError(
        "triage reply --tag applied cannot take --verdict " +
          "(applied pays no adjudicator)",
      );
    }
    if (options.issue !== undefined && options.tag !== "deferred") {
      throw new CliUsageError(
        "triage reply --issue only applies to --tag deferred",
      );
    }
  } else {
    if (options.finding !== undefined) {
      throw new CliUsageError("--finding only applies to triage reply");
    }
    if (options.tag !== undefined) {
      throw new CliUsageError("--tag only applies to triage reply");
    }
    if (options.bodyFile !== undefined) {
      throw new CliUsageError("--body-file only applies to triage reply");
    }
    if (options.verdict !== undefined) {
      throw new CliUsageError("--verdict only applies to triage reply");
    }
    if (options.issue !== undefined) {
      throw new CliUsageError("--issue only applies to triage reply");
    }
  }
  if (command === "config" && options.configSubcommand !== undefined) {
    options.configLayer = options.configLayer ?? "person";
  }
  return { command, options };
}

function applyValueFlag(
  options: CliOptions,
  flag: string,
  value: string,
): void {
  switch (flag) {
    case "--repo":
      options.repo = value;
      return;
    case "--base":
      options.base = value;
      return;
    case "--head":
      options.head = value;
      return;
    case "--agents":
      options.agents = value;
      return;
    case "--out":
      options.out = value;
      return;
    case "--gotchas":
      options.gotchas = value;
      return;
    case "--config":
      options.config = value;
      return;
    case "--model":
      options.model = value;
      return;
    case "--scout-model":
      options.scoutModel = value;
      return;
    case "--runs":
      options.runs = value;
      return;
    case "--from":
      options.from = value;
      return;
    case "--interval": {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new CliUsageError(
          `--interval must be a positive integer (minutes), got: ${value}`,
        );
      }
      options.interval = parsed;
      return;
    }
    // >= 0, unlike every other numeric flag here: 0 is the documented
    // "disable this limit" value, not a nonsense input.
    case "--max-changed-lines":
      options.maxChangedLines = parseLimit(flag, value);
      return;
    case "--max-changed-files":
      options.maxChangedFiles = parseLimit(flag, value);
      return;
    case "--finding":
      options.finding = value;
      return;
    case "--tag": {
      if (
        value !== "applied" &&
        value !== "dismissed" &&
        value !== "deferred" &&
        value !== "misclassified"
      ) {
        throw new CliUsageError(
          `--tag must be applied, dismissed, deferred or misclassified, ` +
            `got: ${value}`,
        );
      }
      options.tag = value;
      return;
    }
    case "--body-file":
      options.bodyFile = value;
      return;
    case "--verdict": {
      if (
        value !== "upheld" &&
        value !== "rejected" &&
        value !== "inconclusive"
      ) {
        throw new CliUsageError(
          `--verdict must be upheld, rejected or inconclusive, got: ${value}`,
        );
      }
      options.verdict = value;
      return;
    }
    // Kept as a raw string and handed to `git log --since=` verbatim: git's
    // date parser is the authority on what "24 months ago" means, and a
    // validator here could only be a worse second opinion. It MUST have its
    // own case — the switch's `default:` is --hop-budget's integer parser,
    // so a missing case would reject a perfectly good date with an error
    // naming a flag the operator never typed.
    case "--since":
      options.since = value;
      return;
    // Kept verbatim, exactly like --since: the 1..90 range rule belongs to
    // validateProximityDays in corpus-preflight.ts, next to the join that
    // consumes the number — an integer parser HERE would be a second opinion
    // the shell's validator contradicts. Same own-case reasoning as --since
    // (the switch's `default:` is --hop-budget's integer parser).
    case "--proximity-days":
      options.proximityDays = value;
      return;
    // Also verbatim: splitBugLabels owns the trim/dedupe rules, and the csv
    // must survive byte-for-byte so error messages can quote what was typed.
    case "--bug-labels":
      options.bugLabels = value;
      return;
    case "--issue": {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new CliUsageError(
          `--issue must be a positive integer, got: ${value}`,
        );
      }
      options.issue = parsed;
      return;
    }
    case "--socket":
      options.socket = value;
      return;
    case "--db":
      options.db = value;
      return;
    case "--kill": {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new CliUsageError(
          `--kill must be a positive integer (PID), got: ${value}`,
        );
      }
      options.kill = parsed;
      return;
    }
    default: {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new CliUsageError(
          `--hop-budget must be a positive integer, got: ${value}`,
        );
      }
      options.hopBudget = parsed;
    }
  }
}

function parseLimit(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliUsageError(
      `${flag} must be a non-negative integer (0 disables the limit), ` +
        `got: ${value}`,
    );
  }
  return parsed;
}

export type BaseRefSource = "flag" | "config" | "remote" | "fallback";

export interface BaseRefResolution {
  ref: string;
  source: BaseRefSource;
}

// `git symbolic-ref refs/remotes/origin/HEAD` answers with the full ref name
// (`refs/remotes/origin/dev`); everything downstream wants the branch. Split
// out as its own function because the shell can only hand it a string, and a
// prefix strip that is wrong by one character reviews a ref nobody named.
// Returns undefined for anything that is not that shape — including the empty
// output of a repo whose origin/HEAD was never set, which is not an error.
export function parseRemoteHead(raw: string): string | undefined {
  const trimmed = raw.trim();
  const prefix = "refs/remotes/origin/";
  if (!trimmed.startsWith(prefix)) return undefined;
  const branch = trimmed.slice(prefix.length);
  return branch.length > 0 ? branch : undefined;
}

// The repository's web URL, derived from a git remote instead of asked of
// `gh`. WHY it exists next to pr.ts's ghRepoWebUrl rather than replacing it:
// ghRepoWebUrl is one `gh repo view` process per call and used to live ONLY
// inside the `--post` branch, so every run without --post had no web URL and
// the terminal could not print a single clickable link. The remote is already
// on disk — free, offline, no API — which is what makes a link affordable on
// EVERY run. Posting keeps ghRepoWebUrl: it is the authority GitHub itself
// answers with (renames, transfers, forks), and the comment bodies it feeds
// are published artifacts, not a terminal nicety.
//
// The three shapes a github remote actually takes, all normalised to the same
// canonical https form: SCP-style `git@github.com:owner/repo(.git)`,
// `https://github.com/owner/repo(.git)(/)`, and `ssh://git@github.com/owner/
// repo(.git)`. ANYTHING else — a non-github host, an enterprise host, a
// missing remote, an owner/repo that does not parse — returns undefined, and
// the caller degrades to a plain `path:line`. A GUESSED url is strictly worse
// than no url: a 404 teaches the reader to stop trusting every link in the
// block (the same honesty rule as cli.ts's "repo web url unavailable:
// posting plain locations").
const GITHUB_HOST = "github.com";

export function repoWebUrlFromRemote(remote: string): string | undefined {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return undefined;
  // SCP syntax first: it is NOT a URL (no scheme), so `new URL` rejects it —
  // and it is the shape a cloned-over-ssh checkout carries by default.
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(trimmed);
  let host: string;
  let repoPath: string;
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    host = parsed.hostname;
    repoPath = parsed.pathname;
  }
  if (host.toLowerCase() !== GITHUB_HOST) return undefined;
  const slug = repoPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  // Exactly owner/repo. A deeper path is not a repository root, and building
  // a blob url on top of one produces a link that resolves to nothing.
  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) return undefined;
  return `https://${GITHUB_HOST}/${slug}`;
}

// WHY this order, and WHY it is a function rather than a default: the base ref
// decides WHICH range gets reviewed, and a hardcoded "main" is silently wrong
// on any repo that does not use it (musive is on `dev`). So the explicit flag
// wins, then the repo's own recorded choice, then what the remote actually
// says its default branch is, and only then the historical literal. The git
// call that produces `remoteHead` lives in the shell; this stays pure so every
// branch of the precedence is tested without a repo.
export function resolveBaseRef(input: {
  flag?: string | undefined;
  configDefaultBase?: string | undefined;
  remoteHead?: string | undefined;
}): BaseRefResolution {
  if (input.flag) return { ref: input.flag, source: "flag" };
  if (input.configDefaultBase) {
    return { ref: input.configDefaultBase, source: "config" };
  }
  if (input.remoteHead) return { ref: input.remoteHead, source: "remote" };
  return { ref: DEFAULT_BASE_REF, source: "fallback" };
}

// C5 §3.6: `"config"` is RETIRED. Two files can carry `agents_dir` now, and
// one label covering both would tell the operator the value came from "the
// config" while leaving them to guess which of two files to open — for the
// single biggest spend lever in the file, whose prompt-set frontmatter picks
// every hunter's model.
export type AgentsDirSource = "flag" | "repo" | "global" | "env" | "default";

export interface AgentsDirResolution {
  dir: string;
  source: AgentsDirSource;
}

// The config seat as ONE object rather than three loose optionals. A value,
// the layer that spoke it, and the directory that value is relative TO are a
// single fact: split apart, a caller can hand over the GLOBAL file's
// `agents_dir` with the REPO's `.prhero/` as its base, which resolves a
// relative path against a directory the value never lived in and then labels
// the result `repo`. Grouped, that mistake does not type-check — which is the
// only mitigation available, because the two are both `string` and tsc cannot
// otherwise tell them apart (judgment ledger JD-14).
export interface AgentsDirConfigSeat {
  value: string;
  // Read off mergeConfig's source record by `agentsDirSeat` below: the merge
  // is the only thing that knows which layer won.
  layer: Extract<ConfigSource, "repo" | "global">;
  // The directory the RELATIVE case resolves against — the dirname of the
  // file `layer` names, never cwd and never the other layer's.
  dir: string;
}

// WHY `agents_dir` belongs in the config at all: requiring a flag that points
// into a SIBLING repository is the single thing that stopped this from being a
// one-word command inside the repo being reviewed. Recorded once in
// .prhero/config.json, `pr-hero review` needs no arguments.
//
// The relative case resolves against the CONFIG FILE's directory, not cwd: the
// config is the thing that names the path, so the path travels with it. A
// cwd-relative reading would make the same config mean different prompt sets
// depending on which subdirectory the developer happened to be standing in.
// After C5 "the config file" is whichever LAYER won, which is why the seat
// carries its own directory instead of taking one from the caller's context.
export function resolveAgentsDirSetting(input: {
  flag?: string | undefined;
  config?: AgentsDirConfigSeat | undefined;
  env?: string | undefined;
  cwd: string;
}): AgentsDirResolution {
  if (input.flag) {
    return { dir: path.resolve(input.cwd, input.flag), source: "flag" };
  }
  if (input.config) {
    return {
      dir: path.resolve(input.config.dir, input.config.value),
      source: input.config.layer,
    };
  }
  if (input.env) {
    return { dir: path.resolve(input.cwd, input.env), source: "env" };
  }
  const assets = resolveEngineAssets();
  return {
    dir: assets.defaultAgentsDir,
    source: "default",
  };
}

// The seat, assembled from the merge's own source record. THIS is the one
// place that record is load-bearing at RUNTIME rather than for display
// (judgment ledger JD-14): a relative `"agents_dir": "./prompts"` in the
// global file must resolve under `~/.prhero/`, while the same string in the
// repo file resolves under `<repo>/.prhero/`. They are two different prompt
// sets — one the operator's, one the team's — and resolving the global value
// against the repo's directory picks a set nobody configured, or throws
// "agents dir does not exist" naming a path that appears in neither file.
//
// Pure and here rather than in the shell for CLAUDE.md's split: the FILES are
// the shell's business, the decision of which of them a value belongs to is
// not, and it is the half that has to be provable offline.
export function agentsDirSeat(input: {
  config: Pick<LocalConfig, "agents_dir">;
  sources: Pick<ConfigSources, "agents_dir">;
  repoConfigPath: string;
  globalConfigPath: string;
}): AgentsDirConfigSeat | undefined {
  const value = input.config.agents_dir;
  if (value === undefined) return undefined;
  // `agents_dir` is a `person` key, so `capped` cannot occur, and `default`
  // cannot occur for a value some layer demonstrably spoke. Everything that
  // is not `global` is therefore the repo file — written as the remainder
  // rather than as a second equality so a direction change cannot land the
  // value in a branch that silently drops it.
  const fromGlobal = input.sources.agents_dir === "global";
  return {
    value,
    layer: fromGlobal ? "global" : "repo",
    dir: path.dirname(
      fromGlobal ? input.globalConfigPath : input.repoConfigPath,
    ),
  };
}

// The already-merged branch, spelled out. This is not a rare edge: reviewing a
// branch that has already landed is exactly what someone does when they want
// to see what the reviewer would have said, and "empty diff" alone reads as a
// bug in the tool rather than as the true answer.
export function headContainedInBaseMessage(
  baseRef: string,
  headRef: string,
): string {
  return (
    `the merge base of ${baseRef} and ${headRef} IS ${headRef}: head is ` +
    "already contained in base; there is nothing this branch adds. If the " +
    "branch has already been merged, review it against its own parent (" +
    "--base <the-commit-before-it>) or pass --two-dot to diff the literal " +
    "two-point range."
  );
}

export function emptyDiffMessage(
  baseRef: string,
  headRef: string,
  twoDot: boolean,
): string {
  return (
    `the diff ${baseRef}${twoDot ? ".." : "..."}${headRef} is empty; there ` +
    "is nothing to review. The usual cause is that head is already contained " +
    "in base (an already-merged branch), or that the branch's changes were " +
    "reverted."
  );
}

// The other empty diff: the range had changes, but every one of them was in a
// generated file the size gate excludes, so the EFFECTIVE diff — the one the
// hunters would be handed — is empty. Treated exactly like the empty-range
// case above rather than spawning hunters on an empty patch: three sessions
// reading nothing is a bill for no review at all.
export function allExcludedMessage(droppedPaths: string[]): string {
  return (
    `every changed file is excluded from review as generated content ` +
    `(${listPaths(droppedPaths)}), so the effective diff is empty and there ` +
    "is nothing to review. Nothing was spawned and nothing was spent."
  );
}

// Enough paths to recognise the diff, never a wall of them: a lockfile-only
// PR is the common case and a hundred-line list helps nobody.
export function listPaths(paths: string[], limit = 5): string {
  if (paths.length <= limit) return paths.join(", ");
  return `${paths.slice(0, limit).join(", ")}, +${paths.length - limit} more`;
}

// A full 40-hex commit id and nothing else. WHY it is enforced this hard: an
// abbreviated head sha once made a COMPLETED three-replicate arm — $29.15
// already spent — unscoreable, because nothing downstream could match the
// recorded run to the tree it reviewed. Refs are canonicalized before they
// are written anywhere.
export function isFullCommitId(candidate: string): boolean {
  return /^[0-9a-f]{40}$/.test(candidate.trim());
}

export interface NumstatDiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export interface NumstatFile {
  // The DESTINATION path — see resolveNumstatPath.
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

// `git diff --numstat` emits `<added>\t<deleted>\t<path>` per file, and for a
// binary file both counters are a literal `-`. A binary file is still a
// changed file (it counts toward `files`) but contributes no lines — reading
// `-` as NaN would poison the whole cost estimate.
export function parseNumstatFiles(raw: string): NumstatFile[] {
  const out: NumstatFile[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    // The path field may itself contain tabs only in quoted form, which git
    // escapes; joining the remainder keeps such a path whole instead of
    // truncating it at the first tab.
    const rawPath = fields.slice(2).join("\t");
    out.push({
      path: resolveNumstatPath(rawPath),
      insertions: countField(fields[0]),
      deletions: countField(fields[1]),
      binary: fields[0] === "-" && fields[1] === "-",
    });
  }
  return out;
}

// A rename does NOT arrive as a plain path. git renders it either whole
// (`old/name => new/name`) or with the common prefix/suffix factored out
// (`src/{old => new}/file.ts`, and the one-sided `src/{ => sub}/file.ts` /
// `src/{old => }/file.ts`). WHY resolving to the DESTINATION matters: every
// consumer here matches the path against globs, and `src/{a => b}/x.min.js`
// matches no exclusion pattern at all — a renamed lockfile would silently
// stop being excluded and push a small PR over the gate.
//
// The SAME globs also meet git's C-quoting, which `core.quotepath` leaves on by
// default for any non-ASCII path (`"canci\303\263n.min.js"`): the leading quote
// makes every pattern miss. Found by pr-hero reviewing its own PR #1 — the patch
// filter unquoted and this did not, so an excluded file vanished from
// diff.patch while its lines stayed in the count. Unquote LAST: git quotes only
// the side that needs it (`a.min.js => "canci\303\263n.min.js"`), so unquoting
// before resolving is a no-op that leaves the destination still quoted.
function resolveNumstatPath(field: string): string {
  return unquotePath(resolveRenameField(field));
}

function resolveRenameField(field: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(field);
  if (braced !== null) {
    // The one-sided forms leave an empty segment behind (`src/` + `` +
    // `/file`), so collapse the doubled separator the substitution creates.
    return collapseSeparators(`${braced[1]}${braced[3]}${braced[4]}`);
  }
  const arrow = field.indexOf(" => ");
  return arrow === -1 ? field : field.slice(arrow + 4);
}

function collapseSeparators(p: string): string {
  return p.replace(/\/{2,}/g, "/");
}

// The aggregate view, a pure sum over the per-file one: two parsers of the
// same format would drift, and the cost estimate and the size gate must
// never disagree about how big a diff is.
export function parseNumstat(raw: string): NumstatDiffStat {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const file of parseNumstatFiles(raw)) {
    files++;
    insertions += file.insertions;
    deletions += file.deletions;
  }
  return { files, insertions, deletions };
}

function countField(field: string | undefined): number {
  const parsed = Number(field);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function runDirCandidate(
  root: string,
  headSha: string,
  n: number,
): string {
  return path.join(root, `${headSha.slice(0, 8)}-${n}`);
}

export function assertOutsideRepo(runDir: string, repoRoot: string): void {
  const resolvedRun = path.resolve(runDir);
  const resolvedRepo = path.resolve(repoRoot);
  if (
    resolvedRun === resolvedRepo ||
    resolvedRun.startsWith(`${resolvedRepo}${path.sep}`)
  ) {
    throw new CliUsageError(
      `run dir ${resolvedRun} is inside the reviewed repo ${resolvedRepo}. ` +
        "Prompts and artifacts written inside the tree show up in the " +
        "hunters' own Grep results and contaminate the review — pick a " +
        "--out outside the repo.",
    );
  }
}

// Threat matrix, ported from the lab: a ReviewSpec's `file` values name the
// .md files that become the SYSTEM PROMPTS of spawned sessions. A basename
// that escapes agentsDir (separator, `..`, or an absolute path) must fail
// loud before any spawn, never be silently joined against a location the
// caller did not choose.
export function assertBasenameOnly(file: string, index: number): void {
  if (
    file.includes("/") ||
    file.includes("\\") ||
    file.includes("..") ||
    path.isAbsolute(file)
  ) {
    throw new CliUsageError(
      `spec.agents[${index}].file must be a plain basename (no "/", "\\", ` +
        `"..", or absolute paths), got: ${JSON.stringify(file)}`,
    );
  }
}

export const AGENT_FILE_PATTERNS = ["deep-review-*.md", "review-*.md"];

// BIDIRECTIONAL on purpose, and this is the check that pays for itself. The
// default spec declares four agents and omits the lifecycle hunter, so
// running the 5-file clean set with that spec silently drops the one hunter
// the whole campaign is about — the run completes, the artifacts validate,
// the cost looks normal, and nothing downstream notices. So: every file the
// spec names must exist, AND every agent file present must be named.
export function agentsDirProblems(
  specFiles: string[],
  presentFiles: string[],
): string[] {
  const problems: string[] = [];
  const present = new Set(presentFiles);
  const named = new Set(specFiles);
  for (const file of named) {
    if (!present.has(file)) {
      problems.push(
        `the spec references "${file}" but the dir does not have it`,
      );
    }
  }
  for (const file of presentFiles) {
    if (!named.has(file)) {
      problems.push(
        `the dir has "${file}" but no agent in the spec references it ` +
          "(it would never run)",
      );
    }
  }
  return problems.sort();
}

// Local mode's wiring: the three unconditional hunters, the conditional
// parity hunter, and the refuter. Deliberately NOT defaultReviewSpec() — that
// one omits the lifecycle hunter, and local mode targets the 5-file clean
// set. Hunter keys stay inside the findings-schema v1.0.0 Hunter enum, which
// validateReviewSpec enforces.
export function localReviewSpec(): ReviewSpec {
  return {
    agents: [
      {
        key: "reliability",
        file: "deep-review-reliability.md",
        role: "hunter",
      },
      { key: "resilience", file: "deep-review-resilience.md", role: "hunter" },
      { key: "lifecycle", file: "deep-review-lifecycle.md", role: "hunter" },
      {
        key: "parity",
        file: "deep-review-parity.md",
        role: "hunter",
        trigger: "input",
      },
      { key: "refuter", file: "review-refuter.md", role: "refuter" },
    ],
  };
}

export type ConfigDirection = "person" | "repo" | "capped";

// Declared per key, and this table IS the known-key set for both parsers and
// the merge — both derive from it below rather than restating it, because a
// second hand-written key list is how the table and the parser drift apart
// with nothing firing. A key added to LocalConfig without a row here fails
// tsc: an undeclared direction is a bug, never a silent default.
//
// The `capped` rows exist because the spend rule the watcher writes down
// (src/watch-preflight.ts:43-47) is DIRECTIONAL: the danger is a committed
// repo file enlarging the OPERATOR's bill, never the reverse. Plain
// specificity cannot express that asymmetry — "repo wins" lets a team raise
// my bill, "person wins" forbids a team from being more frugal.
export const CONFIG_DIRECTION: Record<keyof LocalConfig, ConfigDirection> = {
  agents_dir: "person",
  // `repo`, and this is the one that costs money if it is wrong:
  // resolveBaseRef checks the config value BEFORE the remote head, so a
  // global default_base would sit ahead of an autodetection that already
  // solves the common case for free. Every quiet repo whose default branch
  // differs would review the wrong range with a plausible branch name on the
  // plan card — verbatim the "wrong answer with a plausible face" failure the
  // comment at the top of this file names.
  default_base: "repo",
  // The values are paths INSIDE one repository. A global answer is meaningless
  // everywhere else and would silently arm or disarm the parity hunter across
  // every repo on the machine.
  parity_trigger_paths: "repo",
  suspicion_priors: "repo",
  // Per-field below — the two fields disagree, which is why SUMMARY_DIRECTION
  // exists. This row declares the key for the known-key set; the merge
  // descends into it rather than folding the object whole.
  summary: "capped",
  max_verification_steps: "capped",
};

// The ONE nested key, so this is a second table and not a pattern. `enabled`
// takes the cap because it switches spend on; `model` cannot be capped even
// in principle — "narrower" is undefinable for a string, and a direction that
// cannot be computed is worse than no direction at all.
export const SUMMARY_DIRECTION: Record<keyof SummaryConfig, ConfigDirection> = {
  enabled: "capped",
  model: "person",
};

export interface LocalConfig {
  parity_trigger_paths: string[];
  suspicion_priors: SuspicionPrior[];
  // Both optional, and both exist to make `pr-hero review` a zero-flag
  // command: the prompt set lives in a sibling repo, and the default branch is
  // a property of THIS repo that no constant can know.
  agents_dir?: string;
  default_base?: string;
  summary?: SummaryConfig;
  // Item 7: unattended bound on the verify queue. Absent means
  // DEFAULT_MAX_VERIFICATION_STEPS. 0 is legal — every queued prior lands
  // `unconfirmed` (the pause switch, same shape as watch daily_cap).
  max_verification_steps?: number;
}

export interface SummaryConfig {
  enabled?: boolean;
  model?: string;
}

export interface SummarySettings {
  enabled: boolean;
  model?: string;
}

export const EMPTY_LOCAL_CONFIG: LocalConfig = {
  parity_trigger_paths: [],
  suspicion_priors: [],
};

// What a layer SAID, not what the engine will use — every key optional,
// including the two arrays LocalConfig declares required.
//
// WHY the distinction is load-bearing rather than cosmetic: a merge whose
// input cannot represent absence has already destroyed the fact it needs to
// fold on. Under LocalConfig a repo file that omits `parity_trigger_paths`
// hands the merge a materialised `[]`, the fold sees the repo layer speak,
// and provenance reports `repo` for a value that file never named. That is a
// lie in pipeline.json and in `pr-hero config`, and no amount of care in the
// merge can recover the bit the parser threw away.
//
// LocalConfig itself is unchanged: it is the EFFECTIVE config, the single
// shape the resolvers receive, produced once at the end of mergeConfig.
export type ConfigLayer = Partial<LocalConfig>;

// Derived, never restated: D2's "the table IS the known-key set" is only true
// if the parsers actually read the table. `Object.keys` rather than `in`,
// because `in` would admit `toString` and every other prototype member as a
// known key.
const KNOWN_CONFIG_KEYS = new Set<string>(Object.keys(CONFIG_DIRECTION));

const GLOBAL_CONFIG_KEYS = new Set<string>(
  Object.keys(CONFIG_DIRECTION).filter(
    (key) => CONFIG_DIRECTION[key as keyof LocalConfig] !== "repo",
  ),
);

// The two file labels every rejection is templated over. A shared validator
// that hardcodes one file name sends the operator to edit the wrong file the
// moment the other file is the malformed one.
const REPO_CONFIG_LABEL = ".prhero/config.json";
const GLOBAL_CONFIG_LABEL = "~/.prhero/config.json";

// `.prhero/config.json` is optional and every setting inside it is optional —
// an absent config is a legal, complete configuration (parity simply never
// fires, while summary activation is resolved by resolveSummary). What is NOT
// tolerated is a malformed one: a typo'd key silently
// read as "no triggers" is exactly how the parity hunter stops firing without
// anyone noticing, so shape violations throw.
// WHY summary defaults on: it is the first defaulted setting that spends
// money, and a silent opt-out would make a normal review's bill differ from
// the plan. `--no-summary` and `summary.enabled: false` are the explicit exits.
//
// WHY it returns a ConfigLayer and no longer materialises the two arrays: the
// return object used to write `parity_trigger_paths` and `suspicion_priors`
// unconditionally, because LocalConfig required them. That destroyed the
// difference between "the file said []" and "the file never mentioned it" —
// and the merge downstream can only report truthful provenance for a key it
// can still see was absent. The `?? []` locals below stay exactly as they
// are: they feed the validators, and validating an absent key against the
// empty array is what keeps every error string byte-identical.
export function parseLocalConfig(raw: string): ConfigLayer {
  return parseConfigLayer(raw, REPO_CONFIG_LABEL, KNOWN_CONFIG_KEYS);
}

// The global layer's parser: same JSON dialect, same validators, same strict
// unknown-key rejection — it differs only in which keys it admits and in the
// file it names. It admits every key whose direction is not `repo`, and
// rejects the three that are, because no global answer to them could be
// right: two are lists of paths inside one repository and the third selects a
// commit range ahead of an autodetection that already works.
export function parseGlobalConfig(raw: string): ConfigLayer {
  return parseConfigLayer(raw, GLOBAL_CONFIG_LABEL, GLOBAL_CONFIG_KEYS);
}

// `??` is what makes an explicit `null` mean "absent" for the two arrays, and
// the returned layer has to agree with it: `{"suspicion_priors": null}`
// validates as the empty array, so it must not claim the layer spoke either.
function given(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function parseConfigLayer(
  raw: string,
  file: string,
  admitted: ReadonlySet<string>,
): ConfigLayer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(
      `${file} is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError(`${file} must be a JSON object`);
  }
  const config = parsed as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      throw new CliUsageError(`${file} unknown key: ${key}`);
    }
    // Templated over the OFFENDING key, never a fixed example: one hardcoded
    // key name across three rejections sends two operators out of three
    // looking for the wrong line in their config.
    if (!admitted.has(key)) {
      throw new CliUsageError(
        `${file}: ${key} is a per-repo key — put it in ` +
          "<repo>/.prhero/config.json",
      );
    }
  }
  const triggers = config.parity_trigger_paths ?? [];
  if (
    !Array.isArray(triggers) ||
    !triggers.every((p) => typeof p === "string" && p.length > 0)
  ) {
    throw new CliUsageError(
      `${file} parity_trigger_paths must be an array of non-empty strings`,
    );
  }
  const priors = config.suspicion_priors ?? [];
  if (!Array.isArray(priors)) {
    throw new CliUsageError(`${file} suspicion_priors must be an array`);
  }
  for (const [i, entry] of priors.entries()) {
    if (typeof entry !== "object" || entry === null) {
      throw new CliUsageError(`suspicion_priors[${i}] must be an object`);
    }
    const prior = entry as Record<string, unknown>;
    if (typeof prior.path !== "string" || prior.path.length === 0) {
      throw new CliUsageError(`suspicion_priors[${i}].path required`);
    }
    if (typeof prior.weight !== "string" && typeof prior.weight !== "number") {
      throw new CliUsageError(
        `suspicion_priors[${i}].weight must be a string or a number`,
      );
    }
    if (typeof prior.reason !== "string" || prior.reason.length === 0) {
      throw new CliUsageError(`suspicion_priors[${i}].reason required`);
    }
  }
  const summary = parseSummaryConfig(config.summary, file);
  const maxVerificationSteps = parseMaxVerificationSteps(
    config.max_verification_steps,
    file,
  );
  return {
    ...(given(config.parity_trigger_paths)
      ? { parity_trigger_paths: triggers as string[] }
      : {}),
    ...(given(config.suspicion_priors)
      ? { suspicion_priors: priors as SuspicionPrior[] }
      : {}),
    ...optionalString(config, "agents_dir", file),
    ...optionalString(config, "default_base", file),
    ...(summary === undefined ? {} : { summary }),
    ...(maxVerificationSteps === undefined
      ? {}
      : { max_verification_steps: maxVerificationSteps }),
  };
}

function parseSummaryConfig(
  value: unknown,
  file: string,
): SummaryConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliUsageError(`${file} summary must be an object`);
  }
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (key !== "enabled" && key !== "model") {
      throw new CliUsageError(`${file} summary unknown key: ${key}`);
    }
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new CliUsageError(`${file} summary.enabled must be a boolean`);
  }
  if (
    config.model !== undefined &&
    (typeof config.model !== "string" || config.model.trim().length === 0)
  ) {
    throw new CliUsageError(`${file} summary.model must be a non-empty string`);
  }
  return {
    ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
    ...(config.model === undefined ? {} : { model: config.model as string }),
  };
}

export const DEFAULT_MAX_VERIFICATION_STEPS = 8;

function parseMaxVerificationSteps(
  value: unknown,
  file: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new CliUsageError(
      `${file} max_verification_steps must be a non-negative integer`,
    );
  }
  return value;
}

// Widened, not weakened. Each of these reads exactly ONE property, so the
// parameter names that property instead of demanding a whole LocalConfig —
// which is what lets a caller hand over a raw parsed layer, before the merge
// has run, without either side lying about what it needs. The precedence each
// resolver applies is untouched.
export function resolveMaxVerificationSteps(
  config: Pick<ConfigLayer, "max_verification_steps">,
): number {
  return config.max_verification_steps ?? DEFAULT_MAX_VERIFICATION_STEPS;
}

export function resolveSummary(
  options: Pick<CliOptions, "summary" | "model">,
  config: Pick<ConfigLayer, "summary">,
): SummarySettings {
  const model = options.model ?? config.summary?.model;
  return {
    enabled: options.summary ?? config.summary?.enabled ?? true,
    ...(model === undefined ? {} : { model }),
  };
}

// Which layer produced each effective value. `capped` is deliberately NOT the
// same answer as `global`: the operator needs to see that a ceiling BOUND —
// that the team asked for something and was narrowed away — not merely that a
// global file happened to exist. `default` means no layer spoke at all and
// the downstream resolver's own fallback decides.
export type ConfigSource = "global" | "repo" | "capped" | "default";

// `summary` gets a per-field seat rather than one entry, because its two
// fields have DIFFERENT directions and a flat record cannot say
// `{ enabled: "capped", model: "global" }`. It is the only nested key, so this
// is one seat, not a pattern.
export type ConfigSources = Record<
  Exclude<keyof LocalConfig, "summary">,
  ConfigSource
> & {
  summary: Record<keyof SummaryConfig, ConfigSource>;
};

type ConfigLayerName = Exclude<ConfigSource, "capped" | "default">;

interface ConfigLayerEntry {
  name: ConfigLayerName;
  layer: ConfigLayer;
  // WHY a flag and not a name comparison: a `repo`-direction key may only be
  // folded from a layer that IS scoped to one repository. parseGlobalConfig
  // rejects those keys, but a fold that leans on another function's rejection
  // starts reporting `global` for a per-repo key the day that guarantee slips
  // — and D3b's deferred config.local.json is a second repo-scoped entry, so
  // `name === "repo"` would be wrong the moment the list grows.
  repoScoped: boolean;
}

interface FoldedValue<T> {
  value: T | undefined;
  source: ConfigSource;
}

function foldKey<T>(
  layers: readonly ConfigLayerEntry[],
  direction: ConfigDirection,
  read: (layer: ConfigLayer) => T | undefined,
  narrower?: (a: T, b: T) => T,
): FoldedValue<T> {
  let value: T | undefined;
  let source: ConfigSource = "default";
  for (const entry of layers) {
    if (direction === "repo" && !entry.repoScoped) continue;
    const spoken = read(entry.layer);
    if (spoken === undefined) continue;
    if (
      value === undefined ||
      direction !== "capped" ||
      narrower === undefined
    ) {
      value = spoken;
      source = entry.name;
      continue;
    }
    const narrowed = narrower(value, spoken);
    // WHY a tie reports the more specific layer and not `capped`: `capped` has
    // to mean the ceiling actually BOUND, or the operator cannot tell a
    // narrowing from a coincidence — and deleting the global file would change
    // nothing about a value both layers already agree on. (Judgment ledger
    // JD-20 left this label undefined; this is the choice, and it is tested.)
    value = narrowed;
    source = narrowed === spoken ? entry.name : "capped";
  }
  return { value, source };
}

// The merge, pure: two layers in, one effective LocalConfig plus its per-key
// provenance out. The signature names the two layers there are today, but the
// body folds over an ORDERED LIST, least specific first — so D3b's deferred
// third layer is one entry appended here plus a row in the direction table,
// not a rewrite of every rule below.
export function mergeConfig(
  global: ConfigLayer | undefined,
  repo: ConfigLayer,
): { effective: LocalConfig; sources: ConfigSources } {
  const layers: ConfigLayerEntry[] = [
    ...(global === undefined
      ? []
      : [{ name: "global" as const, layer: global, repoScoped: false }]),
    { name: "repo" as const, layer: repo, repoScoped: true },
  ];

  const agentsDir = foldKey(
    layers,
    CONFIG_DIRECTION.agents_dir,
    (layer) => layer.agents_dir,
  );
  const defaultBase = foldKey(
    layers,
    CONFIG_DIRECTION.default_base,
    (layer) => layer.default_base,
  );
  const triggers = foldKey(
    layers,
    CONFIG_DIRECTION.parity_trigger_paths,
    (layer) => layer.parity_trigger_paths,
  );
  const priors = foldKey(
    layers,
    CONFIG_DIRECTION.suspicion_priors,
    (layer) => layer.suspicion_priors,
  );
  // `summary` is descended into per-field: CONFIG_DIRECTION.summary declares
  // the key for the parsers, SUMMARY_DIRECTION decides each field. Folding the
  // object whole would silently adopt one layer's entire block.
  const summaryEnabled = foldKey(
    layers,
    SUMMARY_DIRECTION.enabled,
    (layer) => layer.summary?.enabled,
    (a, b) => a && b,
  );
  const summaryModel = foldKey(
    layers,
    SUMMARY_DIRECTION.model,
    (layer) => layer.summary?.model,
  );
  const maxSteps = foldKey(
    layers,
    CONFIG_DIRECTION.max_verification_steps,
    (layer) => layer.max_verification_steps,
    Math.min,
  );

  const summary: SummaryConfig = {
    ...(summaryEnabled.value === undefined
      ? {}
      : { enabled: summaryEnabled.value }),
    ...(summaryModel.value === undefined ? {} : { model: summaryModel.value }),
  };

  const effective: LocalConfig = {
    // The ONE place `[]` is materialised, and it is here on purpose: the fold
    // above ran on absence and has already recorded `source: "default"` for a
    // key nobody named, so the array can be handed to the resolvers without
    // that fact being lost. Materialising it any earlier is what made
    // provenance a lie.
    parity_trigger_paths: triggers.value ?? [],
    suspicion_priors: priors.value ?? [],
    ...(agentsDir.value === undefined ? {} : { agents_dir: agentsDir.value }),
    ...(defaultBase.value === undefined
      ? {}
      : { default_base: defaultBase.value }),
    ...(summaryEnabled.value === undefined && summaryModel.value === undefined
      ? {}
      : { summary }),
    ...(maxSteps.value === undefined
      ? {}
      : { max_verification_steps: maxSteps.value }),
  };

  const sources: ConfigSources = {
    agents_dir: agentsDir.source,
    default_base: defaultBase.source,
    parity_trigger_paths: triggers.source,
    suspicion_priors: priors.source,
    summary: { enabled: summaryEnabled.source, model: summaryModel.source },
    max_verification_steps: maxSteps.source,
  };

  return { effective, sources };
}

// Same fail-loud discipline as the two array keys: an `agents_dir` that is a
// number, or an empty `default_base`, must not be read as "absent" — that is
// how a config silently stops configuring anything.
function optionalString(
  config: Record<string, unknown>,
  key: "agents_dir" | "default_base",
  file: string,
): Record<string, string> {
  const value = config[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliUsageError(`${file} ${key} must be a non-empty string`);
  }
  return { [key]: value };
}

export interface InitTemplateInput {
  agentsDir?: string | undefined;
  defaultBase: string;
  // What `~/.prhero/config.json` ALREADY says, or undefined when the operator
  // has no global file. C5 O-9: a scaffold that re-states what the global
  // layer already supplies ships the exact duplication C5 exists to delete —
  // §0.5 measured three byte-identical 212-byte configs on one machine.
  global?: ConfigLayer;
  // True when `--agents` named the prompt set on THIS init. A deliberate
  // narrowing of O-9's letter ("does not write a person key when the global
  // supplies it"), and D5's reasoning one command earlier: a flag is the
  // operator typing an intent, and a flag that parses and then writes nothing
  // is an operator believing they scaffolded a repo they did not. `PRHERO_
  // AGENTS_DIR` gets no such exception — the merged config already beats the
  // env var at review time (judgment ledger JD-9), so writing the env value
  // into the repo file would silently CHANGE which prompt set runs, not
  // preserve it.
  agentsDirFromFlag?: boolean;
}

export interface InitTemplateOmissions {
  agentsDir: boolean;
  summaryEnabled: boolean;
  summaryModel: boolean;
  // The same three facts as config-file key names, for init's log. Derived
  // here rather than rebuilt at the call site, because a scaffold that omits a
  // key and a log that does not mention it is worse than either alone: the
  // operator reads "agents_dir <path>" and never learns the file does not
  // contain that line.
  keys: string[];
}

// Which person/capped keys the repo scaffold LEAVES OUT, decided once and read
// by both the template below and init's own log.
//
// `default_base` is NOT here and must never be: it is a `repo` key (D4),
// `parseGlobalConfig` rejects it by name, so no global file can supply it and
// omitting it would scaffold a repo with no base ref at all. The two array
// keys are `repo` for the same reason. `summary.enabled` IS here even though
// O-9's wording names only the person keys — the template hardcodes `true`,
// which is exactly the value `capped` forbids the team file from raising over
// a global `false` (judgment ledger JD-17), so seeding it against a global
// that already spoke writes a line that is either dead on arrival or pure
// duplication.
export function initTemplateOmissions(
  input: InitTemplateInput,
): InitTemplateOmissions {
  const agentsDir =
    input.agentsDir === undefined ||
    (input.global?.agents_dir !== undefined &&
      input.agentsDirFromFlag !== true);
  const summaryEnabled = input.global?.summary?.enabled !== undefined;
  const summaryModel = input.global?.summary?.model !== undefined;
  return {
    agentsDir,
    summaryEnabled,
    summaryModel,
    keys: [
      ...(agentsDir ? ["agents_dir"] : []),
      ...(summaryEnabled ? ["summary.enabled"] : []),
      ...(summaryModel ? ["summary.model"] : []),
    ],
  };
}

// The scaffold `pr-hero init` writes. Kept pure and next to parseLocalConfig
// on purpose: a template its own parser would reject is a bug that only shows
// up on someone else's machine, and a round-trip test through parseLocalConfig
// costs nothing.
//
// With no global layer the bytes are exactly what they were before C5 — the
// regression boundary, and the reason `global` is optional rather than
// required.
export function initConfigTemplate(input: InitTemplateInput): string {
  const omit = initTemplateOmissions(input);
  const summary: SummaryConfig = {
    ...(omit.summaryEnabled ? {} : { enabled: true }),
    ...(omit.summaryModel ? {} : { model: DEFAULT_SUMMARY_MODEL }),
  };
  return `${JSON.stringify(
    {
      ...(omit.agentsDir ? {} : { agents_dir: input.agentsDir }),
      // Always written, whatever the global file says.
      default_base: input.defaultBase,
      // Dropped WHOLE when both fields hoisted: `"summary": {}` parses fine
      // and configures nothing, which is a line whose only effect is to make
      // the next reader wonder what it does.
      ...(Object.keys(summary).length === 0 ? {} : { summary }),
      parity_trigger_paths: [],
      suspicion_priors: [],
    },
    null,
    2,
  )}\n`;
}

// WHY init says this out loud: an untracked file under .prhero/ dirties the
// working tree, and the clean-tree gate in cli.ts then refuses to run at all.
// A first-time user who scaffolds and immediately hits "the working tree is
// dirty" has no way to connect the two.
export const INIT_GIT_REMINDER =
  "Now either commit .prhero/ or add it to .gitignore. Every review step " +
  "reads the checkout directly, so pr-hero refuses to run on a dirty tree — " +
  "and an untracked .prhero/ is exactly that.";

export const GOTCHAS_TEMPLATE = `# Repo gotchas

Facts a reviewer cannot infer from the diff alone. Each line is injected
verbatim into every hunter's system prompt, so keep them short and true.

- <subsystem>: <the thing that looks like a bug but is deliberate, and why>
- <subsystem>: <the invariant that is enforced somewhere the diff does not show>
- <subsystem>: <the naming/ownership rule a newcomer would violate>
`;

// The pipeline treats missing-or-empty gotchas as a fail-loud abort and
// returns a zero-cost partial run. Correct, but a bare "partial, 0 findings"
// tells the user nothing — so the CLI checks first and explains.
export function gotchasErrorMessage(gotchasPath: string): string {
  return [
    `missing or empty gotchas file: ${gotchasPath}`,
    "",
    "Gotchas are the repo-specific facts a hunter cannot infer from the diff",
    "— deliberate oddities, invariants enforced elsewhere, conventions worth",
    "more than they look. They are injected into every hunter's system",
    "prompt, and the engine refuses to run without them: an empty file makes",
    "the whole review a zero-cost no-op that LOOKS like a clean result.",
    "",
    "Create it with something like:",
    "",
    GOTCHAS_TEMPLATE,
  ].join("\n");
}
