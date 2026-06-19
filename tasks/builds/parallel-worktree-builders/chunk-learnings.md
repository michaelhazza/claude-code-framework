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


