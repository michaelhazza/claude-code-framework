import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const {
  normaliseContent,
  hashContent,
  compareSemver,
  writeManagedFileAtomic,
  writeUpdated,
  writeFrameworkNew,
  writeNewFile,
  classifyFile,
  scanForUnresolvedMerges,
} = require('../sync.js');

const FRAMEWORK_ROOT = path.resolve(__dirname, '../');
const SYNC_JS = path.join(FRAMEWORK_ROOT, 'sync.js');
const CANONICAL_VERSION = fs
  .readFileSync(path.join(FRAMEWORK_ROOT, '.claude', 'FRAMEWORK_VERSION'), 'utf8')
  .trim();

function uuid() { return crypto.randomUUID(); }

async function makeTmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), `sync-hard-${uuid().slice(0, 8)}-`));
}

function runSync(targetRoot: string, args: string[] = []): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('node', [SYNC_JS, ...args], {
    cwd: targetRoot,
    // GIT_DIR set to a non-existent path so git commands fail gracefully,
    // triggering synthetic-test mode in checkSubmoduleClean (returns clean=true).
    env: { ...process.env, GIT_DIR: '/nonexistent-for-test' },
    encoding: 'utf8',
    timeout: 60000,
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

function makeCtx(overrides: Record<string, unknown> = {}): any {
  return {
    targetRoot: os.tmpdir(),
    frameworkRoot: os.tmpdir(),
    manifest: { managedFiles: [], removedFiles: [], doNotTouch: [], frameworkVersion: '2.30.0' },
    state: null,
    frameworkVersion: '2.30.0',
    frameworkCommit: 'abc123',
    flags: { adopt: false, dryRun: false, check: false, strict: false, doctor: false, force: false, forceDowngrade: false },
    ...overrides,
  };
}

function buildStateWithFile(relPath: string, fileOverrides: Partial<any> = {}, stateOverrides: Partial<any> = {}): any {
  return {
    frameworkVersion: '2.30.0',
    adoptedAt: '2026-01-01T00:00:00.000Z',
    adoptedFromCommit: null,
    profile: 'STANDARD',
    substitutions: {},
    files: {
      [relPath]: {
        lastAppliedHash: 'deadbeef0000000000000000000000000000000000000000000000000000dead',
        lastAppliedFrameworkVersion: '2.25.0',
        lastAppliedFrameworkCommit: null,
        lastAppliedSourcePath: relPath,
        customisedLocally: true,
        ...fileOverrides,
      },
    },
    syncIgnore: [],
    ...stateOverrides,
  };
}

async function noTmpResidue(dir: string): Promise<void> {
  const entries = await fsp.readdir(dir);
  const tmpFiles = entries.filter(e => e.endsWith('.tmp'));
  assert.deepEqual(tmpFiles, [], `expected no .tmp residue in ${dir}, found: ${tmpFiles.join(', ')}`);
}

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

describe('compareSemver', () => {
  test('orders versions numerically, not lexicographically', () => {
    assert.equal(compareSemver('2.30.0', '2.25.0'), 1);
    assert.equal(compareSemver('2.25.0', '2.30.0'), -1);
    assert.equal(compareSemver('2.30.0', '2.30.0'), 0);
    assert.equal(compareSemver('2.4.10', '2.4.9'), 1);
    assert.equal(compareSemver('10.0.0', '9.9.9'), 1);
  });
});

// ---------------------------------------------------------------------------
// Fix 1a: false-conflict short-circuit — classifyFile
// ---------------------------------------------------------------------------

describe('classifyFile — false-conflict short-circuit', () => {
  test('byte-identical target with stale state baseline classifies as clean, not customised', async () => {
    const frameworkDir = await makeTmpDir();
    const targetDir = await makeTmpDir();
    try {
      const relPath = 'agent.md';
      const content = '# Shared Agent\n\nSame bytes on both sides.\n';
      await fsp.writeFile(path.join(frameworkDir, relPath), content, 'utf8');
      await fsp.writeFile(path.join(targetDir, relPath), content, 'utf8');

      // Stale baseline: wrong hash, customisedLocally stuck true, old version —
      // the exact shape observed in the audit (lastAppliedFrameworkVersion 2.25.0).
      const state = buildStateWithFile(relPath);
      const ctx = makeCtx({ frameworkRoot: frameworkDir, targetRoot: targetDir, state });
      const entry = { path: relPath, category: 'agent', mode: 'sync', substituteAt: 'never' };

      const result = classifyFile(ctx, entry, relPath);
      assert.deepEqual(result, { kind: 'clean', needsUpdate: true });
    } finally {
      await fsp.rm(frameworkDir, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });

  test('genuinely divergent target still classifies as customised', async () => {
    const frameworkDir = await makeTmpDir();
    const targetDir = await makeTmpDir();
    try {
      const relPath = 'agent.md';
      await fsp.writeFile(path.join(frameworkDir, relPath), '# Framework Agent\n', 'utf8');
      await fsp.writeFile(path.join(targetDir, relPath), '# Operator Edited Agent\n', 'utf8');

      const state = buildStateWithFile(relPath);
      const ctx = makeCtx({ frameworkRoot: frameworkDir, targetRoot: targetDir, state });
      const entry = { path: relPath, category: 'agent', mode: 'sync', substituteAt: 'never' };

      const result = classifyFile(ctx, entry, relPath);
      assert.deepEqual(result, { kind: 'customised' });
    } finally {
      await fsp.rm(frameworkDir, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });

  test('self-heals a stale customisedLocally flag when hash matches baseline at current version', async () => {
    const frameworkDir = await makeTmpDir();
    const targetDir = await makeTmpDir();
    try {
      const relPath = 'agent.md';
      const content = '# Agent\n';
      await fsp.writeFile(path.join(frameworkDir, relPath), content, 'utf8');
      await fsp.writeFile(path.join(targetDir, relPath), content, 'utf8');

      const realHash = hashContent(normaliseContent(content));
      const state = buildStateWithFile(relPath, {
        lastAppliedHash: realHash,
        lastAppliedFrameworkVersion: '2.30.0',
        customisedLocally: true, // stale flag — hash and version are current
      });
      const ctx = makeCtx({ frameworkRoot: frameworkDir, targetRoot: targetDir, state });
      const entry = { path: relPath, category: 'agent', mode: 'sync', substituteAt: 'never' };

      // Must route through writeUpdated (clean/needsUpdate) so the flag clears,
      // instead of skipping with the stale flag left in place.
      const result = classifyFile(ctx, entry, relPath);
      assert.deepEqual(result, { kind: 'clean', needsUpdate: true });
    } finally {
      await fsp.rm(frameworkDir, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 1b: false-conflict short-circuit — writeFrameworkNew (defence in depth)
// ---------------------------------------------------------------------------

describe('writeFrameworkNew — false-conflict short-circuit', () => {
  test('identical content refreshes state and writes no .framework-new', async () => {
    const frameworkDir = await makeTmpDir();
    const targetDir = await makeTmpDir();
    try {
      const relPath = 'agent.md';
      const content = '# Same Agent\n';
      await fsp.writeFile(path.join(frameworkDir, relPath), content, 'utf8');
      await fsp.writeFile(path.join(targetDir, relPath), content, 'utf8');

      const state = buildStateWithFile(relPath);
      const entry = { path: relPath, category: 'agent', mode: 'sync', substituteAt: 'never' };

      let captured = '';
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: any) => { captured += chunk; return true; };
      let op;
      try {
        op = await writeFrameworkNew(
          makeCtx({ frameworkRoot: frameworkDir, targetRoot: targetDir, state }),
          entry,
          relPath
        );
      } finally {
        process.stdout.write = originalWrite;
      }

      assert.equal(op, 'rebaselined');
      assert.ok(captured.includes('status=rebaselined'), `Expected status=rebaselined, got: ${captured}`);
      assert.ok(!fs.existsSync(path.join(targetDir, `${relPath}.framework-new`)),
        'no .framework-new should be written for identical content');
      assert.equal(state.files[relPath].customisedLocally, false, 'customisedLocally should self-heal to false');
      assert.equal(state.files[relPath].lastAppliedHash, hashContent(normaliseContent(content)),
        'lastAppliedHash should be refreshed to the real content hash');
      assert.equal(state.files[relPath].lastAppliedFrameworkVersion, '2.30.0');
    } finally {
      await fsp.rm(frameworkDir, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });

  test('divergent content still writes .framework-new and flags customisedLocally', async () => {
    const frameworkDir = await makeTmpDir();
    const targetDir = await makeTmpDir();
    try {
      const relPath = 'agent.md';
      await fsp.writeFile(path.join(frameworkDir, relPath), '# Framework Agent\n', 'utf8');
      await fsp.writeFile(path.join(targetDir, relPath), '# Customised Agent\n', 'utf8');

      const state = buildStateWithFile(relPath, { customisedLocally: false });
      const entry = { path: relPath, category: 'agent', mode: 'sync', substituteAt: 'never' };

      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      let op;
      try {
        op = await writeFrameworkNew(
          makeCtx({ frameworkRoot: frameworkDir, targetRoot: targetDir, state }),
          entry,
          relPath
        );
      } finally {
        process.stdout.write = originalWrite;
      }

      assert.equal(op, 'customised');
      assert.ok(fs.existsSync(path.join(targetDir, `${relPath}.framework-new`)));
      assert.equal(state.files[relPath].customisedLocally, true);
    } finally {
      await fsp.rm(frameworkDir, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 1 (e2e): stale state baseline over a byte-identical file self-heals
// ---------------------------------------------------------------------------

test('e2e: byte-identical file with stale state baseline syncs clean and self-heals state', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-hard-e2e1-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    const adoptResult = runSync(tmpDir, ['--adopt']);
    assert.equal(adoptResult.status, 0, `--adopt failed: ${adoptResult.stderr}`);

    // Pick a sync-mode file (agents are sync-mode) and corrupt its state entry
    // into the audited shape: stale hash, customisedLocally:true, old version.
    const state = await readState(tmpDir);
    const testPath = Object.keys(state.files).find(p => p.startsWith('.claude/agents/'));
    assert.ok(testPath, 'need at least one tracked agent file');
    const realHash = state.files[testPath!].lastAppliedHash;
    state.frameworkVersion = '2.25.0';
    state.files[testPath!].lastAppliedHash = 'deadbeef0000000000000000000000000000000000000000000000000000dead';
    state.files[testPath!].lastAppliedFrameworkVersion = '2.25.0';
    state.files[testPath!].customisedLocally = true;
    await writeState(tmpDir, state);

    const syncResult = runSync(tmpDir);
    assert.equal(syncResult.status, 0, `sync failed: ${syncResult.stderr}`);

    const fullPath = path.join(tmpDir, testPath!);
    assert.ok(!fs.existsSync(`${fullPath}.framework-new`),
      `byte-identical file was flagged as a conflict — .framework-new written for ${testPath}`);

    const stateAfter = await readState(tmpDir);
    assert.equal(stateAfter.files[testPath!].customisedLocally, false, 'customisedLocally should self-heal');
    assert.equal(stateAfter.files[testPath!].lastAppliedHash, realHash, 'lastAppliedHash should be refreshed');
    assert.equal(stateAfter.files[testPath!].lastAppliedFrameworkVersion, CANONICAL_VERSION);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fix 1 (e2e): stale customisedLocally flag clears on a maintenance run
// ---------------------------------------------------------------------------

test('e2e: maintenance run clears a stale customisedLocally flag when content matches baseline', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-hard-e2e2-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    const adoptResult = runSync(tmpDir, ['--adopt']);
    assert.equal(adoptResult.status, 0, `--adopt failed: ${adoptResult.stderr}`);

    // Same version, correct hash — only the flag is stale.
    const state = await readState(tmpDir);
    const testPath = Object.keys(state.files).find(p => p.startsWith('.claude/agents/'));
    assert.ok(testPath, 'need at least one tracked agent file');
    state.files[testPath!].customisedLocally = true;
    await writeState(tmpDir, state);

    const syncResult = runSync(tmpDir);
    assert.equal(syncResult.status, 0, `maintenance sync failed: ${syncResult.stderr}`);

    const fullPath = path.join(tmpDir, testPath!);
    assert.ok(!fs.existsSync(`${fullPath}.framework-new`), 'no .framework-new for a clean file');

    const stateAfter = await readState(tmpDir);
    assert.equal(stateAfter.files[testPath!].customisedLocally, false,
      'stale customisedLocally flag should be cleared on the next sync');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fix 2: atomic managed writes
// ---------------------------------------------------------------------------

describe('writeManagedFileAtomic', () => {
  test('content lands complete and no tmp file is left behind on success', async () => {
    const dir = await makeTmpDir();
    try {
      const dst = path.join(dir, 'managed.md');
      const content = '# Managed\n\nfull content body\n';
      await writeManagedFileAtomic(dst, content);
      assert.equal(await fsp.readFile(dst, 'utf8'), content);
      await noTmpResidue(dir);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('overwrites an existing file atomically', async () => {
    const dir = await makeTmpDir();
    try {
      const dst = path.join(dir, 'managed.md');
      await fsp.writeFile(dst, 'old content\n', 'utf8');
      await writeManagedFileAtomic(dst, 'new content\n');
      assert.equal(await fsp.readFile(dst, 'utf8'), 'new content\n');
      await noTmpResidue(dir);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('cleans up the tmp file when the rename fails (destination is a directory)', async () => {
    const dir = await makeTmpDir();
    try {
      // A directory at the destination makes the rename step fail after the
      // tmp file has been written — the failure path must unlink the tmp.
      const dst = path.join(dir, 'managed.md');
      await fsp.mkdir(dst);
      await assert.rejects(() => writeManagedFileAtomic(dst, 'content\n'));
      assert.ok((await fsp.stat(dst)).isDirectory(), 'destination directory should be untouched');
      await noTmpResidue(dir);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('fails without residue when the parent directory is missing', async () => {
    const dir = await makeTmpDir();
    try {
      const dst = path.join(dir, 'no-such-dir', 'managed.md');
      await assert.rejects(() => writeManagedFileAtomic(dst, 'content\n'));
      assert.ok(!fs.existsSync(dst), 'no partial file should exist');
      await noTmpResidue(dir);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 6: symlink guard
// ---------------------------------------------------------------------------

describe('symlink guard', () => {
  test('writeManagedFileAtomic refuses to write through a symlink', async (t) => {
    const dir = await makeTmpDir();
    try {
      const victim = path.join(dir, 'victim.md');
      await fsp.writeFile(victim, 'victim content\n', 'utf8');
      const link = path.join(dir, 'link.md');
      try {
        await fsp.symlink(victim, link, 'file');
      } catch {
        t.skip('symlink creation not permitted on this platform');
        return;
      }

      await assert.rejects(
        () => writeManagedFileAtomic(link, 'attacker content\n'),
        /symlink/,
        'write through a symlink must be refused'
      );
      assert.equal(await fsp.readFile(victim, 'utf8'), 'victim content\n', 'victim must be untouched');
      assert.equal(await fsp.readlink(link), victim, 'the symlink itself must be untouched');
      await noTmpResidue(dir);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('writeUpdated refuses when the managed target is a symlink', async (t) => {
    const frameworkDir = await makeTmpDir();
    const targetDir = await makeTmpDir();
    try {
      const relPath = 'agent.md';
      await fsp.writeFile(path.join(frameworkDir, relPath), '# Framework Agent\n', 'utf8');
      const victim = path.join(targetDir, 'victim.md');
      await fsp.writeFile(victim, 'victim content\n', 'utf8');
      try {
        await fsp.symlink(victim, path.join(targetDir, relPath), 'file');
      } catch {
        t.skip('symlink creation not permitted on this platform');
        return;
      }

      const state = buildStateWithFile(relPath, { customisedLocally: false });
      const entry = { path: relPath, category: 'agent', mode: 'sync', substituteAt: 'never' };

      await assert.rejects(
        () => writeUpdated(
          makeCtx({ frameworkRoot: frameworkDir, targetRoot: targetDir, state }),
          entry,
          relPath
        ),
        /symlink/
      );
      assert.equal(await fsp.readFile(victim, 'utf8'), 'victim content\n', 'victim must be untouched');
    } finally {
      await fsp.rm(frameworkDir, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 3: --adopt compares to framework content
// ---------------------------------------------------------------------------

describe('writeNewFile — adopt divergence detection', () => {
  test('adopt flags a divergent pre-existing file and writes .framework-new', async () => {
    const frameworkDir = await makeTmpDir();
    const targetDir = await makeTmpDir();
    try {
      const relPath = 'agent.md';
      await fsp.writeFile(path.join(frameworkDir, relPath), '# Framework Agent\n', 'utf8');
      await fsp.writeFile(path.join(targetDir, relPath), '# Locally Customised Agent\n', 'utf8');

      const state: any = buildStateWithFile('unrelated.md');
      state.files = {}; // no entry for relPath — adopt path
      const entry = { path: relPath, category: 'agent', mode: 'sync', substituteAt: 'never' };

      let captured = '';
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: any) => { captured += chunk; return true; };
      let op;
      try {
        op = await writeNewFile(
          makeCtx({
            frameworkRoot: frameworkDir, targetRoot: targetDir, state,
            flags: { adopt: true, dryRun: false, check: false, strict: false, doctor: false, force: false, forceDowngrade: false },
          }),
          entry,
          relPath
        );
      } finally {
        process.stdout.write = originalWrite;
      }

      assert.equal(op, 'customised');
      assert.ok(captured.includes('status=customised'), `Expected status=customised, got: ${captured}`);
      assert.ok(captured.includes('reason=adopted-divergent'), `Expected reason=adopted-divergent, got: ${captured}`);
      assert.equal(state.files[relPath].customisedLocally, true, 'divergent adopted file must be flagged');
      const newFilePath = path.join(targetDir, `${relPath}.framework-new`);
      assert.ok(fs.existsSync(newFilePath), '.framework-new sibling must be written for the divergence');
      const sibling = await fsp.readFile(newFilePath, 'utf8');
      assert.ok(sibling.includes('Framework Agent'), '.framework-new must carry the framework copy');
      // Target untouched, baseline records the on-disk content
      assert.equal(await fsp.readFile(path.join(targetDir, relPath), 'utf8'), '# Locally Customised Agent\n');
      assert.equal(state.files[relPath].lastAppliedHash,
        hashContent(normaliseContent('# Locally Customised Agent\n')));
    } finally {
      await fsp.rm(frameworkDir, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });

  test('adopt catalogues an identical pre-existing file as clean (unchanged behaviour)', async () => {
    const frameworkDir = await makeTmpDir();
    const targetDir = await makeTmpDir();
    try {
      const relPath = 'agent.md';
      const content = '# Same Agent\n';
      await fsp.writeFile(path.join(frameworkDir, relPath), content, 'utf8');
      await fsp.writeFile(path.join(targetDir, relPath), content, 'utf8');

      const state: any = buildStateWithFile('unrelated.md');
      state.files = {};
      const entry = { path: relPath, category: 'agent', mode: 'sync', substituteAt: 'never' };

      let captured = '';
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: any) => { captured += chunk; return true; };
      let op;
      try {
        op = await writeNewFile(
          makeCtx({
            frameworkRoot: frameworkDir, targetRoot: targetDir, state,
            flags: { adopt: true, dryRun: false, check: false, strict: false, doctor: false, force: false, forceDowngrade: false },
          }),
          entry,
          relPath
        );
      } finally {
        process.stdout.write = originalWrite;
      }

      assert.equal(op, 'new');
      assert.ok(captured.includes('reason=catalogued-existing'), `Expected reason=catalogued-existing, got: ${captured}`);
      assert.equal(state.files[relPath].customisedLocally, false);
      assert.ok(!fs.existsSync(path.join(targetDir, `${relPath}.framework-new`)),
        'no .framework-new for identical adopted content');
    } finally {
      await fsp.rm(frameworkDir, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });

  test('adopt never flags divergent adopt-only files (project owns them)', async () => {
    const frameworkDir = await makeTmpDir();
    const targetDir = await makeTmpDir();
    try {
      const relPath = 'docs/doc-sync.md';
      await fsp.mkdir(path.join(frameworkDir, 'docs'), { recursive: true });
      await fsp.mkdir(path.join(targetDir, 'docs'), { recursive: true });
      await fsp.writeFile(path.join(frameworkDir, relPath), '# Framework Doc\n', 'utf8');
      await fsp.writeFile(path.join(targetDir, relPath), '# Project-Owned Doc\n', 'utf8');

      const state: any = buildStateWithFile('unrelated.md');
      state.files = {};
      const entry = { path: relPath, category: 'reference', mode: 'adopt-only', substituteAt: 'never' };

      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      let op;
      try {
        op = await writeNewFile(
          makeCtx({
            frameworkRoot: frameworkDir, targetRoot: targetDir, state,
            flags: { adopt: true, dryRun: false, check: false, strict: false, doctor: false, force: false, forceDowngrade: false },
          }),
          entry,
          relPath
        );
      } finally {
        process.stdout.write = originalWrite;
      }

      assert.equal(op, 'new');
      assert.equal(state.files[relPath].customisedLocally, false);
      assert.equal(state.files[relPath].adoptedOwnership, true);
      assert.ok(!fs.existsSync(path.join(targetDir, `${relPath}.framework-new`)),
        'adopt-only divergence is expected and must not produce a merge');
    } finally {
      await fsp.rm(frameworkDir, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 4: downgrade guard
// ---------------------------------------------------------------------------

test('e2e: sync refuses a downgrade, naming both versions; --force-downgrade overrides', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-hard-e2e3-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    const adoptResult = runSync(tmpDir, ['--adopt']);
    assert.equal(adoptResult.status, 0, `--adopt failed: ${adoptResult.stderr}`);

    // Pretend the repo was last synced from a NEWER framework than this checkout.
    const state = await readState(tmpDir);
    state.frameworkVersion = '99.0.0';
    await writeState(tmpDir, state);

    const refused = runSync(tmpDir);
    assert.equal(refused.status, 1, `downgrade should be refused:\nstdout: ${refused.stdout}\nstderr: ${refused.stderr}`);
    assert.ok(refused.stderr.includes('v99.0.0'), `stderr should name the state version: ${refused.stderr}`);
    assert.ok(refused.stderr.includes(`v${CANONICAL_VERSION}`), `stderr should name the framework version: ${refused.stderr}`);
    assert.ok(refused.stderr.includes('--force-downgrade'), `stderr should name the override flag: ${refused.stderr}`);

    // State must be untouched by the refused run.
    const stateAfterRefusal = await readState(tmpDir);
    assert.equal(stateAfterRefusal.frameworkVersion, '99.0.0', 'refused run must not write state');

    // Override proceeds.
    const forced = runSync(tmpDir, ['--force-downgrade']);
    assert.equal(forced.status, 0, `--force-downgrade should proceed:\nstderr: ${forced.stderr}`);
    const stateAfterForce = await readState(tmpDir);
    assert.equal(stateAfterForce.frameworkVersion, CANONICAL_VERSION,
      'forced downgrade should record the checkout version');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fix 5: orphaned .framework-new scan
// ---------------------------------------------------------------------------

describe('scanForUnresolvedMerges — state-tracked orphans', () => {
  test('finds .framework-new siblings on paths dropped from the manifest', async () => {
    const tmpDir = await makeTmpDir();
    try {
      // Manifest only knows docs/kept.md; docs/dropped.md exists only in state.
      await fsp.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
      await fsp.writeFile(path.join(tmpDir, 'docs', 'kept.md'), 'kept\n', 'utf8');
      await fsp.writeFile(path.join(tmpDir, 'docs', 'kept.md.framework-new'), 'kept new\n', 'utf8');
      await fsp.writeFile(path.join(tmpDir, 'docs', 'dropped.md.framework-new'), 'dropped new\n', 'utf8');

      const manifest = {
        frameworkVersion: '2.30.0',
        managedFiles: [{ path: 'docs/kept.md', category: 'reference', mode: 'sync', substituteAt: 'never' }],
        removedFiles: [],
        doNotTouch: [],
      };
      const state = {
        files: {
          'docs/kept.md': {},
          'docs/dropped.md': {},
        },
      };

      const result = scanForUnresolvedMerges(tmpDir, manifest, state);
      assert.deepEqual(result, ['docs/dropped.md', 'docs/kept.md'],
        'both the manifest-matched and the state-only orphan must be found, deduplicated and sorted');
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('remains backward compatible without a state argument', async () => {
    const tmpDir = await makeTmpDir();
    try {
      await fsp.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
      await fsp.writeFile(path.join(tmpDir, 'docs', 'kept.md'), 'kept\n', 'utf8');
      await fsp.writeFile(path.join(tmpDir, 'docs', 'kept.md.framework-new'), 'kept new\n', 'utf8');
      const manifest = {
        frameworkVersion: '2.30.0',
        managedFiles: [{ path: 'docs/kept.md', category: 'reference', mode: 'sync', substituteAt: 'never' }],
        removedFiles: [],
        doNotTouch: [],
      };
      assert.deepEqual(scanForUnresolvedMerges(tmpDir, manifest), ['docs/kept.md']);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('ignores escaping paths from a tampered state file', async () => {
    const tmpDir = await makeTmpDir();
    try {
      const manifest = { frameworkVersion: '2.30.0', managedFiles: [], removedFiles: [], doNotTouch: [] };
      const state = { files: { '../outside.md': {}, '/abs/outside.md': {} } };
      assert.deepEqual(scanForUnresolvedMerges(tmpDir, manifest, state), []);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test('e2e: sync blocks on an orphaned .framework-new for a state-tracked path outside the manifest', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-hard-e2e4-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    const adoptResult = runSync(tmpDir, ['--adopt']);
    assert.equal(adoptResult.status, 0, `--adopt failed: ${adoptResult.stderr}`);

    // Simulate a path dropped from the manifest but still tracked in state,
    // with an unresolved .framework-new left behind.
    const orphanPath = 'docs/orphaned-dropped-file.md';
    const state = await readState(tmpDir);
    state.frameworkVersion = '2.1.0'; // rewind so a real sync runs
    state.files[orphanPath] = {
      lastAppliedHash: 'deadbeef0000000000000000000000000000000000000000000000000000dead',
      lastAppliedFrameworkVersion: '2.1.0',
      lastAppliedFrameworkCommit: null,
      lastAppliedSourcePath: orphanPath,
      customisedLocally: true,
    };
    await writeState(tmpDir, state);
    await fsp.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fsp.writeFile(path.join(tmpDir, `${orphanPath}.framework-new`), '# orphaned merge\n', 'utf8');

    const syncResult = runSync(tmpDir);
    assert.equal(syncResult.status, 1, `sync should block on the orphaned merge:\nstdout: ${syncResult.stdout}\nstderr: ${syncResult.stderr}`);
    assert.ok(syncResult.stderr.includes('unresolved'), `stderr should mention unresolved: ${syncResult.stderr}`);
    assert.ok(syncResult.stderr.includes(orphanPath), `stderr should list the orphaned path: ${syncResult.stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
