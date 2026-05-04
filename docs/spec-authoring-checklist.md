# Spec Authoring Checklist

This file is the **pre-authoring checklist** for any non-trivial spec in this repo. It exists because `spec-reviewer` kept catching the same eight categories of problem across 15+ different specs — all of which are cheaper to prevent at authoring time than to fix in a review iteration.

Use it when drafting any **Significant** or **Major** spec (per the task classification in `CLAUDE.md`). It is *not* required for trivial doc updates, ADRs, or single-page clarifications.

> **What this checklist is not.** It is not a replacement for the rules in `architecture.md`, `CLAUDE.md`, or `docs/spec-context.md`. It is a pre-flight checklist that *points at* those rules so the author applies them while writing. When in doubt, the deep references win.
>
> **What this checklist is.** It is the minimum set of authoring decisions that, if missed, force `spec-reviewer` to catch them post-hoc. Every item below has been caught by the reviewer in a production spec.

---

## Table of contents

0. Verify present state (before you write)
1. Existing primitives search (before you write)
2. File inventory lock
3. Contracts section (mandatory)
4. Permissions / RLS checklist
5. Execution model (sync/async, inline/queued, cached/dynamic)
6. Phase sequencing (dependency graph)
7. Deferred items section (mandatory, even if empty)
8. Self-consistency pass (last step before review)
9. Testing posture sanity check
10. Execution-safety contracts (new writes and state machines)
11. Spec frontmatter (status header convention)

Appendix — Pre-review checklist summary

---

## Section 0 — Verify present state (before you write)

Before authoring any spec that draws from deferred items in `tasks/todo.md` (or from a prior mini-spec), run a present-state verification pass on each cited item. **Do not assume the deferred item is still open.**

### Why this matters

Surrounding work routinely closes deferred items between mini-spec authoring and spec drafting. On the pre-launch hardening sprint, a mini-spec claimed 60 open RLS gaps; verification found 2 — migration 0227 had already closed the other 58. Without the verification step the spec would have re-litigated 58 already-fixed items, consuming review cycles and producing invalid scope.

### The verification pass

For each cited deferred item:

1. Does the file / migration / column / function the item references still exist?
2. Is the gap still present, or has surrounding work closed it?
3. Record one of:
   - `verified open: <evidence>` — the gap exists in the current codebase
   - `verified closed by <commit-sha or migration number>` — the gap is gone

Record the findings in a verification log (e.g. `tasks/builds/<slug>/verification-log.md`) so the spec reviewer has evidence, not assertions.

### When to apply

Any spec that begins with "address items from `tasks/todo.md`" or "implement deferred work from mini-spec X." Not needed for greenfield specs that introduce genuinely new behaviour with no prior deferred items.

### Reviewer signal this prevents

"This spec re-specifies items already closed by migration N" — caught at the start of the pre-launch hardening sprint Chunk 1 verification pass. The larger the gap between mini-spec authoring and spec drafting, the higher the risk.

---

## Section 1 — Existing primitives search (before you write)

Before you propose a new table, endpoint, service, or pattern, search the codebase for the closest existing primitive. If one exists, either:

- **Reuse it**, and state that explicitly in the spec, or
- **Extend it** (new column, new arg, new variant), and state why a new primitive would have been wrong, or
- **Invent a new primitive**, and state in one paragraph *why reuse and extension were both insufficient*.

The "invent new" path is the expensive one. Choosing it without justification is the single most common directional finding in the review corpus.

### Searches to run

| Proposing… | Grep | Then check |
|---|---|---|
| A new table | `server/db/schema/**/*.ts` for similar columns or naming | `rlsProtectedTables.ts` to see how neighbouring tables are scoped |
| A new route | `server/routes/**/*.ts` for similar list/get/update shapes | existing permission guards on neighbouring routes |
| A new service | `server/services/**/*.ts` for similar responsibilities | whether an existing `*ServicePure.ts` already exports the logic |
| A new job | `server/jobs/**/*.ts` + `server/jobs/index.ts` | whether an existing job can take a new payload variant |
| A new skill | `server/skills/**/*.md` + `server/config/actionRegistry.ts` | whether the skill is a thin variant of an existing one |
| A new prompt partition or cache tier | the prompt assembly in `agentExecutionServicePure.ts` | which partition the new content genuinely belongs in |
| A new feature flag | `docs/spec-context.md` (`feature_flags: only_for_behaviour_modes`) | whether this is a *behaviour mode* (shadow vs active, dev vs prod) or a rollout gate (the latter is directional and almost always wrong here) |

### Reference

