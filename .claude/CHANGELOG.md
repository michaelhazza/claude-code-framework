# Claude Code Framework — Changelog

This file tracks framework versions for cross-repo drift detection. The version lives in `.claude/FRAMEWORK_VERSION` (single line, semver). When you propagate this framework to a new repo, the version travels with it; future updates can compare versions and produce a delta.

## Format

```
## <version> — <YYYY-MM-DD>

**Highlights:** one paragraph of what shipped.

**Breaking:** changes that require manual migration in repos already on a previous version.
**Added:** new agents, hooks, conventions, or scaffolding.
**Changed:** existing files updated in place; agents now do X instead of Y.
**Deprecated:** still works, but slated for removal.
**Removed:** files / agents / conventions no longer in the framework.
**Fixed:** bugs, doc-rot, broken cross-references.
```

## Upgrade protocol

When a repo's `FRAMEWORK_VERSION` falls behind the latest:

1. **Read this changelog** from the latest version backward to your current one.
2. **For each `Breaking:` entry**, follow the migration note. Don't skip.
3. **For each `Added:` entry**, decide whether to adopt (some additions are opt-in).
4. **For each `Changed:` entry**, diff your local file against the new template — the change may already exist locally if you customised, or may need to be re-applied.
5. **Update `.claude/FRAMEWORK_VERSION`** to the new version.
6. **Run `validate-setup`** (when that skill exists) or the agent fleet's smoke test to confirm the upgrade landed cleanly.

Repos can stay on older versions intentionally. The framework is designed to be additive; older versions don't break.

---

## 2.8.0 — 2026-05-29 — chatgpt-review prompts framework-managed + 13 new Hunt Targets + PROJECT_CONTEXT registries

**Highlights:** Promotes the chatgpt-review prompt harness (`scripts/chatgpt-review.ts`, `scripts/chatgpt-review-api.ts`, `scripts/chatgpt-reviewPure.ts`, `scripts/__tests__/chatgpt-reviewPure.test.ts`) from per-repo local copies to framework-managed files so all consuming repos receive prompt updates via the standard submodule-bump + sync.js adoption path. Adds 13 new Hunt-Target patterns across the three system prompts based on the 2026-05-29 notifications-system build's full end-to-end review run (2 SPEC + 1 in-place SPEC extension + 5 PLAN + 6 PR). Patterns are tied to specific incidents in that build's spec-review false-positives, plan-review missed chunk-discipline, PR-review CI fix-loop iterations, and dual-reviewer test-mock-staleness findings. Adds a parallel coordinator-side change requiring PROJECT_CONTEXT to expose 5 named registry sections (registry/manifest surfaces, CI-only gates, gate IDs + suppression scopes, CI workflow files, local-vs-CI verification policy) so the new Hunt Targets can fire reliably across consuming repos. Posture is soft-default at launch (missing sections degrade gracefully with a console.warn; the corresponding Hunt Targets fall silent on that run) and may flip to fail-closed in a future framework version.

**Added:**
- `scripts/chatgpt-review.ts`, `scripts/chatgpt-review-api.ts`, `scripts/chatgpt-reviewPure.ts`, `scripts/__tests__/chatgpt-reviewPure.test.ts` — now framework-managed (new `review-script` / `review-script-test` categories in `manifest.json`). Consuming repos that previously kept local copies will see the framework's version supersede the local copy via `sync.js --apply`.
- `scripts/review-coordinator/*.ts` — newly added to `manifest.json` `managedFiles` (the directory existed in the framework canonical but was not previously synced to consuming repos).
- `.claude/project-registries.json.template` — template for the new `.claude/project-registries.json` per-repo config that the chatgpt-review coordinator reads at dispatch time to inject registry/manifest/gate/workflow names into PROJECT_CONTEXT. Consuming repos copy the template and fill in the 5 sections to enable the new Hunt Targets.
- 13 new Hunt-Target patterns in `scripts/chatgpt-reviewPure.ts`:
  - **SYSTEM_PROMPT_SPEC_V2** (2 new + 1 in-place extension): stale-view false-positive prevention; chunk-discipline file-count check on the spec's own chunk plan; testing-posture-contradiction escalation rule appended to the existing "Testing-posture drift inside a single spec" bullet so the contradiction now emits as `recommendation="implement"` rather than `"discuss"`.
  - **SYSTEM_PROMPT_PLAN_V2** (5 new): local-vs-CI verification language consistency; Registry / Manifest Completeness (plan-stage); test-mock-staleness implication of implementation contract changes; discovery and precondition-validation sequencing (generalised from probe-specific to any chunk whose output can invalidate later work); forward-reference and migration-order check across the chunk DAG.
  - **SYSTEM_PROMPT_PR_V2** (6 new): Registry / Manifest Completeness (PR-stage); gate convention regex pre-check on new files; test-mock staleness when implementation adds new method calls on a mocked parameter; guard-ignore comment correctness check; module side-effects on import (with standalone-script exception and uncertainty-noting diagnostic); large-diff CI infrastructure adequacy heads-up (advisory only — never blocking).
- `scripts/review-coordinator/validateProjectContextPure.ts` — new exported `findMissingRegistrySections(context)` helper + `REGISTRY_SECTIONS` const array. Returns the list of §6.2 registry headings missing from PROJECT_CONTEXT for the coordinator to log as console.warn (soft-default posture; does NOT fail-close).

**Changed:**
- `manifest.json`: bumped `frameworkVersion` to `2.8.0`; added 5 new `managedFiles` entries for the relocated chatgpt-review scripts + the project-registries template + the review-coordinator helpers; introduced two new categories (`review-script`, `review-script-test`, `review-coordinator`).

