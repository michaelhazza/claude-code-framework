# Dual Review Log — parallel-worktree-builders

**Files reviewed:** `scripts/build-scheduler/computeWaves.ts`, `scripts/build-scheduler/validatePlanMetadata.ts`, `scripts/build-scheduler/__tests__/*.test.ts`, `scripts/chatgpt-reviewPure.ts`, `.claude/agents/{architect,feature-coordinator,builder,claude-plan-review,chatgpt-plan-review}.md`, ADR-0007, CHANGELOG, manifest.json, build-artifact docs (full `origin/main...HEAD` diff)
**Iterations run:** 3/3
**Timestamp:** 2026-06-19T05:09:02Z
**Reviewer:** Codex (gpt-5.5, xhigh) via `codex review`; sandbox forced to `danger-full-access` because the default Windows sandbox cannot spawn git (`CreateProcessWithLogonW failed: 1326`).
**Commit at finish:** <filled-after-commit>

---

## Iteration 1 — `codex review --base main`

Codex raised 4 findings (2 P1, 2 P2).

[ACCEPT] feature-coordinator.md:468 — [P1] Untracked files dropped from worktree merge-back patch.
  Reason: Real data-loss bug in the parallel path. `git diff --binary HEAD` (step 3) and `git diff --name-only HEAD` (step 1) both OMIT untracked files. Builders are explicitly told "Never commit" and are never told to stage, so any NEW file a builder creates is untracked and silently dropped by the merge-back — the chunk would commit without the files it created. Fixed by adding an intent-to-add step (`git -C <worktree> add -AN`) before computing the change set and the patch, so new files appear in both diffs without staging content.

[ACCEPT] architect.md:161-168 — [P1] Chunk `id` absent from the machine-readable metadata block.
  Reason: Genuine contract gap. `computeWaves` requires non-optional `ChunkNode.id` (emits `chunkIds`), and the serialised merge-back loop keys builder handles by chunk id and iterates ids in ascending order. The documented YAML block had only `declared_files`/`depends_on`/`exclusive_resources` — and `depends_on` references "chunk ids" the block never defines. A coordinator parsing blocks verbatim had no id to pass through. Fixed by adding a required `id` field + field rule to the architect YAML contract, and by adding a missing/empty-id validation error in `validatePlanMetadata` (the parser already read `item['id']`, but the validator silently accepted `<unknown>`).

[ACCEPT] validatePlanMetadata.ts:113-120 — [P2] Malformed (non-string) `depends_on` / `exclusive_resources` entries silently dropped.
  Reason: Real safety hole consistent with the module's own `declared_files` handling. A `depends_on: [2]` (number) was filtered out, leaving `dependsOn: []` — a vanished dependency edge that would let a dependent chunk schedule concurrently with the chunk it depends on, defeating the core safety property. `declared_files` already surfaced non-string entries as errors; `depends_on`/`exclusive_resources` did not. Fixed by surfacing non-string entries as `pathErrors` (kept the valid string entries).

[REJECT] feature-coordinator.md:423-429 — [P2] Probe worktree support before metadata validation.
  Reason: Rejected. Codex argues a metadata defect could surface as `PLAN_GAP` on a worktree-unavailable surface where the documented fallback is to degrade to strict-sequential. But validating the plan-metadata contract regardless of execution surface is the SAFER posture: under-declared `declared_files` is the primary correctness risk this entire feature is built around (architect.md §4, spec §4), and reordering the probe ahead of validation would mean a worktree-unavailable session SKIPS that validation and runs a genuinely malformed plan. A `PLAN_GAP` on a malformed plan is correct behaviour, not a defect — the same plan is reused on the operator's next worktree-capable run. Less change is safer; surfacing real plan defects early wins over masking them behind a silent fallback. No code change.

## Iteration 2 — `codex review --uncommitted`

Codex confirmed the three accepted fixes resolved cleanly ("the rest of the changes and tests appear consistent") and raised 1 new finding introduced by the iteration-1 fix.

[ACCEPT] validatePlanMetadata.ts:127 — [P2] `JSON.stringify` can throw on non-serialisable values (BigInt / circular), regressing the NEVER-throws contract.
  Reason: Valid catch on code I had just written. `parsePlanMetadata` is contractually NEVER-throws; `JSON.stringify(BigInt)` throws `TypeError` and circular objects throw. The new `depends_on`/`exclusive_resources` error paths interpolated raw values via `JSON.stringify`. The identical latent pattern already existed at the pre-existing `declared_files` and `exclusiveResources` sites — 4 call sites total, which crosses the Three-Similar-Lines threshold and justifies extraction. Fixed by adding a `safeStringify(value)` helper (try/catch around `JSON.stringify`, falls back to `String(value)` / `Object.prototype.toString`) and routing all four call sites through it. Added a regression test asserting `parsePlanMetadata` does not throw on a BigInt entry and a circular object, and still reports the malformed entry.

## Iteration 3 — `codex review --uncommitted`

Clean. Codex: "No discrete correctness issues were found in the staged, unstaged, or untracked changes. The scheduler tests also pass for the modified build-scheduler files." Loop converged.

---

## Changes Made

- `.claude/agents/feature-coordinator.md` — Step 2d: added intent-to-add (`git add -AN`) step before merge-back diff/patch so untracked new files are not dropped (P1).
- `.claude/agents/architect.md` — Per-Chunk metadata YAML: added required `id` field + field rule; clarified `depends_on` references chunk `id`s (P1).
- `scripts/build-scheduler/validatePlanMetadata.ts` — required-`id` validation error; non-string `depends_on`/`exclusive_resources` entries now surface as errors instead of being silently dropped (P2); added `safeStringify` helper and routed all 4 error-message interpolation sites through it to preserve the NEVER-throws contract (P2).
- `scripts/build-scheduler/__tests__/validatePlanMetadata.test.ts` — added tests: missing/empty `id` → error; malformed `depends_on`/`exclusive_resources` entries surface errors and keep valid strings; `parsePlanMetadata` never throws on BigInt/circular inputs. (45 → 50 tests, all green.)

## Rejected Recommendations

- [P2] "Probe worktree support before metadata validation" (feature-coordinator.md:423-429) — rejected. Validating the metadata contract regardless of execution surface is the safer posture; reordering to skip validation when worktree is unavailable would mask under-declaration bugs (the feature's primary correctness risk). A `PLAN_GAP` on a malformed plan is correct, not a defect.

---

**Verdict:** APPROVED (3 iterations; 4 findings accepted and fixed — 2 P1, 2 P2; 1 P2 rejected with rationale; 50/50 scheduler tests green)