- `docs/spec-context.md` → `accepted_primitives` block. Any primitive listed there is the preferred extension point for its category.
- `architecture.md` → "Key files per domain" table. Start-here file for every common task.

### Reviewer signal this prevents

"You invented a new X, but the codebase already has a similar X — should you reuse it or are these genuinely different?" — caught on ClientPulse-GHL, session-1-foundation, skill-analyzer-v2, and others.

---

## Section 2 — File inventory lock

Every non-trivial spec has a "Files to change" table (usually `§3`, `§4`, or `§11` depending on the spec's template). This table is the **single source of truth** for what the spec touches.

### The rule

Every time you add a prose reference to a new file, column, migration, table, service, or endpoint, **cascade the reference into the inventory in the same edit**. No exceptions, even for "minor" additions — that's the path by which inventory drift gets introduced.

### Consistency pass (before sending to reviewer)

Grep your draft for the following phrases and verify each occurrence is reflected in the file inventory:

- `new table` / `new column` / `new migration`
- `new service` / `new endpoint` / `new route`
- `new job` / `new skill`
- `new hook` / `new middleware`
- `new partition` / `new cache tier`

If any prose reference is missing from the inventory, the reviewer will raise a `file-inventory-drift` finding.

### Reviewer signal this prevents

"File X is referenced in §5 but not in the Files-to-change table" — caught on agent-intelligence, canonical-data-platform, improvements-roadmap, memory-and-briefings, onboarding-playbooks (migration numbers especially).

---

## Section 3 — Contracts section (mandatory)

For every data shape that crosses a service boundary or is consumed by a parser, write a **Contracts** subsection. Do not describe the behaviour in prose without pinning the shape.

### Required fields per contract

- **Name** (e.g. `GEO_SCORE_PAYLOAD`, `agentProposals`, `ConfigQuestion`)
- **Type** (JSON / Drizzle enum / JSONB column / TypeScript union / Postgres composite)
- **Example instance** (one concrete, valid example — not pseudocode)
- **Nullability and defaults** (which fields can be null, what the default is when absent)
- **Producer** (which service/handler/job writes this)
- **Consumer** (which service/parser/UI reads this)

### Why the example matters

A contract without a worked example is ambiguous at the boundary the parser cares about. Example: "score is a number between 0 and 100" does not say whether missing dimensions produce `null`, `0`, or a skipped key — and the parser has to make a choice either way. Pin it in the spec, not in the implementation.

### Source-of-truth precedence (mandatory when multiple representations exist)

If the spec introduces behaviour where the same fact is represented in more than one place (execution record, step status, JSONB artefact, audit log, in-memory state), declare the source-of-truth precedence explicitly:

- Which representation wins when two representations disagree?
- What is the correct read path? (e.g. "execution record > artefact JSONB > log entry")

Add this as a named subsection in the spec's Contracts block, not as a prose aside. If the precedence is implicit, the implementation will make inconsistent choices and the inconsistency is invisible until it manifests as a concurrency bug under load.

### Reviewer signal this prevents

"X is processed by Y but the payload shape is never defined" — caught on geo-seo, skill-analyzer-v2, improvements-roadmap, robust-scraping, memory-and-briefings.

"Multiple representations of the same fact, no declared winner" — caught during the pre-launch hardening cross-spec consistency sweep (Phase 5/6 alignment on execution record vs artefact precedence).

---

## Section 4 — Permissions / RLS checklist

Every new tenant-scoped table (anything with `organisation_id` or `subaccount_id`) must have all four of the following. If any is absent, document *why* inline in the spec — do not leave it implicit.

### The four requirements

1. **RLS policy** in the same migration that creates the table. See `architecture.md §1155 "Row-Level Security — Three-Layer Fail-Closed Data Isolation"` for the three-layer model and the exact policy shape.
2. **Entry in `server/config/rlsProtectedTables.ts`** — this is the manifest that `verify-rls-coverage.sh` enforces. Missing entry = CI gate failure.
3. **Route-level or middleware guard** if the table is accessed via HTTP. Name the guard in the spec (`authenticate`, `requirePermission(key)`, `resolveSubaccount`, or a new guard with a named location).
4. **Principal-scoped context** if the table is read from an agent execution path. See `architecture.md §1116 "P3B — Principal-scoped RLS"`.

### Opt-out rule

If a new table is intentionally *not* tenant-scoped (e.g. system-wide reference data), write one line explaining why. The reviewer's rubric correctly flags "missing RLS on org-scoped table" and won't be satisfied by implicit reasoning.

### Reviewer signal this prevents

"RLS claimed needed but migration doesn't include policies" / "Endpoint unguarded" / "Access control stated in Goals but not enforced in routes or migrations" — caught on ClientPulse, config-agent-guidelines (multiple rounds), canonical-data-platform, memory-and-briefings.

---

## Section 5 — Execution model (sync/async, inline/queued, cached/dynamic)

If your spec introduces behaviour that crosses a transactional or latency boundary, pick one execution model *explicitly* and keep the rest of the spec consistent with it.

### The three choices

- **Inline / synchronous** — caller blocks on the operation. Use when the result must be available before the caller returns. Example: prompt assembly during an agent run. Do NOT add a pg-boss job row for inline operations.
- **Queued / asynchronous (pg-boss)** — durable, survives restarts, retryable. Use when the operation is decoupled from the caller. Do NOT describe this as "the service does X" in prose — a job processor does X, and the spec should say so.
- **Cached / prompt-partition** — for LLM prompt sections that stay constant for a full request lifecycle. If you claim "stablePrefix", the partition table and the assembly code must both agree. A prompt partition in `dynamicSuffix` with a stated goal of 40–60% cache efficiency is a self-contradicting spec.

### Consistency pass

After writing the execution-model decision, check:

1. Does the job idempotency table include a row for this operation? (Queued only.)
2. Does the route/service prose describe a *synchronous call* or an *enqueue*? Match that to the model above.
3. Does any non-functional goal (cache efficiency, latency budget) contradict the model?

### Reviewer signal this prevents

"Bulk dispatch marked inline but job row exists" / "Briefing in dynamicSuffix vs 40-60% cache efficiency" / "Sync postCall vs async job row" — caught on agent-intelligence, improvements-roadmap.

---

## Section 6 — Phase sequencing (dependency graph)

If your spec has phases, do one explicit pass over the dependency graph *before* sending to review.

### The three failure modes

1. **Backward dependency.** Phase N references a column/table/service that's created in Phase N+k. Fix: move the prerequisite earlier, or move the dependent later, or merge phases.
2. **Orphaned deferral.** A section says "X is deferred to Phase N+1" but Phase N+1 doesn't list X. Either add it to Phase N+1 or move it to the Deferred Items section (see Section 7).
3. **Phase-boundary contradiction.** A phase claims "no migrations" but is assigned a table-creation migration. Usually means the item's phase was changed in one section but not the other.

### How to check

For each phase, list (inline in a scratch note, not in the spec):

- Schema changes introduced: <migration numbers>
- Services introduced: <names>
- Services modified: <names>
- Jobs introduced: <names>
- Columns referenced by code: <column names>

Then for every "referenced by code" column, confirm it's in an equal-or-earlier phase's "schema changes introduced" line.

### Reviewer signal this prevents

"Phase N depends on column X but X ships in Phase N+k" — caught on agent-intelligence, canonical-data-platform, improvements-roadmap, memory-and-briefings.

---

## Section 7 — Deferred items section (mandatory, even if empty)

Every spec has an explicit `## Deferred Items` section listing features/migrations/criteria mentioned in prose but intentionally deferred.

### The rule

Any time prose in the spec uses the words "deferred", "later", "Phase N+1 will", "not in this phase", "future", or "nice to have", the thing being deferred must appear in the Deferred Items section. The section is the single source of truth — prose mentions without a corresponding Deferred entry are treated as in-scope deliverables by readers.

### Format

```markdown
## Deferred Items

- **Name of deferred feature.** Phase N will ship [the small thing]. Phase N+1 will ship [the larger thing]. Reason: <one line>.
- **Another deferred feature.** <same shape>.
```

Empty is fine — if nothing is deferred, write "None." rather than omitting the section, so future readers know the author considered deferrals.

### Reviewer signal this prevents

"S14 described as standalone in §5.10 but marked deferred in Q6" / "Deferred items scattered through prose and inferred rather than listed" — caught on memory-and-briefings, geo-seo.

---

## Section 8 — Self-consistency pass (last step before review)

After completing Sections 1–7, do one final read-through focused on contradictions between sections. This is the cheapest pass to run and the highest-value pass to skip.

### Questions to answer

- Do the **Goals / Philosophy** sections match the **Implementation** sections? (The #1 directional finding — 35% of specs.)
- Does every phase item have an explicit verdict (BUILD IN PHASE N, DEFER, WON'T DO)?
- Does every "single source of truth" claim survive? Grep for the claimed source — is it actually written to by every path the spec describes? Is it filtered out anywhere?
- Do non-functional claims (cache efficiency, latency budgets, cost budgets) match the execution model in Section 5?
- Does every phrase using "must", "guarantees", "idempotent", "source of truth" have a backing mechanism named? Load-bearing claims without a mechanism are the most expensive finding class to fix in review.

### Reviewer signal this prevents

"Goals say X but Implementation does Y" / "Load-bearing claim without enforcement" — caught on agent-intelligence, ClientPulse (multiple), geo-seo, improvements-roadmap.

---

## Section 9 — Testing posture sanity check

Before adding any test plan to the spec, re-read the testing-related sections of `docs/spec-context.md`:

```yaml
testing_posture: static_gates_primary
runtime_tests: pure_function_only
frontend_tests: none_for_now
api_contract_tests: none_for_now
e2e_tests_of_own_app: none_for_now
performance_baselines: defer_until_production
composition_tests: defer_until_stabilisation
```

If your spec's test plan proposes anything in the `none_for_now` or `defer_until_*` categories, either:

- Remove the test plan item, or
- Acknowledge it as a framing deviation in the spec's own Implementation philosophy section (not silently). The reviewer will flag this as directional either way, but flagging it yourself shortens the review loop.

### Reviewer signal this prevents

"Spec proposes E2E/frontend/API-contract tests against framing" — caught on onboarding-playbooks (D1, D2), routines-response.

---

## Section 10 — Execution-safety contracts (new writes and state machines)

Before sending any spec for review that introduces new write paths, state machine transitions, or externally-triggered operations, verify each of the following is pinned in the spec. These are routinely missing from first-draft specs and are the root cause of the most expensive post-ship bugs.

### 10.1 Idempotency posture

For every externally-triggered write, state one of:

- `key-based` — a unique key (e.g. `(artefactId, decision)`) guarantees exactly-once with a DB unique constraint. Name the key and the index.
- `state-based` — the write is guarded by an optimistic predicate (`UPDATE ... WHERE status = 'expected_pre_state'`). Name the predicate.
- `non-idempotent (intentional)` — the operation is inherently non-idempotent; state why and what the caller's retry contract is.

Do not describe an operation as "idempotent" without naming which of the three applies. "We'll handle retries" is not an idempotency posture.

### 10.2 Retry classification

For every write or external call, declare one of: `safe` (unconditionally retryable), `guarded` (retryable with an idempotency key or optimistic predicate), or `unsafe` (caller bears retry risk). Any `unsafe` operation must be wrapped by a `safe` or `guarded` boundary before the caller can retry it. Name the boundary.

### 10.3 Concurrency guard for racing writes

If two concurrent callers can race to write the same terminal state (e.g. two approve requests for the same decision, two job instances for the same org), the spec must declare the concurrency guard:

- Optimistic predicate: `UPDATE ... WHERE status = 'review_required'` → 0 rows affected = conflict
- Unique constraint: DB-level (`UNIQUE (artefact_id, decision)`) + catch `23505` → defined HTTP status
- First-commit-wins: the 0-rows-updated path returns the winning decision to the losing caller

Name the guard, the DB mechanism, and the losing-caller response. "The DB will handle it" is not a guard.

### 10.4 Terminal event guarantee

Every cross-flow chain that emits events must declare:

- Exactly one terminal event (the event that marks the logical run complete)
- Post-terminal prohibition — no further events with the same correlation key after the terminal
- The terminal event's `status` field: `success | partial | failed`

If the chain has multiple success paths or multiple error paths, each path gets exactly one terminal event — they are mutually exclusive.

### 10.5 No-silent-partial-success

Every flow that can partially complete must emit an explicit `status: 'partial'` terminal event (not `status: 'success'` with a silent partial-failure). Name the conditions under which `partial` fires vs `failed`.

### 10.6 Unique-constraint-to-HTTP mapping

For every DB unique constraint the spec introduces, pin the HTTP status returned to the caller when the constraint is violated. Never let a `23505 unique_violation` bubble as a 500 — map it to a named status (409, 422, or 200-idempotent-hit) and document which one and why.

### 10.7 State machine closure (if the spec introduces or modifies a state machine)

If the spec introduces or modifies a state machine (step transitions, run aggregation, approval boundaries, status enums), include a State/Lifecycle subsection that pins:

- Valid transitions (and which transitions are forbidden)
- What execution record must exist before a terminal state is written
- Whether the status set is closed (adding a new status value requires a spec amendment)

A spec that describes behaviour without pinning valid transitions and forbidden transitions will have its state machine diverge from implementation within two feature cycles.

### Reviewer signal this prevents

"No idempotency posture declared" / "What happens when two callers race here?" / "How does the caller know if this partially failed?" — all caught in the pre-launch hardening pre-implementation hardening pass (amendments v2–v5, Chunks 3, 4, 5). These gaps are architectural, not stylistic — they produce correctness bugs at production load.

---

## Section 11 — Spec frontmatter (status header convention)

Every non-trivial spec opens with a small frontmatter block so future archive sweeps can identify shipped/superseded specs without re-reading them.

### The required fields

```markdown
**Status:** draft | reviewing | accepted | shipped | superseded by <path-or-ADR>
**Spec date:** YYYY-MM-DD
**Last updated:** YYYY-MM-DD
**Author:** <handle>
**Build slug:** <slug> (or `n/a` for ADR-shaped specs without a build slug)
```

Status values:

- `draft` — being written; not yet sent to `spec-reviewer`.
- `reviewing` — sent to `spec-reviewer` / `chatgpt-spec-review`; not yet final.
- `accepted` — approved for build; either in flight or queued.
- `shipped` — feature has merged to main; spec is historical reference.
- `superseded by <path-or-ADR>` — replaced by a later spec or ADR. Include the path or ADR number so readers can find the successor.

### Why this matters

The 2026-05-03 docs/ archive triage found 84 specs in `docs/` and only 4 with explicit retirement markers. Without a uniform `Status:` header, the operator can't run a reliable archive sweep — every candidate has to be read end-to-end to judge whether it's still authoritative. With the header, archive becomes a one-line grep: "show me every spec with `Status: shipped` older than 90 days" → operator confirms successor links → archive.

### Maintenance rule

Update `Last updated:` whenever you edit the spec. Update `Status:` when the spec moves through its lifecycle:
- Sent to spec-reviewer → `Status: reviewing`
- Spec-reviewer returns READY_FOR_BUILD and operator accepts → `Status: accepted`
- Feature merges to main → `Status: shipped` (sweeper-friendly)
- Replaced by a successor → `Status: superseded by <path>`

### Reviewer signal this prevents

"Spec at `docs/<old-spec>.md` is still cited from architecture.md but the feature it specs has shipped and the implementation has drifted." With a `Status: shipped` marker on the old spec, the doc-sync sweep at finalisation flags the architecture.md citation for redirect to the implementation file, not the spec.

### Backfill

Existing specs without this frontmatter are NOT required to be updated retroactively — that's a separate, opt-in pass. New specs from 2026-05-03 forward MUST carry the frontmatter.

---

## Appendix — Pre-review checklist summary

Before invoking `spec-reviewer` on a draft spec, answer yes to all of the following:

- [ ] **[Section 0]** Every cited deferred item verified as still open (or annotated as `verified closed by <commit>`)
- [ ] Every new primitive has a "why not reuse" paragraph
- [ ] Every new file / column / migration / endpoint is in the file inventory
- [ ] Every data shape crossing a boundary has a Contracts entry with an example
- [ ] Every contract that writes to multiple representations declares the source-of-truth precedence
- [ ] Every new tenant-scoped table has RLS policy + manifest entry + route guard + principal-scoped context (or a documented reason for opting out)
- [ ] Execution model (sync/async, inline/queued, cached/dynamic) is picked explicitly and the prose + inventory + goals all agree
- [ ] Phase dependency graph has no backward references, no orphaned deferrals, no phase-boundary contradictions
- [ ] `## Deferred Items` section exists (even if "None.")
- [ ] Self-consistency pass complete: Goals ↔ Implementation match; every load-bearing claim has a named mechanism
- [ ] Testing plan consistent with `docs/spec-context.md`
- [ ] **[Section 10]** Every externally-triggered write has an idempotency posture, retry classification, and concurrency guard declared
- [ ] **[Section 10]** Every cross-flow chain has a declared terminal event + post-terminal prohibition
- [ ] **[Section 10]** Every DB unique constraint has a named HTTP mapping (no bubbled 500s from `23505`)
- [ ] **[Section 10]** If a state machine is introduced or modified: valid transitions, forbidden transitions, and status-set closure are declared
- [ ] **[Section 11]** Spec opens with `Status:` / `Spec date:` / `Last updated:` / `Author:` / `Build slug:` frontmatter

If every box is checked, the spec is ready for `spec-reviewer`. If any box is unchecked and you're intentionally leaving it so (e.g. deferring the contract to implementation), mark the deviation inline in the spec's framing section — don't leave it implicit.

---

## Maintenance

This checklist is built from patterns observed in `tasks/spec-review-checkpoint-*.md` across 15+ specs. When a new recurring pattern emerges across three or more specs, extend this checklist with a new section that points at the reviewer signal and the existing deep reference.

When a section of this checklist stops catching recurrent findings (i.e. the reviewer no longer raises that signal for specs authored against this checklist), leave the section in place — it is working. Do not remove "working" sections; only remove sections that turn out to be noisy or wrong.
