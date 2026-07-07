# Verification log — ci-gate-integrity

Evidence that every touched gate can actually fail (spec §7). Filled **during** the build; paste raw command + exit code + key output for each planted violation, then confirm the fixture was reverted. A gate is not "done" until its rows here are complete.

Status legend: ☐ pending · ☑ captured (red observed) · ↩ fixture reverted

## Environment baseline (author-time facts to reconfirm at build start)

| Fact | Value at spec authoring (`776030e`) | Reconfirmed at build |
|---|---|---|
| `npx madge --circular scripts` | `No circular dependency found!` (0 cycles) | ☐ |
| On-disk skill dirs | 19 (`.claude/skills/*/`) | ☐ |
| `managedFiles` skill entries | 19 | ☐ |
| `npm run test:scripts` | (record baseline pass/fail) | ☐ |

## Phase 1 — PR 1

### Gate A — circular-deps (`scripts/gates/verify-circular-deps.sh`)

| # | Planted violation | Expected | Exit | Evidence | State |
|---|---|---|---|---|---|
| A1 | Mutual `import` cycle between two temp files under a scan root | exit 1, cycle listed | | | ☐ |
| A2 | Real cycle present, baseline `cycle-count:0` | exit 1 | | | ☐ |
| A3 | Broken madge call (bad `--extensions`) | fail-closed, exit 1, stderr shown | | | ☐ |
| A4 | Clean tree, honest baseline | exit 0 (green) | | | ☐ |

### Gate B — skill-registry alignment (`scripts/validate-skill-registry.ts`)

| # | Planted violation | Expected | Exit | Evidence | State |
|---|---|---|---|---|---|
| B1 | `.claude/skills/_planted/SKILL.md`, no manifest entry | exit 1 (`unregistered-skill`) | | | ☐ |
| B2 | `managedFiles` entry for a nonexistent skill | exit 1 (`phantom-entry`) | | | ☐ |
| B3 | SKILL.md frontmatter `name:` ≠ dir name | exit 1 (`name-dir-mismatch`) | | | ☐ |
| B4 | Registry as-is (aligned) | exit 0 (green) | | | ☐ |

### Self-tests

| # | Check | Evidence | State |
|---|---|---|---|
| S1 | `npm run test:scripts` includes + passes both new self-tests | | ☐ |
| S2 | `verify-circular-deps.test.ts` fails if the gate is stubbed to always-exit-0 (meta-check the self-test can fail) | | ☐ |

### CI wiring

| # | Check | Evidence | State |
|---|---|---|---|
| W1 | `ci.yml` circular-deps step present + observed running green on `main` after merge | | ☐ |
| W2 | `ci.yml` skill-registry step present + observed running green on `main` after merge | | ☐ |

## Phase 2 — PR 2

### loc-cap subdirectory patterns

| # | Planted violation | Expected | Exit | Evidence | State |
|---|---|---|---|---|---|
| L1 | File over a nested subdir cap not covered by parent rule | exit 1 vs most-specific cap | | | ☐ |
| L2 | Same file, only parent (looser) rule → within cap | exit 0 (proves most-specific-wins, no double-count) | | | ☐ |

### duplicate-blocks promotion

| # | Planted violation | Expected | Exit | Evidence | State |
|---|---|---|---|---|---|
| D1 | Clone pushing count above seeded baseline | exit 1 | | | ☐ |
| D2 | Framework tree at seeded baseline | exit 0 (green) | | | ☐ |

### guard-utils shrink-only ratchet

| # | Planted violation | Expected | Exit | Evidence | State |
|---|---|---|---|---|---|
| G1 | Baseline edited upward, no justification token | `assert_shrink_only` exit 1 | | | ☐ |
| G2 | Baseline edited downward | exit 0 (ratchet tightens freely) | | | ☐ |
| G3 | Refactored duplicate-blocks + circular-deps self-tests still pass (no regression from sourcing guard-utils) | | | ☐ |

## Review record

| PR | pr-reviewer | dual-reviewer (Codex) | adversarial-reviewer | Notes |
|---|---|---|---|---|
| PR 1 | ☐ | ☐ / `REVIEW_GAP` | skipped (no security surface) | |
| PR 2 | ☐ | ☐ / `REVIEW_GAP` | skipped (no security surface) | |
