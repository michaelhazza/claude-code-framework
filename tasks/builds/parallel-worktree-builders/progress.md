# Progress — parallel-worktree-builders

**Repo:** `.claude-framework` (canonical) | **Branch:** `claude/build-parallel-worktree-builders` (off origin/main @ a0303b2, #26)
**Classification:** Major (core build-loop orchestration) | **Review mode:** parallel (`.claude/session-state/review-mode`)
**Phase:** Phase 2 build — at PLAN GATE (awaiting operator decisions)

## Homing decision (cross-branch precedent applied)
"All in framework, Pure-split" — all 6 chunks land in `.claude-framework`; pure modules unit-tested here; `architecture.md`/`CLAUDE.md` (doNotTouch, absent here) deferred to a logged consuming-repo follow-up. One framework PR. See memory `project_framework_build_homing`.

## Status log
- [x] Branch created off latest origin/main (#26).
- [x] Spec staged in framework build dir.
- [x] architect → plan.md (6 chunks, 4-wave dogfooded scheduling).
- [x] claude-plan-review → APPROVE_WITH_FINDINGS (0 blocking, 5 non-blocking). All 4 safety-critical claims verified sound.
- [x] Applied F1 (manifest frameworkVersion drift), F2 (ADR-0007 + README→0008 same chunk), F3 (wave-internal migration check ≠ Step 2 branch-vs-main), F5 (.js import extension) to plan.md.
- [x] Decision B/F4 → Vitest (operator chose at gate); plan updated (§1.5, §8, Chunk 1/2 verification, risk table, decision B).
- [x] chatgpt-plan-review parallel — OpenAI tier ran (gpt-5.5, NEEDS_DISCUSSION, 8 findings, clean call). Manual ChatGPT-web tier: blocked by missing SendMessage plumbing; offered to operator as optional final pass.
- [x] Applied all 8 OpenAI findings: OAI-001 (merge-back diff-apply primitive — builders never commit, so `git -C <wt> diff --binary HEAD | git apply --3way`, NOT `git merge`), OAI-002 (snake↔camel single normaliser in Chunk 2 + fixture), OAI-003 (rollout = operator-phrase, no persistent counter), OAI-004 (tightened version-bump branch), OAI-005 (per-chunk manifest-parse + grep self-checks in Chunks 1-5), OAI-006 (§8 stale npx tsx → vitest), OAI-007 (serialisedReasons reason+priority defined + tested), OAI-008 (runtime independence gate mandatory, both intersections).
- Review log: `tasks/review-logs/chatgpt-plan-review-parallel-worktree-builders-2026-06-19T03-09-57Z.md`.
- [x] Operator ChatGPT round 1 (CHANGES_REQUESTED, 2 HIGH + 3 MEDIUM) — all applied:
  - HIGH-1 strict-sequential mode: at effectiveCap=1 / no opt-in phrase, the NEW path (parse/validate/computeWaves/probe/gate/audit) does NOT execute — A8 by non-execution. Wave preview is plan-gate-only. (Chunk 4 step 2a/2b, §1.2.)
  - HIGH-2 crash-safety transaction: clean-branch precondition before each diff-apply; apply→commit is the only dirty window; on resume a dirty feature branch = interrupted merge-back → `git reset --hard && git clean -fd` + per-chunk re-dispatch, never silently continue. (Chunk 4 step 2d.)
  - MED-3 hard cleanup: apply conflict → `git reset --hard HEAD && git clean -fd` + verify porcelain empty (not `git checkout -- .`/reverse-apply). (Chunk 4 step 2d.4.)
  - MED-4 stable merge order made mechanical: handles keyed by chunk id; iterate ascending sorted ids; await the specific builder; never integrate a later id before earlier ids commit/fallback. (Chunk 4 step 2d.)
  - MED-5 worktree-unavailable: discard wave schedule, full strict-sequential fallback (not an under-specified "single-chunk path"). (Chunk 4 step 2c.)
  - Reflected in §1.2 (A8), audit-trail note, error-handling line, A7 grep anchors, and ADR-0007 safety argument/alternatives.
- [x] Operator ChatGPT round 2 (CHANGES_REQUESTED → APPROVED-on-apply, 1 HIGH + 2 MEDIUM + 1 LOW) — all applied:
  - HIGH path canonicalisation: `parsePlanMetadata` canonicalises declared_files (`\`→`/`, collapse `.`/`//`, reject abs/`..`/empty, de-dupe, case-fold for Windows) BEFORE validate + schedule; computeWaves intersects exact-string on canonical paths (single normalisation point). Tests for `./src/a.ts`≡`src/a.ts`, `src\a.ts`≡`src/a.ts`, `src/Foo.ts`≡`src/foo.ts`, abs/`..`/empty reject. (Chunk 2 + Chunk 1 precondition.)
  - MEDIUM sibling quarantine: an INDEPENDENCE_VIOLATION discards ALL remaining unintegrated sibling worktrees (stale vs old base) → re-run sequentially in chunk-id order; keep only pre-violation integrated commits. (Chunk 4 wave failure handling.)
  - MEDIUM stale "git merge conflicts" wording → "3-way patch apply conflicts or commit-integrity fails" in §1.3, risks, ADR, anchors.
  - LOW post-commit clean-state: after each merge-back commit, assert `git status --porcelain` empty before push/progress/worktree-remove; dirty → fail + reset + re-run.
- [x] PLAN APPROVED by operator → autonomous build authorised through finalisation, STOP at PR (no merge).

## Phase 2 — Construction (autonomous)
Build order (bootstrap: scheduler does not exist yet, old sequential coordinator builds it): 1 → 2 → 3 → 4 → 5 → 6.
- [ ] Build chunks 1→6 sequentially (scheduler does not exist until ch1 lands; bootstrap order 1-2-3-4-5-6).
- [ ] G2 (consuming-repo CI post-sync) + pr-reviewer.

## GRADED review posture
- `adversarial-reviewer`: skipped — no schema/RLS/tenant-data surface (spec §13). Orchestration-correctness risk covered by computeWaves unit tests + merge-back guard. Not a REVIEW_GAP (correctly not applicable for this diff shape).
- `dual-reviewer`: to run at branch review if Codex available; else REVIEW_GAP.

## Open decisions for the gate
A (scope split — defer architecture.md/CLAUDE.md downstream), B/F4 (test runner — recommend Vitest), C (cap=3, §12.1 binding), D (ADR 0007 + README→0008), E (doc-sync trigger row — recommend add), F (rollout phrase `launch feature coordinator parallel`, §12.5 binding).
