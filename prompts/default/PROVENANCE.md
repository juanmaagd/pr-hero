# Bundled Default Prompt Set Provenance

- **Source prompt set:** `slice3b-lifecycle-v6-clean` (from `deep-review/agents/slice3b-lifecycle-v6-clean`)
- **Freeze date:** 2026-08-24
- **Modifications:** Branding-only edits:
  - Frontmatter `name:` rebranded from `deep-review-*` / `review-*` to `pr-hero-*`
  - Document headings updated to `pr-hero — ...`
  - Stale config paths updated (`deep-review.config.json` -> `.prhero/config.json`, `deep-review/intel/gotchas.md` -> `.prhero/gotchas.md`)
  - Unshipped `hunting-map.md` citations resolved to generic category taxonomy references
  - Retired "golden" benchmark vocabulary removed
  - Zero behavioral intent changes
- **Modifications (2026-08-24, post-freeze):** Harness-hygiene edit:
  - Stripped an auto-injected HTML-comment guidance block (`…:codegraph-guidance`) from `deep-review-parity.md`, `deep-review-resilience.md` and `review-refuter.md`. The block was appended to the source agent files by tooling installed on the maintainer's machine, not authored as part of the prompt set: it names a CLI that exists nowhere else and instructs agents to run shell commands they have no Bash tool for. `deep-review-lifecycle.md` and `deep-review-reliability.md` never carried it. The prompts' own `codegraph_explore` instructions are untouched. Guarded by `test/preflight-bundled-prompts.test.ts` (no HTML comments in bundled prompts).
- **Verification:** The freeze was verified via `bun run refuter-probe` and `bun run fixture-eval`. The stripped revision passed `bun run refuter-probe` on 2026-08-24 (3 replicates x 4 arms, 12/12 verdicts matched: `corroborated`, `refuted` on both false-claim arms, `downgraded-latent`; refuter model `sonnet`, refuter cost $0.8222). `bun run fixture-eval` has not been re-run for the stripped revision.
