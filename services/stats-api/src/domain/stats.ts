import type { Aggregate, LabeledMatrix, Matrix } from './types';

/**
 * An accumulator that keeps the running total accurate to near machine
 * precision.
 *
 * Plain `sum += x` accumulates rounding error: after adding 1e16 and then
 * subtracting 1e16, the naive total has drifted. That matters here because the
 * matrices this service receives are QR factors, whose entries span many orders
 * of magnitude and whose diagonal is negative, so large terms routinely cancel
 * smaller ones. Reporting a wrong `sum` would be a silent correctness bug in a
 * service whose entire job is to report correct numbers.
 *
 * The variant used is Neumaier's improvement over Kahan's algorithm: it
 * accumulates a compensation term `c` that captures the part of each addition
 * that was lost to rounding, and folds it back into the next addition. Neumaier
 * is used rather than plain Kahan because it stays accurate even when the
 * running total is *smaller* than the value being added, which happens
 * constantly with cancellation and is exactly Kahan's weak spot.
 */
export class CompensatedSum {
  /** The corrected running total. */
  private total = 0;

  /** The accumulated low-order error, carried into the next addition. */
  private compensation = 0;

  /** Adds a value to the running total. */
  add(value: number): void {
    const next = this.total + value;
    // `next` is the magnitude that can lose precision; `this.total` is the
    // magnitude that keeps it. Choosing the larger of the two as the reference
    // is what makes the correction valid in both regimes.
    if (Math.abs(this.total) >= Math.abs(value)) {
      this.compensation += this.total - next + value;
    } else {
      this.compensation += value - next + this.total;
    }
    this.total = next;
  }

  /** Returns the corrected total. */
  value(): number {
    return this.total + this.compensation;
  }
}

/**
 * Reports whether a value is a finite number.
 *
 * JSON has no syntax for NaN or Infinity, but a JavaScript client can still
 * smuggle `null` through, and `1e999` decodes to `Infinity`. Both would poison
 * every statistic downstream, so they are rejected at the boundary.
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Returns whether a matrix is square and non-empty.
 *
 * A matrix with no rows or no columns is not square for the purpose of this
 * service; it is invalid, and validation reports it separately.
 */
export function isSquare(matrix: Matrix): boolean {
  if (matrix.length === 0) return false;
  const cols = matrix[0]?.length ?? 0;
  if (cols === 0) return false;
  return matrix.every((row) => row.length === cols);
}

/**
 * Returns whether every off-diagonal element of a matrix is within epsilon of
 * zero, and the matrix is square.
 *
 * The tolerance is not optional (ADR-004). The matrices this service is fed
 * come straight out of a QR factorization, so a matrix that is diagonal in
 * exact arithmetic arrives here carrying rounding noise of order 1e-16 in
 * positions that are mathematically zero. Testing for exact zero would report
 * `isDiagonal: false` for precisely the matrices a user would expect to be
 * flagged, and the flag would be worthless.
 *
 * The definition is strict about shape: a non-square matrix is never diagonal,
 * even if it happened to have zeros elsewhere. A 1x1 matrix is diagonal,
 * because it has no off-diagonal elements at all.
 *
 * @param matrix the matrix to inspect
 * @param epsilon absolute tolerance for off-diagonal entries
 */
export function isDiagonal(matrix: Matrix, epsilon: number): boolean {
  if (!isSquare(matrix)) return false;

  for (let i = 0; i < matrix.length; i += 1) {
    const row = matrix[i] as number[];
    for (let j = 0; j < row.length; j += 1) {
      if (i === j) continue;
      if (Math.abs(row[j] as number) > epsilon) return false;
    }
  }
  return true;
}

/**
 * Computes max, min, average and compensated sum over the values of a matrix.
 *
 * The scan is a single pass with no intermediate allocation, so the memory cost
 * is constant regardless of matrix size and the branch predictor sees a very
 * predictable loop.
 *
 * @param matrix the matrix to aggregate
 * @returns the aggregate, with `count` reporting how many values contributed
 */
export function computeMatrixStats(matrix: Matrix): Aggregate {
  const sum = new CompensatedSum();
  let max = Number.NEGATIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  let count = 0;

  for (const row of matrix) {
    for (const value of row) {
      if (value > max) max = value;
      if (value < min) min = value;
      sum.add(value);
      count += 1;
    }
  }

  // An empty matrix cannot happen after validation, but the function is total:
  // returning zeros keeps a caller from having to guard, and 0 is the neutral
  // value rather than NaN or +/-Infinity, which would poison downstream sums.
  if (count === 0) {
    return { max: 0, min: 0, average: 0, sum: 0, count: 0 };
  }

  const total = sum.value();
  return { max, min, average: total / count, sum: total, count };
}

/**
 * Computes max, min, average and compensated sum across every value of every
 * matrix.
 *
 * This is deliberately a separate function rather than a sum of per-matrix
 * totals: adding up the individual sums would discard each matrix's
 * compensation term and reintroduce exactly the rounding error the compensated
 * accumulator exists to remove. The global figure is therefore accumulated in
 * one pass over the same values.
 *
 * @param matrices the matrices to aggregate across
 */
export function computeGlobalStats(matrices: LabeledMatrix[]): Aggregate {
  const sum = new CompensatedSum();
  let max = Number.NEGATIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  let count = 0;

  for (const matrix of matrices) {
    for (const row of matrix.data) {
      for (const value of row) {
        if (value > max) max = value;
        if (value < min) min = value;
        sum.add(value);
        count += 1;
      }
    }
  }

  if (count === 0) {
    return { max: 0, min: 0, average: 0, sum: 0, count: 0 };
  }

  const total = sum.value();
  return { max, min, average: total / count, sum: total, count };
}
