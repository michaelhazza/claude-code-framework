# Spec: Parallel Worktree Builders for Independent Chunks

**Status:** DRAFT (iteration 1 decisions applied; see §12)
**Date:** 2026-06-18
**Target:** Claude framework (canonical coordinator + architect + builder contracts), authored from `automation-v1`
**Classification:** Major (changes the core build-loop orchestration; cross-cutting concern across architect, feature-coordinator, builder)
**Build branch (intended):** dedicated branch, separate from the grounded-mockups feature

## Table of contents

1. Problem and motivation
2. Goals and non-goals
3. Domain model — chunk dependency graph and independence
4. Architect changes — emit the dependency graph
5. The wave scheduler
6. Worktree execution model
7. Merge-back and commit-integrity
8. Failure modes
9. Integration boundaries
10. Chunk plan
11. Acceptance criteria
12. Open questions (for iteration)
13. Framework, versioning, and doc-sync impact

---

## 1. Problem and motivation

`feature-coordinator` Step 6 builds chunks strictly sequentially: "Do not start chunk N+1 until chunk N is committed and its TodoWrite item is marked complete." The cost lever today is *model* (each chunk dispatched to a Sonnet `builder` sub-agent), not *parallelism*. On a Major build with many chunks, total wall-clock time is the sum of every chunk's build time plus its per-chunk lint and commit, in series, even when chunks have nothing to do with each other.

Many chunks genuinely *are* independent: they touch disjoint file sets, share no types, and have no ordering dependency (e.g. "add page A", "add unrelated service B", "add docs C"). Building those in series is pure latency with no safety benefit.

The AI Website Cloner pattern that motivated this spec runs builders in parallel, each in its own git worktree, merging back independently — a foreman handing each section's spec to a builder and moving on while it builds. We already have the two enabling primitives:

- The harness supports per-agent **worktree isolation** (`isolation: "worktree"` on the Agent dispatch), which gives a builder its own working copy on a temporary branch, auto-cleaned if unchanged.
- The harness supports **concurrent agent dispatch** (multiple Agent calls in a single message run in parallel), and `feature-coordinator` runs *inline in the main session*, so it has top-level `Agent` access and is not blocked by the ADR-0014 "sub-agents cannot dispatch sub-agents" rule.

So the capability exists; the playbook simply doesn't use it. This spec adds a **parallel lane for independent chunks only**, with sequential fallback for everything else. It is a latency optimisation with a hard safety boundary, not a rewrite of the build loop's guarantees.

**Why safety-first matters here.** The sequential loop's correctness rests on assumptions that parallelism breaks if applied naively: a single clean working tree, the `plan-declared ⊇ builder-reported ⊇ working-tree` commit-integrity chain, migration-number uniqueness, and one linear commit history. Parallelism is only sound for chunks that provably cannot interfere. The whole design centres on *proving* independence before parallelising, and falling back to sequential whenever proof is absent.

## 2. Goals and non-goals

### Goals

- **G1.** Build provably-independent chunks concurrently, each in its own git worktree, merging each back to the feature branch independently — cutting wall-clock time on large builds.
- **G2.** Never parallelise chunks that could interfere. Independence must be *proven* (disjoint declared files, no dependency edge, no shared exclusive resource such as a migration number) before two chunks run concurrently. Absent proof, run sequentially.
- **G3.** Preserve every existing safety guarantee: per-chunk G1, the commit-integrity invariant, G2 integrated-state gate, migration-collision detection, doc-sync, and the branch-level review pass run exactly as today on the merged-back result.
- **G4.** Degrade to today's behaviour transparently. A plan with no declared independence, or an environment without worktree support, runs fully sequentially with a logged note. No build is *worse* off than today.
- **G5.** Make the parallel decision auditable: which chunks ran in which wave, concurrency used, merge order, and any conflict fallbacks recorded in `progress.md`.

### Non-goals

- **NG1.** Not parallelising the *review* pass. Reviewers (spec-conformance, pr-reviewer, dual-reviewer) run once on the integrated branch state, sequentially, unchanged.
- **NG2.** Not parallelising across builds or across phases. Scope is the chunk loop of a single Phase 2 build.
- **NG3.** Not changing the model story. Builders still run on Sonnet; this changes scheduling, not models.
- **NG4.** Not auto-merging conflicting work. On any merge-back conflict that isn't trivially resolvable, the chunk falls back to sequential re-application; the coordinator never force-merges.
- **NG5.** Not introducing distributed/remote execution. Worktrees are local to the session's repo clone.
- **NG6.** Not relaxing the "builder dispatch is mandatory; coordinator never writes chunk code inline" rule. Parallel builders are still `builder` sub-agents.

