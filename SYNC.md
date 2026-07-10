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

**Gitignore prerequisite.** Before working through `.framework-new` files for the first time in a repo, ensure `*.framework-new` is in the repo's `.gitignore`. These files are per-clone working state — they're sync.js's "here's what the new canonical looks like, decide if you want to absorb it" advisory for one developer's sync run. If they get tracked in git, one developer's mid-sync state propagates to every clone and creates a misleading appearance of a shared "pending decisions backlog" that other clones think they need to resolve. sync.js itself never modifies a consuming repo's root `.gitignore`; since framework v2.30.0 the migration runner handles this instead — the v2.30.0 migration idempotently appends the rule during `/claudeupdate` (or a manual `run-migrations.js` pass). Only repos that have not yet run the v2.30.0 migration need to add it manually, once:

```
# Framework sync working artefacts — per-clone, per-sync-run; never team-shared
*.framework-new
```

Then proceed with the walk.

Run `find . -name "*.framework-new"` (or equivalent for the OS) to list any `.framework-new` sibling files. These are framework-updated versions of files that sync detected as locally customised — sync wrote the new framework content beside the target rather than overwriting it.

**Ownership contract — behavioural files always resolve framework-wins.** For `.claude/agents/*.md` (excluding `extensions/`), `.claude/skills/**`, `.claude/hooks/*`, and `.claude/commands/*`, there is no "which side to keep" decision: the framework version is taken **verbatim, every time**. These files define agent, skill, and hook behaviour, and every canonical agent already reads the repo's project context first at runtime (`.claude/context/agent-context.md` for agents, `.claude/context/skill-context.md` for skills — ADR-0006), so repo-specific behaviour belongs in those context files, never in a divergent copy of the canonical file. A local delta found in a behavioural file is **relocated** into the matching `## <name>` section of the appropriate context file (operator confirms the destination), then the framework content overwrites the target. Hooks and commands have no runtime overlay: a local delta there is either proposed upstream as a framework change or dropped — the operator decides which, but the consumer copy still ends byte-identical to canonical. The end state after every sync: all behavioural files byte-identical to framework-canonical, all repo-specific behaviour in the context files. `validate-setup` treats a divergent agent file as a critical finding.

For each `.framework-new` file:

1. Read both the current target file and the `.framework-new` file.
2. Summarise what changed in the framework version: new lines, removed lines, and the intent of the change.
3. Suggest a resolution, with a brief reason. **Behavioural files (agents/skills/hooks/commands): framework side always wins — the only decision is where the local delta relocates (see the ownership contract above).** For other managed files (docs, references, templates): where the framework change is a bug fix or policy clarification, the framework side is usually the right choice; where the operator customised deliberately, prefer moving the customisation into the file's `LOCAL-OVERRIDE` slot if it has one, so the next sync doesn't re-flag it.
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

## Far-behind repos: squash to current

A consumer that is many versions behind (say v2.13.0 while the framework is at v2.30.0) does NOT step through intermediate versions one release at a time. The supported path is a single bump straight to the latest version:

1. Point the submodule at the latest framework commit (`git submodule update --remote .claude-framework`).
2. Run migrations across the whole gap: `node .claude-framework/scripts/run-migrations.js . <old-version> <latest-version>`. The runner discovers every migration script in the range and executes them in semver order; `appliedMigrations[]` in state.json guarantees nothing already applied re-runs.
3. Run `node .claude-framework/sync.js` as usual (Phases 3–6 above).

Two properties make the squash safe:

- **Where no migration script exists for a gap version, the sync itself IS the migration.** Most versions ship only file updates, which sync.js deploys declaratively regardless of how many versions are being crossed. Migration scripts exist only for versions that needed imperative one-time work, and those run in order across the gap.
- **`.framework-new` conflicts are the expected fallout, and are resolved once.** A long gap means more accumulated divergence between local customisations and canonical files, so expect a larger-than-usual batch of `.framework-new` siblings after the sync. This is not an error state: walk them once via Phase 5, against the latest canonical content only, and the repo is current. There is no per-version merge debt.

---

## Troubleshooting

**sync.js exits 1 with "state.json not found":** The framework-state file is missing or corrupted. Run `node .claude-framework/sync.js --adopt` to re-initialise from the current file state. This is non-destructive for files that already exist — it computes and records their hashes without overwriting them.

**sync.js exits 1 with "unresolved .framework-new files":** Complete the manual merges first (Phase 5 in a prior sync run), or pass `--force` to proceed anyway. Passing `--force` is not recommended if the merge is meaningful — it advances the framework version record while leaving the conflict unresolved.

**sync.js exits 1 with substitution drift:** Your `state.substitutions` changed since the last sync. See Phase 4 above. The short path: run `node .claude-framework/sync.js --adopt` to rebaseline.

**Submodule has uncommitted changes:** Stash or revert changes inside `.claude-framework/` before syncing. Framework source files should never be edited directly in the submodule checkout — make changes in the framework source repo, commit there, and pull here via `git submodule update`.

**Submodule pointer is at an older version than state.json records:** Downgrades are unsupported — sync.js has no downgrade guard and its behaviour when run against an older framework is undefined. Restore the newer submodule pointer (check out the correct submodule commit, e.g. `git submodule update --init` after resetting the pointer in the parent repo) before syncing.
