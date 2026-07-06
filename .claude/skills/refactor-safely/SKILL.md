---
name: refactor-safely
description: Use BEFORE moving, splitting, renaming, extracting, or deleting existing code — file splits, helper extraction, lifting code into an orchestrator, mass find-replace edits, resolving merge conflicts, or acting on "unused code" findings. Structural changes have their own defect classes distinct from new-feature bugs.
---

# Refactor safely

Structural changes fail differently from new code: the pieces all compile, the tests stay green, and the regression hides in what the move dropped, duplicated, or left behind.

## Moves and splits

- "Move X to Y" is routinely executed as "copy X to Y". Spell out both halves: create the destination, REMOVE the symbols from the source, rewire imports — and verify with a line-count check. Lint and typecheck do not fail on silent duplication.
- A file split only counts if the ORIGINAL file shrinks below the size cap — an extracted companion beside an unshrunk original delivers none of the benefit while signalling the problem is solved. Check both halves against the cap; land before/after line counts with the split.
- After moving code into deeper directories, audit every relative import in every extracted file against its NEW depth — verbatim-copied imports cascade into hundreds of downstream type errors that obscure the ~15 root-cause lines.
- Registry/config monolith splits: keep the original path as a re-export shim (zero caller churn), preserve original insertion/assembly order, run post-construction mutation passes after ALL modules assemble, and gate the refactor with a snapshot diff-test as the correctness oracle — not manual review of a 3,000-line diff.
- Preserve latent bugs verbatim during a move; fix them in a follow-on commit. A refactor that also "fixes" things cannot be verified as behaviour-preserving.
- When lifting a concrete function into a generic orchestrator, diff the legacy function line-by-line first: early-return and failure branches carry non-obvious side effects (stamps, metrics, retry scheduling) that the lift silently drops. Enumerate them as explicit preservation criteria.
- Post-refactor metrics (file size, LOC) dropping does not prove the underlying properties (cycles, durability) were fixed — verify each claimed property with its own check.

## Mass edits

- Exact-match replace-all silently misses "identical" code differing only in leading indentation, and the half-converted result passes lint and typecheck. Use per-site surgical edits for multi-site replacements; reserve replace-all for single-token renames.
- Renaming any string identifier (queue topic, event name, log code, cache prefix) is a repo-wide sweep: grep before editing, enumerate every hit including tests, comments, agent/config/prompt files, and require a zero-match post-rename grep.
- Any commit that moves or renames a file greps scripts/, docs/, and CI configs for the old path in the same commit — gate scripts referencing dead paths fail silently for weeks. Path-matching regexes in guards break when files move into subdirectories.
- When applying the same pattern across sibling call sites, use ONE check style verbatim at every site — subtle divergence behaves identically in prod but breaks differently under mocks and future refactors.

## Deleting code

- Static dead-code analysers are unreliable in registry/config-driven architectures (files reached via string-keyed registration, not imports). Verify "unused" findings by grepping the registries and git history before deleting anything. Wrong-deletion cost is high; the cost of routing to a backlog is zero.
- Test-shaped files outside the runner's include globs provide zero coverage — deleting them removes nothing; but check the globs before assuming either way.
- A refactor that "replaces" a feature deletes the replaced subtree in the same PR or files a tracked follow-up — a comment listing superseded files creates the illusion of cleanup while dead code confuses every future grep.
- After deleting orphaned components, immediately re-run unused-export checks: types often become newly orphaned because the deleted component was their last consumer; fix in the same unit.
- Superseded placeholder docs in agent-readable directories get a grep-visible tombstone pointing at the successor, not deletion — future sessions read file contents, not git history, and a deleted placeholder invites duplicate re-creation.
- Retiring a registered backend/consumer: keep the adapter, make dispatch fail closed behind an explicit opt-in flag, and pin the retirement with a test asserting the typed "retired" reason — a header comment is documentation, not protection.

## Merge conflicts and provenance

- `git checkout --ours` on a code-area conflict replaces the ENTIRE file with your pre-merge version, discarding every hunk the merge already auto-resolved — potentially rolling back dozens of commits. Reserve it for branch-canonical artifact files; hand-edit code conflicts marker-by-marker, then verify with `git diff origin/main -- <file>` that the result matches your intended change.
- On refactor/move PRs, verify every reviewer finding as introduced-vs-pre-existing with `git diff main -- <file>` before accepting — moved-verbatim issues look new to diff readers. Pre-existing issues route to backlog (unless the refactor enlarges their blast radius).
- Mixed conventions inside one file (half canonical helper, half legacy handle) mark an unfinished migration, not a design choice — finish it, because new code copies whichever function it sits next to.
- Before consolidating two similar-looking resources as "duplicates", verify both are live and whether the split is intentional (separate process spaces, unrenameable schedule keys) — load-bearing exceptions get an allowlist entry with rationale, not a rename.
