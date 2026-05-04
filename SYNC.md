# SYNC.md — Framework Upgrade Walkthrough

---

**Operator: paste this into Claude Code (Opus) when upgrading:**

```
Read .claude-framework/SYNC.md and execute the upgrade flow.
The current framework version is in .claude-framework/.claude/FRAMEWORK_VERSION.
The target version recorded in this repo is in .claude/.framework-state.json.
```

---

## Phase 0 — Confirm prerequisites

Before touching any files, verify:

1. `.claude/.framework-state.json` exists and is readable. If it is missing or malformed, stop and tell the operator: state.json is the record of what sync last applied — without it, the upgrade cannot run safely. The operator should re-run the adoption flow or restore from git.
2. The submodule at `.claude-framework/` (or the local path where the framework source lives) is reachable and contains a `.claude/FRAMEWORK_VERSION` file.
3. The working tree is clean. Run `git status` and confirm there are no uncommitted changes. A dirty tree means the diff between before and after the sync will be hard to review.

If any check fails, state the failure clearly and stop. Do not proceed to Phase 1.

---

## Phase 1 — Diff versions

Read `.claude-framework/.claude/FRAMEWORK_VERSION` — this is the version the submodule is at (the target version). Read the `frameworkVersion` field from `.claude/.framework-state.json` — this is the version the repo is currently on.

- **Equal:** print `Already on latest (v<X>)` and exit. Nothing to do.
- **New version is lower than current:** warn the operator — `Going backward: the framework version in the submodule (v<new>) is older than what state.json records (v<current>). Confirm this is intentional before proceeding.` Wait for operator confirmation before continuing.
- **New version is higher than current:** print `Upgrading v<current> -> v<new>` and continue to Phase 2.

---

## Phase 2 — Read changelog

Read `.claude-framework/.claude/CHANGELOG.md`. Extract the entries between the current version (exclusive) and the new version (inclusive) — that is, everything the operator has not yet applied.

Present a summary with these sections:

- **Highlights:** the main themes of this upgrade in plain language.
- **Breaking:** any changes that require operator action (config edits, manual migrations, removed files). Present each breaking entry individually and explicitly warn that it needs attention.
- **Added:** new files, agents, or capabilities introduced.
- **Changed:** modified files or behaviours.

If there are Breaking entries, ask the operator to confirm each one before continuing. A breaking change ignored silently is worse than a short pause.

---

## Phase 3 — Dry-run sync

Run:

```
node .claude-framework/sync.js --dry-run
```

Show the operator the full output. The report lists which files would be updated, which are customised (and therefore get a `.framework-new` sibling rather than an overwrite), and the totals. This lets the operator understand the scope of the upgrade before anything is written to disk.

---

## Phase 4 — Run sync

Run:

```
node .claude-framework/sync.js
```

Show the full output including the end-of-run report (N updated, M new, P customised, K removal warnings, time=Xs).

**If sync exits non-zero with a substitution-drift error**, this means `state.substitutions` changed since the last sync. Sync refuses to continue because re-applying substitutions to only the files it would update would leave the already-current files frozen at the old substitution values, producing a silent inconsistency across the file set.

When this happens:

1. Ask the operator whether the substitution change is intentional.
2. Summarise the substitution map: list the key names (not the values — values may be sensitive). Example: `PROJECT_NAME`, `STACK_DESCRIPTION`, `COMPANY_NAME`.
3. Before running the rebaseline, print the following warning so the operator understands the scope:

   > This will rewrite every clean framework-managed file under the new substitution map. Customised files are preserved and get a `.framework-new` sibling for review. Total managed files: N (from the manifest).

4. Wait for operator confirmation.
5. Then run the rebaseline (Phase 4a below).

### Phase 4a — Substitution rebaseline (conditional, only if drift detected)

Run:

```
node .claude-framework/sync.js --adopt
```

Show the INFO header line — it will read either `INFO: --adopt first-run mode (...)` or `INFO: --adopt rebaseline mode (...)`. For a substitution rebaseline, it should read rebaseline mode.

Show the resulting report. After completion, continue to Phase 5.

---

## Phase 5 — Walk pending merges

Run `find . -name "*.framework-new"` (or equivalent for the OS) to list any `.framework-new` sibling files. These are framework-updated versions of files that sync detected as locally customised — sync wrote the new framework content beside the target rather than overwriting it.

For each `.framework-new` file:

1. Read both the current target file and the `.framework-new` file.
2. Summarise what changed in the framework version: new lines, removed lines, and the intent of the change.
3. Suggest which side to keep for each changed section, with a brief reason. Where the framework change is a bug fix or policy clarification, the framework side is usually the right choice. Where the operator customised the file deliberately, the operator's version may be worth preserving.
4. Ask the operator to confirm the suggested merge.
5. Apply the merge: write the final content to the target path, then delete the `.framework-new` file.
6. After each resolution, re-run sync to update the hash:

   ```
   node .claude-framework/sync.js
   ```

   This confirms the resolution was recorded and checks whether any other files still need attention.

Repeat until no `.framework-new` files remain.

---

## Phase 6 — Verify

Run:

```
node .claude-framework/sync.js --doctor
```

Show the full output. If any anomalies are found, describe what they mean and how to resolve them.

Common cases:

- **Merge in flight** (`.framework-new` still present plus hash mismatch): the merge was not completed. Return to Phase 5 and finish the resolution.
- **Merged without resync** (no `.framework-new` but hash mismatch): the operator merged the file manually but did not re-run sync afterward. Run `node .claude-framework/sync.js` to record the resolved content hash.
- **Substitution drift**: `state.lastSubstitutionHash` does not match the current substitution map. Run `node .claude-framework/sync.js --adopt` to rebaseline (see Phase 4a).
- **Orphaned state entries**: state.json references a path that is no longer in any manifest glob. No action required — these are informational and are cleaned up automatically when the framework drops those paths from the manifest in a future version.

If `--doctor` exits 0 with no anomalies, the upgrade is complete.

---

## Phase 7 — Commit

List the files modified by this sync run. The list comes from the per-file `SYNC file=... status=updated` and `status=new` lines in the run output.

Suggest a commit message of the form:

```
chore: sync framework v<old>->v<new>

N updated, M new, P customised, K removal warnings
```

The operator commits manually. Sync never auto-commits.

---

## Troubleshooting

**sync.js exits 1 with "state.json not found":** The framework-state file is missing or corrupted. Run `node .claude-framework/sync.js --adopt` to re-initialise from the current file state. This is non-destructive for files that already exist — it computes and records their hashes without overwriting them.

**sync.js exits 1 with "unresolved .framework-new files":** Complete the manual merges first (Phase 5 in a prior sync run), or pass `--force` to proceed anyway. Passing `--force` is not recommended if the merge is meaningful — it advances the framework version record while leaving the conflict unresolved.

**sync.js exits 1 with substitution drift:** Your `state.substitutions` changed since the last sync. See Phase 4 above. The short path: run `node .claude-framework/sync.js --adopt` to rebaseline.

**Submodule has uncommitted changes:** Stash or revert changes inside `.claude-framework/` before syncing. Framework source files should never be edited directly in the submodule checkout — make changes in the framework source repo, commit there, and pull here via `git submodule update`.

**sync.js exits 1 with "Going backward":** The submodule pointer is at an older version than what state.json records. This happens if the submodule was rolled back. Confirm with the operator whether this is intentional before proceeding.
