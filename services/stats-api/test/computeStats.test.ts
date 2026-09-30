import { describe, expect, it } from 'vitest';

import {
  PayloadTooLargeError,
  ValidationError,
  computeStats,
  validateStatsRequest,
  type StatsLimits,
} from '../src/application/computeStats';
import type { LabeledMatrix } from '../src/domain/types';

/** Limits used by the validation tests. */
const LIMITS: StatsLimits = {
  maxMatrices: 16,
  maxTotalElements: 20_000,
  maxMatrixDim: 100,
};

describe('validateStatsRequest', () => {
  it('accepts a well-formed payload and preserves input order', () => {
    const result = validateStatsRequest(
      {
        matrices: [
          { id: 'Q', data: [[1, 2]] },
          { id: 'R', data: [[3, 4]] },
        ],
      },
      LIMITS,
    );

    expect(result).toEqual<LabeledMatrix[]>([
      { id: 'Q', data: [[1, 2]] },
      { id: 'R', data: [[3, 4]] },
    ]);
  });

  it('accepts a single 1x1 matrix', () => {
    const result = validateStatsRequest({ matrices: [{ id: 'A', data: [[5]] }] }, LIMITS);
    expect(result).toHaveLength(1);
    expect(result[0]?.data).toEqual([[5]]);
  });

  it('accepts the exact limits and rejects one element beyond them', () => {
    const atLimit = Array.from({ length: 2 }, (_, i) => [i, i + 1]);
    expect(
      validateStatsRequest({ matrices: [{ id: 'A', data: atLimit }] }, { ...LIMITS, maxMatrixDim: 2 }),
    ).toHaveLength(1);

    const overLimit = Array.from({ length: 3 }, (_, i) => [i]);
    expect(() =>
      validateStatsRequest({ matrices: [{ id: 'A', data: overLimit }] }, { ...LIMITS, maxMatrixDim: 2 }),
    ).toThrow(PayloadTooLargeError);
  });

  describe.each([
    ['a non-object body', 'not an object', 'must be a JSON object'],
    ['an array body', [], 'must be a JSON object'],
    ['null body', null, 'must be a JSON object'],
    ['a missing matrices field', {}, 'field "matrices" is required'],
    ['a non-array matrices field', { matrices: 'nope' }, 'field "matrices" is required'],
    ['an empty matrices list', { matrices: [] }, 'at least one matrix'],
  ])('rejects %s', (_label, body, expectedReason) => {
    it(`with a message mentioning "${expectedReason}"`, () => {
      expect(() => validateStatsRequest(body, LIMITS)).toThrow(ValidationError);
      try {
        validateStatsRequest(body, LIMITS);
      } catch (error) {
        expect((error as ValidationError).reason).toContain(expectedReason);
      }
    });
  });

  describe.each([
    [
      'a ragged matrix',
      { matrices: [{ id: 'Q', data: [[1, 2, 3], [4, 5]] }] },
      'row 1 has length 2, expected 3',
    ],
    ['an empty matrix', { matrices: [{ id: 'Q', data: [] }] }, 'at least one row'],
    ['an empty row', { matrices: [{ id: 'Q', data: [[]] }] }, 'at least one number'],
    [
      'a null cell',
      { matrices: [{ id: 'Q', data: [[1, null]] }] },
      'row 0, column 1 is not a finite number',
    ],
    [
      'a string cell',
      { matrices: [{ id: 'Q', data: [[1, 'two']] }] },
      'row 0, column 1 is not a finite number',
    ],
    [
      'a boolean cell',
      { matrices: [{ id: 'Q', data: [[true]] }] },
      'row 0, column 0 is not a finite number',
    ],
    [
      'a non-array data field',
      { matrices: [{ id: 'Q', data: 42 }] },
      'must be an array of arrays',
    ],
    [
      'a non-array row',
      { matrices: [{ id: 'Q', data: [1, 2] }] },
      'row 0 must be an array of numbers',
    ],
    [
      'a missing id',
      { matrices: [{ data: [[1]] }] },
      'matrices[0].id must be a non-empty string',
    ],
    [
      'an empty id',
      { matrices: [{ id: '   ', data: [[1]] }] },
      'matrices[0].id must be a non-empty string',
    ],
    [
      'an over-long id',
      { matrices: [{ id: 'x'.repeat(65), data: [[1]] }] },
      'at most 64 characters',
    ],
    [
      'a non-object matrix entry',
      { matrices: ['Q'] },
      'matrices[0] must be an object',
    ],
  ])('rejects %s', (_label, body, expectedReason) => {
    it(`with a message mentioning "${expectedReason}"`, () => {
      expect(() => validateStatsRequest(body, LIMITS)).toThrow(ValidationError);
      try {
        validateStatsRequest(body, LIMITS);
      } catch (error) {
        expect((error as ValidationError).reason).toContain(expectedReason);
      }
    });
  });

  it('rejects a matrix with more rows than the dimension limit', () => {
    const data = Array.from({ length: 5 }, () => [1]);
    expect(() =>
      validateStatsRequest({ matrices: [{ id: 'Q', data }] }, { ...LIMITS, maxMatrixDim: 4 }),
    ).toThrow(PayloadTooLargeError);
  });

  it('rejects a matrix with more columns than the dimension limit', () => {
    expect(() =>
      validateStatsRequest({ matrices: [{ id: 'Q', data: [[1, 2, 3, 4, 5]] }] }, {
        ...LIMITS,
        maxMatrixDim: 4,
      }),
    ).toThrow(PayloadTooLargeError);
  });

  it('rejects more matrices than allowed', () => {
    const matrices = Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, data: [[1]] }));
    expect(() => validateStatsRequest({ matrices }, { ...LIMITS, maxMatrices: 3 })).toThrow(
      PayloadTooLargeError,
    );
  });

  it('rejects a payload whose total element count exceeds the limit', () => {
    // Two matrices of 4 elements each exceed a total limit of 7, even though
    // neither individually violates the dimension limit.
    const matrices = [
      { id: 'a', data: [[1, 2], [3, 4]] },
      { id: 'b', data: [[5, 6], [7, 8]] },
    ];
    expect(() =>
      validateStatsRequest({ matrices }, { ...LIMITS, maxTotalElements: 7 }),
    ).toThrow(PayloadTooLargeError);
  });

  it('names the offending matrix in its error message', () => {
    // Labels are what make a multi-matrix error actionable.
    try {
      validateStatsRequest(
        { matrices: [{ id: 'Q', data: [[1]] }, { id: 'R', data: [[1, 2], [3]] }] },
        LIMITS,
      );
      expect.unreachable('expected a ValidationError');
    } catch (error) {
      expect((error as ValidationError).reason).toContain('"R"');
    }
  });
});

