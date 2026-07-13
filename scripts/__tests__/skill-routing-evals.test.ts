/**
 * skill-routing-evals.test.ts
 *
 * Pure-function tests for the skill-routing eval core: tokenizer/stemmer,
 * TF-IDF ranking over a synthetic catalogue, positive/negative trigger
 * evaluation (incl. negative-with-owner pairwise routing), case validation,
 * collision detection + exemption list, and the rank-1-rate metric.
 *
 * Run via: npx vitest run scripts/__tests__/skill-routing-evals.test.ts
 */

import { expect, test } from 'vitest';
import {
  buildCorpus,
  evaluateCase,
  pairwiseCollisions,
  rankSkillsForPrompt,
  stem,
  summarize,
  tokenize,
  validateRoutingCase,
  type RoutingCase,
  type SkillDoc,
} from '../skill-routing-evalsPure.js';

// ── synthetic 3-skill catalogue ──────────────────────────────────────────────

const CATALOGUE: SkillDoc[] = [
  {
    name: 'git-rebase',
    description: 'Use when rebasing a branch, resolving merge conflicts, or rewriting commit history.',
  },
  {
    name: 'db-migrations',
    description: 'Use when authoring database schema migrations, indexes, constraints, or backfills.',
  },
  {
    name: 'frontend-styling',
    description: 'Use when styling components with css, layout, spacing, or visual design tokens.',
  },
];

function makeCase(overrides: Partial<RoutingCase>): RoutingCase {
  return { skill: 'git-rebase', topK: 3, positive: [], negative: [], ...overrides };
}

// ── tokenizer / stemmer ──────────────────────────────────────────────────────

test('stem: clusters common suffix variants', () => {
  expect(stem('conflicts')).toBe('conflict');
  expect(stem('branching')).toBe('branch');
  expect(stem('committing')).toBe('commit'); // -ing strip + doubled-consonant collapse
  expect(stem('migrations')).toBe('migration');
  expect(stem('simplifies')).toBe(stem('simplify')); // trailing-y normalization
});

test('tokenize: lowercases, splits on hyphens, drops stopwords and short tokens', () => {
  const tokens = tokenize('Help me with the DB-Migrations when branching!');
  expect(tokens).not.toContain('the'); // stopword
  expect(tokens).not.toContain('db'); // length <= 2
  expect(tokens).toContain('migration');
  expect(tokens).toContain('branch');
});

// ── ranking ──────────────────────────────────────────────────────────────────

test('rankSkillsForPrompt: crafted prompt ranks its skill #1', () => {
  const corpus = buildCorpus(CATALOGUE);
  const ranking = rankSkillsForPrompt('rebase my branch and resolve the merge conflicts', corpus);
  expect(ranking[0].name).toBe('git-rebase');
  expect(ranking[0].score).toBeGreaterThan(0);
  expect(ranking).toHaveLength(3);
});

// ── positive / negative trigger evaluation ───────────────────────────────────

test('evaluateCase: positive within top_k passes; off-topic positive fails with top-3 evidence', () => {
  const corpus = buildCorpus(CATALOGUE);
  const ev = evaluateCase(
    makeCase({
      positive: [
        'rebase my branch and resolve the merge conflicts', // on-topic
        'style this component with css spacing tokens', // clearly frontend-styling territory
      ],
    }),
    corpus,
  );
  expect(ev.positives).toBe(2);
  expect(ev.passed).toBe(1);
  expect(ev.failures).toHaveLength(1);
  expect(['positive-rank', 'positive-no-vocabulary']).toContain(ev.failures[0].kind);
});

test('evaluateCase: negative ranking the skill #1 fails (over-broad description)', () => {
  const corpus = buildCorpus(CATALOGUE);
  const ev = evaluateCase(
    makeCase({ negative: [{ prompt: 'rebase my branch and resolve the merge conflicts' }] }),
    corpus,
  );
  expect(ev.failures.map((f) => f.kind)).toContain('negative-rank1');
});

