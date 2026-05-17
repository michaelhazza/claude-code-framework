# Migrating from a partial copy-paste

> Use this when a target repo has SOME of the framework files (you copy-pasted the agents you needed earlier) but never ran `ADAPT.md` and never adopted the sync engine. The goal: catch the target up to framework v2.4.0 without overwriting its customisations.

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

## 1 — Get the v2.4.0 bundle into the target repo

Pick one of these paths:

**A. Git submodule (recommended long-term).** If you plan to keep upgrading:
```bash
# In the framework source repo (this repo), publish setup/portable/ to a separate GitHub repo first (see "Phase B" below). Then in the target:
cd <target-repo>
git submodule add <framework-repo-url> .claude-framework
```

**B. One-shot copy (fastest for a single bring-across).** Until you do Phase B, this is fine:
```bash
cd <target-repo>
mkdir -p .claude-framework
cp -r <this-repo>/setup/portable/* .claude-framework/
cp -r <this-repo>/setup/portable/.claude .claude-framework/.claude
```

Either way, you now have the v2.4.0 bundle at `.claude-framework/` in the target repo.

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

## 3 — Run `sync.js --adopt` to establish a baseline

This is the safest one-shot path. It catalogues every file as "framework-original" without overwriting anything customised:

```bash
cd <target-repo>
node .claude-framework/sync.js --adopt
```

What `--adopt` does:
- Reads `.claude-framework/manifest.json` to know which files are framework-managed.
- For each managed file that exists in the target: hashes it, records the hash in `.claude/.framework-state.json` as `lastAppliedHash`, marks `customisedLocally: true` if the hash differs from the bundle's hash.
- For each managed file that does NOT exist in the target: copies the bundle's version verbatim (substituting `{{PROJECT_NAME}}` etc. at this step — `--adopt` prompts for substitution values OR re-uses whatever the operator provided last time if a stale `lastSubstitutionHash` is present).
- Writes the state file. Does NOT touch files marked `doNotTouch` (CLAUDE.md, KNOWLEDGE.md, architecture.md, DEVELOPMENT_GUIDELINES.md, `tasks/**`).

After `--adopt`, the target repo has:
- A `.claude/.framework-state.json` recording exactly which files came from the framework.
- Every missing agent / doc filled in from the bundle.
- Every locally-customised file preserved untouched, but flagged in state so future syncs know.

This is the migration's actual cutover. From here on, future framework updates are one command (`node .claude-framework/sync.js`).

## 4 — Decide which new agents to keep

If you copy-pasted only MINIMAL or STANDARD agents previously, `--adopt` will have copied in:
- `reality-checker` (new in v2.2 — post-pr-reviewer evidence verifier)
- `incident-commander` (new in v2.3 — production incident coordinator)
- Plus any other agents the target was missing

If you DON'T want a particular agent (e.g. the target doesn't run incident-commander), just delete the file:
```bash
rm .claude/agents/incident-commander.md
```

This is safe — the framework treats missing agent files as "not adopted". Future sync runs won't re-add deleted agents unless you ask.

## 5 — Verify nothing broke

```bash
# 1. Settings.json hooks still wire correctly
cat .claude/settings.json | grep -A2 "hooks"

# 2. No leftover {{PLACEHOLDER}} strings
grep -r "{{PROJECT" .claude/ docs/ references/ 2>/dev/null | head -20
# If anything appears, sync didn't substitute it. Re-run `--adopt` with the correct substitution values.

# 3. Open Claude Code in the target repo, type /agents, confirm the list shows expected names.

# 4. Open the target repo's CLAUDE.md and confirm the agent-fleet table is up-to-date.
#    If you added reality-checker or incident-commander, you may need to add rows manually
#    (CLAUDE.md is in `doNotTouch` — sync.js will not edit it).
```

## 6 — Commit

```bash
cd <target-repo>
git add .claude/ docs/decisions/ docs/context-packs/ docs/incident-response.md docs/spec-authoring-checklist.md docs/doc-sync.md references/
git add .claude-framework  # if you went the submodule route
git commit -m "framework: adopt v2.4.0 via migration-from-copy-paste"
```

## What about Phase B (separate GitHub repo)?

If you want every target repo to pull future framework updates with a single `git pull` on a submodule, the framework needs to live in its own GitHub repo. Today the bundle lives in this repo at `setup/portable/`.

The spec for the lift is at `tasks/builds/framework-standalone-repo/spec.md`. The submodule + sync.js pattern was Phase A and shipped (PR #257). Phase B is the actual lift to a standalone GitHub repo and was NOT executed.

You can either:
- Stay on the in-repo bundle. Every target uses `cp -r <this-repo>/setup/portable/* .claude-framework/` to receive new versions, then runs `sync.js`. Works fine; manual but simple.
- Execute Phase B now (~half a day): create a new GitHub repo (e.g. `claude-code-framework`), copy `setup/portable/` contents in as the new repo's root, push, then each target repo adds it as a submodule (`git submodule add <new-repo-url> .claude-framework`). After that, framework updates flow with `cd .claude-framework && git pull && cd .. && node .claude-framework/sync.js`.

Phase B is what makes this stop being manual work. Without it, every target's "catch up to v2.5.0" is a copy-paste of the bundle.

## Common pitfalls

- **Running `sync.js` without `--adopt` on a target that has no state file.** Sync.js will refuse and tell you to run `--adopt` first. Do not pass `--force` to bypass — you'll overwrite customisations silently.
- **Leaving `Automation OS` placeholder leakage.** If you see `Automation OS` in any agent file after `--adopt`, the bundle wasn't fully substituted. Re-run `--adopt` and double-check you provided `{{PROJECT_NAME}}` at the substitution prompt.
- **Trying to merge by hand instead of via `.framework-new`.** When future `sync.js` runs find a customised file with bundle updates, they write the new bundle version to `<file>.framework-new` next to your customised version. Merge by hand, then delete `.framework-new`. Do not edit the state file directly.
- **Adopting on a dirty branch.** The sync engine refuses if the working tree has uncommitted changes to managed files. Commit first.
