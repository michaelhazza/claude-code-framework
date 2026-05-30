---
description: One-shot bump of the claude-code-framework submodule across all consuming repos — sync canonical files, run pending migrations, commit, push
---

# /claudeupdate

Update every local repo that mounts `claude-code-framework` as a submodule. Bumps the submodule pointer to the latest canonical commit, deploys canonical files via `sync.js`, runs any pending framework migrations, commits the lot, and pushes — per repo, only when safe to do so.

This is the one-shot, fully-automated flow as of framework v2.9.0. Earlier versions of this command only bumped the submodule pointer and left `sync.js` + migration steps as manual per-repo follow-ups; that's no longer the case.

## What to do

1. **Determine the scan root.**
   - If `$ARGUMENTS` is provided, use it (e.g. `/claudeupdate D:/projects/`).
   - Otherwise default to the parent directory of the current working repo (the directory that contains the current session's checkout).
   - Typical layouts: Windows `c:/files/Claude/` or `c:/Files/Projects/`; Linux/macOS `~/projects/` or similar — parent-of-cwd handles both.

2. **Discover consuming repos.** Scan `<scan-root>/*` for any directory containing a `.claude-framework/` whose `origin` URL contains `claude-code-framework`. Skip directories that don't have it.

   ```bash
   for d in <scan-root>/*/; do
     if [ -d "$d.claude-framework" ]; then
       origin=$(git -C "$d.claude-framework" remote get-url origin 2>/dev/null)
       if echo "$origin" | grep -q "claude-code-framework"; then
         echo "$d"
       fi
     fi
   done
   ```

3. **For each repo discovered, gather state** before doing anything:
   - Current submodule sha (`git -C <repo>/.claude-framework rev-parse --short HEAD`)
   - Current submodule version (`cat <repo>/.claude-framework/.claude/FRAMEWORK_VERSION` — this is `FROM_VERSION`)
   - Current branch (`git -C <repo> rev-parse --abbrev-ref HEAD`)
   - Working tree clean? (`git -C <repo> status --porcelain` — empty = clean)
   - Submodule working tree clean? (`git -C <repo>/.claude-framework status --porcelain`)

4. **Fetch the latest framework tip** to know the target sha and version. Use the current session's already-mounted framework as the fetch source (every consuming repo shares the same `origin`):

   ```bash
   git -C <current-repo>/.claude-framework fetch origin main --quiet
   TARGET_SHA=$(git -C <current-repo>/.claude-framework rev-parse --short origin/main)
   TARGET_VERSION=$(git -C <current-repo>/.claude-framework show origin/main:.claude/FRAMEWORK_VERSION)
   ```

5. **Per repo, decide:**

   | State | Action |
   |---|---|
   | Already at TARGET_SHA | Skip — "already current" |
   | Branch != main | Skip — "on branch <X>, won't auto-commit" |
   | Working tree dirty | Skip — "uncommitted changes in <repo>" |
   | Submodule has uncommitted edits | Skip — "uncommitted submodule edits in <repo>" |
   | Clean, on main, behind target | Run the **one-shot update sequence** below |

6. **One-shot update sequence (safe path only).** Run from `<repo>` (the consumer root):

   ```bash
   cd <repo>

   # 6a. Bump the submodule pointer
   git submodule update --remote .claude-framework

   # 6b. Deploy canonical files via sync.js
   #     Writes managed files into the working .claude/, schemas/, scripts/, docs/, etc.
   #     Customised files get .framework-new siblings for manual merge.
   node .claude-framework/sync.js

   # 6c. Detect unresolved .framework-new conflicts BEFORE running migrations
   CONFLICTS=$(find .claude .claude-framework -name '*.framework-new' 2>/dev/null | head -20)
   if [ -n "$CONFLICTS" ]; then
     echo "PAUSE: $(echo "$CONFLICTS" | wc -l) .framework-new conflict(s) need manual merge before continuing."
     echo "$CONFLICTS"
     exit 1
   fi

   # 6d. Run pending migrations in semver order
   node .claude-framework/scripts/run-migrations.js "$PWD" "$FROM_VERSION" "$TARGET_VERSION"

   # 6e. Stage everything sync.js + migrations touched
   git add -A

   # 6f. Single commit summarising the one-shot update
   git commit -m "$(cat <<EOF
   chore(framework): bump claude-code-framework submodule to ${TARGET_VERSION}

   Pointer: ${OLD_SHA} -> ${TARGET_SHA}
   sync.js: applied managed files
   migrations: ran pending migrations in (${FROM_VERSION}, ${TARGET_VERSION}]

   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
   EOF
   )"

   # 6g. Push
   git push origin main
   ```

7. **On .framework-new conflict (6c trips):**
   - Do NOT auto-merge or auto-resolve.
   - Stop the one-shot for this repo and report `paused — manual merge of N .framework-new files`.
   - Surface the file list to the operator. The operator merges, deletes the `.framework-new` sibling, then re-runs `/claudeupdate` for that repo.

8. **On migration failure (6d throws):**
   - sync.js already wrote canonical files; staged state may be inconsistent.
   - Do NOT commit or push.
   - Report `failed — migration v<X> threw <error>`. Surface the error to the operator.
   - The runner persists state after each successful migration, so re-running `/claudeupdate` resumes after the failed one (operator must fix the root cause first).

9. **Final report.** Single plain table — one row per repo. Columns: Repo, Before, After, Sync, Migrations, Outcome.

   Example:
   ```
   Repo                  Before    After     Sync          Migrations         Outcome
   automation-v1         1702ae0   d302e29   3 updated     2 applied          updated + pushed
   automation-v1-3rd     866c667   d302e29   1 customised  1 applied 1 skip   updated + pushed
   automation-v1-4th     866c667   d302e29   2 customised  -                  paused — 2 .framework-new
   automation-v1-5th     d302e29   d302e29   -             -                  already current
   automation-v1-6th     866c667   866c667   -             -                  skipped — branch feature/foo
   ```

## Rules

- **Never `--force` past dirty state.** If a repo isn't on `main` or has uncommitted work, skip and report. Don't try to be clever.
- **One commit per repo.** No batching across repos.
- **No auto-resolution of `.framework-new` conflicts.** Customised files survive only because manual review is the merge point. The one-shot pauses on conflict; the operator resolves and re-runs.
- **Migrations run after sync.js, before commit.** Order matters: sync.js deploys new framework files (including the migrations themselves), then the runner picks them up. If sync.js produces a `.framework-new` conflict, the runner doesn't run — keeping state and files in sync.
- **Skip the current working directory** unless the operator passes it explicitly. The session's own repo is usually already in flight; if it's behind, surface it but don't auto-commit there — let the operator decide.

## Arguments

`$ARGUMENTS` — optional. Path to the directory to scan for consuming repos. Defaults to the parent of the current working repo.
