#!/usr/bin/env node
'use strict';

/**
 * audit-consumer-state.js — deterministic consumer-drift audit.
 *
 * Runs READ-ONLY against a CONSUMING repo (the repo that mounts this framework
 * at <consumer>/.claude-framework) and detects the silent-failure modes that
 * neither sync.js nor validate-framework.js currently reports:
 *
 *   (a) .claude/.framework-state.json structural corruption — field-level ajv
 *       diagnosis against schemas/framework-state.schema.json (sync.js merely
 *       degrades to "all files treated as customised", sync.js:1701);
 *   (b) unsubstituted {{PLACEHOLDER}} tokens left in state-tracked files whose
 *       manifest entry declares substituteAt: "adoption" (validate-framework.js
 *       skips {} link targets and never scans body text);
 *   (c) state.files vs disk reconciliation, both directions, using the mounted
 *       framework's manifest globs (classifyFile only sees this during a sync);
 *   (d) syncIgnore rot — entries matching no managed path (classifyFile matches
 *       syncIgnore by exact string equality, so dead entries are pure noise);
 *   (e) appliedMigrations vs migrations/ dir, both directions, including
 *       pending unapplied migrations in (adoptionVersion, stateVersion];
 *   (f) orphaned *.framework-new files (scanForUnresolvedMerges only fires
 *       during a sync, and misses bases dropped from BOTH manifest and state);
 *   (g) settings.json hook registrations whose command path does not exist
 *       (a missing hook file fails silently at session runtime).
 *
 * Usage:
 *   node scripts/audit-consumer-state.js [--repo <path>] [--framework <path>] [--json]
 *
 *   --repo       Consumer repo root. Default: when this script lives inside a
 *                directory named `.claude-framework`, its parent; else cwd.
 *   --framework  Framework mount to audit against. Default: <repo>/.claude-framework.
 *   --json       Machine-readable output.
 *
 * Severity model:
 *   blocker — the audit could not verify (unreadable/missing/invalid state or
 *             manifest: FAIL CLOSED) or the state file is schema-invalid.
 *   warn    — real drift an operator should fix (placeholders, stale
 *             substitution hash, tracked-vs-disk mismatch, syncIgnore rot,
 *             migration drift, .framework-new residue, dead hook paths).
 *   info    — benign or expected-between-syncs conditions.
 *
 * Exit code: 1 when any blocker finding exists, 2 on usage error, else 0.
 * Zero writes, ever.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// sync.js is require-safe (main() is guarded behind require.main === module).
// Reusing its hardened helpers keeps glob and hash semantics identical to the
// engine whose state we are auditing.
const { expandGlob, hashSubstitutions, compareSemver } = require(path.join(__dirname, '..', 'sync.js'));

const SCHEMA_PATH = path.join(__dirname, '..', 'schemas', 'framework-state.schema.json');

const KNOWN_STATE_KEYS = new Set([
  'frameworkVersion', 'adoptedAt', 'adoptedFromCommit', 'profile',
  'substitutions', 'lastSubstitutionHash', 'files', 'syncIgnore', 'appliedMigrations',
]);

// Substitution placeholders are uppercase-led ({{PROJECT_NAME}},
// {{ARCHITECTURE_ANCHOR:route-conventions}}). Lowercase forms like {{var}} or
// {slug} are documentation/template placeholders, never substitution targets
// (applySubstitutions only replaces keys present in the map, and every shipped
// key is uppercase-led) — so they are deliberately NOT matched.
const PLACEHOLDER_RE = /\{\{([A-Z][A-Z0-9_]*(?::[A-Za-z0-9._-]+)?)\}\}/g;

const HOOK_FILE_EXT_RE = /\.(js|cjs|mjs|ts|tsx|sh|py)$/;

const SKIP_WALK_DIRS = new Set(['node_modules', '.git', '.claude-framework']);

const MAX_SCHEMA_FINDINGS = 50;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function makeFinding(severity, check, message, file) {
  const f = { severity, check, message };
  if (file) f.path = file;
  return f;
}

function readJson(filePath) {
  // Returns { ok: true, value } | { ok: false, error, missing }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, missing: err && err.code === 'ENOENT', error: err.message };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, missing: false, error: `invalid JSON: ${err.message}` };
  }
}

function isSafeRelPath(rel) {
  return typeof rel === 'string' && rel.length > 0 &&
    !path.isAbsolute(rel) && !/^[A-Za-z]:/.test(rel) &&
    !rel.split(/[/\\]/).includes('..');
}

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

function resolveRoots(args, ownRoot, cwd) {
  let repoRoot;
  if (args.repo) {
    repoRoot = path.resolve(cwd, args.repo);
  } else if (path.basename(ownRoot) === '.claude-framework') {
    repoRoot = path.dirname(ownRoot);
  } else {
    repoRoot = cwd;
  }
  const frameworkRoot = args.framework
    ? path.resolve(cwd, args.framework)
    : path.join(repoRoot, '.claude-framework');
  return { repoRoot, frameworkRoot };
}

function parseArgs(argv) {
  const args = { repo: null, framework: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--framework') args.framework = argv[++i];
    else return { error: `Unknown argument "${a}". Supported: --repo <path>, --framework <path>, --json, --help` };
  }
  if ((args.repo === undefined) || (args.framework === undefined)) {
    return { error: '--repo and --framework require a value' };
  }
  return args;
}

// ---------------------------------------------------------------------------
// Check (a): schema validation
// ---------------------------------------------------------------------------

function validateStateSchema(state, findings) {
  let Ajv, addFormats;
  try {
    Ajv = require('ajv');
    addFormats = require('ajv-formats');
  } catch (err) {
    findings.push(makeFinding('blocker', 'state-schema',
      `cannot load ajv/ajv-formats (${err.message}) — schema validation is unavailable; run npm install in the framework checkout. Failing closed.`));
    return;
  }
  const schemaRead = readJson(SCHEMA_PATH);
  if (!schemaRead.ok) {
    findings.push(makeFinding('blocker', 'state-schema',
      `cannot read ${SCHEMA_PATH}: ${schemaRead.error}. Failing closed.`));
    return;
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  let validate;
  try {
    validate = ajv.compile(schemaRead.value);
  } catch (err) {
    findings.push(makeFinding('blocker', 'state-schema', `schema does not compile: ${err.message}`));
    return;
  }
  if (validate(state)) return;

  const seen = new Set();
  let emitted = 0;
  for (const e of validate.errors || []) {
    let where = e.instancePath || '(root)';
    if (e.keyword === 'propertyNames' && e.params && e.params.propertyName !== undefined) {
      where += ` key "${e.params.propertyName}"`;
    }
    let detail = e.message || 'invalid';
    if (e.params && e.params.additionalProperty) detail += ` ("${e.params.additionalProperty}")`;
    if (e.params && e.params.allowedValues) detail += ` (${JSON.stringify(e.params.allowedValues)})`;
    const key = `${where}|${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (emitted >= MAX_SCHEMA_FINDINGS) {
      findings.push(makeFinding('blocker', 'state-schema',
        `... ${validate.errors.length - emitted} further schema error(s) suppressed`));
      break;
    }
    emitted++;
    findings.push(makeFinding('blocker', 'state-schema', `${where}: ${detail}`));
  }
}

// ---------------------------------------------------------------------------
// Check (b): unsubstituted placeholder scan
// ---------------------------------------------------------------------------

function findPlaceholderTokens(content) {
  // Returns Map<token, firstLineNumber>
  const tokens = new Map();
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    PLACEHOLDER_RE.lastIndex = 0;
    let m;
    while ((m = PLACEHOLDER_RE.exec(lines[i])) !== null) {
      if (!tokens.has(m[1])) tokens.set(m[1], i + 1);
    }
  }
  return tokens;
}

function checkPlaceholders(ctx, findings) {
  const { repoRoot, state, managedMap, manifest } = ctx;
  if (!state || typeof state.files !== 'object' || state.files === null) return;
  const substitutions = (state.substitutions && typeof state.substitutions === 'object')
    ? state.substitutions : {};
  const entryByPattern = new Map();
  if (manifest && Array.isArray(manifest.managedFiles)) {
    for (const e of manifest.managedFiles) {
      if (e && typeof e.path === 'string' && !entryByPattern.has(e.path)) entryByPattern.set(e.path, e);
    }
  }

  for (const [rel, st] of Object.entries(state.files)) {
    if (!isSafeRelPath(rel)) continue; // schema already flags these
    let entry = managedMap ? managedMap.get(rel) : undefined;
    if (!entry && st && typeof st.lastAppliedSourcePath === 'string') {
      entry = entryByPattern.get(st.lastAppliedSourcePath);
    }
    if (!entry || entry.substituteAt !== 'adoption') continue;

    let content;
    try {
      content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    } catch {
      continue; // absence is reported by the state-vs-disk check
    }
    const tokens = findPlaceholderTokens(content);
    if (tokens.size === 0) continue;

    const parts = [];
    for (const [token, line] of tokens) {
      const inMap = Object.prototype.hasOwnProperty.call(substitutions, token);
      parts.push(`{{${token}}} (line ${line}, ${inMap ? 'HAS a substitutions entry — substitution was never applied' : 'no substitutions entry — key missing from the map'})`);
    }
    findings.push(makeFinding('warn', 'placeholders',
      `unsubstituted placeholder token(s) in adoption-substituted file: ${parts.join('; ')}`, rel));
  }
}

// ---------------------------------------------------------------------------
// Check (c): state.files vs disk reconciliation
// ---------------------------------------------------------------------------

function checkStateVsDisk(ctx, findings) {
  const { repoRoot, state, managedMap, manifest } = ctx;
  if (!state || typeof state.files !== 'object' || state.files === null) return;

  const removedPaths = new Set(
    (manifest && Array.isArray(manifest.removedFiles) ? manifest.removedFiles : [])
      .map(r => r && r.path).filter(p => typeof p === 'string')
  );

  // Direction 1: every tracked path should exist on disk.
  for (const rel of Object.keys(state.files)) {
    if (!isSafeRelPath(rel)) continue;
    if (!fs.existsSync(path.join(repoRoot, rel))) {
      findings.push(makeFinding('warn', 'state-vs-disk',
        'state-tracked file is missing on disk — next sync will classify it as customised and emit a .framework-new (classifyFile treats a deleted target as an operator edit)', rel));
    }
    // Orphan detection: tracked but no longer produced by any manifest glob.
    if (managedMap && !managedMap.has(rel)) {
      const note = removedPaths.has(rel)
        ? 'listed in manifest removedFiles (warn-only removal); the state entry is retirement residue'
        : 'no manifest managedFiles glob expands to this path in the mounted framework';
      findings.push(makeFinding('info', 'state-vs-disk',
        `orphan state entry — ${note}`, rel));
    }
  }

  // Direction 2: every managed framework file present on the consumer's disk
  // should be tracked. Untracked+present means the next sync classifies it
  // new-file-no-state with targetExists: true — a conflict.
  if (managedMap) {
    const pendingNew = [];
    for (const [rel, entry] of managedMap) {
      if (state.files[rel]) continue;
      if (fs.existsSync(path.join(repoRoot, rel))) {
        findings.push(makeFinding('warn', 'state-vs-disk',
          `managed file exists on disk but has no state entry (manifest entry ${entry.path}, mode ${entry.mode}) — next sync treats it as new-file-no-state with a pre-existing target`, rel));
      } else {
        pendingNew.push(rel);
      }
    }
    if (pendingNew.length > 0) {
      const shown = pendingNew.slice(0, 5).join(', ');
      const more = pendingNew.length > 5 ? ` (+${pendingNew.length - 5} more)` : '';
      findings.push(makeFinding('info', 'state-vs-disk',
        `${pendingNew.length} managed framework file(s) not yet present in the consumer and untracked — expected when the framework submodule is ahead of the last sync; the next sync writes them as new: ${shown}${more}`));
    }
  }
}

// ---------------------------------------------------------------------------
// Check (d): syncIgnore rot
// ---------------------------------------------------------------------------

function checkSyncIgnore(ctx, findings) {
  const { state, managedMap } = ctx;
  if (!state || !Array.isArray(state.syncIgnore)) return;
  const seen = new Set();
  for (const entry of state.syncIgnore) {
    if (typeof entry !== 'string') continue; // schema flags it
    if (seen.has(entry)) {
      findings.push(makeFinding('info', 'sync-ignore', 'duplicate syncIgnore entry', entry));
      continue;
    }
    seen.add(entry);
    if (managedMap && !managedMap.has(entry)) {
      findings.push(makeFinding('warn', 'sync-ignore',
        'syncIgnore entry matches no managed path in the mounted framework manifest — dead configuration (classifyFile matches syncIgnore by exact path equality)', entry));
    }
  }
}

// ---------------------------------------------------------------------------
// Check (e): appliedMigrations vs migrations/ (both directions)
// ---------------------------------------------------------------------------

function discoverMigrationVersions(frameworkRoot) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(frameworkRoot, 'migrations'));
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const m = e.match(/^v(\d+\.\d+\.\d+)\.js$/);
    if (m) out.push(m[1]);
  }
  return out.sort(compareSemver);
}

function resolveAdoptionVersion(frameworkRoot, adoptedFromCommit) {
  if (typeof adoptedFromCommit !== 'string' || adoptedFromCommit.length === 0) return null;
  try {
    const res = spawnSync('git', ['-C', frameworkRoot, 'show', `${adoptedFromCommit}:.claude/FRAMEWORK_VERSION`],
      { encoding: 'utf8' });
    if (res.status === 0) {
      const v = String(res.stdout || '').trim();
      if (/^\d+\.\d+\.\d+$/.test(v)) return v;
    }
  } catch {
    // git unavailable — fall through to the unknown-baseline path
  }
  return null;
}

function checkMigrations(ctx, findings) {
  const { frameworkRoot, state } = ctx;
  if (!state) return;
  const discovered = discoverMigrationVersions(frameworkRoot);
  const discoveredSet = new Set(discovered);
  const applied = Array.isArray(state.appliedMigrations) ? state.appliedMigrations : [];

  const seen = new Set();
  for (const v of applied) {
    if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v)) continue; // schema flags it
    if (seen.has(v)) {
      findings.push(makeFinding('info', 'migrations', `duplicate appliedMigrations entry: ${v}`));
      continue;
    }
    seen.add(v);
    if (!discoveredSet.has(v)) {
      findings.push(makeFinding('warn', 'migrations',
        `appliedMigrations records v${v} but migrations/v${v}.js does not exist in the mounted framework — the migration file was removed or the state was hand-edited`));
    }
  }

  const stateVersion = typeof state.frameworkVersion === 'string' && /^\d+\.\d+\.\d+$/.test(state.frameworkVersion)
    ? state.frameworkVersion : null;
  if (!stateVersion) return;

  const adoptionVersion = ctx.adoptionVersion !== undefined
    ? ctx.adoptionVersion
    : resolveAdoptionVersion(frameworkRoot, state.adoptedFromCommit);
  ctx.resolvedAdoptionVersion = adoptionVersion;

  for (const v of discovered) {
    if (seen.has(v)) continue;
    if (compareSemver(v, stateVersion) > 0) continue; // future migration — runs at the next update
    if (adoptionVersion !== null) {
      if (compareSemver(v, adoptionVersion) <= 0) continue; // predates adoption: never applicable
      findings.push(makeFinding('warn', 'migrations',
        `pending unapplied migration: migrations/v${v}.js falls in (adoption v${adoptionVersion}, state v${stateVersion}] but is not in appliedMigrations — run-migrations.js never ran for that range, or the migration reported conflict and was never resolved`));
    } else {
      findings.push(makeFinding('info', 'migrations',
        `migration migrations/v${v}.js (<= state v${stateVersion}) is not in appliedMigrations — adoption baseline could not be resolved from adoptedFromCommit, so this may simply predate adoption`));
    }
  }
}

// ---------------------------------------------------------------------------
// Check (f): orphaned *.framework-new files
// ---------------------------------------------------------------------------

function walkForSuffix(dir, suffix, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_WALK_DIRS.has(e.name)) continue;
      walkForSuffix(full, suffix, out);
    } else if (e.isFile() && e.name.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

function checkFrameworkNew(ctx, findings) {
  const { repoRoot, state, managedMap } = ctx;

  // Scan the union of directories that can contain managed files: the first
  // path segment of every managed path and every state-tracked path. This
  // bounds the walk (never the whole consumer repo) while still catching
  // orphans whose base path is in NEITHER manifest nor state — the case
  // scanForUnresolvedMerges (sync.js:506) cannot see.
  const roots = new Set();
  if (managedMap) for (const rel of managedMap.keys()) roots.add(rel.split('/')[0]);
  if (state && state.files && typeof state.files === 'object') {
    for (const rel of Object.keys(state.files)) {
      if (isSafeRelPath(rel)) roots.add(rel.split('/')[0]);
    }
  }

  const found = [];
  for (const seg of roots) {
    const full = path.join(repoRoot, seg);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      walkForSuffix(full, '.framework-new', found);
    } else if (fs.existsSync(full + '.framework-new')) {
      found.push(full + '.framework-new');
    }
  }
  // Root-level managed files (e.g. CONTRIBUTING.md) are covered above via the
  // non-directory branch; also sweep the repo root's immediate children.
  let rootEntries = [];
  try { rootEntries = fs.readdirSync(repoRoot); } catch { /* repo existence already checked */ }
  for (const name of rootEntries) {
    if (name.endsWith('.framework-new')) found.push(path.join(repoRoot, name));
  }

  const seen = new Set();
  for (const abs of found.sort()) {
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    const base = rel.slice(0, -'.framework-new'.length);
    const tracked = Boolean((managedMap && managedMap.has(base)) ||
      (state && state.files && state.files[base]));
    findings.push(makeFinding('warn', 'framework-new', tracked
      ? 'unresolved .framework-new merge file — sync.js refuses to run until it is resolved or deleted'
      : 'ORPHANED .framework-new file — its base path is in neither the manifest nor state, so scanForUnresolvedMerges will never surface it',
      rel));
  }
}

