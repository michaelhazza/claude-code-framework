# Progress — grounded-mockups-render-and-behaviour

**Repo:** `.claude-framework` (framework-canonical)
**Branch:** `claude/build-grounded-mockups` (off framework main a0303b2, v2.23.0)
**Classification:** Significant
**Review mode:** parallel (set in `.claude/session-state/review-mode`)
**Target version:** 2.24.0
**Status:** PR OPEN — awaiting operator review (no merge). PR #27: https://github.com/michaelhazza/claude-code-framework/pull/27 · branch HEAD 7f0479e

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

## Branch review

- **spec-conformance:** CONFORMANT — 34 requirements, zero gaps (log `tasks/review-logs/spec-conformance-log-...-2026-06-19T03-26-53Z.md`, pushed 792be63).
- **pr-reviewer:** APPROVED (0 blocking). F1 auto-applied by reviewer (widest-viewport extraction). F2/F3/F4 (should-fix, technical) applied by coordinator: orphan-PNG cleanup on degrade + two missing tests. Re-verified in automation-v1: 25 Vitest pass, ESLint clean, tsc clean.
- **adversarial-reviewer:** skipped per GRADED — no schema/migration/RLS/auth/tenant-data surface (spec §10).
- **dual-reviewer:** REVIEW_GAP — see below.

### Deferred (pr-reviewer Consider, F5–F8 — not applied)
- F5: `isIsoTimestamp` accepts any Date.parse-able string (only producer is toISOString; tighten only for external edits).
- F6: `primaryButton` selector tags all buttons; field name over-promises (harmless grounding input).
- F7: `parseArgs` casts JSON.parse without shape validation (CLI-only; degrades safely).
- F8: `isServerReachable` treats 4xx root as reachable (intentional liveness; comment-only).

```
REVIEW_GAP: dual-reviewer | task-class: Significant | reason: Codex CLI availability not confirmed in this session; framework build is internal authoring tooling, risk_domain none | operator-override: no | remediation: optional — run dual-reviewer manually if Codex is available; pr-reviewer + spec-conformance already passed on a none-risk-domain diff
```

## Finalisation (automated mode, stopped at PR)

- **PR #27** opened into `michaelhazza/claude-code-framework` (base `main`).
- **chatgpt-pr-review (automated, gpt-5.5):** CHANGES_REQUESTED → 3 technical findings, all auto-applied + pushed (7f0479e):
  1. `chromium.launch()` moved inside error handling — a missing browser binary now degrades every screen gracefully (honours the spec's "capture is never a gate"), instead of crashing the round.
  2. Manifest `screenshotPaths` now repo-relative POSIX (the manifest is committed; absolute paths leaked local workspace layout).
  3. ADR-0007 added to `docs/decisions/README.md` index.
  - Deferred: mocked browser tests for 1+2 (would be dead tests — no toolchain in the framework repo; folded into the live-capture REVIEW_GAP).
- **Final verification after all fixes (automation-v1):** 25 Vitest pass, ESLint clean, `tsc --noEmit` (DOM lib) clean.
- **Doc-sync verdict:** frontend-design-principles + mobile-capability-principles updated; behaviour-manifest-template + ADR-0007 added; CHANGELOG + FRAMEWORK_VERSION + manifest bumped to 2.24.0; doc-sync trigger row added; `docs/capabilities.md`: n/a — internal tooling only.
- **STOPPED before merge** per operator instruction: no `ready-to-merge` label, no auto-merge. PR awaits operator review.

## Log

- Setup: framework branch created, spec copied into build dir, review mode = parallel.
- Architect: plan.md written, 6 chunks, model-collapse rejected, REVIEW_GAP recorded.
- Plan review iteration 1 (external, CHANGES_REQUESTED): 5 technical findings applied to plan.md §10 — (1) per-viewport `captured` validation, (2) structured `domOutline` not digest, (3) `failed` semantics, (4) capabilities.md doc-sync verdict, (5) coordinator artifact persistence (adds mockup-coordinator.md edit to Chunk 5). Awaiting operator plan-gate approval.

## Doc-sync verdicts

- `docs/capabilities.md`: n/a — internal tooling only, no product capability change (recorded per review #4 / spec §6/§10).
