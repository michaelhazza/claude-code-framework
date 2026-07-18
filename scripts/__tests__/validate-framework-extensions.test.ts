/**
 * Tests for the three validate-framework.js extension checks:
 *   - checkAgentFrontmatter (agent fleet frontmatter gate)
 *   - checkHookWiring       (settings.json <-> .claude/hooks/ both directions)
 *   - checkAdrIndex         (manifest "adr" set <-> index rows <-> disk files)
 *
 * Runner: Vitest (per docs/testing-conventions.md).
 *
 * Every test runs the check functions against a fixture tree built under a
 * fresh os.tmpdir() directory — the repo itself is never mutated. The checks
 * take (root, errs) parameters for exactly this purpose; the CLI entry point
 * passes the real repo root and the shared errors array.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  checkAgentFrontmatter,
  checkHookWiring,
  checkAdrIndex,
} = require('../validate-framework.js');

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'vf-ext-fixture-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function agentMd(name: string, opts: { description?: string; extra?: string } = {}): string {
  const description = opts.description ?? 'Does one focused thing for the fleet.';
  return `---\nname: ${name}\ndescription: ${description}\n${opts.extra ?? ''}---\n\nAgent body.\n`;
}

// ── checkAgentFrontmatter ───────────────────────────────────────────────────

describe('checkAgentFrontmatter', () => {
  it('passes a well-formed fleet and returns the agent count', () => {
    write('.claude/agents/architect.md', agentMd('architect', { extra: 'tools: Read, Glob, Grep\nmodel: opus\n' }));
    write('.claude/agents/builder.md', agentMd('builder', { extra: 'tools: Read, Edit, Bash, TodoWrite\nmodel: sonnet\n' }));
    write('.claude/agents/context-pack-loader.md', agentMd('context-pack-loader', { extra: 'model: inherit\n' }));
    const errs: string[] = [];
    const count = checkAgentFrontmatter(root, errs);
    expect(errs).toEqual([]);
    expect(count).toBe(3);
  });

  it('fails loudly when .claude/agents/ is missing', () => {
    const errs: string[] = [];
    checkAgentFrontmatter(root, errs);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/agent-frontmatter: .*\.claude\/agents\/ not found/);
  });

  it('fails loudly when the agents dir contains no .md files', () => {
    mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
    const errs: string[] = [];
    checkAgentFrontmatter(root, errs);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/no agent \.md files found/);
  });

  it('reports a file with no frontmatter block', () => {
    write('.claude/agents/broken.md', 'No frontmatter here.\n');
    const errs: string[] = [];
    checkAgentFrontmatter(root, errs);
    expect(errs.some((e) => e.includes('broken.md has no frontmatter block'))).toBe(true);
  });

  it('reports name/filename-stem mismatch', () => {
    write('.claude/agents/architect.md', agentMd('builder'));
    const errs: string[] = [];
    checkAgentFrontmatter(root, errs);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('"name" is "builder" but filename stem is "architect"');
  });

  it('reports missing description per file', () => {
    write('.claude/agents/a.md', '---\nname: a\n---\n\nBody.\n');
    write('.claude/agents/b.md', agentMd('b'));
    const errs: string[] = [];
    checkAgentFrontmatter(root, errs);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('.claude/agents/a.md missing non-empty "description"');
  });

  it('reports an empty model key and a malformed model value', () => {
    write('.claude/agents/a.md', agentMd('a', { extra: 'model:\n' }));
    write('.claude/agents/b.md', agentMd('b', { extra: 'model: opus sonnet\n' }));
    const errs: string[] = [];
    checkAgentFrontmatter(root, errs);
    expect(errs.some((e) => e.includes('a.md has an empty "model" key'))).toBe(true);
    expect(errs.some((e) => e.includes('b.md "model" is malformed: "opus sonnet"'))).toBe(true);
  });

  it('reports empty and malformed tools entries', () => {
    write('.claude/agents/a.md', agentMd('a', { extra: 'tools:\n' }));
    write('.claude/agents/b.md', agentMd('b', { extra: 'tools: Read,, Grep\n' }));
    write('.claude/agents/c.md', agentMd('c', { extra: 'tools: Read Glob, Grep\n' }));
    const errs: string[] = [];
    checkAgentFrontmatter(root, errs);
    expect(errs.some((e) => e.includes('a.md has an empty "tools" key'))).toBe(true);
    expect(errs.some((e) => e.includes('b.md "tools" has an empty entry'))).toBe(true);
    expect(errs.some((e) => e.includes('c.md "tools" entry is malformed: "Read Glob"'))).toBe(true);
  });

  it('ignores the _retired/ subdir and *.md.retired renames', () => {
    write('.claude/agents/active.md', agentMd('active'));
    // Retired agent under _retired/: frontmatter name no longer matches the
    // dated filename stem — must NOT be validated.
    write('.claude/agents/_retired/reality-checker-2026-06-18.md', agentMd('reality-checker'));
    // .md.retired rename at top level (v2.43.0 retirement shape) — skipped.
    write('.claude/agents/old-agent.md.retired', 'no frontmatter at all');
    const errs: string[] = [];
    const count = checkAgentFrontmatter(root, errs);
    expect(errs).toEqual([]);
    expect(count).toBe(1);
  });
});

// ── checkHookWiring ─────────────────────────────────────────────────────────

function settingsWith(commands: string[]): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: commands.map((command) => ({ type: 'command', command })),
        },
      ],
    },
  });
}

describe('checkHookWiring', () => {
  it('passes when every registered path exists and every entry hook is registered', () => {
    write(
      '.claude/settings.json',
      settingsWith([
        'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/guard.js',
        // braced-variable variant must also resolve
        'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/nudge.js"',
      ]),
    );
    write('.claude/hooks/guard.js', "'use strict';\n");
    write('.claude/hooks/nudge.js', "'use strict';\n");
    write('.claude/hooks/guard.test.js', '// test file, not an entry hook\n');
    write('.claude/hooks/package.json', '{"type": "module"}\n');
    const errs: string[] = [];
    const count = checkHookWiring(root, errs);
    expect(errs).toEqual([]);
    expect(count).toBe(2);
  });

  it('fails loudly when settings.json is missing', () => {
    write('.claude/hooks/guard.js', "'use strict';\n");
    const errs: string[] = [];
    checkHookWiring(root, errs);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/settings\.json not found/);
  });

  it('fails loudly when settings.json has no hooks registrations', () => {
    write('.claude/settings.json', '{}');
    const errs: string[] = [];
    checkHookWiring(root, errs);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/no "hooks" registrations/);
  });

  it('fails loudly when settings.json is invalid JSON', () => {
    write('.claude/settings.json', '{not json');
    const errs: string[] = [];
    checkHookWiring(root, errs);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/not valid JSON/);
  });

  it('reports a registered command whose file does not exist', () => {
    write('.claude/settings.json', settingsWith(['node "$CLAUDE_PROJECT_DIR"/.claude/hooks/gone.js']));
    mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });
    write('.claude/hooks/present.js', "'use strict';\n");
    const errs: string[] = [];
    checkHookWiring(root, errs);
    expect(errs.some((e) => e.includes('registers ".claude/hooks/gone.js" which does not exist'))).toBe(true);
  });

  it('reports an unregistered hook implementation (an unregistered hook ships dead)', () => {
    write('.claude/settings.json', settingsWith(['node "$CLAUDE_PROJECT_DIR"/.claude/hooks/wired.js']));
    write('.claude/hooks/wired.js', "'use strict';\n");
    write('.claude/hooks/dead.js', "'use strict';\n");
    const errs: string[] = [];
    checkHookWiring(root, errs);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('.claude/hooks/dead.js is not registered');
    expect(errs[0]).toContain('ships dead');
  });

  it('fails loudly when .claude/hooks/ is missing', () => {
    write('.claude/settings.json', settingsWith(['node "$CLAUDE_PROJECT_DIR"/.claude/hooks/guard.js']));
    const errs: string[] = [];
    checkHookWiring(root, errs);
    // the registered-path failure fires too; the dir failure must be present
    expect(errs.some((e) => e.includes('.claude/hooks/ not found'))).toBe(true);
  });

  it('skips shared libraries listed under hookLibraries in the allowlist', () => {
    write('.claude/settings.json', settingsWith(['node "$CLAUDE_PROJECT_DIR"/.claude/hooks/entry.js']));
    write('.claude/hooks/entry.js', "'use strict';\nrequire('./lib-shared.js');\n");
    write('.claude/hooks/lib-shared.js', "'use strict';\nmodule.exports = {};\n");
    write('scripts/validate-framework-allowlist.json', JSON.stringify({ hookLibraries: ['.claude/hooks/lib-shared.js'] }));
    const errs: string[] = [];
    const count = checkHookWiring(root, errs);
    expect(errs).toEqual([]);
    expect(count).toBe(1); // the library does not count as an entry hook
  });

  it('flags stale hookLibraries entries (file missing, or actually registered)', () => {
    write(
      '.claude/settings.json',
      settingsWith(['node "$CLAUDE_PROJECT_DIR"/.claude/hooks/entry.js']),
    );
    write('.claude/hooks/entry.js', "'use strict';\n");
    write(
      'scripts/validate-framework-allowlist.json',
      JSON.stringify({ hookLibraries: ['.claude/hooks/never-existed.js', '.claude/hooks/entry.js'] }),
    );
    const errs: string[] = [];
    checkHookWiring(root, errs);
    expect(errs.some((e) => e.includes('stale hookLibraries allowlist entry ".claude/hooks/never-existed.js"') && e.includes('no such file'))).toBe(true);
    expect(errs.some((e) => e.includes('stale hookLibraries allowlist entry ".claude/hooks/entry.js"') && e.includes('registered in settings.json'))).toBe(true);
  });
});

// ── checkAdrIndex ───────────────────────────────────────────────────────────

function adrManifest(paths: string[]): string {
  return JSON.stringify({
    managedFiles: paths.map((p) => ({ path: p, category: 'adr' })),
  });
}

function adrReadme(rows: string[], extra = ''): string {
  return [
    '# Decisions (ADRs)',
    '',
    '## Index',
    '',
    '| ADR | Title | Status | Domain |',
    '|-----|-------|--------|--------|',
    ...rows,
    '',
    extra,
  ].join('\n');
}

describe('checkAdrIndex', () => {
  it('passes when manifest globs, index rows, and disk files all agree', () => {
    write('manifest.json', adrManifest(['docs/decisions/0001-*.md', 'docs/decisions/0002-*.md', 'docs/decisions/README.md']));
    write('docs/decisions/0001-first-choice.md', '# ADR 0001\n');
    write('docs/decisions/0002-second-choice.md', '# ADR 0002\n');
    write('docs/decisions/_template.md', '# template — not an ADR\n');
    write(
      'docs/decisions/README.md',
      adrReadme([
        '| [0001](./0001-first-choice.md) | First | accepted | x |',
        '| [0002](./0002-second-choice.md) | Second | accepted | y |',
      ]),
    );
    const errs: string[] = [];
    const count = checkAdrIndex(root, errs);
    expect(errs).toEqual([]);
    expect(count).toBe(2);
  });

  it('fails loudly when manifest.json is unreadable', () => {
    const errs: string[] = [];
    checkAdrIndex(root, errs);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/adr-index: manifest\.json unreadable/);
  });

  it('fails loudly when the manifest has no category "adr" entries', () => {
    write('manifest.json', JSON.stringify({ managedFiles: [{ path: 'README.md', category: 'doc' }] }));
    const errs: string[] = [];
    checkAdrIndex(root, errs);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/no category "adr" entries/);
  });

  it('reports a manifest adr glob that matches nothing on disk', () => {
    write('manifest.json', adrManifest(['docs/decisions/0001-*.md', 'docs/decisions/0007-*.md', 'docs/decisions/README.md']));
    write('docs/decisions/0001-first-choice.md', '# ADR 0001\n');
    write('docs/decisions/README.md', adrReadme(['| [0001](./0001-first-choice.md) | First | accepted | x |']));
    const errs: string[] = [];
    checkAdrIndex(root, errs);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('"docs/decisions/0007-*.md" matches no file on disk');
  });

  it('fails loudly when the index README is missing', () => {
    write('manifest.json', adrManifest(['docs/decisions/0001-*.md']));
    write('docs/decisions/0001-first-choice.md', '# ADR 0001\n');
    const errs: string[] = [];
    checkAdrIndex(root, errs);
    expect(errs.some((e) => e.includes('docs/decisions/README.md not found — the ADR index is missing'))).toBe(true);
  });

  it('fails loudly when the README has no parseable index rows', () => {
    write('manifest.json', adrManifest(['docs/decisions/0001-*.md', 'docs/decisions/README.md']));
    write('docs/decisions/0001-first-choice.md', '# ADR 0001\n');
    write('docs/decisions/README.md', '# Decisions\n\nProse only, no table.\n');
    const errs: string[] = [];
    checkAdrIndex(root, errs);
    expect(errs.some((e) => e.includes('contains no parseable index rows'))).toBe(true);
  });

  it('reports an index row pointing at a missing file', () => {
    write('manifest.json', adrManifest(['docs/decisions/0001-*.md', 'docs/decisions/README.md']));
    write('docs/decisions/0001-first-choice.md', '# ADR 0001\n');
    write(
      'docs/decisions/README.md',
      adrReadme([
        '| [0001](./0001-first-choice.md) | First | accepted | x |',
        '| [0003](./0003-ghost.md) | Ghost | accepted | y |',
      ]),
    );
    const errs: string[] = [];
    checkAdrIndex(root, errs);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('[0003](./0003-ghost.md) points at a missing file');
  });

  it('reports a disk ADR that has no index row', () => {
    write('manifest.json', adrManifest(['docs/decisions/0001-*.md', 'docs/decisions/README.md']));
    write('docs/decisions/0001-first-choice.md', '# ADR 0001\n');
    write('docs/decisions/0004-unindexed.md', '# ADR 0004\n');
    write('docs/decisions/README.md', adrReadme(['| [0001](./0001-first-choice.md) | First | accepted | x |']));
    const errs: string[] = [];
    checkAdrIndex(root, errs);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('docs/decisions/0004-unindexed.md exists on disk but has no index row');
  });

  it('reports link text that does not match the file number prefix', () => {
    write('manifest.json', adrManifest(['docs/decisions/0001-*.md', 'docs/decisions/README.md']));
    write('docs/decisions/0001-first-choice.md', '# ADR 0001\n');
    write('docs/decisions/README.md', adrReadme(['| [0009](./0001-first-choice.md) | First | accepted | x |']));
    const errs: string[] = [];
    checkAdrIndex(root, errs);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('link text does not match');
  });

  it('ignores illustrative rows inside fenced code blocks', () => {
    write('manifest.json', adrManifest(['docs/decisions/0001-*.md', 'docs/decisions/README.md']));
    write('docs/decisions/0001-first-choice.md', '# ADR 0001\n');
    write(
      'docs/decisions/README.md',
      adrReadme(
        ['| [0001](./0001-first-choice.md) | First | accepted | x |'],
        '```\n| [0099](./0099-example-only.md) | Example | proposed | z |\n```\n',
      ),
    );
    const errs: string[] = [];
    checkAdrIndex(root, errs);
    expect(errs).toEqual([]);
  });
});
