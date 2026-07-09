---
slug: compound-learning-suite
scope_class: Major
target_release: v2.33.0
bugs: []
ui_touch: false
created: 2026-07-09
---

# Intent — compound-learning-suite

## Problem Statement

Lessons and quality improvements in consuming repos do not compound. Three concrete leaks:

1. **Memory is honour-system.** CLAUDE.md §3 tells every session to review KNOWLEDGE.md at start, but nothing enforces or surfaces it. Sessions start cold; hard-won lessons in KNOWLEDGE.md, `tasks/lessons.md`, and the current sprint pointer sit unread. Consuming KNOWLEDGE.md files are 400KB+ (automation-v1: 464KB / 2974 lines), so "just read it" is not viable.
2. **Skills cannot accrue repo-specific lessons between releases.** Canonical skills sync with `mode: sync` (fully overwritten on framework update), so a consuming repo has nowhere to attach a repo-specific failure mode to a skill. Skill-shaped lessons pile up in KNOWLEDGE.md with no path back into the canonical skill.
3. **Prompt tuning has no answer key.** Consuming repos tune LLM prompts (review pipelines, judges) with no fixed expectations; "better" is a judgment call, so prompt changes ship on vibes and silently regress.

## Desired Outcome

Three shipped capabilities in the framework, deployed to every consuming repo on next `/claudeupdate`:

- **A — Session-start memory digest hook.** A new SessionStart hook injects a compact, hard-budgeted (~150 lines) digest of the most recent KNOWLEDGE.md entries, recent `tasks/lessons.md` entries, and the current-focus pointer. Fail-open, never blocks or slows session start, degrades silently when files are absent.
- **B — Local skill overlay.** An unmanaged `.claude/context/skill-context.md` (mirroring the ADR-0006 agent-context.md pattern) with `## <skill-name>` sections holding repo-specific addenda. Sync never touches it. A greppable pointer line is added to skills so a session knows to consult it. A documented write protocol keeps KNOWLEDGE.md as the master log while mirroring skill-shaped lessons into the overlay same-day. A defined quarterly drain promotes overlay entries into canonical skills upstream (marking, not deleting). framework-doctor gains checks for overlay integrity.
- **C — Golden-set prompt eval runner.** A generic `/eval-prompts` command-skill plus a runner script that reads a repo-local suite (`eval/<suite>/cases.jsonl` + `eval/<suite>/config.json`), runs each case through the named target prompt, scores catch rate and false-alarm rate against a last-accepted baseline, and fails on regression beyond a configurable threshold. Framework ships the runner + format spec + a framework-doctor manifest-validity check; each consuming repo owns its cases.

All three land in one release (v2.33.0) with version bump, CHANGELOG entry, migration, and consumer migration notes per `/release`.

## Non-Goals

- Not seeding any consuming repo's actual content: no real KNOWLEDGE digest data, no populated `skill-context.md`, no eval `cases.jsonl` ships from the framework. The framework ships mechanism + templates + docs only; repos own their data (consistent with `doNotTouch: tasks/**` and the adopt-only pattern).
- Not wiring automation-v1's parallel-mode Step 7 prompt-evolution into the eval runner, and not seeding eval cases from `tasks/review-mining` — those are consumer-side follow-ups after the framework release lands.
- Not changing how canonical skills themselves are authored or synced (`mode: sync` stays); the overlay is strictly additive sidecar.
- Not building a scheduler/cron for the memory hook or the quarterly drain — cadence stays operator/`/cleanfiles`-driven.
- Not a UI change of any kind (framework repo has no UI).
- Not retrofitting existing KNOWLEDGE.md entries into overlays or eval cases.

## Affected Capability Area

Framework subsystems (the framework has no live capabilities register — only `docs/capabilities-template.md`): **Hooks** (Feature A — new SessionStart hook), **Skills + context-overlay convention** (Feature B — new unmanaged overlay, skill pointers, promotion protocol, doctor checks), **Review pipeline / scripts + Commands** (Feature C — eval runner script, `/eval-prompts` command-skill, doctor check). Cross-cutting: **Sync engine / manifest** (all three add managed files), **Release plumbing** (version, CHANGELOG, migration).

## User / Operator Impact

Operators of consuming repos get: (A) every session opens with the last lessons and current focus already in front of the model, no manual reminder; (B) a durable place to record "this skill bit us this way in THIS repo" that survives framework updates and eventually flows upstream; (C) a gate that turns "did this prompt change help or hurt?" from a guess into a pass/fail number. No breaking change to existing workflows — all three are additive. Operators must run `/claudeupdate` to receive them, and per-repo value requires the operator to populate `skill-context.md` and author eval cases (mechanism ships empty).

## Risk Surface

