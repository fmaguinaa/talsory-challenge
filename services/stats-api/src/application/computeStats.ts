import { computeGlobalStats, computeMatrixStats, isDiagonal, isFiniteNumber } from '../domain/stats';
import type { GlobalStats, LabeledMatrix, Matrix, MatrixStats, StatsResult } from '../domain/types';

/**
 * Limits applied to every request. They exist to bound the work a single
 * request can cause: the service is stateless, so the only defence against a
 * client asking for a million-element payload is refusing it.
 */
export interface StatsLimits {
  /** Largest number of matrices accepted per request. */
  readonly maxMatrices: number;
  /** Largest total number of elements accepted across all matrices. */
  readonly maxTotalElements: number;
  /** Largest number of rows (or columns) accepted for a single matrix. */
  readonly maxMatrixDim: number;
}

/**
 * Raised when the payload is structurally unusable.
 *
 * It is distinct from an authentication failure on purpose: the HTTP layer maps
 * it to 422 with a precise reason, whereas a bad token is a 401 and an
 * unavailable authority is a 503. Conflating them would tell a client to
 * re-authenticate when the real problem is its own payload.
 */
export class ValidationError extends Error {
  /** Machine-readable reason, e.g. `matrix "Q" row 2 has length 2, expected 3`. */
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'ValidationError';
    this.reason = reason;
  }
}

/**
 * Raised when the request is larger than the configured limits.
 *
 * Separated from {@link ValidationError} so the transport layer can answer 413
 * instead of 422: "your body is too big" and "your matrix is the wrong shape"
 * call for different client behaviour.
 */
export class PayloadTooLargeError extends Error {
  /** Machine-readable reason. */
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'PayloadTooLargeError';
    this.reason = reason;
  }
}

/**
 * Narrows an unknown value to a raw array of arrays of unknown values.
 *
 * The HTTP body is `unknown` by the time it reaches here. Rather than trusting
 * any structural assumption, every level is checked, which is what allows the
 * error messages to name the exact position that is wrong.
 */
function asRawMatrix(value: unknown, where: string): unknown[][] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${where} must be an array of arrays of numbers`);
  }
  if (value.length === 0) {
    throw new ValidationError(`${where} must contain at least one row`);
  }
  return value as unknown[][];
}

/**
 * Validates one matrix and returns it typed.
 *
 * Checks, in order: the shape, the width, the row count against the limit, the
 * row widths against each other, and finiteness of every entry. The order
 * matters only for the message the user sees; all of them reject the request.
 *
 * @param raw the untrusted matrix
 * @param id the label, used in error messages
 * @param limits the configured bounds
 */
function validateMatrix(raw: unknown, id: string, limits: StatsLimits): Matrix {
  const rows = asRawMatrix(raw, `matrix "${id}"`);

  // The first row fixes the expected width for every other row, so its own
  // problems are reported first: telling a caller "row 3 has length 2, expected
  // 3" when row 0 is not even an array would be misleading.
  const firstRow = rows[0];
  if (!Array.isArray(firstRow)) {
    throw new ValidationError(`matrix "${id}" row 0 must be an array of numbers`);
  }
  if (firstRow.length === 0) {
    throw new ValidationError(`matrix "${id}" row 0 must contain at least one number`);
  }
  const cols = firstRow.length;

  if (rows.length > limits.maxMatrixDim) {
    throw new PayloadTooLargeError(
      `matrix "${id}" has ${rows.length} rows, the maximum is ${limits.maxMatrixDim}`,
    );
  }
  if (cols > limits.maxMatrixDim) {
    throw new PayloadTooLargeError(
      `matrix "${id}" has ${cols} columns, the maximum is ${limits.maxMatrixDim}`,
    );
  }

  const matrix: number[][] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    // Array.isArray is both the runtime check and the type guard: afterwards
    // `row` is known to be an array, and its length can be trusted.
    if (!Array.isArray(row)) {
      throw new ValidationError(`matrix "${id}" row ${i} must be an array of numbers`);
    }
    const current = row;
    if (current.length !== cols) {
      throw new ValidationError(
        `matrix "${id}" row ${i} has length ${current.length}, expected ${cols}`,
      );
    }
    for (let j = 0; j < current.length; j += 1) {
      if (!isFiniteNumber(current[j])) {
        throw new ValidationError(
          `matrix "${id}" value at row ${i}, column ${j} is not a finite number`,
        );
      }
    }
    matrix.push(current as number[]);
  }

  return matrix;
}

/**
 * Validates an entire request payload.
 *
 * @param body the untrusted request body
 * @param limits the configured bounds
 * @returns the validated, labeled matrices in input order
 * @throws ValidationError when the payload is structurally wrong
 * @throws PayloadTooLargeError when the payload exceeds a configured limit
 */
export function validateStatsRequest(body: unknown, limits: StatsLimits): LabeledMatrix[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('request body must be a JSON object');
  }

  const rawMatrices = (body as { matrices?: unknown }).matrices;
  if (!Array.isArray(rawMatrices)) {
    throw new ValidationError('field "matrices" is required and must be an array');
  }
  if (rawMatrices.length === 0) {
    throw new ValidationError('field "matrices" must contain at least one matrix');
  }
  if (rawMatrices.length > limits.maxMatrices) {
    throw new PayloadTooLargeError(
      `request contains ${rawMatrices.length} matrices, the maximum is ${limits.maxMatrices}`,
    );
  }

  const result: LabeledMatrix[] = [];
  let totalElements = 0;

  for (let index = 0; index < rawMatrices.length; index += 1) {
    const entry = rawMatrices[index] as unknown;

    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ValidationError(`matrices[${index}] must be an object with "id" and "data"`);
    }
    const { id, data } = entry as { id?: unknown; data?: unknown };

    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new ValidationError(`matrices[${index}].id must be a non-empty string`);
    }
    if (id.length > 64) {
      throw new ValidationError(`matrices[${index}].id must be at most 64 characters`);
    }

    const matrix = validateMatrix(data, id, limits);
    totalElements += matrix.length * (matrix[0]?.length ?? 0);

    // The total is checked as we go rather than after the whole loop, so an
    // oversized payload is refused before every element has been validated.
    if (totalElements > limits.maxTotalElements) {
      throw new PayloadTooLargeError(
        `request contains more than ${limits.maxTotalElements} elements across all matrices`,
      );
    }

    result.push({ id, data: matrix });
  }

  return result;
}

/**
 * Statistics of a single labeled matrix, including its diagonal flag.
 */
export function statsForMatrix(matrix: LabeledMatrix, epsilon: number): MatrixStats {
  const aggregate = computeMatrixStats(matrix.data);
  return {
    id: matrix.id,
    ...aggregate,
    isDiagonal: isDiagonal(matrix.data, epsilon),
  };
}

/**
 * Statistics of a whole request: the global aggregate plus the per-matrix
 * breakdown.
 *
 * The `count` field is intentionally not part of the public response contract
 * (see contracts/stats-api.yaml); it lives on the internal type because the
 * mobile client does not need it and the orchestrator forwards the response
 * verbatim. Stripping it is the transport layer's job.
 */
export function computeStats(matrices: LabeledMatrix[], epsilon: number): StatsResult {
  const perMatrix = matrices.map((matrix) => statsForMatrix(matrix, epsilon));
  const globalAggregate = computeGlobalStats(matrices);
  const global: GlobalStats = {
    ...globalAggregate,
    anyDiagonal: perMatrix.some((entry) => entry.isDiagonal),
  };
  return { global, perMatrix };
}
