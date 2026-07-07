# Chunk learnings — [BUILD_SLUG]

> Append-only. Written by `feature-coordinator` after each chunk's G1 passes (Contract 3), BEFORE the chunk commit so the entry lands in the chunk's own commit. The next chunk's `builder` reads all prior entries at Step 0. If this file is missing, builders proceed without it — never fail on absence.

## Chunk 1 — [chunk title]

- **Files touched:** [list builder reported in "Files changed"]
- **G1 failures resolved:** [one bullet per G1 fix attempt this chunk, or "none"]
- **Plan gaps surfaced:** [one bullet per PLAN_GAP routed back to architect this chunk, or "none"]
- **Watch-out for future chunks:** [one bullet — concrete, actionable observation (e.g. "helper X exports `migrate` only; Chunk 3 must APPEND to that function, not create a new one"). If nothing useful surfaced, write "none" rather than padding.]

## Chunk 2 — [chunk title]

[Same four-bullet shape as Chunk 1. The `Watch-out for future chunks` line is the load-bearing line — write a concrete observation, not generic advice.]
