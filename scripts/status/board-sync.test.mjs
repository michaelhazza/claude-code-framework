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
  normaliseItem,
  parseOwnerRepoFromGitUrl,
  REPO_FIELD_NAME,
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

// Regression: pr-reviewer PR-003, 2026-07-28. The repo field was renamed
// 'Repo' -> 'Build Repo' (Projects v2 reserves 'Repo'), but only the create
// and write sites were updated; normaliseItem still read `item.Repo`. So
// item.repo was always null, every existing card was skipped as "not one of
// ours", and each sync created a DUPLICATE draft card -- with duplicate
// recovery, stale-skip and the MERGED auto-archive all unreachable. The old
// suite could not catch it: it asserted only the write key, and normaliseItem
// was not exported.
describe('upsert key: read side matches write side', () => {
  const record = {
    slug: 'dev-pipeline-v2',
    status: 'REVIEWING',
    phase: 'build',
    updated_at: '2026-07-28T00:00:00Z',
    summary: 's',
    blockers: [],
  };

  it('normaliseItem reads the same field name mapRecordToCard writes', () => {
    const card = mapRecordToCard(record, 'michaelhazza/automation-v1');
    expect(Object.keys(card.fields)).toContain(REPO_FIELD_NAME);

    const item = {
      id: 'PVTI_x',
      [REPO_FIELD_NAME]: card.fields[REPO_FIELD_NAME],
      Slug: card.fields.Slug,
      body: card.body,
    };
    expect(normaliseItem(item).repo).toBe('michaelhazza/automation-v1');
  });

  it('a card written by mapRecordToCard round-trips to the SAME key (no duplicate)', () => {
    const card = mapRecordToCard(record, 'michaelhazza/automation-v1');
    const item = {
      id: 'PVTI_x',
      [REPO_FIELD_NAME]: card.fields[REPO_FIELD_NAME],
      Slug: card.fields.Slug,
      body: card.body,
    };
    const normalised = normaliseItem(item);
    expect(buildCardKey(normalised.repo, normalised.slug)).toBe(card.key);
  });

  it('also reads the field from the nested fieldValues shape', () => {
    const item = {
      id: 'PVTI_y',
      fieldValues: { [REPO_FIELD_NAME]: 'Owner/Repo', Slug: 's' },
      body: '',
    };
    expect(normaliseItem(item).repo).toBe('owner/repo');
  });

  it('the legacy reserved name is NOT what the code reads', () => {
    // Guards the specific regression: an item carrying only the old 'Repo'
    // key must not resolve, otherwise the rename was never really applied.
    const item = { id: 'PVTI_z', Repo: 'Owner/Repo', Slug: 's', body: '' };
    expect(normaliseItem(item).repo).toBe(null);
  });

  // Regression: dual-reviewer, 2026-07-28. The three tests above build their
  // fixture item from REPO_FIELD_NAME, i.e. from the code's own constant, so
  // they assert the assumption instead of testing it and stayed green while
  // the read was broken against every real result. `gh project item-list
  // --format json` flattens custom fields onto the item and lower-cases only
  // the FIRST character of the display name, so the key is `build Repo`, not
  // `Build Repo`, and `slug`, not `Slug`. These fixtures are written out
  // literally, never derived from the constant, so they fail if the read side
  // regresses to an exact-display-name lookup.
  it('resolves the real gh item-list key shape (lower-cased first character)', () => {
    const item = {
      id: 'PVTI_gh',
      content: { type: 'DraftIssue' },
      title: 'dev-pipeline-v2: Development Pipeline v2',
      'build Repo': 'michaelhazza/automation-v1',
      slug: 'dev-pipeline-v2',
      status: 'REVIEWING',
      body: '<!-- board-sync:v1 updated_at=2026-07-28T00:00:00Z -->',
    };
    const normalised = normaliseItem(item);
    expect(normalised.repo).toBe('michaelhazza/automation-v1');
    expect(normalised.slug).toBe('dev-pipeline-v2');
    expect(normalised.updated_at).toBe('2026-07-28T00:00:00Z');
  });

  it('a card written by mapRecordToCard round-trips through the gh key shape to the SAME key', () => {
    const card = mapRecordToCard(record, 'michaelhazza/automation-v1');
    const item = {
      id: 'PVTI_gh',
      'build Repo': card.fields[REPO_FIELD_NAME],
      slug: card.fields.Slug,
      body: card.body,
    };
    const normalised = normaliseItem(item);
    expect(buildCardKey(normalised.repo, normalised.slug)).toBe(card.key);
  });

  it('also resolves a camelCased key shape, so the read does not pin one transformation', () => {
    const item = { id: 'PVTI_c', buildRepo: 'Owner/Repo', slug: 's', body: '' };
    expect(normaliseItem(item).repo).toBe('owner/repo');
    expect(normaliseItem(item).slug).toBe('s');
  });

  it('prefers the exact field name over a looser match when a board carries both', () => {
    // An operator-added `BuildRepo` alongside the real `Build Repo` normalises
    // to the same key. Without precedence the winner would be whichever key gh
    // emitted first, so a card could bind a different field from run to run.
    const item = {
      id: 'PVTI_dup',
      BuildRepo: 'wrong/field',
      'Build Repo': 'right/field',
      Slug: 's',
      body: '',
    };
    expect(normaliseItem(item).repo).toBe('right/field');
  });

  it('prefers a case-only match over a separator-insensitive one', () => {
    const item = { id: 'PVTI_dup2', buildrepo: 'wrong/field', 'build Repo': 'right/field', slug: 's', body: '' };
    expect(normaliseItem(item).repo).toBe('right/field');
  });

  it('a foreign card with neither field still reads as "not one of ours"', () => {
    const item = { id: 'PVTI_f', title: 'someone else', body: 'no markers' };
    const normalised = normaliseItem(item);
    expect(normalised.repo).toBe(null);
    expect(normalised.slug).toBe(null);
  });
});
