# Implementation Plan: Parallel Worktree Builders for Independent Chunks

**Spec:** `tasks/builds/parallel-worktree-builders/spec.md` (DRAFT, §12 decisions binding)
**Classification:** Major (core build-loop orchestration; cross-cutting across architect / feature-coordinator / builder / plan-review)
**Repo:** `claude-code-framework` canonical submodule (this repo) — NOT the consuming app repo.
**Target framework version:** 2.24.0 (current `.claude/FRAMEWORK_VERSION` = 2.23.0).
**Plan author:** architect
**Date:** 2026-06-19

## Table of contents

- Executor notes
- Model-collapse check
- 1. Architecture notes
- 2. Stepwise implementation plan (chunk overview)
- 3. Per-chunk detail (Chunks 1–6)
- 4. Build parallelism
- 5. Risks and mitigations
- 6. Open decisions for plan-gate
- 7. Acceptance criteria coverage map
- 8. G2 / end-of-construction (consuming-repo CI)

---

## Executor notes

Test gates and whole-repo verification scripts (`npm run test:gates`, `npm run test:qa`, `npm run test:unit`, `npm test`, `scripts/verify-*.sh`, `scripts/gates/*.sh`, `scripts/run-all-*.sh`) are CI-only. They do NOT run during local execution of this plan, in any chunk, in any form. Targeted execution of unit tests authored within this plan is allowed; running the broader suite is not.

**Framework-repo specifics the executor must respect:**

- This repo has **no `tsconfig.json`, no eslint config, no local vitest**. `package.json` is bare (`{"type":"commonjs"}`). Typecheck/build/lint gates that the canonical agent file calls "G2" do NOT exist here and run in the **consuming repo** after sync. The G2 line in chunk verification below is therefore reduced to what is actually runnable here (see § 8 / § Verification model in §1.5).
- Every NEW file under `scripts/` (the scheduler, its test, the validator, the validator test) **MUST** be registered in `manifest.json` `managedFiles[]` or it never propagates to consuming repos. Manifest registration is plan work, done in the chunk that creates the file.
- `architecture.md` and `CLAUDE.md` are in `manifest.json` `doNotTouch` and **do not exist in this repo** — they are consuming-repo-owned. Spec §13's `architecture.md` / `CLAUDE.md` edits are OUT OF SCOPE for this branch and are flagged as a downstream consuming-repo follow-up (§ 6, decision A).

## Model-collapse check

This feature does NOT decompose into ingest → extract → transform → render, and no step is a candidate for a single frontier-model call. The work is (1) a deterministic pure graph algorithm (`computeWaves` — topological layering + disjoint grouping), (2) a deterministic plan-metadata validator, and (3) playbook prose edits to agent definitions. Determinism and auditability are the entire point: the spec requires byte-identical sequential fallback at concurrency=1 (A8) and stable wave ordering across resumes (A5). A model call cannot provide that — wave computation must be a pure, unit-tested function whose output is reproducible and inspectable. **Collapse rejected:** the value is in removing model judgement from the safety-critical scheduling decision, not adding it. The merge-back independence guard is likewise a deterministic git-conflict check, not a model judgement. This is the correct shape — no multi-step pipeline is being built that a single model call would replace.

## 1. Architecture notes

### 1.1 The one real module vs. the prose edits

This Major change has a small hard core and a large prose surface. The hard core is two pure TypeScript modules:

- `scripts/build-scheduler/computeWaves.ts` — the wave scheduler (pure, unit-tested, the safety-critical heart).
- `scripts/build-scheduler/validatePlanMetadata.ts` — the plan-metadata validator (pure, unit-tested).

Everything else (`architect.md`, `feature-coordinator.md`, `builder.md`, `claude-plan-review.md`, `chatgpt-plan-review.md`, ADR, CHANGELOG, doc-sync) is **playbook prose**. The architecture decision is to **push every testable decision into the two pure modules** and keep the agent prose declarative — the Step 6 rewrite *references* `computeWaves`/`validatePlanMetadata` outputs rather than re-deriving wave logic in prose. This is the same pattern the repo already uses (`cross-repo-scoutPure.ts`, `experiment-runner-loopPure.ts`, `chatgpt-reviewPure.ts`): logic in a helper, orchestration in the agent. **Pattern selected: extract-the-decidable-core.** Considered and rejected: encoding the wave algorithm directly in `feature-coordinator.md` prose (spec §5 explicitly rejects this — "so wave computation is unit-tested, not buried in the playbook prose").

### 1.2 Sequential path IS the concurrency=1 path (A8)

The single most important constraint: **concurrency=1 must reproduce today's sequential loop byte-identically** (A8). The design achieves this structurally, not via a parallel branch with an `if cap==1` shortcut:

- **The new path is GATED OFF entirely in strict-sequential mode (Chunk 4 step 2b).** When `effectiveCap == 1` (the default — no opt-in phrase, or worktree unavailable, or cap=1), the coordinator runs today's loop verbatim and **never invokes** `parsePlanMetadata` / `validatePlanMetadata` / `computeWaves` / the worktree probe / the independence gate / wave-audit writes. A8 holds because the new code path *does not execute at all*, not because a new path happens to behave the same. Wave preview is a plan-gate-only (Step 5) computation for the operator.
- A **single-chunk wave in parallel mode also dispatches exactly as today**: one `builder` Agent call, no `isolation: "worktree"`, coordinator commits on the feature branch with the identical message format (spec §6.1). Worktree isolation, concurrent dispatch, and the diff-apply merge-back are reachable ONLY on multi-chunk waves under an engaged parallel opt-in.

A8 is thus a structural property: in the default mode the new machinery is unreachable; only an explicit `launch feature coordinator parallel` + a multi-chunk wave + an available worktree exercises any of it.

### 1.3 Four layers of independence enforcement (defence in depth)

The spec mandates independence be *proven*, never assumed. Four layers, each a backstop for the prior:

1. **Plan-time (architect, §4):** emits `declared_files` / `depends_on` / `exclusive_resources`, conservative-by-default. Wrong declarations are the primary risk.
2. **Plan-review-time (Chunk 5):** `claude-plan-review` + `chatgpt-plan-review` hunt for under-declared `declared_files` relative to `spec_sections`.
3. **Dispatch-time (independence gate, §5.2):** coordinator recomputes file-set intersection + migration collision across a wave's chunks before dispatching; any overlap pulls a chunk into a later sequential slot.
4. **Merge-back-time (§7 guard):** if an UNDECLARED overlap slips all three, **the 3-way patch apply (`git apply --3way`) conflicts or the commit-integrity check fails** (builders never commit, so there is no `git merge` here); coordinator never force-applies, falls the late chunk back to sequential re-application, logs `INDEPENDENCE_VIOLATION`.

This is the "state-based idempotency: exists is not correct" principle applied to merges — a clean-looking wave is not trusted; the merge result is verified and a conflict is a typed failure with a defined recovery, never a silent force-merge.

### 1.4 Serialised integration, parallel construction

Builders run concurrently in isolated worktrees; results integrate back to the feature branch **one at a time, in stable chunk-ID order** (§12.4), keeping commit history linear and one-commit-per-chunk — identical in shape to today's output. Coordinator-owned files (`progress.md`, `chunk-learnings.md`, `.phase`, etc.) are NEVER written inside a worktree, eliminating the N-builders-racing-to-append failure. This is the load-bearing invariant that lets every downstream guarantee (commit-integrity chain, resume detection, G2, review pass) run unchanged on the merged result.

