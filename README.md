# Portable Claude Code Framework

Version: see `.claude/FRAMEWORK_VERSION`. Changelog: `.claude/CHANGELOG.md`.

## What this is

A portable agent fleet + governance docs + hooks for Claude Code projects. This repo is the standalone framework repo — consuming repos add it as a git submodule at `.claude-framework/`. It lands alongside your existing repo structure; it doesn't replace your CLAUDE.md, architecture.md, or KNOWLEDGE.md (you keep your own).

## Quick start (5 minutes)

1. **Add the submodule** in your repo: `git submodule add <this-repo-url> .claude-framework`
2. **Open the target repo** in Claude Code on Opus.
3. **Paste** this prompt:
   ```
   Read .claude-framework/ADAPT.md in full and execute the phases.
   Profile: STANDARD
   Project name: <your project name>
   Project description: <one short clause>
   Stack: <comma-separated stack description>
   Company name: <your company> (or "skip")
   ```
4. Claude walks the phases (placement → profile prune → substitute → customise → wire → verify → record adoption state). ~30 minutes for STANDARD profile.

If you don't know which profile to pick, use STANDARD. See `ADAPT.md` § 12 for differences.

## Placeholder format

Agent files and docs use `{{PROJECT_NAME}}`, `{{PROJECT_DESCRIPTION}}`, `{{STACK_DESCRIPTION}}`, and `{{COMPANY_NAME}}` as substitution placeholders (double-brace format). Phase 2 of `ADAPT.md` replaces them with your project's values. Do not use the old single-bracket format `[PROJECT_NAME]` — the build script flags any remaining old-format occurrences as errors.

## What ships

