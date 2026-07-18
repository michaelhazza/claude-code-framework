#!/usr/bin/env node
'use strict';

/**
 * check-migrations.js — migration coverage gate.
 *
 * Statically verifies the invariants the /claudeupdate migration pipeline
 * relies on but nothing else enforces. Motivated by the v2.32.1 incident
 * (.claude/CHANGELOG.md "2.32.1" entry): migrations/v2.13.0.js carried a `*`+`/`
 * glob inside a block comment, terminating the comment early and making the
 * file a SyntaxError — every pre-2.13.0 consumer's /claudeupdate was bricked
 * before sync.js ran. An unparseable migration is fleet-wide breakage.
 *
 * Checks (each grounded in the real mechanism):
 *   parse               node --check on every migrations/*.js (including the
 *                       underscore-prefixed _helpers.js/_template.js — a broken
 *                       helper breaks every migration that requires it).
 *   load                require() each discovered migrations/v*.js in a CHILD
 *                       process and verify it exports migrate() as a function
 *                       (scripts/run-migrations.js:132-139 requires the module
 *                       and throws when migrate is missing). A parse-clean file
 *                       can still throw at require time; the child isolates the
 *                       gate from top-level throws, process.exit, and hangs.
 *   naming              every non-underscore .js in migrations/ must match the
 *                       runner discovery regex ^v<semver>.js$
 *                       (scripts/run-migrations.js:57) — a near-miss name is a
 *                       migration that silently never runs.
 *   test-coverage       every discovered migration version is referenced by
 *                       tests/migrations.test.ts the way that file references
 *                       real migrations: path.join(..., 'migrations',
 *                       'v<ver>.js') or a migrations/v<ver>.js path string.
 *                       Bare version strings do NOT count — the runner tests
 *                       use synthetic fixture versions (2.2.0 etc.) that must
 *                       not read as coverage. Mandated by migrations/README.md
 *                       "Authoring a new migration" step 4.
 *   changelog-coverage  every discovered migration version is referenced in
 *                       the changelog as v<ver>.js (migrations/README.md step 5;
 *                       observed convention: every shipped migration appears as
 *                       `migrations/v<ver>.js` or `v<ver>.js` in .claude/CHANGELOG.md).
 *   test-orphan-ref     tests/migrations.test.ts references a migrations/v*.js
 *                       file that does not exist.
 *   changelog-orphan-ref  the changelog references a v<ver>.js migration that
 *                       does not exist (migrations are never deleted — consumers
 *                       on old versions still need them).
 *   version-ceiling     no migration version exceeds .claude/FRAMEWORK_VERSION.
 *                       The runner only runs versions <= toVersion
 *                       (scripts/run-migrations.js:115), so a migration above
 *                       the released version is dormant and will never run.
 *
 * Fail-closed: missing/unreadable migrations/, tests/migrations.test.ts,
 * changelog, or FRAMEWORK_VERSION is itself a failure (exit 1).
 *
 * Usage:
 *   node scripts/check-migrations.js [--json] [--root <dir>]
 *
 * Exit codes: 0 all checks pass, 1 findings or fail-closed, 2 usage error.
 * Env: CHECK_MIGRATIONS_LOAD_TIMEOUT_MS — per-file require() child timeout
 * (default 15000).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Reuse the runner's semver semantics rather than re-implementing them —
// the gate must agree with scripts/run-migrations.js exactly.
const { parseSemver, compareSemver } = require('./run-migrations.js');

/** Mirrors the discovery regex in scripts/run-migrations.js:57. */
const DISCOVERY_RE = /^v(\d+\.\d+\.\d+)\.js$/;

const TEST_FILE_REL = path.join('tests', 'migrations.test.ts');
const CHANGELOG_CANDIDATES = [
  path.join('.claude', 'CHANGELOG.md'),
  'CHANGELOG.md',
];
const FRAMEWORK_VERSION_REL = path.join('.claude', 'FRAMEWORK_VERSION');

const LOAD_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.CHECK_MIGRATIONS_LOAD_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 15000;
})();