### 1.5 Verification model in this repo

This repo has no tsconfig/eslint/vitest, so the executor cannot run `npm run lint` / `npm run typecheck`. Runnable local verification is:

- **Unit tests for the pure modules** via **Vitest** — `npx vitest run scripts/build-scheduler/` (vitest self-downloads; no tsconfig needed — it transpiles TS natively). This is the resolved decision B/F4: Vitest matches the simultaneously-landing framework build's pure module and the framework-wide "Runner is Vitest" rule. Use Vitest's `describe`/`it`/`expect` API (mirroring the existing `chatgpt-reviewPure.test.ts`), NOT `node:test`/`node:assert`.
- **Lint/typecheck/build** are deferred to the consuming repo's CI after sync (the canonical G2). There is no G2 to run here; the plan's "G2" is satisfied by consuming-repo CI post-sync.

**Test runner note (RESOLVED — decision B/F4 = Vitest):** new scheduler tests use **Vitest**, matching `chatgpt-reviewPure.test.ts` and the parallel framework build's pure module, for one consistent runner across the new `scripts/build-scheduler/` modules. (The three older helper-script tests use `node:test`; we do not follow that here — cross-branch consistency and the framework-wide Vitest default win, per the operator's plan-gate decision.)

### 1.6 ADR-0014 respected

The coordinator runs INLINE in the main session, giving it top-level `Agent` access to dispatch builders concurrently. It is never itself a sub-agent (which would hit the "sub-agents cannot dispatch sub-agents" runtime block). The Step 6 rewrite and ADR-0007 both call this out so no future change nests the coordinator.

## 2. Stepwise implementation plan (chunk overview)

Six chunks, mirroring spec §10, dependency-ordered. Each chunk dogfoods the metadata format this spec introduces.

| # | Chunk | Public capability | depends_on |
|---|-------|-------------------|------------|
| 1 | `computeWaves` pure scheduler + tests | wave computation from chunk graph | — |
| 2 | Plan-metadata contract + validator + tests | declared_files/depends_on/exclusive_resources schema + rejection of malformed plans | — |
| 3 | `architect.md` metadata emission | architect emits the §3.1 fields + `## Build parallelism` section | 2 |
| 4 | `feature-coordinator.md` Step 6 wave-loop rewrite | the parallel build loop with serialised merge-back | 1, 2 |
| 5 | Plan-review under-declared-files hunt target | claude-plan-review + chatgpt-plan-review catch under-declaration | 2 |
| 6 | Docs + doc-sync + ADR + version + manifest finalise | ADR-0007, CHANGELOG, version bump, doc-sync trigger, builder.md note | 1,2,3,4,5 |

Chunks 1 and 2 have no dependency edge, but **both touch `manifest.json`** (a singleton registry file modelled as an exclusive resource per §12.6) → the scheduler serialises them. The real parallel wave is {3, 4, 5}. See § 4 Build parallelism for the full computation.

## 3. Per-chunk detail

### Chunk 1 — `computeWaves` pure scheduler + unit tests

**Spec sections:** §3.2 (independence relation), §3.3 (waves), §5.1 (wave computation), §5.3 (concurrency cap shape).

```yaml
declared_files:
  - scripts/build-scheduler/computeWaves.ts
  - scripts/build-scheduler/__tests__/computeWaves.test.ts
  - manifest.json
depends_on: []
exclusive_resources:
  - manifest.json   # singleton registry file — see note below
```

**Module shape:**
- *Public interface:* one exported pure function plus its types.
  ```ts
  export interface ChunkNode {
    id: string;                      // stable chunk id, e.g. "1", "chunk-4"
    dependsOn: string[];             // chunk ids that must complete first
    declaredFiles: string[];         // exhaustive create/modify set
    exclusiveResources?: string[];   // e.g. ["migration:v2.24.0"]
  }
  export interface ComputeWavesInput { chunks: ChunkNode[]; concurrencyCap: number; }
  export interface Wave { chunkIds: string[]; }       // ordered; size 1..cap
  export interface ComputeWavesResult {
    waves: Wave[];
    serialisedReasons: Array<{ chunkId: string; reason: 'file-overlap' | 'exclusive-resource' | 'dependency' | 'cap-spill'; conflictsWith?: string }>;
  }
  export function computeWaves(input: ComputeWavesInput): ComputeWavesResult;
  ```
- *What stays hidden:* topological layering, the greedy pairwise-disjoint grouping within a layer, cap-spill into sub-waves, the stable-sort tiebreak (chunk id ascending), cycle detection, intersection helpers. Callers see waves + reasons only.

