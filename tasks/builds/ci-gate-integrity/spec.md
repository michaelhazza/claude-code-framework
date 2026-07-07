# Spec — ci-gate-integrity

**Status:** draft
**Date:** 2026-07-07
**Author:** direct build session (Opus 4.8, 1M) — spec authored because no prior planning artifacts existed on any ref
**Scope class:** Significant
**Source branch:** `main` (each phase lands as its own PR branch off `main`)

> Canonical location: `tasks/builds/ci-gate-integrity/spec.md`. This is a **DIRECT build** — spec-coordinator / feature-coordinator are intentionally NOT invoked. Implementation is inline, one phase per PR.

## Provenance note

The task referenced this spec, `build-approach.md`, and `verification-log.md` as pre-existing "read first" artifacts. None existed on `main`, any local/remote branch, stash, worktree, or anywhere on disk (only the `ci-gate-integrity` *skill* existed). This document was authored from scratch against the real repo state at commit `776030e` (`v2.30.2`), with three design decisions confirmed by the user (see § Design decisions). Treat every claim here as grounded in the current tree, not inherited.

## Goals

Verifiable assertions (each checkable by a test, a gate self-test, or deterministic inspection):

1. **A circular-dependency gate exists, can fail, and is wired.** `scripts/gates/verify-circular-deps.sh` detects import cycles across the configured TS/JS surface via `npx madge --circular`, fails closed on tool error, ratchets against a `cycle-count:<N>` baseline, and is invoked by a `.github/workflows/ci.yml` step running over the framework's own `scripts` + `tests`. A planted cycle makes it exit non-zero (recorded in `verification-log.md`).
2. **A skill-registry-alignment check exists, can fail, and is wired.** A framework-internal validator asserts three invariants between `.claude/skills/*/SKILL.md` on disk and `manifest.json` `managedFiles`: (a) every on-disk SKILL.md is registered, (b) every registered skill entry resolves to a file on disk, (c) each SKILL.md frontmatter `name:` equals its directory name. It runs in CI's validation stage and fails loudly (non-baselineable). Each of the three planted violations makes it exit non-zero.
3. **Both Phase-1 gates carry seeded-violation self-tests** discovered by `scripts/run-tests.js` and run via `npm run test:scripts`, so a regression that neuters either gate fails CI.
4. **Baselines are honest and atomic.** The circular-deps baseline is seeded from the gate's own output on the real tree (`cycle-count:0` at author time) in the *same commit* as the gate. No blind regeneration.
5. **(Phase 2) `verify-loc-cap.sh` supports subdirectory patterns** — overlapping/nested rules resolve most-specific-wins, each file judged against exactly one rule (no double-counting), proven by a self-test.
6. **(Phase 2) The duplicate-blocks gate is promoted** from an unwired library script to running on the framework's own repo in CI, with an honest `clone-count:<current>` baseline seeded from its own output in the same commit.
7. **(Phase 2) A shared shrink-only ratchet lives in `scripts/gates/guard-utils.sh`**, sourced by the duplicate-blocks and circular-deps gates, DRY-ing the count-vs-baseline compare and enforcing that a committed baseline may only *decrease* without an explicit recorded justification.

## Non-goals

- **Phase 3 is out of scope.** The tenant-isolation-dependent gate waits for the tenant-isolation build to land first. Not started here.
- **No real `npm run lint` is added.** This repo has no `lint` script; the task's "verify with `npm run lint`" is reconciled to this repo as: `npm run test:scripts` (gate self-tests) + the new `ci.yml` gate steps. (See § Verification.)
- **No changes to the other existing gates** (`verify-no-raw-console.sh`, `verify-no-orphan-react-component.sh`, `verify-protected-block-names.sh`) except that `verify-duplicate-blocks.sh` and `verify-circular-deps.sh` are refactored to source `guard-utils.sh` in Phase 2.
- **No new committed runtime dependency.** `madge` and `jscpd` are invoked via `npx` (fail-closed), matching the existing duplicate-blocks pattern — nothing added to `dependencies`/`devDependencies` unless CI cold-start cost forces it (decided at PR time, noted in build-approach).
- **The skill-registry validator is framework-internal and is NOT synced to consumers** — skills + `manifest.json` are framework-only concepts. It stays out of `managedFiles`.

## Framing assumptions

