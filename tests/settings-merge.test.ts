import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const {
  isFrameworkOwnedCommand,
  mergeSettingsHooksBlock,
  mergeSettings,
  normaliseContent,
  hashContent,
} = require('../sync.js');

// ---------------------------------------------------------------------------
// Helper: unique temp dir
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), `sync-sm-${crypto.randomUUID().slice(0, 8)}-`));
}

// ---------------------------------------------------------------------------
// Helper: minimal SyncContext for mergeSettings
// ---------------------------------------------------------------------------

function makeCtx(targetRoot: string, frameworkRoot: string, overrides: Record<string, unknown> = {}): any {
  return {
    targetRoot,
    frameworkRoot,
    manifest: { managedFiles: [], removedFiles: [], doNotTouch: [], frameworkVersion: '2.2.0' },
    state: {
      frameworkVersion: '2.1.0',
      adoptedAt: '',
      adoptedFromCommit: null,
      profile: 'STANDARD',
      substitutions: {},
      files: {},
      syncIgnore: [],
    },
    frameworkVersion: '2.2.0',
    frameworkCommit: null,
    flags: { adopt: false, dryRun: false, check: false, strict: false, doctor: false, force: false },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isFrameworkOwnedCommand — Rule 1 (identity)
// ---------------------------------------------------------------------------

describe('isFrameworkOwnedCommand', () => {
  test('returns true for a .claude/hooks/ command with CLAUDE_PROJECT_DIR prefix', () => {
    assert.equal(
      isFrameworkOwnedCommand('node ${CLAUDE_PROJECT_DIR}/.claude/hooks/long-doc-guard.js'),
      true
    );
  });

  test('returns true for a .claude/hooks/ command without CLAUDE_PROJECT_DIR prefix', () => {
    assert.equal(
      isFrameworkOwnedCommand('.claude/hooks/config-protection.js'),
      true
    );
  });

  test('returns false for a project-owned script', () => {
    assert.equal(
      isFrameworkOwnedCommand('node ./scripts/my-hook.js'),
      false
    );
  });

  test('returns false for an inline shell command', () => {
    assert.equal(
      isFrameworkOwnedCommand('echo "hello"'),
      false
    );
  });

  test('ignores trailing arguments — only first token matters', () => {
    assert.equal(
      isFrameworkOwnedCommand('node ${CLAUDE_PROJECT_DIR}/.claude/hooks/long-doc-guard.js --verbose'),
      true
    );
    assert.equal(
      isFrameworkOwnedCommand('node ./scripts/my-hook.js .claude/hooks/something.js'),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// mergeSettingsHooksBlock — Rule 2a (replace-in-place)
// ---------------------------------------------------------------------------

describe('mergeSettingsHooksBlock — Rule 2a (replace-in-place)', () => {
  test('exactly one long-doc-guard entry in framework-declared position when project already has it', () => {
    const fwHooks = {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/long-doc-guard.js' }],
        },
      ],
    };
    const projHooks = {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/long-doc-guard.js' }],
        },
      ],
    };

    const result = mergeSettingsHooksBlock(fwHooks, projHooks);
    const writeGroup = result.PreToolUse?.find((g: any) => g.matcher === 'Write');
    assert.ok(writeGroup, 'Write group should exist');
    // Exactly one entry
    const guardEntries = writeGroup.hooks.filter((h: any) =>
      h.command.includes('long-doc-guard.js')
    );
    assert.equal(guardEntries.length, 1, 'Should have exactly one long-doc-guard entry');
  });
});

// ---------------------------------------------------------------------------
// mergeSettingsHooksBlock — Rule 2b (append)
// ---------------------------------------------------------------------------

describe('mergeSettingsHooksBlock — Rule 2b (append)', () => {
  test('inserts long-doc-guard into framework group when project has no such entry', () => {
    const fwHooks = {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/long-doc-guard.js' }],
        },
      ],
    };
    const projHooks = {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: 'node ./scripts/my-hook.js' }],
        },
      ],
    };

    const result = mergeSettingsHooksBlock(fwHooks, projHooks);
    const writeGroup = result.PreToolUse?.find((g: any) => g.matcher === 'Write');
    assert.ok(writeGroup, 'Write group should exist');
    const guardEntry = writeGroup.hooks.find((h: any) => h.command.includes('long-doc-guard.js'));
    assert.ok(guardEntry, 'long-doc-guard should be present');
  });
});