/** Child-process source for the load check (argv[1] = migration file path). */
const LOADER_SRC = [
  "'use strict';",
  'const file = process.argv[1];',
  'let mod;',
  'try { mod = require(file); }',
  'catch (err) { console.error(String((err && err.stack) || err)); process.exit(2); }',
  "if (!mod || typeof mod.migrate !== 'function') { console.error('module does not export migrate(ctx)'); process.exit(3); }",
].join('\n');

function rel(root, p) {
  return path.relative(root, p).split(path.sep).join('/');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Versions referenced by the test file the way it references REAL migration
 * files (see tests/migrations.test.ts:31-33 — path.join(FRAMEWORK_ROOT,
 * 'migrations', 'v2.30.0.js') — and migrations/v<ver>.js path-string
 * mentions). The join pattern is anchored on FRAMEWORK_ROOT deliberately:
 * the runner tests also path.join synthetic fixture migrations into temp
 * fake-framework roots (e.g. path.join(fw, 'migrations', 'v2.3.0.js') at
 * tests/migrations.test.ts:215), and those must count neither as coverage
 * nor as orphan refs. Bare version strings never count for the same reason.
 */
function extractTestVersionRefs(src) {
  const out = new Set();
  const patterns = [
    /FRAMEWORK_ROOT\s*,\s*['"`]migrations['"`]\s*,\s*['"`]v(\d+\.\d+\.\d+)\.js['"`]/g,
    /migrations[/\\]v(\d+\.\d+\.\d+)\.js/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) out.add(m[1]);
  }
  return out;
}

/** Every v<semver>.js token in the changelog (the observed reference convention). */
function extractChangelogVersionRefs(src) {
  const out = new Set();
  const re = /\bv(\d+\.\d+\.\d+)\.js\b/g;
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

function checkParse(file) {
  const res = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    timeout: LOAD_TIMEOUT_MS,
  });
  if (res.error) return `node --check failed to spawn: ${res.error.message}`;
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim() || `exit ${res.status}`;
    return `does not parse (node --check): ${detail}`;
  }
  return null;
}

function checkLoad(file) {
  const res = spawnSync(process.execPath, ['-e', LOADER_SRC, file], {
    encoding: 'utf8',
    timeout: LOAD_TIMEOUT_MS,
  });
  if (res.error && res.error.code === 'ETIMEDOUT') {
    return `require() timed out after ${LOAD_TIMEOUT_MS}ms (hung at load time)`;
  }
  if (res.error) return `load child failed to spawn: ${res.error.message}`;
  if (res.status === null) {
    return `require() child was killed (likely timeout after ${LOAD_TIMEOUT_MS}ms)`;
  }
  if (res.status === 3) return 'module does not export migrate(ctx)';
  if (res.status !== 0) {
    const detail = (res.stderr || '').trim().split('\n').slice(0, 4).join(' | ') || `exit ${res.status}`;
    return `throws at require() time: ${detail}`;
  }
  return null;
}

/**
 * Run every check against the repo at `root`.
 * Returns { ok, root, changelog, frameworkVersion, migrations, findings, summary }.
 */
