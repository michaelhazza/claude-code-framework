---
name: spec-hygiene
description: Use when authoring or editing a spec or implementation plan, when applying review findings to one, and when verifying an implementation against its spec. Covers grounding claims in the real codebase, keeping multi-section documents self-consistent, and the conformance checks that catch the recurring implementation-vs-spec gaps.
---

# Spec and plan hygiene

The two dominant failure modes: specs that describe a codebase that doesn't exist, and documents that contradict themselves after edits. Both mislead builders more than no spec would.

## Ground every claim in the real tree

- Before referencing any file, column, route, tab, or helper: grep the live codebase. Specs are routinely authored aspirationally; if a referenced field doesn't exist, add it, route around it with a real fallback, or defer the feature — never hardcode null "to match the spec".
- Never hand-write counts, caller lists, or line ranges — regenerate from an anchored grep (`^import ... from`) at authoring time and state the command used. Substring greps inflate counts with comments and strings; a "25 call sites" claim that is really 16 misleads every downstream reader.
- Name paths/identifiers verified against the tree, or mark them proposed-new. At build time, grep every spec-named identifier: create it at the named location or record the rename as an explicit deviation — never silently relocate.
- Verify tooling assumptions (module system, npm scripts, test runner) rather than presuming; match the repo's existing harness patterns rather than inventing new ones.
- Cite wire-truth (live code, actual schema), not the brief's citations — brief references drift between brief-lock and spec-authoring; live source wins.

## Keep the document self-consistent

- After ANY edit changing a load-bearing value (count, enum list, migration number, section cross-reference, contract shape), immediately grep the whole document for the old value — such values always appear in goals, acceptance criteria, invariants, and inventories, and each missed copy costs a review round.
- After a mid-review directional decision (semantics flip, contract change), run a propagation pass over every section describing the same semantic from a different angle (goals, success criteria, non-goals, audit checks).
- Each repeated topic (file lists, state machines, testing posture) appears once authoritatively with pointers, or the copies are verified to agree. Every state transition mentioned in prose must be legal in the state-machine section.
- Resolved open questions are replaced with pointers to the resolution, not left verbatim.
- Chunk plans: no chunk consumes a file, type, or primitive introduced by a later chunk; no two chunks edit the same shared file without an explicit ordering edge; "do X first" is meaningless unless encoded in the dependency structure.

## Contract-level rules that prevent build drift

- State uniqueness invariants first-class (invariant → enforcing constraint → downstream ON CONFLICT consumers), never introduced only as backing for upsert wording.
- Every closed enum gets a single source-of-truth; conformance diffs the spec's member list against code value-by-value (count and names). Never reference a state without defining it in the enum table.
- Every "fall back to default X" rule pins: storage location of the default, lookup interface with null semantics, behaviour when absent/invalid/cross-tenant, and the configuration UX — unpinned defaults make sibling builders invent divergent implementations.
- Enumerate guards/preflight checks as numbered, individually-verifiable items with typed rejection reasons; at build time verify each check has a code path that can fire (grep the reason strings). An override flag whose underlying check doesn't exist is an automatic red flag.
- Spec-named events, audit rows, and log codes are first-class requirements with named emit sites; verification greps each literal and requires a producer.
- Migration chunks: separate "build the script" from "run the script" — readers accept both formats first, writers switch + script runs in the same chunk. Ask of every chunk boundary: "do persisted artifacts and live writers agree on format here?"
- Data mirrored from a polled external provider: absence from an incremental poll is NOT deletion; tombstoning requires a full-reconciliation pass or webhook semantics. A false tombstone hides live records.
- Multiple ingest paths into one canonical table (poll, webhook, manual, import) must each satisfy the same FK/CHECK contracts; a fix in one path is incomplete until symmetric paths are patched in the same commit.
- Two-concern columns stay separate: "can this be used" (gate) and "has it been verified" (audit signal) as one merged state creates dead-ends with no exit.
- Kill-switched migrations need agreeing fallback at BOTH the suppression layer and the dispatch layer, or there's a valley of failure between flag-on and fully-rolled-out, invisible in single-tenant dev.
- Diagnostic/test-send paths are a separate contract from production dispatch: map each production gate (approval, safety checks, rate limits, audit) to applies/bypassed/discriminated explicitly.
- Route via declarative capability rules, not hardcoded per-target if-statements in the orchestrator; platform-wide invariants live in the architecture doc, and any spec special-casing one agent/mode against a universal primitive is suspect.

## Conformance verification (implementation vs spec)

Checks that catch the recurring gap classes, in order of yield:

1. **Unwired artifact**: for every spec-named artifact, verify a production consumer on the execution path (see the wire-it-through skill) — the #1 gap across all builds.
2. **Absent/relocated artifact**: grep every spec-named identifier.
3. **Enum drift**: member-by-member diff.
4. **Pinned-literal drift**: extract every literal the spec pins (intervals, caps, defaults, precision) into a checklist and diff verbatim — fully mechanical.
5. **Missing guards/emissions**: grep the numbered checks' reason strings and event names.
6. **Doc-sync**: a reference-doc section added in the build must use the same vocabulary as the spec and code it describes.
7. Verify literal value-class conformance, not just type conformance: a `string[]` of titles where the spec pins run-ids typechecks and is wrong; expect doc drift to accompany implementation drift.
8. A conformance log outlives its spec: re-read the spec (including remediation notes) for each item before drafting fixes from an old log. The spec after build-time amendment is the single source of truth over plans and stale logs.
