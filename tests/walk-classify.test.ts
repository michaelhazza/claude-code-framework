import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const require = createRequire(import.meta.url);
const {
  expandManagedFiles,
  classifyFile,
  hashContent,
  normaliseContent,
} = require('../sync.js');

// Directory containing this test file (setup/portable/tests/)
const testsDir = path.dirname(fileURLToPath(import.meta.url));
// setup/portable/ — the real frameworkRoot
const frameworkRoot = path.resolve(testsDir, '..');

// ---------------------------------------------------------------------------
// Helper: build a minimal SyncContext
// ---------------------------------------------------------------------------

function makeCtx(overrides: Record<string, unknown> = {}): any {
  return {
    targetRoot: os.tmpdir(),
    frameworkRoot,
    manifest: { managedFiles: [], removedFiles: [], doNotTouch: [], frameworkVersion: '2.2.0' },
    state: null,
    frameworkVersion: '2.2.0',
    frameworkCommit: null,
    flags: { adopt: false, dryRun: false, check: false, strict: false, doctor: false, force: false },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// expandManagedFiles
// ---------------------------------------------------------------------------

describe('expandManagedFiles', () => {
  test('returns a non-empty array from the real manifest', () => {
    const { loadManifest } = require('../sync.js');
    const manifest = loadManifest(frameworkRoot);
    const result = expandManagedFiles(manifest, frameworkRoot);
    assert.ok(Array.isArray(result));
    assert.ok(result.length > 0);
  });

  test('no duplicate relativePaths in result', () => {
    const { loadManifest } = require('../sync.js');
    const manifest = loadManifest(frameworkRoot);
    const result = expandManagedFiles(manifest, frameworkRoot);
    const paths = result.map((r: { relativePath: string }) => r.relativePath);
    const unique = new Set(paths);
    assert.equal(unique.size, paths.length);
  });

  test('all relativePaths use forward slashes', () => {
    const { loadManifest } = require('../sync.js');
    const manifest = loadManifest(frameworkRoot);
    const result = expandManagedFiles(manifest, frameworkRoot);
    for (const { relativePath } of result) {
      assert.ok(!relativePath.includes('\\'), `Path uses backslash: ${relativePath}`);
    }
  });
});

// ---------------------------------------------------------------------------
// classifyFile — syncIgnore
// ---------------------------------------------------------------------------

describe('classifyFile — syncIgnore', () => {
  test('returns skipped/syncIgnore when path is in syncIgnore list', () => {
    const ctx = makeCtx({
      state: {
        frameworkVersion: '2.2.0',
        adoptedAt: '2026-01-01T00:00:00.000Z',
        adoptedFromCommit: null,
        profile: 'STANDARD',
        substitutions: {},
        files: {},
        syncIgnore: ['somefile.md'],
      },
    });
    const entry = { path: 'somefile.md', category: 'reference', mode: 'sync', substituteAt: 'never' };
    const result = classifyFile(ctx, entry, 'somefile.md');
    assert.deepEqual(result, { kind: 'skipped', reason: 'syncIgnore' });
  });
});

// ---------------------------------------------------------------------------
// classifyFile — adopt-only with existing state (project owns it)
// ---------------------------------------------------------------------------

describe('classifyFile — adopt-only already owned', () => {
  test('returns skipped/adopt-only when state entry exists and adoptedOwnership is set', () => {
    const ctx = makeCtx({
      state: {
        frameworkVersion: '2.2.0',
        adoptedAt: '2026-01-01T00:00:00.000Z',
        adoptedFromCommit: null,
        profile: 'STANDARD',
        substitutions: {},
        files: {
          'docs/spec-context.md': {
            lastAppliedHash: 'abc123',
            lastAppliedFrameworkVersion: '2.2.0',
            lastAppliedFrameworkCommit: null,
            lastAppliedSourcePath: 'docs/spec-context.md',
            customisedLocally: false,
            adoptedOwnership: true,
          },
        },
        syncIgnore: [],
      },
    });
    const entry = { path: 'docs/spec-context.md', category: 'template', mode: 'adopt-only', substituteAt: 'adoption' };
    const result = classifyFile(ctx, entry, 'docs/spec-context.md');
    assert.deepEqual(result, { kind: 'skipped', reason: 'adopt-only' });
  });
});

// ---------------------------------------------------------------------------
// classifyFile — already-on-version
// ---------------------------------------------------------------------------

describe('classifyFile — already-on-version', () => {
  let tmpDir: string;

  test('returns skipped/already-on-version when hash matches and version matches', async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-classify-'));
    try {
      const content = 'hello framework file\n';
      const normalised = normaliseContent(content);
      const hash = hashContent(normalised);

      await fsp.writeFile(path.join(tmpDir, 'testfile.md'), content, 'utf8');

      const ctx = makeCtx({
        targetRoot: tmpDir,
        frameworkVersion: '2.2.0',
        state: {
          frameworkVersion: '2.2.0',
          adoptedAt: '2026-01-01T00:00:00.000Z',
          adoptedFromCommit: null,
          profile: 'STANDARD',
          substitutions: {},
          files: {
            'testfile.md': {
              lastAppliedHash: hash,
              lastAppliedFrameworkVersion: '2.2.0',
              lastAppliedFrameworkCommit: null,
              lastAppliedSourcePath: 'testfile.md',
              customisedLocally: false,
            },
          },
          syncIgnore: [],
        },
      });
      const entry = { path: 'testfile.md', category: 'reference', mode: 'sync', substituteAt: 'never' };
      const result = classifyFile(ctx, entry, 'testfile.md');
      assert.deepEqual(result, { kind: 'skipped', reason: 'already-on-version' });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// classifyFile — clean, needs update
// ---------------------------------------------------------------------------

describe('classifyFile — clean needs update', () => {
  test('returns clean/needsUpdate when hash matches but version differs', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-classify-'));
    try {
      const content = 'hello framework file\n';
      const normalised = normaliseContent(content);
      const hash = hashContent(normalised);

      await fsp.writeFile(path.join(tmpDir, 'testfile.md'), content, 'utf8');

      const ctx = makeCtx({
        targetRoot: tmpDir,
        frameworkVersion: '2.3.0',
        state: {
          frameworkVersion: '2.2.0',
          adoptedAt: '2026-01-01T00:00:00.000Z',
          adoptedFromCommit: null,
          profile: 'STANDARD',
          substitutions: {},
          files: {
            'testfile.md': {
              lastAppliedHash: hash,
              lastAppliedFrameworkVersion: '2.2.0',
              lastAppliedFrameworkCommit: null,
              lastAppliedSourcePath: 'testfile.md',
              customisedLocally: false,
            },
          },
          syncIgnore: [],
        },
      });
      const entry = { path: 'testfile.md', category: 'reference', mode: 'sync', substituteAt: 'never' };
      const result = classifyFile(ctx, entry, 'testfile.md');
      assert.deepEqual(result, { kind: 'clean', needsUpdate: true });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// classifyFile — customised (hash mismatch)
// ---------------------------------------------------------------------------

describe('classifyFile — customised', () => {
  test('returns customised when target hash does not match lastAppliedHash', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-classify-'));
    try {
      await fsp.writeFile(path.join(tmpDir, 'testfile.md'), 'operator modified this\n', 'utf8');

      const ctx = makeCtx({
        targetRoot: tmpDir,
        frameworkVersion: '2.2.0',
        state: {
          frameworkVersion: '2.2.0',
          adoptedAt: '2026-01-01T00:00:00.000Z',
          adoptedFromCommit: null,
          profile: 'STANDARD',
          substitutions: {},
          files: {
            'testfile.md': {
              lastAppliedHash: 'deadbeef0000000000000000000000000000000000000000000000000000dead',
              lastAppliedFrameworkVersion: '2.2.0',
              lastAppliedFrameworkCommit: null,
              lastAppliedSourcePath: 'testfile.md',
              customisedLocally: false,
            },
          },
          syncIgnore: [],
        },
      });
      const entry = { path: 'testfile.md', category: 'reference', mode: 'sync', substituteAt: 'never' };
      const result = classifyFile(ctx, entry, 'testfile.md');
      assert.deepEqual(result, { kind: 'customised' });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// classifyFile — new-file-no-state, target missing
// ---------------------------------------------------------------------------

describe('classifyFile — new-file-no-state target missing', () => {
  test('returns new-file-no-state/targetExists=false when no state entry and file absent', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-classify-'));
    try {
      const ctx = makeCtx({
        targetRoot: tmpDir,
        state: {
          frameworkVersion: '2.2.0',
          adoptedAt: '2026-01-01T00:00:00.000Z',
          adoptedFromCommit: null,
          profile: 'STANDARD',
          substitutions: {},
          files: {},
          syncIgnore: [],
        },
      });
      const entry = { path: 'newfile.md', category: 'reference', mode: 'sync', substituteAt: 'never' };
      const result = classifyFile(ctx, entry, 'newfile.md');
      assert.deepEqual(result, { kind: 'new-file-no-state', targetExists: false });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// classifyFile — new-file-no-state, target exists (pre-existing)
// ---------------------------------------------------------------------------

describe('classifyFile — new-file-no-state target exists', () => {
  test('returns new-file-no-state/targetExists=true when no state entry but file present', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-classify-'));
    try {
      await fsp.writeFile(path.join(tmpDir, 'existing.md'), 'pre-existing content\n', 'utf8');

      const ctx = makeCtx({
        targetRoot: tmpDir,
        state: {
          frameworkVersion: '2.2.0',
          adoptedAt: '2026-01-01T00:00:00.000Z',
          adoptedFromCommit: null,
          profile: 'STANDARD',
          substitutions: {},
          files: {},
          syncIgnore: [],
        },
      });
      const entry = { path: 'existing.md', category: 'reference', mode: 'sync', substituteAt: 'never' };
      const result = classifyFile(ctx, entry, 'existing.md');
      assert.deepEqual(result, { kind: 'new-file-no-state', targetExists: true });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// classifyFile — ownership-transferred (was sync, now adopt-only)
// ---------------------------------------------------------------------------

describe('classifyFile — ownership-transferred', () => {
  test('returns ownership-transferred when state entry exists without adoptedOwnership and mode is adopt-only', () => {
    const ctx = makeCtx({
      state: {
        frameworkVersion: '2.2.0',
        adoptedAt: '2026-01-01T00:00:00.000Z',
        adoptedFromCommit: null,
        profile: 'STANDARD',
        substitutions: {},
        files: {
          'docs/some-template.md': {
            lastAppliedHash: 'abc123',
            lastAppliedFrameworkVersion: '2.1.0',
            lastAppliedFrameworkCommit: null,
            lastAppliedSourcePath: 'docs/some-template.md',
            customisedLocally: false,
            // adoptedOwnership intentionally absent
          },
        },
        syncIgnore: [],
      },
    });
    const entry = { path: 'docs/some-template.md', category: 'template', mode: 'adopt-only', substituteAt: 'adoption' };
    const result = classifyFile(ctx, entry, 'docs/some-template.md');
    assert.deepEqual(result, { kind: 'ownership-transferred' });
  });
});

// ---------------------------------------------------------------------------
// classifyFile — settings-merge
// ---------------------------------------------------------------------------

describe('classifyFile — settings-merge', () => {
  test('returns settings-merge when entry mode is settings-merge', () => {
    const ctx = makeCtx({
      state: {
        frameworkVersion: '2.2.0',
        adoptedAt: '2026-01-01T00:00:00.000Z',
        adoptedFromCommit: null,
        profile: 'STANDARD',
        substitutions: {},
        files: {},
        syncIgnore: [],
      },
    });
    const entry = { path: '.claude/settings.json', category: 'settings', mode: 'settings-merge', substituteAt: 'never' };
    const result = classifyFile(ctx, entry, '.claude/settings.json');
    assert.deepEqual(result, { kind: 'settings-merge' });
  });
});