**Algorithm (hidden behind the interface):**
1. Validate the graph: detect cycles in `dependsOn` → throw `Error("dependency cycle: <ids>")`.
2. Topologically layer by `dependsOn` (Kahn's algorithm, stable by id within a layer).
3. Within each layer, greedily build waves: iterate chunks in stable id order; place each in the first existing wave where it is pairwise file-disjoint AND exclusive-resource-disjoint with every member AND the wave is below `concurrencyCap`; else open a new wave. Record a `serialisedReasons` entry whenever a chunk is forced into a separate wave.

**`serialisedReasons` semantics (OAI-007 — define precisely so the type, the algorithm, and the §4 example agree):** a chunk gets at most one reason, chosen by this fixed priority when multiple causes apply:
   1. `'dependency'` — the chunk sits in a LATER topological layer than the wave it would otherwise join (a `depends_on` edge pushed it down). Cross-layer; takes precedence because it is the hardest constraint. (This is why §4 emits `{chunkId:'6', reason:'dependency'}` — chunk 6 depends on all.)
   2. `'exclusive-resource'` — same layer, but split into a later sub-wave because it shares an `exclusive_resources` value with an earlier-placed chunk. (Higher priority than file-overlap: chunks 1 & 2 share `manifest.json` as BOTH a declared file AND an exclusive resource → reason is `'exclusive-resource'`, `conflictsWith:'1'`.)
   3. `'file-overlap'` — same layer, split because of a `declared_files` intersection with an earlier-placed chunk.
   4. `'cap-spill'` — same layer, no overlap/resource clash, split only because the target wave hit `concurrencyCap`.
   `conflictsWith` names the earlier chunk that triggered a resource/file split (omitted for `dependency`/`cap-spill`).
4. Emit waves in layer order, waves within a layer in creation order, chunk ids within a wave sorted ascending.

**Path precondition (round 2 HIGH):** `computeWaves` does **exact-string** intersection on `declaredFiles`; it assumes those paths are ALREADY canonicalised + case-folded by `parsePlanMetadata` (Chunk 2). `computeWaves` does not re-canonicalise — canonicalisation lives in exactly one place (Chunk 2). The A3 same-file test feeds canonical paths; the Windows-casing/slash cases are tested in Chunk 2 where the normalisation lives.

**Determinism (A5):** every ordering decision uses a stable sort keyed on chunk id; no `Set` iteration order or `Object.keys` ordering leaks into output.

**`manifest.json` registration (this chunk):** add two entries mirroring the existing helper-script + helper-script-test rows (`manifest.json` lines 46–51):
```json
{ "path": "scripts/build-scheduler/computeWaves.ts", "category": "helper-script", "mode": "sync", "substituteAt": "never" },
{ "path": "scripts/build-scheduler/__tests__/computeWaves.test.ts", "category": "helper-script-test", "mode": "sync", "substituteAt": "never" }
```
*Note on `manifest.json` as `exclusive_resources`:* `manifest.json` is a singleton registry file edited by Chunks 1, 2, and 6. Per §12.6 ("singleton registry files … model any it finds as exclusive resources"), it is declared as an exclusive resource so the scheduler never co-schedules two chunks that both edit it. This dogfooding forces Chunks 1 and 2 — which both touch `manifest.json` — into separate waves (§ 4).

**Error handling:** dependency cycle → throw with named ids. Unknown id in `dependsOn` → throw `Error("unknown dependency id: <id>")`. Empty chunk list → `{ waves: [], serialisedReasons: [] }`. Cap < 1 → throw (caller guarantees ≥1).

**Test considerations (mandatory — author with the module):** **Vitest** (decision B/F4), `describe`/`it`/`expect`, run via `npx vitest run scripts/build-scheduler/__tests__/computeWaves.test.ts`. **Import convention (F5):** import the module under test extensionless or `.js` per the existing `chatgpt-reviewPure.test.ts` Vitest convention (Vitest resolves `../computeWaves` to the `.ts` source) — confirm against that sibling when authoring. Cases:
- **A1:** 3 chunks, no `dependsOn`, disjoint files, cap≥3 → one wave of 3.
- **A2:** fully-chained (2→1, 3→2) → 3 waves of 1 (today's sequential order).
- **A3 (core safety):** 2 chunks declaring the same file, no edge → 2 waves of 1, never one of 2; `serialisedReasons` records `file-overlap`.
- **A4:** 2 chunks sharing `exclusive_resources: ["migration:v2.24.0"]` → serialised; reason `exclusive-resource`.
- **A5:** same input run twice → deep-equal waves (determinism).
- **A8 support:** cap=1 on the A1 plan → 3 waves of 1 (1-per-wave dispatch == sequential).
- Extra: cap=2 on 3 independent chunks → wave of 2 then wave of 1 (`cap-spill`); cycle → throws; unknown dep id → throws.
- **`serialisedReasons` reason + priority (OAI-007):** a chunk depending on another → reason `'dependency'` (no `conflictsWith`); two chunks sharing BOTH a file and an exclusive resource → reason `'exclusive-resource'` (priority over `file-overlap`), `conflictsWith` names the earlier chunk. (This mirrors the dogfooded §4 result: `{chunkId:'2', reason:'exclusive-resource', conflictsWith:'1'}` and `{chunkId:'6', reason:'dependency'}`.)

**Verification commands:** `npx vitest run scripts/build-scheduler/__tests__/computeWaves.test.ts`. Because this chunk edits `manifest.json`, also self-check it parses + contains the two new entries (OAI-005): `node -e "const m=JSON.parse(require('fs').readFileSync('manifest.json','utf8')); if(!m.managedFiles.some(f=>f.path==='scripts/build-scheduler/computeWaves.ts')) throw new Error('computeWaves not registered')"`. No typecheck/build here (runs in consuming-repo CI post-sync).

**Acceptance criteria covered:** A1, A2, A3, A4, A5, partial A8 (scheduler 1-per-wave proof).

**Dependencies:** none. (First parallel layer with Chunk 2, but serialised from it by the `manifest.json` exclusive resource.)

---

### Chunk 2 — Plan-metadata contract + validator + unit tests

**Spec sections:** §3.1 (chunk metadata fields), §4 (required `declared_files`/`depends_on`), §11 A6.

```yaml
declared_files:
  - scripts/build-scheduler/validatePlanMetadata.ts
  - scripts/build-scheduler/__tests__/validatePlanMetadata.test.ts
  - manifest.json
depends_on: []
exclusive_resources:
  - manifest.json
```

**Module shape:**
- *Public interface:*
  ```ts
  export interface RawChunkMetadata {
    id?: string; specSections?: string[];
    declaredFiles?: string[];        // required, non-empty
    dependsOn?: string[];            // required, may be empty array
    exclusiveResources?: string[];   // optional
  }
  export interface ValidationError { chunkId: string | '<unknown>'; field: string; message: string; }
  export interface ValidatePlanResult { ok: boolean; errors: ValidationError[]; }
  export function validatePlanMetadata(chunks: RawChunkMetadata[]): ValidatePlanResult;
  ```
- *What stays hidden:* per-field presence/shape checks, duplicate-id detection, dangling-`dependsOn`-id detection, empty-`declaredFiles` rejection, the `exclusive_resources` free-form-string note (no schema enforced per §12.6 open-endedness).

**Contracts + the snake↔camel boundary (OAI-002 — load-bearing).** The on-disk plan contract is **snake_case** (`declared_files` / `depends_on` / `exclusive_resources`, as authored in each chunk's YAML block); the TS interfaces here and in `computeWaves` are **camelCase** (`declaredFiles` / `dependsOn` / `exclusiveResources`). **Chunk 2 owns the single normalisation point:** export a `parsePlanMetadata(raw)` (or equivalent) that reads the snake_case keys and emits the camelCase `RawChunkMetadata[]`, which `validatePlanMetadata` then validates and the coordinator feeds straight into `computeWaves`. There is exactly ONE place snake→camel mapping happens; no other chunk re-implements it. **Mandatory fixture:** include a test whose input is a snake_case block copied verbatim from a real plan chunk (e.g. this plan's Chunk 1 block) → asserts it normalises + validates to `ok:true`; and a malformed snake_case block → `ok:false`. This is the guard against shipping a validator that rejects every real (snake_case) plan. Single responsibility otherwise: it only answers "is this plan metadata well-formed enough to schedule?" — it does NOT re-implement wave logic.

**Validation rules:** `declaredFiles` present + non-empty (A6); `dependsOn` present (empty array allowed); ids unique; every `dependsOn` id resolves to a known chunk; `exclusiveResources` if present is an array of non-empty strings. Each violation → one `ValidationError`; `ok` false if any.

**Path canonicalisation — REQUIRED for the core safety property (HIGH, round 2).** `declared_files(A) ∩ declared_files(B) = ∅` is only sound if paths are compared canonically; the target env includes **Windows**, so `src\Foo.ts`, `./src/foo.ts`, and `src//foo.ts` can name the same file while a naïve set intersection calls them disjoint. `parsePlanMetadata` MUST canonicalise EVERY `declared_files` entry BEFORE validation and before the value reaches `computeWaves`/the independence gate:
- replace `\` → `/`; collapse `//` → `/`; resolve `.` segments;
- **reject** absolute paths, `..` segments, and empty strings (→ `ValidationError`);
- de-duplicate within a chunk after normalisation;
- a **conservative case-folded collision check**: two entries equal under `toLowerCase()` (across chunks in a wave, or duplicates within a chunk) are treated as the SAME file for intersection purposes (Windows is case-insensitive; this is conservative — it may serialise a true-disjoint pair on a case-sensitive FS, which is safe). The canonical, case-folded path is what `computeWaves` and the §5.2 gate intersect on; the original casing is preserved only for display/`conflictsWith` messages.
**Tests (mandatory):** `./src/a.ts` vs `src/a.ts` → same file (serialise); `src\a.ts` vs `src/a.ts` → same file; `src/Foo.ts` vs `src/foo.ts` → same file (case-fold); absolute path / `..` / empty → `ValidationError`.

**Error handling:** the validator NEVER throws on malformed input — it returns structured `errors`. (Throwing is reserved for `computeWaves` graph-integrity faults.) The coordinator treats `ok:false` as a `PLAN_GAP` route back to architect.

**Test considerations (mandatory):** runner per decision B/F4 (see § 6); same `.js`-extension import convention as Chunk 1 (F5):
- **A6:** chunk missing `declaredFiles` → `ok:false`, error names field + chunk.
- Empty `declaredFiles: []` → rejected. Missing `dependsOn` → rejected; `dependsOn: []` → accepted.
- Dangling `dependsOn` id → rejected. Duplicate chunk ids → rejected. Fully-valid 3-chunk plan → `ok:true`.

**`manifest.json` registration:** add the two entries for `validatePlanMetadata.ts` + its test (same `helper-script` / `helper-script-test` categories).

**Verification commands:** `npx vitest run scripts/build-scheduler/__tests__/validatePlanMetadata.test.ts`. Plus the same `manifest.json` parse + entry self-check for `validatePlanMetadata.ts` (OAI-005).

**Acceptance criteria covered:** A6.

**Dependencies:** none. (Serialised after Chunk 1 by the shared `manifest.json` exclusive resource — see § 4.)

---

### Chunk 3 — `architect.md` metadata emission + parallelism summary

**Spec sections:** §4 (architect changes), §12.3 (conservative-default + active-marking), §12.6 (survey singletons).

```yaml
declared_files:
  - .claude/agents/architect.md
depends_on: ["2"]
exclusive_resources: []
```

**Module shape (prose edit):**
- *Public interface:* the architect's plan output now requires, per chunk, a `declared_files:` block, a `depends_on:` block, and (where applicable) `exclusive_resources:`; plus a new `## Build parallelism` section in `plan.md`.
- *What stays hidden:* the architect's internal independence reasoning (it just emits the fields). Wave computation is NOT the architect's job — it states the graph; the coordinator runs `computeWaves`. Architect MAY preview expected waves in `## Build parallelism`, but the authoritative computation is the coordinator's.

**Edits:**
1. Add to the "Per-Chunk Detail" output spec (after `Module shape`/`Contracts`): each chunk emits `declared_files:` (exhaustive create/modify set — "the same set the commit-integrity invariant already relies on; now explicit + machine-readable"), `depends_on:` (chunk ids; empty allowed), and `exclusive_resources:` where it claims a migration prefix or other singleton.
2. Add the **conservative-default stance** (§12.3): "If unsure whether two chunks are independent, add a `depends_on` edge to serialise them. Do actively mark clearly-disjoint chunks as independent (empty `depends_on`, disjoint files) — do not chain everything — but never chase parallelism at the cost of provable safety."
3. Add the **singleton survey instruction** (§12.6): during file inventory, survey for shared singletons (migration prefixes, shared codegen outputs, singleton registry files such as `manifest.json`, lockfiles) and model each as an `exclusive_resources` entry.
4. Add a **`## Build parallelism`** plan-section requirement summarising the computed/expected waves + rationale, so the operator sees the parallel plan at the plan-gate. Note the coordinator re-derives authoritative waves via `computeWaves` (Chunk 1).
5. Cross-reference: "exhaustive `declared_files` is a correctness obligation — under-declaration is the primary risk, hunted by plan-review (spec §4)."

**Contracts:** the field names architect emits (`declared_files` / `depends_on` / `exclusive_resources`) must match the validator's vocabulary (Chunk 2) and the `computeWaves` `ChunkNode` shape (Chunk 1) — hence the dependency on Chunk 2 as contract source.

**Error handling:** n/a (prose). Backstops: validator (Chunk 2) + plan-review (Chunk 5).

**Test considerations:** deterministic grep — `architect.md` contains anchors for `declared_files`, `depends_on`, `exclusive_resources`, `## Build parallelism`, and the conservative-default sentence. (No test file; verified at Chunk-6 doc-sync + branch review.)

**Verification commands (OAI-005 — self-check at this chunk, not deferred):** `grep -F` that `architect.md` now contains each anchor: `declared_files`, `depends_on`, `exclusive_resources`, `## Build parallelism`, and the conservative-default sentence. Each must return a hit before commit.

**Acceptance criteria covered:** contributes to A7 (metadata the coordinator consumes) + the §4 obligation; enables A9 doc-sync.

**Dependencies:** Chunk 2 (field vocabulary / contract).

---

### Chunk 4 — `feature-coordinator.md` Step 6 wave-loop rewrite

**Spec sections:** §5, §5.2, §5.3, §6, §7, §8, §12.1/§12.4/§12.5.

```yaml
declared_files:
  - .claude/agents/feature-coordinator.md
depends_on: ["1", "2"]
exclusive_resources: []
```

**Module shape (the largest prose edit):**
- *Public interface:* Step 6 becomes a **wave loop**. Its observable contract to the rest of the playbook is unchanged: after Step 6 the feature branch has one clean commit per chunk in stable order, `progress.md` reflects every chunk done, and G2 (Step 7) runs on the integrated state exactly as today.
- *What stays hidden behind the wave loop:* whether a wave ran 1 or N builders, worktree provisioning/teardown, concurrent dispatch, the dispatch-time independence gate, serialised merge-back ordering, and the `INDEPENDENCE_VIOLATION` fallback. Steps 0–5 and 7–12 see no change.

**Rewrite structure (preserving A8 — concurrency=1 == today byte-identically):**

1. **Extract today's per-chunk body into a "process one chunk" inner routine** containing, verbatim, the current: resume detection, builder dispatch (mandatory, Sonnet, never inline), G1 scoped lint + coordinator backup lint, plan-gap handling (≤2 rounds), commit-integrity invariant (`plan-declared ⊇ builder-reported ⊇ working-tree`), chunk-learnings write-BEFORE-commit (incl. partial-write recovery), `git add <declared files only> + chunk-learnings.md`, commit message format, push, progress + environment-snapshot write, TodoWrite complete. **None of this logic changes.**

2. **Gate STRICT-SEQUENTIAL mode FIRST — before any new machinery runs (HIGH-1 / MEDIUM-5):**

   **2a. Determine effective concurrency up front.** `effectiveCap = min(operator cap, current-default cap, worktree-availability)`. **Parallel is engaged ONLY if ALL hold:** the operator included the opt-in phrase `launch feature coordinator parallel`, the worktree-availability probe (2c) succeeds, AND `effectiveCap ≥ 2`.

   **2b. Strict-sequential mode (the default — `effectiveCap == 1` or no opt-in phrase) is byte-identical to today (A8).** Run the OLD Step 6 loop VERBATIM in plan order via the inner routine. In this mode the coordinator **does NOT call `parsePlanMetadata`, `validatePlanMetadata`, `computeWaves`, the worktree probe, the independence gate, or any wave-audit write** — none of the new code path executes, so there is nothing new that can fail or mutate state. Progress/snapshot writes are exactly today's. **Wave PREVIEW is computed at the plan-gate (Step 5) for the operator only — never inside Step 6 execution.** This makes A8 a property of *not running the new path at all*, not of a new path that happens to behave the same.

   **2c. Parallel mode (opt-in phrase present) only:**
   - Compute waves once: **parse + normalise** the plan's snake_case metadata via `parsePlanMetadata` (Chunk 2, the single snake→camel point — OAI-002), **validate** via `validatePlanMetadata`; `ok:false` → `PLAN_GAP` to architect. Then `computeWaves({ chunks, concurrencyCap })` (Chunk 1) on the normalised chunks. Default cap = **3** (§12.1). Record chosen cap + the computed waves in `progress.md`.
   - **Worktree availability probe BEFORE committing to the wave schedule (§8, §12.2, MEDIUM-5):** verify `isolation: "worktree"` actually provisions a worktree here (confirm-on-first-run per §12.2). **If the probe FAILS → discard the wave schedule entirely and fall the WHOLE build back to strict-sequential mode (2b).** Do NOT attempt to run a multi-chunk wave (e.g. `{3,4,5}`) via an under-specified "single-chunk path" — there is no such path; the correct fallback is full strict-sequential in plan order. Log `parallelism: disabled — worktree unavailable`.
   - **Resume determinism:** waves recomputed identically on resume (§6.4, deterministic `computeWaves`); per-chunk resume detection (commit exists for the chunk's files?) applies per chunk regardless of wave. See the merge-back resume protocol (step 2d) for the dirty-branch case.
   - For each wave **in order**:
     - **Single-chunk wave → call the inner routine directly (today's path; no worktree, no concurrency).**
     - **Multi-chunk wave (size ≥2):**
       - **Independence gate (§5.2) — MANDATORY, both intersections (OAI-008).** Before dispatch the coordinator MUST re-verify BOTH: (a) pairwise `declared_files` intersection across the wave — any non-empty intersection → pull the offending chunk into a later sequential slot, log it; AND (b) a **wave-internal exclusive-resource check** — pairwise-compare the wave's chunks' declared `exclusive_resources` (migration prefixes, singleton registry files, etc.); any shared resource → serialise. Both checks are REQUIRED. **This is NOT the Step 2 branch-vs-main collision check** (`origin/main...HEAD`) — the wave-internal check MUST be a pairwise comparison across the wave's chunks.
       - **Concurrent dispatch:** issue all N `builder` Agent calls **in a single message**, each `model: "sonnet"`, each with `isolation: "worktree"`, each given plan path + chunk name + declared-files list. Builders run normal Steps 0–5 incl. per-chunk G1 inside their own worktree. **HARD RULE preserved:** builder dispatch is mandatory; coordinator never writes chunk code inline.

   **2d. Serialised merge-back is a TRANSACTION, in ascending chunk-id order (§7, §12.4 — HIGH-2 / MEDIUM-3 / MEDIUM-4):**

   Keep the dispatched builder handles **keyed by chunk id**. Iterate the wave's chunk ids in **ascending sorted order** (NOT first-finished-first); when it is chunk C's turn, **await C's specific builder result**. Never integrate a later chunk id before every earlier chunk id in the wave has either committed or entered explicit sequential-fallback. For each chunk C in sorted order:

   0. **Clean-branch precondition (HIGH-2).** Assert `git status --porcelain` on the feature branch is empty before touching C. If it is dirty, a prior merge-back was interrupted → run the resume protocol below first; never apply onto a dirty branch.
   1. Collect C's result (SUCCESS / PLAN_GAP / G1_FAILED) + reported `Files changed`; compute the worktree change set with `git -C <worktree> diff --name-only HEAD`.
   2. **Commit-integrity check** on the worktree diff (`plan-declared ⊇ builder-reported ⊇ worktree-changed`) — unchanged semantics.
   3. **Integration primitive — diff-apply, NOT `git merge` (OAI-001).** Builders never commit, so there is no worktree branch to merge; transfer the uncommitted diff: `git -C <worktree> diff --binary HEAD | git -C <feature-branch-root> apply --3way`. `--3way` merges against the current feature HEAD (which may have advanced as earlier siblings merged back).
   4. **Merge-back guard + HARD cleanup (MEDIUM-3).** If `git apply --3way` conflicts or fails: do NOT force it and do NOT rely on `git checkout -- .` or reverse-apply (these can leave unmerged index stages, conflict markers, new untracked files, or partial binary changes). Run `git reset --hard HEAD && git clean -fd` from the feature root, then **verify `git status --porcelain` is empty** before proceeding. Fall C back to sequential re-application (re-dispatch its builder against the now-updated feature branch); log `INDEPENDENCE_VIOLATION` naming both chunks + the file. (Store the failed patch in a temp file for debug logging only — never for partial reversal.) The earlier chunk of the pair already committed cleanly.
   5. **Coordinator-owned writes on the feature branch (NEVER in a worktree):** chunk-learnings entry, backup scoped lint, `git add <declared files> + chunk-learnings.md`, per-chunk commit (standard message). **Post-commit clean-state assertion (round 2 LOW):** immediately verify `git status --porcelain` is EMPTY before pushing, updating `progress.md`, marking TodoWrite complete, or removing the worktree. If anything remains (residue from staging, an undeclared artefact), the transaction did NOT close cleanly → fail this chunk's merge-back, `git reset --hard HEAD && git clean -fd`, and re-run the chunk rather than making the NEXT chunk discover the dirtiness. Only on a clean porcelain: push, `progress.md` update, TodoWrite complete. **The clean commit closes the transaction** — the only point at which C's work becomes durable feature-branch state.
   6. Remove the worktree.

   **Crash-safety / resume protocol (HIGH-2 — restores the spec's "a crash leaves only fully-merged chunk commits" guarantee).** The ONLY window where the feature branch holds uncommitted chunk work is between apply (3) and commit (5). On ANY Step 6 resume, if the feature branch is dirty (`git status --porcelain` non-empty), treat it as an **interrupted merge-back**: `git reset --hard HEAD && git clean -fd`, then let per-chunk resume detection ("is there a commit for this chunk's files?") re-dispatch the affected chunk. **Never silently continue on a dirty feature branch.** Because apply→commit is the only dirty window and it resolves to reset+re-run, a crash never leaves half-merged state that survives resume.

   - **Wave failure handling (§8):** one builder's `G1_FAILED` re-dispatches only that chunk (siblings unaffected, file-isolated); `PLAN_GAP` pauses the wave and routes to architect, but siblings already integrated (earlier sorted ids) stay committed. Per-chunk escalation ladders (plan-gap ≤2, G1 ≤3) apply within the wave, unchanged.
   - **INDEPENDENCE_VIOLATION quarantines the rest of the wave (round 2 MEDIUM).** A merge-back conflict DISPROVES this wave's independence claim. The only worktrees that can still be trusted are those **already integrated before the violation** (their clean apply proved their disjointness against the then-current feature HEAD). Every **remaining unintegrated sibling worktree** in this wave was built against the OLD wave base and is now stale → **discard all of them (remove the worktrees, do NOT apply them) and re-run those chunks SEQUENTIALLY, in ascending chunk-id order, against the updated feature branch** (each via the strict-sequential inner routine). Keep the already-integrated commits; never apply a stale sibling worktree after an independence claim has been falsified. Log the quarantine list in `progress.md` alongside the `INDEPENDENCE_VIOLATION`.
   - After every wave's merge-back completes, proceed to the next wave (its `depends_on` now satisfied on the feature branch).

3. **Audit trail (§G5) — parallel mode only:** when parallel is engaged, record in `progress.md` per wave: wave index, chunk ids, concurrency used, merge order, any `INDEPENDENCE_VIOLATION` / serialisation fallbacks / worktree-unavailable fallback. In strict-sequential mode there is no wave-audit write (2b) — progress writes are exactly today's.

4. **Rollout gate (§12.5) — operator-phrase-driven, NO persistent build counter (OAI-003).** The gate is purely the per-invocation operator phrase: parallel runs ONLY when the operator includes `launch feature coordinator parallel`; absent the phrase, force concurrency=1 (today's behaviour) while still computing + displaying the waves for preview at the plan-gate. **The coordinator stores no build-count state and does not track "build N of 3"** — there is nothing to increment, nothing to double-count on resume. The "opt-in for the first 3 builds, then default-on" in §12.5 is a **maintainer decision**: after confidence is gained, a maintainer edits this agent's default (a one-line change flipping the absent-phrase default from concurrency=1 to wave-on), recorded in `.claude/CHANGELOG.md` — it is NOT an automated counter the coordinator maintains. Effective cap = min(operator cap, current-default cap, worktree-availability cap).

5. **ADR-0014 callout:** the coordinator must run inline in the main session (top-level `Agent` access) and must never itself be dispatched as a sub-agent — that would break both the sequential and parallel loops at the first builder dispatch.

**Contracts consumed:** `computeWaves` (`ChunkNode` → `ComputeWavesResult`) and `validatePlanMetadata` (`RawChunkMetadata` → `ValidatePlanResult`). The prose references these helpers by path + contract; it does not re-derive wave logic.

**Error handling:** validator `ok:false` → PLAN_GAP; `computeWaves` throw (cycle/unknown id) → PLAN_GAP with the thrown message; worktree unavailable → discard wave schedule + full strict-sequential fallback (no failure); `git apply --3way` conflict → hard cleanup (`git reset --hard HEAD && git clean -fd`, verify porcelain empty) + `INDEPENDENCE_VIOLATION` + sequential re-apply (never force-merge); crash between apply and commit → dirty feature branch on resume → reset + per-chunk re-dispatch (never silently continue); per-chunk ladders unchanged.

**Test considerations:** deterministic grep (A7) — Step 6 must contain anchors for: **strict-sequential mode** (the default, new path gated off), wave loop, runtime independence gate, concurrent builder dispatch with `isolation: "worktree"`, the **diff-apply integration primitive** (`git apply --3way`), **serialised merge-back transaction** in ascending chunk-id order, the **clean-branch precondition** + **crash-safety resume** (dirty branch → `git reset --hard` + re-run), `INDEPENDENCE_VIOLATION` merge-back guard, concurrency=1 / worktree-unavailable fallback. Plus the A8 assertion (strict-sequential mode never invokes the new modules). **Preserve-every-invariant review checklist** (branch reviewer must confirm each survives): commit-integrity chain, chunk-learnings write-before-commit + partial-write recovery, resume detection, migration-collision check, mandatory-builder-dispatch rule, G1/G2 split (G1 scoped lint per chunk; typecheck+build deferred to G2).

**Verification commands (OAI-005 — self-check at this chunk):** `grep -F` that Step 6 contains each anchor: `strict-sequential`, wave loop, runtime independence gate, `isolation: "worktree"`, `git apply --3way`, serialised merge-back / ascending chunk-id, clean-branch precondition, post-commit `git status --porcelain` assertion, `git reset --hard` (crash-safety + hard cleanup), `INDEPENDENCE_VIOLATION` + sibling quarantine, worktree-unavailable fallback. Each must hit before commit. Branch reviewer (`pr-reviewer` + `spec-conformance`) additionally verifies invariant preservation.

**Acceptance criteria covered:** A7, A8 (structural + reasoned).

**Dependencies:** Chunks 1 and 2 (the helpers it references must exist + be contract-stable).

---

### Chunk 5 — Plan-review under-declared-files hunt target

**Spec sections:** §4 (under-declaration risk), §11 (supports A7's safety net).

```yaml
declared_files:
  - .claude/agents/claude-plan-review.md
  - .claude/agents/chatgpt-plan-review.md
depends_on: ["2"]
exclusive_resources: []
```

**Module shape (prose edit):**
- *Public interface:* both plan-review agents gain a hunt target: "any chunk whose `declared_files` looks under-specified relative to its `spec_sections` (a chunk that, by its stated scope, must touch a file it didn't declare — the under-declaration that would wrongly parallelise two chunks)."
- *What stays hidden:* the reviewers' existing finding pipeline, schema, and severity model — the new target is one added check, not a restructure.

**Edits:**
1. `claude-plan-review.md`: add the under-declared-`declared_files` hunt target to its hunt list; tie it to the existing risk-weighted sampling (any chunk touching migrations / shared singletons / many files is a priority sample). Emit findings in the existing result schema.
2. `chatgpt-plan-review.md`: mirror the same hunt target in the ChatGPT plan-review prompt/criteria so both tiers catch it.

**Contracts:** references the §3.1 field names (Chunk 2 vocabulary).

**Error handling:** n/a (advisory review prose).

**Test considerations:** deterministic grep — both files contain the `declared_files` under-declaration anchor. Verified at Chunk-6 doc-sync.

**Verification commands (OAI-005 — self-check at this chunk):** `grep -F` that both `claude-plan-review.md` and `chatgpt-plan-review.md` contain the under-declared-`declared_files` hunt-target anchor. Each must hit before commit.

**Acceptance criteria covered:** supports A7 (plan-time safety net for the metadata).

**Dependencies:** Chunk 2.

---

### Chunk 6 — Docs + doc-sync + ADR + version + builder note + manifest finalise

**Spec sections:** §13, §12 (rollout note in changelog), §6.1 (builder worktree awareness).

```yaml
declared_files:
  - docs/decisions/0007-parallel-worktree-builders.md
  - docs/decisions/README.md
  - .claude/CHANGELOG.md
  - .claude/FRAMEWORK_VERSION
  - .claude/agents/builder.md
  - docs/doc-sync.md
  - manifest.json
depends_on: ["1", "2", "3", "4", "5"]
exclusive_resources:
  - manifest.json
  - framework-version   # singleton: only one chunk may bump the version
```

**Module shape (docs/registration):**
- *Public interface:* ADR-0007, the version bump (2.23.0 → 2.24.0), the CHANGELOG entry, the manifest registration of ADR-0007, the builder.md awareness note.
- *What stays hidden:* nothing — finalisation bookkeeping.

**Edits:**
1. **`docs/decisions/0007-parallel-worktree-builders.md`** (new, from `_template.md`): Status `accepted`, Date 2026-06-19, Domain `build-orchestration`. **Decision:** "We will build provably-independent plan chunks concurrently, each in its own git worktree, and integrate them back to the feature branch serially in stable chunk-id order." **Context:** spec §1–§2; the sequential Step 6 loop; the two enabling primitives (worktree isolation + concurrent dispatch). **Consequences:** positive (wall-clock cut on large builds); negative (under-declared `declared_files` is the primary risk — mitigated by 4-layer defence); neutral (web sessions degrade to sequential). **Safety argument (required by §13):** independence is *proven* (disjoint declared files + no edge + no shared exclusive resource), never assumed; conservative-default serialises on doubt; the **default mode is strict-sequential — the new machinery is unreachable without an explicit opt-in** (A8 by non-execution, not by behavioural coincidence); integration is **diff-apply, not `git merge`** (builders never commit), serialised as a **transaction** in ascending chunk-id order with a clean-branch precondition; a crash between apply and commit is recovered by treating any dirty feature branch on resume as an interrupted merge-back (reset + re-run), preserving the commit-integrity chain + linear history; an apply conflict → hard cleanup + sequential re-apply, never force-apply; file-path disjointness is proven on **canonicalised, case-folded paths** (Windows-safe — `src\Foo.ts` ≡ `./src/foo.ts`), normalised in one place (`parsePlanMetadata`); and once any independence claim is falsified at merge-back, the wave's remaining unintegrated sibling worktrees are **quarantined** (discarded + re-run sequentially), never trusted as stale. **Alternatives considered:** `git merge` of a worktree branch (rejected — builders never commit, nothing to merge); first-finished-first-merged order (rejected — non-deterministic resume + history); a wave loop that always runs at cap=1 (rejected — fails byte-identical A8; strict-sequential gating chosen instead); wave logic in coordinator prose (rejected — untestable; extracted to `computeWaves`). **When to revisit:** if under-declaration repeatedly slips past plan-review + the dispatch gate to merge-back. ADR-0014 referenced (coordinator must stay inline).
2. **`docs/decisions/README.md`**: add the ADR-0007 row to the Index table AND edit the reservation note (currently "Start your project's local ADRs at 0007 to preserve the gap as a marker.") to **0008** — this framework-canonical ADR consumes 0007, so the consuming-project reservation must move to 0008 in the SAME chunk or every consuming repo inherits contradictory guidance (a framework 0007 plus advice to start local ADRs at 0007). Both edits land here; `declared_files` already includes `docs/decisions/README.md`. (Resolves F2 / decision D.)
3. **`.claude/CHANGELOG.md`**: Added entry for 2.24.0 — parallel worktree builders, the two new pure modules, the metadata fields, the rollout phrase, the opt-in-first-3-builds rollout.
4. **`.claude/FRAMEWORK_VERSION`**: `2.23.0` → `2.24.0`. **Also bump `manifest.json` `frameworkVersion`** (currently `2.20.0`, pre-existing drift) → `2.24.0` in the same chunk, so the two version signals agree. (Resolves F1 — no conditional: bump both to 2.24.0.)
5. **`.claude/agents/builder.md`**: minor — add the §6.1 awareness note: "You may run inside an isolated git worktree; operate on the working tree you are given. No behavioural change — you still never commit, run scoped G1 on your touched files, and report `Files changed`."
6. **`docs/doc-sync.md`**: add a trigger row if warranted — "When the build-loop orchestration or chunk-metadata format changes → update architect.md, feature-coordinator.md, the plan-review agents, and ADR." *Open decision: § 6 decision E.*
7. **`manifest.json`**: register ADR-0007 mirroring the existing ADR rows:
   ```json
   { "path": "docs/decisions/0007-*.md", "category": "adr", "mode": "sync", "substituteAt": "never" }
   ```
   (The two helper modules + two tests are registered by Chunks 1 and 2; Chunk 6 only adds the ADR row. Verify no double-registration.)

**Contracts:** none (docs).

**Error handling:** n/a.

**Test considerations:** deterministic — ADR exists + validates against `_template.md` headings; README index updated; `FRAMEWORK_VERSION` == 2.24.0; CHANGELOG has the 2.24.0 entry; `manifest.json` parses as valid JSON and contains ADR-0007 + both helper-script + both helper-script-test entries (A9). The **consuming-repo CI** runs lint + typecheck on the two pure modules post-sync (the canonical A9 "lint + typecheck pass on computeWaves.ts and the validator").

**Verification commands:** `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"` to confirm `manifest.json` is valid JSON after all three chunks' edits land (cheap, runnable locally, no config). No lint/typecheck locally (no config — consuming-repo CI owns it).

**Acceptance criteria covered:** A9 (doc-sync + ADR present; version bumped; lint+typecheck deferred to consuming-repo CI per § 1.5).

**Dependencies:** all of Chunks 1–5 (documents + version-stamps the finished change; registers the ADR last so the index reflects accepted state).

## 4. Build parallelism

Dogfooding the scheduler on THIS plan's own six chunks, using each chunk's metadata block from § 3.

**Dependency edges:** 3→2, 4→{1,2}, 5→2, 6→{1,2,3,4,5}. Chunks 1, 2 have no edges.

**Exclusive resources:** Chunks 1, 2, 6 all declare `manifest.json`. Chunk 6 also declares `framework-version`.

**File overlaps:** none beyond the `manifest.json` exclusive-resource overlap (every chunk's agent/script file set is otherwise disjoint).

**Topological layers (by `depends_on`):**
- Layer 0: {1, 2}
- Layer 1: {3, 4, 5} (all deps in layer 0)
- Layer 2: {6}

**Wave splitting within layers (cap = 3; exclusive-resource + file disjointness):**

| Wave | Chunks | Why split here |
|------|--------|----------------|
| **Wave 1** | **{1}** | 1 and 2 both claim `manifest.json` (exclusive resource) → cannot co-schedule. Stable id order puts 1 first. |
| **Wave 2** | **{2}** | 2 serialised after 1 by the `manifest.json` exclusive-resource clash (reason `exclusive-resource`, conflictsWith 1). |
| **Wave 3** | **{3, 4, 5}** | Layer 1; pairwise file-disjoint (architect.md / feature-coordinator.md / {claude-plan-review.md, chatgpt-plan-review.md}); no shared exclusive resource; ≤ cap 3 → one parallel wave of 3. |
| **Wave 4** | **{6}** | Layer 2; depends on all; lone chunk. |

**Result: 4 waves.** The real parallelism win is **Wave 3** — chunks 3, 4, 5 build concurrently in separate worktrees. Chunks 1 and 2, which a naive reading would parallelise, are correctly serialised by the `manifest.json` exclusive-resource model. This demonstrates the spec's core safety property (the A3/A4 analogue) on the plan itself: a shared singleton registry file forces serialisation even though the chunks' *primary* files differ.

**`serialisedReasons` this plan would emit:** `{chunkId:'2', reason:'exclusive-resource', conflictsWith:'1'}`, `{chunkId:'6', reason:'dependency'}`.

**Executor note — bootstrap ordering.** The scheduler does not exist until Chunk 1 merges, so THIS plan is built with the OLD sequential coordinator. The waves above are advisory; the safe sequential order is **1, 2, 3, 4, 5, 6** (a valid topological linearisation). Build it sequentially. Once Chunk 4 lands, this plan is a good first real test case for the scheduler — but per §12.5 the first 3 builds are opt-in via the rollout phrase.

## 5. Risks and mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Under-declared `declared_files`** (architect omits a file two chunks share → wrongly parallelised) | High — the core correctness risk | 4-layer defence: conservative architect default → plan-review hunt target (Chunk 5) → dispatch-time independence gate (§5.2) → merge-back guard (3-way patch-apply conflict OR commit-integrity failure) → sequential re-apply + `INDEPENDENCE_VIOLATION` log. Never force-apply. |
| **New files not registered in `manifest.json`** → never propagate to consuming repos | High (silent) | Manifest registration is explicit chunk work (Chunks 1, 2, 6); Chunk 6 verification parses `manifest.json` + asserts all four new entries + ADR row present. |
| **No local typecheck/lint** → type errors in pure modules ship to consuming CI | Medium | Vitest unit tests run locally via `npx vitest run` (catches logic + most type misuse at runtime); consuming-repo CI runs the authoritative lint+typecheck post-sync (A9). Keep the modules small + pure to minimise surface. |
| **A8 regression** (parallel rewrite subtly changes single-chunk behaviour) | High | Structural guarantee: single-chunk waves call the unchanged inner routine — one code path, not a `cap==1` branch. Scheduler test proves 1-per-wave at cap=1. Branch reviewer runs the preserve-every-invariant checklist. |
| **Worktree unavailable (web session)** silently breaking a build | Medium | §8 fallback: probe `isolation: "worktree"` before first parallel dispatch; on failure set concurrency=1 + log. No build fails for lack of parallelism. Confirm-on-first-run (§12.2). |
| **Coordinator nested as sub-agent** (future change) breaks dispatch | Low but fatal if it happens | ADR-0007 + Step 6 callout: coordinator must run inline (top-level `Agent` access); ADR-0014 cross-referenced. |
| **Resume non-determinism** (different waves on resume → re-runs committed chunks) | Medium | `computeWaves` is deterministic (stable id sort, A5); per-chunk resume detection (commit exists?) applies per chunk regardless of wave. |
| **`architecture.md` / `CLAUDE.md` edits cannot land here** → consuming-repo docs drift | Medium | Out of scope for this branch (doNotTouch + absent here); flagged as downstream consuming-repo follow-up. § 6 decision A. |

## 6. Open decisions for plan-gate

**A. `architecture.md` / `CLAUDE.md` scope split (REQUIRES OPERATOR DECISION).** Spec §13 lists edits to `architecture.md` (build-pipeline / Phase 2 description) and `CLAUDE.md` (build-lifecycle "Construction" row gains a parallel note). **Both are in `manifest.json` `doNotTouch` and do NOT exist in this framework repo** — consuming-repo-owned. They CANNOT be edited on this framework branch. **Recommendation:** land all framework-canonical edits here (the 6 chunks), and open a **separate downstream task in the consuming app repo** to make the `architecture.md` + `CLAUDE.md` edits after this framework version is synced in. Confirm: ship framework branch now + file the consuming-repo doc follow-up as a tracked item? (Blocking this branch on consuming-repo docs would couple two repos' release cadence — not recommended.)

**B. `computeWaves` / validator test runner (DECISION — cross-branch precedent now known).** This repo has no tsconfig; existing tests are split — three helper-script tests use `node:test` + `npx tsx`, one (`chatgpt-reviewPure.test.ts`) uses Vitest (run via `npx vitest run`, self-downloading). Two options:
- **(B1) Vitest** — matches the simultaneously-landing framework build's pure module (operator-supplied screenshot: "capture-surfacePure.ts — Vitest-tested there") and the global "Runner is Vitest" rule. Both new `scripts/build-scheduler/` modules would use the same runner as the sibling new module landing this release. Run via `npx vitest run scripts/build-scheduler/`.
- **(B2) `node:test` + `npx tsx`** — matches the three existing `scripts/__tests__/*.test.ts` helper tests; zero-config; what the architect originally proposed.

**RESOLVED at plan-gate → B1 (Vitest).** Operator confirmed Vitest for cross-branch consistency with the simultaneously-landing framework build's pure module and the framework-wide "Runner is Vitest" rule. Both `scripts/build-scheduler/` test files use Vitest (`describe`/`it`/`expect`), run via `npx vitest run`. §1.5 and Chunk 1/2 verification commands updated accordingly.

**C. Default concurrency cap (CONFIRM — spec §12.1 says 3).** Cap defaults to **3** builders, operator-overridable at the plan-gate (1 = fully sequential). Confirm 3, or set a different default. Bounds resource use + merge-back queue length; 1 is always safe.

**D. ADR number 0007 (CONFIRM).** `docs/decisions/README.md` says "projects start their LOCAL ADRs at 0007 to preserve the numbering gap." This ADR is **framework-canonical** (ships with the framework, registered in `manifest.json` like 0001/0002/0005/0006), so it should take the next framework number — which is **0007**, colliding with that guidance. **Recommendation:** use **0007** for this framework-canonical ADR and update the README note to say "projects start their local ADRs at 0008." Confirm 0007 + README adjustment, or pick a different number.

**E. New doc-sync trigger (CONFIRM — minor).** Whether `docs/doc-sync.md` needs a NEW explicit trigger row ("build-loop orchestration / chunk-metadata format change → update architect + feature-coordinator + plan-review agents + ADR") or whether the existing agent-edit trigger already covers these files. **Recommendation:** add the explicit row — the metadata format spans four agent files + an ADR, exactly the multi-file coupling doc-sync exists to catch. Low stakes either way.

**F. Rollout phrase wording (CONFIRM — spec §12.5).** Parallel path is opt-in for the first 3 builds via an operator phrase. Spec suggests `launch feature coordinator parallel`. Confirm that phrase (it parallels the existing `launch bugfixer <N> parallel` ChatGPT-mode phrase, so it is consistent) or choose another.

## 7. Acceptance criteria coverage map

| AC | Covered by | Verification |
|----|-----------|--------------|
| A1 | Chunk 1 | unit test (one wave of 3) |
| A2 | Chunk 1 | unit test (3 waves of 1) |
| A3 | Chunk 1 | unit test (same-file → 2 waves of 1) |
| A4 | Chunk 1 | unit test (shared migration prefix → serialised) |
| A5 | Chunk 1 | unit test (deterministic, deep-equal across runs) |
| A6 | Chunk 2 | unit test (validator rejects missing `declared_files`) |
| A7 | Chunk 4 (+ 3, 5) | grep anchors in `feature-coordinator.md` for all 6 required terms |
| A8 | Chunk 4 | structural (single-chunk wave == inner routine) + Chunk 1 scheduler 1-per-wave test |
| A9 | Chunk 6 | ADR present, version bumped, doc-sync updated, manifest valid JSON; lint+typecheck on the two modules run in consuming-repo CI post-sync |

## 8. G2 / end-of-construction (consuming-repo CI)

There is no local G2 in this repo (no lint/typecheck/build config). The canonical G2 — `npm run lint` + `npm run typecheck` on `computeWaves.ts` and `validatePlanMetadata.ts` — runs in the **consuming repo's CI after this framework version is synced in**. The local end-of-construction check here is limited to: the Vitest unit-test runs `npx vitest run scripts/build-scheduler/` (Chunks 1, 2 — runner resolved to Vitest per decision B/F4) and the `manifest.json` JSON-validity parse (Chunk 6). Branch review (`spec-conformance` → `pr-reviewer`, plus `dual-reviewer`) runs on the integrated framework branch. `adversarial-reviewer` is correctly NOT triggered (no schema / RLS / tenant-data surface — spec §13; record the GRADED skip in `progress.md`).
