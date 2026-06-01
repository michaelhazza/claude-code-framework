/**
 * experiment-runner-loopPure.test.ts
 *
 * Pure-function tests for decideKeepOrDiscard (Contract 1).
 * Run via: npx tsx scripts/__tests__/experiment-runner-loopPure.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideKeepOrDiscard } from '../experiment-runner-loopPure.js';

// --- iteration 1 (bestSoFar === null) ---

test('bestSoFar null returns keep for direction lower', () => {
  assert.equal(
    decideKeepOrDiscard({ currentMetric: 240, bestSoFar: null, direction: 'lower', minDelta: 5 }),
    'keep',
  );
});

test('bestSoFar null returns keep for direction higher', () => {
  assert.equal(
    decideKeepOrDiscard({ currentMetric: 50, bestSoFar: null, direction: 'higher', minDelta: 2 }),
    'keep',
  );
});

// --- direction lower ---

test('lower: improvement exactly at minDelta boundary returns keep (inclusive >=)', () => {
  assert.equal(
    decideKeepOrDiscard({ currentMetric: 235, bestSoFar: 240, direction: 'lower', minDelta: 5 }),
    'keep',
  );
});

test('lower: improvement below minDelta returns discard', () => {
  assert.equal(
    decideKeepOrDiscard({ currentMetric: 237, bestSoFar: 240, direction: 'lower', minDelta: 5 }),
    'discard',
  );
});

test('lower: regression (currentMetric worse than bestSoFar) returns discard', () => {
  assert.equal(
    decideKeepOrDiscard({ currentMetric: 250, bestSoFar: 240, direction: 'lower', minDelta: 5 }),
    'discard',
  );
});

// --- direction higher ---

test('higher: improvement exactly at minDelta boundary returns keep (inclusive >=)', () => {
  assert.equal(
    decideKeepOrDiscard({ currentMetric: 93, bestSoFar: 91, direction: 'higher', minDelta: 2 }),
    'keep',
  );
});

test('higher: improvement below minDelta returns discard', () => {
  assert.equal(
    decideKeepOrDiscard({ currentMetric: 92, bestSoFar: 91, direction: 'higher', minDelta: 2 }),
    'discard',
  );
});

test('higher: regression (currentMetric worse than bestSoFar) returns discard', () => {
  assert.equal(
    decideKeepOrDiscard({ currentMetric: 88, bestSoFar: 91, direction: 'higher', minDelta: 2 }),
    'discard',
  );
});

// --- minDelta validation ---

test('minDelta = 0 throws', () => {
  assert.throws(
    () => decideKeepOrDiscard({ currentMetric: 100, bestSoFar: 110, direction: 'lower', minDelta: 0 }),
    /minDelta must be a finite positive number/,
  );
});

test('minDelta < 0 throws', () => {
  assert.throws(
    () => decideKeepOrDiscard({ currentMetric: 100, bestSoFar: 110, direction: 'lower', minDelta: -1 }),
    /minDelta must be a finite positive number/,
  );
});

test('minDelta NaN throws', () => {
  assert.throws(
    () => decideKeepOrDiscard({ currentMetric: 100, bestSoFar: 110, direction: 'lower', minDelta: NaN }),
    /minDelta must be a finite positive number/,
  );
});

test('minDelta Infinity throws', () => {
  assert.throws(
    () => decideKeepOrDiscard({ currentMetric: 100, bestSoFar: 110, direction: 'lower', minDelta: Infinity }),
    /minDelta must be a finite positive number/,
  );
});

test('minDelta -Infinity throws', () => {
  assert.throws(
    () => decideKeepOrDiscard({ currentMetric: 100, bestSoFar: 110, direction: 'lower', minDelta: -Infinity }),
    /minDelta must be a finite positive number/,
  );
});

// --- currentMetric validation ---

test('currentMetric NaN throws', () => {
  assert.throws(
    () => decideKeepOrDiscard({ currentMetric: NaN, bestSoFar: 100, direction: 'lower', minDelta: 5 }),
    /currentMetric must be finite/,
  );
});

test('currentMetric Infinity throws', () => {
  assert.throws(
    () => decideKeepOrDiscard({ currentMetric: Infinity, bestSoFar: 100, direction: 'lower', minDelta: 5 }),
    /currentMetric must be finite/,
  );
});

test('currentMetric -Infinity throws', () => {
  assert.throws(
    () => decideKeepOrDiscard({ currentMetric: -Infinity, bestSoFar: 100, direction: 'lower', minDelta: 5 }),
    /currentMetric must be finite/,
  );
});

// --- bestSoFar (non-null) validation ---

test('bestSoFar NaN throws', () => {
  assert.throws(
    () => decideKeepOrDiscard({ currentMetric: 100, bestSoFar: NaN, direction: 'lower', minDelta: 5 }),
    /bestSoFar must be finite/,
  );
});

test('bestSoFar Infinity throws', () => {
  assert.throws(
    () => decideKeepOrDiscard({ currentMetric: 100, bestSoFar: Infinity, direction: 'lower', minDelta: 5 }),
    /bestSoFar must be finite/,
  );
});

test('bestSoFar -Infinity throws', () => {
  assert.throws(
    () => decideKeepOrDiscard({ currentMetric: 100, bestSoFar: -Infinity, direction: 'lower', minDelta: 5 }),
    /bestSoFar must be finite/,
  );
});

// --- referential transparency ---

test('determinism: 100 identical invocations return identical Decision', () => {
  const input = { currentMetric: 235, bestSoFar: 240, direction: 'lower' as const, minDelta: 5 };
  const first = decideKeepOrDiscard(input);
  for (let i = 0; i < 99; i++) {
    assert.equal(decideKeepOrDiscard(input), first);
  }
});

// --- direction validation (R4 OAI-PR-004 regression) ---

test('direction typo throws (not silently treated as higher)', () => {
  assert.throws(
    () => decideKeepOrDiscard({
      // @ts-expect-error — runtime guard for invalid direction
      currentMetric: 100,
      bestSoFar: 50,
      direction: 'lowerer',
      minDelta: 5,
    }),
    /direction must be 'higher' or 'lower'/,
  );
});

test('direction undefined throws', () => {
  assert.throws(
    () => decideKeepOrDiscard({
      // @ts-expect-error — runtime guard for invalid direction
      currentMetric: 100,
      bestSoFar: 50,
      direction: undefined,
      minDelta: 5,
    }),
    /direction must be 'higher' or 'lower'/,
  );
});

test('direction empty-string throws', () => {
  assert.throws(
    () => decideKeepOrDiscard({
      // @ts-expect-error — runtime guard for invalid direction
      currentMetric: 100,
      bestSoFar: 50,
      direction: '',
      minDelta: 5,
    }),
    /direction must be 'higher' or 'lower'/,
  );
});
