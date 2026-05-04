import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const require = createRequire(import.meta.url);
const {
  normaliseContent,
  hashContent,
  expandGlob,
  hashSubstitutions,
  loadManifest,
  readState,
  writeStateAtomic,
  readFrameworkVersion,
  logFileOp,
  scanForUnresolvedMerges,
} = require('../sync.js');

// ---------------------------------------------------------------------------
// normaliseContent
// ---------------------------------------------------------------------------

describe('normaliseContent', () => {
  test('strips UTF-8 BOM', () => {
    const withBom = '﻿hello world\n';
    const result = normaliseContent(withBom);
    assert.equal(result, 'hello world\n');
  });

  test('converts CRLF to LF', () => {
    const crlf = 'line1\r\nline2\r\nline3\r\n';
    const result = normaliseContent(crlf);
    assert.equal(result, 'line1\nline2\nline3\n');
  });

  test('converts lone CR to LF', () => {
    const cr = 'line1\rline2\r';
    const result = normaliseContent(cr);
    assert.equal(result, 'line1\nline2\n');
  });

  test('strips trailing spaces from each line', () => {
    const padded = 'line1   \nline2\t\nline3\n';
    const result = normaliseContent(padded);
    assert.equal(result, 'line1\nline2\nline3\n');
  });

  test('collapses multiple trailing blank lines to exactly one newline', () => {
    const multiTrail = 'content\n\n\n\n';
    const result = normaliseContent(multiTrail);
    assert.equal(result, 'content\n');
  });

  test('adds a trailing newline when missing', () => {
    const noTrail = 'content';
    const result = normaliseContent(noTrail);
    assert.equal(result, 'content\n');
  });

  test('is idempotent', () => {
    const raw = '﻿line1   \r\nline2\r\n\r\n';
    const once = normaliseContent(raw);
    const twice = normaliseContent(once);
    assert.equal(once, twice);
  });
});

// ---------------------------------------------------------------------------
// hashContent
// ---------------------------------------------------------------------------

