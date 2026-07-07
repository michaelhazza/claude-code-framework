'use strict';

const fs = require('fs/promises');
const fsp = fs;
const fsSync = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// JSDoc type definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {'never'|'adoption'} ManifestSubstituteAt
 * @typedef {'sync'|'adopt-only'|'settings-merge'} ManifestMode
 * @typedef {'agent'|'command'|'hook'|'skill'|'settings'|'version'|'changelog'|'adr'|'context-pack'|'reference'|'template'|'review-script'|'review-script-test'|'sync-test'|'review-coordinator'|'review-schema'|'migration-runner'|'migration'|'helper-script'|'helper-script-test'} ManifestCategory
 * @typedef {{ path: string, category: ManifestCategory, mode: ManifestMode, substituteAt: ManifestSubstituteAt }} ManifestEntry
 * @typedef {{ path: string, removedIn: string, action: 'warn-only' }} RemovedFile
 * @typedef {{ frameworkVersion: string, managedFiles: ManifestEntry[], removedFiles: RemovedFile[], doNotTouch: string[] }} Manifest
 * @typedef {Record<string, string>} Substitutions
 * @typedef {{ lastAppliedHash: string, lastAppliedFrameworkVersion: string, lastAppliedFrameworkCommit: string|null, lastAppliedSourcePath: string, customisedLocally: boolean, adoptedOwnership?: boolean }} FileStateEntry
 * @typedef {{ frameworkVersion: string, adoptedAt: string, adoptedFromCommit: string|null, profile: 'MINIMAL'|'STANDARD'|'FULL', substitutions: Substitutions, lastSubstitutionHash?: string, files: Record<string, FileStateEntry>, syncIgnore: string[], appliedMigrations?: string[] }} FrameworkState
 * @typedef {'skipped'|'new'|'customised'|'updated'|'removed-warn'|'ownership-transferred'|'rebaselined'} FileOpStatus
 * @typedef {{ targetRoot: string, frameworkRoot: string, manifest: Manifest, state: FrameworkState|null, frameworkVersion: string, frameworkCommit: string|null, flags: SyncFlags, maintenance?: boolean }} SyncContext
 * @typedef {{ adopt: boolean, dryRun: boolean, check: boolean, strict: boolean, doctor: boolean, force: boolean }} SyncFlags
 */

// ---------------------------------------------------------------------------
// Helper: normaliseContent
// ---------------------------------------------------------------------------

/**
 * Strip BOM, normalise line endings, strip trailing whitespace per line,
 * collapse trailing blank lines to exactly one newline.
 *
 * @param {string} raw
 * @returns {string}
 */
function normaliseContent(raw) {
  // Strip UTF-8 BOM
  let s = raw.startsWith('﻿') ? raw.slice(1) : raw;
  // Normalise line endings: CRLF → LF, then lone CR → LF
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Strip trailing whitespace from each line
  s = s.split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n');
  // Collapse trailing blank lines: trim trailing newlines, add exactly one
  s = s.replace(/\n+$/, '') + '\n';
  return s;
}

// ---------------------------------------------------------------------------
// Helper: hashContent
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex digest of the UTF-8 bytes of `normalised`.
 *
 * @param {string} normalised
 * @returns {string}
 */
function hashContent(normalised) {
  return crypto.createHash('sha256').update(normalised, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Helper: expandGlob
// ---------------------------------------------------------------------------

/**
 * Expand a glob pattern (supports `*` and `{a,b,c}` only) against `rootDir`.
 * Throws if `**` is present.
 *
 * @param {string} pattern  Relative pattern, forward-slash separated.
 * @param {string} rootDir  Absolute directory to expand against.
 * @returns {string[]}      Relative paths (forward slash), sorted lexicographically.
 */
function assertWithinRoot(rootDir, candidate) {
  const rootResolved = path.resolve(rootDir);
  const candResolved = path.resolve(rootDir, candidate);
  if (candResolved !== rootResolved && !candResolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`refusing to use path outside root: ${candidate}`);
  }
}

function expandGlob(pattern, rootDir) {
  if (pattern.includes('**')) {
    throw new Error('** not supported in v1; use multiple manifest entries instead.');
  }
  // Reject manifest paths that could escape the root: absolute paths or paths with .. segments.
  // Defence against a compromised manifest.json declaring "../../etc/passwd" or similar.
  if (path.isAbsolute(pattern) || pattern.split('/').includes('..')) {
    throw new Error(`manifest path must be relative without '..' segments: ${pattern}`);
  }

  // Expand {a,b,c} alternation into multiple literal patterns
  const braceMatch = pattern.match(/\{([^}]+)\}/);
  /** @type {string[]} */
  let patterns;
  if (braceMatch) {
    const prefix = pattern.slice(0, braceMatch.index);
    const suffix = pattern.slice(/** @type {number} */(braceMatch.index) + braceMatch[0].length);
    const alts = braceMatch[1].split(',');
    patterns = alts.map(alt => prefix + alt + suffix);
  } else {
    patterns = [pattern];
  }

  /** @type {Set<string>} */
  const results = new Set();

  for (const pat of patterns) {
    const segments = pat.split('/');
    const lastSeg = segments[segments.length - 1];
    const dirSegments = segments.slice(0, -1);
    const dirPath = dirSegments.length > 0
      ? path.join(rootDir, ...dirSegments)
      : rootDir;

    if (lastSeg.includes('*')) {
      // Glob the directory for matching filenames
      let entries;
      try {
        entries = fsSync.readdirSync(dirPath);
      } catch {
        // Directory doesn't exist — no matches
        continue;
      }
      const starParts = lastSeg.split('*');
      const prefix = starParts[0];
      const suffix = starParts[starParts.length - 1];
      for (const entry of entries) {
        if (entry.startsWith(prefix) && entry.endsWith(suffix) &&
            entry.length >= prefix.length + suffix.length) {
          const rel = [...dirSegments, entry].join('/');
          results.add(rel);
        }
      }
    } else {
      // Literal path — check if file exists
      const fullPath = path.join(rootDir, pat);
      if (fsSync.existsSync(fullPath)) {
        results.add(pat);
      }
    }
  }

  return Array.from(results).sort();
}

// ---------------------------------------------------------------------------
// Helper: hashSubstitutions
// ---------------------------------------------------------------------------

/**
 * Stable SHA-256 hex of the substitutions map (keys sorted for stability).
 *
 * @param {Substitutions} substitutions
 * @returns {string}
 */
