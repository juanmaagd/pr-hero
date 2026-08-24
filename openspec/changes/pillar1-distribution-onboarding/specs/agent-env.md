# Specification: Agent-Environment Adapters & Integrations

Rev 4 (2026-08-24, post Codex review + empirical verification; renamed `providers.md` →
`agent-env.md` in rev 3 to match D2). Scope: these are **agent-environment** adapters — the
consumer's coding assistant, which receives the triage skill and the MCP server. The **execution
axis** (who runs the hunters) is explicitly out of scope: it stays Claude-only via `StepRunner`,
whose Stage-2 obligations are documented at `src/step-runner.ts:67-82` (the `backend` field
already exists); new runners are Phase D.

## 1. Adapter Architecture

### 1.1 Requirements

- `src/agent-env.ts` **MUST** define:
  - `AgentEnvId = "claude" | "antigravity" | "opencode" | "codex" | "cursor"` — **`groq` is
    dropped**: it is a model provider with no skills directory or MCP config, i.e. an
    execution-axis concern; rev 1's inclusion was the axis-conflation artifact. **`cursor` joins
    as a stub**: the MCP data-layer design's consumer surface named Claude Code / Cursor, so the
    registry stays honest about the real consumer roster; an active Cursor adapter is a
    fast-follow, not a Pillar 1 blocker.
  - `AgentEnvStatus = "active" | "detected_inactive" | "coming_soon"`.
  - **`AgentEnvCapabilities = { skills: boolean; mcp: boolean }`** — every adapter declares what
    it can actually do. `syncSkills` and `registerMcpServer` are **optional methods, present only
    where the matching capability is true**; stubs declare `{ skills: false, mcp: false }` and
    implement neither — no adapter implements fictitious methods. Callers (wizard, doctor)
    **MUST** consult `capabilities` before invoking either method.
  - `AgentEnvAdapter` with `detect()`, `syncSkills?(assets: EngineAssets)`, and
    `registerMcpServer?(reg: McpRegistration)` where `McpRegistration` is
    **SelfInvocation-derived** (see §2).
- An `AgentEnvRegistry` **MUST** register, enumerate, and look up adapters; unknown ids return
  `undefined` without throwing, and `detect()` on any adapter **MUST** resolve (never reject) when
  its binary/config is absent.

### 1.2 Scenarios

#### Scenario 1.1: Registry roster
- **Given** the default registry
- **When** `getAll()` is called
- **Then** it returns adapters for claude (active, `{skills: true, mcp: true}`), antigravity,
  opencode, codex, cursor (stubs, `{skills: false, mcp: false}`) — and nothing for groq.

#### Scenario 1.2: Unknown environment lookup
- **Given** id `"unknown-llm"`
- **When** `get("unknown-llm")` is called
- **Then** it returns `undefined` without throwing.

#### Scenario 1.3: Capabilities gate the calls
- **Given** a stub adapter with `{ skills: false, mcp: false }`
- **When** the wizard's skills/MCP step evaluates it
- **Then** neither `syncSkills` nor `registerMcpServer` is invoked (they do not exist on the
  stub), and the step renders the environment as detected-but-not-integratable.

---

## 2. Claude Adapter (`ClaudeAgentEnvAdapter`)

### 2.1 Requirements

- **Detection:** binary via `Bun.which("claude")`; auth via `CLAUDE_CODE_OAUTH_TOKEN` (source
  `"env"`), session files under `~/.claude/` (source `"file"`/`"session"`), or a version/auth
  probe. Auth failure is a reported status with the actionable command, never a crash.
- **Skills sync — copy, never symlink, digest-tracked:** deploy `pr-hero-triage` from
  `assets.triageSkillFiles` into the environment's skills directory by **copying**, writing a
  sync marker that records a **content digest of the deployed files**; re-sync is idempotent and
  triggers on **digest mismatch** — which catches local edits and partial copies that an
  engine-version marker would miss. The engine version is recorded as informational metadata
  only. Symlinks are forbidden: a compiled binary cannot symlink out of its embedded filesystem,
  and copies survive upgrades/moves.
- **License alignment task:** the synced (and source) `SKILL.md` frontmatter license moves
  `MIT` → `Apache-2.0` per D0.
