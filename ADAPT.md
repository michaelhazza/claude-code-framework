# ADAPT.md — Master prompt for adopting the Claude Code framework

> Drop the contents of this `setup/portable/` bundle into a target repo, then ask Claude Code (Opus) to read this file and execute the phases below. The framework lands cleanly with project-specific substitutions.

## Contents

1. What this bundle is
2. Prerequisites in target repo
3. Operator inputs to gather first
4. Phase 0 — Confirm prerequisites
5. Phase 1 — File placement
6. Phase 1.5 — Profile selection + agent pruning
7. Phase 2 — Substitute placeholders
8. Phase 3 — Customise verification commands + anchors
9. Phase 4 — Wire into target CLAUDE.md
10. Phase 5 — Verify
11. Phase 6 — Record adoption state
12. Profile reference
13. Common pitfalls

---

## 1. What this bundle is

A drop-in agent fleet + governance docs + portable hooks for any Claude Code project. See `.claude/CHANGELOG.md` for the source release version and history.

The bundle ships:
- 19 agent definitions in `.claude/agents/` (with placeholders for project name, description, stack)
- 4 portable hooks in `.claude/hooks/` + a `.claude/settings.json` registering them
- ADRs at `docs/decisions/` (3 generic ones — 0001, 0002, 0005)
- Context packs at `docs/context-packs/` (5 mode-scoped packs)
- Reference docs at `references/` (test-gate-policy, spec-review-directional-signals, verification-commands template)
- Spec / doc-sync / frontend conventions at `docs/`
- Empty tasks scaffolding at `tasks/`
- Framework version + changelog at `.claude/FRAMEWORK_VERSION` + `.claude/CHANGELOG.md`

What it does NOT ship: project-specific architecture docs, KNOWLEDGE.md, CLAUDE.md. Those are the operator's. The framework is additive — it lands alongside whatever already exists.

## 2. Prerequisites in target repo

- Git repo with at least one commit on the default branch.
- `.claude/` directory may exist or not — Phase 1 handles both cases.
- A `CLAUDE.md` may exist or not — Phase 4 handles both cases.
- Claude Code installed; opening this repo on **Opus** is recommended for the adoption itself.

## 3. Operator inputs to gather first

Have these ready before starting — Phase 2 substitutes them everywhere:

| Placeholder | Example value | Notes |
|---|---|---|
| `{{PROJECT_NAME}}` | `Acme Platform` | Short, human-readable. Used in agent intros. |
| `{{PROJECT_DESCRIPTION}}` | `a customer billing platform` | One short clause. |
| `{{STACK_DESCRIPTION}}` | `Node + Express + Drizzle ORM (PostgreSQL) + React` | Comma-separated. Stack-name level, not version-pinned. |
| `{{COMPANY_NAME}}` | `Acme Inc` | Optional. If empty, lines containing it are deleted. |

Plus the **profile selection**: MINIMAL (4 agents) / STANDARD (10) / FULL (20). See § 11.

---

## 4. Phase 0 — Confirm prerequisites

Read this entire file. Verify the operator inputs above are gathered. Confirm the bundle's `setup/portable/` (or wherever it was extracted) is co-located with the target repo at a known path.

If any input is missing, stop and ask the operator. Do NOT guess.

## 5. Phase 1 — File placement

Copy bundle contents into the target repo at the matching paths:

```
setup/portable/.claude/         → <repo-root>/.claude/
setup/portable/docs/            → <repo-root>/docs/
setup/portable/references/      → <repo-root>/references/
setup/portable/tasks/           → <repo-root>/tasks/      (only if tasks/ does not exist)
```

**Conflict handling:** if a target file already exists, do NOT overwrite. Copy the bundle file to `<existing-name>.framework.md` and surface the conflict to the operator. They merge manually.

**Special cases:**
- `.claude/settings.json` — if the target already has one, MERGE the `hooks` block by appending the bundle's entries. Don't replace.
- `tasks/todo.md` — bundle ships an empty template; if the target already has a populated todo, leave it untouched.
- `.claude/FRAMEWORK_VERSION` and `.claude/CHANGELOG.md` — copy verbatim. These are tracking metadata.

After Phase 1, the target repo's lint/typecheck should still pass — the framework adds files but doesn't modify code.

## 6. Phase 1.5 — Profile selection + agent pruning

Ask the operator: "Which profile? MINIMAL (4) / STANDARD (10) / FULL (19)."

Delete agent files NOT in the chosen profile from `.claude/agents/`. See § 11 for the per-profile list.

If the operator is unsure, default to **STANDARD**. They can add agents later by copying from the bundle.

## 7. Phase 2 — Substitute placeholders

Walk every file under `.claude/agents/`, `docs/`, and `references/` and substitute:

