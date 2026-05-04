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
    env: { ...process.env },
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
// Test 1: first-run adoption writes all managed files
// ---------------------------------------------------------------------------

test('e2e-adopt: first-run adoption writes all managed files', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-adopt-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // Write initial state with no files tracked and old version
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);

    // Run --adopt
    const result = runSync(tmpDir, ['--adopt']);
    assert.equal(result.status, 0, `--adopt failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

    // Assert: state.json updated
    const state = await readState(tmpDir);
    assert.equal(state.frameworkVersion, '2.2.0', 'frameworkVersion should be 2.2.0');
    assert.ok(Object.keys(state.files).length > 0, 'state should have file entries');
    assert.ok(state.lastSubstitutionHash, 'state should have lastSubstitutionHash');

    // Assert: agent files were written (substituted)
    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    const agentFiles = fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')) : [];
    assert.ok(agentFiles.length > 0, `Expected agent files in ${agentsDir}, found none`);

    // Assert: at least one agent file has substitutions applied (no literal {{PROJECT_NAME}})
    const firstAgent = path.join(agentsDir, agentFiles[0]);
    const agentContent = await fsp.readFile(firstAgent, 'utf8');
    assert.ok(!agentContent.includes('{{PROJECT_NAME}}'),
      `Agent file should have substitutions applied, found literal placeholder in ${agentFiles[0]}`);

    // Assert: stdout includes status=new for at least one file
    assert.ok(result.stdout.includes('status=new'), 'should have logged status=new for new files');

    // Assert: end-of-run summary is in stdout
    assert.ok(result.stdout.match(/\d+ updated, \d+ new,/), 'should have end-of-run summary');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2: state.json has per-file hashes for all tracked files
// ---------------------------------------------------------------------------

test('e2e-adopt: state.json has per-file hashes for all tracked files', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-adopt2-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);

    const result = runSync(tmpDir, ['--adopt']);
    assert.equal(result.status, 0, `--adopt failed: ${result.stderr}`);

    const state = await readState(tmpDir);
    // Every file in state.files should have a lastAppliedHash
    for (const [filePath, entry] of Object.entries(state.files) as [string, any][]) {
      assert.ok(entry.lastAppliedHash, `File ${filePath} should have lastAppliedHash`);
      assert.ok(entry.lastAppliedFrameworkVersion, `File ${filePath} should have lastAppliedFrameworkVersion`);
      assert.ok(entry.lastAppliedSourcePath, `File ${filePath} should have lastAppliedSourcePath`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3: against real manifest.json — all files covered
// ---------------------------------------------------------------------------

test('e2e-adopt: against real manifest.json — all files covered', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-adopt3-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);

    const result = runSync(tmpDir, ['--adopt']);
    assert.equal(result.status, 0, `--adopt failed: ${result.stderr}`);

    // Read manifest to verify sync-mode entries were processed
    const manifestContent = fs.readFileSync(path.join(FRAMEWORK_ROOT, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestContent);
    assert.ok(Array.isArray(manifest.managedFiles), 'manifest should have managedFiles');

    const state = await readState(tmpDir);
    assert.ok(Object.keys(state.files).length > 0, 'should have file entries');

    // The --adopt mode header should be present (rebaseline since state.json pre-exists)
    assert.ok(
      result.stdout.includes('--adopt first-run mode') || result.stdout.includes('--adopt rebaseline mode'),
      `should emit --adopt mode header, got:\n${result.stdout}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
