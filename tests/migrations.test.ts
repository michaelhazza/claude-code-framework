/**
 * Fixture-based tests for the migration infrastructure:
 *
 *   - scripts/run-migrations.js runner semantics (semver ordering, range
 *     filtering, downgrade refusal, per-migration state persistence,
 *     conflict-not-recorded retry semantics)
 *   - migrations/v2.30.0.js (idempotent `*.framework-new` .gitignore append)
 *
 * Harness shape follows tests/e2e-sync.test.ts: node:test + assert/strict,
 * temp dirs under os.tmpdir(), spawnSync against the real script.
 *
 * Runner tests use a FAKE framework root (temp dir with synthetic
 * migrations/v*.js fixtures plus a copy of the real run-migrations.js, since
 * the runner resolves frameworkRoot relative to its own location) and a temp
 * CONSUMER root carrying .claude/.framework-state.json.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const requireCjs = createRequire(__filename);

const FRAMEWORK_ROOT = path.resolve(__dirname, '../');
const RUN_MIGRATIONS_SRC = path.join(FRAMEWORK_ROOT, 'scripts', 'run-migrations.js');
const V2_30_0_SRC = path.join(FRAMEWORK_ROOT, 'migrations', 'v2.30.0.js');
const HELPERS_SRC = path.join(FRAMEWORK_ROOT, 'migrations', '_helpers.js');

function uuid() { return crypto.randomUUID(); }

function buildMinimalState(overrides: Partial<any> = {}): any {
  return {
    frameworkVersion: '2.1.0',
    adoptedAt: new Date().toISOString(),
    adoptedFromCommit: null,
    profile: 'STANDARD',
    substitutions: {
      PROJECT_NAME: 'Test Project',
      PROJECT_DESCRIPTION: 'a test project',
      STACK_DESCRIPTION: 'Node.js',
      COMPANY_NAME: 'Test Co',
    },
    lastSubstitutionHash: '',
    files: {},
    syncIgnore: [],
    appliedMigrations: [],
    ...overrides,
  };
}

/**
 * Create a fake framework root: synthetic migrations/v<version>.js files and
 * a verbatim copy of the real scripts/run-migrations.js (whose frameworkRoot
 * is `path.resolve(__dirname, '..')`, i.e. this fake root).
 */
async function makeFakeFramework(migrations: Record<string, string>): Promise<string> {
  const root = path.join(os.tmpdir(), `migr-fw-${uuid()}`);
  await fsp.mkdir(path.join(root, 'migrations'), { recursive: true });
  await fsp.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fsp.copyFile(RUN_MIGRATIONS_SRC, path.join(root, 'scripts', 'run-migrations.js'));
  for (const [version, source] of Object.entries(migrations)) {
    await fsp.writeFile(path.join(root, 'migrations', `v${version}.js`), source, 'utf8');
  }
  return root;
}

async function makeConsumer(state: any = buildMinimalState()): Promise<string> {
  const root = path.join(os.tmpdir(), `migr-consumer-${uuid()}`);
  await fsp.mkdir(path.join(root, '.claude'), { recursive: true });
  if (state) {
    await fsp.writeFile(
      path.join(root, '.claude', '.framework-state.json'),
      JSON.stringify(state, null, 2) + '\n',
      'utf8'
    );
  }
  return root;
}

async function readConsumerState(consumerRoot: string): Promise<any> {
  const content = await fsp.readFile(
    path.join(consumerRoot, '.claude', '.framework-state.json'),
    'utf8'
  );
  return JSON.parse(content);
}

function runMigrations(
  fakeFrameworkRoot: string,
  consumerRoot: string,
  fromVersion: string,
  toVersion: string
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(
    'node',
    [path.join(fakeFrameworkRoot, 'scripts', 'run-migrations.js'), consumerRoot, fromVersion, toVersion],
    { cwd: consumerRoot, encoding: 'utf8', timeout: 30000 }
  );
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status ?? 1,
  };
}

/** Migration fixture that appends its version to run-log.txt, then runs `body`. */
function loggingMigration(version: string, body = "return { status: 'applied', notes: [] };"): string {
  return [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    'async function migrate(ctx) {',
    `  fs.appendFileSync(path.join(ctx.consumerRoot, 'run-log.txt'), '${version}\\n', 'utf8');`,
    `  ${body}`,
    '}',
    'module.exports = { migrate };',
    '',
  ].join('\n');
}