| Find | Replace with |
|---|---|
| `{{PROJECT_NAME}}` | operator's project name |
| `{{PROJECT_DESCRIPTION}}` | operator's project description |
| `{{STACK_DESCRIPTION}}` | operator's stack description |
| `{{COMPANY_NAME}}` | operator's company name (or delete the line if empty) |

Use a deterministic find-and-replace — do NOT rewrite prose around the placeholders. The framework's tone is intentional.

After Phase 2, grep for any remaining `{{PROJECT_NAME}}` / `{{PROJECT_DESCRIPTION}}` / `{{STACK_DESCRIPTION}}` / `{{COMPANY_NAME}}`. Zero hits expected.

---

## 8. Phase 3 — Customise verification commands + anchors

### 3a — `references/verification-commands.md`

Open the file. Replace the `[PLACEHOLDER]` commands in the *Stack template* table with the target repo's actual lint / typecheck / build / targeted-test commands. Delete inapplicable rows. Optionally retain one of the worked-example tables matching the stack.

### 3b — `architecture.md` anchors (if architecture.md exists)

Context packs reference `architecture.md#<anchor>` slugs. If the target repo has an `architecture.md`:

1. Run a one-shot anchor-generation pass: insert `<a id="<kebab-case-slug>"></a>` immediately before every `## ` heading.
2. Open `docs/context-packs/*.md` and replace generic anchor names with the actual anchors generated.
3. If the target has no `architecture.md`, skip this step. The packs will fall back to whole-file reads (with warnings printed by `context-pack-loader`).

## 9. Phase 4 — Wire into target CLAUDE.md

