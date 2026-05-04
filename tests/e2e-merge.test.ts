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
// Test 1: customised file gets .framework-new, target untouched
// ---------------------------------------------------------------------------

test('e2e-merge: customised file gets .framework-new, target untouched', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-merge-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // Set up via --adopt
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    const adoptResult = runSync(tmpDir, ['--adopt']);
    assert.equal(adoptResult.status, 0, `--adopt failed: ${adoptResult.stderr}`);

    // Pick a sync-mode agent file to "customise"
    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
    assert.ok(agentFiles.length > 0, 'need agent files');
    const testFile = agentFiles[0];
    const testPath = `.claude/agents/${testFile}`;
    const fullPath = path.join(tmpDir, testPath);

    // Record original content
    const originalContent = await fsp.readFile(fullPath, 'utf8');

    // "Customise" the file (append a project-specific note)
    const customisedContent = originalContent + '\n<!-- PROJECT-SPECIFIC CUSTOMISATION -->\n';
    await fsp.writeFile(fullPath, customisedContent, 'utf8');

    // Downgrade state to trigger sync
    const state = await readState(tmpDir);
    state.frameworkVersion = '2.1.0';
    await writeState(tmpDir, state);

    // Run sync
    const syncResult = runSync(tmpDir);
    assert.equal(syncResult.status, 0, `sync failed: ${syncResult.stderr}`);

    // Assert: target file unchanged (still has customisation)
    const afterSyncContent = await fsp.readFile(fullPath, 'utf8');
    assert.ok(afterSyncContent.includes('PROJECT-SPECIFIC CUSTOMISATION'),
      'customised content should be preserved in target file');

    // Assert: .framework-new was written
    const newFilePath = `${fullPath}.framework-new`;
    assert.ok(fs.existsSync(newFilePath), `.framework-new should exist at ${newFilePath}`);

    // Assert: state marks customisedLocally = true
    const newState = await readState(tmpDir);
    assert.equal(newState.files[testPath]?.customisedLocally, true,
      'state should mark file as customisedLocally');

    // Assert: status=customised in stdout
    assert.ok(syncResult.stdout.includes('status=customised'), 'should log status=customised');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2: startup check blocks next sync when .framework-new unresolved
// ---------------------------------------------------------------------------

test('e2e-merge: startup check blocks next sync when .framework-new unresolved', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-merge2-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // Set up and adopt
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    const adoptResult = runSync(tmpDir, ['--adopt']);
    assert.equal(adoptResult.status, 0, `--adopt failed: ${adoptResult.stderr}`);

    // Pick a file to customise
    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    const testFile = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'))[0];
    const fullPath = path.join(agentsDir, testFile);
    const original = await fsp.readFile(fullPath, 'utf8');
    await fsp.writeFile(fullPath, original + '\n<!-- CUSTOM -->\n', 'utf8');

    // Downgrade state to trigger sync (creates .framework-new)
    const state = await readState(tmpDir);
    state.frameworkVersion = '2.1.0';
    await writeState(tmpDir, state);

    // First sync creates .framework-new and updates state.frameworkVersion to 2.2.0
    runSync(tmpDir);
    const newFilePath = `${fullPath}.framework-new`;
    assert.ok(fs.existsSync(newFilePath), '.framework-new should exist');

    // Downgrade state.frameworkVersion again so the "already on latest" short-circuit
    // does not fire before the unresolved-merge scan
    const stateAfterFirstSync = await readState(tmpDir);
    stateAfterFirstSync.frameworkVersion = '2.1.0';
    await writeState(tmpDir, stateAfterFirstSync);

    // Next sync without --force should exit 1 (unresolved merge)
    const blockedResult = runSync(tmpDir);
    assert.equal(blockedResult.status, 1, 'sync should exit 1 when .framework-new unresolved');
    assert.ok(blockedResult.stderr.includes('unresolved'), 'stderr should mention unresolved');

    // With --force should proceed
    const forcedResult = runSync(tmpDir, ['--force']);
    assert.equal(forcedResult.status, 0, `--force sync should proceed: ${forcedResult.stderr}`);

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3: after manual merge + re-run sync, --doctor detects case(b)
// ---------------------------------------------------------------------------

test('e2e-merge: after manual merge + re-run sync, --doctor detects case(b)', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-merge3-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // Set up, customise, run sync (creates .framework-new)
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    runSync(tmpDir, ['--adopt']);

    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    const testFile = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'))[0];
    const testPath = `.claude/agents/${testFile}`;
    const fullPath = path.join(agentsDir, testFile);
    const original = await fsp.readFile(fullPath, 'utf8');
    await fsp.writeFile(fullPath, original + '\n<!-- CUSTOM -->\n', 'utf8');

    // Downgrade state so sync runs and detects customisation
    const state = await readState(tmpDir);
    state.frameworkVersion = '2.1.0';
    await writeState(tmpDir, state);
    runSync(tmpDir); // creates .framework-new

    const newFilePath = `${fullPath}.framework-new`;
    assert.ok(fs.existsSync(newFilePath), '.framework-new should exist');

    // Simulate operator manual merge: write merged content to target, delete .framework-new
    const mergedContent = original + '\n<!-- CUSTOM KEPT -->\n';
    await fsp.writeFile(fullPath, mergedContent, 'utf8');
    await fsp.unlink(newFilePath);

    // Run --doctor: should detect case(b) (hash mismatch, no .framework-new)
    const doctorResult = runSync(tmpDir, ['--doctor']);
    assert.equal(doctorResult.status, 1, 'doctor should report anomaly');
    assert.ok(doctorResult.stderr.includes('case(b)'), 'doctor should report case(b)');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