function readRunLog(consumerRoot: string): string[] {
  try {
    return fs
      .readFileSync(path.join(consumerRoot, 'run-log.txt'), 'utf8')
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function rmrf(...dirs: string[]) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 1: semver ordering + range filtering
// ---------------------------------------------------------------------------

test('runner: executes migrations in semver order (not lexicographic) and respects the (from, to] range', async () => {
  // Lexicographic order would be 2.10.0 < 2.2.0 < 2.9.0 — semver must win.
  // v2.1.0 (== fromVersion) and v2.11.0 (> toVersion) must not run.
  const fw = await makeFakeFramework({
    '2.1.0': loggingMigration('2.1.0'),
    '2.10.0': loggingMigration('2.10.0'),
    '2.2.0': loggingMigration('2.2.0'),
    '2.9.0': loggingMigration('2.9.0'),
    '2.11.0': loggingMigration('2.11.0'),
  });
  const consumer = await makeConsumer();
  try {
    const result = runMigrations(fw, consumer, '2.1.0', '2.10.0');
    assert.equal(result.status, 0, `runner failed:\n${result.stdout}\n${result.stderr}`);

    assert.deepEqual(readRunLog(consumer), ['2.2.0', '2.9.0', '2.10.0']);

    const state = await readConsumerState(consumer);
    assert.deepEqual(state.appliedMigrations, ['2.2.0', '2.9.0', '2.10.0']);

    assert.match(result.stdout, /MIGRATIONS: 3 applied, 0 skipped, 0 conflict/);
  } finally {
    rmrf(fw, consumer);
  }
});

// ---------------------------------------------------------------------------
// Test 2: downgrade refusal
// ---------------------------------------------------------------------------

test('runner: refuses when fromVersion > toVersion (downgrade)', async () => {
  const fw = await makeFakeFramework({ '2.2.0': loggingMigration('2.2.0') });
  const consumer = await makeConsumer();
  try {
    const result = runMigrations(fw, consumer, '2.5.0', '2.1.0');
    assert.equal(result.status, 1, 'downgrade must exit non-zero');
    assert.match(result.stderr, /downgrades are not supported/);
    assert.deepEqual(readRunLog(consumer), [], 'no migration may run on a refused downgrade');
  } finally {
    rmrf(fw, consumer);
  }
});

// ---------------------------------------------------------------------------
// Test 3: state persistence per migration (mid-flight failure)
// ---------------------------------------------------------------------------

test('runner: persists appliedMigrations after EACH migration, so a mid-flight failure does not re-run earlier ones', async () => {
  const fw = await makeFakeFramework({
    '2.2.0': loggingMigration('2.2.0'),
    '2.3.0': loggingMigration('2.3.0', "throw new Error('boom');"),
  });
  const consumer = await makeConsumer();
  try {
    // First run: v2.2.0 applies, v2.3.0 throws — runner exits 1.
    const first = runMigrations(fw, consumer, '2.1.0', '2.3.0');
    assert.equal(first.status, 1, 'a thrown migration must fail the run');
    assert.match(first.stderr, /migration v2\.3\.0 threw/);

    const stateAfterFailure = await readConsumerState(consumer);
    assert.deepEqual(
      stateAfterFailure.appliedMigrations,
      ['2.2.0'],
      'the completed migration must be recorded even though a later one threw'
    );

    // Fix v2.3.0, re-run: only v2.3.0 executes — v2.2.0 must not re-run.
    await fsp.writeFile(path.join(fw, 'migrations', 'v2.3.0.js'), loggingMigration('2.3.0'), 'utf8');
    const second = runMigrations(fw, consumer, '2.1.0', '2.3.0');
    assert.equal(second.status, 0, `retry failed:\n${second.stdout}\n${second.stderr}`);

    const stateAfterRetry = await readConsumerState(consumer);
    assert.deepEqual(stateAfterRetry.appliedMigrations, ['2.2.0', '2.3.0']);
    // v2.2.0 once, v2.3.0 twice (first attempt logged before throwing).
    assert.deepEqual(readRunLog(consumer), ['2.2.0', '2.3.0', '2.3.0']);
  } finally {
    rmrf(fw, consumer);
  }
});

// ---------------------------------------------------------------------------
// Test 4: conflict is NOT recorded — the migration retries on the next run
// ---------------------------------------------------------------------------

test('runner: conflict status is not recorded in appliedMigrations and re-runs after the operator resolves it', async () => {
  // Returns 'conflict' until resolved-marker.txt exists in the consumer root
  // (stand-in for the operator merging a .framework-new file), then 'applied'.
  const conflictThenApplied = loggingMigration(
    '2.4.0',
    "if (!fs.existsSync(path.join(ctx.consumerRoot, 'resolved-marker.txt'))) { return { status: 'conflict', notes: ['unresolved local divergence'] }; } return { status: 'applied', notes: [] };"
  );
  const fw = await makeFakeFramework({ '2.4.0': conflictThenApplied });
  const consumer = await makeConsumer();
  try {
    // Run 1: conflict — exit 0 (ran-but-incomplete, not an error), unrecorded.
    const first = runMigrations(fw, consumer, '2.1.0', '2.4.0');
    assert.equal(first.status, 0, 'conflict must not fail the run');
    assert.match(first.stdout, /MIGRATION v2\.4\.0 status=conflict/);
    const stateAfterConflict = await readConsumerState(consumer);
    assert.deepEqual(stateAfterConflict.appliedMigrations, [], 'conflict must NOT be recorded');

    // Operator resolves; run 2: applied and recorded.
    await fsp.writeFile(path.join(consumer, 'resolved-marker.txt'), 'ok\n', 'utf8');
    const second = runMigrations(fw, consumer, '2.1.0', '2.4.0');
    assert.equal(second.status, 0);
    assert.match(second.stdout, /MIGRATION v2\.4\.0 status=applied/);
    const stateAfterResolve = await readConsumerState(consumer);
    assert.deepEqual(stateAfterResolve.appliedMigrations, ['2.4.0']);

    // Run 3: nothing pending — the migration must not run a third time.
    const third = runMigrations(fw, consumer, '2.1.0', '2.4.0');
    assert.equal(third.status, 0);
    assert.match(third.stdout, /no pending migrations/);
    assert.deepEqual(readRunLog(consumer), ['2.4.0', '2.4.0'], 'exactly two executions: conflict then applied');
  } finally {
    rmrf(fw, consumer);
  }
});

// ---------------------------------------------------------------------------
// Test 5: skipped status IS recorded (never re-runs)
// ---------------------------------------------------------------------------

test('runner: skipped status is recorded in appliedMigrations and never re-runs', async () => {
  const fw = await makeFakeFramework({
    '2.2.0': loggingMigration('2.2.0', "return { status: 'skipped', notes: ['nothing to do'] };"),
  });
  const consumer = await makeConsumer();
  try {
    const first = runMigrations(fw, consumer, '2.1.0', '2.2.0');
    assert.equal(first.status, 0);
    assert.match(first.stdout, /MIGRATION v2\.2\.0 status=skipped/);
    const state = await readConsumerState(consumer);
    assert.deepEqual(state.appliedMigrations, ['2.2.0'], 'skipped must be recorded as done');

    const second = runMigrations(fw, consumer, '2.1.0', '2.2.0');
    assert.equal(second.status, 0);
    assert.match(second.stdout, /no pending migrations/);
    assert.deepEqual(readRunLog(consumer), ['2.2.0'], 'a skipped migration must not run twice');
  } finally {
    rmrf(fw, consumer);
  }
});

// ---------------------------------------------------------------------------
// Test 6: v2.30.0 gitignore migration — fresh append
// ---------------------------------------------------------------------------

test('v2.30.0: appends *.framework-new to an existing .gitignore (status applied), preserving prior content', async () => {
  const { migrate } = requireCjs(V2_30_0_SRC);
  const consumer = await makeConsumer();
  try {
    // Note: no trailing newline — the append must insert a separator.
    await fsp.writeFile(path.join(consumer, '.gitignore'), 'node_modules/\ndist', 'utf8');

    const result = await migrate({
      consumerRoot: consumer,
      frameworkRoot: FRAMEWORK_ROOT,
      fromVersion: '2.29.0',
      toVersion: '2.30.0',
    });
    assert.equal(result.status, 'applied');
    assert.ok(Array.isArray(result.notes) && result.notes.length > 0);

    const content = await fsp.readFile(path.join(consumer, '.gitignore'), 'utf8');
    assert.equal(content, 'node_modules/\ndist\n*.framework-new\n');
  } finally {
    rmrf(consumer);
  }
});

// ---------------------------------------------------------------------------
// Test 7: v2.30.0 — idempotent re-run
// ---------------------------------------------------------------------------

test('v2.30.0: re-run is a no-op (status skipped, content unchanged)', async () => {
  const { migrate } = requireCjs(V2_30_0_SRC);
  const consumer = await makeConsumer();
  try {
    await fsp.writeFile(path.join(consumer, '.gitignore'), 'node_modules/\n', 'utf8');
    const ctx = {
      consumerRoot: consumer,
      frameworkRoot: FRAMEWORK_ROOT,
      fromVersion: '2.29.0',
      toVersion: '2.30.0',
    };

    const first = await migrate(ctx);
    assert.equal(first.status, 'applied');
    const afterFirst = await fsp.readFile(path.join(consumer, '.gitignore'), 'utf8');

    const second = await migrate(ctx);
    assert.equal(second.status, 'skipped');
    const afterSecond = await fsp.readFile(path.join(consumer, '.gitignore'), 'utf8');
    assert.equal(afterSecond, afterFirst, 're-run must not modify .gitignore');

    // An indented / whitespace-padded existing entry also counts as present.
    await fsp.writeFile(path.join(consumer, '.gitignore'), '  *.framework-new  \n', 'utf8');
    const third = await migrate(ctx);
    assert.equal(third.status, 'skipped');
  } finally {
    rmrf(consumer);
  }
});

// ---------------------------------------------------------------------------
// Test 8: v2.30.0 — missing .gitignore is created
// ---------------------------------------------------------------------------

test('v2.30.0: creates .gitignore when absent (status applied)', async () => {
  const { migrate } = requireCjs(V2_30_0_SRC);
  const consumer = await makeConsumer();
  try {
    assert.equal(fs.existsSync(path.join(consumer, '.gitignore')), false);

    const result = await migrate({
      consumerRoot: consumer,
      frameworkRoot: FRAMEWORK_ROOT,
      fromVersion: '2.29.0',
      toVersion: '2.30.0',
    });
    assert.equal(result.status, 'applied');

    const content = await fsp.readFile(path.join(consumer, '.gitignore'), 'utf8');
    assert.equal(content, '*.framework-new\n');
  } finally {
    rmrf(consumer);
  }
});

// ---------------------------------------------------------------------------
// Test 9: v2.30.0 end-to-end through the runner (discovery + _helpers resolution)
// ---------------------------------------------------------------------------

test('v2.30.0: runs through run-migrations.js discovery with _helpers resolving from the framework migrations dir', async () => {
  const fw = await makeFakeFramework({});
  const consumer = await makeConsumer();
  try {
    // Copy the REAL migration + helpers into the fake framework, proving the
    // relative require('./_helpers') resolves inside migrations/.
    await fsp.copyFile(V2_30_0_SRC, path.join(fw, 'migrations', 'v2.30.0.js'));
    await fsp.copyFile(HELPERS_SRC, path.join(fw, 'migrations', '_helpers.js'));

    const result = runMigrations(fw, consumer, '2.29.0', '2.30.0');
    assert.equal(result.status, 0, `runner failed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /MIGRATION v2\.30\.0 status=applied/);

    const content = await fsp.readFile(path.join(consumer, '.gitignore'), 'utf8');
    assert.equal(content, '*.framework-new\n');

    const state = await readConsumerState(consumer);
    assert.deepEqual(state.appliedMigrations, ['2.30.0']);

    // _helpers.js / _template.js must never be discovered as migrations.
    assert.ok(!result.stdout.includes('_helpers'), 'underscore-prefixed files must not be discovered');
  } finally {
    rmrf(fw, consumer);
  }
});
