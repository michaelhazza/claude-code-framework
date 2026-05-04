# Implementation plan — [BUILD_SLUG]

**Spec:** `[path-to-spec]`
**Branch:** `[branch-name]`
**Classification:** [Trivial | Standard | Significant | Major]
**Plan shape:** [single file | multi-chunk | phased]

---

## Mental model

[2-3 sentences describing how the change is shaped. The reader should be able to predict the file layout from this paragraph.]

## What this is NOT

[Locked non-goals. List items that are explicitly out of scope so future sessions don't drift into them.]

## What this IS (build surface)

[The file-by-file breakdown. For each file: what it does, what it depends on, what tests cover it.]

### Chunk 1 — [name]

**Files touched:**
- `path/to/file.ts` (NEW | MODIFIED) — one-paragraph description.

**Verification commands** (per `references/verification-commands.md`):
- Lint: `[LINT_COMMAND]`
- Typecheck: `[TYPECHECK_COMMAND]`
- Targeted test: `[targeted test command for THIS chunk's new test file]`

**Done criteria:**
- [ ] Specific assertion 1.
- [ ] Specific assertion 2.

### Chunk 2 — [name]

[Same shape as Chunk 1.]

---

## Decisions locked in this plan

[List decisions the architect locked. Future builders should not re-open them.]

## Open questions for the implementer

[Genuine unknowns the architect deliberately left for the build phase. If none, write "None — proceed."]
