/**
 * status-contract.test.mjs
 *
 * The Ajv-available path is exercised incidentally by every other status test
 * (Ajv is installed in this repo). This file targets the path that is NOT
 * exercised by default and was therefore where the defect lived: the
 * **Ajv-unavailable structural floor**.
 *
 * External review round 4 found that the floor checked `blockers` was an array
 * but never the shape of its elements, so `blockers: [null]` passed and then
 * threw on `blocker.cleared_at` inside buildCardBody — surfacing to the
 * operator as a "gh failure", i.e. blaming GitHub for malformed local data. It
 * also missed `title`, `branch` and `pr`, all of which the card renderer
 * dereferences.
 *
 * Ajv is made unavailable with vi.doMock + resetModules so the floor runs for
 * real rather than being reimplemented in the test.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

/** A fresh copy of the module with `import('ajv')` forced to fail. */
async function loadWithoutAjv() {
  vi.resetModules();
  vi.doMock('ajv', () => {
    throw new Error('Cannot find module ajv');
  });
  return import('./status-contract.mjs');
}

/** A fresh copy with Ajv left alone. */
async function loadWithAjv() {
  vi.resetModules();
  vi.doUnmock('ajv');
  return import('./status-contract.mjs');
}

function validRecord(overrides = {}) {
  return {
    contract_version: 'build-status.v2',
    slug: 'build-a',
    title: 'A build',
    classification: 'Standard',
    phase: 'build',
    status: 'BUILDING',
    branch: 'claude/build-a',
    pr: null,
    gates: {},
    gate_evidence: {},
    blockers: [],
    summary: 'Working',
    updated_at: '2026-07-29T00:00:00Z',
    updated_by: 'feature-coordinator',
    ...overrides,
  };
}

function validBlocker(overrides = {}) {
  return {
    id: 'b1',
    text: 'waiting on review',
    raised_by: 'feature-coordinator',
    raised_at: '2026-07-29T00:00:00Z',
    cleared_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe('validateRecordShape — Ajv unavailable (the structural floor)', () => {
  it('confirms the floor is actually running, not Ajv', async () => {
    // If this ever reports a `schema-invalid:` prefix, Ajv loaded after all and
    // every other test in this block is testing the wrong code path.
    const { validateRecordShape } = await loadWithoutAjv();
    const error = await validateRecordShape(validRecord({ summary: 42 }));
    expect(error).toBeTruthy();
    expect(error).not.toContain('schema-invalid');
  });

  it('accepts a valid record', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    expect(await validateRecordShape(validRecord())).toBeNull();
  });

  it('accepts a valid record carrying blockers', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    const record = validRecord({
      blockers: [validBlocker(), validBlocker({ id: 'b2', cleared_at: '2026-07-29T01:00:00Z' })],
    });
    expect(await validateRecordShape(record)).toBeNull();
  });

  it('rejects blockers: [null] — the reported crash', async () => {
    // buildCardBody dereferences blocker.cleared_at and blocker.text on every
    // element. A null element threw, and the per-record catch reported it as a
    // gh failure.
    const { validateRecordShape } = await loadWithoutAjv();
    const error = await validateRecordShape(validRecord({ blockers: [null] }));
    expect(error).toBeTruthy();
    expect(error).toContain('blockers[0]');
  });

  it('rejects a blocker missing the fields the renderer reads', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    for (const missing of ['text', 'cleared_at']) {
      const blocker = validBlocker();
      delete blocker[missing];
      const error = await validateRecordShape(validRecord({ blockers: [blocker] }));
      expect(error, `blocker missing ${missing}`).toBeTruthy();
      expect(error).toContain(missing);
    }
  });

  it('rejects a blocker whose text is not a string', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    const error = await validateRecordShape(
      validRecord({ blockers: [validBlocker({ text: 42 })] })
    );
    expect(error).toContain('blockers[0].text');
  });

  it('rejects non-string title and branch — both dereferenced by the renderer', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    for (const key of ['title', 'branch', 'slug', 'status', 'phase', 'summary', 'updated_at']) {
      const error = await validateRecordShape(validRecord({ [key]: 42 }));
      expect(error, `${key} must be type-checked`).toContain(key);
    }
  });

  it('accepts pr as an integer or null, rejects anything else', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    expect(await validateRecordShape(validRecord({ pr: 733 }))).toBeNull();
    expect(await validateRecordShape(validRecord({ pr: null }))).toBeNull();
    expect(await validateRecordShape(validRecord({ pr: '733' }))).toContain('pr');
    expect(await validateRecordShape(validRecord({ pr: 7.5 }))).toContain('pr');
  });

  it('rejects a missing required key', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    for (const key of ['contract_version', 'title', 'branch', 'blockers', 'updated_by']) {
      const record = validRecord();
      delete record[key];
      expect(await validateRecordShape(record), key).toContain(key);
    }
  });

  it('does not treat null or an array as an object for `gates`', async () => {
    // JSON Schema's `object` excludes both; a plain typeof check does not.
    const { validateRecordShape } = await loadWithoutAjv();
    expect(await validateRecordShape(validRecord({ gates: null }))).toContain('gates');
    expect(await validateRecordShape(validRecord({ gates: [] }))).toContain('gates');
  });

  it('rejects a non-object record instead of throwing', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    for (const value of [null, 'a string', 42, []]) {
      expect(await validateRecordShape(value)).toContain('must be a JSON object');
    }
  });
});

describe('validateRecordShape — Ajv available', () => {
  it('accepts a valid record and rejects a malformed one', async () => {
    const { validateRecordShape } = await loadWithAjv();
    expect(await validateRecordShape(validRecord())).toBeNull();
    expect(await validateRecordShape(validRecord({ blockers: [null] }))).toBeTruthy();
  });

  it('agrees with the floor on the round-4 regression cases', async () => {
    // The two paths must not disagree about validity, or which one happened to
    // load becomes a correctness variable.
    const withAjv = await loadWithAjv();
    const cases = [
      validRecord(),
      validRecord({ blockers: [validBlocker()] }),
      validRecord({ blockers: [null] }),
      validRecord({ title: 42 }),
      validRecord({ pr: '733' }),
      validRecord({ gates: [] }),
    ];
    const ajvVerdicts = [];
    for (const record of cases) ajvVerdicts.push(await withAjv.validateRecordShape(record) === null);

    const withoutAjv = await loadWithoutAjv();
    const floorVerdicts = [];
    for (const record of cases) floorVerdicts.push(await withoutAjv.validateRecordShape(record) === null);

    expect(floorVerdicts).toEqual(ajvVerdicts);
  });
});

describe('readStatusEnum', () => {
  it('returns the nine v2 statuses in pipeline order', async () => {
    const { readStatusEnum } = await loadWithAjv();
    expect(await readStatusEnum()).toEqual([
      'SPECIFYING', 'PLANNING', 'BUILDING', 'REVIEWING', 'TESTING',
      'FINALISING', 'MERGE_READY', 'MERGED', 'ABANDONED',
    ]);
  });
});
