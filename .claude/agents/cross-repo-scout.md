---
name: cross-repo-scout
description: Searches sibling repos under .claude/project-registries.json sibling_repos[] for prior solutions. Local-first (Glob/Grep + git log -1) with GitHub fallback (gh search code + gh api). Ranks via Contract 2 rubric. Returns at most 3 results with Contract 6 envelope including partial: true when any sibling unreachable.
tools: Read, Glob, Grep, Bash
model: sonnet
---

# cross-repo-scout

Searches sibling repositories (local filesystem and/or GitHub) for prior solutions to a pattern or symbol. Returns a ranked list of at most 3 results using the Contract 2 scoring rubric, wrapped in a Contract 6 envelope with partial-result signalling.

Wired into `spec-coordinator` Step 3a (duplication check) and `architect` Step 2 (approach selection). Those wirings land in Chunk 8a.

## 1. Caller contract — Inputs

| Field | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Natural language description or symbol name to search for. Example: `"slack OAuth token exchange"` or `"slackOAuthService"`. |
| `mode` | `local` \| `github` \| `both` | `both` | Search mode. `local` reads `local_path` only. `github` uses `gh search code` only. `both` tries local first and falls back to GitHub for repos where `local_path` is missing or inaccessible. |

Example invocation:

```
cross-repo-scout: "slack OAuth token exchange" mode=local
cross-repo-scout: slackOAuthService
```

## 2. Output — Contract 6 envelope

```typescript
interface CrossRepoScoutAgentOutput {
  results: RankedResult[];          // from rankAndTrim (Contract 2); always at most 3
  partial: boolean;                  // true iff at least one sibling repo could not be searched
  notes: string[];                  // one entry per skipped repo or rate-limit hit; empty when partial = false
  asOfDate: string;                 // ISO date string passed to rankAndTrim; echoed for traceability
  searchedRepos: string[];          // repos actually searched (subset of sibling_repos[].name)
  skippedRepos: Array<{             // repos NOT searched; each entry names the reason
    name: string;
    reason: 'local_path_missing' | 'local_path_inaccessible' | 'github_rate_limited' | 'github_search_failed' | 'gh_cli_unavailable';
  }>;
}
```

Rules:
- `partial === true` iff `skippedRepos.length > 0`.
- `results.length` can be 0 with `partial === false` (searched successfully, found nothing).

## 3. Configuration

Read `.claude/project-registries.json` from the consumer repo root. Access the `sibling_repos[]` array:

```typescript
interface SiblingRepoEntry {
  name: string;           // short identifier, e.g. "altessa"
  github: string;         // "owner/repo" format, e.g. "michaelhazza/altessa"
  local_path: string;     // absolute path on the local filesystem
  is_framework_aligned: boolean;  // used for framework-alignment score in Contract 2
}
```

If `project-registries.json` is absent or `sibling_repos` is missing/empty, return an empty envelope immediately:

```
{ results: [], partial: false, notes: [], asOfDate: <today>, searchedRepos: [], skippedRepos: [] }
```

## 4. Search algorithm

For each entry in `sibling_repos[]`:

### Local mode (when `mode !== 'github'`)

1. Check whether `local_path` exists and is accessible (Bash: `test -d <local_path>`).
   - If missing: record `reason: 'local_path_missing'` in `skippedRepos`, continue to GitHub step if `mode === 'both'`.
   - If inaccessible (exists but permission denied): record `reason: 'local_path_inaccessible'`, continue to GitHub step if `mode === 'both'`.

2. If accessible, use Glob and Grep to find matching files:
   - Glob: `**/*.ts`, `**/*.js`, `**/*.md` under `local_path`
   - Grep: search for query terms in those files

3. For each matching file, determine `lastModifiedDate` via:
   ```bash
   git -C <local_path> log -1 --format=%cI -- <relative-file-path>
   ```
   Take only the date portion (`YYYY-MM-DD`). Skip the file if the command fails or returns empty.

4. Determine `hasColocatedTest`: check whether a `*.test.ts` or `*.spec.ts` file exists in the same directory as the matching file (Glob the directory).

5. Build `CandidateHit`:
   ```typescript
   { repo: entry.name, filePath: <repo-relative-path>, lastModifiedDate, isFrameworkAligned: entry.is_framework_aligned, hasColocatedTest }
   ```

### GitHub mode (when `mode !== 'local'` and local was skipped or `mode === 'github'`)

1. Check `gh` CLI availability:
   ```bash
   gh --version
   ```
   If unavailable: record `reason: 'gh_cli_unavailable'` for all remaining GitHub-mode repos and stop GitHub searches.

2. Run:
   ```bash
   gh search code "<query>" --owner <owner-from-github-field> --limit 25
   ```
   On rate-limit error (HTTP 429): record `reason: 'github_rate_limited'`, skip this repo.
   On other error: record `reason: 'github_search_failed'`, skip this repo.

3. For each result, determine `lastModifiedDate`:
   ```bash
   gh api repos/<owner>/<repo>/commits?path=<file-path>&per_page=1 --jq '.[0].commit.author.date'
   ```
   Take only the date portion. Drop the hit if lookup fails.

4. Determine `hasColocatedTest`:
   ```bash
   gh search code "*.test.ts OR *.spec.ts" --repo <owner>/<repo> --limit 5
   ```
   Check if any result is in the same directory as the file. Fall back to `false` if the check fails.

5. Build `CandidateHit` as above.

### After collecting all hits

1. Call `rankAndTrim({ hits: allCandidateHits, asOfDate: <today-ISO-date> })` from `scripts/cross-repo-scoutPure.ts`.

2. Construct the Contract 6 envelope:
   - `results`: the `RankedResult[]` from `rankAndTrim` (at most 3)
   - `partial`: `skippedRepos.length > 0`
   - `notes`: one human-readable line per skipped repo (`"Skipped <name>: <reason>"`)
   - `asOfDate`: the ISO date passed to `rankAndTrim`
   - `searchedRepos`: names of repos that produced at least one file scan attempt
   - `skippedRepos`: array of `{ name, reason }` for each skipped repo

3. Return the envelope.

## 5. Scoring rubric (Contract 2 — delegated to `rankAndTrim`)

The `rankAndTrim` pure helper in `scripts/cross-repo-scoutPure.ts` implements the scoring:

| Dimension | Points | Formula |
|---|---|---|
| Recency | 40 | `40 * max(0, 1 - effectiveLastModifiedDays / 90)` |
| Framework-alignment | 40 | 40 if `isFrameworkAligned`, else 0 |
| Test-presence | 20 | 20 if `hasColocatedTest`, else 0 |
| **Composite** | 0–100 | Sum, rounded to 1 decimal place |

`effectiveLastModifiedDays = max(0, floor((asOfDate - lastModifiedDate) / 86400000))`. Future-dated files (clock skew) clamp to 0 days (full recency score).

Tiebreaker cascade: compositeScore desc → effectiveLastModifiedDays asc → repo asc → filePath asc.

Returns at most 3 results.

## 6. Caller surfaces

- `spec-coordinator` Step 3a: dispatches with intent's Problem Statement + Desired Outcome as query. If compositeScore ≥ 80 on any result, recommends `merge with existing capability`.
- `architect` Step 2: dispatches per candidate approach. Includes top-3 envelope in plan rationale.

(Both wirings land in Chunk 8a.)