function hashSubstitutions(substitutions) {
  const sorted = Object.keys(substitutions).sort();
  const canonical = JSON.stringify(substitutions, sorted);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Helper: loadManifest
// ---------------------------------------------------------------------------

/** Modes a managedFiles entry may declare. Derived from actual manifest.json usage. */
const VALID_MODES = new Set(['sync', 'adopt-only', 'settings-merge']);

/** Categories a managedFiles entry may declare. Derived from actual manifest.json usage. */
const VALID_CATEGORIES = new Set([
  'agent', 'command', 'hook', 'skill', 'settings', 'version', 'changelog',
  'adr', 'context-pack', 'reference', 'template',
  'review-script', 'review-script-test', 'sync-test', 'review-coordinator',
  'review-schema', 'migration-runner', 'migration',
  'helper-script', 'helper-script-test',
]);

/**
 * Returns true when `relativePath` falls under a manifest `doNotTouch` entry.
 * Entries are treated as literal path prefixes: a trailing `/**` is stripped,
 * then the path matches if it equals the entry or lives underneath it.
 * NO glob expansion is performed.
 *
 * @param {string} relativePath  Forward-slash relative path.
 * @param {string[]|undefined} doNotTouch
 * @returns {boolean}
 */
function isDoNotTouch(relativePath, doNotTouch) {
  if (!Array.isArray(doNotTouch)) return false;
  for (const raw of doNotTouch) {
    if (typeof raw !== 'string' || raw === '') continue;
    const base = raw.endsWith('/**') ? raw.slice(0, -3) : raw;
    if (base === '') continue;
    if (relativePath === base || relativePath.startsWith(base + '/')) return true;
  }
  return false;
}

/**
 * Read, parse, and validate `manifest.json` from the framework root.
 * Detects duplicate and overlapping glob entries, validates mode/category
 * enums, and cross-checks manifest.frameworkVersion against the
 * `.claude/FRAMEWORK_VERSION` file when present.
 *
 * @param {string} frameworkRoot
 * @returns {Manifest}
 */
function loadManifest(frameworkRoot) {
  const manifestPath = path.join(frameworkRoot, 'manifest.json');
  let raw;
  try {
    raw = fsSync.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read manifest.json: ${/** @type {Error} */(err).message}`);
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${/** @type {Error} */(err).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('manifest.json must be a JSON object');
  }

  const obj = /** @type {Record<string, unknown>} */ (parsed);

  if (typeof obj['frameworkVersion'] !== 'string') {
    throw new Error('manifest.json missing required field: frameworkVersion (string)');
  }
  if (!Array.isArray(obj['managedFiles'])) {
    throw new Error('manifest.json missing required field: managedFiles (array)');
  }
  if (!Array.isArray(obj['removedFiles'])) {
    throw new Error('manifest.json missing required field: removedFiles (array)');
  }
  if (!Array.isArray(obj['doNotTouch'])) {
    throw new Error('manifest.json missing required field: doNotTouch (array)');
  }

  const manifest = /** @type {Manifest} */ (parsed);

  // Cross-check: manifest.frameworkVersion must agree with .claude/FRAMEWORK_VERSION.
  // The two are bumped together at release time; drift means a half-finished release
  // (or a hand-edit) and would make changelog excerpts / state records lie.
  const versionFilePath = path.join(frameworkRoot, '.claude', 'FRAMEWORK_VERSION');
  if (fsSync.existsSync(versionFilePath)) {
    const fileVersion = fsSync.readFileSync(versionFilePath, 'utf8').trim();
    if (fileVersion !== manifest.frameworkVersion) {
      throw new Error(
        `manifest.json frameworkVersion (${manifest.frameworkVersion}) does not match ` +
        `.claude/FRAMEWORK_VERSION (${fileVersion}). The framework checkout is inconsistent — ` +
        `both are bumped together at release; refusing to sync until they agree.`
      );
    }
  }

  // Per-entry enum validation: catch typo'd modes/categories before any classification runs.
  for (const entry of manifest.managedFiles) {
    if (typeof entry.path !== 'string' || entry.path === '') {
      throw new Error('manifest.json managedFiles entry missing required string field: path');
    }
    if (!VALID_MODES.has(entry.mode)) {
      throw new Error(
        `manifest.json entry ${entry.path} has invalid mode "${entry.mode}" ` +
        `(expected one of: ${Array.from(VALID_MODES).join(', ')})`
      );
    }
    if (!VALID_CATEGORIES.has(entry.category)) {
      throw new Error(
        `manifest.json entry ${entry.path} has invalid category "${entry.category}" ` +
        `(expected one of: ${Array.from(VALID_CATEGORIES).join(', ')})`
      );
    }
  }

  // Overlap detection: expand globs against frameworkRoot, build path→entries index
  /** @type {Map<string, ManifestEntry[]>} */
  const pathIndex = new Map();

  for (const entry of manifest.managedFiles) {
    const expanded = expandGlob(entry.path, frameworkRoot);
    for (const p of expanded) {
      if (!pathIndex.has(p)) pathIndex.set(p, []);
      /** @type {ManifestEntry[]} */ (pathIndex.get(p)).push(entry);
    }
  }

  for (const [p, entries] of Array.from(pathIndex)) {
    if (entries.length < 2) continue;

    const hasSettingsMerge = entries.some(e => e.mode === 'settings-merge');
    if (hasSettingsMerge) {
      throw new Error(
        `ERROR: manifest overlap at ${p}: settings-merge mode is exclusive`
      );
    }

    const allIdentical = entries.every(e =>
      e.mode === entries[0].mode &&
      e.category === entries[0].category &&
      e.substituteAt === entries[0].substituteAt
    );

    if (allIdentical) {
      process.stderr.write(`WARN: manifest path ${p} matched by ${entries.length} entries (identical config; first wins)\n`);
    } else {
      throw new Error(
        `ERROR: manifest overlap conflict at ${p}: entry has mode=${entries[0].mode} but another has mode=${entries[1].mode}`
      );
    }
  }

  return manifest;
}

// ---------------------------------------------------------------------------
// Helper: readState
// ---------------------------------------------------------------------------

/**
 * Read `.framework-state.json` from the target repo root.
 * Returns null if the file is missing.
 *
 * @param {string} targetRoot
 * @returns {FrameworkState|null}
 */
function readState(targetRoot) {
  const statePath = path.join(targetRoot, '.claude', '.framework-state.json');
  try {
    const raw = fsSync.readFileSync(statePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: writeStateAtomic
// ---------------------------------------------------------------------------

/**
 * Atomically write state to `.framework-state.json` via a tmp file + rename.
 *
 * @param {string} targetRoot
 * @param {FrameworkState} state
 * @returns {Promise<void>}
 */
async function writeStateAtomic(targetRoot, state) {
  const dir = path.join(targetRoot, '.claude');
  const finalPath = path.join(dir, '.framework-state.json');
  // PID-suffix the tmp file so two concurrent sync processes (e.g. CI matrix, operator + Claude
  // session running sync simultaneously) cannot clobber each other's tmp before rename.
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  const json = JSON.stringify(state, null, 2) + '\n';
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, json, 'utf8');
  await fs.rename(tmpPath, finalPath);
}

// ---------------------------------------------------------------------------
// Helper: readFrameworkVersion
// ---------------------------------------------------------------------------

/**
 * Read and validate the framework version string.
 *
 * @param {string} frameworkRoot
 * @returns {string}
 */
function readFrameworkVersion(frameworkRoot) {
  const versionPath = path.join(frameworkRoot, '.claude', 'FRAMEWORK_VERSION');
  let raw;
  try {
    raw = fsSync.readFileSync(versionPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read FRAMEWORK_VERSION: ${/** @type {Error} */(err).message}`);
  }
  const version = raw.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`FRAMEWORK_VERSION is not a valid semver: "${version}"`);
  }
  return version;
}

// ---------------------------------------------------------------------------
// Helper: getSubmoduleCommit
// ---------------------------------------------------------------------------

/**
 * Get the current commit SHA of the framework submodule.
 * Returns null if not in a git repo (synthetic-test mode).
 *
 * @param {string} frameworkRoot
 * @returns {string|null}
 */
