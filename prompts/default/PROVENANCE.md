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
- **Verification:** Verified via `bun run refuter-probe` and `bun run fixture-eval`.