**Why the prompts move to the framework now:** the notifications-system build (PR #447 in automation-v1) was the first complete end-to-end run of all three OpenAI-driven review tiers under the parallel-mode v2.7.2 contract. The build's full audit log (4 CI fix-loop iterations, 6 distinct missed-pattern classes, 14 distinct findings across 2 rounds of chatgpt-pr-review) yielded enough concrete patterns to justify a meaningful tuning pass. Keeping the prompts as per-repo local copies meant Foundry / CryptoTrackr / Freedom Planner would not have benefited from these patterns without a manual mirror per repo. Promoting to framework-managed makes future prompt-tuning iterations a single PR against the framework canonical, propagating to every consuming repo via the existing submodule bump pattern.

**Brief and source incidents:**
- Full brief (revision 3, APPROVED): `tasks/builds/chatgpt-prompt-tuning-notifications-system-2026-05-29/brief.md`
- Source incident logs (in automation-v1): `tasks/review-logs/chatgpt-{spec,plan,pr}-review-*-notifications-system-*.md`, `tasks/review-logs/auto-fix-log-notifications-system-*.md`, `tasks/review-logs/dual-review-log-notifications-system-*.md`.

**Migration for consuming repos (Trivial follow-up PR per repo):**
1. Bump `.claude-framework/` submodule pointer to this version's merge commit.
2. Run `node .claude-framework/sync.js --apply` — deploys the 4 chatgpt-review scripts, the review-coordinator helpers, and the project-registries.json.template.
3. Delete any pre-existing local copies of `scripts/chatgpt-review*.ts` in the consuming repo (now superseded by synced versions).
4. Copy `.claude/project-registries.json.template` to `.claude/project-registries.json` and fill in the 5 sections with paths that exist in your repo. Missing or null sections are tolerated at v2.8.0 launch (the relevant Hunt Targets fall silent on that run) but will be required by a future framework version.
5. Bump `.claude/FRAMEWORK_VERSION` in the consuming repo to `2.8.0` and run lint + typecheck. No behaviour change is expected until the next chatgpt-review dispatch picks up the new prompts.

## 2.7.2 — 2026-05-28 — chatgpt-review parallel mode + learning component

**Highlights:** Fixes three stacked bugs in the OpenAI-driven chatgpt-review CLI that caused real schema quarantines on real artefacts, then adds a `parallel` mode to all three review agents (PR, spec, plan) that runs OpenAI and manual ChatGPT-web side-by-side and renders a compare panel. New learning step (Step 7) inspects every parallel round, proposes targeted edits to the OpenAI prompts when ChatGPT-web catches things OpenAI missed, gates each proposal on operator approval, and persists every edit to a durable `tasks/review-logs/prompt-evolution-log.md` audit trail. Three rounds of self-test on the introducing PR (#441) drove ChatGPT-web's verdict from CHANGES_REQUESTED → APPROVED with three durable prompt-evolution entries logged. The system is the prerequisite for the future Phase 3 flip to fully automated review.

**Added:**
- `docs/review-pipeline/parallel-mode.md` — shared contract for the parallel mode used by `chatgpt-pr-review`, `chatgpt-spec-review`, `chatgpt-plan-review`. Covers loop shape, compare-panel rendering, session-log schema (with the new 7a/7b learning sub-sections), failure handling, the three learning channels (chatgpt-only, severity-delta, anti-hunt), Step 7a (pre-triage Channels 1+2) and Step 7b (post-triage Channel 3) split, the `CHATGPT_REVIEW_DEFAULT_MODE` env-var gate, and the Phase 3 flip criterion (zero ChatGPT-only findings for two consecutive rounds).
- `manifest.json` entry for the new shared contract doc as a managed reference file.

**Changed:**
- `.claude/agents/chatgpt-pr-review.md` — mode resolution now lists three modes (`manual` / `automated` / `parallel`); resolution order honours explicit operator phrase, then `CHATGPT_REVIEW_DEFAULT_MODE` env var, then hard-default `manual`. Parallel-mode entry note pins explicit stdin redirection for PR mode to prevent `readStdin` deadlock, splits stdout/stderr to keep JSON capture clean, and points at the shared contract for Step 7 learning analysis.
- `.claude/agents/chatgpt-spec-review.md` — same three-mode resolution + parallel entry note + Step 7 pointer; spec mode uses `--file` for unambiguous input.
- `.claude/agents/chatgpt-plan-review.md` — three-mode resolution + parallel entry note + Step 7 pointer; the legacy "`OPENAI_API_KEY` set → automated by default" behaviour was REMOVED so all three agents now follow the same hard-default-manual contract (no silent token-burn on a fresh machine with the key set). Front-matter description and Mode Detection section both updated.

**Why:**
- The OpenAI-driven CLI was quarantining real responses on real PR diffs because three bugs stacked: (A) the CLI never substituted prompt placeholders (model saw raw `{{DIFF}}` literals), (B) the v2 prompts under-specified the result envelope (verdict enum, integrity_check string contract, source_refs shape, category enum, the conditional `operator_decision_required_reason` requirement), and (C) the repair prompt was generic. Parallel mode is the dev-loop that lets the operator A/B-test the automated OpenAI path against manual ChatGPT-web until OpenAI consistently catches what ChatGPT-web catches plus more — the criterion for flipping the default to automated.
- All three agents reading the shared contract from one doc keeps the loop shape, session-log schema, and Phase 3 transition criteria in one place — three copies of the same content drift apart.

**Project-side companion changes (not framework-managed; documented here for cross-repo awareness):**
- `scripts/chatgpt-reviewPure.ts` and `scripts/chatgpt-review.ts` were rewritten in the introducing PR (#441 on automation-v1) to: substitute `{{KEY}}` placeholders (with fail-fast on missing keys), split each v2 prompt into `_SYSTEM` (instructions + envelope skeleton) and `_USER` (artefact + metadata) templates so untrusted document content stays out of the highest-priority instruction channel, add `buildAdHocPromptVars` for ad-hoc CLI runs, add `buildRepairPrompt` + `OUTPUT_ENVELOPE_SKELETON` + `translateAjvErrorsToChecklist` + `SYSTEM_PROMPT_REPAIR_V2` (dedicated repair-retry system prompt), add `compareFindingSets` + `renderComparePanel` + `mdCell` + `jaccard` for the compare panel, true-alias the `--expected-sha` / `--source-artifact-sha` flags at argument-parse time with conflict detection, and add CLI flags (`--project-context`, `--pr-context`, `--prior-rounds`, `--project-context-version`, `--source-artifact-sha`) for coordinator-driven invocations. These scripts live per-project (the framework does not manage `scripts/`); other repos adopting the framework should pull the same shape from the canonical implementation in `automation-v1`.
- `tasks/review-logs/prompt-evolution-log.md` was introduced as the append-only audit trail for every learning-step edit. Each repo that adopts parallel mode should create the same file using the header template in the canonical implementation.

**Not done (deliberately):**
- `scripts/chatgpt-review.ts` and `scripts/chatgpt-reviewPure.ts` were NOT promoted to framework-managed. Each project's prompts evolve based on its own A/B history; promoting the scripts to framework-canonical would couple prompt evolution across all consumers. The decision was flagged in the introducing PR's session log for future revisit.

## 2.7.1 — 2026-05-28 — feature-coordinator model-switch contradiction fix

**Highlights:** Resolves the Opus/Sonnet model-switching contradiction between Model A (builder dispatched as a Sonnet sub-agent) and Model B (operator manually switches the main session). Commits Model A — the only execution model that actually matches Claude Code runtime constraints (a running interactive session cannot change its own model programmatically). The main session now stays on Opus end-to-end through the three-coordinator pipeline; token-heavy chunk construction runs on Sonnet via the `builder` sub-agent dispatch. No more `/model` prompts during a `feature-coordinator` run.

**Changed:**
- `.claude/agents/feature-coordinator.md` Step 6 (Builder invocation) — added a HARD RULE that the coordinator MUST dispatch `builder` via the `Agent` tool for all chunk construction and MUST NEVER write chunk code inline with `Edit` or `Write` in the main session. The dispatch now passes an explicit `model: "sonnet"` per-invocation override as belt-and-suspenders over the `builder.md` frontmatter (per-invocation override beats frontmatter per Claude Code runtime). Inline construction closes a scope-drift hole and ensures the cost model holds: heavy build tokens are Sonnet, coordinator orchestration tokens are Opus.
- `.claude/agents/feature-coordinator.md` Step 7 (Post-G2 spec-validity checkpoint) — removed the `MANDATORY STOP: switch to Opus before continuing` block and the `Do not start Step 8 until the operator has confirmed they are on Opus` enforcement. The main session is already on Opus throughout Phase 2 under Model A; no switch is needed. The spec-validity question itself is retained — operator still confirms `continue` before Step 8.
- `CLAUDE.md` "Model guidance per phase" table — rewrote to reflect Model A end-to-end. Old table conflated execution model (which session runs) with sub-agent model (per-agent frontmatter). New table has two columns: "Main session" (Opus throughout) and "Sub-agent model" (Sonnet for builder, Opus for everything else). Removed plan-gate "manually switch to Sonnet" and post-G2 "switch back to Opus" rows. Added a closing paragraph explaining why no main-session switch is needed and what the headless `claude -p --model sonnet` escape hatch is if orchestration cost ever becomes an issue.

**Why:**
- A running interactive Claude Code session cannot change its own model programmatically. `/model` is interactive and user-only; no tool, hook, or settings entry lets an agent switch its session model mid-run. Model B (manual main-session switching) was unreachable from inside the coordinator playbook — the operator was being asked to perform a manual dance that the coordinator could not enforce.
- Model A (builder-as-Sonnet-sub-agent) was already implemented (`.claude/agents/builder.md` frontmatter `model: sonnet`; `feature-coordinator.md` Step 6 dispatches `builder` via the `Agent` tool). The fix commits Model A as the sole execution model and deletes Model B's documentation residue.
- The plan-gate and post-G2 stops remain as operator-review seams; they just no longer demand a model switch.

**Not done (deliberately):**
- `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` was NOT set. That env var forces ALL sub-agents to Sonnet, which would wrongly demote `architect`, `pr-reviewer`, `reality-checker`, and other reviewers intentionally pinned to `model: opus`. Per-agent frontmatter is the correct mechanism.
- Orchestration cost (coordinator's own Opus tokens during the build loop — running lint/typecheck, reading builder output, writing commits) is accepted as the tradeoff. If it ever becomes material, the right answer is to run the build loop as a separate headless `claude -p --model sonnet` invocation across the plan-gate or post-G2 seam, handing off through `tasks/builds/{slug}/plan.md` and `progress.md`. This is documented in the CLAUDE.md model-guidance table but not implemented in this release.

**Fixed (defence-in-depth):**
- The new HARD RULE in Step 6 also closes a latent drift hole: prior wording allowed the coordinator to be interpreted as optionally dispatching builder, which could lead a future agent (or a confused operator) to inline-write chunk code in the main session, defeating both the cost model and the commit-integrity invariant (which depends on builder's structured `files-changed` verdict).

## 2.7.0 — 2026-05-28 — review-cascade-v3

**Highlights:** Schema-gated multi-tier review pipeline upgrade. Replaces the ad-hoc prose review contract with a JSON-Schema-gated v2 envelope across all three review modes (spec, plan, PR). Adds two new advisory Claude reviewers, upgrades `pr-reviewer` to v2 with mechanical auto-fix authority, wires coordinator-side auto-apply with rollback, disagreement adjudication, and false-positive suppression memory. Golden corpus: 11/11 fixtures passing (8 coordinator + 3 driver smoke).

**Added:**
- `schemas/review-finding.schema.json` — active v2 contract for a single finding. Key additions: `risk_domain` (independent enum from `finding_type`; carve-out gate keys on this), `source_refs[]` (replaces `evidence` string; min 1 item), `scope_signal`, `triage_hint`, `proposed_edits[]` (required when `auto_apply_eligible: true` per §A11 patch contract), `acceptance_check` denylist via `pattern` constraint.
- `schemas/review-result.schema.json` — active v2 envelope. Versioning quartet: `contract_version`, one of `{prompt_version | reviewer_version | stitched_from}`, `project_context_version`, `source_artifact_sha`. `oneOf` enforces mutual-exclusivity between OpenAI-tier, Claude-tier, and coordinator-stitched records.
- `schemas/prior-rounds.schema.json` — PRIOR_ROUNDS input shape: `current_round`, `findings_settled[]` (with resolution enum), `coordinator_notes[]`.
- `schemas/pr-context.schema.json` — PR_CONTEXT input shape: `pr_title`, `build_slug`, `task_class`, `phase_2_review_outcomes`, `accepted_deviations[]`.
- `schemas/CHANGELOG.md` — field-move history for the schema contract surface.
- `.claude/agents/claude-spec-review.md` — new advisory Claude spec reviewer. Read-only, 3-iteration lifetime cap per artifact. Runs before Codex and OpenAI; emits markdown log + canonical JSON validated by the v2 schema. Fail-closed on missing PROJECT_CONTEXT sections (§3b). `auto_apply_eligible: false` at launch; promoted via `CLAUDE_REVIEWER_FIX_MODE_SPEC` config flag.
- `.claude/agents/claude-plan-review.md` — new advisory Claude plan reviewer. Read-only, 3-iteration lifetime cap per artifact. Risk-weighted chunk sampling (schema/migration/RLS/worker/route chunks always in the 2-3 sample). Runs as the only mechanical pre-screen before OpenAI plan review. `auto_apply_eligible: false` at launch; promoted via `CLAUDE_REVIEWER_FIX_MODE_PLAN`.
- `scripts/review-coordinator/applyFindings.ts` — coordinator-side §11a auto-apply orchestrator: one-finding-at-a-time, snapshot + rollback, anchor-based patch, cumulative re-verify, structured commit.
- `scripts/review-coordinator/applyFindingsPure.ts` — pure helper for the apply loop (no FS side effects; testable in isolation).
- `scripts/review-coordinator/auditLog.ts` — structured audit log writer for coordinator decisions (applied / deferred / suppressed / quarantined).
- `scripts/review-coordinator/buildDiffPackage.ts` — coordinator-side §3c diff truncation manifest builder; hashes the focused package (manifest + diff + PR_CONTEXT + PRIOR_ROUNDS) for `source_artifact_sha`.
- `scripts/review-coordinator/buildDiffPackagePure.ts` — pure helper for diff package construction.
- `scripts/review-coordinator/resolveBaseRef.ts` — F9 R1 fix: `resolveBaseRef()` dynamically resolves the merge-base against `origin/HEAD` or the configured default branch; no more hardcoded `origin/main`.
- `scripts/review-coordinator/suppressionStore.ts` — §11c false-positive suppression memory with mandatory provenance, round-level dedup, and F10 R1 absent-directory tolerance.
- `scripts/review-coordinator/validateProjectContextPure.ts` — §3b PROJECT_CONTEXT fail-closed preflight; rejects missing Stage, Framing assumptions, or Architecture + Guidelines sections; pure and testable.
- `context/framing-defaults.md` — default PROJECT_CONTEXT framing block injected into all three review modes when the host repo does not supply its own.
- `context/README.md` — context directory convention: how framing-defaults.md is loaded, override semantics, and the five canonical framing-assumption keys.

**Changed:**
- `.claude/agents/pr-reviewer.md` — upgraded in place to v2 (same file, same caller contract). New authorities: mechanical auto-fix via Edit for `scope_signal: local` AND `risk_domain: none` findings (`auto_apply_eligible: true`, `auto_apply_reason: "local_one_obvious_fix"`). Security carve-out (§13) keys on `risk_domain` — any value other than `none` blocks auto-fix regardless of `finding_type`. Inline-apply sets `applied_inline_by_reviewer: true`; coordinator verifies via `acceptance_check` and does NOT re-apply. JSON output now required alongside the markdown log; both validate against `schemas/review-result.schema.json`. `reviewer_version: "pr-reviewer.v2"`.
- `.claude/agents/chatgpt-pr-review.md` — v2 routing rules: reads `triage_hint` as initial bucket, uses `risk_domain` (NOT `finding_type`) for carve-out gating, reads `auto_apply_eligible` and `proposed_edits[]` directly from the CLI's normalised findings[]. Automated mode flipped to default when `OPENAI_API_KEY` is set.
- `.claude/agents/chatgpt-spec-review.md` — same v2 routing rules; reads normalised findings[] from CLI JSON (no re-parsing raw_response). Automated mode default when `OPENAI_API_KEY` set.
- `.claude/agents/chatgpt-plan-review.md` — new agent (was absent from prior framework versions); automated mode auto-detected from `OPENAI_API_KEY`; manual fallback retained.
- `.claude/agents/spec-coordinator.md` — Steps 6a/6b added: claude-spec-review invocation with D5 cap + validateProjectContext preflight (Step 6a), followed by coordinator apply of surfaced technical findings per §11a (Step 6b).
- `.claude/agents/feature-coordinator.md` — Steps 3a/3b added: claude-plan-review invocation with D5 cap + validateProjectContext preflight (Step 3a), followed by coordinator apply of surfaced technical findings per §11a (Step 3b).

**Coordinator wiring (§11a/11b/11c):**
- §11a coordinator-side auto-apply: one-finding-at-a-time apply loop with snapshot before each apply, anchor-based patch (literal substring uniqueness check), cumulative re-verify (lint + typecheck after each), structured commit per finding, rollback on verification failure.
- §11b reviewer-disagreement adjudication: when two reviewers disagree on the same finding, coordinator surfaces the delta with both rationales; operator decides; decision logged with `coordinator_override_reason`.
- §11c false-positive suppression memory: findings suppressed in prior rounds persist to the suppression store; re-raised findings in subsequent rounds are auto-suppressed with provenance; F10 R1 tolerates absent suppression directory (creates on first write).

**Fixed:**
- F9 R1 — `resolveBaseRef()` replaces hardcoded `origin/main` with dynamic default-branch resolution; consuming repos on `origin/master` or custom default branches no longer fail the diff-package builder.
- F10 R1 — `suppressionStore.ts` creates the store directory on first write instead of throwing on absent path.

**Adoption notes (for repos consuming this framework upgrade):**
- `schemas/` directory is new at the repo root. Sync deploys it automatically (glob `schemas/**`). No manifest entry was needed in prior versions; v2.7.0 adds the glob.
- `scripts/review-coordinator/` is a new directory under `scripts/`. Consuming repos that mount the framework's `scripts/` must ensure their `tsconfig.json` picks up this subdirectory (standard `include: ["scripts/**"]` already covers it).
- `context/` directory is new at the repo root. Contains `framing-defaults.md` and `README.md`. Coordinators load from `context/framing-defaults.md` unless the host repo ships a project-specific override at the same path.
- `pr-reviewer.md` upgraded in place: consuming repos that had local customisations (e.g. project-specific "Specific Things to Check") will see a `.framework-new` sibling on next `sync.js` run. Merge the new §13 carve-out logic and the JSON output requirement; preserve project-specific checklist items.
- `spec-coordinator.md` and `feature-coordinator.md` changed in place: Steps 6a/6b and 3a/3b are additive; consuming repos with `customisedLocally: true` should merge the new steps into their local copies.
- `chatgpt-plan-review.md` is a new agent file. Sync deploys it automatically via the `agents/*.md` glob. Add the fleet table row and common-invocation entry to `CLAUDE.md` (manual step — `CLAUDE.md` is `doNotTouch` per manifest).

---

## 2.6.5 — 2026-05-27

**Highlights:** Operator-facing UX upgrade across all three ChatGPT review agents (`chatgpt-spec-review`, `chatgpt-plan-review`, `chatgpt-pr-review`) for consistency. Every round (kickoff and Round N+1) now ends with two operator-ready outputs in one place: (a) a clickable repo-relative VS Code markdown link to the artefact (spec, plan, or per-round PR diff file), and (b) a ready-to-paste ChatGPT prompt block. For Round N+1, the prompt block enumerates per-finding what was applied, rejected (with reason), and deferred (with reason) drawn from that round's decisions table — so ChatGPT has the context needed to avoid re-flagging items the operator already decided about. Eliminates the previous friction of (1) operators having to manually ask the agent for a file link each round, (2) the spec agent embedding the entire spec content inline in the prompt rather than using ChatGPT-web's native file-attach support, (3) the plan agent providing no Round N+1 prompt at all (just "Run another round?"), and (4) the PR agent lacking the applied/rejected/deferred summary in its upload prompt despite already having clickable diff links.

**Changed:**
- `.claude/agents/chatgpt-spec-review.md` — Step 7 [MANUAL] (Round 1 kickoff) replaces "Read spec content in full + embed in prompt" with a clickable VS Code markdown link to the spec file + paste-ready prompt block (no inline content). Per-Round Loop Round 2+ block trimmed (no re-prompt at start of round N — the round N-1 footer carries the prompt and link). Round summary footer (step 7 manual line) now prints a structured Round N+1 prompt block with per-finding Applied / Rejected (with reason) / Deferred (with reason) sections + a fresh clickable spec link.
- `.claude/agents/chatgpt-plan-review.md` — Step 6 (Round 1 kickoff) replaces backtick-wrapped path + "Upload this file" prose with a clickable markdown link + paste-ready ChatGPT prompt block. Per-Round Loop step 6 replaces the bare "Run another round, or say done?" prompt with the same structured Round N+1 prompt block + clickable plan link used by the spec agent.
- `.claude/agents/chatgpt-pr-review.md` — Per-Round Loop step 9 [MANUAL] now prints a structured Round N+1 prompt block (Implemented / Rejected with reason / Deferred with reason) ABOVE the existing clickable diff-file link, so the operator gets one copy-paste unit (prompt + file attachment) instead of just the diff link. Worked example updated to show the new shape end-to-end. Diff-file generation, exclusions list, repo-relative-link format rules, and VSCode-clickable-link enforcement (no absolute paths, no backslashes, no bare backticks) are unchanged — they were already correct.

---

## 2.6.4 — 2026-05-27

**Highlights:** Docs-only patch documenting a gotcha discovered during the v2.6.3 adoption rollout. The `.framework-new` files sync.js writes when a customised file has a newer canonical version are per-clone working artefacts — if accidentally committed to git, they propagate one developer's mid-sync state to every clone and look like a shared "pending decisions backlog" needing collaborative resolution. They are NOT a team-shared backlog. SYNC.md Phase 5 now opens with a gitignore prerequisite so future adopters add `*.framework-new` to their root `.gitignore` once, up front.

**Changed:**
- `SYNC.md` — Phase 5 opens with a gitignore prerequisite explaining why `*.framework-new` must be gitignored per repo, and showing the exact line to add. The framework itself does NOT auto-write this rule (it would not be safe for sync.js to modify a consuming repo's root `.gitignore`).

---

## 2.6.3 — 2026-05-27

**Highlights:** Two operator-facing additions. First, the framework now ships a `commands/` convention for transportable Claude Code slash commands, with `/claudeupdate` as the inaugural command — a one-touch updater that bumps the `claude-code-framework` submodule pointer across every consuming repo on disk (auto-discovered) and pushes per-repo, only when each repo is on `main` and clean. Second, `finalisation-coordinator` now emits a CEO-level summary at end-of-phase (Step 13.1) — plain-English dot points of what shipped, benefits, further action required, and new backlog items — before the existing technical block (Step 13.2). The summary refreshes the operator when running multiple parallel build sessions.

**Added:**
- `.claude/commands/` directory convention. Sync deploys this category like `agents/`, `hooks/`, `skills/`.
- `.claude/commands/claudeupdate.md` — the `/claudeupdate` slash command. Discovers every directory under `<scan-root>/*` that mounts `claude-code-framework` as a submodule, bumps the pointer, commits, pushes, and reports a per-repo outcome table. `<scan-root>` defaults to the parent of the current working repo; can be overridden via `$ARGUMENTS`.
- `command` category added to `ManifestCategory` in `sync.js`.
- `manifest.json` entry: `{ "path": ".claude/commands/*.md", "category": "command", "mode": "sync", "substituteAt": "never" }`.

**Changed:**
- `.claude/agents/finalisation-coordinator.md` — Step 13 split into 13.1 (CEO summary, prints first) and 13.2 (existing technical end-of-phase block, prints second). 13.1 mandates plain-English composition: no chunk IDs, no agent names, no internal jargon; reads from handoff.md + intent.md + the squash diff of `tasks/todo.md` for ground-truth sources; lists "Further action required" as a binary yes/no, not a hedge.

---

## 2.6.2 — 2026-05-26

**Highlights:** Two clarifications to `finalisation-coordinator` — (a) Step 11 spells out how to invoke `gh pr checks --watch` in Claude Code (background `Bash` + harness notification) and forbids `ScheduleWakeup` polling on top of an active watch; (b) Step 12 forbids any operator-pause `AskUserQuestion` between CI green and auto-merge. The single operator gate remains the `ready-to-merge` label at Step 10.3.

**Changed:**
- `.claude/agents/finalisation-coordinator.md` — Step 11 watch-protocol contract expanded with invocation guidance + `ScheduleWakeup` discipline; Step 12 gains a "No operator pause here" paragraph.

---

## 2.6.1 — 2026-05-24

**Highlights:** Stage 2 framework polish — consolidates findings from Foundry / CryptoTrackr / Freedom Planner sibling adoptions. De-contaminates canonical agent templates of origin-project literals (the framework now describes patterns; project-specific paths and identifiers live in each repo's `.claude/agents/extensions/<agent>.md` overlay). Lifts CryptoTrackr's audit-runner invariants (M1, M2, I1-I3, F1-F5, E1-E5) into canonical. Fixes two `sync.js` bugs that blocked clean adoption elsewhere. Makes `feature-coordinator` profile-aware so STANDARD-profile repos don't choke on missing FULL-only reviewer dispatches.

**Added:**
- `references/project-extensions-convention.md` — documents the `.claude/agents/extensions/<agent>.md` overlay convention end-to-end. Canonical agents now reference it explicitly.
- `## Project Extensions` directive section in `architect.md`, `pr-reviewer.md`, `audit-runner.md`, `feature-coordinator.md` — instructs the agent to load `.claude/agents/extensions/<agent>.md` if present at context-load time.
- `## Branch Naming and Slug Normalization (M1)` section in `audit-runner.md`.
- `## Invariants` section in `audit-runner.md` lifting CryptoTrackr's I1 (read-only-by-default pass-1), I3 (no-parallel-area pass-2), F2/E3/E5 (pass-2 hard allow-list ≤30 LOC / ≤3 files / no schema / no migration / no encryption / no dep changes), E4 (no-speculative-fix), E2 (finding-state invariant), F5 (schema/migration always pass-3), F1/I4/E1 (commit-and-rollback discipline) — all project-agnostic.
- M2 invariant in `audit-runner.md` Pre-flight (behind-main check: `git rev-list --left-right --count origin/main...HEAD`).
- Profile-aware skip block in `feature-coordinator.md` Step 4 — `chatgpt-plan-review` is skipped (no `REVIEW_GAP` required) when the agent file is not present in the repo's fleet (MINIMAL/STANDARD profile per GRADED policy).

**Changed:**
- `architect.md` — "Architecture Constraints" wrong-project section (L145-159 of v2.6.0) removed and replaced with a pointer to the project's `architecture.md` + project extensions file. `DEVELOPMENT_GUIDELINES.md` context-load made conditional ("read if present"). "Three-tier agent hierarchy" / "two-tier permission model" / "WebSocket rooms" / `references/project-map.md` build commands all softened to project-agnostic prose.
- `pr-reviewer.md` — "Specific Things to Check" wrong-project subsections (L60-99 of v2.6.0) removed and replaced with project-agnostic category headers that point to the project extensions file. `DEVELOPMENT_GUIDELINES.md` context-load made conditional. Convention-violation and shallow-modules bullets softened (no more `resolveSubaccount` / `asyncHandler` references).
- `audit-runner.md` — hardcoded subsystem inventory (origin-project hotspots: `rls`, `agent-execution`, `queues`, `skills`, `webhooks`) and per-hotspot path resolution removed. Hotspots are now project-supplied via the extensions file. `docs/codebase-audit-framework.md` is now an OPTIONAL authoritative manual: if the project ships one, audit-runner reads it as the source of truth; if absent, audit-runner uses this file as a self-contained playbook (the pre-v2.6.1 hard-halt on missing doc was a framework defect — fixed).
- `feature-coordinator.md` — `DEVELOPMENT_GUIDELINES.md` context-load made conditional. Step 4 (chatgpt-plan-review) now profile-aware.
- `builder.md`, `dual-reviewer.md`, `chatgpt-pr-review.md`, `chatgpt-spec-review.md`, `adversarial-reviewer.md`, `finalisation-coordinator.md` — `DEVELOPMENT_GUIDELINES.md` context-load made conditional across the agent fleet ("read if present; skip when absent"). Architecture/RLS references softened to project-agnostic wording where the underlying concept (tenant isolation, service-tier, etc.) is universal.
- `manifest.json` — `docs/frontend-design-principles.md` and `references/spec-review-directional-signals.md` `substituteAt` flipped from `"never"` to `"adoption"`. Both files contain `{{PROJECT_NAME}}` / `{{COMPANY_NAME}}` placeholders that were shipping unfilled — surfaced by Foundry's adoption. Consuming repos that already adopted v2.6.0 will see those two files reclassify as needing re-substitution on next `sync.js --apply`.

**Fixed:**
- `sync.js` `frameworkHookIdentity()` no longer crashes with `Cannot read properties of undefined (reading 'trim')` when settings.json contains a hook entry without a `command` string (e.g. agent-type hooks with `prompt` instead of `command`). Such hooks are now correctly classified as project-owned (not framework-owned). Surfaced by Foundry's `--adopt` where a pre-existing PR-quality-gate hook had `type: "agent"`. Workaround in Foundry v2.6.0 adoption: manual settings.json merge — no longer required at v2.6.1.
- `sync.js` `classifyForAdopt()` now honours `state.syncIgnore`, matching the regular `classifyFile()` path. Surfaced by Foundry where `--adopt` re-added FULL-only agents that had been explicitly pruned during STANDARD profile selection. Workaround in v2.6.0: post-adopt delete + re-add to syncIgnore — no longer required.
- `audit-runner.md` pre-flight no longer hard-halts when `docs/codebase-audit-framework.md` is missing. The doc is now treated as an OPTIONAL authoritative manual: if present, audit-runner reads it as the source of truth; if absent, audit-runner uses the canonical agent file as a self-contained playbook. Header description, Step-1 context loading, Pre-flight check, and the executor-vs-rewriter rule all updated to reflect optional-presence semantics. Surfaced by all three sibling-repo adoptions (none ship the manual); was the single hardest blocker for cross-repo audit-runner reuse.

**Adoption notes (for repos consuming this framework upgrade):**

- Consuming repos that adopted v2.6.0 and committed canonical-with-overlay agent files: re-running `node .claude-framework/sync.js` after the v2.6.1 update will reclassify `architect.md`, `pr-reviewer.md`, and `audit-runner.md` as needing update (because canonical now matches what their overlay-using copies already had). `.framework-new` siblings produced during the v2.6.0 adoption can now be deleted; their content is already absorbed into canonical v2.6.1.
- Sibling repos that adopted v2.6.0 with `customisedLocally: true` on the contaminated agents (and stripped the wrong-project content locally) should diff their local against the new canonical v2.6.1 — most local strips are now redundant.
- Two reference docs that previously shipped unfilled placeholders (`docs/frontend-design-principles.md`, `references/spec-review-directional-signals.md`) will re-substitute on next apply. Any local edits to those files survive (they're mode `sync`, not `adopt-only`); operators see a `.framework-new` sibling if local diverges from the canonical.
- Foundry's documented v2.6.0 workarounds (manual settings.json merge, manual delete of FULL-only agents post-adopt) are no longer needed at v2.6.1.

---

## 2.6.0 — 2026-05-24

**Highlights:** Phase A decoupling — Synthetos / Automation OS specifics removed from agent and reference content; portable skills (grill-me, zoom-out) now ship with the framework; new portable hook spec-creation-grill-nudge nudges Standard+ spec authors to invoke grill-me; Post-G2 Opus-switch checkpoint propagated to feature-coordinator; generic project-baseline-gate slot wired into finalisation-coordinator G4.

**Added:**
- `.claude/skills/grill-me/SKILL.md` and `.claude/skills/zoom-out/SKILL.md` — two portable skills ported from mattpocock/skills (MIT). Referenced by spec-coordinator (grill-me) and as a session-start prompt (zoom-out) in CLAUDE.md.
- `.claude/hooks/spec-creation-grill-nudge.js` (+ companion test) — UserPromptSubmit hook that nudges Claude to invoke grill-me when a prompt looks like a spec-creation request. Always exits 0; never blocks.
- `feature-coordinator.md` Post-G2 checkpoint — mandatory Opus-switch instruction before branch-level review pass.

**Changed:**
- `audit-runner.md` — two literal `AutomationOS` placeholders replaced with `{{PROJECT_NAME}}`. v2.2 claimed this fix; it had regressed.
- `docs/spec-context.md` — YAML body genericised; `accepted_primitives` and `convention_rejections` are now template placeholders. Synthetos-loaded content moved to automation-v1-local override.
- `docs/spec-authoring-checklist.md` — Synthetos-specific paths, anchors, function names, migration anecdotes, and named past-specs genericised. Synthetos-flavoured content moved to automation-v1-local override.
- `finalisation-coordinator.md` G4 step — extended with a generic project-baseline-gate slot (not the project-specific `verify-baseline-coverage.sh` path).
- `ADAPT.md` and `README.md` — agent count 22 → 24; FULL profile now lists mockup-coordinator and mockup-reviewer; smoke-check counts corrected to 4 / 11 / 24.
- `manifest.json` — frameworkVersion bumped 2.5.0 → 2.6.0; two literal skill entries added; settings.json now registers the spec-creation-grill-nudge hook.

**Adoption notes (for downstream repos consuming this framework):**
- Consuming repos that re-sync from v2.5.0 → v2.6.0 receive the genericised `docs/spec-context.md` and `docs/spec-authoring-checklist.md`. If a consuming repo had hand-customised either file, sync.js writes a `.framework-new` sibling and the operator merges manually. If a consuming repo had ALSO copied the old Synthetos-flavoured content as their own (rare — that content was not generic), they SHOULD move it to a repo-local override before applying the sync.
- The two new skills (grill-me, zoom-out) sync into `.claude/skills/`. New directory; sync.js will create it.
- The new hook (spec-creation-grill-nudge) appends to the `UserPromptSubmit` array via settings-merge. Existing UserPromptSubmit entries are preserved.

## 2.5.0 — 2026-05-18

**Highlights:** Mockup pipeline gets a self-correcting loop. New `mockup-reviewer` agent independently audits every `mockup-designer` round for ungrounded surfaces (phantom pages, invented nav, fictional component extensions) and operator overload (jargon, exposed internals, complexity-budget breaches). New `mockup-coordinator` inline playbook owns the pre-spec mockup loop — any operator phrase like "create mockups for X" now triggers a self-correcting designer ↔ reviewer loop before the prototype reaches the operator. `spec-coordinator`'s Step 5 reuses the same dispatch pattern.

**Added:**
- `.claude/agents/mockup-reviewer.md` — read-only audit agent for HTML prototypes. CLEAN / NEEDS_REWORK / NEEDS_DISCUSSION verdicts. Persists `mockup-review-log-round-N-*.md` per round for institutional design-governance lineage.
- `.claude/agents/mockup-coordinator.md` — inline playbook for the pre-spec mockup loop. Operator entry phrases (`create mockups for X`, `mock up the Y feature`, `mockup-coordinator: <brief>`) trigger the main session to adopt this playbook.

**Changed:**
- `.claude/agents/mockup-designer.md` — header now notes that the caller will run `mockup-reviewer` after every round, and that grounding (Step 0a) and simplification (Step 3 five-hard-rules) are the highest-leverage steps because that is where reviewer blocking findings concentrate.
- `.claude/agents/spec-coordinator.md` Step 5 — mockup loop now dispatches `mockup-designer` AND `mockup-reviewer` as a pair per round. Reuse-check skips Round 1 if `mockup-coordinator` already ran pre-spec; reuse-check keys off a machine-readable `status: complete` YAML marker in `mockup-log.md` (written by `mockup-coordinator` Step 8), not a prose heading — heading conventions are brittle to formatting drift and future coordinator additions.
- `manifest.json` — `frameworkVersion` bumped 2.4.0 → 2.5.0.

**Adoption notes (for downstream repos consuming this framework):**
- `.claude/agents/mockup-coordinator.md` and `.claude/agents/mockup-reviewer.md` are picked up automatically by the existing `.claude/agents/*.md` glob in `manifest.json`. No manifest change needed in consuming repos beyond running `sync.js` after the version bump.
- Consuming repos should add `mockup-coordinator` and `mockup-reviewer` rows to their own `CLAUDE.md` fleet table, add `create mockups for X` / `mock up the Y feature` / `mockup-coordinator: <brief>` to their common-invocations block, and add a "Mockup-request handling rule" near the inline-coordinator list forbidding the main session from dispatching `mockup-designer` alone. (`CLAUDE.md` itself is `doNotTouch` per manifest, so syncs do not overwrite the consuming repo's version — these edits are a manual one-time adoption step.)

**Design notes (incorporated during PR review on the consuming repo):**
- **No bypass.** `mockup-coordinator` explicitly forbids a "one-shot prototype, skip review" escape hatch. Every mockup request goes through the designer + reviewer pair. The failure mode this release was built to prevent (phantom pages, invented nav, jargon-heavy default surfaces) was demonstrated to enter the system under exactly the "just a quick mockup" framing — a bypass would reintroduce the regression path.
- **Canonical-registry phrasing.** `mockup-reviewer`'s route and sidebar verification refers to "the project's canonical route registry / sidebar registry" with current locations named but allowed to evolve. If a project's architecture splits routes into feature modules or moves sidebar definitions elsewhere, the reviewer follows the current convention. If no canonical registry exists at all, the reviewer returns `NEEDS_DISCUSSION` rather than guess. Consuming repos with different file paths can adopt without editing the reviewer.
- **Complexity-budget escape.** Caps in the reviewer's complexity-budget section are framed as strong defaults, NOT absolute rules. A brief or operator workflow may justify exceeding a cap (safety-critical payload screens, admin-only views per `docs/frontend-design-principles.md § When to break these rules`). Justified exceptions downgrade to 🟡 or 💭; unjustified breaches remain 🔴. The reviewer's job is to surface unjustified bloat, not to block legitimate complex workflows.
- **Single round structure, no duplicated control flow.** The previous draft of `spec-coordinator` Step 5 and `mockup-coordinator` Steps 5+7 carried two near-identical "dispatch designer, then reviewer, loop" descriptions — one for reviewer-driven NEEDS_REWORK, one for operator-driven feedback. Collapsed both to a single round structure: one round = one designer dispatch + one reviewer dispatch + one verdict. Both NEEDS_REWORK and operator-feedback simply start the next round with their respective input as "feedback for the designer." Same loop, same dispatch pair, same verdict gate. Removes divergent-prose risk and makes the playbook easier to follow.

---

## 2.4.0 — 2026-05-15

**Highlights:** propagates v2.3 (incident-commander) and v2.4 (governance overlay) work from the in-repo deployment to the portable bundle. The portable bundle had drifted: v2.2.0 had shipped without `reality-checker` (added to deployment), v2.3 (`incident-commander`) was deployed-only, and v2.4 governance overlay (intent intake, duplication/strategy check, capability registration verdict, compound learning feedback, lifecycle/ABCd in spec authoring) lived only in `.claude/`. This release brings the portable bundle to parity. Bundle is now ready to ship to other dev environments.

**Added:**
- `.claude/agents/reality-checker.md` — post-pr-reviewer evidence-demanding verifier (was deployed at 2.2 but never copied to portable).
- `.claude/agents/incident-commander.md` — production incident coordinator (inline playbook). SEV classification, timeline scribe, hotfix handoff, post-mortem drive. Distinct from hotfix.
- `docs/incident-response.md` — SEV matrix (four levels), on-call expectations, timeline-log format, post-mortem template.

**Changed:**
- `.claude/agents/feature-coordinator.md` — branch-level review pass §8.4 inserts `reality-checker` between `pr-reviewer` and `dual-reviewer`.
- `.claude/agents/spec-coordinator.md` — Step 3 "Intent intake" with classification branching (Trivial → `brief.md`, Standard+ → `intent.md`); Step 3a "Duplication / Strategy Check" hard-gate inserted between Step 3 and Step 4.
- `.claude/agents/finalisation-coordinator.md` — Step 6 emits combined Capability Registration verdict (eight valid strings); Step 7a "Compound Learning Feedback" inserted between Step 7 and Step 8.
- `docs/spec-authoring-checklist.md` — Section 12 (Lifecycle Declaration + ABCd Estimate templates) added.
- `docs/doc-sync.md` — `docs/capabilities.md` row carries the combined eight-string Capability Registration verdict; new row added for `docs/incident-response.md`.
- All other agent files refreshed from the deployed copy (placeholder substitutions applied; Vitest-specific test-runner references rolled back to the portable bundle's generic `npx tsx` idiom).

**Notes:**
- This release closes drift accumulated over v2.2 → v2.3 → v2.4. The portable bundle is now ready to ship to consuming repos. Adoption flow (`ADAPT.md`) and sync flow (`SYNC.md`) are unchanged.
- App-specific work (RLS migration guard, arch-guard, audit-prevention-gates baselines, `docs/capabilities.md` 10-cluster Asset Register content) is intentionally not portable and stays in the deployed tree only.

---

## 2.2.0 — 2026-05-04

**Highlights:** adds sync infrastructure for one-command framework upgrade across consuming repos. Introduces `manifest.json` (file ownership declaration), `sync.js` (deterministic sync engine, ~300 lines JS with JSDoc types), and `SYNC.md` (guided upgrade prompt for Claude sessions). Migrates placeholder format from `[PROJECT_NAME]` to canonical `{{PROJECT_NAME}}` (double-brace) across all agent files and docs. ADAPT.md Phase 6 now records adoption state in `.claude/.framework-state.json` for future syncs.

**Breaking:** NONE (additive — old `[…]` placeholders are ignored by sync.js, but ADAPT.md authors must use `{{...}}` format from this version forward).

**Added:**
- `setup/portable/manifest.json` — declares which files are framework-managed, their sync mode, and substitution behaviour.
- `setup/portable/sync.js` — the sync engine: reads manifest, classifies per-file state (clean/customised/new), applies substitutions, writes framework updates or `.framework-new` siblings for manual merge. Atomic state write. Flags: `--adopt`, `--dry-run`, `--check`, `--strict`, `--doctor`, `--force`.
- `setup/portable/SYNC.md` — guided upgrade walkthrough prompt. Claude reads it to walk the operator through a framework upgrade (diff versions, dry-run, run sync, resolve merges, verify, commit).
- `setup/portable/tests/` — unit and end-to-end tests for the sync engine (helpers, walk/classify, substitution, settings-merge, flags, e2e-adopt, e2e-sync, e2e-merge).

**Changed:**
- `setup/portable/ADAPT.md` — Phase 2 substitution table updated to `{{...}}` format; Phase 6 added (record adoption state with `sync.js --adopt`).
- `setup/portable/README.md` — updated to describe submodule + sync model; mentions SYNC.md for upgrades; documents `{{...}}` placeholder format.
- Placeholder format migrated across 14 source files in `setup/portable/` (agent files, docs, references).
- `scripts/build-portable-framework.ts` — preflight scan now also detects legacy `[PROJECT_NAME]`-style placeholders as errors. `FORBIDDEN_STRINGS` blacklist expanded with `AutomationOS` (no-space variant) and case variants (`automation-os`, `automation_os`, `automation_v1`, `automationV1`, lowercase / uppercase Synthetos) to catch project-name leakage that the original list missed.
- `scripts/build-portable-framework.ts` — added `assertZipBinaryAvailable()` preflight before invoking `zip` on POSIX, with installation hints for apt / apk / brew so minimal containers fail with a clear error instead of cryptic ENOENT.
- `package.json` — added `test:portable-framework` script (`node --import tsx --test setup/portable/tests/*.test.ts`) and `.github/workflows/ci.yml` `portable_framework_tests` unconditional CI gate that runs the same script on every PR.

**Fixed:**
- Placeholder format consistency: all `[PROJECT_NAME]` occurrences in portable bundle migrated to `{{PROJECT_NAME}}`.
- Two `AutomationOS` (no-space variant) leaks in `setup/portable/.claude/agents/audit-runner.md` replaced with `{{PROJECT_NAME}}`. The forbidden-string scanner only caught `Automation OS` (with space) before this release; both variants are now caught.

**Notes:**
- Version authority is now explicit: `setup/portable/.claude/CHANGELOG.md` (this file) is canonical; `.claude/CHANGELOG.md` in any consuming repo is a deployment marker. See the deployment-marker file's § *Version authority — single source of truth* for the rules.

---

## 2.1.0 — 2026-05-04

**Highlights:** adds in-repo portable bundle infrastructure so the framework can be reproducibly exported to other repos. Adds the SessionStart hook for self-healing code-intelligence cache. Adds the `validate-setup` agent for ongoing framework health checks.

**Added:**
- `setup/portable/` — in-repo source of truth for the export bundle. Mirrors the agent fleet, hooks, and conventions with placeholders substituted at adoption time.
- `setup/portable/ADAPT.md` — master prompt for adapting the framework to a target repo (5-phase walkthrough + profile selector MINIMAL/STANDARD/FULL).
- `setup/portable/README.md` — drop-in instructions for target repos.
- `scripts/build-portable-framework.ts` — preflight-checks the bundle source (forbidden-string scan, conflict-marker scan, agent-count sanity, FRAMEWORK_VERSION ↔ CHANGELOG check) and produces a versioned zip at `dist/portable-claude-framework-v<VERSION>.zip`.
- `.claude/hooks/code-graph-freshness-check.js` — SessionStart hook. Detects a dead code-intelligence watcher at session start and rebuilds the cache plus respawns the watcher in-process. Steady-state cost <200ms; degrades gracefully when the cache build script is absent (so target repos that haven't adopted the cache infra still work).
- `.claude/agents/validate-setup.md` — read-only health-checker. Verifies every agent's referenced files exist, every context-pack anchor resolves in `architecture.md`, ADR index matches files on disk, FRAMEWORK_VERSION matches CHANGELOG, every hook is registered in settings.json. Use periodically to catch drift, or as a pre-merge gate for framework PRs.

**Changed:**
- `.claude/settings.json` — added `SessionStart` hook block for `code-graph-freshness-check`.
- `CLAUDE.md` § Code intelligence artifacts — three-tier refresh model (automatic via SessionStart hook / live during dev / manual). Adds explicit fallback for repos without the cache infra. Reframed as "(optional infra)" so target repos can adopt the cache later.

**Fixed:**
- `.claude/agents/hotfix.md` (internal) — replaced leftover `[PROJECT_NAME]` placeholder with the project name in the internal copy. Portable bundle's copy uses the canonical `{{PROJECT_NAME}}` format.

---

## 2.0.0 — 2026-05-03

**Highlights:** major refactor of the agent fleet for cross-repo portability. Adds ADR convention, mode-scoped context packs, hotfix path, and a stack-neutral templating layer (ADAPT.md). Extracts duplicated boilerplate to references/. Removes hardcoded JS-stack assumptions from the framework core.

**Breaking:**
- Agent file `Context Loading` blocks for `architect`, `pr-reviewer`, `spec-conformance`, `adversarial-reviewer` now reference architecture.md anchor IDs (e.g. `architecture.md#service-layer`) instead of section names. **If you renamed sections in your architecture.md, you must regenerate anchors via the script in tasks/builds/_example/ or run ADAPT.md again.**
- "Test gates are CI-only" boilerplate moved from individual agent files to `references/test-gate-policy.md`. Agents now reference the file. **No-op for operators**, but if you forked an agent file before this version, your fork still has the duplicated boilerplate.

**Added:**
- `.claude/agents/hotfix.md` — fast-path coordinator for time-critical fixes.
- `.claude/agents/context-pack-loader.md` — inline playbook that loads a mode-scoped slice of architecture.md instead of the full file.
- `.claude/agents/codebase-explainer.md` — produces human-facing onboarding tour at `docs/codebase-tour.md`.
- `docs/decisions/` — ADR convention with template + 5 inaugural ADRs.
- `docs/context-packs/` — five mode-scoped packs (review / implement / debug / handover / minimal).
- `references/test-gate-policy.md` — single source of truth for the "test gates are CI-only" rule.
- `references/spec-review-directional-signals.md` — extracted from spec-reviewer.md (was 70 lines of inline bullet lists).
- `references/verification-commands.md` — stack-specific lint/typecheck/test commands template (portable zip only).
- 54 HTML anchors in `architecture.md` so context-packs can splice precisely.
- `Status:` header convention for specs (see `docs/spec-authoring-checklist.md` § 11) — enables future archive sweeps.
- `last_reviewed_at` / `stale_after_days` / `stale_blocks_at_days` staleness gate in `docs/spec-context.md`. `spec-reviewer` enforces it before iteration 1.
- `.claude/FRAMEWORK_VERSION` + this CHANGELOG for cross-repo drift detection.

**Changed:**
- `KNOWLEDGE.md` preamble now distinguishes observations / gotchas / corrections (KNOWLEDGE) from architectural decisions (ADRs in `docs/decisions/`).
- `spec-reviewer.md` slimmed (575 → 509 lines) by extracting the directional-signals classifier.
- `architecture.md` cross-link from `references/project-map.md` softened to "optional infra" — no longer claims the cache always exists.

**Deprecated:**
- "Decision" category in KNOWLEDGE.md — write an ADR in `docs/decisions/` instead. Existing entries stay; new entries should not use this category.

**Removed:**
- `quality-checker-gpt.md` (legacy GPT pipeline doc) — moved to `docs/_archive/`.

**Fixed:**
- 9 fully-resolved sections in `tasks/todo.md` archived to `tasks/todo-archive/2026-Q2.md`.
- `replit.md` is now cross-linked from `CLAUDE.md` (was load-bearing but undocumented).
- `references/` directory presence treated as optional in `CLAUDE.md` and `architect.md` (was previously assumed always-present).

---

## 1.0.0 — predates this changelog

The original {{PROJECT_NAME}} internal setup. Agent fleet of 16, three-coordinator pipeline, ChatGPT review agents, doc-sync sweep, audit framework. No formal version tracking.
