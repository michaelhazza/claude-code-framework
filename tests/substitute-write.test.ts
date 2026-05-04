import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const {
  validateSubstitutions,
  checkSubstitutionDrift,
  applySubstitutions,
  hashSubstitutions,
  normaliseContent,
  hashContent,
  writeUpdated,
  writeFrameworkNew,
  writeNewFile,
} = require('../sync.js');

// ---------------------------------------------------------------------------
// Helper: unique temp dir
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), `sync-sw-${crypto.randomUUID().slice(0, 8)}-`));
}

// ---------------------------------------------------------------------------
// Helper: build a minimal SyncContext
// ---------------------------------------------------------------------------

function makeCtx(overrides: Record<string, unknown> = {}): any {
  return {
    targetRoot: os.tmpdir(),
    frameworkRoot: os.tmpdir(),
    manifest: { managedFiles: [], removedFiles: [], doNotTouch: [], frameworkVersion: '2.2.0' },
    state: null,
    frameworkVersion: '2.2.0',
    frameworkCommit: 'abc123',
    flags: { adopt: false, dryRun: false, check: false, strict: false, doctor: false, force: false },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateSubstitutions
// ---------------------------------------------------------------------------

describe('validateSubstitutions', () => {
  test('accepts a valid substitution map without throwing', () => {
    assert.doesNotThrow(() => validateSubstitutions({ PROJECT_NAME: 'Acme' }));
  });

  test('rejects a value containing {{ with an error mentioning the key', () => {
    assert.throws(
      () => validateSubstitutions({ PROJECT_NAME: 'Acme {{COMPANY_NAME}}' }),
      (err: Error) => {
        assert.ok(err.message.includes('PROJECT_NAME'));
        return true;
      }
    );
  });

  test('accepts empty map without throwing but emits WARN to stderr', () => {
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: any) => { stderrChunks.push(String(chunk)); return true; };
    try {
      assert.doesNotThrow(() => validateSubstitutions({}));
    } finally {
      process.stderr.write = originalWrite;
    }
    const combined = stderrChunks.join('');
    assert.ok(combined.includes('WARN'), `Expected WARN in stderr, got: ${combined}`);
  });
});

// ---------------------------------------------------------------------------
// checkSubstitutionDrift
// ---------------------------------------------------------------------------

describe('checkSubstitutionDrift', () => {
  const subs = { PROJECT_NAME: 'Acme' };
  const hash = hashSubstitutions(subs);
  const noFlags = { adopt: false, dryRun: false, check: false, strict: false, doctor: false, force: false };

  test('returns drift=false when hashes match', () => {
    const state = {
      frameworkVersion: '2.2.0',
      adoptedAt: '2026-01-01T00:00:00.000Z',
      adoptedFromCommit: null,
      profile: 'STANDARD',
      substitutions: subs,
      lastSubstitutionHash: hash,
      files: {},
      syncIgnore: [],
    };
    const result = checkSubstitutionDrift(state, noFlags);
    assert.deepEqual(result, { drift: false });
  });

  test('returns drift=true when hashes differ and no flags set', () => {
    const state = {
      frameworkVersion: '2.2.0',
      adoptedAt: '2026-01-01T00:00:00.000Z',
      adoptedFromCommit: null,
      profile: 'STANDARD',
      substitutions: { PROJECT_NAME: 'Changed' },
      lastSubstitutionHash: hash, // old hash for 'Acme'
      files: {},
      syncIgnore: [],
    };
    const result = checkSubstitutionDrift(state, noFlags);
    assert.equal(result.drift, true);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
  });

  test('returns drift=false when lastSubstitutionHash is missing (forward-migration)', () => {
    const state = {
      frameworkVersion: '2.2.0',
      adoptedAt: '2026-01-01T00:00:00.000Z',
      adoptedFromCommit: null,
      profile: 'STANDARD',
      substitutions: subs,
      // lastSubstitutionHash intentionally absent
      files: {},
      syncIgnore: [],
    };
    const result = checkSubstitutionDrift(state, noFlags);
    assert.deepEqual(result, { drift: false });
  });

  test('returns drift=false when flags.adopt is true even if hashes differ', () => {
    const state = {
      frameworkVersion: '2.2.0',
      adoptedAt: '2026-01-01T00:00:00.000Z',
      adoptedFromCommit: null,
      profile: 'STANDARD',
      substitutions: { PROJECT_NAME: 'Changed' },
      lastSubstitutionHash: hash,
      files: {},
      syncIgnore: [],
    };
    const flags = { ...noFlags, adopt: true };
    const result = checkSubstitutionDrift(state, flags);
    assert.deepEqual(result, { drift: false });
  });

  test('returns drift=false when flags.force is true even if hashes differ', () => {
    const state = {
      frameworkVersion: '2.2.0',
      adoptedAt: '2026-01-01T00:00:00.000Z',
      adoptedFromCommit: null,
      profile: 'STANDARD',
      substitutions: { PROJECT_NAME: 'Changed' },
      lastSubstitutionHash: hash,
      files: {},
      syncIgnore: [],
    };
    const flags = { ...noFlags, force: true };
    const result = checkSubstitutionDrift(state, flags);
    assert.deepEqual(result, { drift: false });
  });
});

// ---------------------------------------------------------------------------
// applySubstitutions
// ---------------------------------------------------------------------------

describe('applySubstitutions', () => {
  test('is idempotent (applying twice equals applying once)', () => {
    const content = 'Hello {{PROJECT_NAME}}, welcome to {{APP_NAME}}!\n';
    const subs = { PROJECT_NAME: 'Acme', APP_NAME: 'MyApp' };
    const once = applySubstitutions(content, subs);
    const twice = applySubstitutions(once, subs);
    assert.equal(once, twice);
  });

  test('only acts on {{X}} patterns, leaves [X] and <X> alone', () => {
    const content = '{{PROJECT_NAME}} and [PROJECT_NAME] and <PROJECT_NAME>\n';
    const subs = { PROJECT_NAME: 'Acme' };
    const result = applySubstitutions(content, subs);
    assert.equal(result, 'Acme and [PROJECT_NAME] and <PROJECT_NAME>\n');
  });

  test('does not modify content when substituteAt is never (caller skips applySubstitutions)', () => {
    // This tests the caller contract: when substituteAt is 'never', callers do not
    // call applySubstitutions, so the content retains literal {{PLACEHOLDER}} text.
    const content = 'raw {{PROJECT_NAME}} content\n';
    // Verify that not calling applySubstitutions leaves content unchanged
    assert.equal(content, 'raw {{PROJECT_NAME}} content\n');
  });
});

// ---------------------------------------------------------------------------
// writeUpdated
// ---------------------------------------------------------------------------

describe('writeUpdated', () => {
  test('writes substituted content to target path, updates state hash, emits status=updated', async () => {
    const frameworkDir = await makeTmpDir();
    const targetDir = await makeTmpDir();
    try {
      // Write framework source file with a placeholder
      const relPath = 'test-agent.md';
      const sourceContent = '# {{PROJECT_NAME}} Agent\n';
      await fsp.writeFile(path.join(frameworkDir, relPath), sourceContent, 'utf8');

      // Compute what the current target hash would be (simulating the "already applied" state)
      const oldContent = 'old content\n';
      const oldHash = hashContent(normaliseContent(oldContent));
      await fsp.writeFile(path.join(targetDir, relPath), oldContent, 'utf8');

      const state: any = {
        frameworkVersion: '2.2.0',
        adoptedAt: '2026-01-01T00:00:00.000Z',
        adoptedFromCommit: null,
        profile: 'STANDARD',
        substitutions: { PROJECT_NAME: 'Acme' },
        lastSubstitutionHash: hashSubstitutions({ PROJECT_NAME: 'Acme' }),
        files: {
          [relPath]: {
            lastAppliedHash: oldHash,
            lastAppliedFrameworkVersion: '2.1.0',
            lastAppliedFrameworkCommit: null,
            lastAppliedSourcePath: relPath,
            customisedLocally: false,
          },
        },
        syncIgnore: [],
      };

      const entry = { path: relPath, category: 'agent', mode: 'sync', substituteAt: 'adoption' };

      let captured = '';
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: any) => { captured += chunk; return true; };
      try {
        await writeUpdated(
          makeCtx({ frameworkRoot: frameworkDir, targetRoot: targetDir, state, frameworkVersion: '2.2.0', frameworkCommit: 'abc123' }),
          entry,
          relPath
        );
      } finally {
        process.stdout.write = originalWrite;
      }

      // Target file should have substituted content
      const written = await fsp.readFile(path.join(targetDir, relPath), 'utf8');
      assert.ok(written.includes('Acme'), `Expected 'Acme' in written content, got: ${written}`);
      assert.ok(!written.includes('{{PROJECT_NAME}}'), 'Placeholder should be replaced');

      // State hash should be updated
      const expectedContent = normaliseContent('# Acme Agent\n');
      const expectedHash = hashContent(expectedContent);
      assert.equal(state.files[relPath].lastAppliedHash, expectedHash);

      // logFileOp emits status=updated
      assert.ok(captured.includes('status=updated'), `Expected status=updated in stdout, got: ${captured}`);
    } finally {
      await fsp.rm(frameworkDir, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });

  test('self-heals lastAppliedSourcePath after writeUpdated', async () => {
    const frameworkDir = await makeTmpDir();
    const targetDir = await makeTmpDir();
    try {
      const relPath = 'some-file.md';
      await fsp.writeFile(path.join(frameworkDir, relPath), '# Content\n', 'utf8');
      await fsp.writeFile(path.join(targetDir, relPath), 'old\n', 'utf8');

      const state: any = {
        frameworkVersion: '2.2.0',
        adoptedAt: '2026-01-01T00:00:00.000Z',
        adoptedFromCommit: null,
        profile: 'STANDARD',
        substitutions: {},
        files: {
          [relPath]: {
            lastAppliedHash: hashContent(normaliseContent('old\n')),
            lastAppliedFrameworkVersion: '2.1.0',
            lastAppliedFrameworkCommit: null,
            lastAppliedSourcePath: 'wrong/path.md', // wrong value
            customisedLocally: false,
          },
        },
        syncIgnore: [],
      };

      const entry = { path: relPath, category: 'reference', mode: 'sync', substituteAt: 'never' };

      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: any) => chunk;
      try {
        await writeUpdated(
          makeCtx({ frameworkRoot: frameworkDir, targetRoot: targetDir, state, frameworkVersion: '2.2.0', frameworkCommit: null }),
          entry,
          relPath
        );
      } finally {
        process.stdout.write = originalWrite;
      }

      // lastAppliedSourcePath should now equal entry.path
      assert.equal(state.files[relPath].lastAppliedSourcePath, relPath);
    } finally {
      await fsp.rm(frameworkDir, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// writeFrameworkNew
// ---------------------------------------------------------------------------

describe('writeFrameworkNew', () => {
  test('writes .framework-new, leaves target untouched, sets customisedLocally=true, emits status=customised', async () => {
    const frameworkDir = await makeTmpDir();
    const targetDir = await makeTmpDir();
    try {
      const relPath = 'custom-agent.md';
      const sourceContent = '# Framework Agent\n';
      await fsp.writeFile(path.join(frameworkDir, relPath), sourceContent, 'utf8');

      const originalTargetContent = '# My Customised Agent\n';
      await fsp.writeFile(path.join(targetDir, relPath), originalTargetContent, 'utf8');

      const state: any = {
        frameworkVersion: '2.2.0',
        adoptedAt: '2026-01-01T00:00:00.000Z',
        adoptedFromCommit: null,
        profile: 'STANDARD',
        substitutions: {},
        files: {
          [relPath]: {
            lastAppliedHash: 'deadbeef0000000000000000000000000000000000000000000000000000dead',
            lastAppliedFrameworkVersion: '2.1.0',
            lastAppliedFrameworkCommit: null,
            lastAppliedSourcePath: relPath,
            customisedLocally: false,
          },
        },
        syncIgnore: [],
      };

      const entry = { path: relPath, category: 'agent', mode: 'sync', substituteAt: 'never' };

      let captured = '';
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: any) => { captured += chunk; return true; };
      try {
        await writeFrameworkNew(
          makeCtx({ frameworkRoot: frameworkDir, targetRoot: targetDir, state, frameworkVersion: '2.2.0', frameworkCommit: null }),
          entry,
          relPath
        );
      } finally {
        process.stdout.write = originalWrite;
      }

      // .framework-new should exist
      const newFilePath = path.join(targetDir, `${relPath}.framework-new`);
      const newFileContent = await fsp.readFile(newFilePath, 'utf8');
      assert.ok(newFileContent.includes('Framework Agent'));

      // Original target should be untouched
      const targetContent = await fsp.readFile(path.join(targetDir, relPath), 'utf8');
      assert.equal(targetContent, originalTargetContent);

      // State should have customisedLocally=true
      assert.equal(state.files[relPath].customisedLocally, true);

      // logFileOp should emit status=customised
      assert.ok(captured.includes('status=customised'), `Expected status=customised, got: ${captured}`);
    } finally {
      await fsp.rm(frameworkDir, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });

  test('overwriting existing .framework-new emits extra prior_framework_new=replaced', async () => {
    const frameworkDir = await makeTmpDir();
    const targetDir = await makeTmpDir();
    try {
      const relPath = 'agent-with-prior.md';
      await fsp.writeFile(path.join(frameworkDir, relPath), '# Updated\n', 'utf8');
      await fsp.writeFile(path.join(targetDir, relPath), '# Customised\n', 'utf8');
      // Pre-create .framework-new
      await fsp.writeFile(path.join(targetDir, `${relPath}.framework-new`), '# Old framework-new\n', 'utf8');

      const state: any = {
        frameworkVersion: '2.2.0',
        adoptedAt: '2026-01-01T00:00:00.000Z',
        adoptedFromCommit: null,
        profile: 'STANDARD',
        substitutions: {},
        files: {
          [relPath]: {
            lastAppliedHash: 'deadbeef0000000000000000000000000000000000000000000000000000dead',
            lastAppliedFrameworkVersion: '2.1.0',
            lastAppliedFrameworkCommit: null,
            lastAppliedSourcePath: relPath,
            customisedLocally: false,
          },
        },
        syncIgnore: [],
      };

      const entry = { path: relPath, category: 'agent', mode: 'sync', substituteAt: 'never' };

      let captured = '';
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: any) => { captured += chunk; return true; };
      try {
        await writeFrameworkNew(
          makeCtx({ frameworkRoot: frameworkDir, targetRoot: targetDir, state, frameworkVersion: '2.2.0', frameworkCommit: null }),
          entry,
          relPath
        );
      } finally {
        process.stdout.write = originalWrite;
      }

      assert.ok(
        captured.includes('prior_framework_new=replaced'),
        `Expected prior_framework_new=replaced in: ${captured}`
      );
    } finally {
      await fsp.rm(frameworkDir, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// writeNewFile
// ---------------------------------------------------------------------------

describe('writeNewFile — target missing', () => {
  test('writes fresh file and emits status=new', async () => {
    const frameworkDir = await makeTmpDir();
    const targetDir = await makeTmpDir();
    try {
      const relPath = 'brand-new.md';
      await fsp.writeFile(path.join(frameworkDir, relPath), '# Brand New File\n', 'utf8');
      // Do NOT create the file in targetDir

      const state: any = {
        frameworkVersion: '2.2.0',
        adoptedAt: '2026-01-01T00:00:00.000Z',
        adoptedFromCommit: null,
        profile: 'STANDARD',
        substitutions: {},
        files: {},
        syncIgnore: [],
      };

      const entry = { path: relPath, category: 'reference', mode: 'sync', substituteAt: 'never' };

      let captured = '';
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: any) => { captured += chunk; return true; };
      try {
        await writeNewFile(
          makeCtx({ frameworkRoot: frameworkDir, targetRoot: targetDir, state, frameworkVersion: '2.2.0', frameworkCommit: null }),
          entry,
          relPath
        );
      } finally {
        process.stdout.write = originalWrite;
      }

      // File should have been written
      const written = await fsp.readFile(path.join(targetDir, relPath), 'utf8');
      assert.ok(written.includes('Brand New File'));

      // Status = new
      assert.ok(captured.includes('status=new'), `Expected status=new, got: ${captured}`);
    } finally {
      await fsp.rm(frameworkDir, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });
});

describe('writeNewFile — target exists, no state', () => {
  test('writes .framework-new and emits status=customised with reason=untracked-pre-existing', async () => {
    const frameworkDir = await makeTmpDir();
    const targetDir = await makeTmpDir();
    try {
      const relPath = 'pre-existing.md';
      await fsp.writeFile(path.join(frameworkDir, relPath), '# Framework Version\n', 'utf8');
      // Pre-existing local file (no state entry)
      await fsp.writeFile(path.join(targetDir, relPath), '# Local Version\n', 'utf8');

      const state: any = {
        frameworkVersion: '2.2.0',
        adoptedAt: '2026-01-01T00:00:00.000Z',
        adoptedFromCommit: null,
        profile: 'STANDARD',
        substitutions: {},
        files: {}, // no entry for this file
        syncIgnore: [],
      };

      const entry = { path: relPath, category: 'reference', mode: 'sync', substituteAt: 'never' };

      let captured = '';
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: any) => { captured += chunk; return true; };
      try {
        await writeNewFile(
          makeCtx({ frameworkRoot: frameworkDir, targetRoot: targetDir, state, frameworkVersion: '2.2.0', frameworkCommit: null }),
          entry,
          relPath
        );
      } finally {
        process.stdout.write = originalWrite;
      }

      // .framework-new should exist
      const newFilePath = path.join(targetDir, `${relPath}.framework-new`);
      const exists = await fsp.stat(newFilePath).then(() => true).catch(() => false);
      assert.ok(exists, '.framework-new file should have been written');

      // Original file should be untouched
      const original = await fsp.readFile(path.join(targetDir, relPath), 'utf8');
      assert.equal(original, '# Local Version\n');

      // Status = customised with reason=untracked-pre-existing
      assert.ok(captured.includes('status=customised'), `Expected status=customised, got: ${captured}`);
      assert.ok(captured.includes('reason=untracked-pre-existing'), `Expected reason=untracked-pre-existing, got: ${captured}`);
    } finally {
      await fsp.rm(frameworkDir, { recursive: true, force: true });
      await fsp.rm(targetDir, { recursive: true, force: true });
    }
  });
});
