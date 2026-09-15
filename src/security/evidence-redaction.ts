const MAX_BYTES = 4 * 1024 * 1024;
const SECRET =
  /authorization|cookie|password|secret|api.?key|access.?token|refresh.?token|^token$|^key$/i;
export function redactEvidenceText(value: string): string {
  return value
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:[^\r\n]*/gi,
      "[REDACTED HEADER]",
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, (text) => {
      try {
        const url = new URL(text);
        url.username = "";
        url.password = "";
        for (const key of [...url.searchParams.keys()])
          if (SECRET.test(key)) url.searchParams.set(key, "[REDACTED]");
        return url.toString();
      } catch {
        return "[REDACTED URL]";
      }
    })
    .replace(
      /\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|Bearer\s+[^\s,;]+)/gi,
      "[REDACTED]",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[=:]\s*)[^\s,;&]+/gi,
      "$1[REDACTED]",
    );
}
/** JSON-only bounded traversal: never call getters, custom iterators or toJSON. */
export function redactEvidence(
  value: unknown,
  depth = 0,
  budget = { nodes: 0 },
): unknown {
  if (++budget.nodes > 20000 || depth > 12)
    throw new Error("capture shape limit");
  if (typeof value === "string") {
    if (value.length > MAX_BYTES) throw new Error("capture string limit");
    return redactEvidenceText(value);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (value === undefined) return null;
  if (typeof value !== "object") throw new Error("non-JSON capture value");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null)
    throw new Error("non-JSON capture object");
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (key === "length" && Array.isArray(value)) continue;
    if (!("value" in descriptor)) throw new Error("capture accessor rejected");
    if (!descriptor.enumerable) continue;
    result[key] = SECRET.test(key)
      ? "[REDACTED]"
      : redactEvidence(descriptor.value, depth + 1, budget);
  }
  return Array.isArray(value) ? Object.values(result) : result;
}