function getSubmoduleCommit(frameworkRoot) {
  // spawnSync with array args avoids shell interpretation of frameworkRoot —
  // a path containing shell metacharacters cannot break out of the argument.
  const result = spawnSync('git', ['-C', frameworkRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout).trim();
}

// ---------------------------------------------------------------------------
// Helper: checkSubmoduleClean
// ---------------------------------------------------------------------------

/**
 * Check whether the framework submodule has uncommitted changes.
 *
 * @param {string} frameworkRoot
 * @returns {{ clean: boolean, reason?: string }}
 */
function checkSubmoduleClean(frameworkRoot) {
  const result = spawnSync('git', ['-C', frameworkRoot, 'status', '--porcelain'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    // Not in a git repo — synthetic-test mode
    return { clean: true };
  }
  if (String(result.stdout).trim() === '') {
    return { clean: true };
  }
  return { clean: false, reason: 'uncommitted changes' };
}

// ---------------------------------------------------------------------------
// Helper: scanForUnresolvedMerges
// ---------------------------------------------------------------------------

/**
 * Return managed paths that have a `.framework-new` sibling in `targetRoot`.
 *
 * @param {string} targetRoot
 * @param {Manifest} manifest
 * @returns {string[]}
 */
function scanForUnresolvedMerges(targetRoot, manifest) {
  /** @type {string[]} */
  const unresolved = [];
  for (const entry of manifest.managedFiles) {
    const expanded = expandGlob(entry.path, targetRoot);
    for (const rel of expanded) {
      const newFilePath = path.join(targetRoot, rel + '.framework-new');
      if (fsSync.existsSync(newFilePath)) {
        unresolved.push(rel);
      }
    }
  }
  return unresolved.sort();
}

// ---------------------------------------------------------------------------
// Helper: logFileOp
// ---------------------------------------------------------------------------

/**
 * Emit a structured per-file operation log line to stdout.
 *
 * @param {string} filePath
 * @param {FileOpStatus} status
 * @param {Record<string, string>} [extra]
 * @returns {void}
 */
function logFileOp(filePath, status, extra = {}) {
  let line = `SYNC file=${filePath} status=${status}`;
  for (const [k, v] of Object.entries(extra)) {
    line += ` ${k}=${v}`;
  }
  process.stdout.write(line + '\n');
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {SyncFlags}
 */
function parseFlags(argv) {
  const known = new Set(['--adopt', '--dry-run', '--check', '--strict', '--doctor', '--force']);
  const flags = { adopt: false, dryRun: false, check: false, strict: false, doctor: false, force: false };
  for (const arg of argv) {
    if (!known.has(arg)) {
      process.stderr.write(`ERROR: Unknown flag "${arg}". Supported: ${Array.from(known).join(', ')}\n`);
      process.exit(1);
    }
    if (arg === '--adopt') flags.adopt = true;
    if (arg === '--dry-run') flags.dryRun = true;
    if (arg === '--check') flags.check = true;
    if (arg === '--strict') flags.strict = true;
    if (arg === '--doctor') flags.doctor = true;
    if (arg === '--force') flags.force = true;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// expandManagedFiles
// ---------------------------------------------------------------------------

/**
 * Expands all managed file globs in manifest order.
 * Returns flat list with the first matching entry per concrete path (deduplication).
 * @param {Manifest} manifest
 * @param {string} frameworkRoot
 * @returns {Array<{entry: ManifestEntry, relativePath: string}>}
 */
function expandManagedFiles(manifest, frameworkRoot) {
  const seen = new Set();
  const result = [];
  for (const entry of manifest.managedFiles) {
    const paths = expandGlob(entry.path, frameworkRoot);
    for (const p of paths) {
      if (!seen.has(p)) {
        seen.add(p);
        result.push({ entry, relativePath: p });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// classifyFile
// ---------------------------------------------------------------------------

/**
 * Classifies a file's sync status.
 * @param {SyncContext} ctx
 * @param {ManifestEntry} entry
 * @param {string} relativePath
 * @returns {{ kind: 'skipped', reason: 'syncIgnore'|'adopt-only'|'already-on-version' } | { kind: 'ownership-transferred' } | { kind: 'clean', needsUpdate: boolean } | { kind: 'customised' } | { kind: 'new-file-no-state', targetExists: boolean } | { kind: 'settings-merge' }}
 */
function classifyFile(ctx, entry, relativePath) {
  const { state, frameworkVersion } = ctx;

  // syncIgnore check
  if (state && state.syncIgnore && state.syncIgnore.includes(relativePath)) {
    return { kind: 'skipped', reason: 'syncIgnore' };
  }

  // Mode-change check: if state entry recorded a different mode and new mode is adopt-only
  const stateEntry = state && state.files ? state.files[relativePath] : null;
  if (stateEntry && entry.mode === 'adopt-only' && !stateEntry.adoptedOwnership) {
    return { kind: 'ownership-transferred' };
  }

  // adopt-only: skip if state entry already exists (project owns it post-adoption)
  if (entry.mode === 'adopt-only') {
    if (stateEntry) {
      return { kind: 'skipped', reason: 'adopt-only' };
    }
    // No state entry + adopt-only = new file path (treat via new-file logic)
  }

  // settings-merge mode
  if (entry.mode === 'settings-merge') {
    return { kind: 'settings-merge' };
  }

  // New-file check: no state entry for this path
  if (!stateEntry) {
    const targetPath = path.join(ctx.targetRoot, relativePath);
    const targetExists = fsSync.existsSync(targetPath);
    return { kind: 'new-file-no-state', targetExists };
  }

  // For sync mode: read target + hash + compare
  const targetPath = path.join(ctx.targetRoot, relativePath);
  let targetContent;
  try {
    targetContent = fsSync.readFileSync(targetPath, 'utf8');
  } catch (err) {
    // File missing but has state entry - treat as customised (operator deleted it)
    return { kind: 'customised' };
  }
  const targetHash = hashContent(normaliseContent(targetContent));

  if (targetHash === stateEntry.lastAppliedHash) {
    // Clean: check if needs update
    if (stateEntry.lastAppliedFrameworkVersion === frameworkVersion) {
      return { kind: 'skipped', reason: 'already-on-version' };
    }
    return { kind: 'clean', needsUpdate: true };
  }

  // Target diverges from last-applied hash. Two possibilities:
  // (a) Operator edited the file (anywhere) → customised → .framework-new
  // (b) Operator edited only inside LOCAL-OVERRIDE blocks (v2.10.0) → clean + needsUpdate;
  //     writeUpdated will re-inject their override content and update the hash.
  // Check (b) by synthesising "current framework + consumer's current override contents"
  // and comparing against the consumer's actual content.
  const sourcePath = path.join(ctx.frameworkRoot, relativePath);
  let fwContent;
  try { fwContent = fsSync.readFileSync(sourcePath, 'utf8'); } catch { return { kind: 'customised' }; }
  if (entry.substituteAt !== 'never') {
    fwContent = applySubstitutions(fwContent, state && state.substitutions ? state.substitutions : {});
  }
  const inj = injectConsumerOverrides(fwContent, targetPath);
  if (inj.frameworkBlockNames.length === 0) {
    // No override slots in framework — divergence is real customisation.
    return { kind: 'customised' };
  }
  const synthesisedHash = hashContent(normaliseContent(inj.injected));
  if (synthesisedHash === targetHash) {
    // Consumer edits live entirely within LOCAL-OVERRIDE blocks — clean.
    // Mark as needing update so the new framework version (with consumer's overrides re-injected) gets written;
    // even if framework content is identical, we still want lastAppliedHash and lastAppliedFrameworkVersion refreshed.
    return { kind: 'clean', needsUpdate: true };
  }
  return { kind: 'customised' };
}

// ---------------------------------------------------------------------------
// Helper: validateSubstitutions
// ---------------------------------------------------------------------------

/**
 * Validates the substitution map. Throws if any value contains "{{".
 * Emits a warning if the map is empty.
 * @param {Substitutions} substitutions
 */
function validateSubstitutions(substitutions) {
  for (const [key, value] of Object.entries(substitutions)) {
    if (value.includes('{{')) {
      throw new Error(
        `substitution value for ${key} contains {{; would break idempotency. Fix .framework-state.json substitutions and re-run.`
      );
    }
  }
  if (Object.keys(substitutions).length === 0) {
    process.stderr.write(
      `WARN: substitution map is empty — files with substituteAt: "adoption" will retain literal {{PLACEHOLDER}} content.\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Helper: checkSubstitutionDrift
// ---------------------------------------------------------------------------

/**
 * Checks whether the substitution map has changed since the last sync.
 * @param {FrameworkState} state
 * @param {SyncFlags} flags
 * @returns {{ drift: boolean, reason?: string }}
 */
function checkSubstitutionDrift(state, flags) {
  if (flags.adopt || flags.force) return { drift: false };
  if (!state.lastSubstitutionHash) return { drift: false }; // forward-migration: first run
  const currentHash = hashSubstitutions(state.substitutions);
  if (state.lastSubstitutionHash === currentHash) return { drift: false };
  return {
    drift: true,
    reason: `state.substitutions changed since last sync (hash mismatch).\n` +
      `       Sync would leave already-current files at old substitution values,\n` +
      `       producing silent inconsistency.\n` +
      `\n` +
      `Resolution: run \`node .claude-framework/sync.js --adopt\` to rebaseline.\n` +
      `            This re-writes every managed file under the new substitutions\n` +
      `            and updates lastAppliedHash + lastSubstitutionHash atomically.`,
  };
}

// ---------------------------------------------------------------------------
// Helper: applySubstitutions
// ---------------------------------------------------------------------------

/**
 * Applies substitutions to content. Single-pass replaceAll for each placeholder.
 * Only acts on {{PLACEHOLDER}} format. Idempotent given pre-validated map.
 * @param {string} content
 * @param {Substitutions} substitutions
 * @returns {string}
 */
function applySubstitutions(content, substitutions) {
  let result = content;
  for (const [key, value] of Object.entries(substitutions)) {
    // Use split+join for global replacement without requiring ES2021 lib
    result = result.split(`{{${key}}}`).join(value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// LOCAL-OVERRIDE block mechanism (v2.10.0)
// ---------------------------------------------------------------------------
//
// Allows the framework to declare named slots in a managed file where the
// consumer can put app-specific content that sync.js preserves on update.
// Markers are HTML comments (invisible in markdown render) of the form:
//
//   <!-- LOCAL-OVERRIDE:start name="rule-list-extension" -->
//   ... default content (replaced by consumer content if consumer has any) ...
//   <!-- LOCAL-OVERRIDE:end name="rule-list-extension" -->
//
// On sync.js update for any managed file:
//   1. Read framework content, apply substitutions, normalise.
//   2. Scan for LOCAL-OVERRIDE markers — collect block boundaries + names.
//   3. If consumer's existing file has the same named blocks, extract the
//      consumer's content between markers and inject into the framework version.
//   4. The resulting "framework structure + consumer overrides" is what
//      sync.js writes to disk; its hash is what gets recorded in state.
//
// Names must match `^[a-z0-9][a-z0-9_-]*$`. Duplicate names within a single
// file are an error. Nested blocks are not supported.

const OVERRIDE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const OVERRIDE_START_RE = /<!--\s*LOCAL-OVERRIDE:start\s+name="([^"]+)"\s*-->/g;
const OVERRIDE_END_RE = /<!--\s*LOCAL-OVERRIDE:end\s+name="([^"]+)"\s*-->/g;

/**
 * Parse all LOCAL-OVERRIDE blocks in `content`.
 * @param {string} content
 * @returns {{ blocks: Map<string, { startIdx: number, endIdx: number, contentStart: number, contentEnd: number }>, errors: string[] }}
 *   - blocks: keyed by name; offsets are character positions in `content`.
 *     startIdx/endIdx span from before `<!-- LOCAL-OVERRIDE:start ... -->` to after `<!-- LOCAL-OVERRIDE:end ... -->`.
 *     contentStart/contentEnd span just the content between markers (excluding the marker comments themselves).
 *   - errors: human-readable validation failures; non-empty means content is malformed.
 */
function parseOverrideBlocks(content) {
  /** @type {Map<string, { startIdx: number, endIdx: number, contentStart: number, contentEnd: number }>} */
  const blocks = new Map();
  /** @type {string[]} */
  const errors = [];

  /** @type {{ name: string, startIdx: number, contentStart: number }[]} */
  const opens = [];
  const startMatches = [];
  const endMatches = [];

  let m;
  const startRe = new RegExp(OVERRIDE_START_RE.source, 'g');
  while ((m = startRe.exec(content)) !== null) {
    startMatches.push({ name: m[1], startIdx: m.index, contentStart: m.index + m[0].length });
  }
  const endRe = new RegExp(OVERRIDE_END_RE.source, 'g');
  while ((m = endRe.exec(content)) !== null) {
    endMatches.push({ name: m[1], contentEnd: m.index, endIdx: m.index + m[0].length });
  }

  // Interleave start/end in order of appearance
  /** @type {{ kind: 'start'|'end', name: string, pos: number, info: any }[]} */
  const events = [
    ...startMatches.map(s => ({ kind: /** @type {'start'} */('start'), name: s.name, pos: s.startIdx, info: s })),
    ...endMatches.map(e => ({ kind: /** @type {'end'} */('end'), name: e.name, pos: e.contentEnd, info: e })),
  ].sort((a, b) => a.pos - b.pos);

  for (const ev of events) {
    if (!OVERRIDE_NAME_RE.test(ev.name)) {
      errors.push(`invalid LOCAL-OVERRIDE block name "${ev.name}" (must match /^[a-z0-9][a-z0-9_-]*$/)`);
      continue;
    }
    if (ev.kind === 'start') {
      if (opens.length > 0) {
        errors.push(`LOCAL-OVERRIDE block "${ev.name}" starts before previous block "${opens[opens.length - 1].name}" closes (nested blocks not supported)`);
        continue;
      }
      if (blocks.has(ev.name)) {
        errors.push(`duplicate LOCAL-OVERRIDE block name "${ev.name}" in the same file`);
        continue;
      }
      opens.push({ name: ev.name, startIdx: ev.info.startIdx, contentStart: ev.info.contentStart });
    } else {
      const open = opens.pop();
      if (!open) {
        errors.push(`LOCAL-OVERRIDE end "${ev.name}" with no matching start`);
        continue;
      }
      if (open.name !== ev.name) {
        errors.push(`LOCAL-OVERRIDE end "${ev.name}" does not match preceding start "${open.name}"`);
        continue;
      }
      blocks.set(ev.name, {
        startIdx: open.startIdx,
        endIdx: ev.info.endIdx,
        contentStart: open.contentStart,
        contentEnd: ev.info.contentEnd,
      });
    }
  }
  for (const stillOpen of opens) {
    errors.push(`LOCAL-OVERRIDE block "${stillOpen.name}" started but never closed`);
  }
  return { blocks, errors };
}

/**
 * Extract the consumer's content for each named override block, keyed by name.
 * Returns null if `consumerContent` is malformed (errors present).
 *
 * @param {string} consumerContent
 * @returns {Map<string, string> | null}
 */
function extractOverrideContents(consumerContent) {
  const { blocks, errors } = parseOverrideBlocks(consumerContent);
  if (errors.length > 0) return null;
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const [name, b] of blocks) {
    out.set(name, consumerContent.slice(b.contentStart, b.contentEnd));
  }
  return out;
}

/**
 * Inject consumer override contents into framework content. For each LOCAL-OVERRIDE block
 * in `frameworkContent` whose name appears in `consumerOverrides`, replace the framework
 * default content between the markers with the consumer's content.
 *
 * Block markers themselves stay intact (sourced from framework). If the consumer has an
 * override for a name the framework doesn't declare, that override is dropped — the framework
 * controls slot existence.
 *
 * @param {string} frameworkContent  framework-canonical content (post-substitution)
 * @param {Map<string, string>} consumerOverrides
 * @returns {{ result: string, frameworkBlockNames: string[], orphanedConsumerNames: string[], errors: string[] }}
 */
function injectOverrides(frameworkContent, consumerOverrides) {
  const { blocks, errors } = parseOverrideBlocks(frameworkContent);
  if (errors.length > 0) {
    return { result: frameworkContent, frameworkBlockNames: [], orphanedConsumerNames: [], errors };
  }
  const frameworkBlockNames = Array.from(blocks.keys());
  const orphanedConsumerNames = Array.from(consumerOverrides.keys()).filter(n => !blocks.has(n));

  // Rewrite in reverse order so earlier offsets stay valid as we mutate the string.
  const ordered = Array.from(blocks.entries()).sort((a, b) => b[1].contentStart - a[1].contentStart);
  let result = frameworkContent;
  for (const [name, b] of ordered) {
    if (!consumerOverrides.has(name)) continue;
    const consumerSlot = consumerOverrides.get(name) || '';
    result = result.slice(0, b.contentStart) + consumerSlot + result.slice(b.contentEnd);
  }
  return { result, frameworkBlockNames, orphanedConsumerNames, errors: [] };
}

/**
 * Convenience: given framework content + consumer file path, compute the "what should
 * land on disk" content with consumer's overrides preserved. Returns the framework content
 * unchanged when no override blocks are present or consumer file is missing/malformed.
 *
 * @param {string} frameworkContent
 * @param {string} consumerPath  Absolute path to consumer's existing file (may not exist).
 * @returns {{ injected: string, frameworkBlockNames: string[], orphanedConsumerNames: string[], malformed: boolean }}
 */
function injectConsumerOverrides(frameworkContent, consumerPath) {
  const { blocks: fwBlocks, errors: fwErrors } = parseOverrideBlocks(frameworkContent);
  if (fwErrors.length > 0) {
    // Framework itself has malformed override markers — leave as-is, surface via caller log.
    return { injected: frameworkContent, frameworkBlockNames: [], orphanedConsumerNames: [], malformed: true };
  }
  if (fwBlocks.size === 0) {
    return { injected: frameworkContent, frameworkBlockNames: [], orphanedConsumerNames: [], malformed: false };
  }
  let consumerContent;
  try {
    consumerContent = fsSync.readFileSync(consumerPath, 'utf8');
  } catch {
    // Consumer file missing — framework defaults stand.
    return { injected: frameworkContent, frameworkBlockNames: Array.from(fwBlocks.keys()), orphanedConsumerNames: [], malformed: false };
  }
  const consumerOverrides = extractOverrideContents(consumerContent);
  if (!consumerOverrides) {
    // Consumer's override markers are malformed; treat as no overrides (framework defaults stand).
    return { injected: frameworkContent, frameworkBlockNames: Array.from(fwBlocks.keys()), orphanedConsumerNames: [], malformed: false };
  }
  const r = injectOverrides(frameworkContent, consumerOverrides);
  return { injected: r.result, frameworkBlockNames: r.frameworkBlockNames, orphanedConsumerNames: r.orphanedConsumerNames, malformed: false };
}

// ---------------------------------------------------------------------------
// Writer stubs (implemented in Chunks 5 and 6)
// ---------------------------------------------------------------------------

/**
 * Write-refusal gate shared by all writers: refuse to touch any path under a
 * manifest `doNotTouch` entry. Returns true when the write was refused.
 * @param {SyncContext} ctx @param {string} relativePath @returns {boolean}
 */
function refuseIfDoNotTouch(ctx, relativePath) {
  const doNotTouch = ctx.manifest ? ctx.manifest.doNotTouch : undefined;
  if (!isDoNotTouch(relativePath, doNotTouch)) return false;
  process.stderr.write(
    `NOTE: ${relativePath} matches a manifest doNotTouch entry — refusing to write. ` +
    `Remove the path from doNotTouch (or from managedFiles) to resolve.\n`
  );
  logFileOp(relativePath, 'skipped', { reason: 'doNotTouch' });
  return true;
}

/** @param {SyncContext} ctx @param {ManifestEntry} entry @param {string} relativePath @returns {Promise<void>} */
async function writeUpdated(ctx, entry, relativePath) {
  const { frameworkRoot, targetRoot, flags } = ctx;
  if (refuseIfDoNotTouch(ctx, relativePath)) return;
  // Defence-in-depth: assert relativePath stays within both roots even if expandGlob's guard regresses.
  assertWithinRoot(frameworkRoot, relativePath);
  assertWithinRoot(targetRoot, relativePath);
  // Read framework source
  const sourcePath = path.join(frameworkRoot, relativePath);
  let content = await fs.readFile(sourcePath, 'utf8');
  // Apply substitutions if applicable
  if (entry.substituteAt !== 'never') {
    content = applySubstitutions(content, ctx.state ? ctx.state.substitutions : {});
  }
  const targetPath = path.join(targetRoot, relativePath);
  // Apply LOCAL-OVERRIDE blocks: if the framework declares override slots and the consumer
  // has filled them, preserve the consumer's content between the markers.
  const inj = injectConsumerOverrides(content, targetPath);
  const finalContent = inj.injected;
  const normalisedContent = normaliseContent(finalContent);
  const newHash = hashContent(normalisedContent);

  /** @type {Record<string, string>} */
  const extra = {};
  if (inj.frameworkBlockNames.length > 0) extra.override_slots = String(inj.frameworkBlockNames.length);
  if (inj.orphanedConsumerNames.length > 0) {
    process.stderr.write(
      `WARN: ${relativePath} — consumer has LOCAL-OVERRIDE block(s) not declared by framework: ${inj.orphanedConsumerNames.join(', ')}. ` +
      `Content dropped; remove the orphan block from your local copy or re-add the slot in framework.\n`
    );
    extra.orphan_overrides = inj.orphanedConsumerNames.join(',');
  }
  if (inj.malformed) extra.framework_overrides_malformed = 'true';

  if (!flags.dryRun) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, normalisedContent, 'utf8');
    // Update state
    if (ctx.state) {
      ctx.state.files[relativePath] = {
        ...ctx.state.files[relativePath],
        lastAppliedHash: newHash,
        lastAppliedFrameworkVersion: ctx.frameworkVersion,
        lastAppliedFrameworkCommit: ctx.frameworkCommit,
        lastAppliedSourcePath: entry.path,
        customisedLocally: false,
      };
    }
  }

  if (flags.dryRun) extra.dry_run = 'true';
  logFileOp(relativePath, 'updated', extra);
}

/** @param {SyncContext} ctx @param {ManifestEntry} entry @param {string} relativePath @returns {Promise<void>} */
async function writeFrameworkNew(ctx, entry, relativePath) {
  const { frameworkRoot, targetRoot, flags } = ctx;
  if (refuseIfDoNotTouch(ctx, relativePath)) return;
  assertWithinRoot(frameworkRoot, relativePath);
  assertWithinRoot(targetRoot, relativePath);
  const sourcePath = path.join(frameworkRoot, relativePath);
  let content = await fs.readFile(sourcePath, 'utf8');
  if (entry.substituteAt !== 'never') {
    content = applySubstitutions(content, ctx.state ? ctx.state.substitutions : {});
  }
  const targetPath = path.join(targetRoot, relativePath);
  // Inject consumer's LOCAL-OVERRIDE block contents into .framework-new too, so the
  // operator's manual merge diff only shows the actually-customised-outside-blocks lines.
  const injNew = injectConsumerOverrides(content, targetPath);
  const normalisedContent = normaliseContent(injNew.injected);

  const newFilePath = `${targetPath}.framework-new`;

  /** @type {Record<string, string>} */
  const extra = {};
  const priorExists = await fs.stat(newFilePath).then(() => true).catch(() => false);
  if (priorExists) extra.prior_framework_new = 'replaced';

  // Inline manual-merge detection hint (non-blocking observability)
  // If no prior .framework-new and target mtime > state.json mtime by a few seconds → possible manual merge without re-run
  if (!priorExists) {
    try {
      const statJson = await fs.stat(path.join(targetRoot, '.claude', '.framework-state.json'));
      const statTarget = await fs.stat(targetPath);
      if (statTarget.mtimeMs - statJson.mtimeMs > 5000) {
        extra.inline_check = 'hash_drift_no_priorMerge';
      }
    } catch { /* ignore if state file missing */ }
  }

  if (!flags.dryRun) {
    await fs.mkdir(path.dirname(newFilePath), { recursive: true });
    await fs.writeFile(newFilePath, normalisedContent, 'utf8');
    if (ctx.state && ctx.state.files[relativePath]) {
      ctx.state.files[relativePath].customisedLocally = true;
    }
  }

  if (flags.dryRun) extra.dry_run = 'true';

  process.stderr.write(
    `MANUAL MERGE: ${relativePath} — customised. See ${relativePath}.framework-new. ` +
    `Merge, delete .framework-new, re-run sync.\n`
  );
  logFileOp(relativePath, 'customised', extra);
}

/** @param {SyncContext} ctx @param {ManifestEntry} entry @param {string} relativePath @returns {Promise<void>} */
async function writeNewFile(ctx, entry, relativePath) {
  const { frameworkRoot, targetRoot, flags } = ctx;
  if (refuseIfDoNotTouch(ctx, relativePath)) return;
  assertWithinRoot(frameworkRoot, relativePath);
  assertWithinRoot(targetRoot, relativePath);
  const sourcePath = path.join(frameworkRoot, relativePath);
  let content = await fs.readFile(sourcePath, 'utf8');
  if (entry.substituteAt !== 'never') {
    content = applySubstitutions(content, ctx.state ? ctx.state.substitutions : {});
  }
  const normalisedContent = normaliseContent(content);
  const newHash = hashContent(normalisedContent);
  const targetPath = path.join(targetRoot, relativePath);
  const targetExists = await fs.stat(targetPath).then(() => true).catch(() => false);

  if (!targetExists) {
    // Branch 1: target missing — write fresh
    if (!flags.dryRun) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, normalisedContent, 'utf8');
      if (ctx.state) {
        if (!ctx.state.files) ctx.state.files = {};
        ctx.state.files[relativePath] = {
          lastAppliedHash: newHash,
          lastAppliedFrameworkVersion: ctx.frameworkVersion,
          lastAppliedFrameworkCommit: ctx.frameworkCommit,
          lastAppliedSourcePath: entry.path,
          customisedLocally: false,
          ...(entry.mode === 'adopt-only' ? { adoptedOwnership: true } : {}),
        };
      }
    }
    const extra = flags.dryRun ? { dry_run: 'true' } : {};
    logFileOp(relativePath, 'new', extra);
  } else {
    // Branch 2: target exists but no state entry
    if (ctx.flags && ctx.flags.adopt) {
      // --adopt mode: catalogue existing file, do NOT write .framework-new, do NOT overwrite
      if (!ctx.flags.dryRun) {
        const existingContent = await fsp.readFile(targetPath, 'utf8');
        const existingHash = hashContent(normaliseContent(existingContent));
        if (ctx.state) {
          if (!ctx.state.files) ctx.state.files = {};
          ctx.state.files[relativePath] = {
            lastAppliedHash: existingHash,
            lastAppliedFrameworkVersion: ctx.frameworkVersion,
            lastAppliedFrameworkCommit: ctx.frameworkCommit,
            lastAppliedSourcePath: entry.path,
            customisedLocally: false,
            ...(entry.mode === 'adopt-only' ? { adoptedOwnership: true } : {}),
          };
        }
      }
      const extra = { reason: 'catalogued-existing', ...(ctx.flags.dryRun ? { dry_run: 'true' } : {}) };
      logFileOp(relativePath, 'new', extra);
    } else {
      // Non-adopt mode: file exists but not in state — write .framework-new
      // Preserve consumer's LOCAL-OVERRIDE block contents in the .framework-new so the
      // operator's merge view focuses on out-of-block divergence only.
      const injOrphan = injectConsumerOverrides(content, targetPath);
      const orphanFinal = normaliseContent(injOrphan.injected);
      if (!flags.dryRun) {
        const newFilePath = `${targetPath}.framework-new`;
        await fs.mkdir(path.dirname(newFilePath), { recursive: true });
        await fs.writeFile(newFilePath, orphanFinal, 'utf8');
        if (ctx.state) {
          if (!ctx.state.files) ctx.state.files = {};
          ctx.state.files[relativePath] = {
            lastAppliedHash: '',
            lastAppliedFrameworkVersion: ctx.frameworkVersion,
            lastAppliedFrameworkCommit: ctx.frameworkCommit,
            lastAppliedSourcePath: entry.path,
            customisedLocally: true,
          };
        }
      }
      process.stderr.write(
        `MANUAL MERGE: ${relativePath} — exists locally but not in state. ` +
        `Review ${relativePath}.framework-new.\n`
      );
      const extra = { reason: 'untracked-pre-existing', ...(flags.dryRun ? { dry_run: 'true' } : {}) };
      logFileOp(relativePath, 'customised', extra);
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: isFrameworkOwnedCommand
// ---------------------------------------------------------------------------

/**
 * Returns true if the command references a .claude/hooks/ script.
 * Checks the first token directly, or if the first token is an interpreter
 * (node, sh, bash), checks the second token (the script path).
 * @param {string} command
 * @returns {boolean}
 */
function isFrameworkOwnedCommand(command) {
  return frameworkHookIdentity(command) !== null;
}

// ---------------------------------------------------------------------------
// Helper: mergeSettingsHooksBlock
// ---------------------------------------------------------------------------

/**
 * Extract the identity token for a framework-owned command: the .claude/hooks/<name> path token.
 * Returns null if the command is not framework-owned, OR if the hook entry has no `command` string
 * (e.g. agent-type hooks with `prompt` instead of `command` — those are NEVER framework-owned).
 * Mirrors the same two-position check as isFrameworkOwnedCommand.
 * @param {string|undefined|null} command
 * @returns {string|null}
 */
function frameworkHookIdentity(command) {
  if (typeof command !== 'string' || command.trim() === '') return null;
  const tokens = command.trim().split(/\s+/);
  const interpreters = new Set(['node', 'sh', 'bash']);
  let tok = tokens[0];
  if (interpreters.has(tokens[0])) {
    if (tokens.length < 2) return null;
    tok = tokens[1];
  }
  // Accept every spelling of the project-dir prefix — ${CLAUDE_PROJECT_DIR},
  // $CLAUDE_PROJECT_DIR, "$CLAUDE_PROJECT_DIR", "${CLAUDE_PROJECT_DIR}", a
  // fully-quoted token, or a bare relative path — and normalise the identity
  // to the `.claude/hooks/<file>` suffix so different spellings of the same
  // hook dedupe against each other. (The pre-2.28.2 exact-spelling identity
  // caused every consuming repo's hooks to duplicate when 2.28.0 changed the
  // canonical quoting style.)
  const m = /^(?:"?\$\{?CLAUDE_PROJECT_DIR\}?"?\/)?(\.claude\/hooks\/[^\s"']+)"?$/.exec(tok);
  return m ? m[1] : null;
}

/**
 * Dedupe a merged hook list: one entry per framework hook identity (first
 * occurrence wins), and exact-duplicate project-owned entries collapse.
 * Keeps merge output stable when a consumer's settings.json accumulated
 * multiple spellings of the same framework hook.
 * @param {any[]} hooks
 * @returns {any[]}
 */
function dedupeHookList(hooks) {
  const seen = new Set();
  const out = [];
  for (const h of hooks) {
    const key = frameworkHookIdentity(h && h.command) || JSON.stringify(h);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/**
 * Merges framework and project hooks blocks.
 * Rules:
 *   1. Framework owns entries whose command contains a .claude/hooks/ path token.
 *   2. Replace-in-place by hook identity (the .claude/hooks/ path token); framework entry kept once.
 *   3. Project hooks coexist.
 *   4. Collision rule: project wins (framework drop).
 *   5. Stable ordering: framework entries first (in framework-declared order), then project entries.
 *   6. Non-removing: orphaned framework hook entries (in project but not in new framework) stay as project-owned.
 * @param {Record<string, any[]>} frameworkHooks
 * @param {Record<string, any[]>} projectHooks
 * @returns {Record<string, any[]>}
 */
function mergeSettingsHooksBlock(frameworkHooks, projectHooks) {
  /** @type {Record<string, any[]>} */
  const result = {};
  const allEvents = new Set([...Object.keys(frameworkHooks), ...Object.keys(projectHooks)]);

  for (const event of Array.from(allEvents)) {
    const fwGroups = frameworkHooks[event] || [];
    const projGroups = projectHooks[event] || [];

    // Build set of framework hook identities already declared in project groups (for collision: project wins)
    // Identity = the .claude/hooks/<name> path token within the command string
    const projFwIdentitySet = new Set();
    for (const group of projGroups) {
      for (const hook of (group.hooks || [])) {
        const identity = frameworkHookIdentity(hook.command);
        if (identity !== null) {
          projFwIdentitySet.add(identity);
        }
      }
    }

    const mergedGroups = [];

    // Process framework groups first (stable framework-declared order)
    for (const fwGroup of fwGroups) {
      const matcher = fwGroup.matcher;
      // Filter framework hook entries: drop those whose identity collides with project-declared slot
      const mergedHooks = [];
      for (const hook of (fwGroup.hooks || [])) {
        const identity = frameworkHookIdentity(hook.command);
        // Rule 4: project wins — skip framework entry if project already declares this hook identity
        if (identity !== null && projFwIdentitySet.has(identity)) continue;
        mergedHooks.push(hook);
      }
      if (mergedHooks.length === 0 && (fwGroup.hooks || []).length > 0) {
        // All hooks in this framework group were collisions; still need to emit the project entries
        // Find matching project group and include project-owned hooks only
        const projGroup = projGroups.find(g => g.matcher === matcher);
        const projOwnedHooks = projGroup
          ? (projGroup.hooks || []).filter(h => frameworkHookIdentity(h.command) === null)
          : [];
        // Include the project's framework-owned hooks (they win the collision)
        const projFwHooks = projGroup
          ? (projGroup.hooks || []).filter(h => frameworkHookIdentity(h.command) !== null)
          : [];
        const finalHooks = dedupeHookList([...projFwHooks, ...projOwnedHooks]);
        if (finalHooks.length > 0) {
          /** @type {Record<string, any>} */
          const group = { hooks: finalHooks };
          if (matcher !== undefined) group.matcher = matcher;
          mergedGroups.push(group);
        }
        continue;
      }
      // Find matching project group (same matcher) and append project-owned hooks
      const projGroup = projGroups.find(g => g.matcher === matcher);
      // Rule 4 (collision, project wins) in mixed groups: project-declared framework-owned hooks
      // must survive the merge — they were already filtered out of mergedHooks via projFwIdentitySet,
      // so include them explicitly. Without this, project's customised version of a framework hook
      // is silently dropped when at least one sibling framework hook in the same group survives.
      const projFwHooks = projGroup
        ? (projGroup.hooks || []).filter(h => {
            const id = frameworkHookIdentity(h.command);
            return id !== null && projFwIdentitySet.has(id);
          })
        : [];
      const projOwnedHooks = projGroup
        ? (projGroup.hooks || []).filter(h => frameworkHookIdentity(h.command) === null)
        : [];

      // Rule 5: framework entries first, then project entries (project-declared framework-owned + project-owned)
      const finalHooks = dedupeHookList([...mergedHooks, ...projFwHooks, ...projOwnedHooks]);
      if (finalHooks.length > 0) {
        /** @type {Record<string, any>} */
        const group = { hooks: finalHooks };
        if (matcher !== undefined) group.matcher = matcher;
        mergedGroups.push(group);
      }
    }

    // Append project groups that have no corresponding framework group
    for (const projGroup of projGroups) {
      const matcher = projGroup.matcher;
      const hasFwGroup = fwGroups.some(g => g.matcher === matcher);
      if (!hasFwGroup) {
        mergedGroups.push(projGroup);
      }
    }

    // Rule 6 (non-removing): warn about orphaned framework-owned hooks in project that are gone from framework
    for (const projGroup of projGroups) {
      for (const hook of (projGroup.hooks || [])) {
        const identity = frameworkHookIdentity(hook.command);
        if (identity !== null) {
          const stillInFramework = fwGroups.some(g =>
            (g.hooks || []).some(h => frameworkHookIdentity(h.command) === identity)
          );
          if (!stillInFramework) {
            process.stderr.write(
              `WARN: hook entry ${hook.command} at ${event} is no longer declared by framework — ` +
              `remains in your settings.json as project-owned. Remove manually if no longer needed.\n`
            );
          }
        }
      }
    }

    if (mergedGroups.length > 0) {
      result[event] = mergedGroups;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// mergeSettings
// ---------------------------------------------------------------------------

/** @param {SyncContext} ctx @param {ManifestEntry} entry @param {string} relativePath @returns {Promise<void>} */
async function mergeSettings(ctx, entry, relativePath) {
  const { frameworkRoot, targetRoot, flags } = ctx;
  if (refuseIfDoNotTouch(ctx, relativePath)) return;
  assertWithinRoot(frameworkRoot, relativePath);
  assertWithinRoot(targetRoot, relativePath);
  const targetSettingsPath = path.join(targetRoot, relativePath);

  // Read framework's settings.json
  const fwSettingsPath = path.join(frameworkRoot, relativePath);
  let frameworkSettings;
  try {
    const fwContent = await fs.readFile(fwSettingsPath, 'utf8');
    frameworkSettings = JSON.parse(fwContent);
  } catch (err) {
    process.stderr.write(`ERROR: framework settings.json missing or unreadable at ${fwSettingsPath}: ${/** @type {Error} */(err).message}\n`);
    logFileOp(relativePath, 'skipped', { error: 'missing_framework_source' });
    return;
  }

  // Read project's existing settings.json (if any)
  let projectSettings = { hooks: {} };
  try {
    const projContent = await fs.readFile(targetSettingsPath, 'utf8');
    projectSettings = JSON.parse(projContent);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */(err).code !== 'ENOENT') {
      // Malformed JSON or other read error: ABORT. Merging against an unparseable
      // consumer settings.json would silently overwrite the operator's (broken but
      // recoverable) customisations with framework defaults. Refuse to write and
      // make the whole sync run fail so the operator fixes the file first.
      process.stderr.write(
        `ERROR: target settings.json at ${targetSettingsPath} is not valid JSON ` +
        `(${/** @type {Error} */(err).message}). Refusing to merge — fix or remove the file, then re-run sync. No write performed.\n`
      );
      const fatal = new Error(`malformed consumer settings.json: ${relativePath}`);
      /** @type {any} */ (fatal).fatal = true;
      throw fatal;
    }
    // ENOENT: no existing file, that's fine — projectSettings stays as default
  }

  // Merge hooks block
  const mergedHooks = mergeSettingsHooksBlock(
    frameworkSettings.hooks || {},
    projectSettings.hooks || {}
  );

  // Build merged settings: framework supplies safe defaults for non-hooks top-level keys
  // (e.g. a future permissions.deny block); project still wins on collision; hooks merged separately.
  const { hooks: _fwHooks, ...frameworkNonHooks } = frameworkSettings || {};
  const mergedSettings = { ...frameworkNonHooks, ...projectSettings, hooks: mergedHooks };

  const mergedContent = JSON.stringify(mergedSettings, null, 2) + '\n';
  const normalisedContent = normaliseContent(mergedContent);
  const newHash = hashContent(normalisedContent);

  if (!flags.dryRun) {
    await fs.mkdir(path.dirname(targetSettingsPath), { recursive: true });
    await fs.writeFile(targetSettingsPath, normalisedContent, 'utf8');
    if (ctx.state) {
      ctx.state.files[relativePath] = {
        ...ctx.state.files[relativePath],
        lastAppliedHash: newHash,
        lastAppliedFrameworkVersion: ctx.frameworkVersion,
        lastAppliedFrameworkCommit: ctx.frameworkCommit,
        lastAppliedSourcePath: entry.path,
        customisedLocally: false,
      };
    }
  }

  const extra = flags.dryRun ? { dry_run: 'true' } : {};
  logFileOp(relativePath, 'updated', extra);
}

// ---------------------------------------------------------------------------
// classifyForAdopt
// ---------------------------------------------------------------------------

/**
 * Classification for --adopt mode. For first-run (state === null), everything becomes new-file-no-state.
 * For rebaseline (state exists), reclassify clean files as needing update, leave customised as customised.
 * @param {SyncContext} ctx
 * @param {ManifestEntry} entry
 * @param {string} relativePath
 */
function classifyForAdopt(ctx, entry, relativePath) {
  if (entry.mode === 'settings-merge') return { kind: 'settings-merge' };
  // syncIgnore check: honour the same skip-list the regular sync path honours.
  // Without this, --adopt re-adds files the operator has explicitly pruned (e.g. FULL-only
  // agents removed during a STANDARD profile prune).
  if (ctx.state && ctx.state.syncIgnore && ctx.state.syncIgnore.includes(relativePath)) {
    return { kind: 'skipped', reason: 'syncIgnore' };
  }
  if (!ctx.state) {
    // First-run: treat every file as new-file-no-state
    const targetPath = path.join(ctx.targetRoot, relativePath);
    const targetExists = require('fs').existsSync(targetPath);
    return { kind: 'new-file-no-state', targetExists };
  }
  // Rebaseline: force clean files to re-substitute
  const stateEntry = ctx.state.files ? ctx.state.files[relativePath] : null;
  if (!stateEntry) {
    const targetPath = path.join(ctx.targetRoot, relativePath);
    const targetExists = require('fs').existsSync(targetPath);
    return { kind: 'new-file-no-state', targetExists };
  }
  const targetPath = path.join(ctx.targetRoot, relativePath);
  let targetContent;
  try { targetContent = require('fs').readFileSync(targetPath, 'utf8'); } catch { return { kind: 'customised' }; }
  const targetHash = hashContent(normaliseContent(targetContent));
  if (targetHash === stateEntry.lastAppliedHash) {
    return entry.mode === 'adopt-only'
      ? { kind: 'skipped', reason: 'adopt-only' } // already catalogued, skip rewrite
      : { kind: 'clean', needsUpdate: true }; // force update for rebaseline
  }
  return { kind: 'customised' };
}

// ---------------------------------------------------------------------------
// classifyForMaintenance
// ---------------------------------------------------------------------------

/**
 * Classification for same-version maintenance runs (state.frameworkVersion ===
 * FRAMEWORK_VERSION). No version bump is happening, so nothing is "updated" in
 * the upgrade sense; the pass exists to close out the merge lifecycle:
 *
 *   - a file that was flagged customised (`customisedLocally: true`) and whose
 *     `.framework-new` sibling is gone has been resolved by the operator →
 *     `rebaseline`: record the on-disk content hash as the new baseline
 *     (SYNC.md Phase 5 step 6, --doctor case(b)).
 *   - a file that still has a `.framework-new` sibling is an unresolved merge →
 *     `still-customised` (the startup blocker normally exits 1 before the walk;
 *     this is reached only under --force).
 *   - a file that diverges from baseline without any merge in flight is
 *     operator-edited → `still-customised`: surfaced, never silently absorbed.
 *
 * Delegates the clean/override-block cases to classifyFile so LOCAL-OVERRIDE
 * edits still flow through writeUpdated (which re-injects and refreshes hashes).
 *
 * @param {SyncContext} ctx
 * @param {ManifestEntry} entry
 * @param {string} relativePath
 * @returns {ReturnType<typeof classifyFile> | { kind: 'rebaseline' } | { kind: 'still-customised', reason: string }}
 */
function classifyForMaintenance(ctx, entry, relativePath) {
  // settings-merge: skip on maintenance runs. Re-merging without a version change
  // is churn (it would report "updated" on every no-op run); the merge re-runs on
  // the next version bump or --adopt.
  if (entry.mode === 'settings-merge') {
    return { kind: 'skipped', reason: 'maintenance-no-version-change' };
  }

  const base = classifyFile(ctx, entry, relativePath);
  if (base.kind !== 'customised') return base;

  const targetPath = path.join(ctx.targetRoot, relativePath);
  if (fsSync.existsSync(`${targetPath}.framework-new`)) {
    return { kind: 'still-customised', reason: 'unresolved-framework-new' };
  }
  if (!fsSync.existsSync(targetPath)) {
    return { kind: 'still-customised', reason: 'target-missing' };
  }
  const stateEntry = ctx.state && ctx.state.files ? ctx.state.files[relativePath] : null;
  if (stateEntry && stateEntry.customisedLocally) {
    // Merge was in flight (.framework-new was written) and the sibling is gone:
    // the operator resolved it. Accept the on-disk merge as the new baseline.
    return { kind: 'rebaseline' };
  }
  return { kind: 'still-customised', reason: 'locally-edited' };
}

/**
 * Apply a maintenance rebaseline: record the on-disk content hash as the new
 * baseline for a resolved `.framework-new` merge. Touches state only — the
 * target file itself is never modified.
 *
 * @param {SyncContext} ctx @param {ManifestEntry} entry @param {string} relativePath
 * @returns {Promise<void>}
 */
async function applyRebaseline(ctx, entry, relativePath) {
  const { targetRoot, flags } = ctx;
  assertWithinRoot(targetRoot, relativePath);
  const targetPath = path.join(targetRoot, relativePath);
  const content = await fs.readFile(targetPath, 'utf8');
  const newHash = hashContent(normaliseContent(content));

  if (!flags.dryRun && ctx.state) {
    ctx.state.files[relativePath] = {
      ...ctx.state.files[relativePath],
      lastAppliedHash: newHash,
      lastAppliedFrameworkVersion: ctx.frameworkVersion,
      lastAppliedFrameworkCommit: ctx.frameworkCommit,
      lastAppliedSourcePath: entry.path,
      customisedLocally: false,
    };
  }

  /** @type {Record<string, string>} */
  const extra = { reason: 'resolved-framework-new' };
  if (flags.dryRun) extra.dry_run = 'true';
  logFileOp(relativePath, 'rebaselined', extra);
}

// ---------------------------------------------------------------------------
// extractChangelogExcerpt
// ---------------------------------------------------------------------------

/**
 * Extracts CHANGELOG entries between oldVersion (exclusive) and newVersion (inclusive).
 * Lines between ## oldVersion and ## newVersion are included.
 * @param {string} content
 * @param {string} oldVersion
 * @param {string} newVersion
 * @returns {string[]}
 */
function extractChangelogExcerpt(content, oldVersion, newVersion) {
  const lines = content.split('\n');
  const result = [];
  let inRange = false;
  for (const line of lines) {
    const versionMatch = line.match(/^## (\d+\.\d+\.\d+)/);
    if (versionMatch) {
      const v = versionMatch[1];
      if (v === newVersion) { inRange = true; continue; }
      if (v === oldVersion) { inRange = false; break; }
    }
    if (inRange) result.push(line);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main (steps 0-6 — file walk added in Chunk 4)
// ---------------------------------------------------------------------------

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const frameworkRoot = path.resolve(__dirname);
  const targetRoot = process.cwd();

  // Step 6: Check submodule clean (skip in --adopt, --check, --strict, --doctor modes)
  if (!flags.adopt && !flags.check && !flags.strict && !flags.doctor) {
    const sc = checkSubmoduleClean(frameworkRoot);
    if (!sc.clean) {
      process.stderr.write(`ERROR: .claude-framework/ submodule has uncommitted changes. Stash or revert before syncing.\n`);
      process.exit(1);
    }
  }

  // Step 1: Read state
  const state = readState(targetRoot);
  if (!state && !flags.adopt && !flags.check && !flags.strict && !flags.doctor) {
    process.stderr.write(`ERROR: .framework-state.json not found or corrupted. Run sync.js --adopt to re-initialise, or --doctor to inspect. All files treated as customised until state is restored.\n`);
    process.exit(1);
  }

  // Steps 2-3: Load manifest
  const manifest = loadManifest(frameworkRoot);

  // Step 4: Read new framework version
  const frameworkVersion = readFrameworkVersion(frameworkRoot);

  // Step 5: Already on latest? Same-version runs no longer early-exit — they run
  // the file walk in maintenance mode: rebaseline resolved .framework-new merges
  // (SYNC.md Phase 5 step 6, --doctor case(b)), surface files still customised,
  // and block on unresolved .framework-new files. No version bump, no changelog
  // excerpt. (lastSubstitutionHash forward-migration happens at the Step 10 state
  // write, same as an upgrade run.)
  const maintenance = Boolean(
    state && state.frameworkVersion === frameworkVersion &&
    !flags.adopt && !flags.check && !flags.strict && !flags.doctor
  );
  if (maintenance) {
    process.stdout.write(`already on latest (v${frameworkVersion}) — running maintenance pass\n`);
  }

  // Step 0: Scan for unresolved merges (after --force check)
  if (!flags.force && !flags.adopt && !flags.check && !flags.strict && !flags.doctor) {
    const unresolved = scanForUnresolvedMerges(targetRoot, manifest);
    if (unresolved.length > 0) {
      const showing = unresolved.slice(0, 10);
      process.stderr.write(`ERROR: ${unresolved.length} unresolved .framework-new file(s) found. Resolve or delete before syncing (or pass --force to override).\n`);
      for (const p of showing) process.stderr.write(`  - ${p}.framework-new\n`);
      if (unresolved.length > 10) process.stderr.write(`  - ... (showing first 10; ${unresolved.length - 10} more)\n`);
      process.exit(1);
    }
  }

  const frameworkCommit = getSubmoduleCommit(frameworkRoot);

  /** @type {SyncContext} */
  const ctx = {
    targetRoot,
    frameworkRoot,
    manifest,
    state,
    frameworkVersion,
    frameworkCommit,
    flags,
    maintenance,
  };

  // Step 7: File walk
  const startTime = performance.now();
  let updatedCount = 0, newCount = 0, customisedCount = 0, removalWarnCount = 0, orphanStateCount = 0, rebaselinedCount = 0;
  const perFileErrors = [];

  const managedFiles = expandManagedFiles(manifest, frameworkRoot);

  // --check / --strict: just classify, don't write
  if (flags.check || flags.strict) {
    // S4: give a clear message for unadopted repos
    if (!state) {
      process.stderr.write(`CHECK: framework not adopted (no .framework-state.json). Run: node sync.js --adopt\n`);
      process.exit(1);
    }

    let updatesAvailable = false;
    let hasCustomised = false;

    // Check substitution drift
    if (state) {
      const drift = checkSubstitutionDrift(state, flags);
      if (drift.drift) {
        process.stderr.write(`ERROR: ${drift.reason}\n`);
        process.exit(1);
      }
    }

    for (const { entry, relativePath } of managedFiles) {
      const classification = classifyFile(ctx, entry, relativePath);
      if (classification.kind === 'clean' && classification.needsUpdate) updatesAvailable = true;
      if (classification.kind === 'customised') hasCustomised = true;
      // Pending ownership transfer counts as an update — operator should review the mode change.
      if (classification.kind === 'ownership-transferred') updatesAvailable = true;
    }
    if (!state || (state && state.frameworkVersion !== frameworkVersion)) updatesAvailable = true;

    if (flags.strict && hasCustomised) {
      process.stderr.write(`CHECK: framework has updates or customisations requiring attention.\n`);
      process.exit(1);
    }
    if (updatesAvailable) {
      process.stderr.write(`CHECK: framework updates available (v${state ? state.frameworkVersion : '?'} → v${frameworkVersion}).\n`);
      process.exit(1);
    }
    process.stdout.write(`CHECK: framework is up to date (v${frameworkVersion}).\n`);
    process.exit(0);
  }

  // --doctor: diagnose state.json health, no writes
  if (flags.doctor) {
    if (!state) {
      process.stderr.write(`ERROR: .framework-state.json missing — cannot run doctor.\n`);
      process.exit(1);
    }
    let anyAnomaly = false;
    // Case: substitution drift
    const drift = checkSubstitutionDrift(state, flags);
    if (drift.drift) {
      process.stderr.write(`DOCTOR: substitution drift detected — ${drift.reason}\n`);
      anyAnomaly = true;
    }
    // Per-file checks
    for (const { entry, relativePath } of managedFiles) {
      const stateEntry = state.files[relativePath];
      if (!stateEntry) continue;
      const targetPath = path.join(targetRoot, relativePath);
      let targetContent;
      try { targetContent = await fsp.readFile(targetPath, 'utf8'); } catch { targetContent = null; }
      if (targetContent === null) {
        process.stderr.write(`DOCTOR: missing target file: ${relativePath}\n`);
        anyAnomaly = true;
        continue;
      }
      const targetHash = hashContent(normaliseContent(targetContent));
      if (targetHash !== stateEntry.lastAppliedHash) {
        const fwNewExists = await fsp.stat(`${targetPath}.framework-new`).then(() => true).catch(() => false);
        if (fwNewExists) {
          process.stderr.write(`DOCTOR: case(a) — merge in flight: ${relativePath} (customised + .framework-new exists)\n`);
        } else {
          process.stderr.write(`DOCTOR: case(b) — merged-without-resync: ${relativePath} (customised + no .framework-new; re-run sync to update hash)\n`);
        }
        anyAnomaly = true;
      }
    }
    // Orphaned state entries
    const expandedPaths = new Set(managedFiles.map(f => f.relativePath));
    for (const p of Object.keys(state.files)) {
      if (!expandedPaths.has(p)) {
        process.stderr.write(`DOCTOR: orphaned state entry: ${p} (not in any manifest glob)\n`);
        anyAnomaly = true;
      }
    }
    // Orphaned framework hooks in settings.json (delegate to mergeSettingsHooksBlock side effects)
    process.stdout.write(`DOCTOR: diagnosis complete.\n`);
    process.exit(anyAnomaly ? 1 : 0);
  }

  // Full sync (or --adopt)
  if (state) {
    // Validate substitutions
    validateSubstitutions(state.substitutions);
    // Check substitution drift (adopt rebaseline mode skips the drift check)
    if (!flags.adopt) {
      const drift = checkSubstitutionDrift(state, flags);
      if (drift.drift) {
        process.stderr.write(`ERROR: ${drift.reason}\n`);
        process.exit(1);
      }
    }
  }

  // --adopt mode header + first-run state initialisation
  if (flags.adopt) {
    if (!state) {
      process.stdout.write(`INFO: --adopt first-run mode (no state.json detected; cataloguing files)\n`);
      // Initialise a blank state so writeNewFile/mergeSettings can populate ctx.state.files
      ctx.state = {
        frameworkVersion,
        adoptedAt: new Date().toISOString(),
        adoptedFromCommit: frameworkCommit,
        profile: 'STANDARD',
        substitutions: {},
        files: {},
        syncIgnore: [],
        appliedMigrations: [],
      };
    } else {
      process.stdout.write(`INFO: --adopt rebaseline mode (substitution map changed; clean files will be rewritten, customised files get .framework-new)\n`);
    }
  }

  for (const { entry, relativePath } of managedFiles) {
    try {
      // doNotTouch write-refusal: a path that is both managed and doNotTouch is a
      // manifest contradiction — refuse before dispatching any writer so it is
      // never written and never counted as updated/new/customised.
      if (refuseIfDoNotTouch(ctx, relativePath)) continue;

      const classification = flags.adopt
        ? classifyForAdopt(ctx, entry, relativePath)
        : maintenance
          ? classifyForMaintenance(ctx, entry, relativePath)
          : classifyFile(ctx, entry, relativePath);

      switch (classification.kind) {
        case 'skipped':
          logFileOp(relativePath, 'skipped');
          break;
        case 'ownership-transferred':
          if (ctx.state && ctx.state.files) {
            ctx.state.files[relativePath] = { ...ctx.state.files[relativePath], adoptedOwnership: true };
          }
          logFileOp(relativePath, 'ownership-transferred');
          break;
        case 'settings-merge':
          await mergeSettings(ctx, entry, relativePath);
          updatedCount++;
          break;
        case 'new-file-no-state':
          await writeNewFile(ctx, entry, relativePath);
          if (!classification.targetExists) newCount++; else customisedCount++;
          break;
        case 'clean':
          if (classification.needsUpdate) {
            await writeUpdated(ctx, entry, relativePath);
            updatedCount++;
          } else {
            logFileOp(relativePath, 'skipped');
          }
          break;
        case 'customised':
          await writeFrameworkNew(ctx, entry, relativePath);
          customisedCount++;
          break;
        case 'rebaseline':
          await applyRebaseline(ctx, entry, relativePath);
          rebaselinedCount++;
          break;
        case 'still-customised':
          // Maintenance pass: surface, never absorb. No .framework-new is written
          // (there is no new framework content to merge at the same version).
          process.stderr.write(
            `NOTE: ${relativePath} diverges from its last-applied baseline (${classification.reason}). ` +
            `Left untouched — it will be treated as customised on the next version sync.\n`
          );
          logFileOp(relativePath, 'customised', { reason: classification.reason, write: 'none' });
          customisedCount++;
          break;
      }
    } catch (err) {
      const msg = String(err && /** @type {any} */(err).message ? /** @type {any} */(err).message : err);
      if (err && /** @type {any} */(err).fatal) {
        // Fatal per-file error (e.g. malformed consumer settings.json): abort the
        // whole run with exit 1 — no state write, no further file operations.
        process.stderr.write(`ERROR: aborting sync — ${msg}\n`);
        process.exit(1);
      }
      logFileOp(relativePath, 'skipped', { error: msg.slice(0, 80) });
      perFileErrors.push({ path: relativePath, error: msg });
    }
  }

  // Step 8: Removed-files reporting
  for (const removed of manifest.removedFiles) {
    const stateEntry = state && state.files ? state.files[removed.path] : null;
    if (stateEntry) {
      const targetPath = path.join(targetRoot, removed.path);
      const stillExists = await fsp.stat(targetPath).then(() => true).catch(() => false);
      if (stillExists) {
        process.stderr.write(`WARN: ${removed.path} removed from framework in v${removed.removedIn}. Remove manually.\n`);
        logFileOp(removed.path, 'removed-warn');
        removalWarnCount++;
      }
    }
  }

  // Orphan state entries count (for end-of-run INFO)
  if (state) {
    const expandedPaths = new Set(managedFiles.map(f => f.relativePath));
    for (const p of Object.keys(state.files)) {
      if (!expandedPaths.has(p)) orphanStateCount++;
    }
  }

  // Step 9: CHANGELOG excerpt (skipped on maintenance runs — no version change,
  // so there is no "what's new" range to show)
  if (!maintenance) {
    try {
      const changelogPath = path.join(frameworkRoot, '.claude', 'CHANGELOG.md');
      const changelogContent = await fsp.readFile(changelogPath, 'utf8');
      const oldVersion = state ? state.frameworkVersion : '?';
      const excerptLines = extractChangelogExcerpt(changelogContent, oldVersion, frameworkVersion);
      if (excerptLines.length > 0) {
        process.stdout.write(`\n--- Changelog v${oldVersion} → v${frameworkVersion} ---\n`);
        process.stdout.write(excerptLines.join('\n') + '\n');
        process.stdout.write(`---\n\n`);
      }
    } catch {
      process.stderr.write(`WARN: Could not read CHANGELOG for v${state ? state.frameworkVersion : '?'}→v${frameworkVersion}. Consult .claude-framework/CHANGELOG.md manually.\n`);
    }
  }

  // Step 10: Atomic state write
  if (!flags.dryRun && ctx.state) {
    const newState = {
      ...ctx.state,
      frameworkVersion,
      lastSubstitutionHash: ctx.state.substitutions ? hashSubstitutions(ctx.state.substitutions) : undefined,
    };
    await writeStateAtomic(targetRoot, newState);
  }

  // Step 11: End-of-run report
  const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(1);
  if (orphanStateCount > 0) {
    process.stdout.write(`INFO: ${orphanStateCount} state entries reference paths no longer in any manifest glob (run --doctor for details).\n`);
  }
  const rebaselinedSegment = maintenance ? `${rebaselinedCount} rebaselined, ` : '';
  process.stdout.write(
    `${updatedCount} updated, ${newCount} new, ${customisedCount} customised, ${rebaselinedSegment}${removalWarnCount} removal warnings, time=${elapsedSec}s\n`
  );
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`ERROR: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}

// Exports for tests
module.exports = {
  normaliseContent,
  hashContent,
  assertWithinRoot,
  expandGlob,
  hashSubstitutions,
  loadManifest,
  readState,
  writeStateAtomic,
  readFrameworkVersion,
  getSubmoduleCommit,
  checkSubmoduleClean,
  scanForUnresolvedMerges,
  logFileOp,
  expandManagedFiles,
  classifyFile,
  classifyForAdopt,
  classifyForMaintenance,
  applyRebaseline,
  isDoNotTouch,
  validateSubstitutions,
  checkSubstitutionDrift,
  applySubstitutions,
  writeUpdated,
  writeFrameworkNew,
  writeNewFile,
  isFrameworkOwnedCommand,
  mergeSettingsHooksBlock,
  mergeSettings,
  extractChangelogExcerpt,
  parseOverrideBlocks,
  extractOverrideContents,
  injectOverrides,
  injectConsumerOverrides,
};