// ---------------------------------------------------------------------------
// Check (g): settings.json hook command paths
// ---------------------------------------------------------------------------

function collectHookCommands(settings) {
  const out = [];
  if (!settings || typeof settings !== 'object' || !settings.hooks || typeof settings.hooks !== 'object') return out;
  for (const [event, matchers] of Object.entries(settings.hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) {
      if (!m || typeof m !== 'object' || !Array.isArray(m.hooks)) continue;
      for (const h of m.hooks) {
        if (h && typeof h.command === 'string') out.push({ event, command: h.command });
      }
    }
  }
  return out;
}

function extractHookCommandPaths(command, repoRoot) {
  // Both quoting dialects appear in live settings files:
  //   node "$CLAUDE_PROJECT_DIR"/.claude/hooks/x.js
  //   node ${CLAUDE_PROJECT_DIR}/.claude/hooks/y.js
  const normalized = String(command).replace(
    /"\$\{CLAUDE_PROJECT_DIR\}"|"\$CLAUDE_PROJECT_DIR"|\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR/g,
    '<ROOT>'
  );
  const results = [];
  for (let tok of normalized.split(/\s+/)) {
    tok = tok.replace(/^["']+/, '').replace(/["'`;|&]+$/, '');
    if (!HOOK_FILE_EXT_RE.test(tok)) continue;
    let resolved;
    if (tok.startsWith('<ROOT>')) resolved = path.join(repoRoot, tok.slice('<ROOT>'.length));
    else if (path.isAbsolute(tok) || /^[A-Za-z]:/.test(tok)) resolved = tok;
    else resolved = path.join(repoRoot, tok);
    results.push({ display: tok.replace('<ROOT>', '$CLAUDE_PROJECT_DIR'), resolved });
  }
  return results;
}

function checkSettingsHooks(ctx, findings) {
  const { repoRoot } = ctx;
  for (const name of ['settings.json', 'settings.local.json']) {
    const filePath = path.join(repoRoot, '.claude', name);
    const rel = `.claude/${name}`;
    const read = readJson(filePath);
    if (!read.ok) {
      if (read.missing) {
        if (name === 'settings.json') {
          findings.push(makeFinding('info', 'settings-hooks', 'no .claude/settings.json in the consumer — no hooks are registered', rel));
        }
        continue;
      }
      findings.push(makeFinding('warn', 'settings-hooks', `cannot parse ${rel}: ${read.error}`, rel));
      continue;
    }
    for (const { event, command } of collectHookCommands(read.value)) {
      for (const { display, resolved } of extractHookCommandPaths(command, repoRoot)) {
        if (!fs.existsSync(resolved)) {
          findings.push(makeFinding('warn', 'settings-hooks',
            `${rel} registers a ${event} hook whose command references a missing file: ${display} — the hook fails silently at runtime`, rel));
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// runAudit
// ---------------------------------------------------------------------------

/**
 * @param {{ repoRoot: string, frameworkRoot: string, adoptionVersion?: string|null }} opts
 *   `adoptionVersion` is a test seam: when provided (including null), the git
 *   resolution of adoptedFromCommit is skipped and this value is used instead.
 * @returns {{ findings: Array<{severity: string, check: string, message: string, path?: string}>,
 *             counts: { blocker: number, warn: number, info: number },
 *             meta: Record<string, unknown> }}
 */
function runAudit(opts) {
  const repoRoot = path.resolve(opts.repoRoot);
  const frameworkRoot = path.resolve(opts.frameworkRoot);
  const findings = [];
  const meta = { repoRoot, frameworkRoot };

  let repoOk = true;
  try {
    if (!fs.statSync(repoRoot).isDirectory()) throw new Error('not a directory');
  } catch (err) {
    findings.push(makeFinding('blocker', 'repo', `consumer repo root is not a readable directory: ${repoRoot} (${err.message})`));
    repoOk = false;
  }

  // --- manifest (fail closed) ---
  let manifest = null;
  const manifestPath = path.join(frameworkRoot, 'manifest.json');
  const manifestRead = readJson(manifestPath);
  if (!manifestRead.ok) {
    findings.push(makeFinding('blocker', 'manifest',
      `cannot read framework manifest at ${manifestPath}: ${manifestRead.error}. ` +
      'Failing closed — manifest-dependent checks (placeholders, disk reconciliation, syncIgnore) cannot run.'));
  } else if (!manifestRead.value || typeof manifestRead.value !== 'object' ||
             !Array.isArray(manifestRead.value.managedFiles) ||
             typeof manifestRead.value.frameworkVersion !== 'string') {
    findings.push(makeFinding('blocker', 'manifest',
      `framework manifest at ${manifestPath} is structurally invalid (expected object with string frameworkVersion and managedFiles array). Failing closed.`));
  } else {
    manifest = manifestRead.value;
    meta.manifestVersion = manifest.frameworkVersion;
    const versionFile = path.join(frameworkRoot, '.claude', 'FRAMEWORK_VERSION');
    try {
      const fileVersion = fs.readFileSync(versionFile, 'utf8').trim();
      if (fileVersion !== manifest.frameworkVersion) {
        findings.push(makeFinding('warn', 'manifest',
          `framework checkout is inconsistent: manifest.json says v${manifest.frameworkVersion} but .claude/FRAMEWORK_VERSION says v${fileVersion} (sync.js refuses to run in this condition)`));
      }
    } catch { /* FRAMEWORK_VERSION absent — sync.js would hard-fail, but manifest alone suffices for auditing */ }
  }

  // Framework-side glob expansion: relPath -> first matching manifest entry
  // (identical dedupe semantics to sync.js expandManagedFiles).
  let managedMap = null;
  if (manifest) {
    managedMap = new Map();
    for (const entry of manifest.managedFiles) {
      if (!entry || typeof entry.path !== 'string') continue;
      let expanded;
      try {
        expanded = expandGlob(entry.path, frameworkRoot);
      } catch (err) {
        findings.push(makeFinding('blocker', 'manifest',
          `manifest glob "${entry.path}" failed to expand: ${err.message}. Failing closed.`));
        continue;
      }
      for (const rel of expanded) {
        if (!managedMap.has(rel)) managedMap.set(rel, entry);
      }
    }
    meta.managedFileCount = managedMap.size;
  }

  // --- state (fail closed) ---
  let state = null;
  const statePath = path.join(repoRoot, '.claude', '.framework-state.json');
  if (repoOk) {
    const stateRead = readJson(statePath);
    if (!stateRead.ok) {
      findings.push(makeFinding('blocker', 'state', stateRead.missing
        ? `.claude/.framework-state.json not found at ${statePath} — the repo has not adopted the framework (or the state file was deleted). sync.js would treat ALL files as customised; run sync.js --adopt to re-initialise.`
        : `.claude/.framework-state.json at ${statePath} is unreadable: ${stateRead.error}. sync.js degrades to "all files treated as customised" with no field-level diagnosis — failing closed.`));
    } else if (!stateRead.value || typeof stateRead.value !== 'object' || Array.isArray(stateRead.value)) {
      findings.push(makeFinding('blocker', 'state',
        `.claude/.framework-state.json must be a JSON object, got ${Array.isArray(stateRead.value) ? 'array' : typeof stateRead.value}`));
    } else {
      state = stateRead.value;
      meta.stateVersion = state.frameworkVersion;
      meta.profile = state.profile;
      meta.adoptedAt = state.adoptedAt;
      meta.trackedFileCount = state.files && typeof state.files === 'object'
        ? Object.keys(state.files).length : 0;
    }
  }

  if (state) {
    // (a) field-level schema diagnosis
    validateStateSchema(state, findings);
    for (const key of Object.keys(state)) {
      if (!KNOWN_STATE_KEYS.has(key)) {
        findings.push(makeFinding('info', 'state-schema',
          `unknown top-level state key "${key}" — not in the sync.js FrameworkState contract (version skew between state writer and this audit?)`));
      }
    }

    // version relationship between state and mounted framework
    if (manifest && typeof state.frameworkVersion === 'string' &&
        /^\d+\.\d+\.\d+$/.test(state.frameworkVersion) &&
        /^\d+\.\d+\.\d+$/.test(manifest.frameworkVersion)) {
      const cmp = compareSemver(state.frameworkVersion, manifest.frameworkVersion);
      if (cmp < 0) {
        findings.push(makeFinding('info', 'version',
          `state is at v${state.frameworkVersion} but the mounted framework is v${manifest.frameworkVersion} — a sync is pending`));
      } else if (cmp > 0) {
        findings.push(makeFinding('warn', 'version',
          `state records v${state.frameworkVersion} but the mounted framework is OLDER (v${manifest.frameworkVersion}) — sync.js will refuse to run (downgrade guard); the submodule was likely rolled back`));
      }
    }

    // stale lastSubstitutionHash (checkSubstitutionDrift only fires during a sync)
    if (state.substitutions && typeof state.substitutions === 'object' && !Array.isArray(state.substitutions)) {
      if (typeof state.lastSubstitutionHash === 'string') {
        let current = null;
        try { current = hashSubstitutions(state.substitutions); } catch { /* non-string values: schema flags them */ }
        if (current !== null && current !== state.lastSubstitutionHash) {
          findings.push(makeFinding('warn', 'substitution-drift',
            'state.substitutions changed since the last sync (lastSubstitutionHash mismatch) — already-current files still carry the OLD substitution values; run sync.js --adopt to rebaseline'));
        }
      } else if (state.lastSubstitutionHash === undefined) {
        findings.push(makeFinding('info', 'substitution-drift',
          'lastSubstitutionHash is absent (state predates the drift check) — the next sync sets it; substitution drift is undetectable until then'));
      }
      if (Object.keys(state.substitutions).length === 0 && managedMap) {
        let adoptionFiles = 0;
        for (const entry of managedMap.values()) if (entry.substituteAt === 'adoption') adoptionFiles++;
        if (adoptionFiles > 0) {
          findings.push(makeFinding('info', 'substitution-drift',
            `substitution map is empty while ${adoptionFiles} managed file(s) declare substituteAt: "adoption" — those files retain literal {{PLACEHOLDER}} content`));
        }
      }
    }

    const ctx = { repoRoot, frameworkRoot, state, manifest, managedMap };
    if ('adoptionVersion' in opts) ctx.adoptionVersion = opts.adoptionVersion;

    checkPlaceholders(ctx, findings);      // (b)
    checkStateVsDisk(ctx, findings);       // (c)
    checkSyncIgnore(ctx, findings);        // (d)
    checkMigrations(ctx, findings);        // (e)
    checkFrameworkNew(ctx, findings);      // (f)
    if (ctx.resolvedAdoptionVersion !== undefined) meta.adoptionVersion = ctx.resolvedAdoptionVersion;
  } else if (repoOk) {
    // State is unreadable, but the .framework-new sweep and hook check need no state.
    checkFrameworkNew({ repoRoot, frameworkRoot, state: null, manifest, managedMap }, findings);
  }

  if (repoOk) checkSettingsHooks({ repoRoot }, findings);  // (g)

  const counts = { blocker: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return { findings, counts, meta };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printHuman(result) {
  const { findings, counts, meta } = result;
  process.stdout.write('Consumer-drift audit (read-only)\n');
  process.stdout.write(`  repo:      ${meta.repoRoot}\n`);
  process.stdout.write(`  framework: ${meta.frameworkRoot}${meta.manifestVersion ? ` (manifest v${meta.manifestVersion})` : ''}\n`);
  if (meta.stateVersion) {
    const adoption = meta.adoptionVersion ? `, adopted at framework v${meta.adoptionVersion}` : '';
    process.stdout.write(`  state:     v${meta.stateVersion}, profile ${meta.profile}, ${meta.trackedFileCount} tracked file(s)${adoption}\n`);
  }
  process.stdout.write('\n');
  for (const severity of ['blocker', 'warn', 'info']) {
    const group = findings.filter(f => f.severity === severity);
    if (group.length === 0) continue;
    process.stdout.write(`${severity.toUpperCase()} (${group.length})\n`);
    for (const f of group) {
      process.stdout.write(`  [${f.check}]${f.path ? ` ${f.path}:` : ''} ${f.message}\n`);
    }
    process.stdout.write('\n');
  }
  process.stdout.write(`AUDIT: ${counts.blocker} blocker(s), ${counts.warn} warning(s), ${counts.info} info — ${counts.blocker > 0 ? 'FAIL' : 'PASS'}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`ERROR: ${args.error}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/audit-consumer-state.js [--repo <path>] [--framework <path>] [--json]\n\n' +
      'Read-only consumer-drift audit for repos that mount claude-code-framework.\n' +
      '  --repo       Consumer repo root (default: parent of this .claude-framework mount, else cwd)\n' +
      '  --framework  Framework mount to audit against (default: <repo>/.claude-framework)\n' +
      '  --json       Machine-readable output\n\n' +
      'Exit codes: 0 clean-or-warnings, 1 blocker findings, 2 usage error.\n'
    );
    process.exit(0);
  }
  const { repoRoot, frameworkRoot } = resolveRoots(args, path.resolve(__dirname, '..'), process.cwd());
  const result = runAudit({ repoRoot, frameworkRoot });
  if (args.json) {
    process.stdout.write(JSON.stringify({
      generatedAt: new Date().toISOString(),
      ...result.meta,
      counts: result.counts,
      findings: result.findings,
    }, null, 2) + '\n');
  } else {
    printHuman(result);
  }
  process.exit(result.counts.blocker > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  runAudit,
  parseArgs,
  resolveRoots,
  findPlaceholderTokens,
  collectHookCommands,
  extractHookCommandPaths,
  discoverMigrationVersions,
  resolveAdoptionVersion,
  SCHEMA_PATH,
};
