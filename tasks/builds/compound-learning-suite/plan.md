# Implementation Plan — Compound Learning Suite (v2.33.0)

**Spec:** `tasks/builds/compound-learning-suite/spec.md` (status ACCEPTED, v0.4)
**Branch:** `feat/v2.33.0-compound-learning` · **Repo:** claude-code-framework (submodule) · **Classification:** Major
**Author:** feature-coordinator (inline, Opus) — decomposition derived from the spec's `# Phase sequencing` + `# File inventory lock` (both externally reviewed, 3 rounds).

## Pipeline-depth decision

The spec is ACCEPTED after 3 external review rounds (19 findings, all patched) with a locked file inventory and phase sequencing. Right-sizing for this framework build:

- **Architect re-derivation:** folded into this plan. The spec's file-inventory lock + phase sequencing IS the decomposition.
- **Plan-review tiers (`claude-plan-review`, `chatgpt-plan-review`):** SKIPPED — documented, not silent. Spec already reviewed to "approved for plan"; this plan is a mechanical decomposition of a locked inventory with no new design decisions. `REVIEW_GAP` recorded in progress.md.
- **Build construction:** performed inline by the grounded Opus session, not dispatched Sonnet builders. Exact-contract framework work (manifest ↔ version ↔ CHANGELOG ↔ migration must stay mutually consistent — CI asserts it) is safer in one coherent hand. Operator explicitly authorized right-sizing. Recorded in progress.md.
- **Gates (load-bearing):** `npm test` + `npm run validate` — the real CI gates and primary verification.
- **Review (worth it):** an independent `pr-reviewer`-style pass after build to catch implementation bugs.
- **Doc-sync:** run against `docs/doc-sync.md` registry.

## Architecture notes

Three additive, fail-open capabilities. No shared runtime; the only cross-cutting artifacts are the release-plumbing files (version pair, CHANGELOG, manifest, migration) that must land together for CI's version-consistency assertion. Framework conventions honored: hooks are ESM plain-text-to-stdout fail-open; hook tests are hand-rolled spawnSync plain-node; pure logic splits into `*Pure.ts` with vitest tests in `scripts/__tests__/`; migrations export `async migrate(ctx)`→`{status,notes}` using `migrations/_helpers.js`; every read byte-bounded; doctor checks are agent-mediated Node-based (Windows-safe).

## Chunk plan

### Chunk 1 — Feature A: session-start memory digest hook
**spec_sections:** Feature A (all).
**Files:** NEW `.claude/hooks/memory-digest.js` (ESM SessionStart hook — three try/catch blocks current-focus/lessons/knowledge, byte-bounded reads KNOWLEDGE 32KB tail + focus/lessons 256KB, per-block line sub-budgets, `SOFT_BUDGET_MS=100` gate before each block, global `TOTAL_MAX_LINES=150` oldest-first trim, header per present block, silent when all empty, `exit(0)` always, stderr only under `MEMORY_DIGEST_DEBUG=1`); NEW `.claude/hooks/memory-digest.test.js` (plain-node spawnSync — fixtures: all-present, none, KNOWLEDGE tail-only, lessons head-not-template, focus HTML-comment strip, over-budget oldest-first, unreadable fail-open, empty `## Lessons`); EDIT `manifest.json` (+memory-digest.js hook, test NOT manifested); EDIT `.claude/settings.json` (SessionStart += memory-digest, `"timeout": 5`); EDIT `README.md` (hooks 9→10); EDIT `SECURITY.md` (per-hook row).
**Contract:** ≤150 lines plain text; never non-zero exit; no network/spawn/writes. **Verify:** `npm run test:hooks`.

### Chunk 2 — Feature B: overlay template + pointer sweep + convention doc
**spec_sections:** Feature B (Overlay file, Skill pointer line, Write protocol, overlay/convention/SKILL.md/manifest registration).
**Files:** NEW `.claude/context/skill-context.md` (adopt-only, mirrors agent-context.md); NEW `references/skill-overlay-convention.md` (drain protocol SSoT + canonical pointer wording + mapping-doc format); EDIT 20 × `.claude/skills/*/SKILL.md` (pointer line after frontmatter); EDIT `manifest.json` (+skill-context.md adopt-only, +skill-overlay-convention.md sync).
**Contract:** every SKILL.md body carries stable substring `.claude/context/skill-context.md`; overlay adopt-only. **Verify:** grep 20/20 + Chunk 3 gate.

