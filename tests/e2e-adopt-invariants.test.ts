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

function runSync(targetRoot: string, args: string[] = []): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('node', [SYNC_JS, ...args], {
    cwd: targetRoot,
    env: { ...process.env, GIT_DIR: '/nonexistent-for-test' },
    encoding: 'utf8',
    timeout: 30000,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status ?? 1 };
}

function buildMinimalState(overrides: Partial<any> = {}): any {
  return {
    frameworkVersion: '2.1.0',
    adoptedAt: new Date().toISOString(),
    adoptedFromCommit: null,
    profile: 'STANDARD',
    substitutions: { PROJECT_NAME: 'Test Project', PROJECT_DESCRIPTION: 'a test', STACK_DESCRIPTION: 'Node', COMPANY_NAME: 'Test Co' },
    lastSubstitutionHash: '',
    files: {},
    syncIgnore: [],
    ...overrides,
  };
}

async function writeState(targetRoot: string, state: any): Promise<void> {
  await fsp.mkdir(path.join(targetRoot, '.claude'), { recursive: true });
  await fsp.writeFile(path.join(targetRoot, '.claude', '.framework-state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function readState(targetRoot: string): Promise<any> {
  return JSON.parse(await fsp.readFile(path.join(targetRoot, '.claude', '.framework-state.json'), 'utf8'));
}

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full));
    else results.push(full);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Test 1: --adopt against pre-existing files does not write .framework-new
// ---------------------------------------------------------------------------

test('--adopt with pre-existing files: catalogues without writing .framework-new', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-adopt-preexist-${crypto.randomUUID()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // First --adopt to populate the target with all files
    const state0 = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, state0);
    const r1 = runSync(tmpDir, ['--adopt']);
    assert.equal(r1.status, 0, `first --adopt failed: ${r1.stderr}`);

    // Delete state.json to simulate "pre-existing files but no state"
    await fsp.unlink(path.join(tmpDir, '.claude', '.framework-state.json'));

    // Re-write a fresh state with empty files map
    const state1 = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, state1);

    // Run --adopt again against files that are already in place
    const r2 = runSync(tmpDir, ['--adopt']);
    assert.equal(r2.status, 0, `second --adopt failed:\nstdout: ${r2.stdout}\nstderr: ${r2.stderr}`);

    // Assert: no .framework-new files were created anywhere in tmpDir
    const allFiles = walkFiles(tmpDir);
    const frameworkNewFiles = allFiles.filter(f => f.endsWith('.framework-new'));
    assert.equal(
      frameworkNewFiles.length,
      0,
      `.framework-new files were written (should not in --adopt pre-existing mode):\n${frameworkNewFiles.join('\n')}`
    );

    // Assert: state.files has entries for managed files
    const state = await readState(tmpDir);
    assert.ok(Object.keys(state.files).length > 0, 'state.files should have entries after second --adopt');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2: adopt-only files are skipped by subsequent regular sync
// ---------------------------------------------------------------------------

test('adopt-only files are untouched by subsequent regular sync', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-adopt-only-${crypto.randomUUID()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // Run --adopt to populate all files
    const state0 = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, state0);
    const r1 = runSync(tmpDir, ['--adopt']);
    assert.equal(r1.status, 0, `--adopt failed:\nstdout: ${r1.stdout}\nstderr: ${r1.stderr}`);

    // Manually edit one adopt-only file to simulate project customisation
    const adoptOnlyPath = path.join(tmpDir, 'docs', 'doc-sync.md');
    if (fs.existsSync(adoptOnlyPath)) {
      const content = await fsp.readFile(adoptOnlyPath, 'utf8');
      await fsp.writeFile(adoptOnlyPath, content + '\n<!-- PROJECT ROW -->\n', 'utf8');
    }

    // Downgrade frameworkVersion in state so sync is not a no-op (not "already on latest")
    const state = await readState(tmpDir);
    state.frameworkVersion = '2.1.0';
    await writeState(tmpDir, state);

    // Run a regular sync (not --adopt)
    const r2 = runSync(tmpDir);
    assert.equal(r2.status, 0, `regular sync failed:\nstdout: ${r2.stdout}\nstderr: ${r2.stderr}`);

    // Assert: no .framework-new files were created for adopt-only files
    const adoptOnlyPaths = [
      'docs/doc-sync.md',
      'docs/spec-context.md',
      'docs/frontend-design-examples.md',
      'references/verification-commands.md',
    ];
    for (const ap of adoptOnlyPaths) {
      const newFilePath = path.join(tmpDir, ap + '.framework-new');
      if (fs.existsSync(path.join(tmpDir, ap))) {
        assert.ok(
          !fs.existsSync(newFilePath),
          `adopt-only file ${ap} should not get a .framework-new but one was written`
        );
      }
    }

    // Assert: the customised adopt-only file (doc-sync.md) has its customisation intact
    if (fs.existsSync(adoptOnlyPath)) {
      const afterContent = await fsp.readFile(adoptOnlyPath, 'utf8');
      assert.ok(afterContent.includes('PROJECT ROW'), 'adopt-only file customisation should be preserved by regular sync');
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
