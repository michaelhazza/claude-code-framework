---
status: APPROVED
slug: harness-audit-remediation
spec: tasks/builds/harness-audit-remediation/spec.md
created: 2026-07-05
target-version: 2.27.0
---

# Implementation Plan: Harness Audit Remediation

Chunks are ordered so each commit leaves the repo consistent. Chunks A1–A3 are file-disjoint and run in parallel; B and C touch overlapping agent .md files and run sequentially after A; D last (CI must see all suites green).

## Chunk A1 — Hook fixes (`.claude/hooks/`, `.claude/settings.json`)

- `config-protection.js`: port the top-level-`file_path`-first extractor from `phase-lock.js:256-266` (fixes verified MultiEdit bypass); remove origin-specific `worker/.eslintrc*` from PROTECTED_PATHS; anchor eslintrc/prettierrc regexes to real config suffixes; add `.claude/settings.json` + `.claude/hooks/**` to the protected set (self-protection); bind the one-shot sentinel to the relative path, not basename.
- New `config-protection.test.js` mirroring phase-lock's EXTRACT_CASES payload-shape suite (Edit/Write/MultiEdit real shapes, sentinel consume, path-bound sentinel).
- `phase-lock.js`: `toRelative()` falls back to `process.cwd()` when `CLAUDE_PROJECT_DIR` unset (fixes verified fail-closed bug); move `..`-path check after the null-phase/build/review/finalise short-circuits; fix the wrong comment; extend `phase-lock.test.js` with cases for both.
- `long-doc-guard.js`: split basename on `/[\/\\]/` (Windows paths).
- `.claude/settings.json`: quote `"$CLAUDE_PROJECT_DIR"` in all commands; add `timeout: 180` to the SessionStart hook entry.
- Gate: `node .claude/hooks/phase-lock.test.js && node .claude/hooks/config-protection.test.js && node .claude/hooks/spec-creation-grill-nudge.test.js` all pass.

## Chunk A2 — Script security/robustness (`scripts/`)

