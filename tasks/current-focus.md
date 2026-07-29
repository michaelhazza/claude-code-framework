# Current Focus

**Status:** NONE

**Slug:** —
**Branch:** —
**Spec:** —

> Update this file when starting a new sprint, spec, or active feature branch. Status field is read by `context-pack-loader` to auto-pick a context pack.
>
> Allowed status values (`build-status.v2`, widened 6 -> 9 on 2026-07-29 — the
> canonical list is the `status` enum in `schemas/build-status.schema.json`, and
> `scripts/status/status-vocabulary.test.mjs` fails the build if this list drifts
> from it):
> - `NONE` — no active build. Pointer-only: never appears in a per-build `status.json`.
> - `SPECIFYING` — deciding what to build. Coordinator: `spec-coordinator`.
> - `PLANNING` — sizing the build plan, up to the operator plan gate. Coordinator: `feature-coordinator`.
> - `BUILDING` — implementation phase. Coordinator: `feature-coordinator`.
> - `REVIEWING` — branch-level review pass.
> - `TESTING` — Codex authors tests, runs the full suite, iterates to green.
> - `FINALISING` — external review, docs, learning, CI parity. Coordinator: `finalisation-coordinator`.
> - `MERGE_READY` — all gates green; PR awaiting merge.
> - `MERGED` — landed; sprint closing out.
> - `ABANDONED` — build stopped without merging.

## Notes

No active feature. The previous entry (v2.33.0 compound-learning suite, status BUILDING) was stale: that build merged in c34bb95 (PR #35) and its `tasks/builds/compound-learning-suite/` directory has since been cleaned up; the framework is now at v2.42.0. Reset 2026-07-16 by the AI-setup audit (item A) — this file is injected into every session by the memory-digest hook and drives context-pack selection, so keep its Status current.
