# Judgment Day Consolidated Ledger: Data Layer Closure (Triage Events & MCP Server)
**Date**: 2026-08-23
**Branch**: `feat/data-layer-mcp-triage`

## Consolidated Finding Ledger

| ID | Title | Severity | Source | Status |
|---|---|---|---|---|
| **JD-1** | Cross-Repo Run Collision in CLI Triage Persistence (`WHERE run_dir = ?` without `repo_id`) | **CRITICAL** | JDA-1, JDB-1 | Confirmed — Fix Required |
| **JD-2** | Shared Socket Hijacking & Teardown Race on Concurrent MCP Sessions | **CRITICAL** | JDA-2, JDB-2 | Confirmed — Fix Required |
| **JD-3** | JSON-RPC Notification Protocol Violation (Returning Errors for Notifications) | **WARNING** | JDA-3, JDB-3 | Confirmed — Fix Required |
| **JD-4** | Inconsistent Numeric Coercion & Validation across MCP Tool Handlers | **WARNING** | JDA-4, JDB-7 | Confirmed — Fix Required |
| **JD-5** | `run_id` Filter Omitted from `prhero_search_findings` MCP Tool Schema | **WARNING** | JDA-5, JDB-4 | Confirmed — Fix Required |
| **JD-6** | Stdio Event Loop & Notification Lifecycle Test Gap | **WARNING** | JDA-6, JDB-5 | Confirmed — Fix Required |
| **JD-7** | Hardcoded `os.homedir()` in CLI Triage Persistence Ignores Custom Home Option | **SUGGESTION** | JDB-6 | Confirmed — Fix in JD-1 |

