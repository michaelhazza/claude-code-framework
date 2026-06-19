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

## Phase 2 — Construction (autonomous) — COMPLETE
Build order (bootstrap: old sequential coordinator builds the scheduler): 1 → 2 → 3 → 4 → 5 → 6. All committed + pushed.
- Chunk 1 computeWaves.ts (19 tests) · Chunk 2 validatePlanMetadata+parsePlanMetadata (25) · Chunk 3 architect.md · Chunk 4 feature-coordinator.md Step 6 · Chunk 5 plan-review ×3 tiers · Chunk 6 ADR-0007/version/manifest/doc-sync.
- G2: 152 Vitest pass (50 build-scheduler + 102 chatgpt-review); manifest valid + frameworkVersion 2.24.0; FRAMEWORK_VERSION 2.24.0.

## Review pass — COMPLETE
- **spec-conformance:** CONFORMANT (zero fixes).
- **adversarial-reviewer:** SKIPPED — no schema/RLS/auth/tenant-data surface (spec §13); orchestration-correctness covered by unit tests + merge-back guard. Correct GRADED not-applicable skip, not a REVIEW_GAP.
- **pr-reviewer:** found PR-001 BLOCKING (case-fold file-disjointness — `src/Foo.ts`≡`src/foo.ts` co-scheduled) + PR-002 masking test. Fixed (computeWaves case-insensitive file identity; original casing kept for git; A3b regression test; gate prose aligned). Re-review: APPROVED.
- **dual-reviewer (Codex, 3 iterations):** APPROVED. Found + fixed 4: P1 merge-back data-loss (`git diff --binary HEAD` omits untracked files → added `git add -AN` intent-to-add); P1 missing chunk `id` in architect contract + validator; P2 silent dependency-edge loss → validation error; P2 never-throw regression → safeStringify. Tests 45→50.
- **chatgpt-pr-review (Phase 3):** RAN on PR #28 (operator-driven). CHANGES_REQUESTED, 1 HIGH + 2 MEDIUM, all fixed (commit `bab418a`):
  - HIGH: present-but-scalar `depends_on`/`exclusive_resources`/`declared_files` silently dropped (singleton-serialisation hole) → now fail closed with a structured error (generalised across all 3 fields, broader than the flagged `exclusive_resources` alone).
  - MEDIUM: `parsePlanMetadata` not truly never-throws → guards non-array `raw` + null/non-object block entries → structured PLAN_GAP, not a coordinator crash.
  - MEDIUM: numeric chunk ids sorted lexicographically (1,10,2) → numeric-aware `compareChunkIds` at all 4 computeWaves sort sites + merge-back prose aligned.
  - Tests 50→57 (7 new); all probed green.
- **chatgpt-pr-review round 2** on PR #28. CHANGES_REQUESTED, 1 HIGH + 1 MEDIUM + 1 LOW, all fixed (commit `eb7f3f0`):
  - HIGH: `computeWaves` was passed the raw operator `concurrencyCap`, not the resolved `effectiveCap` (min of operator/default/worktree caps) → a lowered cap wouldn't constrain dispatch. Now passes `effectiveCap`; records it in progress.
  - MEDIUM: worktree probe ran AFTER waves computed+recorded → stale wave data on fallback. Moved probe into step 2a (effectiveCap resolution) — probe failure → strict-sequential, waves never computed; no stale data possible.
  - LOW: `validatePlanMetadata` honoured "never throws" only for well-formed arrays → now guards non-array/null/non-object input like `parsePlanMetadata`. Tests 57→60.

## Doc-sync
ADR-0007, CHANGELOG 2.24.0, FRAMEWORK_VERSION + manifest frameworkVersion (2.24.0), manifest registrations (4 modules + ADR), doc-sync.md trigger, README 0008 reservation — all done. CHANGELOG updated post-review for the `id` field + case-insensitive identity + intent-to-add.

## Phase 3 — Finalisation (operator authorised full finalisation after chatgpt-pr-review)
- **chatgpt-pr-review round 3** (A8 regression from r2's probe move): fixed — Step 2a checks opt-in phrase BEFORE the probe; absent it, force effectiveCap=1 → 2b with no probe/progress-write (commit `cce1662`).
- **Branch sync / version reconcile (S2):** grounded-mockups merged first (`43f1221`), deferring its version ("Unreleased") for coordination with this build. Merged origin/main; resolved 4 conflicts:
  - **Version:** grounded-mockups finalised to **2.24.0** (merged first); parallel-worktree-builders takes **2.25.0** (merged second). `FRAMEWORK_VERSION` + manifest `frameworkVersion` → 2.25.0.
  - **ADR collision:** both claimed 0007. Theirs keeps `0007-ground-mockups-in-real-render`; mine renumbered to **`0008-parallel-worktree-builders`** (file, title, README row, reservation note → 0009, manifest `0008-*.md` registration).
  - **manifest:** merged both `managedFiles` sets (4 build-scheduler + 5 capture entries), deduped the template.example line; valid JSON.
  - **CHANGELOG:** my 2.25.0 entry on top, their finalised 2.24.0 entry below.
- **Post-merge verification:** full combined Vitest suite **196 passed** (build-scheduler 60 + grounded-mockups capture + chatgpt-review + framework tests).
- [ ] Build chunks 1→6 sequentially (scheduler does not exist until ch1 lands; bootstrap order 1-2-3-4-5-6).
- [ ] G2 (consuming-repo CI post-sync) + pr-reviewer.

## GRADED review posture
- `adversarial-reviewer`: skipped — no schema/RLS/tenant-data surface (spec §13). Orchestration-correctness risk covered by computeWaves unit tests + merge-back guard. Not a REVIEW_GAP (correctly not applicable for this diff shape).
- `dual-reviewer`: to run at branch review if Codex available; else REVIEW_GAP.

## Open decisions for the gate
A (scope split — defer architecture.md/CLAUDE.md downstream), B/F4 (test runner — recommend Vitest), C (cap=3, §12.1 binding), D (ADR 0007 + README→0008), E (doc-sync trigger row — recommend add), F (rollout phrase `launch feature coordinator parallel`, §12.5 binding).
