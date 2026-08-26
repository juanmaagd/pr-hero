import { describe, expect, test } from "bun:test";
import { redactDiagnostic } from "../../src/security/redact";

describe("redactDiagnostic (§6.3 redaction-before-persistence)", () => {
  test("redacts Anthropic-style sk- keys", () => {
    expect(redactDiagnostic("auth failed for sk-a1B2c3D4e5F6g7H8")).toBe(
      "auth failed for [REDACTED]",
    );
  });

  test("redacts GitHub token families ghp/gho/ghu/ghs/ghr", () => {
    const token = `ghp_${"a1_".repeat(10)}`;
    expect(redactDiagnostic(`push denied: ${token}`)).toBe(
      "push denied: [REDACTED]",
    );
    for (const prefix of ["gho_", "ghu_", "ghs_", "ghr_"]) {
      expect(redactDiagnostic(`${prefix}${"z9".repeat(20)}`)).toBe(
        "[REDACTED]",
      );
    }
  });

  test("redacts Bearer authorization values case-insensitively", () => {
    expect(redactDiagnostic("authorization: Bearer abc.def.ghi")).toBe(
      "authorization: [REDACTED]",
    );
    expect(redactDiagnostic("AUTHORIZATION: bearer tok")).toBe(
      "AUTHORIZATION: [REDACTED]",
    );
  });

  test("redacts api_key/token/password assignments", () => {
    // \S+ in the binding pattern consumes up to the next whitespace, so a
    // JSON string's closing quote/brace is swallowed into the replacement.
    expect(redactDiagnostic('{"api_key": "supersecret123"}')).toBe(
      '{"[REDACTED]',
    );
    // The whole match — keyword included — becomes [REDACTED].
    expect(redactDiagnostic("password=hunter2")).toBe("[REDACTED]");
    expect(redactDiagnostic("token: abc123")).toBe("[REDACTED]");
  });

  test("near-misses are preserved verbatim", () => {
    // sk- needs >= 8 following chars; this has 7.
    expect(redactDiagnostic("sk-1234567")).toBe("sk-1234567");
    // ghp_ needs >= 20 following chars; this has 5.
    expect(redactDiagnostic("ghp_short")).toBe("ghp_short");
    // No separator/value after the keyword.
    expect(redactDiagnostic("tokenizer and passwordless flow")).toBe(
      "tokenizer and passwordless flow",
    );
    // Bearer without a value.
    expect(redactDiagnostic("Bearer")).toBe("Bearer");
  });

  test("redacts every occurrence in a combined diagnostic tail", () => {
    const text = [
      "error: request to provider failed",
      `sent key sk-zz9Z8Y7X6W5V and ghp_${"q".repeat(22)}`,
      "header was Bearer eyJhbGciOi",
      'config {"api-key":"abcd1234"}',
    ].join("\n");
    const redacted = redactDiagnostic(text);
    expect(redacted).not.toContain("sk-zz9Z8Y7X6W5V");
    expect(redacted).not.toContain("q".repeat(22));
    expect(redacted).not.toContain("eyJhbGciOi");
    expect(redacted).not.toContain("abcd1234");
    expect(redacted.split("[REDACTED]").length - 1).toBeGreaterThanOrEqual(4);
  });
});
