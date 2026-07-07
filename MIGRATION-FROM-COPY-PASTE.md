# Migrating from a partial copy-paste

> Use this when a target repo has SOME of the framework files (you copy-pasted the agents you needed earlier) but never ran `ADAPT.md` and never adopted the sync engine. The goal: catch the target up to the current framework version without overwriting its customisations.

This is the safe upgrade path for the dev environments you've been hand-curating. It avoids the two failure modes of "just run sync.js":

1. **No `.framework-state.json` exists** — sync.js can't tell which of your files are framework-original vs. locally edited, so it conservatively flags everything as customised and produces `.framework-new` siblings for every file. You end up doing the manual merge for the whole bundle.
2. **Files you renamed or split locally** — sync.js sees them as missing-from-bundle and bundle-files-not-present, and ships new copies of the framework versions alongside.

The guide below avoids both by doing the diff first, then running `sync.js --adopt` once your tree matches the bundle shape.

## When to use this guide vs. `ADAPT.md` vs. `SYNC.md`

| Situation | Use |
|---|---|
| Target repo has NO framework files yet | `ADAPT.md` |
| Target repo has the framework AND a `.claude/.framework-state.json` | `SYNC.md` |
| Target repo has SOME framework files, no state file, manual paste history | **this guide** |

## 0 — Inventory the target repo

Before touching anything, run this in the target repo to take stock:

```bash
# What framework files exist?
ls .claude/agents/ 2>/dev/null
ls .claude/hooks/ 2>/dev/null
ls docs/decisions/ 2>/dev/null
ls docs/context-packs/ 2>/dev/null
ls references/ 2>/dev/null
test -f .claude/FRAMEWORK_VERSION && cat .claude/FRAMEWORK_VERSION || echo "no version file"
test -f .claude/.framework-state.json && echo "state file present" || echo "no state file"
```

Capture the output. You'll diff against the bundle.

## 1 — Get the framework into the target repo

This repo IS the standalone framework repo. Pick one of these paths:

**A. Git submodule (recommended).** If you plan to keep upgrading:
```bash
cd <target-repo>
git submodule add <this-repo-url> .claude-framework
```

**B. One-shot copy (fastest for a single bring-across):**
```bash
cd <target-repo>
mkdir -p .claude-framework
cp -r <local-clone-of-this-repo>/* .claude-framework/
cp -r <local-clone-of-this-repo>/.claude .claude-framework/.claude
```

Either way, you now have the current framework at `.claude-framework/` in the target repo.

## 2 — Diff target agents against bundle agents

```bash
cd <target-repo>
for f in .claude-framework/.claude/agents/*.md; do
  name=$(basename "$f")
  if [ -f ".claude/agents/$name" ]; then
    if ! diff -q ".claude/agents/$name" "$f" > /dev/null 2>&1; then
      echo "DIFFERS: $name"
    fi
  else
    echo "MISSING: $name"
  fi
done
```

You'll see two categories:
- `MISSING: <agent>` — the target doesn't have this agent. Decide per agent if you want it (see § 4).
- `DIFFERS: <agent>` — the target's copy has drifted from the bundle. Some drift is the bundle's `{{PROJECT_NAME}}` vs. your substituted project name (expected); some is genuine customisation you made.

For each `DIFFERS:`, eyeball the diff:
```bash
diff .claude/agents/<name>.md .claude-framework/.claude/agents/<name>.md
```

Three patterns:
- **Pure substitution drift** (your project name where the bundle has `{{PROJECT_NAME}}`): safe to overwrite from bundle after Phase 3 below — the substitution gets re-applied.
- **Framework updates you missed** (bundle has new sections, your file is older): adopt the bundle version.
- **Your customisation** (you edited the agent to call a project-specific script or pattern): keep your version. Note it in `tasks/todo.md` so a future sync knows.

## 3 — Seed substitutions, then run `sync.js --adopt` to establish a baseline

This is the safest one-shot path. It catalogues every file as "framework-original" without overwriting anything customised.

**3a — Seed the substitution map first.** Sync never prompts for anything — `--adopt` reads substitution values from `.claude/.framework-state.json`. Write a minimal state file before running it (this is the same step as `ADAPT.md` Phase 6b):

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

Save it to `.claude/.framework-state.json`. The `frameworkVersion: "0.0.0"` placeholder tells sync that everything needs to be catalogued.

**3b — Run adopt:**

```bash
cd <target-repo>
node .claude-framework/sync.js --adopt
```

