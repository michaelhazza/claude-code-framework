# PR Review — Render-Grounded Mockups + Behaviour Capture (capture scripts)

Reviewer: pr-reviewer (v2)
Date: 2026-06-19
Branch: claude/build-grounded-mockups (.claude-framework)
Files reviewed: scripts/mockup/capture-manifestPure.ts, capture-surfacePure.ts, capture-surface.ts, scripts/__tests__/capture-manifestPure.test.ts, capture-surfacePure.test.ts
risk_domain: none (internal authoring tooling)

**Verdict:** APPROVED (0 blocking, 3 should-fix, 4 consider)

## Auto-applied by reviewer (mechanical)
- **F1** capture-surface.ts — token-sheet/DOM-outline extraction now grounds on the WIDEST captured viewport via a max-tracking guard (`widestSeen`), not the last-iterated one. Viewports are caller-parameterised (§9 decision 2), so an unsorted list would otherwise ground on the narrowest layout.

## Applied by coordinator (should-fix — all technical, applied per autonomous-build authorisation)
- **F2** capture-surface.ts — orphan-PNG cleanup. `captureOneScreen` now tracks screenshots written for the screen and removes them (`removePartials`) on the 4xx degrade path and in a catch before a `failed` is recorded, so a non-`captured` entry never leaves a stray PNG. Closes the file-tree-level gap in the A2 "no partial artifacts" claim.
- **F3** capture-surfacePure.test.ts — added a test proving `extractTokenSheet` caps each token array at MAX_PER_BUCKET (60).
- **F4** capture-surfacePure.test.ts — added a test proving `pruneDomOutline` silently drops an unknown `OutlineKind` candidate without throwing.

Re-verified in automation-v1 after the fixes: 25 Vitest tests pass, ESLint clean, `tsc --noEmit` (DOM lib) clean.

## Surfaced — Consider (deferred; not applied)
- **F5** capture-manifestPure.ts `isIsoTimestamp` accepts any `Date.parse`-able string, not strictly ISO. Only producer is `toISOString()`, so it never bites today; tighten with a regex only if external hand-edited manifests must be trusted.
- **F6** capture-surface.ts `primaryButton` selector tags all buttons; the field name `primaryButtons` over-promises. Capped/deduped grounding input — harmless; rename or narrow only if it misleads.
- **F7** capture-surface.ts `parseArgs` casts `JSON.parse` without runtime shape validation. CLI-only operator path; malformed input degrades safely (per-screen `failed`).
- **F8** capture-surface.ts `isServerReachable` treats a 4xx root as reachable (intentional liveness semantics); a clarifying comment would help future readers.

Consider items routed to `tasks/builds/grounded-mockups-render-and-behaviour/progress.md` deferred notes.

Blocking: 0 / Should-fix: 3 (all applied) / Consider: 4 (deferred)
**Verdict:** APPROVED
