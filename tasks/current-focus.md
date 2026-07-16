# Current Focus

**Status:** NONE

**Slug:** —
**Branch:** —
**Spec:** —

> Update this file when starting a new sprint, spec, or active feature branch. Status field is read by `context-pack-loader` to auto-pick a context pack.
>
> Allowed status values:
> - `NONE` — no active feature.
> - `PLANNING` — spec phase. Coordinator: `spec-coordinator`.
> - `BUILDING` — implementation phase. Coordinator: `feature-coordinator`.
> - `REVIEWING` — branch-level review pass.
> - `MERGE_READY` — all gates green; PR awaiting merge.
> - `MERGED` — landed; sprint closing out.

## Notes

No active feature. The previous entry (v2.33.0 compound-learning suite, status BUILDING) was stale: that build merged in c34bb95 (PR #35) and its `tasks/builds/compound-learning-suite/` directory has since been cleaned up; the framework is now at v2.42.0. Reset 2026-07-16 by the AI-setup audit (item A) — this file is injected into every session by the memory-digest hook and drives context-pack selection, so keep its Status current.