### Chunk 3 — Feature B: pointer gate + drain + doctor 6/7 + CONTRIBUTING + doc-sync
**spec_sections:** Feature B (Executable pointer gate, /cleanfiles wiring, doctor 6+7, validate/cleanfiles/doctor/CONTRIBUTING/doc-sync registration).
**Files:** EDIT `scripts/validate-framework.js` (+`checkSkillPointers()` → exit 1 on any missing pointer); EDIT `.claude/commands/cleanfiles.md` (overlay-drain target); EDIT `.claude/commands/framework-doctor.md` (Check 6 overlay-section-validity + Check 7 stale-un-promoted, Node-based; bump count); EDIT `CONTRIBUTING.md` §Adding a skill (pointer step); EDIT `docs/doc-sync.md` (register skill-overlay-convention.md).
**Verify:** `npm run validate` green.

### Chunk 4 — Feature C: pure scoring module + test
**spec_sections:** Feature C (Goal, cases/expected/normalizer/metric defs, pure module).
**Files:** NEW `scripts/eval-promptsPure.ts` (no I/O — parse+validate cases, strict default normalizer [JSON `verdict` required else malformed], `catchRate`/`falseAlarmRate` [null single-class], baseline+threshold compare → `{pass, catchRate, falseAlarmRate, deltas, regressions[], malformed[]}`); NEW `scripts/__tests__/eval-promptsPure.test.ts` (vitest — scoring, baseline compare, threshold breach, malformed handling, null-rate).
**Verify:** `npm run test:scripts`.

### Chunk 5 — Feature C: I/O runner + provider seam + command + format spec
**spec_sections:** Feature C (I/O module, provider seam, provider-reuse adapter, baseline accept, missing-baseline, /eval-prompts command, suite layout, scripts/command/format-spec registration).
**Files:** NEW `scripts/eval-prompts.ts` (tsx — guarded dotenv, lazy `OPENAI_API_KEY`, `EvalProvider.runPrompt(messages,{model})` seam, openai impl via `callResponsesApi`, adapter promptModule(input)→ResponsesMessage[]→normalizer, `--accept`/`--dry-run`/missing-baseline-nonzero, exit 1 on breach, provider failures throw); NEW `references/eval-suite-format.md`; NEW `.claude/commands/eval-prompts.md` (runs `npx tsx scripts/eval-prompts.ts <suite>`, no shell env preamble); EDIT `manifest.json` (+eval-prompts.ts, +eval-promptsPure.ts, +eval-suite-format.md; command + test glob-covered).
**Verify:** imports cleanly under test run; command frontmatter validates.

### Chunk 6 — Feature C: doctor Check 8 + doc-sync eval-format row
**spec_sections:** Feature C (doctor check, doc-sync registration).
**Files:** EDIT `.claude/commands/framework-doctor.md` (Check 8 eval-suite-validity, Node-based; bump count); EDIT `docs/doc-sync.md` (register eval-suite-format.md).
**Verify:** summary count correct; both doc-sync rows present.

### Chunk 7 — Release plumbing (v2.33.0)
**spec_sections:** Release plumbing, File inventory lock, Self-consistency pass, Testing posture (migration).
**Files:** EDIT `.claude/FRAMEWORK_VERSION`→`2.33.0`; EDIT `manifest.json` `frameworkVersion`→`2.33.0` (same commit); EDIT `.claude/CHANGELOG.md` (`## 2.33.0 — 2026-07-09`, Highlights/Added/Changed, references migration); NEW `migrations/v2.33.0.js` (adopts skill-context.md via `adoptNewlyManagedFiles`; idempotent; `{status,notes}`); EDIT `tests/migrations.test.ts` (fresh/idempotent/pristine/conflict); EDIT `README.md` (commands 7→8; What-ships rows).
**Contract:** FRAMEWORK_VERSION == manifest.frameworkVersion == CHANGELOG heading (CI asserts). **Verify:** `npm test` + `npm run validate` green.

## Risks and mitigations
- **Version-consistency CI assertion** — land all three version surfaces in Chunk 7 together; verify with `npm test`.
- **SKILL.md pointer breaking frontmatter parse** — pointer inserted AFTER the closing `---`; validator frontmatter regex anchors on the leading block, unaffected (verified against `validate-framework.js` parseFrontmatter).
- **Migration reading a real framework file** — v2.33.0 test writes the framework's actual skill-context.md bytes into the fixture consumer to guarantee a content match, isolating the test from template wording.
- **Hook ordering asymmetry (KNOWLEDGE tail vs lessons head)** — tests assert both directions with decoy-template fixtures per spec Ordering rationale.

## Sequencing
1 → 2 → 3 → 4 → 5 → 6 → 7. Chunks 1 and 4 are independent; the rest layer on B/C foundations. Release plumbing (7) last so counts/CHANGELOG reflect the final file set.