- `review-coordinator/applyFindings.ts`: replace string-interpolated `execSync` in stashPush/revertFiles/commit with `spawnSync(cmd, [args])`; gate `acceptance_check` behind an allowlist (leading binary ∈ {npm, npx, node, tsx, vitest, git} AND no shell metacharacters `` `$();&|<> `` beyond plain args) — keep the prod-DSN denylist as defence-in-depth.
- `review-coordinator/buildDiffPackage.ts:35`: spawnSync array args for the per-file diff.
- `chatgpt-review-api.ts`: AbortController timeout (default 120s, `CHATGPT_REVIEW_TIMEOUT_MS` override) + retry ×2 with backoff on 429/5xx/network.
- `chatgpt-review.ts`: route API-call failures to documented exit 2 (currently exit 1).
- Recreate `scripts/verify-chatgpt-model.ts` (smoke test named in chatgpt-review-api.ts header): calls `callResponsesApi` through the same path, prints requested-vs-served model via `compareModels`, exit 0 match / 3 mismatch / 2 API error.
- Gate: `npx vitest run` on touched pure-module suites passes; `npx tsx --test` node:test files pass.

## Chunk A3 — Sync engine (`sync.js`, `manifest.json`, `migrations/`, `tests/`)

- `sync.js`: same-version runs no longer early-exit — run the walk in maintenance mode (rebaseline resolved `.framework-new` merges, report unresolved ones, no version bump); `mergeSettings` aborts (exit 1, no write) on malformed consumer settings.json; `loadManifest` cross-checks `manifest.frameworkVersion` vs `.claude/FRAMEWORK_VERSION` (error on drift), validates `category`/`mode` enums, enforces `doNotTouch` as write-refusal (prefix match, no glob expansion).
- `manifest.json`: add `.claude/hooks/package.json` (mode sync) and `references/project-extensions-convention.md` (mode sync).
- `migrations/v2.27.0.js`: auto-adopt the two newly-managed files when hash-matched (v2.8.0 pattern); fix v2.13.0 docstring glob typo.
- `tests/helpers.test.ts:274`: replace `=== 19` with dynamic invariants (every glob matches ≥1 file; count equals expansion); extend `e2e-merge.test.ts` to cover rebaseline WITHOUT the hand-rewind workaround.
- `.claude/CHANGELOG.md`: backfill missing `## 2.3.0` and `## 2.16.1` headings (thin entries) so excerpt ranges terminate.
- `.github/workflows/notify-application-on-release.yml`: `curl --fail-with-body` + non-zero exit on dispatch failure.
- `SYNC.md`: delete the fictitious "Going backward" troubleshooting entry (downgrades out of scope).
- Gate: `npx tsx --test tests/*.test.ts` — 113/113.

## Chunk B — Agent/doc reconciliation (sequential, main session)

Order matters; one commit per numbered group.

1. **Merge safety**: `chatgpt-pr-review.md` gets an explicit INVOCATION CONTEXT block — `standalone` (runs its own finalisation tail) vs `coordinator-invoked` (stops after findings/doc-sync; steps 10–14 forbidden); `finalisation-coordinator.md` Step 5 passes `coordinator-invoked`. Align CI-loop rules on the coordinator's (5 iterations, label-pull-first, `--admin --squash`); fix "30 polls ≈ 45 min" arithmetic.
2. **Spec location**: standardise on `tasks/builds/{slug}/spec.md`. `spec-coordinator.md` Step 6 writes there; back-compat note (accept `docs/**/specs/*-{slug}-spec.md` if the canonical path is absent).
3. **Mode defaults**: fix `feature-coordinator.md:184` and `spec-coordinator.md:79` to hard-default-manual (post-PR-#441); add `Mode: parallel` to the three session-log schemas; extract MODE/AUTONOMY resolution into `references/review-mode-resolution.md`, consumed by all three chatgpt-* agents.
4. **Registry-derived doc-sync**: verdict tables instruct "one row per `docs/doc-sync.md` registry entry present in the consuming repo" — delete the hard-coded 6/7-doc templates in feature-coordinator, finalisation-coordinator, chatgpt-pr-review.
5. **Test-runner policy**: single statement in `references/test-gate-policy.md`; fix spec-conformance:411, dual-reviewer:195, audit-runner:234/349, hotfix:75/84 to reference it.
6. **Names/caps**: rename finalisation auto-fix guardrails G1–G4 → AF1–AF4; new `references/iteration-caps.md` registry; agents cite it instead of restating caps.
7. **Dangling authority**: strip/inline references to the two unshipped specs (adversarial-reviewer, dual-reviewer, finalisation-coordinator, spec-authoring-checklist §Lifecycle); resolve phantom ADR-0014 by inlining the coordinator-runs-inline rationale into ADR-0008 + feature-coordinator; mark `docs/capabilities.md`/`integration-reference.md` conditional ("if present") in doc-sync and spec-coordinator Step 3a.
8. **Schemas**: reconcile `schemas/CHANGELOG.md` to `review-finding.schema.json`; drop `reality_checker` from `pr-context.schema.json`; document pr-context/prior-rounds consumption status honestly.
9. **Dead text sweep**: "(NEW)" markers, "Chunk 8a/10 will patch this", 5× v2.13.0 bootstrap notes, superseded S0 force-rule (spec-coordinator:88), duplicate step numbers, Co-Authored-By → neutral `Claude <noreply@anthropic.com>`, MIGRATION doc reality-checker mentions, review-log filename convention alignment.
10. **Model assignments**: adversarial-reviewer → opus; mockup-reviewer → sonnet.

## Chunk C — Portability sweep

1. Origin content out of portable agents (replaced with `{{...}}` placeholders or agent-context.md pointers per ADR-0006): Codex fallback path ×3 → `command -v codex` + agent-context override slot; "Automation OS" ×2; pr-reviewer origin checklist (258-294) → generic hunt-list + agent-context section; adversarial-reviewer fallback identifiers; spec-reviewer framing assumption 3 + origin test stats; claude-spec/plan-review baked-in SaaS identity → read PROJECT_CONTEXT; mockup prototype/CSS paths; `michaelhazza/altessa` → `<owner>/<sibling-repo>`.
2. Context packs: origin anchors → placeholders + ADAPT Phase 3b instruction; README updated (loader shipped; drop "this week"); remove `project-map.md`/`import-graph` references.
3. `ADAPT.md`: counts 28 agents / 6 hooks; STANDARD count fixed; remove `setup/portable/` narrative; Phase 1.5 documents `syncIgnore` pruning; `MIGRATION-FROM-COPY-PASTE.md` false "won't re-add deleted agents" claim fixed.
4. `docs/spec-context.md` + checklist §9 key-set reconciled; leaked substitution prose fixed (checklist:169,196-197); `zoom-out` sources marked "if present"; `/claudeupdate` stale co-author + undefined vars fixed; registries template `frameworkVersion` documented as schema-introduced-at.

## Chunk D — CI, measurement runbook, release

- `package.json`: `scripts.test` (three suites), pinned devDeps (tsx, vitest, ajv, ajv-formats, @types/node).
- `.github/workflows/ci.yml`: sync suite + vitest + node:test + hook tests on PR and main push.
- `references/review-tier-redundancy-audit.md`: runbook to measure net-new findings per review tier from `tasks/review-logs/` (the 2.21.0 method), with decision thresholds for collapsing tiers.
- `docs/review-pipeline/parallel-mode.md` fixes (prompts framework-managed since v2.8.0) + ship `tasks/review-logs/prompt-evolution-log.md` template.
- `FRAMEWORK_VERSION` → 2.27.0; `manifest.json.frameworkVersion` → 2.27.0; CHANGELOG entry incl. **consumer migration notes** (agent-context.md additions for origin repos; new managed files; mode-default clarification).
- Final gate: full test run green.

## Out of scope (deferred with rationale)

- Cutting any review tier (needs the runbook's data first).
- Bash-tool coverage for config-protection/phase-lock (heuristics risk false-positive lockouts; → tasks/todo.md).
- Merging claude-spec-review + claude-plan-review; folding incident-commander into hotfix (behaviour-changing; propose after redundancy data).
- sync.js downgrade guard (doc claim deleted instead).