- **Target repo is the framework itself** (`claude-code-framework`, currently `v2.30.2`). All referenced paths (`scripts/gates/`, `manifest.json`, `.claude/skills/`, `tasks/builds/`) resolve here.
- **`scripts/gates/*.sh` is a portable library** synced into consumer repos via `manifest.json` `managedFiles` (the `scripts/gates/*.sh` glob already covers new gate scripts). The framework *also* runs a relevant subset on itself via its own `ci.yml`.
- **Baselines are repo-local state, not framework files.** `scripts/gates/.baselines/*` is intentionally NOT in `managedFiles` (each consumer owns its own counts); the framework keeps its own baselines for its own CI runs.
- **The repo's own CI enforces version consistency** (`.github/workflows/ci.yml` "Version consistency" step: `FRAMEWORK_VERSION` must equal `manifest.frameworkVersion`, and `CHANGELOG.md` must have a heading for that version). Every PR here that touches shipped/managed content bumps `FRAMEWORK_VERSION` + `manifest.frameworkVersion` + adds a `.claude/CHANGELOG.md` entry, atomically.
- **`madge` currently reports 0 cycles** over `scripts/` (verified at author time), so the honest circular-deps baseline is `cycle-count:0` and the gate is green on the real tree once wired.

## Design decisions (user-confirmed)

| # | Decision | Choice |
|---|---|---|
| D1 | Cycle-detection engine | `npx madge --circular --json` (mirrors `npx jscpd`; no committed dep; fail-closed) |
| D2 | Where the two gates live + wiring | **Split**: circular-deps → `scripts/gates/` (portable library, also run on framework via `ci.yml`); skill-registry-alignment → framework-internal validator run in CI's validation stage. Self-tests via `npm run test:scripts`. "`npm run lint`" maps to `test:scripts` + gate steps. |
| D3 | skill-registry-alignment assertions | Bidirectional (disk ⊆ manifest AND manifest ⊆ disk) **plus** frontmatter `name:` == directory name |

## Contracts

### Gate A — `scripts/gates/verify-circular-deps.sh` (Phase 1)

