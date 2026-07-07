# Spec — [BUILD_SLUG]

**Status:** [draft | reviewed | finalised]
**Date:** [YYYY-MM-DD]
**Author:** [session description]
**Scope class:** [Trivial | Standard | Significant | Major]
**Source branch:** `[branch-name]`

> Canonical location: `tasks/builds/{slug}/spec.md`. The whole pipeline keys on this path — feature-coordinator's spec-conformance gate, finalisation-coordinator's auto-resolve table, and spec-coordinator's Step 3a duplication scan. If your repo authors specs elsewhere, keep this file as a stub that links to the real spec.

## Lifecycle Declaration

*(Standard+ only — authoritative template in `spec-coordinator.md` Step 6.)*

| Field | Value |
|---|---|
| Capability cluster | [cluster(s) from `docs/capabilities.md`] |
| Capability owner | [handle, or `TBD — <role>`] |
| Lifecycle state on launch | [Inception \| Growth] |
| Risk surface | [`None.` or values from intent.md § Risk Surface] |
| Review cadence | [quarterly \| biannually \| on-incident-only] |

## Goals

[Verifiable assertions, not aspirations. Each goal should be checkable by a test, log, or deterministic inspection.]

## Non-goals

[Locked out-of-scope items so future sessions don't drift into them.]

## Framing assumptions

[Per `docs/spec-context.md` — the assumptions reviewers inherit.]

## File inventory lock

[Every file, column, and migration this build touches. Feature-coordinator's commit-integrity invariant enforces `plan-declared ⊇ builder-reported ⊇ working-tree` against this inventory via plan.md.]

## Contracts

[Data shapes crossing service boundaries, with examples.]

## Execution model

[sync/async, inline/queued, cached/dynamic.]

## ABCd Lifecycle Estimate

*(Standard+ only. Sizing is exactly S, M, or L — numeric estimates prohibited.)*

| Dimension | Sizing | Notes |
|---|---|---|
| Acquire | S \| M \| L | [dominant cost driver] |
| Build | S \| M \| L | [dominant cost driver] |
| Carry | S \| M \| L | [dominant cost driver] |
| decommission | S \| M \| L | [dominant cost driver] |

## Testing posture statement

[Per `docs/spec-context.md` and `references/test-gate-policy.md`.]

## Deferred items

[Mandatory, even if "None."]

## Open questions

[Genuine unknowns. If none, write "None — proceed."]