## 3. Domain model — chunk dependency graph and independence

### 3.1 Chunk metadata (extends today's plan format)

Today each chunk already declares `spec_sections:` and a file list. This spec adds two fields per chunk:

- **`declared_files:`** — the exhaustive set of files the chunk will create or modify. This already exists implicitly (the commit-integrity invariant relies on it); the spec makes it a required, explicit, machine-readable field.
- **`depends_on:`** — the list of chunk IDs that must complete before this chunk can start. Empty means no ordering dependency.

Optionally:

- **`exclusive_resources:`** — named non-file resources the chunk consumes exclusively, the prime example being a migration number/prefix. Two chunks claiming a migration prefix are never independent even if their files differ.

### 3.2 Independence relation

Two chunks A and B are **independent** (safe to run concurrently) iff ALL hold:

1. **No dependency edge.** A ∉ `depends_on(B)` and B ∉ `depends_on(A)`, transitively.
2. **Disjoint declared files.** `declared_files(A) ∩ declared_files(B) = ∅`.
3. **Disjoint exclusive resources.** No shared migration prefix or other named exclusive resource.
4. **No shared append-only artifact write contention** beyond coordinator-owned files the coordinator serialises itself (e.g. `chunk-learnings.md`, `progress.md` are written by the coordinator after merge-back, not by parallel builders — see §7).

If any condition is unprovable from the plan metadata, the chunks are treated as dependent (conservative default). Independence is a *proven* property, never an assumed one.

### 3.3 Waves

A **wave** is a maximal set of mutually-independent chunks whose dependencies are all already satisfied. Waves are computed by topological layering of the dependency graph, then splitting any layer so that no two chunks within a wave share files or exclusive resources. Waves run in order; chunks *within* a wave run concurrently up to a concurrency cap. A fully-dependent plan degenerates to one chunk per wave — i.e. today's sequential behaviour, for free.

## 4. Architect changes — emit the dependency graph

`architect` already decomposes a spec into chunks with `spec_sections:` and file contracts. It gains responsibility for emitting the §3.1 metadata so the scheduler can compute waves:

- Every chunk MUST carry an explicit `declared_files:` list (exhaustive create/modify set) and a `depends_on:` list (possibly empty).
- Where a chunk consumes a migration prefix or other exclusive resource, it MUST carry `exclusive_resources:`.
- `architect` adds a `## Build parallelism` section to `plan.md` summarising the computed waves and the rationale (which chunks are independent and why), so the operator sees the parallel plan at the plan-gate.
- **Correctness obligation:** `architect`'s file declarations must be exhaustive. An under-declared file set is the primary risk (two chunks that actually touch the same file but didn't declare it would be wrongly parallelised). The plan-review pass (`claude-plan-review`, `chatgpt-plan-review`) gains a hunt target: "any chunk whose `declared_files` looks under-specified relative to its `spec_sections`." The merge-back guard (§7) is the runtime backstop if a declaration was wrong.

Conservative-by-default: if `architect` is unsure whether two chunks are independent, it adds a `depends_on` edge to serialise them. The scheduler only parallelises what the plan explicitly proves independent.

## 5. The wave scheduler

Replaces the linear "for each chunk in order" loop in `feature-coordinator` Step 6 with a wave loop. The scheduler logic is extracted into a testable pure helper (`scripts/build-scheduler/computeWaves.ts`) so wave computation is unit-tested, not buried in the playbook prose.

### 5.1 Wave computation

Input: the chunk list with `depends_on`, `declared_files`, `exclusive_resources`. Output: an ordered list of waves, each a set of chunk IDs. Algorithm: topological layering by `depends_on`; within each layer, greedily group chunks that are pairwise file- and resource-disjoint into the same wave, spilling conflicting chunks into a later sub-wave. Deterministic ordering (stable sort by chunk ID) so reruns and resumes produce identical waves — this matters for the resume-detection path.

### 5.2 The independence gate (runtime re-verification)

Before dispatching a wave, the coordinator re-verifies independence at runtime, not trusting the precomputed wave blindly:

- Recompute file-set intersection across the wave's chunks from their `declared_files`. Any non-empty intersection → pull the offending chunk out of the wave into a later sequential slot, log it.
- Run the existing migration-number collision check across the wave's chunks (reuse the Step 2 collision detection logic) → any collision → serialise.

This is belt-and-suspenders over §4: even if the plan metadata is wrong, the gate catches declared overlaps before they run concurrently. (Undeclared overlaps are caught later, at merge-back, §7.)

