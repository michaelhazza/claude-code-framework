'use strict';

/**
 * TEMPLATE — scaffold for a new framework migration. Copy this file to
 * `v<MAJOR>.<MINOR>.<PATCH>.js` (matching `.claude/FRAMEWORK_VERSION` at
 * authoring time) and fill in the marked sections.
 *
 * This file is never executed: the runner's discovery regex
 * (`^v\d+\.\d+\.\d+\.js$` in scripts/run-migrations.js) and the manifest
 * glob (`migrations/v*.js`) both skip underscore-prefixed files.
 *
 * THE CONTRACT
 * ------------
 * - Export a single async function `migrate(ctx)`.
 * - `ctx` is `{ consumerRoot, frameworkRoot, fromVersion, toVersion }`:
 *     consumerRoot   absolute path to the consuming repo root
 *     frameworkRoot  absolute path to the framework checkout (submodule) —
 *                    read canonical files from here, never from consumerRoot
 *     fromVersion    consumer's framework version before this update
 *     toVersion      THIS migration's version (not the bump target)
 * - The runner calls migrate() with `process.cwd() === ctx.consumerRoot`,
 *   but never rely on cwd — always join paths off ctx.consumerRoot /
 *   ctx.frameworkRoot.
 * - Return `{ status, notes }` where notes is a string[] of operator-visible
 *   one-liners and status is one of:
 *     'applied'   the migration made a change (recorded in
 *                 state.appliedMigrations — never runs again)
 *     'skipped'   nothing to do, e.g. change already present (ALSO recorded —
 *                 never runs again)
 *     'conflict'  the migration ran but found local state needing operator
 *                 action (e.g. a customised file that diverges from the
 *                 framework canonical). NOT recorded — the runner re-runs it
 *                 on the next /claudeupdate after the operator resolves the
 *                 conflict. Must be non-destructive: report, don't overwrite.
 * - Throwing aborts the whole run: the runner stops, propagates the error,
 *   and records nothing for this migration. Prefer 'conflict' + notes over
 *   throwing for anything an operator can resolve.
 *
 * RULES
 * -----
 * - Idempotent: safe to re-run. Check whether the change is already applied
 *   before applying it ('skipped' on re-run is the usual shape).
 * - Non-destructive on conflict: never overwrite a locally-customised file.
 * - Use migrations/_helpers.js instead of copy-pasting from old migrations.
 * - Tests are a required deliverable: extend tests/migrations.test.ts
 *   (fresh apply, idempotent re-run, conflict path if any).
 *
 * @param {{ consumerRoot: string, frameworkRoot: string, fromVersion: string, toVersion: string }} ctx
 * @returns {Promise<{ status: 'applied'|'skipped'|'conflict', notes: string[] }>}
 */

// Shared helpers — see migrations/_helpers.js for full JSDoc:
//   normaliseContent / hashContent   BOM/CRLF/trailing-whitespace-insensitive hashing
//   expandGlob                       single-`*` glob expansion (sync.js convention)
//   readConsumerState                read .claude/.framework-state.json (null if absent)
//   persistStateAtomic               tmp-write + rename state persistence
//   adoptNewlyManagedFiles           the adopt-if-matches loop for newly-managed files
//   ensureGitignoreLine              idempotent .gitignore line append
const {
  readConsumerState,
  persistStateAtomic,
  adoptNewlyManagedFiles,
  ensureGitignoreLine, // eslint-disable-line no-unused-vars -- example import; keep what you use
} = require('./_helpers');

async function migrate(ctx) {
  const { consumerRoot, frameworkRoot, toVersion } = ctx;
  const notes = [];

  // -----------------------------------------------------------------------
  // EXAMPLE A — adopt files that became framework-managed in this version,
  // so sync.js doesn't write .framework-new siblings for matching copies.
  // Delete this block if your migration doesn't take ownership of new files.
  // -----------------------------------------------------------------------
  const { state, statePath } = readConsumerState(consumerRoot);
  if (!state) {
    // Pristine adoption — sync.js --adopt will catalogue everything.
    notes.push('No .framework-state.json — assuming pristine adoption. sync.js --adopt will catalogue files; migration is a no-op.');
    return { status: 'skipped', notes };
  }

  const result = adoptNewlyManagedFiles({
    consumerRoot,
    frameworkRoot,
    toVersion,
    state,
    paths: [
      // '.claude/agents/example.md',
      // 'schemas/*.json',
    ],
  });
  notes.push(...result.notes);
  if (result.stateChanged) persistStateAtomic(statePath, state);

  // -----------------------------------------------------------------------
  // EXAMPLE B — idempotent .gitignore rule (see v2.30.0.js for a real one).
  // -----------------------------------------------------------------------
  // const { appended } = await ensureGitignoreLine(consumerRoot, 'some/ephemeral-path/');
  // if (appended) notes.push('Appended some/ephemeral-path/ to .gitignore.');
  // else notes.push('.gitignore already excludes some/ephemeral-path/ — left untouched.');

  // -----------------------------------------------------------------------
  // Derive the status. Typical mapping:
  //   any unresolved divergence  -> 'conflict' (re-runs next update)
  //   made a change              -> 'applied'
  //   nothing to do              -> 'skipped'
  // -----------------------------------------------------------------------
  if (result.conflicts.length > 0) return { status: 'conflict', notes };
  return { status: 'applied', notes };
}

module.exports = { migrate };
