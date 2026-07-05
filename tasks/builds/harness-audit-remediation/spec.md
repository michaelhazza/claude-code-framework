---
status: APPROVED
slug: harness-audit-remediation
created: 2026-07-05
task-class: Significant
source: full-repo audit (4 parallel deep passes: agents, hooks/settings, scripts/sync, docs/process)
---

# Spec: Harness Audit Remediation — claude-code-framework v2.26.0 → v2.27.0

Operator approved implementing all recommendations below ("go ahead and implement all your recommendations"), with two agreed carve-outs: (1) review-tier cutting ships as a measurement runbook only — no tiers removed without data; (2) consuming repos apply origin-specific content to their own `.claude/context/agent-context.md` post-sync (migration notes go in the CHANGELOG entry).

2026-07-05. Full read of all 28 agents, 6 hooks, sync engine, scripts, docs, schemas. Hook bugs verified by execution; test suites run (112/113 sync, 196/196 vitest, 63/63 node:test — the 1 failure is a stale assertion).

## The system in one paragraph

A three-phase pipeline (spec-coordinator → feature-coordinator → finalisation-coordinator) with gates S0–S3/G1–G5, Sonnet builders working chunk-by-chunk from an architect plan, and a tri-vendor review cascade: Claude reviewers (claude-spec/plan-review, pr-reviewer, spec-conformance, adversarial-reviewer), Codex CLI reviewers (spec-reviewer, dual-reviewer), and OpenAI/ChatGPT reviewers (chatgpt-spec/plan/pr-review via `scripts/chatgpt-review.ts`). Enforced by 6 hooks; distributed to consumer repos via submodule + `sync.js`.

## Recommendations

### Phase A — safety-critical fixes (small diffs, do first)

1. **config-protection.js MultiEdit bypass** (verified live): extractor ignores top-level `file_path` (`config-protection.js:83-94`) — a MultiEdit to `tsconfig.json` sails through while the identical Edit is blocked. Port the fix already made in `phase-lock.js:256-266`, and add the payload-shape test that would have caught it.
2. **phase-lock.js blocks legitimate writes when `CLAUDE_PROJECT_DIR` is unset** (verified live): absolute paths never match relative globs (`phase-lock.js:146-177`). Add the cwd fallback; also move the `..`-path check after the "unrestricted phase" short-circuits.
3. **Shell injection from LLM output**: `applyFindings.ts:84-128` interpolates reviewer-generated titles/paths into `execSync` strings and runs `acceptance_check` verbatim behind only a prod-DSN denylist; same pattern in `buildDiffPackage.ts:35`. Switch to `spawnSync` array args (sync.js already does this) and allowlist acceptance-check runners.
4. **Double-merge hazard**: `chatgpt-pr-review.md:807-984` carries its own merge/label/CI tail that conflicts with `finalisation-coordinator.md:583-855` (3 vs 5 iterations, `--merge` vs `--admin --squash`, no label-pull vs mandatory). Add a coordinator-invoked flag that suppresses the sub-agent's finalisation steps.
5. **Spec-location split skips a gate**: Phase 1 writes specs to `docs/superpowers/specs/…` (`spec-coordinator.md:418`) but Phase 2's spec-conformance skip-gate keys on `tasks/builds/{slug}/spec.md` (`feature-coordinator.md:584`) — the pipeline's own spec causes spec-conformance to be skipped. Standardise on `tasks/builds/{slug}/spec.md`.
6. **sync.js same-version trap**: post-merge re-sync exits "already on latest" and never rebaselines hashes (`sync.js:1352-1362`; the e2e test hand-rewinds state to dodge it). Also: ship `.claude/hooks/package.json` in `managedFiles` (ESM hooks crash in CJS consumers without it) and make `mergeSettings` non-destructive when consumer settings.json is malformed (currently overwrites it).
7. **settings.json**: quote `"$CLAUDE_PROJECT_DIR"` in all 10 hook commands (paths with spaces break every hook) and add a `timeout` to the SessionStart hook (worst case ~120s vs 60s default kill).

### Phase B — consistency reconciliation