### 5.3 Concurrency cap

A configurable max concurrency (default proposed: 3 builders at once; see Open Questions). The cap bounds resource use and keeps the merge-back queue manageable. A wave larger than the cap runs in cap-sized batches. Concurrency of 1 reproduces today's sequential behaviour exactly and is the universal fallback.

## 6. Worktree execution model

### 6.1 Dispatch

For a wave of N independent chunks, the coordinator issues N `builder` dispatches in a single message (concurrent), each with `isolation: "worktree"` so each builder gets its own working copy on a temporary branch off the current feature-branch HEAD. Each builder receives the same inputs as today (plan path, chunk name, declared-files list) and runs its normal Steps 0–5 including per-chunk G1 (scoped lint + targeted pure-function tests) *inside its own worktree*.

Single-chunk waves are dispatched exactly as today (no worktree needed for a wave of one — the optimisation is a no-op there, preserving the current path).

### 6.2 Per-worktree G1

G1 is unchanged in content but now runs inside each builder's isolated worktree against only that chunk's touched files. Because worktrees are file-isolated, two builders' lint runs cannot interfere. The coordinator's backup lint (today's re-run of scoped lint) happens at merge-back per chunk (§7), not across the still-isolated worktrees.

### 6.3 What does NOT move into the worktree

- **Commits.** Builders never commit (unchanged hard rule). The coordinator commits at merge-back, on the feature branch, preserving the one-commit-per-chunk history and message format.
- **typecheck / build.** Still deferred to G2 on the integrated branch, exactly as today. Worktrees do not each run typecheck.
- **Coordinator-owned files.** `progress.md`, `chunk-learnings.md`, `handoff.md`, `current-focus.md`, `.phase` are written by the coordinator on the feature branch, never inside a builder worktree. This avoids N builders racing to append to the same learnings file.

### 6.4 Resume semantics

Deterministic wave computation (§5.1) means a resumed build recomputes identical waves. The existing per-chunk resume detection (is there a commit for this chunk's files?) is applied per chunk regardless of which wave it was in. A chunk already committed is skipped; an uncommitted chunk in a partially-completed wave is re-dispatched. Worktrees are ephemeral, so a crashed build leaves no half-merged state on the feature branch — only fully merged-back chunks have commits.

## 7. Merge-back and commit-integrity

Merge-back is serialised even when builds are parallel. Builders run concurrently; their results are integrated back to the feature branch one at a time, in a deterministic order (stable by chunk ID). This keeps the commit history linear and one-commit-per-chunk, and keeps the commit-integrity invariant intact.

For each completed builder in a wave, in order:

1. **Collect the builder's result** (SUCCESS / PLAN_GAP / G1_FAILED) and its reported `Files changed` list from its worktree.
2. **Commit-integrity check (unchanged semantics, applied to the worktree diff).** Verify `plan-declared ⊇ builder-reported ⊇ worktree-changed`. Any file outside the declared set → hard fail for that chunk (same rule as today).
3. **Merge the worktree branch into the feature branch.** Because the wave was proven file-disjoint (§5.2), a clean merge is expected.
4. **Merge-back guard (the runtime backstop for under-declared files).** If the merge reports a conflict, the plan's independence claim was wrong (two chunks touched the same file without declaring it). The coordinator does NOT force-merge. It aborts that chunk's merge, **falls the conflicting chunk back to sequential re-application** on top of the now-updated feature branch (re-dispatch builder against the merged state), and logs an `INDEPENDENCE_VIOLATION` note naming the two chunks and the file, so the plan metadata can be corrected. The first chunk of the pair still merges cleanly; only the late conflicting one is re-run.
5. **Coordinator-owned writes on the feature branch:** write the chunk-learnings entry, run the backup scoped lint, `git add` only the declared files plus `chunk-learnings.md`, commit with the standard per-chunk message, push, update `progress.md`, mark TodoWrite complete.
6. **Clean up the worktree** (auto-cleaned if unchanged; explicitly removed after merge).

After every wave completes merge-back, proceed to the next wave (its `depends_on` are now satisfied on the feature branch). After the final wave, G2 runs on the integrated branch state exactly as today.

The net effect: parallel *construction*, serialised *integration*. The feature branch only ever sees clean, one-at-a-time, fully-checked chunk commits, identical in shape to today's output.

## 8. Failure modes

- **Worktree unsupported in the environment.** If `isolation: "worktree"` is unavailable or git worktree fails, the scheduler sets concurrency to 1 and runs fully sequentially, logging `parallelism: disabled — worktree unavailable`. No build fails for lack of parallelism.
- **One builder in a wave fails (G1_FAILED / PLAN_GAP).** The other builders in the wave are unaffected (file-isolated). A `PLAN_GAP` routes back to architect as today (the wave pauses; sibling chunks that already succeeded still merge back first). A `G1_FAILED` re-dispatches that single chunk's builder; the wave's other chunks merge independently.
- **Merge-back conflict (under-declared files).** Handled by §7 step 4: conflicting chunk falls back to sequential re-application; `INDEPENDENCE_VIOLATION` logged. Never force-merged.
- **Migration collision discovered at runtime.** The independence gate (§5.2) serialises migration-claiming chunks before dispatch; if one still slips through, merge-back's collision recheck catches it and serialises. Migration chunks are conservatively never co-scheduled.
- **Partial wave + crash/resume.** Ephemeral worktrees mean no half-state on the feature branch. Resume recomputes identical waves (§5.1) and skips already-committed chunks (§6.4).
- **Concurrency cap exhaustion / resource pressure.** Cap bounds it; lowering the cap (to 1) is always safe and always correct.

Escalation paths reuse the existing Step 6 failure ladder (plan-gap rounds ≤2, G1 attempts ≤3) per chunk, unchanged — they now apply per chunk within a wave rather than strictly in series.

## 9. Integration boundaries

- **`feature-coordinator.md` Step 6** is the primary edit: the linear loop becomes the wave loop. Steps 0–5 (context, sync, architect, plan-review, plan-gate) and Steps 7–12 (G2, review pass, doc-sync, handoff) are unchanged. The plan-gate now also surfaces the `## Build parallelism` summary to the operator.
- **`architect.md`** gains the dependency-graph emission responsibility (§4).
- **`builder.md`** is essentially unchanged — it already runs scoped per-chunk and never commits. The only addition is awareness that it may run inside an isolated worktree (no behavioural change for the builder; it just operates on the working tree it's given).
- **`claude-plan-review` / `chatgpt-plan-review`** gain the "under-declared `declared_files`" hunt target (§4).
- **ADR-0014 (no nested sub-agent dispatch)** is respected: the coordinator runs inline in the main session and dispatches builders concurrently from there. This must be called out so no future change tries to run the coordinator itself as a sub-agent (which would break both the sequential and parallel loops identically).
- **`computeWaves.ts`** is the one new pure module, unit-tested. The rest is playbook prose edits.
- **No app code, no schema, no RLS surface.** This is build-tooling orchestration only.

## 10. Chunk plan

Architecture-level; `architect` produces the detailed plan in Phase 2. (This plan is itself a candidate for the parallel treatment it describes, once landed.)

- **Chunk 1 — `computeWaves.ts` pure scheduler + tests.** Topological layering + file/resource-disjoint grouping + deterministic ordering. Targeted unit tests covering: fully-independent plan (one wave), fully-dependent plan (N waves of 1), mixed, file-overlap split, migration-resource split.
- **Chunk 2 — Plan metadata contract.** `declared_files` / `depends_on` / `exclusive_resources` fields; a validator that rejects a plan missing required fields; the `## Build parallelism` summary format.
- **Chunk 3 — `architect.md` edits.** Emit the metadata + parallelism summary; conservative-default rule.
- **Chunk 4 — `feature-coordinator.md` Step 6 rewrite.** Wave loop, independence gate, concurrent dispatch, serialised merge-back, merge-back guard, resume semantics, failure ladder per chunk. Concurrency cap config.
- **Chunk 5 — Plan-review hunt target.** `claude-plan-review.md` + `chatgpt-plan-review.md` under-declared-files target.
- **Chunk 6 — Docs + doc-sync + ADR.** `architecture.md` (build pipeline), `.claude/CHANGELOG.md`, framework version, `docs/doc-sync.md` if a new trigger, and an ADR: "Parallel worktree builders for independent chunks; serialised merge-back."

Dependencies: Chunk 1 and 2 are independent of each other (scheduler vs contract) but both precede 4. Chunk 3 depends on 2. Chunk 4 depends on 1+2. Chunk 5 depends on 2. Chunk 6 depends on all.

## 11. Acceptance criteria

Verifiable assertions:

- **A1.** `computeWaves` on a plan of 3 chunks with no `depends_on` and disjoint files returns one wave of 3. (Unit test.)
- **A2.** `computeWaves` on a fully-chained plan (each depends on the prior) returns 3 waves of 1 — i.e. today's sequential order. (Unit test.)
- **A3.** `computeWaves` on 2 chunks declaring the same file returns 2 waves of 1, never one wave of 2. (Unit test — the core safety property.)
- **A4.** `computeWaves` on 2 chunks sharing a migration prefix returns them serialised. (Unit test.)
- **A5.** Wave computation is deterministic: same input → identical waves across runs (stable ordering). (Unit test.)
- **A6.** The plan validator rejects a plan with a chunk missing `declared_files`. (Unit test.)
- **A7.** `feature-coordinator.md` Step 6 documents: wave loop, runtime independence gate, concurrent builder dispatch with `isolation: "worktree"`, serialised merge-back, the `INDEPENDENCE_VIOLATION` merge-back guard, and concurrency=1 fallback. (Deterministic: grep the agent file for each anchor.)
- **A8.** A concurrency cap of 1 produces byte-identical orchestration behaviour to today's sequential loop (regression safety). (Reasoned assertion + scheduler test showing 1-per-wave dispatch.)
- **A9.** Doc-sync + ADR present; framework version bumped; `lint` + `typecheck` pass on `computeWaves.ts` and the validator. (Deterministic.)

## 12. Decisions (iteration 1, operator-confirmed)

All iteration-1 open questions resolved per recommendation. These are now binding for the plan.

1. **Default concurrency cap: 3, operator-overridable at the plan-gate.** The plan-gate presents the computed waves and the cap; the operator may raise or lower it (1 = fully sequential) before replying `proceed`.
2. **Execution-surface availability (confirmed via Claude Code docs).** Worktree isolation is supported on the CLI and Desktop app (including Windows with Git for Windows) and is reachable from the VS Code extension via its integrated-terminal CLI path. It is **not** available in Claude Code on the web (managed ephemeral container). Therefore: parallel builds run on the operator's Windows VS Code / Desktop / CLI; web sessions degrade to sequential (concurrency = 1) via the §8 fallback. This is acceptable and is the designed behaviour, not a defect. **Confirm-on-first-run:** the first local parallel build should verify `isolation: "worktree"` actually provisions a worktree in the target environment before relying on it; until then, treat web-vs-local availability as the documented assumption above.
3. **Architect independence stance: conservative default plus active marking of obvious-independent chunks.** Architect serialises whenever unsure (adds a `depends_on` edge), but it does actively mark clearly-disjoint chunks as independent rather than defaulting everything to sequential. It does not chase maximum parallelism at the cost of safety.
4. **Merge-back order: stable-by-chunk-ID (deterministic).** Chosen for clean resume and a linear, auditable history over the marginal latency of first-finished-first-merged.
5. **Rollout: opt-in for the first 3 builds, then default-on.** Ship behind an operator phrase (e.g. `launch feature coordinator parallel`) for the first 3 real builds to gain confidence, then flip the default to on (sequential remains reachable via concurrency = 1).
6. **`exclusive_resources`: model migration prefixes from day one; extend as discovered.** Migrations are modelled immediately. During planning, architect surveys for other singletons (shared codegen outputs, singleton registry files, lockfiles) and models any it finds as exclusive resources; the field is open-ended so new resource classes need no schema change.

## 13. Framework, versioning, and doc-sync impact

- **Framework-canonical files edited:** `.claude/agents/feature-coordinator.md`, `.claude/agents/architect.md`, `.claude/agents/builder.md` (minor), `.claude/agents/claude-plan-review.md`, `.claude/agents/chatgpt-plan-review.md`. Authored here; land in the `claude-code-framework` submodule per its sync protocol.
- **New files:** `scripts/build-scheduler/computeWaves.ts` + tests, the plan-metadata validator.
- **Docs:** `architecture.md` (build pipeline / Phase 2 description), `.claude/CHANGELOG.md`, framework version bump, `docs/doc-sync.md` (if a new trigger), `CLAUDE.md` build-lifecycle table (the "Construction" row gains a parallel note).
- **ADR (required):** this is a durable orchestration decision with rationale — "Parallel worktree builders for proven-independent chunks; serialised merge-back preserves commit integrity." Include the safety argument (independence is proven, not assumed) and the conservative-default stance.
- **No schema, no migration, no RLS, no tenant-data surface.** `adversarial-reviewer` not triggered (record the GRADED skip). The risk here is *orchestration correctness*, which the `computeWaves` unit tests and the merge-back guard cover.
- **Relationship to the grounded-mockups spec:** independent feature, separate branch. The only touch point is that the mockups spec's Chunk plan is written to be wave-friendly (its §7 chunk-dependency note), so it makes a good first real test case for this scheduler once both land.
