# Progress — compound-learning-suite

**Phase:** 1 (SPEC) — PAUSED by operator 2026-07-09, mid-grounding, before intent.md authoring.
**Branch:** feat/v2.33.0-compound-learning (created off origin/main @ 937aba6 / v2.32.1; clean tree, no commits yet)
**Target release:** v2.33.0 — one release, one PR (operator delegated the split decision; batching precedent: v2.30.0 five workstreams, v2.32.0 multi-discipline)
**Classification:** Major (three features: new hook + new overlay convention + new eval subsystem; version bump + migration + doctor checks)
**Venue decision:** pipeline runs IN the framework repo (precedent: harness-audit-remediation 4bbe8ea, parallel-worktree-builders). Consuming-repo automation-v1 state untouched; its pipeline lock belongs to rls-prod-role-cutover.

## Operator brief (2026-07-09, verbatim scope)

Three related features, making lessons/quality compound faster in consuming repos. One release or split = my call (chose one). All features: version bump, CHANGELOG, migration notes per /release conventions.

- **Feature A — session-start memory hook.** New SessionStart hook (alongside framework-merge-reminder, code-graph-freshness-check) injecting a compact digest: recent KNOWLEDGE.md entries (tail-read only — consuming files are 400KB+), recent tasks/lessons.md entries, full tasks/current-focus.md. Hard budget ~150 lines total, drop oldest first. Degrade gracefully: missing/unreadable file → silent skip; never block/slow session start.
- **Feature B — local skill overlay.** Unmanaged `.claude/context/skill-context.md` with `## <skill-name>` sections (mirrors agent-context.md / ADR-0006). Sync never touches it. One-line pointer added to skill template + existing skills: "Repo-specific addenda: .claude/context/skill-context.md § <name>, if present." Write protocol documented: KNOWLEDGE.md stays master append-only log; skill-shaped procedural lessons ALSO appended to matching overlay section same day. Quarterly promotion flow (knowledge-to-framework-skills-map) extended to drain overlay entries upstream, marking "promoted in vX.Y.Z" (not deleted). framework-doctor checks: every overlay section names an existing skill; warn on entries >1 quarter old never promoted.
- **Feature C — golden-set prompt eval runner.** Generic command-skill `/eval-prompts` + runner script. Reads repo-local suite `eval/<suite>/cases.jsonl` + `eval/<suite>/config.json` (names target prompt module + provider). Keys from .env (`set -a; . ./.env; set +a`). Compares outputs vs labeled expectations; reports catch rate + false-alarm rate vs last-accepted baseline; regression beyond configurable threshold = fail. Cases format pinned: `{id, input, expected, notes, source}`. Framework ships runner + format spec + framework-doctor manifest-validity check; repos own cases. Documented integration: prompt change lands only if suite passes (automation-v1: wires into parallel-mode Step 7 prompt-evolution; first cases seeded from tasks/review-mining ~1,900 adjudicated findings — consumer-side follow-up, not this PR).

## Grounding completed (explorer 1 — hooks + memory files)

