import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const FRAMEWORK_ROOT = path.resolve(__dirname, '../');
const SYNC_JS = path.join(FRAMEWORK_ROOT, 'sync.js');

function uuid() { return crypto.randomUUID(); }

function runSync(targetRoot: string, args: string[] = []): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('node', [SYNC_JS, ...args], {
    cwd: targetRoot,
    // GIT_DIR set to a non-existent path so git commands fail gracefully,
    // triggering synthetic-test mode in checkSubmoduleClean (returns clean=true).
    env: { ...process.env, GIT_DIR: '/nonexistent-for-test' },
    encoding: 'utf8',
    timeout: 30000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status ?? 1,
  };
}

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
    ...overrides,
  };
}

async function writeState(targetRoot: string, state: any): Promise<void> {
  await fsp.mkdir(path.join(targetRoot, '.claude'), { recursive: true });
  await fsp.writeFile(
    path.join(targetRoot, '.claude', '.framework-state.json'),
    JSON.stringify(state, null, 2) + '\n',
    'utf8'
  );
}

async function readState(targetRoot: string): Promise<any> {
  const content = await fsp.readFile(
    path.join(targetRoot, '.claude', '.framework-state.json'),
    'utf8'
  );
  return JSON.parse(content);
}

// ---------------------------------------------------------------------------
// Test 1: clean-file update flow updates changed files
// ---------------------------------------------------------------------------

test('e2e-sync: clean-file update flow updates changed files', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-sync-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // Phase 1: adopt to get real hashes
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    const adoptResult = runSync(tmpDir, ['--adopt']);
    assert.equal(adoptResult.status, 0, `--adopt failed: ${adoptResult.stderr}`);

    // Phase 2: downgrade state.frameworkVersion to simulate being on v2.1.0
    const state = await readState(tmpDir);
    state.frameworkVersion = '2.1.0';
    await writeState(tmpDir, state);

    // Phase 3: run sync — should update files
    const syncResult = runSync(tmpDir);
    assert.equal(syncResult.status, 0, `sync failed:\nstdout: ${syncResult.stdout}\nstderr: ${syncResult.stderr}`);
    assert.ok(
      syncResult.stdout.includes('status=updated') || syncResult.stdout.match(/\d+ updated/),
      `sync should have updated at least some files, got:\n${syncResult.stdout}`
    );

    // Phase 4: verify state.frameworkVersion is now 2.2.0
    const newState = await readState(tmpDir);
    assert.equal(newState.frameworkVersion, '2.2.0', 'state should be updated to 2.2.0');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2: idempotency — second sync run produces zero file writes
// ---------------------------------------------------------------------------

test('e2e-sync: idempotency — second sync run produces zero file writes', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-sync2-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // Run adopt to get on latest
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    const adoptResult = runSync(tmpDir, ['--adopt']);
    assert.equal(adoptResult.status, 0, `--adopt failed: ${adoptResult.stderr}`);

    // Run sync again — should be a no-op (already on 2.2.0)
    const syncResult = runSync(tmpDir);
    assert.equal(syncResult.status, 0, `second sync failed: ${syncResult.stderr}`);

    // Should say "already on latest"
    assert.ok(
      syncResult.stdout.includes('already on latest') || syncResult.stdout.match(/0 updated/),
      `Expected "already on latest" or "0 updated" but got: ${syncResult.stdout}`
    );

    // State should still be 2.2.0
    const newState = await readState(tmpDir);
    assert.equal(newState.frameworkVersion, '2.2.0', 'state should still be 2.2.0');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3: CRLF line endings produce no false customised signal
// ---------------------------------------------------------------------------

test('e2e-sync: CRLF line endings produce no false customised signal', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-crlf-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // Run adopt to get a real state
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    const adoptResult = runSync(tmpDir, ['--adopt']);
    assert.equal(adoptResult.status, 0, `--adopt failed: ${adoptResult.stderr}`);

    const state = await readState(tmpDir);
    // Pick one sync-mode file from state.files that is not settings
    const managedPaths = Object.keys(state.files).filter(p => !p.includes('settings'));
    assert.ok(managedPaths.length > 0, 'need at least one tracked file');
    const testPath = managedPaths[0];
    const fullPath = path.join(tmpDir, testPath);

    // Rewrite the file with CRLF endings
    const lf = await fsp.readFile(fullPath, 'utf8');
    const crlf = lf.split('\n').join('\r\n');
    await fsp.writeFile(fullPath, crlf, 'utf8');

    // Downgrade state to trigger a sync run
    state.frameworkVersion = '2.1.0';
    await writeState(tmpDir, state);

    // Run sync — the CRLF file should NOT be flagged as customised
    const syncResult = runSync(tmpDir);
    assert.equal(syncResult.status, 0, `sync failed: ${syncResult.stderr}`);

    // If the file were flagged as customised, a .framework-new would be written
    const frameworkNewPath = `${fullPath}.framework-new`;
    assert.ok(!fs.existsSync(frameworkNewPath),
      `CRLF file was incorrectly flagged as customised — .framework-new was written for ${testPath}`);

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
