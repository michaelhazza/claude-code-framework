/**
 * audit-context-packs.test.ts
 *
 * Pure-function tests for auditContextPacks (Contract 4).
 * Run via: npx tsx scripts/__tests__/audit-context-packs.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditContextPacks } from '../audit-context-packs.js';

// ---------------------------------------------------------------------------
// Test 1: Empty packs → ok
// ---------------------------------------------------------------------------
test('empty packs returns ok', () => {
  const result = auditContextPacks({ packs: [], architectureMarkdown: '' });
  assert.deepEqual(result, { kind: 'ok' });
});

// ---------------------------------------------------------------------------
// Test 2: Markdown-link reference to a present heading anchor → ok
// ---------------------------------------------------------------------------
test('markdown link to present heading anchor returns ok', () => {
  const arch = '# Overview\n\nSome content.\n\n## Key Concepts\n\nMore content.\n';
  const pack = '[see section](architecture.md#key-concepts)\n';
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.deepEqual(result, { kind: 'ok' });
});

// ---------------------------------------------------------------------------
// Test 3: Markdown link to missing anchor → fail with correct miss
// ---------------------------------------------------------------------------
test('markdown link to missing anchor returns fail', () => {
  const arch = '# Overview\n';
  const pack = '[see section](architecture.md#nonexistent-section)\n';
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.equal(result.kind, 'fail');
  if (result.kind !== 'fail') return;
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].anchor, 'nonexistent-section');
  assert.equal(result.missing[0].pack, 'review.md');
  assert.equal(result.missing[0].line, 1);
});

// ---------------------------------------------------------------------------
// Test 4: Duplicate headings get GFM suffix -1, -2
// ---------------------------------------------------------------------------
test('duplicate heading slugs get numeric suffixes', () => {
  const arch = '# Setup\n\nContent A.\n\n## Setup\n\nContent B.\n\n### Setup\n\nContent C.\n';
  // First "Setup" → #setup, second → #setup-1, third → #setup-2
  const pack = [
    '[first](architecture.md#setup)',
    '[second](architecture.md#setup-1)',
    '[third](architecture.md#setup-2)',
  ].join('\n');
  const result = auditContextPacks({
    packs: [{ path: 'minimal.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.deepEqual(result, { kind: 'ok' });
});

// ---------------------------------------------------------------------------
// Test 5: Anchors inside GFM fenced blocks are NOT treated as references
// ---------------------------------------------------------------------------
test('anchors inside fenced code blocks are ignored', () => {
  const arch = '# Real Section\n';
  // The markdown link inside the fence should NOT be extracted as a ref.
  const pack = [
    'Some intro text.',
    '```markdown',
    '[example](architecture.md#fake-anchor)',
    '```',
    'End of file.',
  ].join('\n');
  const result = auditContextPacks({
    packs: [{ path: 'implement.md', content: pack }],
    architectureMarkdown: arch,
  });
  // fake-anchor is NOT in architecture.md, but it's inside a fence → no miss.
  assert.deepEqual(result, { kind: 'ok' });
});

// ---------------------------------------------------------------------------
// Test 6: Bare-fragment form under source-block heading
// ---------------------------------------------------------------------------
test('bare fragment under architecture.md source-block heading is extracted', () => {
  const arch = '# Services Layer\n\nContent.\n';
  const pack = [
    '- `architecture.md`:',
    '  - `#services-layer` — core service conventions',
  ].join('\n');
  const result = auditContextPacks({
    packs: [{ path: 'debug.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.deepEqual(result, { kind: 'ok' });
});

// ---------------------------------------------------------------------------
// Test 7: Bare fragment with broken anchor → fail
// ---------------------------------------------------------------------------
test('bare fragment with missing anchor returns fail', () => {
  const arch = '# Services Layer\n\nContent.\n';
  const pack = [
    '- `architecture.md`:',
    '  - `#totally-missing` — does not exist',
  ].join('\n');
  const result = auditContextPacks({
    packs: [{ path: 'debug.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.equal(result.kind, 'fail');
  if (result.kind !== 'fail') return;
  assert.equal(result.missing[0].anchor, 'totally-missing');
});

// ---------------------------------------------------------------------------
// Test 8: Explicit <a id="..."></a> anchor is found
// ---------------------------------------------------------------------------
test('<a id> anchor is resolved', () => {
  const arch = '<a id="custom-anchor"></a>\n# Some Heading\n';
  const pack = '[link](architecture.md#custom-anchor)\n';
  const result = auditContextPacks({
    packs: [{ path: 'handover.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.deepEqual(result, { kind: 'ok' });
});

// ---------------------------------------------------------------------------
// Test 9: Empty architectureMarkdown with pack containing refs → fail
// ---------------------------------------------------------------------------
test('empty architecture.md with pack anchor refs returns fail', () => {
  const pack = '[see section](architecture.md#any-section)\n';
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: '',
  });
  assert.equal(result.kind, 'fail');
  if (result.kind !== 'fail') return;
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].anchor, 'any-section');
});

// ---------------------------------------------------------------------------
// Test 10: Fragment-only link form [text](#anchor) also works
// ---------------------------------------------------------------------------
test('fragment-only markdown link [text](#anchor) is extracted', () => {
  const arch = '# Authentication\n\nContent.\n';
  const pack = '[see authentication](#authentication)\n';
  const result = auditContextPacks({
    packs: [{ path: 'minimal.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.deepEqual(result, { kind: 'ok' });
});

// ---------------------------------------------------------------------------
// Test 11: Multiple packs — one clean, one with miss
// ---------------------------------------------------------------------------
test('multiple packs — one miss surfaces with correct pack name', () => {
  const arch = '# Setup\n\nContent.\n';
  const clean = '[setup](architecture.md#setup)\n';
  const broken = '[missing](architecture.md#no-such-section)\n';
  const result = auditContextPacks({
    packs: [
      { path: 'implement.md', content: clean },
      { path: 'review.md', content: broken },
    ],
    architectureMarkdown: arch,
  });
  assert.equal(result.kind, 'fail');
  if (result.kind !== 'fail') return;
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].pack, 'review.md');
  assert.equal(result.missing[0].anchor, 'no-such-section');
});