Configuration (env vars, all optional; mirrors the duplicate-blocks gate's shape):

| Knob | Default | Meaning |
|---|---|---|
| `CIRCULAR_DEPS_DIRS` | whichever of `scripts server client shared src tests` exist | Space-separated scan roots; **none existing = fail** (misconfigured gate must not pass silently) |
| `CIRCULAR_DEPS_BASELINE` | `scripts/gates/.baselines/circular-deps.txt` | File containing `cycle-count:<N>`; missing file = baseline `0` (strict: any cycle fails until seeded) |
| `CIRCULAR_DEPS_EXTENSIONS` | `ts,tsx,js,mjs,cjs` | Passed to `madge --extensions` |
| `CIRCULAR_DEPS_ROOT` | `$(pwd)` | Repo root |

Mechanics (fail-closed, no piped exit codes — per `ci-gate-integrity` skill):
1. Resolve scan roots; if none exist → exit 1 (misconfiguration).
2. Run `npx madge --circular --json --extensions <ext> <roots>` capturing **stdout to a file** and stderr separately, recording madge's exit code. Never pipe madge into the parser (piping masks exit codes).
3. Parse the stdout file as JSON via `node`. `madge --circular --json` emits a JSON array of cycles; **CURRENT = array length**. madge exits `1` merely when cycles exist — that alone is not a tool failure.
4. **Tool-failure discrimination:** if stdout is not valid JSON *and* madge exited non-zero → tool failure → echo stderr, exit 1 (fail closed). Valid-JSON-array is the only trusted signal.
5. Read baseline `cycle-count:<N>` (missing/blank → 0).
6. If `CURRENT > BASELINE` → exit 1 (regression, list the cycles). Else exit 0.

Exit codes: `0` at/below baseline, `1` regression or tool/misconfiguration failure. (No warning tier.)

### Gate B — Skill-registry alignment (Phase 1, framework-internal)

Files:
- `scripts/skill-registry-checkPure.ts` — **pure** function (repo `*Pure.ts` convention), no I/O:
  ```
  checkSkillRegistry(input: {
    diskSkills: string[];            // repo-relative SKILL.md paths found on disk
    manifestSkillPaths: string[];    // managedFiles paths matching .claude/skills/*/SKILL.md
    frontmatterNames: Record<string, string | null>;  // diskPath -> frontmatter `name:` (null if unparseable/absent)
  }): { violations: Array<{ kind: 'unregistered-skill' | 'phantom-entry' | 'name-dir-mismatch'; path: string; detail: string }> }
  ```
  - `unregistered-skill`: on disk but not in `manifestSkillPaths`.
  - `phantom-entry`: in `manifestSkillPaths` but not on disk.
  - `name-dir-mismatch`: frontmatter `name` (or null) ≠ the skill's directory name.
- `scripts/validate-skill-registry.ts` — impure CLI wrapper: globs `.claude/skills/*/SKILL.md`, reads `manifest.json` `managedFiles`, parses each SKILL.md YAML frontmatter `name:`, calls the pure function, prints any violations, and **exits 1 if `violations.length > 0`** (loud, non-baselineable). Exit 0 only when all three invariant sets are empty.
- Wiring: a dedicated `.github/workflows/ci.yml` step **`Skill registry alignment`** → `npx tsx scripts/validate-skill-registry.ts`, in the validation stage alongside `npm run validate`.

### Baseline files

- `scripts/gates/.baselines/circular-deps.txt` → single line `cycle-count:0` (author-time truth). Not in `managedFiles`.
- (Phase 2) `scripts/gates/.baselines/duplicate-blocks.txt` → `clone-count:<current>` from the gate's own first run over `scripts tests`. Not in `managedFiles`.

### Gate C — `scripts/gates/guard-utils.sh` (Phase 2, shared library)

Sourced (`. "$(dirname "$0")/guard-utils.sh"`) by `verify-duplicate-blocks.sh` and `verify-circular-deps.sh`. Provides:
- `read_baseline_count <file> <key>` → echoes the integer for `key:<N>` (missing file/line → `0`).
- `assert_not_above_baseline <current> <baseline> <label>` → exit 1 with a uniform `[FAIL]` message if `current > baseline`; else return 0.
- `assert_shrink_only <baseline_file> <key> <root>` → the **shrink-only ratchet**: compares the committed baseline value against its `origin/main` version (`git show origin/main:<file>`); if the new value is **higher** than the base value and the HEAD commit body carries no recorded justification token, exit 1 ("baseline inflated — a ratchet only tightens"). Degrades to a warning (not a hard fail) when `origin/main` is unavailable (shallow/detached), per the skill's shallow-clone rule. (Exact justification-token spelling + degrade behavior is the one item finalized at PR-2 kickoff — see § Open questions.)

## Execution model

All gates are **CI-only** shell/Node checks (no runtime service). Synchronous, deterministic, invoked per-PR by GitHub Actions on `pull_request` and `push: [main]`. Self-tests are inline unit tests run by `run-tests.js`.

## File inventory lock

**Phase 1 (PR 1) — one atomic commit for gate+baseline+wiring+self-test:**

| File | Action |
|---|---|
| `scripts/gates/verify-circular-deps.sh` | **new** — Gate A |
| `scripts/gates/.baselines/circular-deps.txt` | **new** — `cycle-count:0` (not managed) |
| `scripts/gates/__tests__/verify-circular-deps.test.ts` | **new** — seeded-cycle self-test (plants a fixture cycle in a temp root, asserts exit 1; asserts exit 0 on an acyclic root) |
| `scripts/skill-registry-checkPure.ts` | **new** — Gate B pure function |
| `scripts/validate-skill-registry.ts` | **new** — Gate B CLI wrapper |
| `scripts/__tests__/skill-registry-checkPure.test.ts` | **new** — seeded-violation self-test (one case per violation kind + all-clean case) |
| `.github/workflows/ci.yml` | **edit** — add `Verify gates (circular-deps)` step + `Skill registry alignment` step |
| `scripts/gates/README.md` | **edit** — document `verify-circular-deps.sh` |
| `.claude/CHANGELOG.md` | **edit** — new version heading |
| `.claude/FRAMEWORK_VERSION` + `manifest.json` `frameworkVersion` | **edit** — version bump (minor; number chosen at PR time, e.g. `v2.31.0`) |

**Phase 2 (PR 2) — after PR 1 merges and one full CI cycle is observed green:**

| File | Action |
|---|---|
| `scripts/gates/guard-utils.sh` | **new** — Gate C shared ratchet (auto-covered by `scripts/gates/*.sh` managed glob) |
| `scripts/gates/verify-loc-cap.sh` | **edit** — subdirectory-pattern (most-specific-wins) rule resolution |
| `scripts/gates/verify-duplicate-blocks.sh` | **edit** — source `guard-utils.sh` |
| `scripts/gates/verify-circular-deps.sh` | **edit** — source `guard-utils.sh` |
| `scripts/gates/.baselines/duplicate-blocks.txt` | **new** — `clone-count:<current>` (not managed) |
| `scripts/gates/__tests__/verify-loc-cap-subdir.test.ts` | **new** — nested-cap most-specific-wins self-test |
| `scripts/gates/__tests__/guard-utils.test.ts` | **new** — ratchet + shrink-only self-tests |
| `.github/workflows/ci.yml` | **edit** — add `Verify gates (duplicate-blocks)` step |
| `scripts/gates/README.md` | **edit** — document guard-utils + loc-cap subdir patterns + duplicate-blocks promotion |
| `.claude/CHANGELOG.md`, `FRAMEWORK_VERSION`, `manifest.frameworkVersion` | **edit** — version bump (e.g. `v2.32.0`) |

## Testing posture statement

Per `references/test-gate-policy.md`: gate scripts are CI-only and are proven by **seeded-violation self-tests** (the gate must be observed going red on a planted violation — `ci-gate-integrity` skill §"Prove the gate can fail"). Pure logic (`*Pure.ts`) is unit-tested in isolation; the shell gates are exercised end-to-end against temp fixtures. Positive assertions only — no "no error line appeared" checks (which cannot distinguish "passed" from "never ran").

## §7 — Prove-it-can-fail contract (mandatory)

No gate is "done" until it has been observed failing on a planted violation, with the evidence pasted into `verification-log.md`. Required demonstrations:

| Gate | Planted violation | Expected |
|---|---|---|
| circular-deps | Add a mutual `import` cycle between two temp files under a scan root | gate exits 1, cycle listed |
| circular-deps | Point baseline at `cycle-count:0` with a real cycle present | gate exits 1 |
| circular-deps | Break madge invocation (bad `--extensions`) | fail-closed, exit 1, stderr shown |
| skill-registry | Add a `.claude/skills/_planted/SKILL.md` with no manifest entry | validator exits 1 (`unregistered-skill`) |
| skill-registry | Add a manifest `managedFiles` entry for a nonexistent skill | validator exits 1 (`phantom-entry`) |
| skill-registry | Set a SKILL.md frontmatter `name:` ≠ its dir | validator exits 1 (`name-dir-mismatch`) |
| loc-cap (P2) | A file over a nested subdir cap not covered by the parent rule | gate exits 1 against the *most-specific* cap |
| duplicate-blocks (P2) | A clone that pushes count above the seeded baseline | gate exits 1 |
| guard-utils (P2) | Edit a baseline file upward with no justification token | `assert_shrink_only` exits 1 |

All fixtures are reverted after capture; no planted violation is committed.

## Review plan (per PR)

- **pr-reviewer:** mandatory on every PR.
- **dual-reviewer:** run if Codex is available; if not, record an explicit `REVIEW_GAP` note in the PR body.
- **adversarial-reviewer:** noted as **skipped** — no security-surface files in the diff (gate scripts, CI config, a JSON-registry validator; no auth/tenant/network/secret handling). This is stated explicitly in each PR body.

## ABCd Lifecycle Estimate

| Dimension | Sizing | Notes |
|---|---|---|
| Acquire | S | Requirements known; three decisions locked |
| Build | M | Two shell gates + one Node validator + shared bash lib + self-tests across two PRs |
| Carry | S | Gates are self-maintaining; baselines are the only ongoing state |
| decommission | S | Remove gate script + baseline + ci.yml step + manifest glob is unaffected |

## Deferred items

- **Phase 3** (tenant-isolation-dependent gate) — deferred until the tenant-isolation build lands.
- **Committing `madge`/`jscpd` as devDependencies** — deferred; revisit only if `npx` cold-fetch proves flaky in CI (decided at PR time).

## Open questions

1. **guard-utils `assert_shrink_only` justification token** (Phase 2 only): exact spelling of the recorded-justification marker in the commit body (candidate: `RATCHET-RESEED:` or reuse the loc-cap `ADR-` convention) and whether an unavailable `origin/main` degrades to warning vs hard-fail. Finalize at PR-2 kickoff — does not block PR 1.
2. **Version numbers**: exact `vX.Y.Z` for each PR chosen at PR time against the then-current `FRAMEWORK_VERSION`. Minor bumps assumed (new features, backward compatible).

Everything else: **proceed.**
