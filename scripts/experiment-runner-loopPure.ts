export type Direction = 'higher' | 'lower';

export interface DecisionInput {
  currentMetric: number;
  bestSoFar: number | null;
  direction: Direction;
  minDelta: number;
}

export type Decision = 'keep' | 'discard';

export function decideKeepOrDiscard(input: DecisionInput): Decision {
  const { currentMetric, bestSoFar, direction, minDelta } = input;

  if (!Number.isFinite(minDelta) || minDelta <= 0) {
    throw new Error('minDelta must be a finite positive number');
  }

  if (!Number.isFinite(currentMetric)) {
    throw new Error('currentMetric must be finite');
  }

  if (bestSoFar === null) {
    return 'keep';
  }

  if (!Number.isFinite(bestSoFar)) {
    throw new Error('bestSoFar must be finite');
  }

  const improvement =
    direction === 'lower'
      ? bestSoFar - currentMetric
      : currentMetric - bestSoFar;

  return improvement >= minDelta ? 'keep' : 'discard';
}
