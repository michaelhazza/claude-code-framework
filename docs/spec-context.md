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
last_reviewed_at: 2026-04-16
stale_after_days: 60
stale_blocks_at_days: 120
```

Current as of 2026-04-16. Update the date whenever any of the statements below change AND when the framing is verified to still apply (even if no statement changed). The staleness check above turns "I'll re-check this someday" into "the agent stops me at 4 months."

```yaml
# Deployment context
pre_production: yes
live_users: no
live_agencies: no
testing_phase_started: no
production_incidents_expected: no

# Stage of the app
stage: rapid_evolution
feature_stability: low
breaking_changes_expected: yes

# Testing posture
testing_posture: static_gates_primary
runtime_tests: pure_function_only
frontend_tests: none_for_now
api_contract_tests: none_for_now
e2e_tests_of_own_app: none_for_now
performance_baselines: defer_until_production
composition_tests: defer_until_stabilisation

# Rollout model
rollout_model: commit_and_revert
feature_flags: only_for_behaviour_modes
staged_rollout: never_for_this_codebase_yet
migration_safety_tests: defer_until_live_data_exists

# Architecture defaults
prefer_existing_primitives_over_new_ones: yes
accepted_primitives:
  - policyEngineService
  - actionService.proposeAction
  - withBackoff (server/lib/withBackoff.ts)
  - TripWire (server/lib/tripwire.ts)
  - runCostBreaker (server/lib/runCostBreaker.ts)
  - playbookEngineService
  - failure() + FailureReason enum (shared/iee/failure.ts)
  - createWorker() (server/lib/createWorker.ts)
  - assertScope() (server/lib/scopeAssertion.ts) — per P1.1
  - mutateActiveToolsPreservingUniversal() (server/services/agentExecutionServicePure.ts) — per P4.1
  - withOrgTx / getOrgScopedDb / withAdminConnection (server/middleware/orgScoping.ts, server/instrumentation.ts) — three-layer fail-closed isolation entry points
  - RLS_PROTECTED_TABLES manifest (server/config/rlsProtectedTables.ts) — single source of truth for tenant-isolated tables; new tenant tables MUST be added in the same migration that creates them
  - verify-rls-coverage.sh + verify-rls-contract-compliance.sh (scripts/gates/) — CI gates that enforce RLS manifest coverage and direct-DB-access prohibition
  - rls.context-propagation.test.ts (server/services/__tests__/) — integration test harness for Layer B RLS default-deny posture
  - scheduleCalendarServicePure (server/services/scheduleCalendarServicePure.ts) — cron-parser / rrule / heartbeat-offset projection math; SOURCE_PRIORITY + computeNextHeartbeatAt
  - agent_runs.is_test_run + testRunIdempotency + testRunRateLimit (server/lib/) — test-run dual-bucket idempotency and rate limiting
  - shared/runStatus.ts — TERMINAL_RUN_STATUSES / IN_FLIGHT_RUN_STATUSES / AWAITING_RUN_STATUSES sets, single source of truth for run-status semantics
  - agentExecutionEventService + agentExecutionEventServicePure (server/services/) — live per-run execution event emission with atomic sequence allocation, critical-tier retry, cap-signal atomic claim; discriminated-union validator + AGENT_EXECUTION_EVENT_CRITICALITY registry at shared/types/agentExecutionLog.ts (Phase 1 of tasks/live-agent-execution-log-spec.md)
  - agentRunPromptService (server/services/agentRunPromptService.ts) — persists fully-assembled run prompts + layer attributions; per-run `agent_run_prompts` rows keyed on `(run_id, assembly_number)` with surrogate UUID
  - agentRunPayloadWriter (server/services/agentRunPayloadWriter.ts) — redaction → tool-policy → greatest-first truncation pipeline for full LLM payload persistence with traceable `redacted_fields` + `modifications` columns
  - redaction (server/lib/redaction.ts) — default pattern bundle (bearer / openai / anthropic / github / slack / aws / google) + cycle-safe JSON walker; used by payload writer and extensible by consumers
  - agentRunVisibility + agentRunEditPermissionMask(Pure) (server/lib/) — single source of truth for the three-tier canView / canViewPayload / per-entity mask rules; mask is computed at read time only and never persisted (closes the privilege-drift class)
  - RLS_PROTECTED_TABLES entries: agent_execution_events, agent_run_prompts, agent_run_llm_payloads (migration 0192)

# Conventions the spec-reviewer should reject findings against
convention_rejections:
  - "do not add vitest / jest / playwright for own app (until Phase 2 trigger)"
  - "do not add supertest for API contract tests (until Phase 2 trigger)"
  - "do not add frontend unit tests (until Phase 2 trigger)"
  - "do not add feature flags for new migrations"
  - "do not add cross-tenant drift detection, speculative execution, or multi-agent reconciliation"
  - "do not add predictive cost modelling or tool success scoring loops"
  - "do not introduce new service layers when existing primitives fit"
  - "do not replace the tsx + static-gate test convention"
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

1. **Classify directional findings.** If Codex suggests "add a staged rollout", the agent compares against `staged_rollout: never_for_this_codebase_yet` and classifies it as directional (not a mechanical fix).
2. **Reject findings in `convention_rejections`.** If Codex suggests "add supertest for API contract tests", the agent checks `convention_rejections` and rejects the finding mechanically with a logged reason.
3. **Prefer existing primitives.** If Codex suggests "introduce a new retry service", the agent checks `accepted_primitives` and rejects the finding because `withBackoff` exists.
4. **Flag context mismatches before the loop starts.** If the spec under review says "staged rollout to 10% of traffic" but `staged_rollout: never_for_this_codebase_yet`, the agent pauses for HITL before running iteration 1.

If you want to override any of these defaults for a specific spec, write the override into the spec's own framing section (Implementation philosophy / Execution model / Headline findings). The agent treats explicit spec-level framing as a permitted override AS LONG AS the override is flagged in a HITL checkpoint first — the human must confirm that the override is intentional.

---

## Emergency override

If you are running the `spec-reviewer` agent in a context where `docs/spec-context.md` is intentionally stale (e.g. you're specifically reviewing a spec that defines a new context), invoke the agent with an explicit override path:

```
spec-reviewer: review docs/my-spec.md with spec-context=docs/my-new-context.md
```

The agent will read the override file instead of this one. The override file must be a markdown file with the same `yaml` block structure.

Emergency overrides are logged in the final review report so the audit trail shows which context file the review was run against.