If `CLAUDE.md` already exists in the target, append these sections (verbatim is fine — they're framework-level):

- `## Local Dev Agent Fleet` — table listing the agents in the chosen profile.
- `### Test gates are CI-only` — pointer to `references/test-gate-policy.md`.
- `### Architecture decisions (ADRs)` — pointer to `docs/decisions/`.
- `### Context packs` — pointer to `docs/context-packs/`.
- `### Agent lifecycle (add / retire)` — copy the lifecycle protocol from the bundle's source CLAUDE.md.
- `### Framework version` — pointer to `.claude/FRAMEWORK_VERSION`.

If `CLAUDE.md` does NOT exist, create a minimal scaffold containing those sections + a header naming the project. Expand as project conventions develop.

In both cases, do NOT duplicate canonical content (route conventions, schema rules) — those belong in `architecture.md`. CLAUDE.md is the entry point + governance pointer.

## 10. Phase 5 — Verify

If the `validate-setup` agent is in the chosen profile, run it:

```
validate-setup: confirm framework health
```

It checks every agent file references files that exist, every context-pack anchor resolves, and the framework version matches the changelog.

If `validate-setup` is NOT in the profile, run a manual smoke check:

1. `ls .claude/agents/` — count matches profile (4 / 10 / 20).
2. `ls .claude/hooks/` — 4 files present.
3. `cat .claude/FRAMEWORK_VERSION` — matches the bundle's version.
4. `grep -rE '\{\{PROJECT_NAME\}\}|\{\{STACK_DESCRIPTION\}\}' .claude/ docs/ references/` — zero hits.
5. `node .claude/hooks/code-graph-freshness-check.js < /dev/null` — exits 0 (degrades gracefully when the cache build script isn't present).

If any check fails, stop and report.

---

## 11. Phase 6 — Record adoption state

Now that the framework files are in place and substituted (Phases 1–5), record the adoption state so future sync runs can track which files have been customised and auto-apply framework updates.

### What this step does

Running `sync.js --adopt` scans every framework-managed file in the target repo (per `manifest.json`):
- If a file is **missing**: writes it fresh (same as Phase 1 would have done).
- If a file is **already in place**: computes its hash and records it in `.claude/.framework-state.json`. Does NOT overwrite the file.

The result is `.claude/.framework-state.json` — the adoption record. Future `sync.js` invocations use it to detect whether a file has been customised (hash mismatch) or is clean (hash matches, safe to auto-update).

### Inputs needed

From your Phase 0 and Phase 2 work, you should have:
- The 4 substitution values: `{{PROJECT_NAME}}`, `{{PROJECT_DESCRIPTION}}`, `{{STACK_DESCRIPTION}}`, `{{COMPANY_NAME}}` (and their actual values).
- The framework's location (if using submodule: `.claude-framework/`; if using a local copy: the path to the `sync.js` file).

### Steps

**6a. Confirm the framework source is reachable.**

If adopting via submodule (recommended):
```bash
ls .claude-framework/sync.js   # should exist
ls .claude-framework/.claude/FRAMEWORK_VERSION  # should print 2.2.0 or later
```

If using a local copy (e.g. `setup/portable/`):
```bash
ls sync.js
ls .claude/FRAMEWORK_VERSION
```

**6b. Write the initial substitution map.**

Before running `--adopt`, the state.json needs the substitution map. Write a minimal state.json so `--adopt` can reference it (otherwise sync may emit a warning about an empty substitution map):

```json
{
  "frameworkVersion": "0.0.0",
  "adoptedAt": "<current ISO timestamp>",
  "adoptedFromCommit": null,
  "profile": "STANDARD",
  "substitutions": {
    "PROJECT_NAME": "<your project name>",
    "PROJECT_DESCRIPTION": "<your project description>",
    "STACK_DESCRIPTION": "<your stack description>",
    "COMPANY_NAME": "<your company name>"
  },
  "lastSubstitutionHash": "",
  "files": {},
  "syncIgnore": []
}
```

Write this to `.claude/.framework-state.json`. The `frameworkVersion: "0.0.0"` placeholder tells sync that everything needs to be (re-)catalogued.

**6c. Run `--adopt` mode.**

From the target repo root:
```bash
node .claude-framework/sync.js --adopt
```

Or if using a local path:
```bash
node <path-to-sync.js> --adopt
```

Sync will print one line per file: `SYNC file=<path> status=<new|skipped|...>`. At the end, it prints a summary line with counts and updates `.claude/.framework-state.json`.

**6d. Verify.**

```bash
node .claude-framework/sync.js --doctor
```

Expected output: `DOCTOR: diagnosis complete.` with exit code 0.

Also verify the state file was written:
```bash
node -e "const s=JSON.parse(require('fs').readFileSync('.claude/.framework-state.json','utf8')); console.log('version:', s.frameworkVersion, 'files:', Object.keys(s.files).length)"
```

Expected: `version: 2.2.0 files: <N>` where N matches the number of managed files.

**6e. Commit the adoption record.**

```bash
git add .claude-framework .claude/.framework-state.json
git commit -m "feat: adopt claude-code-framework v2.2.0 as submodule"
```

### Important: framework dev location

From this point on, **do not edit framework-managed files in this target repo's generated copies** (`.claude/agents/*`, `.claude/hooks/*`, etc.). If you spot an improvement to an agent prompt, make the change in the framework repo and sync it back:

```bash
# In the framework repo
# ... make your change ...
git commit -m "fix: improve pr-reviewer prompt"
git tag v2.2.1

# In the target repo
git submodule update --remote
node .claude-framework/sync.js
```

For future upgrades, see `.claude-framework/SYNC.md` — the guided upgrade walkthrough.

---

## 12. Profile reference

### MINIMAL (4 agents) — solo dev, self-review baseline

`triage-agent`, `pr-reviewer`, `architect`, `spec-reviewer`.

Use when the project is small, the operator is solo, and the goal is "capture ideas + independent review of my own changes." No coordinator pipeline.

### STANDARD (10 agents) — small team / structured solo

MINIMAL 4 plus: `spec-coordinator`, `feature-coordinator`, `finalisation-coordinator` (the three-coordinator pipeline), `spec-conformance`, `builder`, `hotfix`.

Use when the project has multiple in-flight features and benefits from spec → plan → build phase separation. Default for most projects.

### FULL (20 agents) — large project / multi-stream development

STANDARD 10 plus: `adversarial-reviewer`, `audit-runner`, `chatgpt-pr-review`, `chatgpt-spec-review`, `chatgpt-plan-review`, `codebase-explainer`, `context-pack-loader`, `dual-reviewer`, `mockup-designer`, `validate-setup`.

Use when the project supports the overhead — `chatgpt-*` agents need ChatGPT-web access, `dual-reviewer` needs the Codex CLI, `audit-runner` needs a mature codebase to audit. Otherwise STANDARD covers it.

---

## 13. Common pitfalls

1. **Forgetting to merge `.claude/settings.json`.** If the target already had hooks, the bundle's `settings.json` will overwrite them unless you merge. Phase 1 specifies a merge — follow it.
2. **Substituting `{{PROJECT_NAME}}` to a value with regex specials.** Project names with `/`, `.`, `{`, `}` need escaping. Substitute one at a time and double-check.
3. **Pruning agents that other agents reference.** `feature-coordinator` calls `builder`, `pr-reviewer`, etc. Profiles in § 11 are pre-curated to avoid this — pick a profile, don't hand-prune mid-tier.
4. **Skipping Phase 3b but keeping context-packs that reference anchors.** Packs will fall back to whole-file reads (slow) and warn. Either run Phase 3b or accept the warnings.
5. **Running ADAPT.md a second time over an already-adapted repo.** Don't — Phase 2 substitution will turn already-substituted text into double-substituted gibberish. To upgrade, follow `.claude/CHANGELOG.md` § *Upgrade protocol* instead.
