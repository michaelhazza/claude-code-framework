'use strict';

/**
 * Shared helpers for framework migrations.
 *
 * Extracted from the boilerplate that was copy-pasted across v2.8.0.js,
 * v2.12.0.js/v2.13.0.js, and v2.27.0.js: content normalisation + hashing,
 * single-`*` glob expansion, consumer-state read/persist, the
 * adopt-if-matches loop, and the idempotent .gitignore append.
 *
 * The pre-v2.30.0 migrations keep their inline copies DELIBERATELY — they
 * have already run across the fleet, and refactoring them onto this module
 * would risk behaviour drift in scripts that must stay byte-stable. All NEW
 * migrations require this module instead of copy-pasting.
 *
 * Loading: migrations always execute from the framework checkout
 * (`node .claude-framework/scripts/run-migrations.js ...`), so
 * `require('./_helpers')` resolves against the framework's own migrations/
 * directory. The runner's discovery regex (`^v\d+\.\d+\.\d+\.js$`) and the
 * manifest glob (`migrations/v*.js`) both skip underscore-prefixed files, so
 * this module is never executed as a migration and never deployed to
 * consumers.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * Normalise file content before hashing so BOM, CRLF/CR line endings,
 * trailing whitespace, and trailing-newline differences do not produce
 * spurious hash mismatches between consumer and framework copies.
 *
 * Must stay byte-identical in effect to the inline copies in the pre-v2.30.0
 * migrations and to sync.js's normalisation, or adopt decisions diverge.
 *
 * @param {string} raw
 * @returns {string}
 */
function normaliseContent(raw) {
  let s = raw.startsWith('﻿') ? raw.slice(1) : raw;
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n');
  s = s.replace(/\n+$/, '') + '\n';
  return s;
}

/**
 * @param {string} s — already-normalised content
 * @returns {string} sha256 hex digest
 */
function hashContent(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Expand a manifest-style glob against a root directory. Follows sync.js's
 * single-`*` convention: `*` allowed only in the LAST path segment, no `**`,
 * no absolute paths, no `..`. Literal paths pass through if they exist.
 *
 * @param {string} pattern — e.g. 'schemas/*.json' or 'scripts/foo.ts'
 * @param {string} rootDir — directory to expand against
 * @returns {string[]} sorted relative paths (forward-slash separated)
 */
function expandGlob(pattern, rootDir) {
  if (pattern.includes('**')) throw new Error('** not supported');
  if (path.isAbsolute(pattern) || pattern.split('/').includes('..')) {
    throw new Error(`refusing path: ${pattern}`);
  }
  const segments = pattern.split('/');
  const lastSeg = segments[segments.length - 1];
  const dirSegments = segments.slice(0, -1);
  const dirPath = dirSegments.length > 0 ? path.join(rootDir, ...dirSegments) : rootDir;
  if (!lastSeg.includes('*')) {
    return fs.existsSync(path.join(rootDir, pattern)) ? [pattern] : [];
  }
  let entries;
  try { entries = fs.readdirSync(dirPath); } catch { return []; }
  const starParts = lastSeg.split('*');
  const prefix = starParts[0];
  const suffix = starParts[starParts.length - 1];
  return entries
    .filter((e) => e.startsWith(prefix) && e.endsWith(suffix) && e.length >= prefix.length + suffix.length)
    .map((e) => [...dirSegments, e].join('/'))
    .sort();
}

/**
 * Read the consumer's .claude/.framework-state.json.
 *
 * @param {string} consumerRoot
 * @returns {{ state: object|null, statePath: string }} state is null when the
 *   file is absent or malformed (pristine adoption — most migrations should
 *   then skip their adoption step). When present, `state.files` is guaranteed
 *   to be an object.
 */
function readConsumerState(consumerRoot) {
  const statePath = path.join(consumerRoot, '.claude', '.framework-state.json');
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { state: null, statePath };
  }
  if (!state.files || typeof state.files !== 'object') state.files = {};
  return { state, statePath };
}

/**
 * Atomically persist consumer state (tmp write + rename), matching the
 * runner's own write discipline.
 *
 * @param {string} statePath — as returned by readConsumerState()
 * @param {object} state
 */
function persistStateAtomic(statePath, state) {
  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, statePath);
}