// ---------------------------------------------------------------------------
// mergeSettingsHooksBlock — Rule 3 (project hooks preserved)
// ---------------------------------------------------------------------------

describe('mergeSettingsHooksBlock — Rule 3 (project hooks preserved)', () => {
  test('project-owned hook survives merge unchanged', () => {
    const fwHooks = {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/long-doc-guard.js' }],
        },
      ],
    };
    const projHooks = {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [
            { type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/long-doc-guard.js' },
            { type: 'command', command: 'node ./scripts/my-hook.js' },
          ],
        },
      ],
    };

    const result = mergeSettingsHooksBlock(fwHooks, projHooks);
    const writeGroup = result.PreToolUse?.find((g: any) => g.matcher === 'Write');
    assert.ok(writeGroup, 'Write group should exist');
    const myHook = writeGroup.hooks.find((h: any) => h.command === 'node ./scripts/my-hook.js');
    assert.ok(myHook, 'project-owned hook should be preserved');
  });
});

// ---------------------------------------------------------------------------
// mergeSettingsHooksBlock — Rule 4 (collision, project wins)
// ---------------------------------------------------------------------------

describe('mergeSettingsHooksBlock — Rule 4 (collision, project wins)', () => {
  test('only one entry when project declares the same framework-owned hook; framework duplicate dropped', () => {
    const fwHooks = {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/long-doc-guard.js' }],
        },
      ],
    };
    // Project has the same framework hook — project wins, framework entry is dropped
    const projHooks = {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/long-doc-guard.js' }],
        },
      ],
    };

    const result = mergeSettingsHooksBlock(fwHooks, projHooks);
    const writeGroup = result.PreToolUse?.find((g: any) => g.matcher === 'Write');
    assert.ok(writeGroup, 'Write group should exist');
    const allGuard = writeGroup.hooks.filter((h: any) => h.command.includes('long-doc-guard.js'));
    assert.equal(allGuard.length, 1, 'Exactly one guard entry — framework duplicate dropped');
  });
});

// ---------------------------------------------------------------------------
// mergeSettingsHooksBlock — Rule 5 (stable ordering / determinism)
// ---------------------------------------------------------------------------

describe('mergeSettingsHooksBlock — Rule 4 (collision in mixed group)', () => {
  test('project keeps its framework-owned hook; framework siblings preserved; project-owned preserved', () => {
    // Framework declares two hooks under matcher Write: A and B.
    // Project also declares matcher Write with [A (with extra field), X].
    // Expectation per spec §4.6 rule 4 (project wins on collision) plus rule 5 (framework-first ordering):
    //   merged Write group hooks = [B (framework), A (project, with extraField), X (project-owned)]
    const fwHooks = {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [
            { type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/A.js' },
            { type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/B.js' },
          ],
        },
      ],
    };
    const projHooks = {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [
            { type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/A.js', extraField: 'projectValue' },
            { type: 'command', command: 'node ./scripts/X.js' },
          ],
        },
      ],
    };

    const result = mergeSettingsHooksBlock(fwHooks, projHooks);
    const writeGroup = result.PreToolUse?.find((g: any) => g.matcher === 'Write');
    assert.ok(writeGroup, 'Write group should exist');

    const aEntries = writeGroup.hooks.filter((h: any) => h.command.includes('/A.js'));
    const bEntries = writeGroup.hooks.filter((h: any) => h.command.includes('/B.js'));
    const xEntries = writeGroup.hooks.filter((h: any) => h.command.includes('X.js'));

    assert.equal(aEntries.length, 1, 'Exactly one A entry — framework duplicate dropped');
    assert.equal((aEntries[0] as any).extraField, 'projectValue', 'A entry must be the project version (preserves extraField)');
    assert.equal(bEntries.length, 1, 'B preserved from framework');
    assert.equal(xEntries.length, 1, 'X preserved from project');
    assert.equal(writeGroup.hooks.length, 3, 'Total: 3 hooks (A, B, X)');
  });
});