describe('hashContent', () => {
  test('same content produces same hash', () => {
    const h1 = hashContent('hello\n');
    const h2 = hashContent('hello\n');
    assert.equal(h1, h2);
  });

  test('different content produces different hash', () => {
    const h1 = hashContent('hello\n');
    const h2 = hashContent('world\n');
    assert.notEqual(h1, h2);
  });

  test('returns a 64-character hex string (sha256)', () => {
    const h = hashContent('test content\n');
    assert.match(h, /^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// expandGlob
// ---------------------------------------------------------------------------

describe('expandGlob', () => {
  /** @type {string} */
  let tmpDir;

  // Set up a fixture directory before each group of tests
  test('setup fixture dir', async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-test-'));
    await fsp.mkdir(path.join(tmpDir, 'sub'), { recursive: true });
    // Create test files
    for (const f of ['a.md', 'b.md', 'c.txt', '0001-init.md', 'hook.js', 'hook.sh', 'other.ts']) {
      await fsp.writeFile(path.join(tmpDir, 'sub', f), '');
    }
  });

  test('*.md returns .md files sorted lexicographically', () => {
    const result = expandGlob('sub/*.md', tmpDir);
    assert.deepEqual(result, ['sub/0001-init.md', 'sub/a.md', 'sub/b.md']);
  });

  test('*.{js,sh} returns both .js and .sh files sorted', () => {
    const result = expandGlob('sub/*.{js,sh}', tmpDir);
    assert.deepEqual(result, ['sub/hook.js', 'sub/hook.sh']);
  });

  test('0001-*.md returns only matching files', () => {
    const result = expandGlob('sub/0001-*.md', tmpDir);
    assert.deepEqual(result, ['sub/0001-init.md']);
  });

  test('no-match case returns empty array', () => {
    const result = expandGlob('sub/*.xyz', tmpDir);
    assert.deepEqual(result, []);
  });

  test('** pattern throws with not-supported message', () => {
    assert.throws(
      () => expandGlob('**/*.md', tmpDir),
      /\*\* not supported in v1/
    );
  });

  test('rejects manifest path containing .. segment', () => {
    assert.throws(
      () => expandGlob('../../etc/passwd', tmpDir),
      /must be relative without '\.\.' segments/
    );
    assert.throws(
      () => expandGlob('sub/../../escape.md', tmpDir),
      /must be relative without '\.\.' segments/
    );
  });

  test('rejects absolute manifest path', () => {
    const abs = path.isAbsolute('/etc/passwd') ? '/etc/passwd' : 'C:\\Windows\\System32\\evil';
    assert.throws(
      () => expandGlob(abs, tmpDir),
      /must be relative without '\.\.' segments/
    );
  });

  test('literal path that exists returns it', () => {
    const result = expandGlob('sub/c.txt', tmpDir);
    assert.deepEqual(result, ['sub/c.txt']);
  });

  test('literal path that does not exist returns empty array', () => {
    const result = expandGlob('sub/nonexistent.md', tmpDir);
    assert.deepEqual(result, []);
  });

  test('cleanup fixture dir', async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// hashSubstitutions
// ---------------------------------------------------------------------------

describe('hashSubstitutions', () => {
  test('key order does not matter', () => {
    const h1 = hashSubstitutions({ A: 'x', B: 'y' });
    const h2 = hashSubstitutions({ B: 'y', A: 'x' });
    assert.equal(h1, h2);
  });

  test('different values produce different hashes', () => {
    const h1 = hashSubstitutions({ A: 'x' });
    const h2 = hashSubstitutions({ A: 'y' });
    assert.notEqual(h1, h2);
  });

  test('empty object produces a stable hash without throwing', () => {
    const h1 = hashSubstitutions({});
    const h2 = hashSubstitutions({});
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// readState / writeStateAtomic round-trip
// ---------------------------------------------------------------------------

describe('readState / writeStateAtomic', () => {
  /** @type {string} */
  let tmpDir;

  test('round-trip writes and reads back state correctly', async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-state-'));

    /** @type {import('../sync.js').FrameworkState} */
    const state = {
      frameworkVersion: '2.2.0',
      adoptedAt: '2026-05-04T00:00:00.000Z',
      adoptedFromCommit: 'abc123',
      profile: 'STANDARD',
      substitutions: { PROJECT_NAME: 'TestProject' },
      lastSubstitutionHash: hashSubstitutions({ PROJECT_NAME: 'TestProject' }),
      files: {
        '.claude/FRAMEWORK_VERSION': {
          lastAppliedHash: 'abc',
          lastAppliedFrameworkVersion: '2.2.0',
          lastAppliedFrameworkCommit: null,
          lastAppliedSourcePath: '.claude/FRAMEWORK_VERSION',
          customisedLocally: false,
        },
      },
      syncIgnore: [],
    };

    await writeStateAtomic(tmpDir, state);
    const readBack = readState(tmpDir);
    assert.deepEqual(readBack, state);
  });

  test('readState returns null when file is missing', () => {
    const result = readState('/tmp/nonexistent-framework-state-dir-xyz');
    assert.equal(result, null);
  });

  test('partial write (only .tmp file) leaves original state intact', async () => {
    const stateDir = path.join(tmpDir, '.claude');
    const statePath = path.join(stateDir, '.framework-state.json');
    const tmpPath = statePath + '.tmp';

    // The state was written in previous test — read the original
    const original = readState(tmpDir);
    assert.ok(original !== null);

    // Simulate writing only .tmp (no rename)
    await fsp.writeFile(tmpPath, JSON.stringify({ frameworkVersion: 'partial' }, null, 2) + '\n', 'utf8');

    // Original should still be readable
    const afterPartial = readState(tmpDir);
    assert.deepEqual(afterPartial, original);

    // Cleanup .tmp
    await fsp.unlink(tmpPath);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// loadManifest
// ---------------------------------------------------------------------------

describe('loadManifest', () => {
  const frameworkRoot = path.dirname(fileURLToPath(import.meta.url)).replace(/[/\\]tests$/, '');

  test('reads real manifest.json and returns expected managedFiles count', () => {
    const manifest = loadManifest(frameworkRoot);
    assert.equal(typeof manifest.frameworkVersion, 'string');
    assert.ok(Array.isArray(manifest.managedFiles));
    // Manifest has 19 entries per spec §4.2 (Chunk 2)
    assert.equal(manifest.managedFiles.length, 19);
    assert.ok(Array.isArray(manifest.removedFiles));
    assert.ok(Array.isArray(manifest.doNotTouch));
  });

  test('rejects malformed JSON', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-manifest-'));
    await fsp.writeFile(path.join(tmpDir, 'manifest.json'), '{invalid json', 'utf8');
    assert.throws(() => loadManifest(tmpDir), /not valid JSON/);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test('rejects missing frameworkVersion field', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-manifest-'));
    const bad = { managedFiles: [], removedFiles: [], doNotTouch: [] };
    await fsp.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(bad), 'utf8');
    assert.throws(() => loadManifest(tmpDir), /frameworkVersion/);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test('overlap: conflicting mode throws an error', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-manifest-'));
    // Create a file that both entries will match
    await fsp.mkdir(path.join(tmpDir, 'sub'), { recursive: true });
    await fsp.writeFile(path.join(tmpDir, 'sub', 'file.md'), '');
    const bad = {
      frameworkVersion: '2.2.0',
      managedFiles: [
        { path: 'sub/file.md', category: 'agent', mode: 'sync', substituteAt: 'never' },
        { path: 'sub/file.md', category: 'agent', mode: 'adopt-only', substituteAt: 'never' },
      ],
      removedFiles: [],
      doNotTouch: [],
    };
    await fsp.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(bad), 'utf8');
    assert.throws(() => loadManifest(tmpDir), /overlap conflict/);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test('overlap: settings-merge exclusivity throws an error', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-manifest-'));
    await fsp.writeFile(path.join(tmpDir, 'settings.json'), '{}');
    const bad = {
      frameworkVersion: '2.2.0',
      managedFiles: [
        { path: 'settings.json', category: 'settings', mode: 'settings-merge', substituteAt: 'never' },
        { path: 'settings.json', category: 'settings', mode: 'sync', substituteAt: 'never' },
      ],
      removedFiles: [],
      doNotTouch: [],
    };
    await fsp.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(bad), 'utf8');
    assert.throws(() => loadManifest(tmpDir), /settings-merge mode is exclusive/);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// readFrameworkVersion
// ---------------------------------------------------------------------------

describe('readFrameworkVersion', () => {
  const frameworkRoot = path.dirname(fileURLToPath(import.meta.url)).replace(/[/\\]tests$/, '');

  test('reads real FRAMEWORK_VERSION and returns a semver string', () => {
    const version = readFrameworkVersion(frameworkRoot);
    assert.match(version, /^\d+\.\d+\.\d+$/);
  });

  test('throws if FRAMEWORK_VERSION does not exist', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-version-'));
    assert.throws(() => readFrameworkVersion(tmpDir), /Cannot read FRAMEWORK_VERSION/);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test('throws if FRAMEWORK_VERSION is not valid semver', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-version-'));
    await fsp.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    await fsp.writeFile(path.join(tmpDir, '.claude', 'FRAMEWORK_VERSION'), 'not-semver\n', 'utf8');
    assert.throws(() => readFrameworkVersion(tmpDir), /not a valid semver/);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// logFileOp
// ---------------------------------------------------------------------------

describe('logFileOp', () => {
  test('emits correct format for basic call', () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => { lines.push(chunk); return true; };
    try {
      logFileOp('test/path', 'updated');
    } finally {
      process.stdout.write = orig;
    }
    assert.equal(lines.join(''), 'SYNC file=test/path status=updated\n');
  });

  test('emits extra key=value pairs', () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => { lines.push(chunk); return true; };
    try {
      logFileOp('test/path', 'customised', { extra1: 'val1', extra2: 'val2' });
    } finally {
      process.stdout.write = orig;
    }
    assert.equal(lines.join(''), 'SYNC file=test/path status=customised extra1=val1 extra2=val2\n');
  });
});

// ---------------------------------------------------------------------------
// scanForUnresolvedMerges
// ---------------------------------------------------------------------------

describe('scanForUnresolvedMerges', () => {
  test('finds .framework-new siblings of managed paths', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-merges-'));
    await fsp.mkdir(path.join(tmpDir, '.claude', 'agents'), { recursive: true });

    // Create a managed file and a .framework-new sibling
    await fsp.writeFile(path.join(tmpDir, '.claude', 'agents', 'architect.md'), '# Architect');
    await fsp.writeFile(path.join(tmpDir, '.claude', 'agents', 'architect.md.framework-new'), '# Architect (new)');

    // Another managed file without a sibling
    await fsp.writeFile(path.join(tmpDir, '.claude', 'agents', 'builder.md'), '# Builder');

    /** @type {import('../sync.js').Manifest} */
    const manifest = {
      frameworkVersion: '2.2.0',
      managedFiles: [
        { path: '.claude/agents/*.md', category: 'agent', mode: 'sync', substituteAt: 'adoption' },
      ],
      removedFiles: [],
      doNotTouch: [],
    };

    const result = scanForUnresolvedMerges(tmpDir, manifest);
    assert.deepEqual(result, ['.claude/agents/architect.md']);

    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test('returns empty array when no .framework-new files exist', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-merges-'));
    await fsp.mkdir(path.join(tmpDir, '.claude', 'agents'), { recursive: true });
    await fsp.writeFile(path.join(tmpDir, '.claude', 'agents', 'builder.md'), '# Builder');

    const manifest = {
      frameworkVersion: '2.2.0',
      managedFiles: [
        { path: '.claude/agents/*.md', category: 'agent', mode: 'sync', substituteAt: 'adoption' },
      ],
      removedFiles: [],
      doNotTouch: [],
    };

    const result = scanForUnresolvedMerges(tmpDir, manifest);
    assert.deepEqual(result, []);

    await fsp.rm(tmpDir, { recursive: true, force: true });
  });
});
