# Portable Claude Code Framework — drop-in bundle

Version: see `.claude/FRAMEWORK_VERSION`. Changelog: `.claude/CHANGELOG.md`.

## What this is

A portable agent fleet + governance docs + hooks for Claude Code projects. Drops alongside your existing repo structure; doesn't replace your CLAUDE.md, architecture.md, or KNOWLEDGE.md (you keep your own).

## Quick start (5 minutes)

1. **Extract** the bundle into your repo at `setup/portable/` (or any path you like — Claude follows `ADAPT.md` from wherever it lives).
2. **Open the target repo** in Claude Code on Opus.
3. **Paste** this prompt:
   ```
   Read setup/portable/ADAPT.md in full and execute the phases.
   Profile: STANDARD
   Project name: <your project name>
   Project description: <one short clause>
   Stack: <comma-separated stack description>
   Company name: <your company> (or "skip")
   ```
4. Claude walks the 5 phases (placement → profile prune → substitute → customise → wire → verify). ~30 minutes for STANDARD profile.

If you don't know which profile to pick, use STANDARD. See `ADAPT.md` § 11 for differences.

## Placeholder format

Agent files and docs use `{{PROJECT_NAME}}`, `{{PROJECT_DESCRIPTION}}`, `{{STACK_DESCRIPTION}}`, and `{{COMPANY_NAME}}` as substitution placeholders (double-brace format). Phase 2 of `ADAPT.md` replaces them with your project's values. Do not use the old single-bracket format `[PROJECT_NAME]` — the build script flags any remaining old-format occurrences as errors.

## What ships

| Path | Contents |
|------|----------|
| `.claude/agents/` | 20 agent definitions (with `{{...}}` placeholders) |
| `.claude/hooks/` | 4 portable hooks: `long-doc-guard`, `correction-nudge`, `config-protection`, `code-graph-freshness-check` |
| `.claude/settings.json` | Hook registration (PreToolUse, UserPromptSubmit, SessionStart) |
| `.claude/FRAMEWORK_VERSION` | Semver — used to detect drift across repos |
| `.claude/CHANGELOG.md` | Framework history + upgrade protocol |
| `docs/decisions/` | 3 ADRs + README + template |
| `docs/context-packs/` | 5 mode-scoped packs (review / implement / debug / handover / minimal) |
| `docs/spec-context.md` | Framing-assumptions template (operator fills in) |
| `docs/spec-authoring-checklist.md` | Pre-spec checklist + Status header convention |
| `docs/frontend-design-principles.md` | 5 hard rules (stack-neutral) |
| `docs/frontend-design-examples.md` | Origin-project worked examples (operator deletes or replaces) |
| `docs/doc-sync.md` | Doc-sync sweep contract (registry of reference docs to keep current) |
| `references/test-gate-policy.md` | "Test gates are CI-only" rule, single source of truth |
| `references/spec-review-directional-signals.md` | Classifier signals for `spec-reviewer` |
| `references/verification-commands.md` | Stack-template lint/typecheck/build/test commands |
| `tasks/` | Empty scaffolding (current-focus, todo, ideas, bugs, lessons, runbooks/, review-logs/, builds/_example/) |
| `ADAPT.md` | Master prompt — Claude reads this and walks adoption |
| `manifest.json` | File ownership declaration — lists every managed path, mode, and substitution rules |
| `sync.js` | Sync engine — one-command upgrade (`node .claude-framework/sync.js`) |
| `SYNC.md` | Guided upgrade walkthrough for Claude — operator pastes a short prompt; Claude walks the phases |
| `README.md` | This file |

## What this bundle does NOT ship

- **`CLAUDE.md`** — yours stays. Phase 4 of ADAPT.md adds framework sections to your existing CLAUDE.md (or scaffolds a new one if absent).
- **`architecture.md`** — yours stays. Phase 3b regenerates anchors so context packs splice precisely.
- **`KNOWLEDGE.md`** — yours stays. Bundle's preamble convention is described in `.claude/CHANGELOG.md`.
- **Project-specific code intelligence** — `scripts/build-code-graph.ts` is not included. The cache-freshness hook degrades gracefully when the script is absent.
- **Project-specific hooks** — `arch-guard.sh` and `rls-migration-guard.js` are origin-project specific (RLS / multi-tenant) and intentionally not portable.
- **Origin-project-specific ADRs** — only ADRs 0001, 0002, 0005 ship (the framework patterns). 0003 and 0004 stay in the origin repo.

## Profiles

Pick at adoption time:

- **MINIMAL (4)** — `triage-agent`, `pr-reviewer`, `architect`, `spec-reviewer`. Solo dev, self-review baseline.
- **STANDARD (10)** — MINIMAL + `spec-coordinator`, `feature-coordinator`, `finalisation-coordinator`, `spec-conformance`, `builder`, `hotfix`. Default for most projects.
- **FULL (20)** — STANDARD + `adversarial-reviewer`, `audit-runner`, `chatgpt-pr-review`, `chatgpt-spec-review`, `chatgpt-plan-review`, `codebase-explainer`, `context-pack-loader`, `dual-reviewer`, `mockup-designer`, `validate-setup`. Large projects with capacity for the overhead.

## Upgrading from a previous framework version

For ongoing upgrades, see `SYNC.md`. When the framework releases a new version, update your submodule pointer and run `node .claude-framework/sync.js` — SYNC.md walks the upgrade phases (diff versions, read changelog, dry-run, apply, merge customised files, verify, commit).

Don't re-run `ADAPT.md` — it expects fresh placeholders, and your repo already has substituted values. Instead, use the sync engine: update the `.claude-framework/` submodule to the new framework version, then follow SYNC.md.

## Source

This bundle is generated from the source repo's `setup/portable/` directory by `scripts/build-portable-framework.ts`. To pull a refreshed bundle from the source repo:

```
npx tsx scripts/build-portable-framework.ts
# or, if the source repo registers it as an npm script:
# npm run build:portable-framework
```

That produces `dist/portable-claude-framework-v<VERSION>.zip` — copy into your target repo and follow the Quick start above.

## Support

- Bundle issues: open against the source repo (the repo this bundle was generated from).
- Adoption issues: re-read `ADAPT.md` § 12 (common pitfalls) before reporting.