describe('mergeSettingsHooksBlock — Rule 5 (stable ordering)', () => {
  test('two consecutive calls with same inputs produce deep-equal output', () => {
    const fwHooks = {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/long-doc-guard.js' }],
        },
        {
          matcher: 'Edit',
          hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/config-protection.js' }],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/correction-nudge.js' }],
        },
      ],
    };
    const projHooks = {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: 'node ./scripts/my-hook.js' }],
        },
      ],
    };

    const result1 = mergeSettingsHooksBlock(fwHooks, projHooks);
    const result2 = mergeSettingsHooksBlock(fwHooks, projHooks);
    assert.deepEqual(result1, result2);
  });
});

// ---------------------------------------------------------------------------
// mergeSettingsHooksBlock — Rule 9 (empty hooks block / new event)
// ---------------------------------------------------------------------------

describe('mergeSettingsHooksBlock — empty/new event', () => {
  test('inserts event key when project had no hooks for that event', () => {
    const fwHooks = {
      SessionStart: [
        {
          hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/code-graph-freshness-check.js' }],
        },
      ],
    };
    const projHooks = {}; // project has no SessionStart entry

    const result = mergeSettingsHooksBlock(fwHooks, projHooks);
    assert.ok(result.SessionStart, 'SessionStart event key should appear in merged output');
    assert.equal(result.SessionStart.length, 1);
    assert.ok(
      result.SessionStart[0].hooks[0].command.includes('code-graph-freshness-check.js')
    );
  });
});

// ---------------------------------------------------------------------------
// mergeSettingsHooksBlock — Rule 6 (no auto-removal, WARN on orphan)
// ---------------------------------------------------------------------------

describe('mergeSettingsHooksBlock — Rule 6 (no auto-removal of orphaned framework hooks)', () => {
  test('orphaned framework-owned hook stays in output; WARN emitted to stderr', () => {
    // Framework no longer declares old-removed.js, but project still has it
    const fwHooks = {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/long-doc-guard.js' }],
        },
      ],
    };
    const projHooks = {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [
            { type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/long-doc-guard.js' },
            { type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/old-removed.js' },
          ],
        },
      ],
    };

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: any) => { stderrChunks.push(String(chunk)); return true; };
    let result: Record<string, any[]>;
    try {
      result = mergeSettingsHooksBlock(fwHooks, projHooks);
    } finally {
      process.stderr.write = originalWrite;
    }

    // Orphaned hook should be present in merged output (preserved, not removed)
    const writeGroup = result.PreToolUse?.find((g: any) => g.matcher === 'Write');
    assert.ok(writeGroup, 'Write group should exist');
    const orphan = writeGroup.hooks.find((h: any) => h.command.includes('old-removed.js'));
    assert.ok(orphan, 'Orphaned hook should be preserved in output');

    // WARN should have been emitted to stderr
    const combined = stderrChunks.join('');
    assert.ok(combined.includes('WARN'), `Expected WARN in stderr output, got: ${combined}`);
    assert.ok(combined.includes('old-removed.js'), `Expected old-removed.js in WARN message, got: ${combined}`);
  });
});

// ---------------------------------------------------------------------------
// mergeSettings — Rule 7 (top-level keys preserved)
// ---------------------------------------------------------------------------

