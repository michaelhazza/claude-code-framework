/**
 * check-migrations.test.ts
 *
 * Vitest tests for scripts/check-migrations.js — the migration coverage gate.
 * Run via: npx vitest run scripts/__tests__/check-migrations.test.ts
 *
 * Each test builds a fixture repo in a temp dir (migrations/,
 * tests/migrations.test.ts, .claude/CHANGELOG.md, .claude/FRAMEWORK_VERSION)
 * and spawns the real gate CLI against it with --root --json, mirroring how
 * tests/migrations.test.ts exercises run-migrations.js against fake roots.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const GATE = path.resolve(__dirname, '..', 'check-migrations.js');

const GOOD_MIGRATION = [
  "'use strict';",
  'async function migrate(ctx) {',
  "  return { status: 'skipped', notes: [] };",
  '}',
  'module.exports = { migrate };',
  '',
].join('\n');

// Replica of the v2.32.1 incident: a `*`+`/` glob inside a block comment
// terminates the comment early, leaving the rest of the line a SyntaxError.
const UNPARSEABLE_MIGRATION = [
  "'use strict';",
  '/* adds tasks/builds/*/.phase to consumer .gitignore */',
  "module.exports = { migrate: async () => ({ status: 'skipped', notes: [] }) };",
  '',
].join('\n');

const THROWS_ON_REQUIRE_MIGRATION = [
  "'use strict';",
  "throw new Error('boom at require time');",
  '',
].join('\n');

const NO_EXPORT_MIGRATION = [
  "'use strict';",
  'module.exports = {};',
  '',
].join('\n');

const HANGING_MIGRATION = [
  "'use strict';",
  'while (true) {}',
  '',
].join('\n');

interface FixtureOpts {
  /** filename -> source, written under migrations/ */
  migrations?: Record<string, string>;
  /** content of tests/migrations.test.ts; null = omit the file entirely */
  testFile?: string | null;
  /** content of .claude/CHANGELOG.md; null = omit */
  changelog?: string | null;
  /** content of .claude/FRAMEWORK_VERSION; null = omit */
  frameworkVersion?: string | null;
  /** omit the migrations/ directory entirely */
  noMigrationsDir?: boolean;
}

/** Test-file line that references a real migration the way the convention does. */
function testRef(version: string): string {
  return `const SRC = path.join(FRAMEWORK_ROOT, 'migrations', 'v${version}.js');\n`;
}

function changelogRef(version: string): string {
  return `## ${version}\n- Migration: v${version}.js — does the thing.\n`;
}

function makeRepo(opts: FixtureOpts = {}): string {
  const root = path.join(os.tmpdir(), `check-migr-${crypto.randomUUID()}`);
  if (!opts.noMigrationsDir) {
    fs.mkdirSync(path.join(root, 'migrations'), { recursive: true });
    for (const [name, src] of Object.entries(opts.migrations ?? {})) {
      fs.writeFileSync(path.join(root, 'migrations', name), src, 'utf8');
    }
  }
  if (opts.testFile !== null) {
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'tests', 'migrations.test.ts'),
      opts.testFile ?? '// no migration refs\n',
      'utf8'
    );
  }
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  if (opts.changelog !== null) {
    fs.writeFileSync(
      path.join(root, '.claude', 'CHANGELOG.md'),
      opts.changelog ?? '# Changelog\n',
      'utf8'
    );
  }
  if (opts.frameworkVersion !== null) {
    fs.writeFileSync(
      path.join(root, '.claude', 'FRAMEWORK_VERSION'),
      (opts.frameworkVersion ?? '9.9.9') + '\n',
      'utf8'
    );
  }
  return root;
}

interface GateResult {
  status: number;
  stdout: string;
  stderr: string;
  json: any;
}

function runGate(root: string, env: Record<string, string> = {}): GateResult {
  const res = spawnSync(process.execPath, [GATE, '--root', root, '--json'], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ...env },
  });
  let json: any = null;
  try {
    json = JSON.parse(res.stdout || 'null');
  } catch {
    // leave null — assertions on json will fail loudly with stdout attached
  }
  return { status: res.status ?? -1, stdout: res.stdout || '', stderr: res.stderr || '', json };
}

function findingsFor(json: any, check: string): any[] {
  return (json?.findings ?? []).filter((f: any) => f.check === check);
}

function rmrf(root: string) {
  fs.rmSync(root, { recursive: true, force: true });
}

/** Fully-covered single-migration fixture — the baseline every test perturbs. */
function cleanOpts(): FixtureOpts {
  return {
    migrations: { 'v9.0.0.js': GOOD_MIGRATION },
    testFile: testRef('9.0.0'),
    changelog: changelogRef('9.0.0'),
    frameworkVersion: '9.0.0',
  };
}

