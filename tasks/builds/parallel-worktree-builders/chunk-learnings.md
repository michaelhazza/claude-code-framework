# Chunk learnings — parallel-worktree-builders

## Chunk 1 — computeWaves pure scheduler

- **Files touched:** scripts/build-scheduler/computeWaves.ts, scripts/build-scheduler/__tests__/computeWaves.test.ts, manifest.json
- **G1 failures resolved:** 1 — a malformed Vitest `.toContain(a, b)` assertion in the test; fixed to single-arg, 19/19 pass. (No eslint in this repo — lint deferred to consuming-repo CI per §1.5.)
- **Plan gaps surfaced:** none
- **Watch-out for future chunks:** `computeWaves` does EXACT-STRING intersection on `declaredFiles` and does NOT canonicalise — **Chunk 2's `parsePlanMetadata` MUST canonicalise + case-fold paths before they reach `computeWaves`**, or the same-file safety property (A3) breaks on Windows (`src\Foo.ts` vs `./src/foo.ts`). `serialisedReasons: 'dependency'` is emitted only for lone chunks in topological layers 1+ (matches the §4 dogfood: only chunk 2 = exclusive-resource, chunk 6 = dependency). Test imports the module as `'../computeWaves.js'` (Vitest resolves `.js`→`.ts`), matching the existing `chatgpt-reviewPure.test.ts` convention.
