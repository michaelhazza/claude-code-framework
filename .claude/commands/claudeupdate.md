---
description: Bump the claude-code-framework submodule across all consuming repos to the latest canonical version
---

# /claudeupdate

Update every local repo that mounts `claude-code-framework` as a submodule. Bumps the submodule pointer to the latest canonical commit, commits, and pushes — per repo, only when safe to do so.

## What to do

1. **Determine the scan root.**
   - If `$ARGUMENTS` is provided, use it (e.g. `/claudeupdate D:/projects/`).
   - Otherwise default to the parent directory of the current working repo (i.e. the directory that contains the current session's checkout).
   - On Windows the typical layout is `c:/files/Claude/`; on Linux/macOS it may be `~/projects/` or similar — the parent-of-cwd default handles both.

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
   - Current branch (`git -C <repo> rev-parse --abbrev-ref HEAD`)
   - Working tree clean? (`git -C <repo> status --porcelain` — empty = clean)
   - Submodule working tree clean? (`git -C <repo>/.claude-framework status --porcelain`)

4. **Fetch the latest framework tip** to know the target sha. Use the current session's already-mounted framework as the fetch source (every consuming repo shares the same `origin`):

   ```bash
   git -C <current-repo>/.claude-framework fetch origin main --quiet
   TARGET_SHA=$(git -C <current-repo>/.claude-framework rev-parse --short origin/main)
   TARGET_VERSION=$(cat <current-repo>/.claude-framework/.claude/FRAMEWORK_VERSION)
   ```

5. **Per repo, decide and act:**

   | State | Action |
   |---|---|
   | Already at TARGET_SHA | Skip — "already current" |
   | Branch != main | Skip — "on branch <X>, won't auto-commit" |
   | Working tree dirty | Skip — "uncommitted changes in <repo>" |
   | Submodule has uncommitted edits | Skip — "uncommitted submodule edits in <repo>" |
   | Clean, on main, behind target | Run the update sequence below |

   **Update sequence (safe path only):**
   ```bash
   cd <repo>
   git submodule update --remote .claude-framework
   git add .claude-framework
   git commit -m "chore(framework): bump claude-code-framework submodule to <TARGET_VERSION>

   Pointer: <old-sha> -> <new-sha>

   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
   git push origin main
   ```

6. **Final report.** Single plain table — one row per repo. Columns: Repo, Before, After, Outcome.

   Example:
   ```
   Repo                  Before    After     Outcome
   automation-v1         1702ae0   d302e29   updated + pushed
   automation-v1-3rd     866c667   d302e29   updated + pushed
   automation-v1-4th     866c667   866c667   skipped — branch feature/foo
   ```

## Rules

- **Never `--force` past dirty state.** If a repo isn't on `main` or has uncommitted work, skip and report. Don't try to be clever.
- **No `sync.js` propagation.** This command only moves the submodule pointer. Deploying canonical files into each repo's working `.claude/` directory (via `sync.js`) is a separate per-repo task because it can require conflict resolution on customised files.
- **Skip the current working directory.** The session's own repo is usually already up-to-date; if not, surface it but don't auto-commit there — let the operator decide.
- **One commit per repo.** No batching across repos.

## Arguments

`$ARGUMENTS` — optional. Path to the directory to scan for consuming repos. Defaults to the parent of the current working repo.
