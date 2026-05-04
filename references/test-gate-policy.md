# Test Gate Policy

> Single source of truth for the "test gates are CI-only — never run locally" rule. Referenced from `CLAUDE.md`, every agent in `.claude/agents/`, and every spec/plan in `docs/` and `tasks/builds/`.

This file replaces ~10 duplicated copies of the same rule across the agent fleet.

## Rule

**Continuous integration runs the complete test/gate suite as a pre-merge gate.** No local agent or development session runs the full battery. This applies to every agent in `.claude/agents/`, every skill, every review loop iteration, and every main-session task — no carve-outs.

## Forbidden locally

- `npm run test:gates`, `npm run test:qa`, `npm run test:unit`, the umbrella `npm test`.
- `bash scripts/run-all-unit-tests.sh`, `bash scripts/run-all-gates.sh`.
- Any individual `scripts/verify-*.sh` or `scripts/gates/*.sh` invocation.
- Any "regression sanity check", "quick re-verify everything", "confirm no regression" framing — these are dressed-up gate runs.

## Allowed locally

- `npm run lint`.
- `npm run typecheck` (or the dual-tsconfig form per `replit.md`).
- `npm run build:server` / `npm run build:client` when the change touches the build surface.
- **Targeted execution of unit tests authored for THIS change** — a single test file via `npx tsx <path-to-test>`. Confirm the new test runs and passes. Not to re-run anything else.

Authoring tests and gates is encouraged. Running the full battery of them locally is not. CI handles that.

## Why

- CI is the authoritative gate runner. Local runs drift. Trust the canonical surface.
- Whole-repo verifiers are slow. They burn agent time without producing new signal.
- Local runs encourage "make this gate pass" patches that hide root causes. CI's pre-merge run catches them anyway.
- Pre-production posture: gate state shifts as the codebase shifts. The CI run is the only one fresh enough to act on.

## What this means for plans and specs

- A plan's "Verification commands" section per chunk lists ONLY lint, typecheck, build:server/client (when relevant), and targeted unit tests for that chunk. No `scripts/verify-*.sh`, no `npm run test:*` umbrella commands.
- A plan does NOT include a "Phase 0 baseline gate run" or a "Programme-end full gate set" section. CI does both.
- A spec MUST NOT instruct implementers to run any forbidden command above. Spec-reviewer auto-fixes specs that do.
- A pull request that requires the operator to "run the gates locally to confirm" before merging is mis-scoped. Either CI catches it, or it's not gate-relevant.

## Pre-existing gate violations

If a plan or implementation suspects pre-existing gate violations:
1. Identify the suspected violation by static reasoning (read the code, read the gate script's grep pattern, point at the offending line).
2. If the new code clearly depends on the violating pattern, add a "Pre-existing violation to fix" item to the plan with the file, the fix, and a one-line justification.
3. CI will catch any baseline violation we missed when the PR is opened — that is the expected behaviour. Don't pre-empt CI by running gates locally.

## How to reference this file

Agent files and specs that need to enforce the rule should link here rather than embedding their own copy:

```markdown
**Test gates are CI-only.** See [`references/test-gate-policy.md`](../../references/test-gate-policy.md). The forbidden / allowed lists live there; this agent enforces them at <step or boundary>.
```

Agents may add a one-line clarification specific to their step (e.g. "step 5 re-verification is limited to reading the affected file back; never runs gates"), but should not duplicate the forbidden / allowed lists.