test('evaluateCase: negative-with-owner passes when the owner outranks, fails when outranked', () => {
  const corpus = buildCorpus(CATALOGUE);
  const prompt = 'author a database schema migration with a new index';

  // db-migrations owns this prompt, so a git-rebase negative declaring it passes.
  const pass = evaluateCase(
    makeCase({ negative: [{ prompt, owner: 'db-migrations' }] }),
    corpus,
  );
  expect(pass.failures).toEqual([]);
  expect(pass.passed).toBe(1);

  // frontend-styling does NOT outrank db-migrations for this prompt: a
  // db-migrations case declaring frontend-styling as owner must fail.
  const fail = evaluateCase(
    makeCase({ skill: 'db-migrations', negative: [{ prompt, owner: 'frontend-styling' }] }),
    corpus,
  );
  expect(fail.failures.map((f) => f.kind)).toContain('owner-outranked');
});

test('evaluateCase: unknown owner and unknown skill are hard failures', () => {
  const corpus = buildCorpus(CATALOGUE);
  const unknownOwner = evaluateCase(
    makeCase({ negative: [{ prompt: 'anything at all', owner: 'no-such-skill' }] }),
    corpus,
  );
  expect(unknownOwner.failures.map((f) => f.kind)).toContain('owner-unknown');

  const unknownSkill = evaluateCase(makeCase({ skill: 'no-such-skill' }), corpus);
  expect(unknownSkill.failures.map((f) => f.kind)).toContain('unknown-skill');
});

// ── case validation ──────────────────────────────────────────────────────────

test('validateRoutingCase: accepts the pinned format and rejects malformed shapes', () => {
  const good = {
    skill: 'git-rebase',
    top_k: 2,
    positive: ['rebase my branch'],
    negative: ['style a component', { prompt: 'write a migration', owner: 'db-migrations' }],
  };
  const ok = validateRoutingCase(good, 'ref');
  expect(ok.error).toBeUndefined();
  expect(ok.case?.topK).toBe(2);
  expect(ok.case?.negative[1].owner).toBe('db-migrations');

  expect(validateRoutingCase(null, 'ref').error).toMatch(/not a JSON object/);
  expect(validateRoutingCase({ ...good, skill: '' }, 'ref').error).toMatch(/"skill"/);
  expect(validateRoutingCase({ ...good, top_k: 0 }, 'ref').error).toMatch(/top_k/);
  expect(validateRoutingCase({ ...good, positive: 'x' }, 'ref').error).toMatch(/positive/);
  expect(validateRoutingCase({ ...good, negative: [42] }, 'ref').error).toMatch(/negative/);
  expect(validateRoutingCase({ ...good, negative: [{ owner: 'x' }] }, 'ref').error).toMatch(/prompt/);
});

// ── collision detection ──────────────────────────────────────────────────────

test('pairwiseCollisions: fires error-level on near-identical descriptions and respects exemptions', () => {
  // Same name tokens (reordered) + identical description → cosine 1.0.
  const twins: SkillDoc[] = [
    ...CATALOGUE,
    { name: 'rebase-git', description: 'Use when rebasing a branch, resolving merge conflicts, or rewriting commit history.' },
  ];
  const corpus = buildCorpus(twins);

  const collisions = pairwiseCollisions(corpus);
  const twin = collisions.find(
    (c) => [c.a, c.b].sort().join('|') === 'git-rebase|rebase-git',
  );
  expect(twin).toBeDefined();
  expect(twin!.level).toBe('error');
  expect(twin!.exempt).toBe(false);

  // Exemption list (order-insensitive) marks the pair exempt without hiding it.
  const exempted = pairwiseCollisions(corpus, [['rebase-git', 'git-rebase']]);
  const twinExempt = exempted.find(
    (c) => [c.a, c.b].sort().join('|') === 'git-rebase|rebase-git',
  );
  expect(twinExempt!.exempt).toBe(true);
});

test('pairwiseCollisions: distinct descriptions stay below the warn threshold', () => {
  const collisions = pairwiseCollisions(buildCorpus(CATALOGUE));
  expect(collisions).toEqual([]);
});

// ── rank-1-rate metric ───────────────────────────────────────────────────────

test('summarize: rank-1 rate counts positives ranking their skill first; null with no positives', () => {
  const corpus = buildCorpus(CATALOGUE);
  const ev = evaluateCase(
    makeCase({
      positive: [
        'rebase my branch and resolve the merge conflicts', // rank 1
        'style this component with css spacing tokens', // not rank 1
      ],
    }),
    corpus,
  );
  const s = summarize([ev]);
  expect(s.positives).toBe(2);
  expect(s.rank1).toBe(1);
  expect(s.rank1Rate).toBe(0.5);

  expect(summarize([]).rank1Rate).toBeNull();
});
