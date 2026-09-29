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
- **Modifications (2026-09-18):** Promoted `deep-review-logic.md` from `deep-review/agents/slice3b-lifecycle-v6-clean-logic-agnostic/` to bundled default prompt set. Rebranded frontmatter and document heading to `pr-hero-*`.
- **Modifications (2026-09-29):** Changed the `model:` frontmatter of `review-refuter.md` from `sonnet` to `opus` (an alias the Claude CLI resolves, so no version is pinned). The prompt body is untouched. Guarded by `test/review/preflight-bundled-prompts.test.ts`, and `REFUTER_MODEL` in `scripts/refuter-probe.ts` must match. Passed `bun run refuter-probe` the same day: 3 replicates x 4 arms, 12/12 verdicts matched, refuter model `opus`. That run used subscription auth, so the probe's own `refuter_cost_usd` read $0; the notional cost in each run's `pipeline.json` summed to $0.9269 (about $0.077 per step). `bun run fixture-eval` was not re-run for this change.
- **Verification:** The freeze was verified via `bun run refuter-probe` and `bun run fixture-eval`. The stripped revision passed `bun run refuter-probe` on 2026-08-24 (3 replicates x 4 arms, 12/12 verdicts matched: `corroborated`, `refuted` on both false-claim arms, `downgraded-latent`; refuter model `sonnet`, refuter cost $0.8222). `bun run fixture-eval` has not been re-run for the stripped revision.