- **MCP registration:**
  - The registered command **MUST** be derived from **`selfInvocation()`**
    (`distribution.md §2`): compiled → `{ command: <absolute binary>, args: ["mcp"] }`; npm/dev →
    `{ command: <absolute bun (process.execPath)>, args: [<absolute cli.ts>, "mcp"] }`. A bare
    `pr-hero` **and** an absolute path to the npm shim are both non-compliant: GUI-launched
    agents inherit launchd's PATH (the lesson is verbatim at `src/watch.ts:125-128`), and the
    shim's `#!/usr/bin/env bun` shebang re-introduces that PATH lookup even when the shim path is
    absolute.
  - The adapter **MUST** prefer the provider's own CLI with **`claude mcp add --scope user`** —
    the installed CLI's default scope is `local` (verified 2026-08-24), which would scope the
    server to one project instead of the user; the remaining invocation details are verified at
    implementation time.
  - The hand-edit fallback **MUST** be hardened: an atomic write via temp-file + rename **in the
    same directory** as the target; the target is **refused if it is a symlink** (lstat before
    write); the existing file mode is preserved; a backup is written before the first
    modification; every third-party `mcpServers` entry is preserved intact; re-running is
    idempotent (no duplicates, no corruption). v1 assumes a **single writer** (no cross-process
    lock) — stated explicitly.
- **Store auto-creation acknowledged:** the registered server's first query on a fresh machine
  creates `~/.prhero/` and an empty schema-v3 `prhero.db` (`src/store.ts:37-56`) and answers with
  zero rows — accepted, documented behavior. The real tool roster is eight
  (`src/mcp-preflight.ts:24-166`): `prhero_health`, `prhero_list_runs`, `prhero_get_run`,
  `prhero_get_findings`, `prhero_search_findings`, `prhero_get_usage`, `prhero_get_comparison`,
  `prhero_get_triage`. (`prhero_get_stats` does not exist; rev 1 named it in error.)

### 2.2 Scenarios

#### Scenario 2.1: Auth via environment variable
- **Given** `CLAUDE_CODE_OAUTH_TOKEN` is set
- **When** `detect()` runs
- **Then** `auth.authenticated` is true with `tokenSource: "env"`.

#### Scenario 2.2: Idempotent registration preserves third parties
- **Given** `~/.claude.json` containing `{"mcpServers": {"existing": {"command": "node"}}}` and a
  dev/npm install
- **When** `registerMcpServer({ command: "<absolute bun>", args: ["<absolute cli.ts>", "mcp"] })`
  runs twice (CLI path unavailable, fallback engaged)
- **Then** the file contains both `existing` and `pr-hero` (SelfInvocation-derived command),
  unchanged on the second run, with a backup written before the first modification.

#### Scenario 2.3: GUI/launchd resolution
- **Given** a registration written with a bare `"pr-hero"` command — or with the absolute path to
  the npm shim
- **Then** it is non-compliant with this spec: launchd-launched apps resolve no user PATH, and the
  shim's shebang makes even an absolute shim path depend on PATH-resolving `bun`.

#### Scenario 2.4: Digest-based skills sync
- **Given** `assets.triageSkillFiles` containing `SKILL.md` + `adjudicator.md`
- **When** `syncSkills(assets)` runs twice
- **Then** the target contains real files (no symlinks) with matching contents and a digest
  marker; the second run reports already-in-sync.

#### Scenario 2.5: Local edits trigger re-sync
- **Given** a previously synced skill whose deployed `SKILL.md` was edited locally (digest
  mismatch, engine version unchanged)
- **When** `syncSkills(assets)` runs
- **Then** staleness is detected via the digest and the files are re-deployed.

#### Scenario 2.6: Symlinked config target is refused
- **Given** `~/.claude.json` is a symlink
- **When** the hand-edit fallback engages
- **Then** the write is refused with an actionable error — no write through the symlink, no
  corruption of the link target.

---

## 3. Stub Adapters

### 3.1 Requirements

- `AntigravityAgentEnvAdapter` (probes `agy` / `~/.gemini/` / `~/.antigravity/`),
  `OpenCodeAgentEnvAdapter` (probes `opencode` / `~/.opencode/`), `CodexAgentEnvAdapter`
  (probes `codex` / OpenAI config), and `CursorAgentEnvAdapter` (probes the `cursor` CLI /
  `~/.cursor/`) **MUST** exist as stubs declaring `capabilities: { skills: false, mcp: false }`,
  implementing only `detect()`, which resolves with `binaryFound: false` → `"coming_soon"`, or
  `binaryFound: true` → `"detected_inactive"`, never throwing and never blocking the wizard. An
  active Cursor adapter (skills dir + `mcp.json` registration) is a fast-follow after Pillar 1.
- Note for Phase D: OpenCode will also appear on the execution axis (`StepSpec.backend`,
  `src/step-runner.ts:42`); that is a separate interface and explicitly not this one.

### 3.2 Scenarios

#### Scenario 3.1: Absent stubs resolve quietly
- **Given** none of the stub binaries installed
- **When** the registry scans all adapters
- **Then** every promise resolves; stubs report `binaryFound: false` and `"coming_soon"`.