function runChecks(root) {
  const findings = [];
  const add = (check, file, message, version) => {
    findings.push({ check, file, version: version || null, message });
  };

  const migrationsDir = path.join(root, 'migrations');
  const report = {
    ok: false,
    root,
    changelog: null,
    frameworkVersion: null,
    migrations: [],
    findings,
    summary: {},
  };

  // --- discovery (fail closed on an unreadable migrations/) -----------------
  let entries;
  try {
    entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  } catch (err) {
    add('fail-closed', 'migrations', `cannot read migrations/ directory: ${err.message}`);
    finaliseSummary(report);
    return report;
  }

  const migrations = []; // { version, file(abs), rel }
  const parseTargets = []; // every .js in migrations/, underscore files included
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = path.join(migrationsDir, e.name);
    if (!e.name.endsWith('.js')) continue;
    parseTargets.push(abs);
    if (e.name.startsWith('_')) continue; // _helpers.js / _template.js — never discovered by the runner
    const m = e.name.match(DISCOVERY_RE);
    if (!m) {
      add(
        'naming',
        rel(root, abs),
        `does not match the runner discovery regex ^v<MAJOR>.<MINOR>.<PATCH>.js$ (scripts/run-migrations.js) — this file will silently never run`
      );
      continue;
    }
    migrations.push({ version: m[1], file: abs, rel: rel(root, abs) });
  }
  migrations.sort((a, b) => compareSemver(a.version, b.version));
  report.migrations = migrations.map((m) => ({ version: m.version, file: m.rel }));

  // --- parse (node --check) --------------------------------------------------
  const parseFailed = new Set();
  for (const file of parseTargets) {
    const msg = checkParse(file);
    if (msg) {
      parseFailed.add(file);
      add('parse', rel(root, file), msg);
    }
  }

  // --- load (child require + migrate export) --------------------------------
  for (const m of migrations) {
    if (parseFailed.has(m.file)) continue; // parse finding already reported
    const msg = checkLoad(m.file);
    if (msg) add('load', m.rel, msg, m.version);
  }

  // --- test coverage + reverse (fail closed on unreadable test file) --------
  const testFileAbs = path.join(root, TEST_FILE_REL);
  const testFileRel = rel(root, testFileAbs);
  let testSrc = null;
  try {
    testSrc = fs.readFileSync(testFileAbs, 'utf8');
  } catch (err) {
    add('fail-closed', testFileRel, `cannot read ${testFileRel}: ${err.message}`);
  }
  if (testSrc !== null) {
    const testRefs = extractTestVersionRefs(testSrc);
    for (const m of migrations) {
      if (!testRefs.has(m.version)) {
        add(
          'test-coverage',
          m.rel,
          `version ${m.version} is not exercised by ${testFileRel} (no 'migrations', 'v${m.version}.js' path reference) — migrations/README.md requires a test per migration`,
          m.version
        );
      }
    }
    const known = new Set(migrations.map((m) => m.version));
    for (const v of testRefs) {
      if (!known.has(v)) {
        add(
          'test-orphan-ref',
          testFileRel,
          `references migrations/v${v}.js which does not exist`,
          v
        );
      }
    }
  }

  // --- changelog coverage + reverse (fail closed when no changelog) ---------
  let changelogRel = null;
  let changelogSrc = null;
  for (const cand of CHANGELOG_CANDIDATES) {
    const abs = path.join(root, cand);
    if (fs.existsSync(abs)) {
      try {
        changelogSrc = fs.readFileSync(abs, 'utf8');
        changelogRel = rel(root, abs);
      } catch (err) {
        add('fail-closed', rel(root, abs), `cannot read changelog: ${err.message}`);
      }
      break;
    }
  }
  if (changelogSrc === null && !findings.some((f) => f.check === 'fail-closed' && /changelog/i.test(f.message))) {
    add(
      'fail-closed',
      CHANGELOG_CANDIDATES[0].split(path.sep).join('/'),
      `no changelog found (looked for ${CHANGELOG_CANDIDATES.map((c) => c.split(path.sep).join('/')).join(', ')})`
    );
  }
  report.changelog = changelogRel;
  if (changelogSrc !== null) {
    const changelogRefs = extractChangelogVersionRefs(changelogSrc);
    for (const m of migrations) {
      const token = `v${m.version}.js`;
      if (!new RegExp(`\\b${escapeRegExp(token)}\\b`).test(changelogSrc)) {
        add(
          'changelog-coverage',
          m.rel,
          `version ${m.version} is not referenced in ${changelogRel} (expected a '${token}' mention — migrations/README.md step 5)`,
          m.version
        );
      }
    }
    const known = new Set(migrations.map((m) => m.version));
    for (const v of changelogRefs) {
      if (!known.has(v)) {
        add(
          'changelog-orphan-ref',
          changelogRel,
          `references v${v}.js but migrations/v${v}.js does not exist (migrations are never deleted)`,
          v
        );
      }
    }
  }

  // --- version ceiling -------------------------------------------------------
  const fvAbs = path.join(root, FRAMEWORK_VERSION_REL);
  const fvRel = rel(root, fvAbs);
  let frameworkVersion = null;
  try {
    frameworkVersion = fs.readFileSync(fvAbs, 'utf8').trim();
  } catch (err) {
    add('version-ceiling', fvRel, `cannot read ${fvRel}: ${err.message} — ceiling check cannot run`);
  }
  if (frameworkVersion !== null) {
    if (!parseSemver(frameworkVersion)) {
      add('version-ceiling', fvRel, `FRAMEWORK_VERSION "${frameworkVersion}" is not valid semver — ceiling check cannot run`);
      frameworkVersion = null;
    } else {
      report.frameworkVersion = frameworkVersion;
      for (const m of migrations) {
        if (compareSemver(m.version, frameworkVersion) > 0) {
          add(
            'version-ceiling',
            m.rel,
            `version ${m.version} > FRAMEWORK_VERSION ${frameworkVersion} — dormant: the runner only runs versions <= toVersion, so this migration never runs until that version is released`,
            m.version
          );
        }
      }
    }
  }

  finaliseSummary(report);
  return report;
}