- Hooks: ESM (`hooks/package.json` `{"type":"module"}`), plain text to stdout (NOT JSON/additionalContext), always exit 0, warnings to stderr, fail-open. SessionStart settings block at `.claude/settings.json:83-97`, no matcher, per-hook `timeout` in seconds (only code-graph sets 180). Command shape: `node "$CLAUDE_PROJECT_DIR"/.claude/hooks/<file>.js`.
- Tests: hand-rolled Node scripts (no framework), `spawnSync(process.execPath, [HOOK], {env: {CLAUDE_PROJECT_DIR: tmpProj}})`, mkdtempSync fixtures, `check()` helper, exit 1 on fail. Test files NOT in manifest (not synced).
- Manifest: hooks listed per-file `{path, category: "hook", mode: "sync", substituteAt: "never"}` (manifest.json:16-69); settings.json is `mode: settings-merge` (:172-177). doNotTouch: CLAUDE.md, KNOWLEDGE.md, architecture.md, DEVELOPMENT_GUIDELINES.md, tasks/** (:642-648).
- Registration surfaces for a new hook: manifest managedFiles + settings.json SessionStart array + sibling .test.js + README.md:38 hook table + SECURITY.md:16 per-hook table + CONTRIBUTING.md contract; validate-setup.md:98 asserts every hook is registered.
- **Load-bearing ordering asymmetry for Feature A:** KNOWLEDGE.md (automation-v1: 464KB/2974 lines) is append-only newest-LAST → read TAIL. tasks/lessons.md (5KB/64 lines) is newest-FIRST at top of `## Lessons` section, and the file TAIL is a static format template/example → read HEAD after the `## Lessons` heading, skip trailing template. Heading formats are mixed in KNOWLEDGE.md (`## [YYYY-MM-DD]`, `### [YYYY-MM-DD]`, undated `##` + `**Date:**` line); lessons.md uses `### YYYY-MM-DD - <title>`. Archives exist (KNOWLEDGE-archive-2026-Q2/Q3.md at root, tasks/lessons-archive-2026-Q3.md) — hook ignores archives.
- No documented SessionStart output budget; existing hooks self-limit to one line; no hook uses async mode. tasks/current-focus.md in automation-v1 is 132KB/450 lines (huge legacy mission-control comment block) → "full content of current-focus.md" needs a cap/strategy in spec (e.g. prose body only, or line cap within the 150-line budget).
- Framework repo does NOT self-host KNOWLEDGE.md; its tasks/* are tiny seed templates covered by doNotTouch.

## Grounding completed (explorer 2 — skills overlay / ADR-0006 / doctor / sync)

- **ADR-0006** = `docs/decisions/0006-no-inline-agent-overrides.md`. agent-context.md lives at `.claude/context/agent-context.md`, one `## <agent-name>` heading per agent. Framework ships a TEMPLATE via manifest `mode: "adopt-only"` (manifest.json:196-201) — deployed once, then consumer owns it, sync never clobbers (classifyFile returns `{kind:'skipped',reason:'adopt-only'}` once a state entry exists). It is NOT in doNotTouch. Uniform read-instruction is the first body line after frontmatter in every agent (greppable). ADR-0006 dated 2026-06-17.
- **doNotTouch does NOT cover `.claude/context/`** — survival is via adopt-only mode, not doNotTouch.
- **Second prior-art precedent:** `references/project-extensions-convention.md` (v2.6.1) — `.claude/agents/extensions/<agent-slug>.md`, fully UNMANAGED (never in manifest), "under the project's ownership." Two viable patterns for the skill overlay: (a) adopt-only template (ships one seeded file), or (b) fully unmanaged (framework never seeds; doctor Check 3 lists it as expected project-local).
- **Skills:** 21 skill dirs, each `.claude/skills/<name>/SKILL.md`, frontmatter is exactly `name` + `description`. **NO skill template file exists** (greenfield — the brief's "add pointer to the skill template" means we must CREATE a template, or add the pointer to each existing SKILL.md). Skills are manifest `mode: "sync"` (fully overwritten on update) → per-repo addenda CANNOT live inside SKILL.md; needs an unmanaged sidecar. No SKILL.md currently carries an addenda pointer (gap the feature fills).
- **CRITICAL BRIEF CORRECTION — `knowledge-to-framework-skills-map` does NOT exist.** No such file, no defined KNOWLEDGE→skills quarterly promotion flow in either repo. The string appears once as a hypothetical in `.claude/commands/cleanfiles.md:30` ("Use a `tasks/knowledge-to-framework-skills-map.md`-style mapping doc if present"). The only codified KNOWLEDGE↔skills relationship is `/cleanfiles`'s destructive quarterly archive of entries a skill ALREADY superseded. The project's real promotion model is KNOWLEDGE.md → ADR/architecture.md (KNOWLEDGE.md:10,21). ⇒ Feature B's "extend the quarterly promotion flow" is greenfield: we DEFINE the overlay→canonical-skill drain, likely as an extension of `/cleanfiles` and/or a documented protocol, not an edit to an existing flow.
- **framework-doctor** = pure-markdown command `.claude/commands/framework-doctor.md` (NO backing script). 5 numbered checks under "## What to do", each "**Check N — <title>**" + one-row-per-finding table; summary line `framework-doctor: N checks, M findings, 0 writes`. Adding a check = append "Check 6/7" in same shape + table + bump count. Check 3 (unmanaged files in managed dirs) is directly relevant. Rules: "Zero writes."
- **sync.js** (root-level `sync.js`, 2085 lines — NOT scripts/sync.js): NEVER deletes any file (managed or not). Files not in manifest are never visited (walk iterates only expandManagedFiles). removedFiles are warn-only. Three write-defence layers (refuseIfDoNotTouch, assertWithinRoot). ⇒ a fully-unmanaged overlay file is 100% safe from sync.

## Review mode resolution

- `.claude/session-state/review-mode` = **automated**. Session is autonomous → run claude-spec-review + spec-reviewer + chatgpt-spec-review(automated OpenAI). .env exists (OPENAI_API_KEY presence pending explorer 3 confirm; automated mode requires it — if absent, fall back + surface).

## Grounding pending (explorer 3 — release/eval, still running)

- command file shape, scripts/ language + package.json, OpenAI driver + key-loading pattern, /release steps, migration contract + recent example, existing eval prior art, tasks/review-mining contents, parallel-mode Step 7, OPENAI_API_KEY presence, manifest scripts entries, README What-ships location. Append on completion.

## Next steps on resume

1. Fold explorer 2+3 digests into this file.
2. Step 3: author tasks/builds/compound-learning-suite/intent.md (nine sections).
3. Step 3a duplication/strategy check (framework has no live capabilities register → per contract treat Strategic fit clear, compare against in-flight builds + README What-ships). cross-repo-scout: automation-v1 .claude/project-registries.json sibling_repos[] is empty → skip silently.
4. Step 3b grill: operator delegated judgment ("your call"); resolve technical topics from codebase, record grill log in intent.md; surface any genuinely operator-owned decisions in chat before spec lock.
5. Step 6 spec authoring (fable-mode gates; spec-authoring-checklist).
6. Reviews (claude-spec-review → spec-reviewer → chatgpt-spec-review per mode resolution — check .claude/session-state/review-mode / CHATGPT_REVIEW_DEFAULT_MODE / OPENAI_API_KEY; manual is hard default but session is autonomous → automated mode if key present, else surface to operator).
7. Plan (architect + claude-plan-review + chatgpt-plan-review), build chunks, framework test suite (npm test, npm run validate), release plumbing (FRAMEWORK_VERSION + manifest.frameworkVersion + CHANGELOG heading must match — CI asserts), migration v2.33.0.js if consumer-side file changes needed, PR via gh to michaelhazza/claude-code-framework.
8. Consumer-side follow-up (NOT this PR): automation-v1 /claudeupdate after release; seed eval cases from review-mining; wire parallel-mode Step 7.

## SPEC DRAFTED — model-switch seam (2026-07-09)

- `intent.md` authored (nine sections + grill decisions). Step 3a: proceed (no register, no in-flight overlap, sibling_repos empty). Step 3b: three architecture forks resolved by operator (drain = protocol+/cleanfiles; overlay = adopt-only; eval = OpenAI-first+seam).
- `spec.md` DRAFT authored on Fable with fable-mode gates active. Architecture-level: three feature sections (A hook / B overlay / C eval), execution model, execution-safety, release plumbing v2.33.0, file inventory lock (11 new / 11 edited incl. 20 SKILL.md), testing posture, phase sequencing, self-consistency pass (caught manifest "+7"→ actually 6 new path entries + version bump), deferred items.
- Explorer 3 (release/eval) never returned before I self-served the same grounding directly (package.json, chatgpt-review-api.ts, migration template/example, /release command, README What-ships, eval prior-art grep = none). All spec claims tagged verified.
- **STOPPED per operator directive:** no review tiers run, no commit made (main-session no-auto-commit preference). Resume on fresh Opus session, same branch `feat/v2.33.0-compound-learning`, from intent.md + spec.md + this file.
- Review mode when Opus resumes: `automated` (session-state). Reviews: claude-spec-review → spec-reviewer (Codex) → chatgpt-spec-review (OpenAI). Then architect plan → claude-plan-review → chatgpt-plan-review → build.

## External spec-review pass applied (2026-07-09, spec v0.2)

Operator relayed an external build-readiness review (5 blockers + 5 medium). Ran review-triage: all 10 accepted (none matched FP classes — no hallucinated premises, no re-raises, no posture violations vs pre-prod framing; 2 were near-automatic accepts: manifest-count file-inventory mismatch, silence/stderr cross-section contradiction). All 10 patched into spec.md:
- B1 Risk surface: added `## Operational risk surface` (5 risks + mitigations); intent-schema field stays "None." (accurate to that controlled vocabulary) with cross-reference.
- B2 Budget: elapsed-gate checked BEFORE each block (sync reads can't be interrupted mid-call) + `"timeout": 5` backstop in settings.json (reversed the "no timeout" position — blast radius is every session in every repo).
- B3 Silence contract: expected-absent → no output; unexpected errors → stderr only under `MEMORY_DIGEST_DEBUG=1`; never stdout.
- B4 Eval scoring: pinned `expected: {verdict:"issue"|"clean", label?}`, a config-named normalizer, and exact catchRate/falseAlarmRate definitions (null-rate handling for single-class suites).
- B5 Missing baseline: non-zero exit + "run --accept to seed" message; `--dry-run` escape; doctor Check 8 advisory.
- B6 Mapping doc: LOCKED consumer-created by /cleanfiles on first drain; removed from manifest + file inventory.
- B7 Manifest count: fixed in inventory to 6 managedFiles entries + frameworkVersion bump (was stale "+7").
- B8 Pointer gate: executable check added to validate-framework.js (CI-run via `npm run validate`); doctor check is the consumer-side advisory view.
- B9 Doctor checks 6-8: marked agent-mediated (matching existing doctor posture) with exact commands; mechanical enforcement lives in validate-framework.js.
- C10 Provider: thin adapter (promptModule→ResponsesMessage[]→chatgpt-review-api.ts caller→normalizer) is an explicit deliverable; verified the existing caller takes {role,content}[] (chatgpt-review-api.ts:35-43).
- Scope: reviewer concurred one release; A+B+C stays bundled.
- Revision recorded in spec.md `# Revision log` (v0.2). Still DRAFT, still uncommitted, still at the model-switch seam.

## External spec-review round 2 applied (2026-07-09, spec v0.3)

Five findings, all accepted (mostly ripple-corrections from v0.2 edits — the triage-predicted "~1/3 of round-N findings are ripples from N-1" class):
- R1 (near-blocking): migration text said "two adopt-only files" — corrected to one (skill-context.md); the other 5 managed files are mode:sync, migration doesn't touch them. This was the churn/wrong-migration risk.
- R2: doc-sync registers convention doc only; mapping-doc format lives inside it (mapping doc is consumer-created, untracked).
- R3: current-focus read bounded to FOCUS_MAX_BYTES=256KB; removed stale "small file" claim (verified real file is 132KB).
- R4: doctor checks 6-8 constrained to Node-based cross-platform commands (framework runs on Windows; no grep/sed/date pipelines).
- R5: eval default normalizer strict — requires JSON verdict; no fuzzy heuristic; malformed case → run fails.

Reviewer verdict moved to "spec approved for plan" pending these. All patched. Spec v0.3, still DRAFT, still uncommitted, still at model-switch seam.

## External spec-review round 3 applied (2026-07-09, spec v0.4) — APPROVED FOR PLAN

Four minor nits, all patched, reviewer verdict "spec approved for plan, no new blockers":
- R6: doctor Check 6 "grep" → "extract with the Node snippet" (word survived from before the cross-platform fix).
- R7: lessons read given LESSONS_MAX_BYTES=256KB (every hook read now byte-bounded).
- R8: /eval-prompts command drops POSIX `set -a; . ./.env` (Windows-unsafe); runner loads .env itself.
- R9: doc-sync "2 new reference docs" spelled out inline (convention + eval-format).

**Spec is now APPROVED FOR PLAN by external review (3 rounds: 10 + 5 + 4 findings, all accepted & patched).** Spec v0.4, still DRAFT status header, still uncommitted, still at model-switch seam awaiting operator go on: (a) commit + switch to Opus, or (b) proceed here.

## Decisions log

- 2026-07-09: One release (v2.33.0), one PR, three workstreams — operator delegated; batching precedent cited above.
- 2026-07-09: Venue = framework repo submodule checkout in automation-v1-2nd; branch feat/v2.33.0-compound-learning.
- 2026-07-09: PAUSED by operator before intent authoring. No commits made; working-tree changes: tasks/current-focus.md (PLANNING lock), this file.
