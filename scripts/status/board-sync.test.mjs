/**
 * board-sync.test.mjs
 *
 * Vitest coverage for the pure decision functions in board-sync.mjs
 * (§5.3/§7.4/§8.4). Deliberately does NOT shell out to `gh` — the thin I/O
 * layer (ghJson and its callers) is untested here by design; only the
 * exported pure functions are exercised, each with an injected `now` where
 * a clock is involved so nothing depends on the real wall clock.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCardBody,
  buildCardKey,
  canonicaliseRepo,
  chooseSurvivor,
  extractUpdatedAtFromBody,
  mapRecordToCard,
  parseOwnerRepoFromGitUrl,
  shouldArchive,
  shouldSkipStale,
  validateSlugMatchesDir,
} from './board-sync.mjs';

function baseRecord(overrides = {}) {
  return {
    contract_version: 'build-status.v1',
    slug: 'dev-pipeline-v2',
    title: 'Development Pipeline v2',
    classification: 'Major',
    phase: 'build',
    status: 'BUILDING',
    branch: 'claude/personal-ai-agent-system-1mqzyh',
    pr: null,
    gates: {},
    gate_evidence: {},
    blockers: [],
    summary: 'In progress.',
    updated_at: '2026-07-26T00:00:00Z',
    updated_by: 'builder',
    ...overrides,
  };
}

describe('canonicaliseRepo / buildCardKey', () => {
  it('repo-casing canonicalisation: Owner/Repo and owner/repo produce one key', () => {
    const keyUpper = buildCardKey('Owner/Repo', 'dev-pipeline-v2');
    const keyLower = buildCardKey('owner/repo', 'dev-pipeline-v2');
    expect(keyUpper).toBe(keyLower);
    expect(canonicaliseRepo('Owner/Repo')).toBe('owner/repo');
  });

  it('passes non-string input through unchanged', () => {
    expect(canonicaliseRepo(null)).toBe(null);
  });
});

describe('validateSlugMatchesDir', () => {
  it('returns null when slug matches the directory', () => {
    expect(validateSlugMatchesDir('dev-pipeline-v2', 'dev-pipeline-v2')).toBe(null);
  });

  it('slug-mismatch refusal: exact INVALID wording, matching C8 verbatim', () => {
    expect(validateSlugMatchesDir('different-slug', 'dir-a')).toBe(
      'slug different-slug does not match directory dir-a'
    );
  });
});

describe('mapRecordToCard', () => {
  it('record -> card mapping: status -> Status field/column, phase -> Phase field, body contents', () => {
    const record = baseRecord({
      status: 'REVIEWING',
      phase: 'review',
      branch: 'my-branch',
      pr: 42,
      blockers: [
        { id: 'b1', text: 'waiting on ops', raised_by: 'x', raised_at: '2026-07-25T00:00:00Z', cleared_at: null },
      ],
      updated_at: '2026-07-27T00:00:00Z',
      summary: 'Under review.',
    });

    const card = mapRecordToCard(record, 'Owner/Repo');

    expect(card.key).toBe('owner/repo::dev-pipeline-v2');
    expect(card.fields).toEqual({
      'Build Repo': 'owner/repo',  // NOT 'Repo' — reserved in Projects v2
      Slug: 'dev-pipeline-v2',
      Status: 'REVIEWING',
      Phase: 'review',
    });
    expect(card.body).toContain('**Branch:** my-branch');
    expect(card.body).toContain('**PR:** #42');
    expect(card.body).toContain('**Blockers:** 1');
    expect(card.body).toContain('- [open] waiting on ops');
    expect(card.body).toContain('**Updated:** 2026-07-27T00:00:00Z');
    expect(card.body).toContain('Under review.');
  });

  it('renders a null PR as "none" and zero blockers with no bullet lines', () => {
    const record = baseRecord({ pr: null, blockers: [] });
    const card = mapRecordToCard(record, 'owner/repo');
    expect(card.body).toContain('**PR:** none');
    expect(card.body).toContain('**Blockers:** 0');
  });
});

describe('extractUpdatedAtFromBody', () => {
  it('round-trips through buildCardBody', () => {
    const record = baseRecord({ updated_at: '2026-07-28T12:00:00Z' });
    const body = buildCardBody(record);
    expect(extractUpdatedAtFromBody(body)).toBe('2026-07-28T12:00:00Z');
  });

  it('returns null when the marker is absent (hand-edited card)', () => {
    expect(extractUpdatedAtFromBody('just some text')).toBe(null);
    expect(extractUpdatedAtFromBody(undefined)).toBe(null);
  });
});

describe('chooseSurvivor', () => {
  it('duplicate recovery: newest updated_at survives, the other is queued to archive', () => {
    const older = { id: 'PVTI_2', updated_at: '2026-07-20T00:00:00Z' };
    const newer = { id: 'PVTI_1', updated_at: '2026-07-25T00:00:00Z' };

    const { survivor, toArchive } = chooseSurvivor([older, newer]);

    expect(survivor).toBe(newer);
    expect(toArchive).toEqual([older]);
  });

  it('equal-updated_at tie-break: lowest card id wins (deterministic)', () => {
    const cardA = { id: 'PVTI_BBB', updated_at: '2026-07-25T00:00:00Z' };
    const cardB = { id: 'PVTI_AAA', updated_at: '2026-07-25T00:00:00Z' };

    const { survivor, toArchive } = chooseSurvivor([cardA, cardB]);

    expect(survivor).toBe(cardB); // 'PVTI_AAA' < 'PVTI_BBB'
    expect(toArchive).toEqual([cardA]);
  });

  it('is order-independent — same result regardless of input array order', () => {
    const cardA = { id: 'PVTI_BBB', updated_at: '2026-07-25T00:00:00Z' };
    const cardB = { id: 'PVTI_AAA', updated_at: '2026-07-25T00:00:00Z' };

    expect(chooseSurvivor([cardA, cardB]).survivor).toBe(chooseSurvivor([cardB, cardA]).survivor);
  });

  it('no existing cards -> no survivor, nothing to archive', () => {
    expect(chooseSurvivor([])).toEqual({ survivor: null, toArchive: [] });
  });
});

describe('shouldSkipStale', () => {
  it('stale-update skip: existing card newer than the incoming record -> skip', () => {
    const card = { id: 'PVTI_1', updated_at: '2026-07-27T00:00:00Z' };
    const record = baseRecord({ updated_at: '2026-07-26T00:00:00Z' });
    expect(shouldSkipStale(card, record)).toBe(true);
  });

  it('existing card older than the incoming record -> do not skip', () => {
    const card = { id: 'PVTI_1', updated_at: '2026-07-25T00:00:00Z' };
    const record = baseRecord({ updated_at: '2026-07-26T00:00:00Z' });
    expect(shouldSkipStale(card, record)).toBe(false);
  });

  it('no existing card -> never skip', () => {
    const record = baseRecord();
    expect(shouldSkipStale(null, record)).toBe(false);
  });

  it('existing card with unreadable updated_at (null) -> never treated as newer', () => {
    const card = { id: 'PVTI_1', updated_at: null };
    const record = baseRecord();
    expect(shouldSkipStale(card, record)).toBe(false);
  });
});

describe('shouldArchive', () => {
  it('archive-after-14-days boundary: 13 days elapsed -> no', () => {
    const record = baseRecord({ status: 'MERGED', updated_at: '2026-07-15T00:00:00Z' });
    const now = new Date('2026-07-28T00:00:00Z'); // 13 days later
    expect(shouldArchive(record, now)).toBe(false);
  });

  it('archive-after-14-days boundary: 15 days elapsed -> yes', () => {
    const record = baseRecord({ status: 'MERGED', updated_at: '2026-07-13T00:00:00Z' });
    const now = new Date('2026-07-28T00:00:00Z'); // 15 days later
    expect(shouldArchive(record, now)).toBe(true);
  });

  it('non-terminal status never archives, regardless of age', () => {
    const record = baseRecord({ status: 'BUILDING', updated_at: '2026-01-01T00:00:00Z' });
    const now = new Date('2026-07-28T00:00:00Z');
    expect(shouldArchive(record, now)).toBe(false);
  });

  it('ABANDONED is archivable the same as MERGED', () => {
    const record = baseRecord({ status: 'ABANDONED', updated_at: '2026-07-13T00:00:00Z' });
    const now = new Date('2026-07-28T00:00:00Z');
    expect(shouldArchive(record, now)).toBe(true);
  });
});

describe('parseOwnerRepoFromGitUrl', () => {
  it('parses an https origin URL', () => {
    expect(parseOwnerRepoFromGitUrl('https://github.com/michaelhazza/claude-code-framework.git')).toBe(
      'michaelhazza/claude-code-framework'
    );
  });

  it('parses an ssh origin URL', () => {
    expect(parseOwnerRepoFromGitUrl('git@github.com:michaelhazza/automation-v1.git')).toBe(
      'michaelhazza/automation-v1'
    );
  });

  it('returns null for a non-github remote', () => {
    expect(parseOwnerRepoFromGitUrl('https://gitlab.com/someone/somewhere.git')).toBe(null);
  });
});
