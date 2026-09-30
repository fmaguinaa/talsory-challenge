import { describe, expect, it } from 'vitest';

import {
  CompensatedSum,
  computeGlobalStats,
  computeMatrixStats,
  isDiagonal,
  isFiniteNumber,
  isSquare,
} from '../src/domain/stats';
import type { LabeledMatrix } from '../src/domain/types';

/** Default epsilon used throughout, matching DIAGONAL_EPSILON in .env.example. */
const EPSILON = 1e-9;

describe('CompensatedSum', () => {
  it('matches naive summation for values that do not cancel', () => {
    const sum = new CompensatedSum();
    for (const value of [1.5, 2.5, 3.5, 4.5]) sum.add(value);
    expect(sum.value()).toBe(12);
  });

  it('is exact where naive summation drifts', () => {
    // The canonical counter-example: 1e16 + (-1e16) + 1 should be exactly 1.
    // A naive accumulator loses the 1 while adding the large term.
    const sum = new CompensatedSum();
    sum.add(1e16);
    sum.add(-1e16);
    sum.add(1);

    expect(sum.value()).toBe(1);
  });

  it('stays accurate when the running total is smaller than the next value', () => {
    // Plain Kahan summation is weakest in exactly this regime: adding a large
    // value to a small running total. Neumaier's variant handles it, which is
    // why this one is used.
    const sum = new CompensatedSum();
    sum.add(0.1);
    sum.add(1e16);
    sum.add(-1e16);

    expect(sum.value()).toBeCloseTo(0.1, 10);
  });

  it('returns 0 for an empty accumulation', () => {
    expect(new CompensatedSum().value()).toBe(0);
  });

  it('handles an alternating sequence that a naive sum would report as 0', () => {
    const sum = new CompensatedSum();
    for (let i = 0; i < 1000; i += 1) {
      sum.add(0.1);
      sum.add(-0.1);
    }
    expect(sum.value()).toBeCloseTo(0, 12);
  });
});

describe('isFiniteNumber', () => {
  it.each([
    ['zero', 0, true],
    ['a normal number', 42.5, true],
    ['negative zero', -0, true],
    ['NaN', Number.NaN, false],
    ['positive infinity', Number.POSITIVE_INFINITY, false],
    ['negative infinity', Number.NEGATIVE_INFINITY, false],
    ['null', null, false],
    ['undefined', undefined, false],
    ['a numeric string', '1', false],
    ['a boolean', true, false],
    ['an array', [1], false],
    ['an object', {}, false],
  ])('classifies %s as %s', (_label, value, expected) => {
    expect(isFiniteNumber(value)).toBe(expected);
  });
});

describe('isSquare', () => {
  it.each([
    [[], false],
    [[[]], false],
    [
      [
        [1, 2],
        [3, 4],
      ],
      true,
    ],
    [
      [
        [1, 2, 3],
        [4, 5],
      ],
      false,
    ],
    [[[1]], true],
    [
      [
        [1, 2, 3],
        [4, 5, 6],
      ],
      true,
    ],
  ])('classifies %j as %s', (matrix, expected) => {
    expect(isSquare(matrix)).toBe(expected);
  });
});

describe('isDiagonal', () => {
  it('recognises an exact diagonal matrix', () => {
    const matrix = [
      [1, 0, 0],
      [0, 2, 0],
      [0, 0, 3],
    ];
    expect(isDiagonal(matrix, EPSILON)).toBe(true);
  });

  it('recognises a diagonal matrix carrying QR rounding noise', () => {
    // This is the case that makes the tolerance mandatory (ADR-004): R from a
    // factorization has entries that are mathematically zero but arrive as
    // values around 1e-16.
    const matrix = [
      [14, 1e-16, -2e-17],
      [1e-16, 21, 3e-16],
      [-2e-17, 3e-16, 35],
    ];
    expect(isDiagonal(matrix, EPSILON)).toBe(true);
  });

  it('rejects noise larger than the tolerance', () => {
    const matrix = [
      [14, 1e-8, 0],
      [0, 21, 0],
      [0, 0, 35],
    ];
    expect(isDiagonal(matrix, EPSILON)).toBe(false);
  });

  it('treats a 1x1 matrix as diagonal', () => {
    // There are no off-diagonal elements, so the condition holds vacuously.
    expect(isDiagonal([[42]], EPSILON)).toBe(true);
  });

  it('treats a 1x1 matrix with any value as diagonal', () => {
    expect(isDiagonal([[-17.5]], EPSILON)).toBe(true);
  });

  it('rejects a non-square matrix even when its off-diagonal entries are zero', () => {
    const matrix = [
      [1, 0],
      [0, 1],
      [0, 1],
    ];
    expect(isDiagonal(matrix, EPSILON)).toBe(false);
  });

  it('rejects an upper-triangular matrix that is not diagonal', () => {
    const matrix = [
      [1, 2],
      [0, 3],
    ];
    expect(isDiagonal(matrix, EPSILON)).toBe(false);
  });

  it('rejects a matrix whose off-diagonal entries are merely small in count', () => {
    const matrix = [
      [0, 1],
      [1, 0],
    ];
    expect(isDiagonal(matrix, EPSILON)).toBe(false);
  });

  it('ignores the magnitude of the diagonal entries themselves', () => {
    // A diagonal matrix with huge entries is still diagonal: only the
    // off-diagonal positions are subject to the tolerance.
    const matrix = [
      [1e15, 0],
      [0, -1e15],
    ];
    expect(isDiagonal(matrix, EPSILON)).toBe(true);
  });

  it('is controlled by the epsilon argument', () => {
    const matrix = [
      [1, 0.5],
      [0, 1],
    ];
    expect(isDiagonal(matrix, 0.1)).toBe(false);
    expect(isDiagonal(matrix, 1)).toBe(true);
  });

  it('rejects an empty matrix', () => {
    expect(isDiagonal([], EPSILON)).toBe(false);
    expect(isDiagonal([[]], EPSILON)).toBe(false);
  });

  it('accepts negative and mixed-sign diagonal matrices', () => {
    expect(
      isDiagonal(
        [
          [-1, 0],
          [0, -2],
        ],
        EPSILON,
      ),
    ).toBe(true);
  });
});

