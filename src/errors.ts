// Generic CLI error classes, shared by every domain. Neither is review logic:
// a usage mistake or a runtime failure (git, gh, the filesystem) can surface
// from any I/O shell, so both live in this neutral, dependency-free module
// instead of being owned by whichever shell happened to throw them first.
// C1 git-layering slice: moved out of review/preflight.ts, which still
// re-exports both for the ~55 existing consumers (see the re-export note
// there).

export class CliUsageError extends Error {}

// Runtime failure (git, gh, the filesystem) as opposed to a usage error.
// Defined here rather than in a shell so every I/O shell (cli.ts, pr/pr.ts,
// and others) can throw the same class without importing each other.
export class CliError extends Error {}
