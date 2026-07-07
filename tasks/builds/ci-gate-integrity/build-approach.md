# Build approach — ci-gate-integrity

Companion to `spec.md`. Covers *how* the build is executed: sequencing, per-PR checklists, review routing, and the repo-specific constraints that bite.

## Class & mode

- **Significant class, DIRECT build.** No spec-coordinator, no feature-coordinator. Implemented inline, one phase per PR.
- **Skill gate:** load the `ci-gate-integrity` skill before touching any gate script (already loaded this session).

## Sequencing

```
PR 1 (Phase 1) ──merge──▶ watch one full CI cycle green ──▶ PR 2 (Phase 2)
                                                             Phase 3: BLOCKED on tenant-isolation build
```

Do **not** open PR 2 until PR 1 is merged and one complete CI run on `main` is observed green (the gate steps must be seen actually running, not just present in the YAML).

## Repo-specific constraints (learned from the tree, easy to miss)

1. **No `npm run lint`.** Verification is `npm run test:scripts` (glob-discovered self-tests via `scripts/run-tests.js`) + the new `ci.yml` gate steps run locally where feasible. Do not invent a `lint` script.
2. **Version-consistency gate is enforced by this repo's own CI** (`ci.yml` "Version consistency"): `.claude/FRAMEWORK_VERSION` must equal `manifest.json` `frameworkVersion`, and `.claude/CHANGELOG.md` must have a `## <version>` heading. **Every PR bumps all three together** or CI goes red.
3. **`scripts/gates/*.sh` is already a managed glob** → new gate scripts (`verify-circular-deps.sh`, `guard-utils.sh`) sync to consumers automatically; no per-file manifest edit needed.
4. **Baselines are NOT managed** (`scripts/gates/.baselines/*` stays out of `managedFiles`) — they are repo-local state per the gates README. The framework keeps its own for its own CI.
5. **Skill-registry validator is framework-internal** — keep it out of `managedFiles` (consumers have no `manifest.json` skill registry).
6. **`tasks/**` is in `doNotTouch`** — these build docs won't be synced or overwritten. Correct home.
7. **Windows dev host.** Gate scripts are bash; run/self-test them via the Bash tool / git-bash, and mind POSIX-vs-Win path handling (the duplicate-blocks gate already uses `cygpath` for the Node hop — reuse that pattern).
8. **Never pipe a gate command into its parser** (masks exit codes). Capture to a file, check `$?` / parse the file — as `verify-duplicate-blocks.sh` already does.

## PR 1 checklist (Phase 1)

Author in one atomic commit (gate + baseline + wiring + self-test together — the skill's "verifier and baseline are one landing unit"):

1. Write `verify-circular-deps.sh` (spec § Gate A). Reuse `verify-duplicate-blocks.sh`'s fail-closed JSON-capture shape.
2. Seed `scripts/gates/.baselines/circular-deps.txt` = `cycle-count:0` from the gate's own run on the real tree (confirm still 0 at author time).
3. Write `skill-registry-checkPure.ts` + `validate-skill-registry.ts` + their `__tests__` self-test (spec § Gate B).
4. Wire both into `.github/workflows/ci.yml` (circular-deps gate step over `scripts tests`; `Skill registry alignment` step via `npx tsx`).
5. Update `scripts/gates/README.md`; bump `FRAMEWORK_VERSION` + `manifest.frameworkVersion`; add `.claude/CHANGELOG.md` entry.
6. **§7 prove-it-can-fail:** run each planted violation from spec §7, paste evidence into `verification-log.md`, revert every fixture.
7. Local verify: `npm run test:scripts` green; `bash scripts/gates/verify-circular-deps.sh` exits 0 on the clean tree; `npx tsx scripts/validate-skill-registry.ts` exits 0.
8. Reviews: pr-reviewer (mandatory); dual-reviewer if Codex available else `REVIEW_GAP` in PR body; adversarial-reviewer noted skipped (no security surface).

## PR 2 checklist (Phase 2) — only after PR 1 merged + one green CI cycle

1. Finalize the § Open-questions #1 decision (shrink-only justification token + shallow-clone degrade).
2. Add `scripts/gates/guard-utils.sh`; refactor `verify-duplicate-blocks.sh` + `verify-circular-deps.sh` to source it (behavior-preserving — re-run their self-tests to prove no regression).
3. Extend `verify-loc-cap.sh` for subdirectory patterns (most-specific-wins); add its self-test.
4. Promote duplicate-blocks: add its `ci.yml` step over `scripts tests`; seed `duplicate-blocks.txt` = `clone-count:<current>` from its own output, same commit.
5. Add `guard-utils` self-tests; update README; version bump + CHANGELOG.
6. §7 prove-it-can-fail for every touched gate (loc-cap subdir, duplicate-blocks, guard-utils shrink-only); evidence → `verification-log.md`; revert fixtures.
7. Reviews: same routing as PR 1.

## Definition of done (per phase)

- All touched gates observed failing on a planted violation (evidence in `verification-log.md`).
- `npm run test:scripts` green; new `ci.yml` steps green on the real tree.
- Version/CHANGELOG consistent (repo's own CI gate passes).
- pr-reviewer clean; dual-reviewer clean or `REVIEW_GAP` recorded.