None. (No values from the Risk Surface canonical vocabulary apply: the framework repo touches no server DB schema, routes, auth/permission services, RLS, webhooks, billing, external messaging, agent runtime, or approvals. The nearest risk is the SessionStart hook's performance/fail-open behaviour and sync-engine correctness — addressed as engineering-correctness concerns in the spec's execution-safety section, not tenant/security risk.)

## Assumptions

- Consuming repos vary in which of KNOWLEDGE.md / `tasks/lessons.md` / `tasks/current-focus.md` exist; the hook must handle every combination including none present. (verified — automation-v1 has all three; framework repo self-hosts none.)
- KNOWLEDGE.md is append-only newest-LAST (read tail); `tasks/lessons.md` is newest-FIRST at the top of its `## Lessons` section with a static format template at the file tail (read head, skip template). (verified via grounding.)
- The overlay must be a sidecar file, not an edit to SKILL.md, because skills are `mode: sync` and would clobber inline addenda. (verified.)
- The "quarterly promotion flow (knowledge-to-framework-skills-map)" named in the brief does not yet exist — it is greenfield and this build defines it. (verified — only a hypothetical mention in `cleanfiles.md:30`.)
- framework-doctor is a pure-markdown command with no backing script; new checks are added as markdown steps. (verified.)
- Review mode for this build's spec/plan reviews resolves to `automated` (session-state file). (verified.)

## Open Questions

- **A budget shape:** the brief says "full content of current-focus.md," but automation-v1's current-focus.md is 132KB / 450 lines (a huge mission-control HTML comment block) — that alone blows the 150-line budget. Resolve in spec: inject the prose body only (strip the leading HTML comment block), within an overall line cap. (technical — resolved in spec, not operator-facing.)
- **B overlay deployment mode:** adopt-only template (ships one seeded empty file) vs fully unmanaged (framework never seeds; doctor lists it). Lean unmanaged to match `agents/extensions/` precedent and keep the framework from writing a file the repo may not want. (technical — resolved in spec.)
- **C provider abstraction:** how many providers must the runner support at v1 (OpenAI only, matching the existing review driver, vs a pluggable interface)? Lean OpenAI-first with a thin provider seam. (technical — resolved in spec.)
- Operator-facing: none outstanding — the operator delegated split/scope ("one release or split, your call") and all remaining questions are implementation choices resolvable from the codebase.

## Duplication / Strategy Check

| Output | Value |
|---|---|
| Duplication assessment | clear |
| Strategic fit | clear |
| Recommendation | proceed |

Notes: Framework has no live Asset Register (`docs/capabilities.md`) — only `docs/capabilities-template.md`; per spec-coordinator Step 3a contract, register comparison skipped, Strategic fit treated as `clear`, duplication check ran against in-flight builds only. In-flight scan of `tasks/builds/*` found no non-merged spec overlapping this intent (only `_example` and this build's own directory). Cross-repo prior art: automation-v1 `.claude/project-registries.json sibling_repos[]` is empty → cross-repo-scout sub-step skipped silently. All three features are additive framework capabilities with no existing equivalent (grounding confirmed: no session-start memory hook, no skill overlay convention, no eval harness exist today).

## Grill-me Q&A / architecture decisions (Step 3b)

The brief is exhaustive on scope, failure modes, and operator surfaces, so no interactive grill loop was needed. Three architecture-shaping decisions (one a factual correction to the brief) were surfaced to the operator 2026-07-09; recommendations accepted:

1. **Feature B promotion drain** — the brief's "extend the quarterly promotion flow (knowledge-to-framework-skills-map)" assumed an existing flow; grounding proved it greenfield. **Decision: Protocol doc + /cleanfiles wiring.** Define the overlay→canonical-skill drain protocol AND wire it into the existing `/cleanfiles` quarterly sweep so drained entries are auto-detected and marked `promoted in vX.Y.Z` (not deleted). Fuller build surface, most faithful to intent.
2. **Feature B overlay deployment** — **Decision: adopt-only seeded template.** Framework ships `.claude/context/skill-context.md` once via manifest `mode: adopt-only` (exactly like agent-context.md, ADR-0006); consumer then owns it, sync never clobbers. Every repo gets a starter file with the section format on next `/claudeupdate`.
3. **Feature C provider scope** — **Decision: OpenAI-first + thin provider seam.** Reuse the existing review driver's key-loading + call pattern for OpenAI, behind a minimal provider interface; `config.json` names the provider so a second can be added later without reworking the runner.

**Model-switch seam (operator directive 2026-07-09):** draft the spec on Fable, present for operator feedback, then STOP. Review tiers (claude-spec-review / spec-reviewer / chatgpt-spec-review), plan, and build run AFTER operator feedback on a fresh Opus session resuming from these artifacts.