describe('computeStats', () => {
  it('aggregates across matrices and reports each one individually', () => {
    const result = computeStats(
      [
        { id: 'Q', data: [[1, 2]] },
        { id: 'R', data: [[3, 4]] },
      ],
      1e-9,
    );

    expect(result.global).toEqual({
      max: 4,
      min: 1,
      average: 2.5,
      sum: 10,
      count: 4,
      anyDiagonal: false,
    });
    expect(result.perMatrix).toHaveLength(2);
    expect(result.perMatrix[0]).toMatchObject({ id: 'Q', max: 2, min: 1, sum: 3, average: 1.5 });
    expect(result.perMatrix[1]).toMatchObject({ id: 'R', max: 4, min: 3, sum: 7, average: 3.5 });
  });

  it('reports anyDiagonal when exactly one matrix is diagonal', () => {
    const result = computeStats(
      [
        { id: 'Q', data: [[1, 0], [0, 1]] },
        { id: 'R', data: [[0, 5], [5, 0]] },
      ],
      1e-9,
    );

    expect(result.global.anyDiagonal).toBe(true);
    expect(result.perMatrix[0]?.isDiagonal).toBe(true);
    expect(result.perMatrix[1]?.isDiagonal).toBe(false);
  });

  it('reports anyDiagonal false when no matrix is diagonal', () => {
    const result = computeStats([{ id: 'Q', data: [[1, 2], [3, 4]] }], 1e-9);
    expect(result.global.anyDiagonal).toBe(false);
  });

  it('flags a matrix whose off-diagonal entries carry QR noise as diagonal', () => {
    // The realistic case: R comes out of a factorization as upper triangular
    // with exact zeros below the diagonal, and Q can be diagonal for a
    // diagonal input.
    const result = computeStats([{ id: 'R', data: [[14, 21, 35]] }], 1e-9);
    // A 1x3 matrix is not square, so it is not diagonal.
    expect(result.perMatrix[0]?.isDiagonal).toBe(false);

    const square = computeStats(
      [
        {
          id: 'S',
          data: [
            [2, 0, 0],
            [0, 3, 0],
            [0, 0, 4],
          ],
        },
      ],
      1e-9,
    );
    expect(square.perMatrix[0]?.isDiagonal).toBe(true);
  });

  it('honours a larger epsilon', () => {
    const matrix: LabeledMatrix[] = [{ id: 'M', data: [[1, 0.5], [0, 1]] }];
    expect(computeStats(matrix, 1e-9).perMatrix[0]?.isDiagonal).toBe(false);
    expect(computeStats(matrix, 1).perMatrix[0]?.isDiagonal).toBe(true);
  });

  it('produces statistics for the known QR example', () => {
    // The Q and R factors of [[12,-51,4],[6,167,-68],[-4,24,-41]] as computed by
    // qr-api: a matrix that is exactly triangular in R's case.
    const result = computeStats(
      [
        {
          id: 'R',
          data: [
            [-14, -21, 14],
            [0, -175, 70],
            [0, 0, -35],
          ],
        },
      ],
      1e-9,
    );

    expect(result.perMatrix[0]?.isDiagonal).toBe(false);
    expect(result.global.max).toBe(70);
    expect(result.global.min).toBe(-175);
    expect(result.global.sum).toBe(-161);
    expect(result.global.count).toBe(9);
    expect(result.global.average).toBeCloseTo(-161 / 9, 12);
  });
});