describe('check-migrations gate', () => {
  it('passes a fully-covered fixture (exit 0, ok:true, no findings)', () => {
    const root = makeRepo(cleanOpts());
    try {
      const r = runGate(root);
      expect(r.json, r.stdout + r.stderr).not.toBeNull();
      expect(r.json.findings).toEqual([]);
      expect(r.json.ok).toBe(true);
      expect(r.status).toBe(0);
      // JSON shape sanity
      expect(r.json.migrations).toEqual([{ version: '9.0.0', file: 'migrations/v9.0.0.js' }]);
      expect(r.json.frameworkVersion).toBe('9.0.0');
      expect(r.json.changelog).toBe('.claude/CHANGELOG.md');
      expect(r.json.summary.migrationCount).toBe(1);
    } finally {
      rmrf(root);
    }
  });

  it('flags an unparseable migration (v2.32.1 glob-in-comment replica) as a parse finding and skips its load check', () => {
    const opts = cleanOpts();
    opts.migrations!['v9.0.1.js'] = UNPARSEABLE_MIGRATION;
    opts.testFile! += testRef('9.0.1');
    opts.changelog! += changelogRef('9.0.1');
    opts.frameworkVersion = '9.0.1';
    const root = makeRepo(opts);
    try {
      const r = runGate(root);
      expect(r.status).toBe(1);
      const parse = findingsFor(r.json, 'parse');
      expect(parse).toHaveLength(1);
      expect(parse[0].file).toBe('migrations/v9.0.1.js');
      expect(parse[0].message).toMatch(/does not parse/);
      // No duplicate load finding for the same file.
      expect(findingsFor(r.json, 'load')).toEqual([]);
    } finally {
      rmrf(root);
    }
  });

  it('flags a parse-clean migration that throws at require time, without killing the gate', () => {
    const opts = cleanOpts();
    opts.migrations!['v9.0.1.js'] = THROWS_ON_REQUIRE_MIGRATION;
    opts.testFile! += testRef('9.0.1');
    opts.changelog! += changelogRef('9.0.1');
    opts.frameworkVersion = '9.0.1';
    const root = makeRepo(opts);
    try {
      const r = runGate(root);
      expect(r.status).toBe(1);
      expect(r.json, r.stdout + r.stderr).not.toBeNull(); // gate completed and emitted a full report
      const load = findingsFor(r.json, 'load');
      expect(load).toHaveLength(1);
      expect(load[0].file).toBe('migrations/v9.0.1.js');
      expect(load[0].message).toMatch(/throws at require\(\) time/);
      expect(load[0].message).toMatch(/boom at require time/);
    } finally {
      rmrf(root);
    }
  });

  it('flags a migration that loads but does not export migrate(ctx)', () => {
    const opts = cleanOpts();
    opts.migrations!['v9.0.0.js'] = NO_EXPORT_MIGRATION;
    const root = makeRepo(opts);
    try {
      const r = runGate(root);
      expect(r.status).toBe(1);
      const load = findingsFor(r.json, 'load');
      expect(load).toHaveLength(1);
      expect(load[0].message).toMatch(/does not export migrate/);
    } finally {
      rmrf(root);
    }
  });

  it('kills a migration that hangs at require time via the load timeout (gate still finishes)', () => {
    const opts = cleanOpts();
    opts.migrations!['v9.0.0.js'] = HANGING_MIGRATION;
    const root = makeRepo(opts);
    try {
      const r = runGate(root, { CHECK_MIGRATIONS_LOAD_TIMEOUT_MS: '1500' });
      expect(r.status).toBe(1);
      const load = findingsFor(r.json, 'load');
      expect(load).toHaveLength(1);
      expect(load[0].message).toMatch(/timed out|killed/);
    } finally {
      rmrf(root);
    }
  });

  it('flags a migration version with no reference in tests/migrations.test.ts', () => {
    const opts = cleanOpts();
    opts.testFile = '// nothing referenced here\n';
    const root = makeRepo(opts);
    try {
      const r = runGate(root);
      expect(r.status).toBe(1);
      const cov = findingsFor(r.json, 'test-coverage');
      expect(cov).toHaveLength(1);
      expect(cov[0].version).toBe('9.0.0');
      expect(cov[0].file).toBe('migrations/v9.0.0.js');
    } finally {
      rmrf(root);
    }
  });

  it('does not count bare version strings or fake-framework fixture joins as test coverage', () => {
    const opts = cleanOpts();
    // The runner-test style: synthetic fixture versions and non-FRAMEWORK_ROOT joins.
    opts.testFile = [
      "const fw = await makeFakeFramework({ '9.0.0': loggingMigration('9.0.0') });",
      "await fsp.writeFile(path.join(fw, 'migrations', 'v9.0.0.js'), loggingMigration('9.0.0'), 'utf8');",
      '',
    ].join('\n');
    const root = makeRepo(opts);
    try {
      const r = runGate(root);
      expect(r.status).toBe(1);
      expect(findingsFor(r.json, 'test-coverage')).toHaveLength(1);
      // ...and the fixture join must not be treated as an orphan ref either.
      expect(findingsFor(r.json, 'test-orphan-ref')).toEqual([]);
    } finally {
      rmrf(root);
    }
  });

  it('flags a migration version never referenced in the changelog', () => {
    const opts = cleanOpts();
    opts.changelog = '# Changelog\nno migration mentions here\n';
    const root = makeRepo(opts);
    try {
      const r = runGate(root);
      expect(r.status).toBe(1);
      const cov = findingsFor(r.json, 'changelog-coverage');
      expect(cov).toHaveLength(1);
      expect(cov[0].version).toBe('9.0.0');
    } finally {
      rmrf(root);
    }
  });

  it('flags reverse-direction orphans: test and changelog refs pointing at nonexistent migrations', () => {
    const opts = cleanOpts();
    opts.testFile! += testRef('8.8.8');
    opts.changelog! += changelogRef('7.7.7');
    const root = makeRepo(opts);
    try {
      const r = runGate(root);
      expect(r.status).toBe(1);
      const testOrphans = findingsFor(r.json, 'test-orphan-ref');
      expect(testOrphans).toHaveLength(1);
      expect(testOrphans[0].version).toBe('8.8.8');
      const clOrphans = findingsFor(r.json, 'changelog-orphan-ref');
      expect(clOrphans).toHaveLength(1);
      expect(clOrphans[0].version).toBe('7.7.7');
    } finally {
      rmrf(root);
    }
  });

  it('flags migration-like filenames the runner discovery regex would silently skip, but not underscore helpers', () => {
    const opts = cleanOpts();
    opts.migrations!['v9.1.js'] = GOOD_MIGRATION; // two-segment version — never discovered
    opts.migrations!['_helpers.js'] = "'use strict';\nmodule.exports = {};\n";
    const root = makeRepo(opts);
    try {
      const r = runGate(root);
      expect(r.status).toBe(1);
      const naming = findingsFor(r.json, 'naming');
      expect(naming).toHaveLength(1);
      expect(naming[0].file).toBe('migrations/v9.1.js');
      expect(naming[0].message).toMatch(/silently never run/);
      // _helpers.js is parse-checked but never a naming finding, and the
      // undiscoverable file gets no coverage findings (it has no version).
      const files = (r.json.findings as any[]).map((f) => f.file);
      expect(files).not.toContain('migrations/_helpers.js');
    } finally {
      rmrf(root);
    }
  });

  it('flags a dormant migration whose version exceeds FRAMEWORK_VERSION', () => {
    const opts = cleanOpts();
    opts.migrations!['v9.5.0.js'] = GOOD_MIGRATION;
    opts.testFile! += testRef('9.5.0');
    opts.changelog! += changelogRef('9.5.0');
    // frameworkVersion stays 9.0.0 — 9.5.0 can never run.
    const root = makeRepo(opts);
    try {
      const r = runGate(root);
      expect(r.status).toBe(1);
      const ceiling = findingsFor(r.json, 'version-ceiling');
      expect(ceiling).toHaveLength(1);
      expect(ceiling[0].version).toBe('9.5.0');
      expect(ceiling[0].message).toMatch(/dormant/);
    } finally {
      rmrf(root);
    }
  });

  it('fails closed when migrations/ is missing', () => {
    const root = makeRepo({ ...cleanOpts(), noMigrationsDir: true });
    try {
      const r = runGate(root);
      expect(r.status).toBe(1);
      const fc = findingsFor(r.json, 'fail-closed');
      expect(fc).toHaveLength(1);
      expect(fc[0].message).toMatch(/cannot read migrations/);
    } finally {
      rmrf(root);
    }
  });

  it('fails closed when tests/migrations.test.ts is missing', () => {
    const root = makeRepo({ ...cleanOpts(), testFile: null });
    try {
      const r = runGate(root);
      expect(r.status).toBe(1);
      const fc = findingsFor(r.json, 'fail-closed');
      expect(fc).toHaveLength(1);
      expect(fc[0].file).toBe('tests/migrations.test.ts');
    } finally {
      rmrf(root);
    }
  });

  it('fails closed when no changelog exists, and reads FRAMEWORK_VERSION problems as findings', () => {
    const root = makeRepo({ ...cleanOpts(), changelog: null, frameworkVersion: null });
    try {
      const r = runGate(root);
      expect(r.status).toBe(1);
      const fc = findingsFor(r.json, 'fail-closed');
      expect(fc).toHaveLength(1);
      expect(fc[0].message).toMatch(/no changelog found/);
      const ceiling = findingsFor(r.json, 'version-ceiling');
      expect(ceiling).toHaveLength(1);
      expect(ceiling[0].message).toMatch(/cannot read/);
    } finally {
      rmrf(root);
    }
  });

  it('human-readable mode prints grouped findings and a FAIL summary line', () => {
    const opts = cleanOpts();
    opts.testFile = '// nothing referenced\n';
    const root = makeRepo(opts);
    try {
      const res = spawnSync(process.execPath, [GATE, '--root', root], {
        encoding: 'utf8',
        timeout: 60000,
      });
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(/TEST COVERAGE \(tests\/migrations\.test\.ts\): 1 finding\(s\)/);
      expect(res.stdout).toMatch(/check-migrations: FAIL — 1 finding\(s\)/);
    } finally {
      rmrf(root);
    }
  });
});
