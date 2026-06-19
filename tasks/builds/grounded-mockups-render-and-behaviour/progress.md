# Progress — grounded-mockups-render-and-behaviour

**Repo:** `.claude-framework` (framework-canonical)
**Branch:** `claude/build-grounded-mockups` (off framework main a0303b2, v2.23.0)
**Classification:** Significant
**Review mode:** parallel (set in `.claude/session-state/review-mode`)
**Target version:** 2.24.0
**Status:** PLAN GATE — awaiting operator approval before construction

## Settled decisions (binding)

- **Repo home (operator-confirmed):** build EVERYTHING in `.claude-framework`, Pure-split. The impure `capture-surface.ts` ships as a managed file that imports the consuming repo's UI-test server/auth at a conventional path at runtime. Pure extractors + manifest validator are Vitest-tested. Live capture (A1/A2) verified in `automation-v1` after sync.
- **§9 spec decisions:** binding, not reopened.
- **Scope boundary:** do NOT touch feature-coordinator.md, architect.md, builder.md, plan-reviewer agents, scripts/build-scheduler/* (parallel build). Shared files (CHANGELOG, FRAMEWORK_VERSION, manifest.json) — expect a small merge reconcile at PR time; if merging second, take next free version and re-stack.

## Key constraint

The framework repo has NO toolchain (no node_modules/tsconfig/vitest/eslint). Lint, typecheck, Vitest, and the live capture run in `automation-v1` against the synced/copied files. Grep + version-diff acceptance (A4/A5/A6/A7) run directly in the framework.

## REVIEW_GAP

```
REVIEW_GAP: live-capture-verification (A1/A2) | task-class: Significant | reason: framework repo has no toolchain/UI server; live Playwright capture cannot run in .claude-framework | operator-override: no | remediation: verify A1/A2 in automation-v1 after sync — start npm run dev:server:ui, run capture-surface.ts against a known org-admin route (A1), then re-run with server down (A2)
```

## GRADED review posture

- `adversarial-reviewer`: skipped — no schema/migration/RLS/tenant-data surface (spec §10).
- `pr-reviewer`: mandatory (Significant) — runs per chunk / branch.
- `dual-reviewer`: applies if Codex available; else REVIEW_GAP.
- `chatgpt-pr-review`: Phase 3 (finalisation), parallel mode.

## Build order (from plan.md)

2 (contract) → 1 (capture script + extractors) → 3 (mockup-designer) → 4 (mockup-reviewer) → 5 (spec-coordinator + template) → 6 (docs + version + ADR + manifest).

## Post-sync action (NOT a framework deliverable)

`architecture.md` frontend-conventions note (§10) is a consuming-repo doc-sync item, executed in automation-v1 after sync (architecture.md is in framework `doNotTouch`).

## Build results

- **Chunk 2** (contract): `scripts/mockup/capture-manifestPure.ts` + test. Discriminated-union entry, full validator. **A3 verified** in automation-v1 (vitest).
- **Chunk 1** (capture): `scripts/mockup/capture-surfacePure.ts` (extractors) + `capture-surface.ts` (Playwright orchestrator, atomic writes, graceful degrade) + test. Pure extractors **verified** (vitest).
- **Chunks 1+2 toolchain (A8):** automation-v1 — **23 Vitest tests pass, ESLint clean, tsc clean** (copied in, verified, cleaned up; canonical files live in framework).
- **Chunk 3** (mockup-designer): Step 0a render-capture sub-step + grounding-list capture status + Step 3c behaviour manifest + skeleton/round-summary updates. **A4 grep green.**
- **Chunk 4** (mockup-reviewer): Axis 1 capture-aware checks + new Axis 4 + four-axes preamble + tier lists. **A4 grep green.**
- **Chunk 5** (spec-coordinator + mockup-coordinator + template): `## Interaction behaviour` pull-through, handoff fields, coordinator persistence, `docs/behaviour-manifest-template.md`. **A5/A6 grep green.**
- **Chunk 6** (docs/version/ADR/manifest): two frontend subsections, mobile cross-links, ADR-0007, FRAMEWORK_VERSION 2.24.0, manifest frameworkVersion 2.24.0 (closes 2.20.0 drift) + 7 managedFiles entries, CHANGELOG 2.24.0, doc-sync trigger row. **A7 grep green.**
- **Acceptance:** A3, A4, A5, A6, A7, A8 verified. A1/A2 = REVIEW_GAP (live capture, post-sync in automation-v1). ADR-0006 compliance verified (no project names in agent edits; LOCAL-OVERRIDE retained in docs).

## Log

- Setup: framework branch created, spec copied into build dir, review mode = parallel.
- Architect: plan.md written, 6 chunks, model-collapse rejected, REVIEW_GAP recorded.
- Plan review iteration 1 (external, CHANGES_REQUESTED): 5 technical findings applied to plan.md §10 — (1) per-viewport `captured` validation, (2) structured `domOutline` not digest, (3) `failed` semantics, (4) capabilities.md doc-sync verdict, (5) coordinator artifact persistence (adds mockup-coordinator.md edit to Chunk 5). Awaiting operator plan-gate approval.

## Doc-sync verdicts

- `docs/capabilities.md`: n/a — internal tooling only, no product capability change (recorded per review #4 / spec §6/§10).