describe('mergeSettings — Rule 7 (top-level keys preserved)', () => {
  test('permissions key from project settings is preserved after mergeSettings', async () => {
    const fwRoot = await makeTmpDir();
    const targetRoot = await makeTmpDir();
    try {
      // Write framework's settings.json
      const claudeDir = path.join(fwRoot, '.claude');
      await fsp.mkdir(claudeDir, { recursive: true });
      const fwSettings = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Write',
              hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/long-doc-guard.js' }],
            },
          ],
        },
      };
      await fsp.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify(fwSettings, null, 2), 'utf8');

      // Write project's existing settings.json with a non-hooks top-level key
      const targetClaudeDir = path.join(targetRoot, '.claude');
      await fsp.mkdir(targetClaudeDir, { recursive: true });
      const projSettings = {
        permissions: { allow: [] },
        hooks: {
          PreToolUse: [
            {
              matcher: 'Write',
              hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/long-doc-guard.js' }],
            },
          ],
        },
      };
      await fsp.writeFile(path.join(targetClaudeDir, 'settings.json'), JSON.stringify(projSettings, null, 2), 'utf8');

      const ctx = makeCtx(targetRoot, fwRoot);
      const entry = { path: '.claude/settings.json', category: 'settings', mode: 'settings-merge', substituteAt: 'never' };

      let stdout = '';
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: any) => { stdout += chunk; return true; };
      try {
        await mergeSettings(ctx, entry, '.claude/settings.json');
      } finally {
        process.stdout.write = origWrite;
      }

      const written = JSON.parse(await fsp.readFile(path.join(targetClaudeDir, 'settings.json'), 'utf8'));
      assert.ok(written.permissions, 'permissions key should be preserved');
      assert.deepEqual(written.permissions, { allow: [] });
    } finally {
      await fsp.rm(fwRoot, { recursive: true, force: true });
      await fsp.rm(targetRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// mergeSettings — no target settings.json
// ---------------------------------------------------------------------------

describe('mergeSettings — no target settings.json', () => {
  test('writes settings.json containing framework hooks when no existing target file', async () => {
    const fwRoot = await makeTmpDir();
    const targetRoot = await makeTmpDir();
    try {
      // Write framework's settings.json
      const claudeDir = path.join(fwRoot, '.claude');
      await fsp.mkdir(claudeDir, { recursive: true });
      const fwSettings = {
        hooks: {
          SessionStart: [
            {
              hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/code-graph-freshness-check.js' }],
            },
          ],
        },
      };
      await fsp.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify(fwSettings, null, 2), 'utf8');

      // Do NOT create target's .claude/settings.json
      const targetClaudeDir = path.join(targetRoot, '.claude');
      await fsp.mkdir(targetClaudeDir, { recursive: true });

      const ctx = makeCtx(targetRoot, fwRoot);
      const entry = { path: '.claude/settings.json', category: 'settings', mode: 'settings-merge', substituteAt: 'never' };

      let stdout = '';
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: any) => { stdout += chunk; return true; };
      try {
        await mergeSettings(ctx, entry, '.claude/settings.json');
      } finally {
        process.stdout.write = origWrite;
      }

      const targetPath = path.join(targetClaudeDir, 'settings.json');
      const exists = await fsp.stat(targetPath).then(() => true).catch(() => false);
      assert.ok(exists, 'settings.json should have been created');

      const written = JSON.parse(await fsp.readFile(targetPath, 'utf8'));
      assert.ok(written.hooks?.SessionStart, 'SessionStart event should be in written file');
    } finally {
      await fsp.rm(fwRoot, { recursive: true, force: true });
      await fsp.rm(targetRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// mergeSettings — hash tracking
// ---------------------------------------------------------------------------

describe('mergeSettings — hash tracking', () => {
  test('ctx.state.files[path].lastAppliedHash matches hash of merged output', async () => {
    const fwRoot = await makeTmpDir();
    const targetRoot = await makeTmpDir();
    try {
      const claudeDir = path.join(fwRoot, '.claude');
      await fsp.mkdir(claudeDir, { recursive: true });
      const fwSettings = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Write',
              hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/long-doc-guard.js' }],
            },
          ],
        },
      };
      await fsp.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify(fwSettings, null, 2), 'utf8');

      const targetClaudeDir = path.join(targetRoot, '.claude');
      await fsp.mkdir(targetClaudeDir, { recursive: true });
      // No pre-existing settings.json

      const ctx = makeCtx(targetRoot, fwRoot);
      const entry = { path: '.claude/settings.json', category: 'settings', mode: 'settings-merge', substituteAt: 'never' };

      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: any) => chunk;
      try {
        await mergeSettings(ctx, entry, '.claude/settings.json');
      } finally {
        process.stdout.write = origWrite;
      }

      // Read the written file and compute its hash
      const writtenContent = await fsp.readFile(path.join(targetClaudeDir, 'settings.json'), 'utf8');
      const expectedHash = hashContent(normaliseContent(writtenContent));

      // State should record the same hash
      const stateEntry = ctx.state.files['.claude/settings.json'];
      assert.ok(stateEntry, 'state entry should exist for .claude/settings.json');
      assert.equal(stateEntry.lastAppliedHash, expectedHash);
    } finally {
      await fsp.rm(fwRoot, { recursive: true, force: true });
      await fsp.rm(targetRoot, { recursive: true, force: true });
    }
  });
});
