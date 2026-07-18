/**
 * Tests for scripts/audit-consumer-state.js — the deterministic consumer-drift
 * audit. Runner: Vitest (auto-discovered by scripts/run-tests.js).
 *
 * Each test builds a throwaway fixture CONSUMER repo (with its own mounted
 * fixture framework at <consumer>/.claude-framework) under os.tmpdir(), runs
 * the audit read-only against it, and asserts on the findings. Covers the
 * happy path plus every failure mode the audit exists to detect:
 * state corruption (field-level schema errors), unsubstituted placeholders,
 * stale substitution hash, state-vs-disk drift in both directions, syncIgnore
 * rot, migration drift in both directions, orphaned .framework-new files, and
 * dead settings.json hook paths — plus fail-closed behaviour and the CLI
 * (--json, exit codes).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import * as path from 'path';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const audit = require('../audit-consumer-state.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { hashSubstitutions } = require('../../sync.js');

const SCRIPT_PATH = path.resolve(__dirname, '..', 'audit-consumer-state.js');
const HASH = 'a'.repeat(64);

// --- fixture machinery ------------------------------------------------------

interface Fixture {
  root: string;
  repo: string;
  fw: string;
  state: Record<string, any>;
}

const fixtures: string[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    rmSync(fixtures.pop() as string, { recursive: true, force: true });
  }
});

function write(p: string, content: string): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function writeJson(p: string, obj: unknown): void {
  write(p, JSON.stringify(obj, null, 2) + '\n');
}

function fileEntry(sourcePath: string, overrides: Record<string, unknown> = {}) {
  return {
    lastAppliedHash: HASH,
    lastAppliedFrameworkVersion: '9.9.9',
    lastAppliedFrameworkCommit: null,
    lastAppliedSourcePath: sourcePath,
    customisedLocally: false,
    ...overrides,
  };
}

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'audit-consumer-'));
  fixtures.push(root);
  const repo = path.join(root, 'consumer');
  const fw = path.join(repo, '.claude-framework');

  // Fixture framework mount (manifest + framework-side copies of managed files)
  writeJson(path.join(fw, 'manifest.json'), {
    frameworkVersion: '9.9.9',
    managedFiles: [
      { path: '.claude/agents/*.md', category: 'agent', mode: 'sync', substituteAt: 'adoption' },
      { path: '.claude/hooks/guard.js', category: 'hook', mode: 'sync', substituteAt: 'never' },
    ],
    removedFiles: [],
    doNotTouch: [],
  });
  write(path.join(fw, '.claude', 'FRAMEWORK_VERSION'), '9.9.9\n');
  write(path.join(fw, '.claude', 'agents', 'helper.md'), '# {{PROJECT_NAME}} helper\n');
  write(path.join(fw, '.claude', 'hooks', 'guard.js'), '// framework guard {{var}}\n');
  write(path.join(fw, 'migrations', 'v9.9.0.js'), 'module.exports.migrate = async () => ({ status: "applied", notes: [] });\n');
  write(path.join(fw, 'migrations', 'v9.9.9.js'), 'module.exports.migrate = async () => ({ status: "applied", notes: [] });\n');

  // Consumer copies (post-substitution)
  write(path.join(repo, '.claude', 'agents', 'helper.md'), '# Acme helper\n');
  write(path.join(repo, '.claude', 'hooks', 'guard.js'), '// framework guard {{var}}\n');

  const substitutions = { PROJECT_NAME: 'Acme' };
  const state: Record<string, any> = {
    frameworkVersion: '9.9.9',
    adoptedAt: '2026-01-01T00:00:00.000Z',
    adoptedFromCommit: null,
    profile: 'STANDARD',
    substitutions,
    lastSubstitutionHash: hashSubstitutions(substitutions),
    files: {
      '.claude/agents/helper.md': fileEntry('.claude/agents/*.md'),
      '.claude/hooks/guard.js': fileEntry('.claude/hooks/guard.js'),
    },
    syncIgnore: [],
    appliedMigrations: ['9.9.0', '9.9.9'],
  };
  writeJson(path.join(repo, '.claude', '.framework-state.json'), state);

  writeJson(path.join(repo, '.claude', 'settings.json'), {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/guard.js' }],
        },
      ],
      SessionStart: [
        { hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.js' }] },
      ],
    },
  });

  return { root, repo, fw, state };
}

function saveState(fx: Fixture): void {
  writeJson(path.join(fx.repo, '.claude', '.framework-state.json'), fx.state);
}

function run(fx: Fixture, extra: Record<string, unknown> = {}) {
  // adoptionVersion: null bypasses git resolution (fixture frameworks are not
  // git checkouts); individual tests override it to exercise the known-baseline path.
  return audit.runAudit({ repoRoot: fx.repo, frameworkRoot: fx.fw, adoptionVersion: null, ...extra });
}

function byCheck(result: any, check: string, severity?: string) {
  return result.findings.filter(
    (f: any) => f.check === check && (severity === undefined || f.severity === severity),
  );
}

// --- happy path --------------------------------------------------------------

describe('happy path', () => {
  it('a fully consistent consumer yields zero blockers and zero warnings', () => {
    const fx = makeFixture();
    const result = run(fx);
    expect(result.counts.blocker).toBe(0);
    expect(result.counts.warn).toBe(0);
  });
});

// --- fail closed: state and manifest ------------------------------------------

describe('fail-closed behaviour', () => {
  it('missing state file is a blocker, not a skip', () => {
    const fx = makeFixture();
    unlinkSync(path.join(fx.repo, '.claude', '.framework-state.json'));
    const result = run(fx);
    expect(result.counts.blocker).toBeGreaterThan(0);
    const f = byCheck(result, 'state', 'blocker');
    expect(f.length).toBe(1);
    expect(f[0].message).toContain('--adopt');
  });

  it('unparseable state JSON is a blocker', () => {
    const fx = makeFixture();
    write(path.join(fx.repo, '.claude', '.framework-state.json'), '{ not json');
    const result = run(fx);
    expect(byCheck(result, 'state', 'blocker').length).toBe(1);
  });

  it('missing framework manifest is a blocker (fail closed, checks that need it are skipped)', () => {
    const fx = makeFixture();
    const emptyFw = path.join(fx.root, 'empty-framework');
    mkdirSync(emptyFw, { recursive: true });
    const result = run(fx, { frameworkRoot: emptyFw });
    const f = byCheck(result, 'manifest', 'blocker');
    expect(f.length).toBe(1);
    expect(f[0].message).toContain('Failing closed');
  });
});

// --- (a) schema validation ----------------------------------------------------

describe('state schema validation (field-level diagnosis)', () => {
  it('reports each invalid field as its own blocker with a JSON path', () => {
    const fx = makeFixture();
    fx.state.profile = 'CUSTOM';
    fx.state.lastSubstitutionHash = 'not-a-sha256';
    delete fx.state.files['.claude/agents/helper.md'].lastAppliedHash;
    saveState(fx);
    const result = run(fx);
    const messages = byCheck(result, 'state-schema', 'blocker').map((f: any) => f.message);
    expect(messages.some((m: string) => m.includes('/profile'))).toBe(true);
    expect(messages.some((m: string) => m.includes('/lastSubstitutionHash'))).toBe(true);
    expect(messages.some((m: string) => m.includes('lastAppliedHash'))).toBe(true);
  });

  it('rejects path-escaping files keys (tampered state)', () => {
    const fx = makeFixture();
    fx.state.files['../evil.md'] = fileEntry('.claude/agents/*.md');
    saveState(fx);
    const result = run(fx);
    const messages = byCheck(result, 'state-schema', 'blocker').map((f: any) => f.message);
    expect(messages.some((m: string) => m.includes('evil.md'))).toBe(true);
  });

  it('flags unknown top-level keys as info, not blocker', () => {
    const fx = makeFixture();
    fx.state.someFutureField = true;
    saveState(fx);
    const result = run(fx);
    expect(result.counts.blocker).toBe(0);
    const f = byCheck(result, 'state-schema', 'info');
    expect(f.some((x: any) => x.message.includes('someFutureField'))).toBe(true);
  });
});

// --- (b) placeholder scan ------------------------------------------------------

describe('unsubstituted placeholder scan', () => {
  it('flags {{TOKENS}} in adoption-substituted files, distinguishing in-map vs missing keys', () => {
    const fx = makeFixture();
    write(path.join(fx.repo, '.claude', 'agents', 'helper.md'), '# {{PROJECT_NAME}} helper\nUses {{NOT_IN_MAP}}.\n');
    const result = run(fx);
    const f = byCheck(result, 'placeholders', 'warn');
    expect(f.length).toBe(1);
    expect(f[0].path).toBe('.claude/agents/helper.md');
    expect(f[0].message).toContain('{{PROJECT_NAME}}');
    expect(f[0].message).toContain('HAS a substitutions entry');
    expect(f[0].message).toContain('{{NOT_IN_MAP}}');
    expect(f[0].message).toContain('no substitutions entry');
  });

  it('ignores substituteAt: never files and lowercase template placeholders', () => {
    const fx = makeFixture();
    // guard.js is substituteAt: never — uppercase tokens there are NOT substitution targets
    write(path.join(fx.repo, '.claude', 'hooks', 'guard.js'), '// {{FOO}} and {{var}} and {slug}\n');
    const result = run(fx);
    expect(byCheck(result, 'placeholders').length).toBe(0);
  });
});

// --- substitution drift ---------------------------------------------------------

describe('substitution drift (stale lastSubstitutionHash)', () => {
  it('warns when substitutions changed without a rebaseline', () => {
    const fx = makeFixture();
    fx.state.substitutions = { PROJECT_NAME: 'Renamed Co' }; // hash left stale
    saveState(fx);
    const result = run(fx);
    const f = byCheck(result, 'substitution-drift', 'warn');
    expect(f.length).toBe(1);
    expect(f[0].message).toContain('--adopt');
  });

  it('treats an absent lastSubstitutionHash as info (forward-migration), not blocker', () => {
    const fx = makeFixture();
    delete fx.state.lastSubstitutionHash;
    saveState(fx);
    const result = run(fx);
    expect(result.counts.blocker).toBe(0);
    expect(byCheck(result, 'substitution-drift', 'info').length).toBe(1);
  });
});

// --- (c) state vs disk -----------------------------------------------------------

describe('state.files vs disk reconciliation', () => {
  it('warns when a state-tracked file is missing on disk', () => {
    const fx = makeFixture();
    unlinkSync(path.join(fx.repo, '.claude', 'hooks', 'guard.js'));
    const result = run(fx);
    const f = byCheck(result, 'state-vs-disk', 'warn');
    expect(f.length).toBe(1);
    expect(f[0].path).toBe('.claude/hooks/guard.js');
    expect(f[0].message).toContain('missing on disk');
  });

  it('warns when a managed file exists on disk with no state entry', () => {
    const fx = makeFixture();
    delete fx.state.files['.claude/hooks/guard.js'];
    saveState(fx);
    const result = run(fx);
    const f = byCheck(result, 'state-vs-disk', 'warn');
    expect(f.length).toBe(1);
    expect(f[0].path).toBe('.claude/hooks/guard.js');
    expect(f[0].message).toContain('no state entry');
  });

  it('reports orphan state entries (path no longer managed) as info', () => {
    const fx = makeFixture();
    fx.state.files['.claude/agents/ghost.md'] = fileEntry('.claude/agents/*.md');
    saveState(fx);
    write(path.join(fx.repo, '.claude', 'agents', 'ghost.md'), '# consumer-only\n');
    const result = run(fx);
    const f = byCheck(result, 'state-vs-disk', 'info').filter((x: any) => x.path === '.claude/agents/ghost.md');
    expect(f.length).toBe(1);
    expect(f[0].message).toContain('orphan state entry');
    expect(result.counts.warn).toBe(0);
  });

  it('aggregates not-yet-synced framework files as a single info naming the paths', () => {
    const fx = makeFixture();
    write(path.join(fx.fw, '.claude', 'agents', 'brand-new.md'), '# new in framework\n');
    const result = run(fx);
    expect(result.counts.warn).toBe(0);
    const f = byCheck(result, 'state-vs-disk', 'info');
    expect(f.length).toBe(1);
    expect(f[0].message).toContain('.claude/agents/brand-new.md');
  });
});

// --- (d) syncIgnore rot ------------------------------------------------------------

describe('syncIgnore rot', () => {
  it('warns on entries matching no managed path and infos on duplicates', () => {
    const fx = makeFixture();
    fx.state.syncIgnore = ['docs/never-managed.md', '.claude/agents/helper.md', 'docs/never-managed.md'];
    saveState(fx);
    const result = run(fx);
    const warns = byCheck(result, 'sync-ignore', 'warn');
    expect(warns.length).toBe(1);
    expect(warns[0].path).toBe('docs/never-managed.md');
    const dups = byCheck(result, 'sync-ignore', 'info');
    expect(dups.length).toBe(1);
    expect(dups[0].message).toContain('duplicate');
  });
});

// --- (e) migrations -----------------------------------------------------------------

describe('appliedMigrations vs migrations/ directory', () => {
  it('warns when an applied migration has no migration file', () => {
    const fx = makeFixture();
    fx.state.appliedMigrations = ['9.8.0', '9.9.0', '9.9.9'];
    saveState(fx);
    const result = run(fx);
    const f = byCheck(result, 'migrations', 'warn');
    expect(f.length).toBe(1);
    expect(f[0].message).toContain('v9.8.0');
    expect(f[0].message).toContain('does not exist');
  });

  it('warns on pending unapplied migrations when the adoption baseline is known', () => {
    const fx = makeFixture();
    fx.state.appliedMigrations = ['9.9.0'];
    saveState(fx);
    const result = run(fx, { adoptionVersion: '9.9.0' });
    const f = byCheck(result, 'migrations', 'warn');
    expect(f.length).toBe(1);
    expect(f[0].message).toContain('v9.9.9');
    expect(f[0].message).toContain('pending unapplied migration');
  });

  it('downgrades unapplied migrations to info when the adoption baseline is unknown', () => {
    const fx = makeFixture();
    fx.state.appliedMigrations = [];
    saveState(fx);
    const result = run(fx); // adoptionVersion: null — unknown baseline
    expect(byCheck(result, 'migrations', 'warn').length).toBe(0);
    const infos = byCheck(result, 'migrations', 'info');
    expect(infos.length).toBe(2);
    expect(infos[0].message).toContain('predate adoption');
  });

  it('flags duplicate appliedMigrations entries as info', () => {
    const fx = makeFixture();
    fx.state.appliedMigrations = ['9.9.0', '9.9.0', '9.9.9'];
    saveState(fx);
    const result = run(fx);
    const f = byCheck(result, 'migrations', 'info');
    expect(f.some((x: any) => x.message.includes('duplicate'))).toBe(true);
  });
});

// --- (f) .framework-new residue -------------------------------------------------------

describe('.framework-new residue', () => {
  it('warns on unresolved merges for tracked bases and flags orphans whose base is unknown', () => {
    const fx = makeFixture();
    write(path.join(fx.repo, '.claude', 'agents', 'helper.md.framework-new'), '# incoming\n');
    write(path.join(fx.repo, '.claude', 'lost', 'nobody.md.framework-new'), '# stranded\n');
    const result = run(fx);
    const f = byCheck(result, 'framework-new', 'warn');
    expect(f.length).toBe(2);
    const tracked = f.find((x: any) => x.path === '.claude/agents/helper.md.framework-new');
    const orphan = f.find((x: any) => x.path === '.claude/lost/nobody.md.framework-new');
    expect(tracked.message).toContain('unresolved');
    expect(orphan.message).toContain('ORPHANED');
  });
});

// --- (g) settings.json hook paths -------------------------------------------------------

describe('settings.json hook registrations', () => {
  it('warns when a hook command references a missing file', () => {
    const fx = makeFixture();
    writeJson(path.join(fx.repo, '.claude', 'settings.json'), {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/nope.js' }] },
        ],
      },
    });
    const result = run(fx);
    const f = byCheck(result, 'settings-hooks', 'warn');
    expect(f.length).toBe(1);
    expect(f[0].message).toContain('nope.js');
    expect(f[0].message).toContain('PreToolUse');
  });

  it('warns on unparseable settings.json', () => {
    const fx = makeFixture();
    write(path.join(fx.repo, '.claude', 'settings.json'), '{ nope');
    const result = run(fx);
    const f = byCheck(result, 'settings-hooks', 'warn');
    expect(f.length).toBe(1);
    expect(f[0].message).toContain('cannot parse');
  });

  it('extractHookCommandPaths handles both CLAUDE_PROJECT_DIR quoting dialects and relative paths', () => {
    const repoRoot = path.join('C:', 'x', 'repo');
    const a = audit.extractHookCommandPaths('node "$CLAUDE_PROJECT_DIR"/.claude/hooks/a.js', repoRoot);
    expect(a.length).toBe(1);
    expect(a[0].resolved).toBe(path.join(repoRoot, '.claude', 'hooks', 'a.js'));
    const b = audit.extractHookCommandPaths('node ${CLAUDE_PROJECT_DIR}/.claude/hooks/b.js --flag', repoRoot);
    expect(b.length).toBe(1);
    expect(b[0].resolved).toBe(path.join(repoRoot, '.claude', 'hooks', 'b.js'));
    const c = audit.extractHookCommandPaths('python scripts/check.py', repoRoot);
    expect(c.length).toBe(1);
    expect(c[0].resolved).toBe(path.join(repoRoot, 'scripts', 'check.py'));
    expect(audit.extractHookCommandPaths('echo hello', repoRoot).length).toBe(0);
  });
});

// --- CLI -----------------------------------------------------------------------------------

describe('CLI (--repo, --json, exit codes)', () => {
  it('exits 0 with parseable JSON on a clean consumer', () => {
    const fx = makeFixture();
    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--repo', fx.repo, '--json'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.counts.blocker).toBe(0);
    expect(Array.isArray(parsed.findings)).toBe(true);
  });

  it('exits 1 with blocker findings when the state file is missing', () => {
    const fx = makeFixture();
    unlinkSync(path.join(fx.repo, '.claude', '.framework-state.json'));
    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--repo', fx.repo, '--json'], { encoding: 'utf8' });
    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.counts.blocker).toBeGreaterThan(0);
    expect(parsed.findings.some((f: any) => f.check === 'state' && f.severity === 'blocker')).toBe(true);
  });

  it('exits 2 on an unknown flag', () => {
    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--bogus'], { encoding: 'utf8' });
    expect(res.status).toBe(2);
  });
});