| Path | Contents |
|------|----------|
| `.claude/agents/` | 29 agent definitions (with `{{...}}` placeholders; `_retired/` excluded) |
| `.claude/commands/` | 8 operator commands: `/claudeupdate` (one-shot framework bump across repos), `/claudemerge` (guided `.framework-new` conflict merge), `/framework-init` (first-time adoption entry point), `/framework-doctor` (framework health diagnosis), `/release` (framework release flow), `/fix-ci-gate-debt` (bounded gate-debt fix loop), `/cleanfiles` (repo-maintenance sweep of accumulating working files), `/eval-prompts` (golden-set prompt eval runner — catch/false-alarm rate vs a pinned baseline) |
| `.claude/hooks/` | 11 portable hooks: `long-doc-guard`, `correction-nudge`, `config-protection`, `code-graph-freshness-check`, `spec-creation-grill-nudge`, `phase-lock`, `bash-config-guard`, `framework-merge-reminder`, `knowledge-append-guard`, `memory-digest`, `wargame-nudge` |
| `.claude/skills/` | 22 portable skills: grill-me, zoom-out, fable-mode (reasoning-discipline overlay for judgment-heavy work on any model tier), wargame (risky-operation planning artifact), and 18 distilled-judgment skills (tenant-isolation, postgres-migrations, db-concurrency, wire-it-through, fail-loud, ci-gate-integrity, test-discipline, review-triage, spec-hygiene, frontend-correctness, security-hardening, frontend-design-check, refactor-safely, llm-integration, dependency-upgrades, performance, logging-observability, deprecation) |
| `.claude/settings.json` | Hook registration (PreToolUse, UserPromptSubmit, SessionStart) |
| `.claude/context/agent-context.md` | Fleet-wide project-context template (adopt-only) — the ADR-0006 home for per-repo agent operating notes |
| `.claude/context/skill-context.md` | Per-skill project-context template (adopt-only) — the home for repo-specific skill failure modes / corrections; paired with the pointer line every SKILL.md carries |
| `.claude/project-registries.json.template` | Sibling-repo registry template for `cross-repo-scout` (+ worked example) |
| `.claude/FRAMEWORK_VERSION` | Semver — used to detect drift across repos |
| `.claude/CHANGELOG.md` | Framework history + upgrade protocol |
| `docs/decisions/` | 7 ADRs (0001, 0002, 0005–0008, 0014) + README + template |
| `docs/context-packs/` | 5 mode-scoped packs (review / implement / debug / handover / minimal) |
| `docs/spec-context.md` | Framing-assumptions template (operator fills in) |
| `docs/spec-authoring-checklist.md` | Pre-spec checklist + Status header convention |
| `docs/frontend-design-principles.md` | Consumer-simple UI doctrine: primary rule (start from the user's task, not the data model), pre-design checklist, ship/defer defaults, visuals-as-simplicity, complexity budget, progressive disclosure, grounding + behaviour-manifest contract, when-to-break rules |
| `docs/frontend-design-examples.md` | Origin-project worked examples (operator deletes or replaces) |
| `docs/design-language-template.md` | Visual-identity scaffold (type, colour tokens, spacing, motion, craft bar) — pair of the design-principles doc |
| `docs/mobile-capability-principles.md` | Mobile shape and behaviour rules — read alongside the design principles for every UI artifact |
| `docs/accessibility-checklist.md` | WCAG 2.1 AA baseline for operator-facing UI — consumed by `frontend-design-check` and mockup-reviewer Axis 3.5 |
| `docs/behaviour-manifest-template.md` | Per-screen interaction-contract checklist for UI builds (adopt-only) |
| `docs/doc-sync.md` | Doc-sync sweep contract (registry of reference docs to keep current) |
| `docs/incident-response.md` | SEV matrix, on-call expectations, timeline-log format, post-mortem template (paired with `incident-commander` agent) |
| `docs/review-pipeline/parallel-mode.md` | Parallel ChatGPT-review mode (OpenAI API + manual web side-by-side) |
| `docs/agent-selection.md` | One-page decision tree: operator intent → agent/command, plus runtime FAQ |
| `docs/capabilities-template.md` | Capabilities-registry skeleton (Asset Register, lifecycle states, editorial rules) — scaffold your `docs/capabilities.md` from it |
| `docs/codebase-audit-framework-template.md` | Codebase-audit operating manual skeleton (Layer 1 cleanup areas, Layer 2 generic modules, Scope Guard, audit modes) — pairs with `audit-runner` |
| `references/test-gate-policy.md` | "Test gates are CI-only" rule, single source of truth |
| `references/spec-review-directional-signals.md` | Classifier signals for `spec-reviewer` |
| `references/verification-commands.md` | Stack-template lint/typecheck/build/test commands |
| `references/iteration-caps.md` | Lifetime iteration caps per review tier, single source of truth |
| `references/review-mode-resolution.md` | How ChatGPT-review mode (manual / automated / parallel) is resolved |
| `references/review-tier-redundancy-audit.md` | Which review tiers overlap and why each survives |
| `references/local-override-convention.md` | `LOCAL-OVERRIDE` block mechanism for non-agent managed files (deprecated for agents per ADR-0006) |
| `references/project-extensions-convention.md` | How consumer repos add their own agents/hooks/skills alongside managed ones |
| `references/skill-overlay-convention.md` | The skill-overlay mechanism: pointer line, `skill-context.md` sidecar, and the KNOWLEDGE→overlay→canonical-skill drain wired into `/cleanfiles` |
| `references/eval-suite-format.md` | Golden-set eval suite contract (`config.json` / `cases.jsonl` / `baseline.json`, verdict taxonomy, metrics) for `/eval-prompts` |
| `schemas/` | Review-result JSON Schemas (v2 contract, Ajv-gated) + input-shape schemas (`pr-context`, `prior-rounds` — advisory) + schema CHANGELOG |
| `scripts/` | Review driver (`chatgpt-review*.ts`), review coordinator library, migration runner, framework merge + validation (`framework-merge.js`, `validate-framework.js`), build-scheduler, mockup capture, code-graph + gates libraries, skill-routing evals (`skill-routing-evals*.ts` + `evals/skill-routing/` cases — framework CI only), helper scripts + their tests |
| `migrations/` | Per-version consumer migrations (run automatically by `/claudeupdate`) + `_helpers.js` + template |
| `context/` | Reviewer `PROJECT_CONTEXT` injection templates (distinct from `.claude/context/agent-context.md`) |
| `tasks/` | Empty scaffolding (current-focus, todo, ideas, bugs, lessons, runbooks/, review-logs/, builds/_example/) |
| `ADAPT.md` | Master prompt — Claude reads this and walks adoption |
| `manifest.json` | File ownership declaration — lists every managed path, mode, and substitution rules |
| `sync.js` | Sync engine — one-command upgrade (`node .claude-framework/sync.js`) |
| `SYNC.md` | Guided upgrade walkthrough for Claude — operator pastes a short prompt; Claude walks the phases |
| `CONTRIBUTING.md` | How to add agents, skills, hooks, commands; version-bump + changelog protocol; test expectations |
| `SECURITY.md` | Security posture: what executes automatically, network egress, secret handling, sync write boundaries |
| `README.md` | This file |

> **`manifest.json` is authoritative.** This table is a human-readable summary; the complete managed surface — every path, its sync mode, and its substitution rule — is declared in `manifest.json`. If this table and the manifest disagree, the manifest wins.

## What this framework does NOT ship

- **`CLAUDE.md`** — yours stays. Phase 4 of ADAPT.md adds framework sections to your existing CLAUDE.md (or scaffolds a new one if absent).
- **`architecture.md`** — yours stays. Phase 3b regenerates anchors so context packs splice precisely.
- **`KNOWLEDGE.md`** — yours stays. Bundle's preamble convention is described in `.claude/CHANGELOG.md`.
- **Project-specific code intelligence** — `scripts/build-code-graph.ts` is not included. The cache-freshness hook degrades gracefully when the script is absent.
- **Project-specific hooks** — `arch-guard.sh` and `rls-migration-guard.js` are origin-project specific (RLS / multi-tenant) and intentionally not portable.
- **Origin-project-specific ADRs** — only the framework-pattern ADRs ship (0001, 0002, 0005–0008). 0003 and 0004 stay in the origin repo.

## Profiles

Pick at adoption time:

- **MINIMAL (4)** — `triage-agent`, `pr-reviewer`, `architect`, `spec-reviewer`. Solo dev, self-review baseline.
- **STANDARD (10)** — MINIMAL + `spec-coordinator`, `feature-coordinator`, `finalisation-coordinator`, `spec-conformance`, `builder`, `hotfix`. Default for most projects.
- **FULL (29)** — STANDARD + `adversarial-reviewer`, `audit-runner`, `bug-fixer`, `chatgpt-pr-review`, `chatgpt-spec-review`, `chatgpt-plan-review`, `claude-spec-review`, `claude-plan-review`, `codebase-explainer`, `context-pack-loader`, `cross-repo-scout`, `dual-reviewer`, `experiment-runner`, `incident-commander`, `mockup-coordinator`, `mockup-designer`, `mockup-reviewer`, `regression-scribe`, `validate-setup`. Large projects with capacity for the overhead.

## Upgrading from a previous framework version

For ongoing upgrades, see `SYNC.md`. When the framework releases a new version, update your submodule pointer and run `node .claude-framework/sync.js` — SYNC.md walks the upgrade phases (diff versions, read changelog, dry-run, apply, merge customised files, verify, commit).

Don't re-run `ADAPT.md` — it expects fresh placeholders, and your repo already has substituted values. Instead, use the sync engine: update the `.claude-framework/` submodule to the new framework version, then follow SYNC.md.

## Migrating from a partial copy-paste

If you have a target repo where someone copy-pasted SOME framework files in earlier without ever running `ADAPT.md` (no `.framework-state.json`), see `MIGRATION-FROM-COPY-PASTE.md` for the safe catch-up path.

## Support

- Framework issues: open against this repo.
- Adoption issues: re-read `ADAPT.md` § 13 (common pitfalls) before reporting.
