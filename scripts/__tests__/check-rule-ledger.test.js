/**
 * Tests for scripts/check-rule-ledger.js — the rule-ledger coverage checker.
 * Runner: Vitest (per docs/testing-conventions.md).
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

// check-rule-ledger.js is a CommonJS module; load it via createRequire.
const require = createRequire(import.meta.url);
const { slugify, extractHeadingSlugs, parseLedgerAnchors, pass2 } = require('../check-rule-ledger.js');

describe('slugify — parity with the ledger preamble algorithm', () => {
  it('lowercases, strips punctuation, collapses spaces to hyphens', () => {
    expect(slugify('Minimum TodoWrite skeleton (Step 1)')).toBe(
      'minimum-todowrite-skeleton-step-1'
    );
  });

  it('strips em-dashes and dots, collapsing the surrounding spaces', () => {
    // "Cross-repo prior art (for each approach) — added in v2.13.0"
    expect(slugify('Cross-repo prior art (for each approach) — added in v2.13.0')).toBe(
      'cross-repo-prior-art-for-each-approach-added-in-v2130'
    );
  });

  it('preserves internal hyphens (allow-list stays intact)', () => {
    expect(slugify('Pass 2: hard allow-list (F2, E3, E5)')).toBe('pass-2-hard-allow-list-f2-e3-e5');
  });
});

describe('extractHeadingSlugs — ordinals, frontmatter, code fences', () => {
  it('applies ordinal suffixes to repeated heading slugs in document order', () => {
    const md = ['# Rules', '## Notes', '## Notes', '## Notes'].join('\n');
    expect(extractHeadingSlugs(md).slugs).toEqual(['rules', 'notes', 'notes-2', 'notes-3']);
  });

  it('skips YAML frontmatter and fenced code blocks', () => {
    const md = [
      '---',
      'title: Something',
      '## Not a heading (frontmatter)',
      '---',
      '# Real heading',
      '```',
      '## fenced not a heading',
      '```',
      '## After fence',
    ].join('\n');
    expect(extractHeadingSlugs(md).slugs).toEqual(['real-heading', 'after-fence']);
  });

  it('ignores headings deeper than level 4', () => {
    const md = ['#### Level four', '##### Level five'].join('\n');
    expect(extractHeadingSlugs(md).slugs).toEqual(['level-four']);
  });
});

describe('parseLedgerAnchors', () => {
  it('extracts path-shaped backticked anchors and splits file/slug', () => {
    const ledger = [
      '| anchor | rule | class | notes |',
      '|---|---|---|---|',
      '| `.claude/agents/foo.md#trigger` | directives | process-contract |  |',
      '| `.claude/hooks/bar.js` | hook contract | durable-invariant |  |',
      '| durable-invariant | 104 |', // summary row — must be ignored
    ].join('\n');
    const rows = parseLedgerAnchors(ledger);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ file: '.claude/agents/foo.md', slug: 'trigger' });
    expect(rows[1]).toMatchObject({ file: '.claude/hooks/bar.js', slug: null });
  });
});

// --- pass2 against a fixture file+ledger pair --------------------------------

function withTempRepo(files, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const FIXTURE_MD = ['# Alpha', '## Beta gamma', '## Beta gamma'].join('\n');

describe('pass2 — heading coverage (a) + anchor resolution (b)', () => {
  it('passes when the ledger covers every heading and every anchor resolves', () => {
    withTempRepo({ 'agents/sample.md': FIXTURE_MD }, (dir) => {
      const rows = parseLedgerAnchors(
        [
          '| `agents/sample.md#alpha` | r | process-contract |  |',
          '| `agents/sample.md#beta-gamma` | r | process-contract |  |',
          '| `agents/sample.md#beta-gamma-2` | r | process-contract |  |',
        ].join('\n')
      );
      const res = pass2(['agents/sample.md'], rows, dir);
      expect(res.ok).toBe(true);
      expect(res.failures).toEqual([]);
    });
  });

  it('fails (a) when a heading has no ledger row', () => {
    withTempRepo({ 'agents/sample.md': FIXTURE_MD }, (dir) => {
      const rows = parseLedgerAnchors(
        [
          '| `agents/sample.md#alpha` | r | process-contract |  |',
          '| `agents/sample.md#beta-gamma` | r | process-contract |  |',
          // missing beta-gamma-2
        ].join('\n')
      );
      const res = pass2(['agents/sample.md'], rows, dir);
      expect(res.ok).toBe(false);
      expect(res.failures).toContain('heading not in ledger: agents/sample.md#beta-gamma-2');
    });
  });

  it('fails (b) when a ledger anchor does not resolve to a real heading', () => {
    withTempRepo({ 'agents/sample.md': FIXTURE_MD }, (dir) => {
      const rows = parseLedgerAnchors(
        [
          '| `agents/sample.md#alpha` | r | process-contract |  |',
          '| `agents/sample.md#beta-gamma` | r | process-contract |  |',
          '| `agents/sample.md#beta-gamma-2` | r | process-contract |  |',
          '| `agents/sample.md#ghost-heading` | r | process-contract |  |',
        ].join('\n')
      );
      const res = pass2(['agents/sample.md'], rows, dir);
      expect(res.ok).toBe(false);
      expect(res.failures.some((f) => f.startsWith('anchor heading unresolved: agents/sample.md#ghost-heading'))).toBe(true);
    });
  });
});
