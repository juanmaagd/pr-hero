// §6.3: redaction occurs BEFORE events, callbacks, logs, persistence, and
// thrown user-visible errors. These patterns are the persisted-witness
// allowlist: anything matching them is replaced wholesale rather than
// partially, because a partially-redacted credential is still a credential.
const REDACTED = "[REDACTED]";

const REDACTION_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /Bearer\s+\S+/gi,
  /(api[_-]?key|token|password)["':=\s]+\S+/gi,
];

export function redactDiagnostic(text: string): string {
  let redacted = text;
  for (const pattern of REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  return redacted;
}
