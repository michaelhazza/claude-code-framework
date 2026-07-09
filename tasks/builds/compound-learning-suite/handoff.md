# Handoff — compound-learning-suite

**Phase complete:** SPEC
**Next phase:** BUILD (run `feature-coordinator` in a new session — ON OPUS per operator model-switch directive)
**Spec path:** tasks/builds/compound-learning-suite/spec.md (status ACCEPTED, v0.4)
**Repo:** claude-code-framework (this submodule checkout at `.claude-framework/`; NOT the automation-v1 consuming repo)
**Branch:** feat/v2.33.0-compound-learning
**Build slug:** compound-learning-suite
**Target release:** v2.33.0 (one release, one PR to michaelhazza/claude-code-framework)
**UI-touching:** no
**Mockup paths:** n/a
**Capture manifest:** n/a
**Behaviour manifest:** n/a

## Review status

**Spec review path taken:** external operator-relayed review (3 rounds — 10 + 5 + 4 findings, all accepted after review-triage adjudication and patched). Verdict: **approved for plan**.
**Internal review tiers NOT yet run** (deferred to the Opus session by operator directive): `claude-spec-review`, `spec-reviewer` (Codex), `chatgpt-spec-review` (mode `automated` per `.claude/session-state/review-mode`). The Opus session may run these before the plan, or proceed straight to the architect plan given the external review already cleared the spec — operator's call at resume.

## Model-switch seam

Phase 1 authored on Fable. Per operator directive (2026-07-09), the model switches to **Opus** for Phase 2 (plan) + build + release + PR. A running session cannot change its own model — resume by starting a fresh Opus session on this branch. All artifacts are on disk and committed; no re-grounding needed.

## What Phase 2 builds (from spec § File inventory lock)

- **Feature A** — `.claude/hooks/memory-digest.js` + `.test.js`; register in manifest + settings.json (SessionStart, `timeout: 5`); README/SECURITY rows.
- **Feature B** — `.claude/context/skill-context.md` (adopt-only template); pointer line into all 20 `SKILL.md`; `references/skill-overlay-convention.md`; `/cleanfiles` drain wiring; framework-doctor Checks 6+7; executable pointer-coverage check in `validate-framework.js`; CONTRIBUTING + doc-sync.
- **Feature C** — `scripts/eval-prompts.ts` + `scripts/eval-promptsPure.ts` + `scripts/__tests__/eval-promptsPure.test.ts`; `.claude/commands/eval-prompts.md`; `references/eval-suite-format.md`; framework-doctor Check 8.
- **Release** — `v2.33.0` bump (`FRAMEWORK_VERSION` + `manifest.frameworkVersion` + CHANGELOG heading, one commit); `migrations/v2.33.0.js` (adopts the one adopt-only file) + `tests/migrations.test.ts`; manifest +6 managedFiles entries; README hooks 9→10 / commands 7→8.

## Verification bar before PR (spec § Testing posture)

`npm test` (sync + scripts + hooks) + `npm run validate` green. Hook test hand-rolled spawnSync style; eval pure test in vitest; migration test fresh/idempotent/pristine.

## Decisions made in Phase 1

- One release (v2.33.0), one PR — operator delegated; scope confirmed by external reviewer across 3 rounds.
- Feature B promotion drain: protocol doc + `/cleanfiles` wiring (greenfield — the "quarterly promotion flow" the brief referenced did not exist).
- Feature B overlay: adopt-only seeded template (ADR-0006 pattern).
- Feature C provider: OpenAI-first behind a thin `runPrompt(messages,{model})` seam; strict JSON-verdict default normalizer (no fuzzy heuristic).
- Mapping doc `tasks/knowledge-to-framework-skills-map.md`: consumer-created by `/cleanfiles`, NOT shipped.
- All hook reads byte-bounded (KNOWLEDGE 32KB tail, current-focus + lessons 256KB); doctor checks Node-based (Windows-safe).

## Open questions for Phase 2

- none blocking. Deferred items (post-release, consumer-side): seed eval cases from automation-v1 `tasks/review-mining`; wire `/eval-prompts` into automation-v1 parallel-mode Step 7; second eval provider.

## Consumer-side follow-ups (NOT this PR)

After v2.33.0 is released and tagged: automation-v1 runs `/claudeupdate` to receive the three features, then populates `skill-context.md` sections and authors its first eval suite (seeded from review-mining). These are automation-v1 work items, not framework work.