/**
 * Adopt-if-matches loop for files that became framework-managed in a new
 * version. For each path (literal or single-`*` glob, expanded against
 * frameworkRoot):
 *
 *   - already tracked in state        -> skip (alreadyTracked)
 *   - absent in the consumer repo     -> skip (absentLocally; sync.js writes fresh)
 *   - content matches framework       -> write a clean adopted entry into
 *                                        state.files (customisedLocally: false)
 *   - content differs from framework  -> report as conflict; leave the file
 *                                        alone (sync.js writes .framework-new)
 *
 * MUTATES `state.files`. Caller decides whether to persist (use
 * `stateChanged`) and derives the migration status (`conflicts.length > 0`
 * usually means status 'conflict').
 *
 * @param {{ consumerRoot: string, frameworkRoot: string, toVersion: string,
 *           state: object, paths: string[] }} args
 * @returns {{ adopted: number, alreadyTracked: number, absentLocally: number,
 *             conflicts: string[], notes: string[], stateChanged: boolean }}
 */
function adoptNewlyManagedFiles({ consumerRoot, frameworkRoot, toVersion, state, paths }) {
  const notes = [];
  const conflicts = [];
  let adopted = 0;
  let alreadyTracked = 0;
  let absentLocally = 0;

  const expanded = [];
  for (const g of paths) {
    for (const p of expandGlob(g, frameworkRoot)) expanded.push(p);
  }

  for (const rel of expanded) {
    if (state.files[rel]) { alreadyTracked++; continue; }
    const consumerPath = path.join(consumerRoot, rel);
    const frameworkPath = path.join(frameworkRoot, rel);
    if (!fs.existsSync(consumerPath)) { absentLocally++; continue; }

    let consumerContent, frameworkContent;
    try { consumerContent = fs.readFileSync(consumerPath, 'utf8'); } catch { absentLocally++; continue; }
    try { frameworkContent = fs.readFileSync(frameworkPath, 'utf8'); } catch { continue; }

    const consumerHash = hashContent(normaliseContent(consumerContent));
    const frameworkHash = hashContent(normaliseContent(frameworkContent));

    if (consumerHash === frameworkHash) {
      state.files[rel] = {
        lastAppliedHash: consumerHash,
        lastAppliedFrameworkVersion: toVersion,
        lastAppliedFrameworkCommit: null,
        lastAppliedSourcePath: rel,
        customisedLocally: false,
      };
      adopted++;
    } else {
      conflicts.push(rel);
    }
  }

  if (adopted > 0) {
    notes.push(`Auto-adopted ${adopted} pre-existing file(s) whose content matched framework v${toVersion}.`);
  }
  if (alreadyTracked > 0) {
    notes.push(`Skipped ${alreadyTracked} file(s) already tracked in state.`);
  }
  if (absentLocally > 0) {
    notes.push(`Skipped ${absentLocally} file(s) not present locally — sync.js will write fresh.`);
  }
  if (conflicts.length > 0) {
    notes.push(`Conflict: ${conflicts.length} file(s) differ from framework v${toVersion}. sync.js will write .framework-new for manual merge:`);
    for (const c of conflicts) notes.push(`  - ${c}`);
  }

  return { adopted, alreadyTracked, absentLocally, conflicts, notes, stateChanged: adopted > 0 };
}

/**
 * Idempotently ensure a line exists in <consumerRoot>/.gitignore. Creates the
 * file if absent. Matches on the trimmed whole line, so an existing entry
 * with surrounding whitespace still counts. Preserves existing content and
 * appends with a separating newline when the file lacks a trailing one.
 *
 * @param {string} consumerRoot
 * @param {string} line — exact .gitignore rule, e.g. '*.framework-new'
 * @returns {Promise<{ appended: boolean }>} appended=false when the line was
 *   already present (caller typically maps this to status 'skipped')
 */
async function ensureGitignoreLine(consumerRoot, line) {
  const gitignorePath = path.join(consumerRoot, '.gitignore');
  let content = '';
  try { content = fs.readFileSync(gitignorePath, 'utf8'); } catch { /* file absent — will be created */ }

  const hasLine = content
    .split(/\r?\n/)
    .some((l) => l.trim() === line);
  if (hasLine) return { appended: false };

  const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  await fsp.writeFile(gitignorePath, `${content}${sep}${line}\n`, 'utf8');
  return { appended: true };
}

module.exports = {
  normaliseContent,
  hashContent,
  expandGlob,
  readConsumerState,
  persistStateAtomic,
  adoptNewlyManagedFiles,
  ensureGitignoreLine,
};
