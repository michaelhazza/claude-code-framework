# Spec Review Context — Framing Ground Truth

This file is the ground-truth framing reference for the `spec-reviewer` agent. Every spec review run starts by reading this file and cross-referencing the spec's framing against it. If the spec contradicts this file, the agent pauses for HITL before running any review iterations.

**This file is maintained by hand.** When the product context shifts, update this file FIRST, then re-review the specs that referenced the old framing. The agent treats every statement below as authoritative — an automated finding that contradicts this file is classified as directional and sent to HITL.

---

## Framing statements

```yaml
# Staleness metadata — used by spec-reviewer's pre-loop context check.
# Update last_reviewed_at when the framing block below is verified or modified.
# stale_after_days = 60: spec-reviewer warns when last_reviewed_at is older.
# stale_blocks_at_days = 120: spec-reviewer refuses to start until reviewed.
last_reviewed_at: 2026-07-05
stale_after_days: 60
stale_blocks_at_days: 120
```

Current as of 2026-07-05 (template date — reset it to your adoption date when you fill this file in). Update the date whenever any of the statements below change AND when the framing is verified to still apply (even if no statement changed). The staleness check above turns "I'll re-check this someday" into "the agent stops me at 4 months."

```yaml
# OPERATOR-FILL AT ADOPTION: every <angle-bracket> value below is a placeholder.
# The adopting operator must replace each one with the project's real answer
# (and delete inapplicable keys). spec-reviewer treats unfilled placeholders
# as "framing unknown" and will pause for HITL.

# Deployment context — fill in for your project
pre_production: <yes|no>
live_users: <yes|no>
live_agencies: <yes|no>
testing_phase_started: <yes|no>
production_incidents_expected: <yes|no>

# Stage of the app
stage: <rapid_evolution|stable|hardening>
feature_stability: <low|medium|high>
breaking_changes_expected: <yes|no>

# Testing posture
testing_posture: <static_gates_primary|hybrid|runtime_primary>
runtime_tests: <none|pure_function_only|api_contract|e2e>
frontend_tests: <none|unit|component|e2e>
api_contract_tests: <none_for_now|adopted>
e2e_tests_of_own_app: <none_for_now|adopted>
performance_baselines: <defer_until_production|tracked>
composition_tests: <defer_until_stabilisation|adopted>

# Rollout model
rollout_model: <commit_and_revert|feature_flags|staged_rollout>
feature_flags: <none|only_for_behaviour_modes|behaviour_and_rollout>

# Architecture defaults
prefer_existing_primitives_over_new_ones: yes
accepted_primitives:
  # Add your project's preferred extension points here, one per line:
  # - <primitive_name> (<path/to/file>) — <one-line description>

# Conventions the spec-reviewer should reject suggestions against
convention_rejections:
  # - "<convention to reject>"
```

---

## When to update this file

Update this file (and re-review any in-flight specs) when:

- A feature hits its per-feature stabilisation threshold (4+ weeks unchanged). The feature moves from "rapid evolution" to "stable" and the testing posture for that feature changes. Example: if `auth flow` stabilises, add a line to the `accepted_primitives` section or create a `stable_features` list.
- The first real agency client is onboarded. `live_users: no` becomes `yes`. Rollout model stops being `commit_and_revert` and becomes something more cautious. Feature flags become legitimate. This is the biggest single context shift and triggers a review of every spec in `docs/`.
- A new test category is adopted. If you decide E2E tests against the app are now worth building, add them to the testing-posture section and update the `e2e_tests_of_own_app` line.
- A new primitive lands that should become a preferred extension point. Add it to `accepted_primitives`.
- A convention the spec-reviewer was rejecting becomes OK to use. Remove it from `convention_rejections`.

---

## How the spec-reviewer agent uses this file

The agent reads this file once at the start of every review run. It uses the framing statements to:

1. **Classify directional findings.** If Codex suggests "add a staged rollout" and this file's `rollout_model` says otherwise (e.g. `commit_and_revert`), the agent classifies the suggestion as directional (not a mechanical fix).
2. **Reject findings in `convention_rejections`.** If Codex suggests "add supertest for API contract tests", the agent checks `convention_rejections` and rejects the finding mechanically with a logged reason.
3. **Prefer existing primitives.** If Codex suggests "introduce a new retry service", the agent checks `accepted_primitives` and rejects the finding when the repo's retry/backoff primitive is already listed there.
4. **Flag context mismatches before the loop starts.** If the spec under review says "staged rollout to 10% of traffic" but this file's `rollout_model` is `commit_and_revert`, the agent pauses for HITL before running iteration 1.

If you want to override any of these defaults for a specific spec, write the override into the spec's own framing section (Implementation philosophy / Execution model / Headline findings). The agent treats explicit spec-level framing as a permitted override AS LONG AS the override is flagged in a HITL checkpoint first — the human must confirm that the override is intentional.

---

## Emergency override

If you are running the `spec-reviewer` agent in a context where `docs/spec-context.md` is intentionally stale (e.g. you're specifically reviewing a spec that defines a new context), invoke the agent with an explicit override path:

```
spec-reviewer: review docs/my-spec.md with spec-context=docs/my-new-context.md
```

The agent will read the override file instead of this one. The override file must be a markdown file with the same `yaml` block structure.

Emergency overrides are logged in the final review report so the audit trail shows which context file the review was run against.
