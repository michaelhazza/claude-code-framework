/**
 * validate-packet.test.mjs
 *
 * Proves acceptance §13.1: work-packet.example.json and the two
 * completion-packet fixtures (claude, openclaw) are schema-valid, and the
 * two completion fixtures are structurally comparable — same required keys,
 * same packet_id — differing only in runtime/commit_sha/changed_files
 * values.
 *
 * The Ajv-available path is exercised by the default `loadWithAjv` describe
 * block (Ajv is installed in this repo); `loadWithoutAjv` forces the
 * structural-floor path with vi.doMock + resetModules, matching the pattern
 * in scripts/status/status-contract.test.mjs.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);

async function loadFixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURES_DIR, name), 'utf8'));
}

/** A fresh copy of the module with `import('ajv')` forced to fail. */
async function loadWithoutAjv() {
  vi.resetModules();
  vi.doMock('ajv', () => {
    throw new Error('Cannot find module ajv');
  });
  return import('./validate-packet.mjs');
}

/** A fresh copy with Ajv left alone. */
async function loadWithAjv() {
  vi.resetModules();
  vi.doUnmock('ajv');
  return import('./validate-packet.mjs');
}

describe.each([
  ['Ajv available', loadWithAjv],
  ['Ajv unavailable (structural floor)', loadWithoutAjv],
])('validatePacket — %s', (_label, load) => {
  it('accepts the work-packet fixture', async () => {
    const { validatePacket } = await load();
    const packet = await loadFixture('work-packet.example.json');
    const result = await validatePacket('work', packet);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('accepts both completion-packet fixtures', async () => {
    const { validatePacket } = await load();
    const claude = await loadFixture('completion-packet.claude.json');
    const openclaw = await loadFixture('completion-packet.openclaw.json');
    expect((await validatePacket('completion', claude)).ok).toBe(true);
    expect((await validatePacket('completion', openclaw)).ok).toBe(true);
  });

  it('rejects a work packet missing a required key', async () => {
    const { validatePacket } = await load();
    const packet = await loadFixture('work-packet.example.json');
    delete packet.objective;
    const result = await validatePacket('work', packet);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a completion packet with a bad status enum', async () => {
    const { validatePacket } = await load();
    const packet = await loadFixture('completion-packet.claude.json');
    packet.status = 'DONE'; // not in the SUCCESS|PLAN_GAP|G1_FAILED enum
    const result = await validatePacket('completion', packet);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('status'))).toBe(true);
  });

  it('rejects a completion packet missing a required key', async () => {
    const { validatePacket } = await load();
    const packet = await loadFixture('completion-packet.claude.json');
    delete packet.summary;
    const result = await validatePacket('completion', packet);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-object packet instead of throwing', async () => {
    const { validatePacket } = await load();
    for (const value of [null, 'a string', 42, []]) {
      const result = await validatePacket('work', value);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects an unknown packet kind instead of throwing', async () => {
    const { validatePacket } = await load();
    const result = await validatePacket('bogus', {});
    expect(result.ok).toBe(false);
  });
});

describe('completion-packet fixtures — structural comparability (§13.1)', () => {
  /** Same sorted key set — the structural-equivalence bar the spec asks for. */
  function structurallyComparable(a, b) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    return keysA.length === keysB.length && keysA.every((k, i) => k === keysB[i]);
  }

  it('share the same packet_id', async () => {
    const claude = await loadFixture('completion-packet.claude.json');
    const openclaw = await loadFixture('completion-packet.openclaw.json');
    expect(claude.packet_id).toBe(openclaw.packet_id);
  });

  it('share the same structural key set', async () => {
    const claude = await loadFixture('completion-packet.claude.json');
    const openclaw = await loadFixture('completion-packet.openclaw.json');
    expect(structurallyComparable(claude, openclaw)).toBe(true);
  });

  it('differ only in runtime, commit_sha, and changed_files values', async () => {
    const claude = await loadFixture('completion-packet.claude.json');
    const openclaw = await loadFixture('completion-packet.openclaw.json');
    const runtimeSpecificKeys = new Set(['runtime', 'commit_sha', 'changed_files']);
    for (const key of Object.keys(claude)) {
      if (runtimeSpecificKeys.has(key)) continue;
      expect(claude[key], `${key} should not diverge`).toEqual(openclaw[key]);
    }
    expect(claude.runtime).not.toEqual(openclaw.runtime);
  });

  it('cannot pass structural comparison while their key sets diverge', async () => {
    // Guards the comparison helper itself: a deliberately divergent clone
    // must fail structurallyComparable, proving the two real fixtures are
    // not "comparable" merely because the helper never fails.
    const claude = await loadFixture('completion-packet.claude.json');
    const divergent = { ...claude };
    delete divergent.commit_sha;
    expect(structurallyComparable(claude, divergent)).toBe(false);
  });
});