What `--adopt` does:
- Reads `.claude-framework/manifest.json` to know which files are framework-managed.
- For each managed file that exists in the target: compares its content against the framework canonical. If they match, it records the file as clean in `.claude/.framework-state.json` (`customisedLocally: false`). If they diverge, it records the local hash with `customisedLocally: true` AND writes a `<file>.framework-new` sibling containing the framework's version, so you can merge deliberately (Phase 5 of `SYNC.md` walks the merge).
- For each managed file that does NOT exist in the target: copies the framework's version, applying the substitutions (`{{PROJECT_NAME}}` etc.) from the state file you seeded in 3a. No prompting happens — if a raw placeholder survives into a written file, the substitution map was incomplete; fix the map and re-run `--adopt`.
- Writes the state file. Does NOT touch files marked `doNotTouch` (CLAUDE.md, KNOWLEDGE.md, architecture.md, DEVELOPMENT_GUIDELINES.md, `tasks/**`).

After `--adopt`, the target repo has:
- A `.claude/.framework-state.json` recording exactly which files came from the framework.
- Every missing agent / doc filled in from the bundle.
- Every locally-customised file preserved untouched, flagged in state, with a `.framework-new` sibling to merge at your leisure.

This is the migration's actual cutover. From here on, future framework updates are one command (`node .claude-framework/sync.js`).

## 4 — Decide which new agents to keep

If you copy-pasted only MINIMAL or STANDARD agents previously, `--adopt` will have copied in:
- `incident-commander` (production incident coordinator)
- Plus any other agents the target was missing

(Note: `reality-checker` was retired in framework 2.21.0 — it no longer ships.)

If you DON'T want a particular agent (e.g. the target doesn't run incident-commander), delete the file AND add its path to `syncIgnore` in `.claude/.framework-state.json`:
```bash
rm .claude/agents/incident-commander.md
# then add ".claude/agents/incident-commander.md" to the syncIgnore array in .claude/.framework-state.json
```

The `syncIgnore` entry is what makes the deletion stick: without it, a file with no state entry is treated as new and re-deployed on the next sync, and a file WITH a state entry shows up as a `.framework-new` conflict nag every version bump.

## 5 — Verify nothing broke

```bash
# 1. Settings.json hooks still wire correctly
cat .claude/settings.json | grep -A2 "hooks"

# 2. No leftover {{PLACEHOLDER}} strings
grep -r "{{PROJECT" .claude/ docs/ references/ 2>/dev/null | head -20
# If anything appears, sync didn't substitute it. Fix the `substitutions` map in
# .claude/.framework-state.json, then re-run `--adopt`.

# 3. Open Claude Code in the target repo, type /agents, confirm the list shows expected names.

# 4. Open the target repo's CLAUDE.md and confirm the agent-fleet table is up-to-date.
#    If you added incident-commander, you may need to add rows manually
#    (CLAUDE.md is in `doNotTouch` — sync.js will not edit it).
```

## 6 — Commit

```bash
cd <target-repo>
git add .claude/ docs/decisions/ docs/context-packs/ docs/incident-response.md docs/spec-authoring-checklist.md docs/doc-sync.md references/
git add .claude-framework  # if you went the submodule route
git commit -m "framework: adopt v<current framework version> via migration-from-copy-paste"
```

## Pulling future updates

This repo is already the standalone framework repo — no publishing/lift step remains. If you went the submodule route (option A above), future framework updates flow with:

```bash
cd .claude-framework && git pull && cd .. && node .claude-framework/sync.js
```

If you went the one-shot-copy route (option B), each upgrade is a fresh copy of the framework repo into `.claude-framework/` followed by `node .claude-framework/sync.js`. Works fine; manual but simple. Switch to the submodule whenever the manual copies get old.

## Common pitfalls

- **Running `sync.js` without `--adopt` on a target that has no state file.** Sync.js will refuse and tell you to run `--adopt` first. Do not pass `--force` to bypass — you'll overwrite customisations silently.
- **Leaving placeholder leakage.** If you see a raw `{{PROJECT_NAME}}`-style placeholder — or another project's name — in any agent file after `--adopt`, the framework files weren't fully substituted. Double-check the `substitutions` map in `.claude/.framework-state.json` (sync never prompts — that map is the only source of values), then re-run `--adopt`.
- **Trying to merge by hand instead of via `.framework-new`.** When future `sync.js` runs find a customised file with bundle updates, they write the new bundle version to `<file>.framework-new` next to your customised version. Merge by hand, then delete `.framework-new`. Do not edit the state file directly.
- **Adopting on a dirty branch.** The sync engine refuses if the working tree has uncommitted changes to managed files. Commit first.