8. **Review-mode defaults contradict**: `feature-coordinator.md:184` says automated-when-API-key; `chatgpt-plan-review.md:28` says hard-default manual (PR #441 removed the auto-default); `spec-coordinator.md` disagrees with itself (79 vs 564). Fix, then extract MODE resolution into one shared reference — the duplication is where the drift bred.
9. **Dangling authority docs**: `2026-04-30-dev-pipeline-coordinators-spec.md` and `development-lifecycle-governance-upgrade/spec.md` are cited as ground truth by 8+ agents but not shipped; `docs/capabilities.md` and `docs/integration-reference.md` are mandatory inputs/doc-sync registrants that don't exist; phantom ADR-0014 collides with the "consumers start at 0009" rule. Inline the content or strip the references.
10. **Schema drift**: `schemas/CHANGELOG.md` enums don't match `review-finding.schema.json:61-81`; `pr-context.schema.json:30` still requires retired `reality_checker`; two schemas have no consumer. Reconcile or delete.
11. **Doc-sync verdict tables are unsatisfiable**: agents demand "exactly as many rows as doc-sync.md registers" then hard-code 6/7-row templates against a 16-row registry. Derive from the registry.
12. **One test-runner policy**: builder/pr-reviewer ban `npx tsx` for tests; spec-conformance/dual-reviewer/audit-runner/hotfix instruct it. State once in `references/test-gate-policy.md`.
13. **Rename finalisation's auto-fix guardrails G1–G4 → AF1–AF4** (currently collide with the pipeline gate names) and add a one-page iteration-cap registry (~17 caps exist; two governing the same CI loop conflict).
14. **Dead-text sweep**: "(NEW)" markers, "Chunk 8a/10 will patch this", 5× v2.13.0 bootstrap notes, superseded S0 force-rule (`spec-coordinator.md:88`), duplicate step numbers, fabricated Co-Authored-By strings ("Claude Opus 4.7 (1M context)" ×8), stale ADAPT.md counts (24/4 vs actual 28/6) and `setup/portable/` narrative.

### Phase C — portability sweep (origin-project leakage)

15. Move into `.claude/context/agent-context.md` (the framework's own ADR-0006 mechanism): **`/c/Users/Michael/AppData/Roaming/npm/codex`** (spec-reviewer:53, dual-reviewer:33, feature-coordinator:628), "Automation OS" (pr-reviewer:10, bug-fixer:10), pr-reviewer's origin checklist (lines 258-294), spec-reviewer's origin primitives, claude-spec/plan-review's baked-in "multi-tenant SaaS + RLS" identity, mockup prototype paths, `michaelhazza/altessa` example, `worker/.eslintrc` in config-protection.
16. Finish or cut the context packs (origin anchors can't resolve in consumer repos; README says the shipped loader "doesn't exist yet"); document `syncIgnore` as the real agent-pruning mechanism (the "deleted agents stay deleted" claim is false).

### Phase D — infrastructure

17. **Add CI**: no workflow runs any test today; `package.json` has no scripts or pinned deps; three test runners coexist; `validate-setup` (built to catch exactly the reference-rot above) is wired to nothing. One workflow + `npm test` + pinned devDeps + validate-setup and hook tests as pre-merge gates. Fix the stale `19 !== 61` manifest assertion with dynamic invariants.
18. Smaller: `curl --fail` in the release-notify workflow (currently fails green); timeout/retry in `callResponsesApi`; recreate the missing `verify-chatgpt-model.ts` smoke test; cross-check `manifest.frameworkVersion` vs `FRAMEWORK_VERSION`; enforce-or-delete `doNotTouch`.

### Phase E — design simplification (measure first)

19. **Repeat the 2.21.0 redundancy audit on the spec/plan review cascade.** A Significant feature crosses up to eleven review surfaces; reality-checker was retired when measurement showed zero net-new findings — run the same measurement on claude-spec-review / Codex / ChatGPT tiers using `tasks/review-logs/` as data. Likely saves 2–4 review rounds per feature, with evidence.
20. Extract the duplicated contracts (branch-sync ×3, doc-sync sweep ×3, Codex bootstrap ×3, triage buckets ×4) into `references/` — shrinks the 700–1100-line coordinator prompts and kills the contradiction breeding ground.
21. Ship a task-classification table (class → required phases/gates/tiers) — it gates everything but lives only in the consumer's unshipped CLAUDE.md; this also creates the missing middle path between "Trivial" and the full pipeline.
22. Swap model assignments: adversarial-reviewer (security) sonnet → opus; mockup-reviewer opus → sonnet.

## Using the harness with ChatGPT 5.5

**Already wired**: `scripts/chatgpt-review.ts:88` defaults to `gpt-5.5`; tests pin `gpt-5.5` snapshot-matching. What you've been missing running Claude-only is the third review tier.

**Turn on the automated OpenAI lane** (chatgpt-spec/plan/pr-review):
```bash
# .env at repo root (auto-loaded) or shell env
OPENAI_API_KEY=sk-...
CHATGPT_REVIEW_MODEL=gpt-5.5          # already the default
CHATGPT_REVIEW_EFFORT=high            # minimal|low|medium|high|off
CHATGPT_REVIEW_REQUIRE_MODEL_MATCH=1  # exit 3 if OpenAI serves a different model
CHATGPT_REVIEW_DEFAULT_MODE=automated # flips all three agents from manual copy-paste to API
```
Mode resolution: explicit phrase → `.claude/session-state/review-mode` → env var → `manual`. Output is Ajv-validated against `review-result.v2` with one repair retry + quarantine, so the model swap is schema-protected.

**Codex CLI lane** (spec-reviewer, dual-reviewer — local only): `npm i -g @openai/codex && codex login`, set `model = "gpt-5.5"` in `~/.codex/config.toml`. This clears the `REVIEW_GAP: dual-reviewer` skips.

**Rollout**: (1) fix the mode-default contradictions (B.8); (2) set the env + run a recreated `verify-chatgpt-model.ts` smoke test; (3) run 2–3 builds in `parallel` mode and check the compare panels (create `prompt-evolution-log.md` first — mandated but not shipped); (4) flip to `automated`.

**What you can't do**: run the harness itself (coordinators, builders, hooks) on GPT-5.5 — Claude Code executes only Anthropic models, and porting 28 agents + the hook layer to Codex CLI would be a rewrite. Keep Claude as the execution engine and GPT-5.5 as the independent cross-vendor review tier — which is this framework's design intent.
