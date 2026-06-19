# Chunk learnings — parallel-worktree-builders

## Chunk 1 — computeWaves pure scheduler

- **Files touched:** scripts/build-scheduler/computeWaves.ts, scripts/build-scheduler/__tests__/computeWaves.test.ts, manifest.json
- **G1 failures resolved:** 1 — a malformed Vitest `.toContain(a, b)` assertion in the test; fixed to single-arg, 19/19 pass. (No eslint in this repo — lint deferred to consuming-repo CI per §1.5.)
- **Plan gaps surfaced:** none
- **Watch-out for future chunks:** `computeWaves` does EXACT-STRING intersection on `declaredFiles` and does NOT canonicalise — **Chunk 2's `parsePlanMetadata` MUST canonicalise + case-fold paths before they reach `computeWaves`**, or the same-file safety property (A3) breaks on Windows (`src\Foo.ts` vs `./src/foo.ts`). `serialisedReasons: 'dependency'` is emitted only for lone chunks in topological layers 1+ (matches the §4 dogfood: only chunk 2 = exclusive-resource, chunk 6 = dependency). Test imports the module as `'../computeWaves.js'` (Vitest resolves `.js`→`.ts`), matching the existing `chatgpt-reviewPure.test.ts` convention.

## Chunk 2 — Plan-metadata validator + parsePlanMetadata

- **Files touched:** scripts/build-scheduler/validatePlanMetadata.ts, scripts/build-scheduler/__tests__/validatePlanMetadata.test.ts, manifest.json
- **G1 failures resolved:** none (25/25 Vitest pass first run; lint deferred — no eslint config)
- **Plan gaps surfaced:** none
- **Watch-out for future chunks:** `parsePlanMetadata(raw)` returns **`{ chunks, pathErrors }`** (NOT a flat array) — path errors are detected during canonicalisation before structural validation, surfaced structurally to honour the never-throw contract. **Chunk 4's coordinator prose must reflect this:** the wave-compute step calls `parsePlanMetadata(raw)`, treats a non-empty `pathErrors` as a `PLAN_GAP` (same as `validatePlanMetadata` `ok:false`), and passes `.chunks` into `validatePlanMetadata` then `computeWaves`. Canonicalisation (snake→camel + path normalise + case-fold) lives ENTIRELY here — Chunk 1 assumes canonical input.

## Chunk 3 — architect.md metadata emission

- **Files touched:** .claude/agents/architect.md
- **G1 failures resolved:** none (markdown; grep self-check — all 5 anchors hit first pass)
- **Plan gaps surfaced:** none
- **Watch-out for future chunks:** architect now emits snake_case `declared_files`/`depends_on`/`exclusive_resources` per chunk + a `## Build parallelism` plan section (advisory; coordinator's `computeWaves` is authoritative). The `## Build parallelism` section the architect produces is the same one Chunk 4's coordinator consumes — keep the field-name vocabulary aligned across architect.md, the validator (Chunk 2), and feature-coordinator.md (Chunk 4).

## Chunk 4 — feature-coordinator.md Step 6 wave-loop rewrite

- **Files touched:** .claude/agents/feature-coordinator.md (151 insertions, 15 deletions — mostly additive; deletions are `###`→`####` heading re-levelling of the extracted inner routine)
- **G1 failures resolved:** none (grep self-check — all 11 anchors hit; lint/tests N/A for markdown)
- **Plan gaps surfaced:** none
- **Watch-out for future chunks:** Step 6 is now: inner routine (today's per-chunk body, verbatim, re-levelled to `####`) + Step 2a/2b/2c/2d mode machinery. Preserved invariants verified present: commit-integrity invariant (×3), `plan-declared ⊇ builder-reported` (×2), mandatory builder dispatch, chunk-learnings, Steps 7/8/10 untouched. Chunk 6's CHANGELOG/ADR should reference the strict-sequential default + diff-apply transaction. The pr-reviewer/spec-conformance branch pass must run the preserve-every-invariant checklist against this file.

## Chunk 5 — Plan-review under-declared-files hunt target

- **Files touched:** .claude/agents/claude-plan-review.md, .claude/agents/chatgpt-plan-review.md, **scripts/chatgpt-reviewPure.ts** (deliberate scope expansion — see below)
- **G1 failures resolved:** none (grep self-check green; `scripts/__tests__/chatgpt-reviewPure.test.ts` 102/102 still green after the prompt edit)
- **Plan gaps surfaced:** none
- **Scope expansion (documented):** the plan declared only the two `.md` plan-review agents, but the **automated** OpenAI plan-review tier's prompt lives in `scripts/chatgpt-reviewPure.ts` (`SYSTEM_PROMPT_PLAN_V2`). Builder correctly flagged (not smuggled) that editing only the `.md` files leaves the default automated/parallel tier without the new hunt target — i.e. the feature would be half-wired. Coordinator folded the hunt-target bullet into `SYSTEM_PROMPT_PLAN_V2`'s Hunt targets list so ALL three plan-review tiers (claude, manual ChatGPT-web, automated OpenAI) carry it. Test asserts only placeholder-substitution, not prompt content → safe; verified green. Chunk 6 manifest note: `scripts/chatgpt-reviewPure.ts` is already a registered managed file, so no new manifest entry needed.
- **Watch-out for future chunks:** none.

## Chunk 6 — Docs + ADR + version + manifest finalise

- **Files touched:** docs/decisions/0007-parallel-worktree-builders.md (new), docs/decisions/README.md, .claude/CHANGELOG.md, .claude/FRAMEWORK_VERSION (2.23.0→2.24.0), .claude/agents/builder.md, docs/doc-sync.md, manifest.json (frameworkVersion 2.20.0→2.24.0 + ADR-0007 row)
- **G1 failures resolved:** none (all deterministic checks pass first run: manifest valid JSON, 4 helper entries + ADR row present, version 2.24.0, CHANGELOG/README/builder/doc-sync anchors hit)
- **Plan gaps surfaced:** none
- **Watch-out:** ADR-0007 references ADR-0014 (coordinator-runs-inline) which exists only in consuming repos, not the framework repo — a logical cross-reference, consistent with other ADRs. manifest `frameworkVersion` drift (2.20.0) reconciled to 2.24.0 alongside FRAMEWORK_VERSION.




