# Automating Low-Risk Code Review at Meta (RADAR)

Source: Meta engineering paper — *Automating Low-Risk Code Review at Meta: RADAR, Risk Calibration, and Review Efficiency* (Chris Adams et al.)
Local copy: `~/Downloads/2605.md`
Captured: 2026-08-18 (analysis session)

> **How this sits beside pr-hero.** RADAR and pr-hero solve **different problems** at different points in
> the workflow. RADAR asks *"is this diff safe enough to land without human review?"* — a binary
> auto-approve funnel optimised for throughput and production safety (reverts, PIs). pr-hero asks *"are
> there real bugs a human should see?"* — a multi-agent finding pipeline with adversarial refutation and
> blocking/advisory tiers, optimised for recall vs Greptile on real PRs. Meta validates that **layered
> automation** (policy gates → risk score → LLM → deterministic validation) scales in production; that
> reinforces pr-hero's architecture without requiring a philosophy pivot. A RADAR-like auto-approve
> pipeline is a **future ReviewSpec mode**, not today's north star.

---

## Context: why Meta built RADAR

Code creation at Meta is accelerating faster than human review capacity:

| Trend (YoY) | Value |
|---|---|
| Significant LOC per human-landed diff | **+105.9%** |
| Diffs per developer per month | **+51%** (80%+ from agentic AI) |
| Diffs reviewed within 24 hours | **declining** |

Some orgs had **thousands of pending diff reviews**. RADAR targets low-to-medium complexity diffs for
automated review and landing while routing higher-risk diffs to humans — preserving rigor while shifting
scarce attention to changes where judgment and accountability matter most.

---

## RADAR architecture (end-to-end funnel)

RADAR is **not a single model** — it is a conservative, incrementally roll-out funnel:

```
Diff → authorship/source classification → eligibility gates
     → static heuristics → Diff Risk Score (ML) → LLM review agent (ACR/DCR)
     → deterministic validation → auto-land (with delay) OR human review
```

### Three validation layers (all must pass)

1. **Static heuristics** — hard constraints: not open-source, not SOX-scoped, no extra-review flags, CI
   in allowed state, blocklisted paths/phrases, onboarded automation source.

2. **Diff Risk Score (DRS)** — ML model predicting production incidents (PI). Expressed as percentile
   thresholds: P5 = safest 5% qualify; P50 = safest 50%. Org-configurable. Originally built for code-freeze
   accept-to-ship; now powers ~20 risk-aware features at Meta.

3. **Automated Code Review (ACR)** — LLM reads actual code changes. Classifies each change against
   predefined **safe** and **risk** signal categories. Auto-accept requires **confidence ≥ 8/10** AND
   **zero risk signals**.

### Safe vs risk signal taxonomy (ACR)

**Safe:** refactoring without behavioral change, dead code removal, defensive programming, logging,
formatting, docs/comments, import hygiene, test additions, static resource updates.

**Risk:** review-effort complexity ≥ 4, substantial structural changes, logic errors, performance risks,
security (secrets, SQLi, auth bypass).

### Authorship-based eligibility (distinct pipelines)

| Source type | Pipeline | Per-diff AI review | DRS | Extra gates |
|---|---|---|---|---|
| Deterministic codemod | Blanket AutoAccept | No | No | Codemod-level vetting |
| AI-generated codemod | ACE | Yes (ACR) | Yes | — |
| RACER runbook | ACE | Yes (ACR) | Yes (per-runbook) | 60-day risk history, daily caps, denylist |
| Human author | Verification + Approval | Yes (ACR) | Yes (P5 default) | Author tenure, oncall, scope exclusions |

**RACER runbook eligibility** (most granular): zero PIs in 60-day window, low revert/rejection rates,
minimum landed count for statistical confidence, per-runbook daily limits (10–2000/day), per-runbook DRS
thresholds (P50 allowlisted / P20 default), keyword denylist (e.g. "test").

**Human diff two-step process:**

- **RADAR Verification** — ship with *deferred* post-land human review (P5 DRS default).
- **RADAR Approval** — stricter criteria; *no* human review required at all (deferred review waived).

Approved diffs land after a **configurable delay** during which a human can still reject.

---

## Production results (535K+ diffs)

| Metric | Value |
|---|---|
| RADAR-reviewed diffs | 535,290 |
| RADAR-landed diffs | 331,720 |
| Peak daily throughput | 25K diffs/day |
| RADAR approve rate (post P25→P50 calibration) | **60.31%** |
| Verification pass rate | **26.31%** |
| Revert rate vs non-RADAR | **1/3** |
| PI rate vs non-RADAR | **1/50** |
| Median time to close vs human-reviewed | **>330% reduction** |
| Median diff review wall time vs human-reviewed | **35% reduction** |

**Calibration (RQ2):** Relaxing DRS threshold from P25 to P50 increased automation yield without
observed safety degradation at scale. Risk threshold is an **operational lever**, not a fixed hyperparameter.

**Selection bias caveat:** RADAR-reviewed diffs are pre-filtered to low-risk eligibility — lower revert/PI
rates partly reflect funnel selection, not only review quality.

---

## Comparison with pr-hero

| Dimension | RADAR (Meta) | pr-hero (today) |
|---|---|---|
| **Objective** | Auto-approve + land low-risk diffs | Find real defects; blocking/advisory tiers |
| **LLM role** | Single conservative classifier (ACR) | Parallel specialty hunters + adversarial refuter |
| **Decision** | Binary: land vs route to human | Findings list + `deriveTier` (code-governed) |
| **Risk signal** | DRS (ML, PI-trained) | `size-gate` = **cost/predictability**, not quality; gotchas/priors |
| **Eligibility** | Granular by authorship/source type | Uniform pipeline per PR |
| **Conservatism** | Conf ≥8/10, zero risk signals | Refuter challenges every BLOCKER/CRITICAL |
| **Success metrics** | Reverts, PIs, time-to-close, approve rate | Recall vs Greptile; fixture/refuter probes |
| **Scale context** | 25K diffs/day, review backlog absorption | Quality head-to-head on real PRs (Phase B) |

