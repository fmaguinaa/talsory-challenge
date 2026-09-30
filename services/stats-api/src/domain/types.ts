/**
 * Domain types for the statistics of a labeled matrix.
 *
 * This module is pure: no I/O, no framework, no configuration. Everything the
 * service computes is derived here, which is what makes the interesting
 * behaviour (compensated summation, the diagonal predicate) testable in
 * isolation and cheap to reason about.
 */

/** A rectangular matrix of finite numbers, serialized as an array of arrays. */
export type Matrix = number[][];

/** A matrix together with the label used to trace it back to its source. */
export interface LabeledMatrix {
  /** Stable label echoed back in the response, e.g. `"Q"` or `"R"`. */
  readonly id: string;
  /** The matrix itself. */
  readonly data: Matrix;
}

/** Descriptive statistics over a set of numbers. */
export interface Aggregate {
  /** Largest value, or 0 for an empty set. */
  readonly max: number;
  /** Smallest value, or 0 for an empty set. */
  readonly min: number;
  /** Arithmetic mean, or 0 for an empty set. */
  readonly average: number;
  /** Total, accumulated with compensated summation. */
  readonly sum: number;
  /** Number of values that contributed to the aggregate. */
  readonly count: number;
}

/** Aggregate for the whole request plus the cross-matrix diagonal flag. */
export interface GlobalStats extends Aggregate {
  /** True when at least one of the input matrices is diagonal. */
  readonly anyDiagonal: boolean;
}

/** Aggregate for one matrix plus its own diagonal flag. */
export interface MatrixStats extends Aggregate {
  /** Label of the matrix these statistics belong to. */
  readonly id: string;
  /** Whether this specific matrix is diagonal. */
  readonly isDiagonal: boolean;
}

/** The full response of the statistics endpoint. */
export interface StatsResult {
  /** Statistics across every value of every matrix. */
  readonly global: GlobalStats;
  /** Per-matrix breakdown, in input order. */
  readonly perMatrix: MatrixStats[];
}
