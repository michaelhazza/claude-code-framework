# Current Focus

**Status:** BUILDING

**Slug:** compound-learning-suite
**Branch:** feat/v2.33.0-compound-learning
**Spec:** tasks/builds/compound-learning-suite/spec.md (ACCEPTED v0.4)

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

v2.33.0 compound-learning suite (A memory-digest hook, B skill overlay, C eval runner). Phase 1 SPEC complete on Fable — spec ACCEPTED (approved for plan by external review, 3 rounds). Handoff written. **Model-switch seam:** Phase 2 (plan → build → release → PR) runs on Opus in a fresh session on this branch. Internal review tiers (claude-spec-review / spec-reviewer / chatgpt-spec-review, mode automated) deferred to that session. Resume state: tasks/builds/compound-learning-suite/handoff.md + progress.md.