### Where pr-hero is already aligned

- **Layered funnel before expensive LLM** — gotchas fail-loud, triggers, size-gate, scout (in progress).
- **LLM judges, code governs** — hunters/refuter propose; dedupe, tier derivation, schema validation are
  deterministic TypeScript.
- **Adversarial check on severe claims** — refuter is pr-hero's answer to false-positive blocking; RADAR
  uses conservative single-agent classification instead.
- **Multi-agent specialty** — RADAR's ACR is monolithic; pr-hero fans out by domain (reliability,
  lifecycle, parity…).

### Where pr-hero differs deliberately

- **No auto-approve / auto-land** — pr-hero produces review findings, not merge decisions.
- **Size gate ≠ risk gate** — documented and measured: big diffs cost more but are not proven worse
  (`src/size-gate.ts`; scale-probe falsified attention-dilution hypothesis).
- **Quality loop still open** — Greptile head-to-head and triage ledger (B4) are the current closure path;
  outcome metrics (reverts/PIs) come after finding quality is trustworthy.

---

## Ideas transferable to pr-hero (tactical, not strategic pivot)

These can be adopted as **modules** without changing today's north star:

1. **Explicit pre-LLM funnel** — eligibility → size-gate → scout (cheap) → hunters (expensive) → refuter.
   Scout (`docs/scout-design.md`) is the natural RADAR-like triage layer.

2. **Safe/risk taxonomy in prompts** — ACR's categories could sharpen hunter prioritisation and refuter
   focus on "safe-looking but risky" changes.

3. **Heuristic risk score (future)** — DRS without ML initially: path patterns × triggers × author history
   × test-coverage delta → variable review depth (not auto-land).

4. **Diff-class detection** — mechanical diffs (lockfiles, formatting) → reduced pipeline; feature/auth
   → full pipeline. RADAR's per-source eligibility model.

5. **Per-source / per-prompt-set track record** — block or downgrade hunters/prompt-sets with poor
   precision@blocking or high refute rate (analogous to RACER runbook 60-day history).

6. **Outcome linkage** — close the loop: finding → merge → revert/incident → hunter/refuter attribution.
   RADAR's PI/revert monitoring; pr-hero's triage ledger is the seed.

7. **Volume caps and kill switches** — daily review limits per repo; pause on triage spike of blocking FPs
   (RADAR's per-runbook caps and denylist).

8. **Knowledge-transfer trade-off** — RADAR acknowledges auto-review may reduce knowledge diffusion.
   pr-hero mitigates via high-quality findings + refuter (noise erodes trust in all bot review).

---

## Strategic decision (2026-08-18)

**Do not pivot pr-hero's philosophy toward RADAR now.**

Rationale:

1. **Different north stars** — RADAR optimises backlog absorption and safe auto-landing; pr-hero optimises
   finding quality vs Greptile. Merging them now dilutes Phase B focus.

2. **Quality loop not closed** — auto-approve requires trusting a classifier; hunters + refuter quality on
   real PRs must be proven first.

3. **Architecture already supports multiple pipelines** — `ReviewSpec` is flow config; agents are prompt
   files; orchestration is testable TypeScript. A future RADAR-like mode is another spec + agent set +
   decision function, not a rewrite:

   ```
   ReviewSpec: "radar-ace"
     → eligibility gates (pure TS)
     → optional risk score
     → single classifier agent (ACR-like)
     → deterministic validation
     → output: approve | route-to-human   (no findings list)
   ```

4. **Refuter is the differentiator worth finishing** — adversarial challenge of severe findings is more
   valuable for advisory/blocking review than copying RADAR's binary conservative classifier.

### Current priority order

1. Close Phase B — production wiring, triage, ledger, scout if probe passes.
2. Demonstrate quality vs Greptile on real PRs.
3. Close outcome loop (triage → revert/incident → attribution).

### Explicit defer

- RADAR-like auto-approve pipeline
- DRS / ML risk scoring for auto-land
- Review-depth variable by risk percentile (until outcome telemetry exists)

### Adopt from RADAR without philosophy change

- Funnel layering (scout before expensive hunters)
- Safe/risk taxonomy in prompts where it helps recall
- Heuristic risk score for **review depth**, not auto-land

---

## Possible future roadmap (when engine is mature)

| Phase | What | RADAR inspiration |
|---|---|---|
| M4–M5 | Scout in real pipeline | Pre-LLM funnel |
| B+ | Heuristic risk score in preflight | DRS without ML |
| B+ | Diff-class detector (mechanical vs feature) | Eligibility by source |
| B4+ | Outcome linkage (revert labels → hunter attribution) | PI/revert monitoring |
| C | Review depth by risk percentile | P5/P25/P50 calibration |

---

## Related docs in this repo

- `docs/cloudflare-ai-code-review.md` — similar topology (specialist fan-out + coordinator); quality focus
- `docs/scout-design.md` — pr-hero's diff-only triage layer (RADAR funnel analogue)
- `docs/doordash-audit.md` — ceiling/floor evidence for multi-agent review
- `src/size-gate.ts` — cost gate (explicitly NOT a quality/risk gate)
- `src/spec.ts` / `src/pipeline.ts` — ReviewSpec + runPipeline (future multi-pipeline host)
