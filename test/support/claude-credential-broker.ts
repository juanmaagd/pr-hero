import type {
  CredentialBroker,
  CredentialProjection,
} from "../../src/security/credential-broker";

// A `claude-code` broker whose projection always SUCCEEDS, deterministically
// on every host. Any test that drives a claude-code route through
// `createProductionRuntime` -> `runner.run` must inject it as
// `credentialBrokers: { "claude-code": successfulClaudeCredentialBroker }`.
//
// WHY the real keychain broker must never be reachable from such a test:
// `resolveBindingAuthority` resolves the slot as
// `options.credentialBrokers?.["claude-code"] ?? claudeCredentialBroker()`
// (runner-authority.ts), and `claudeCredentialBroker()` returns a REAL
// `KeychainCredentialBroker` whenever the host is darwin with
// /usr/bin/security. There is no way to switch it off from test code:
// injecting `undefined` still falls through the `??`, and it probes the
// module-level `existsSync`, so `authorityDeps.existsFn` cannot intercept
// it. A test that leaves the slot empty therefore depends on the machine's
// Keychain — it projects the developer's real Claude credential to disk when
// one exists, and on a Mac without that item the lookup fails as
// `source_read_failed`, which the harness deliberately fails closed, so the
// step fails before any spawn. ubuntu CI has no such broker at all and a Mac
// with a Claude login projects fine, which is how this stayed invisible until
// a macOS runner ran the suite.
//
// WHY a successful projection rather than a `missing_subscription_record`
// throw (the one class the harness degrades onto the operator environment,
// which is the closest a stub gets to Linux's "no projection"): a degrade sets
// `projectionDegraded`, and with a metered ambient key or token in the
// shell that opens a real spend-ledger reservation (#279). That would trade a
// Keychain dependency for a shell-environment dependency, and the tests that
// use this are about the NON-degraded case. A successful projection keeps
// `projectionDegraded` false, opens no reservation and adds no warning to
// `stderrTail`, on every host. It is not byte-identical to Linux — the child
// env goes through the projection overlay and `credentialProjectionId` is the
// stub's id rather than "operator-env-fallback" — so a test that asserts on
// either must not use this helper.
export const successfulClaudeCredentialBroker: CredentialBroker = {
  async project() {
    const projection: CredentialProjection = {
      projectionId: "cred-successful-stub",
      kind: "claude_subscription_oauth",
      syntheticHome: "/tmp/pr-hero-stub-home",
      syntheticConfigHome: "/tmp/pr-hero-stub-home/.claude",
      syntheticTmp: "/tmp/pr-hero-stub-home/tmp",
      env: {},
      files: [],
      destroy: async () => {},
    };
    return projection;
  },
};
