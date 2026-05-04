# Handoff — [BUILD_SLUG]

**Phase complete:** [SPEC | PLAN | BUILD | REVIEW | FINALISATION]
**Branch:** `[branch-name]`
**Build slug:** `[build-slug]`
**Author:** [session description, e.g. "single multi-round session, 2026-MM-DD"]
**Status:** [in flight | complete | superseded].

---

## Contents

1. Why this work happened
2. Decisions made this session
3. What was built
4. What was deferred (with reasoning)
5. Files inventory — modified + created + moved
6. Working tree state at handoff
7. Open questions for next session
8. Resume instructions

---

## 1. Why this work happened

[2-4 sentences. The problem this work addresses. Source of the request — operator brief, deferred item, audit finding, incident response.]

## 2. Decisions made this session

[List each durable decision. If architectural, link to the ADR you wrote. If tactical, list inline.]

- **<decision>** — chose X over Y because Z. ADR: `docs/decisions/NNNN-<slug>.md` (if applicable).

## 3. What was built

[List by surface. Be specific — file paths, function names, table names. Future sessions will grep this.]

### New files

- `path/to/file.ts` — one-line description.

### Modified files

- `path/to/file.ts` — one-line description of the change.

### New conventions

- [convention name]. Captured in [where].

## 4. What was deferred (with reasoning)

[Each item: short title, why deferred (risk / cost / scope), where it's queued (`tasks/todo.md` section name).]

- **<item>** — deferred because [reason]. Queued in `tasks/todo.md` § <section>.

## 5. Files inventory

[Output of `git status --short` at handoff time, plus any files outside the working tree that matter (e.g. generated artifacts).]

## 6. Working tree state at handoff

[Branch state, commit status, any uncommitted changes the operator should know about.]

## 7. Open questions for next session

[Genuine unknowns. If none, write "None blocking."]

## 8. Resume instructions

[Exact prompt the next session can paste to resume. Reference this file by path.]

```
You're picking up the [build-slug] work.
Read tasks/builds/[build-slug]/handoff.md in full.
Then [next concrete step].
```