describe('computeMatrixStats', () => {
  it('computes max, min, sum, average and count', () => {
    const stats = computeMatrixStats([
      [1, 2, 3],
      [4, 5, 6],
    ]);

    expect(stats).toEqual({ max: 6, min: 1, sum: 21, average: 3.5, count: 6 });
  });

  it('handles a single element', () => {
    expect(computeMatrixStats([[7]])).toEqual({ max: 7, min: 7, sum: 7, average: 7, count: 1 });
  });

  it('handles all-negative values', () => {
    const stats = computeMatrixStats([
      [-3, -1],
      [-2, -4],
    ]);

    expect(stats.max).toBe(-1);
    expect(stats.min).toBe(-4);
    expect(stats.sum).toBe(-10);
    expect(stats.average).toBe(-2.5);
  });

  it('returns zeros for an empty matrix instead of NaN or infinity', () => {
    // Infinity would poison every downstream sum, so the neutral value is used.
    expect(computeMatrixStats([])).toEqual({ max: 0, min: 0, sum: 0, average: 0, count: 0 });
    expect(computeMatrixStats([[]])).toEqual({ max: 0, min: 0, sum: 0, average: 0, count: 0 });
  });

  it('reports the correct max and min for a single row', () => {
    const stats = computeMatrixStats([[5, 1, 9, 3]]);
    expect(stats.max).toBe(9);
    expect(stats.min).toBe(1);
    expect(stats.sum).toBe(18);
  });

  it('keeps the sum accurate across many magnitudes', () => {
    const matrix = [[1e16, 1, -1e16]];
    const stats = computeMatrixStats(matrix);
    expect(stats.sum).toBe(1);
  });

  it('computes the average over all elements, not per row', () => {
    const stats = computeMatrixStats([
      [10, 10],
      [0, 0],
    ]);
    expect(stats.average).toBe(5);
  });
});

describe('computeGlobalStats', () => {
  it('aggregates across every matrix', () => {
    const matrices: LabeledMatrix[] = [
      { id: 'Q', data: [[1, 2]] },
      { id: 'R', data: [[3, 4]] },
    ];
    const stats = computeGlobalStats(matrices);

    expect(stats).toEqual({ max: 4, min: 1, sum: 10, average: 2.5, count: 4 });
  });

  it('aggregates across matrices while preserving accuracy for cancelling values', () => {
    // 1e16 and -1e16 cancel exactly, leaving 3 from the second matrix. A single
    // pass with compensation keeps that result regardless of which matrix the
    // values arrive in.
    const matrices: LabeledMatrix[] = [
      { id: 'a', data: [[1e16, -1e16]] },
      { id: 'b', data: [[3]] },
    ];
    expect(computeGlobalStats(matrices).sum).toBe(3);
  });

  it('returns zeros when there are no matrices', () => {
    expect(computeGlobalStats([])).toEqual({ max: 0, min: 0, sum: 0, average: 0, count: 0 });
  });

  it('handles matrices of different sizes', () => {
    const matrices: LabeledMatrix[] = [
      { id: 'Q', data: [[1, 2, 3]] },
      { id: 'R', data: [[4, 5]] },
    ];
    const stats = computeGlobalStats(matrices);
    expect(stats.count).toBe(5);
    expect(stats.max).toBe(5);
    expect(stats.min).toBe(1);
    expect(stats.sum).toBe(15);
  });
});
