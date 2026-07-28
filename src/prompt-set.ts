// Prompt-set loading, ported from deep-review runner/session.ts. In v1 these
// files were assembled into an inline `--agents` registry for the orchestrator
// session's Task tool; in v2 each agent body IS a step's system prompt, so the
// frontmatter parsing survives while the JSON registry assembly is gone — and
// the {{PRIORS}}/{{GOTCHAS}} templating the orchestrator prose used to do at
// spawn time moves into the driver (renderAgentBody).

// Fixed order — the lab's promptSetFingerprint hashes the concatenated files
// in exactly this sequence, so reordering here would silently move every
// recorded fingerprint. The names are the file basenames inside a prompt-set
// directory (`agents/<set>/<name>.md`).
export const AGENT_NAMES = [
  "deep-review-reliability",
  "deep-review-resilience",
  "deep-review-parity",
  "review-refuter",
] as const;

export function agentFilesIn(agentsDir: string): string[] {
  return AGENT_NAMES.map((name) => `${agentsDir}/${name}.md`);
}

export interface ParsedAgent {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  // Everything below the frontmatter block — the step's system prompt.
  body: string;
}

// Same minimal frontmatter grammar as v1: a leading `---` block with
// single-line `key: value` fields. Deliberately not a YAML parser — the agent
// files are ours, and a stricter grammar keeps a malformed set failing loudly
// instead of half-parsing.
export function parseAgentSource(raw: string): ParsedAgent {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match?.[1] || match[2] === undefined) {
    throw new Error("agent file has no frontmatter block");
  }
  const [, frontmatter, body] = match;
  const field = (key: string): string | undefined => {
    const line = frontmatter.split("\n").find((l) => l.startsWith(`${key}:`));
    return line
      ?.slice(key.length + 1)
      .trim()
      .replace(/^"|"$/g, "");
  };
  const name = field("name");
  if (!name) throw new Error("agent file has no name field");
  const tools = field("tools");
  const model = field("model");
  return {
    name,
    description: field("description") ?? name,
    tools: tools ? tools.split(",").map((t) => t.trim()) : [],
    ...(model ? { model } : {}),
    body: body.trim(),
  };
}

export async function parseAgentFile(filePath: string): Promise<ParsedAgent> {
  return parseAgentSource(await Bun.file(filePath).text());
}

export interface SuspicionPrior {
  path: string;
  // The live config carries prose weights ("maximum", "high"), not numbers;
  // rendering only interpolates, so both pass through untouched.
  weight: number | string;
  reason: string;
}

// Prose Step 4's two dynamic sections, now driver-side: {{PRIORS}} becomes a
// bullet list of the config's suspicion_priors, {{GOTCHAS}} the verbatim
// gotchas content — placed wherever the agent body anchors them (the baseline
// bodies put gotchas ahead of the diff, per the spec's injection requirement).
export function renderAgentBody(
  body: string,
  context: { priors: SuspicionPrior[]; gotchas: string },
): string {
  const bullets = context.priors
    .map((p) => `- ${p.path} (weight ${p.weight}): ${p.reason}`)
    .join("\n");
  return body
    .replaceAll("{{PRIORS}}", bullets)
    .replaceAll("{{GOTCHAS}}", context.gotchas);
}
