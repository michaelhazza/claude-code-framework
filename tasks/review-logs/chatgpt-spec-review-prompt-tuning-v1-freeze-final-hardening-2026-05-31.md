# ChatGPT Spec Review Session — chatgpt-prompt-tuning-v1-freeze-final-hardening — 2026-05-31T02-40-56Z

## Session Info
- Spec: `tasks/builds/chatgpt-prompt-tuning-v1-freeze-final-hardening-2026-05-31/brief.md` (framework submodule)
- Branch: `chatgpt-prompt-tuning-v1-freeze-final-hardening-2026-05-31` (framework submodule)
- PR: framework PR-not-yet-opened — target `https://github.com/michaelhazza/claude-code-framework/pull/new/chatgpt-prompt-tuning-v1-freeze-final-hardening-2026-05-31`
- Mode: automated (operator-directed, no manual / parallel)
- Started: 2026-05-31T02:40:56Z
- Notes: Reviewing a framework prompt-tuning BRIEF, not a product spec. Brief proposes 6 new Hunt Targets for `SYSTEM_PROMPT_SPEC_V2`. Operator directives: skip consuming-repo PR creation; commit + push to framework branch only; no host-repo submodule pointer bump.

---

## Round 1 — 2026-05-31T02:40:56Z

### ChatGPT Feedback (raw — OpenAI automated)

Verdict: CHANGES_REQUESTED. Findings: 1. Model: gpt-5.5. Prompt version: openai-spec-review.v2. Raw JSON saved at `tasks/review-logs/.parallel-mode/openai-prompt-tuning-round1.json`.

Single finding (OAI-SPEC-001) on §6.1 step 7 smoke-check reproducibility — see Decisions table.

### Coordinator-adversarial pass (supplementing OpenAI's sparse Round 1 output)

Per the operator's focus list, the coordinator ran its own adversarial read of the brief covering: Hunt Target detection-logic concreteness, source-attribution honesty in §3.2/§3.3 (Revision 2 fixed F22 over-attribution; checked for residual cases), §3.5 architect-tier non-additions, §6.3 false-positive risk acknowledgement, §6.1 rollout, Decision 5 precedent claim, and any unstated decisions. Findings labelled CW-N below.

### Recommendations and Decisions

| Finding | Triage | Recommendation | Final Decision | Severity | Rationale |
|---|---|---|---|---|---|
| OAI-SPEC-001 — §6.1 step 7 smoke check depends on undefined reverted spec and non-repeatable LLM evidence | technical | apply (tighten to operator-time best-effort with named consuming-repo SHA; do not gate apply) | auto (apply) | medium | OpenAI's underlying point is sound — the smoke gate is non-reproducible. Coordinator rejects the model's proposed fix (commit a consuming-repo spec fixture to the framework repo — wrong repo boundary) in favour of a smaller fix: reframe the gate to operator-time best-effort, name the consuming-repo SHA, log results in §8 either way, and explicitly note it does not block the apply. |
| CW-1 — §4.3 over-attributes SPEC-NEW-6 to F18 while §3.4 says F18 was caught by existing "Testability" Hunt Target (same pattern Revision 2 fixed for F22) | technical | apply (drop F18 from §4.3 sources; clarify §3.4 wins) | auto (apply) | low | Mechanical attribution cleanup. Identical structural defect to the F22 over-attribution Revision 2 fixed. F7 remains the sole source for SPEC-NEW-6. F18 continues to evidence the existing Testability Hunt Target. |
| CW-2 — §6.3 false-positive ratings under-rate SPEC-NEW-4 (fires on common `version` columns) and SPEC-NEW-5 (fires on generic `name` / `identifier` / `label` inputs) | technical | apply (re-rate both from low to medium FP risk; SPEC-NEW-7 stays low — only one with mechanically-narrow trigger) | auto (apply) | low | The brief's existing FP ratings name "mechanically specific detection conditions" for SPEC-NEW-4 and SPEC-NEW-5 but the actual trigger sets include very broad terms. Honest re-rate brings the brief into line with the SPEC-NEW-9 self-criticism standard. |
| CW-4 — Decision 5 (no version bump) defends the "no bump" side but does not name what WOULD trigger a future bump | technical | apply (add inverse trigger to Decision 5) | auto (apply) | low | One-sided decision-log entries leave future authors guessing. Adding the inverse trigger (envelope schema change, Hunt-Target removal, Process renumber, enum change) closes the loop. |
| CW-5 — No follow-up tracking infrastructure for SPEC-NEW-4 through SPEC-NEW-8 (only SPEC-NEW-9 has a tracking commitment in §6.3) | technical | defer (separate Trivial brief — would expand scope beyond this brief's "additive prompt change" framing) | **ESCALATED to operator** (defer on technical = escalation carve-out) | low | The 5 other Hunt Targets have no "track next N invocations" commitment. This is a real gap but adding tracking infra here would push the brief out of the Trivial class. Coordinator recommends defer; operator sees the held-back item per the escalation carve-out. |
| CW-6 — SPEC-NEW-6 says "the full carrier set includes" — open-ended phrasing a future reviewer-bot may interpret inconsistently | technical | apply (replace "the full carrier set includes" with "at minimum (silence is a defect)" phrasing) | auto (apply) | low | Minor wording tightening. Pins the AC enumeration as a floor not a ceiling. |
| CW-7 — §3.3 table header says "OpenAI surfaced (one round late or twice in a row)" but F20 and F21 each surfaced once (Round 3 only) — minor framing inaccuracy | technical | apply (rephrase to "in any round"; clarify F19/F24 are the actual twice-in-a-row case) | auto (apply) | low | Honest framing. F19/F24 belong elsewhere (correctly flagged as cross-tier-deferred). |

### Applied (auto-applied technical)

- [auto] §6.1 step 7 reframed as operator-time best-effort smoke check, names consuming-repo SHA `7a457794`, explicitly does not gate the apply
- [auto] §4.3 source for SPEC-NEW-6 trimmed to F7 only; F18 cross-reference clarified to point at existing "Testability" Hunt Target per §3.4
- [auto] §6.3 FP ratings: SPEC-NEW-4, SPEC-NEW-5, SPEC-NEW-6, SPEC-NEW-8 medium; SPEC-NEW-7 low; SPEC-NEW-9 highest (unchanged)
- [auto] Decision 5 expanded with inverse trigger (envelope change, Hunt-Target removal, Process renumber, enum change)
- [auto] SPEC-NEW-6 DOM-carrier wording changed from "the full carrier set includes" to "at minimum (silence is a defect)"
- [auto] §3.3 table header rephrased; F19/F24 correctly attributed as the twice-in-a-row case
- [auto] Status header bumped to Revision 3 with summary line

### Integrity check

Integrity check: 0 issues found this round (auto: 0, escalated: 0).
Post-integrity sanity (4c): no broken section refs; no empty sections; six §4 Hunt Targets present; §3.4 / §3.3 / §6.3 / §8 all internally consistent.

---