const CHECK_ORDER = [
  'fail-closed',
  'parse',
  'load',
  'naming',
  'test-coverage',
  'test-orphan-ref',
  'changelog-coverage',
  'changelog-orphan-ref',
  'version-ceiling',
];

function finaliseSummary(report) {
  const byCheck = {};
  for (const c of CHECK_ORDER) byCheck[c] = 0;
  for (const f of report.findings) byCheck[f.check] = (byCheck[f.check] || 0) + 1;
  report.summary = {
    migrationCount: report.migrations.length,
    findingCount: report.findings.length,
    byCheck,
  };
  report.ok = report.findings.length === 0;
}

function printHuman(report) {
  const out = [];
  out.push(`check-migrations: root=${report.root}`);
  out.push(
    `migrations: ${report.migrations.length} discovered` +
      (report.migrations.length
        ? ` (${report.migrations.map((m) => `v${m.version}`).join(', ')})`
        : '')
  );
  out.push(`changelog: ${report.changelog || 'NOT FOUND'}`);
  out.push(`framework version: ${report.frameworkVersion || 'UNKNOWN'}`);
  out.push('');

  const grouped = new Map();
  for (const f of report.findings) {
    if (!grouped.has(f.check)) grouped.set(f.check, []);
    grouped.get(f.check).push(f);
  }
  const labels = {
    'fail-closed': 'FAIL-CLOSED (required input unreadable)',
    parse: 'PARSE (node --check)',
    load: 'LOAD (require in child process + migrate export)',
    naming: 'NAMING (runner discovery regex)',
    'test-coverage': 'TEST COVERAGE (tests/migrations.test.ts)',
    'test-orphan-ref': 'TEST ORPHAN REFS (tests -> missing migration)',
    'changelog-coverage': 'CHANGELOG COVERAGE',
    'changelog-orphan-ref': 'CHANGELOG ORPHAN REFS (changelog -> missing migration)',
    'version-ceiling': 'VERSION CEILING (migration <= FRAMEWORK_VERSION)',
  };
  for (const check of CHECK_ORDER) {
    const rows = grouped.get(check) || [];
    out.push(`${labels[check]}: ${rows.length === 0 ? 'ok' : `${rows.length} finding(s)`}`);
    for (const f of rows) out.push(`  - ${f.file}: ${f.message}`);
  }
  out.push('');
  out.push(
    report.ok
      ? 'check-migrations: PASS'
      : `check-migrations: FAIL — ${report.findings.length} finding(s)`
  );
  process.stdout.write(out.join('\n') + '\n');
}

function main() {
  const argv = process.argv.slice(2);
  let json = false;
  let root = path.resolve(__dirname, '..');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--root') {
      const v = argv[++i];
      if (!v) {
        process.stderr.write('ERROR: --root requires a directory argument\n');
        process.exit(2);
      }
      root = path.resolve(v);
    } else if (a === '--help' || a === '-h') {
      process.stdout.write('Usage: node scripts/check-migrations.js [--json] [--root <dir>]\n');
      process.exit(0);
    } else {
      process.stderr.write(`ERROR: unknown argument "${a}"\n`);
      process.exit(2);
    }
  }

  const report = runChecks(root);
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else printHuman(report);
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  runChecks,
  extractTestVersionRefs,
  extractChangelogVersionRefs,
  DISCOVERY_RE,
};
