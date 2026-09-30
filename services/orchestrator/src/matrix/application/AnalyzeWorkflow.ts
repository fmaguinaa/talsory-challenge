import type {
  LabeledMatrix,
  LoginResponse,
  Matrix,
  QrFactorization,
  StatsResult,
} from '../domain/types';

/**
 * Error kinds the workflow can fail with.
 *
 * The split matters because each kind maps to a different status code the client
 * must react to differently: a bad matrix is the caller's to fix, an expired
 * token means log in again, and an unreachable dependency means retry. Folding
 * them into one error would force the client to guess.
 */
export type WorkflowErrorKind =
  /** The matrix is structurally unusable. Becomes 422. */
  | 'invalid-matrix'
  /** The bearer token is missing or rejected. Becomes 401. */
  | 'unauthorized'
  /** auth-service could not be reached, so the token is unverified. Becomes 503. */
  | 'auth-unavailable'
  /** A downstream service answered with an error. Becomes 502. */
  | 'downstream-failure'
  /** A downstream service did not answer in time. Becomes 504. */
  | 'downstream-timeout';

/**
 * A failure raised by the workflow or by one of its ports.
 *
 * The `detail` is safe to return to the client: adapters are responsible for
 * putting a user-facing explanation there rather than a raw transport error.
 */
export class WorkflowError extends Error {
  constructor(
    readonly kind: WorkflowErrorKind,
    readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(detail, options);
    this.name = 'WorkflowError';
  }
}

/**
 * Port for the QR factorization service.
 *
 * Declared here so the workflow depends on the interface, not on an HTTP client.
 */
export interface QrClient {
  /**
   * Requests the QR factorization of a matrix.
   *
   * @param matrix the validated matrix
   * @param token the caller's bearer token, propagated verbatim so qr-api
   *   authorizes independently rather than trusting the orchestrator
   * @param requestId the correlation id, propagated for cross-service tracing
   * @throws WorkflowError with kind `unauthorized`, `auth-unavailable`,
   *   `downstream-failure` or `downstream-timeout`
   */
  factorize(
    matrix: Matrix,
    token: string,
    requestId: string,
  ): Promise<QrFactorization>;
}

/**
 * Port for the statistics service.
 */
export interface StatsClient {
  /**
   * Requests statistics over a list of labeled matrices.
   *
   * @throws WorkflowError with kind `unauthorized`, `auth-unavailable`,
   *   `downstream-failure` or `downstream-timeout`
   */
  compute(
    matrices: readonly LabeledMatrix[],
    token: string,
    requestId: string,
  ): Promise<StatsResult>;
}

/**
 * Port for the authentication service.
 *
 * `login` is here as well as `validate` because the orchestrator proxies it:
 * the frontend talks only to the orchestrator, so the login round trip is part
 * of its job.
 */
export interface AuthClient {
  /** Exchanges credentials for a token. */
  login(username: string, password: string, requestId: string): Promise<LoginResponse>;

  /**
   * Reports whether a token is currently valid.
   *
   * Implementations must fail closed: an unreachable authority yields
   * `auth-unavailable`, never a positive answer.
   */
  validate(token: string, requestId: string): Promise<void>;
}

/** The limits the workflow enforces before making any network call. */
export interface WorkflowLimits {
  readonly maxMatrixDim: number;
}

/** Everything the workflow needs, injected so tests can substitute any part. */
export interface AnalyzeDeps {
  readonly auth: AuthClient;
  readonly qr: QrClient;
  readonly stats: StatsClient;
  readonly limits: WorkflowLimits;
}

/**
 * The analysis workflow.
 *
 * ADR-002 records why this lives in the orchestrator instead of in qr-api
 * calling stats-api directly. In short: one place owns the sequence, each
 * service keeps a single responsibility, and the services stay independently
 * testable and scalable. Switching to a direct Go to Node flow would be a
 * change confined to this file.
 */
export class AnalyzeWorkflow {
  private readonly auth: AuthClient;
  private readonly qr: QrClient;
  private readonly stats: StatsClient;
  private readonly limits: WorkflowLimits;

  constructor(deps: AnalyzeDeps) {
    this.auth = deps.auth;
    this.qr = deps.qr;
    this.stats = deps.stats;
    this.limits = deps.limits;
  }

  /**
   * Runs the whole workflow.
   *
   * Order, and why:
   *
   * 1. **Validate the matrix locally.** Cheapest possible rejection, and it
   *    costs no downstream call. Validating here as well as in qr-api is
   *    deliberate: qr-api must not trust its caller, and the orchestrator must
   *    not spend a round trip to learn the input is empty.
   * 2. **Authorize.** Fail closed if auth-service cannot be reached. Doing this
   *    after validation but before any real work means an unauthenticated
   *    caller cannot use the endpoint as an oracle for the shape rules.
   * 3. **Factorize.** The caller's token travels with the request, so qr-api
   *    applies its own authorization instead of trusting the orchestrator.
   * 4. **Compute statistics** over Q and R, again with the original token.
   * 5. **Assemble** the single aggregated response.
   *
   * @param matrix the raw, untrusted matrix from the request
   * @param token the caller's bearer token
   * @param requestId the correlation id for this workflow
   */
  async execute(
    matrix: unknown,
    token: string,
    requestId: string,
  ): Promise<{
    input: { rows: number; cols: number };
    qr: QrFactorization;
    stats: StatsResult;
  }> {
    const validated = validateMatrixInput(matrix, this.limits.maxMatrixDim);

    if (token.trim().length === 0) {
      throw new WorkflowError('unauthorized', 'A valid bearer token is required.');
    }
    await this.auth.validate(token, requestId);

    const qr = await this.qr.factorize(validated.matrix, token, requestId);

    // Q and R are labelled so stats-api can report each one separately: the
    // whole point of the per-matrix breakdown is that a user can see which of
    // the two factors is diagonal.
    const stats = await this.stats.compute(
      [
        { id: 'Q', data: qr.q },
        { id: 'R', data: qr.r },
      ],
      token,
      requestId,
    );

    return {
      input: { rows: validated.matrix.length, cols: validated.matrix[0]?.length ?? 0 },
      qr,
      stats,
    };
  }
}

/** A validated matrix plus its shape. */
interface ValidatedInput {
  readonly matrix: Matrix;
}

/**
 * Validates the raw request body into a matrix.
 *
 * This repeats what qr-api and stats-api do, and the duplication is the point:
 * a service that validates only what it trusts its caller to have validated is
 * a service one direct call away from an incident. The messages name the exact
 * position so a client can fix the input without guesswork.
 *
 * @throws WorkflowError with kind `invalid-matrix`
 */
export function validateMatrixInput(raw: unknown, maxDim: number): ValidatedInput {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new WorkflowError('invalid-matrix', 'field "matrix" must be a non-empty array of arrays of numbers');
  }

  const rows = raw as unknown[];
  const firstRow = rows[0];
  if (!Array.isArray(firstRow)) {
    throw new WorkflowError('invalid-matrix', 'matrix row 0 must be an array of numbers');
  }
  if (firstRow.length === 0) {
    throw new WorkflowError('invalid-matrix', 'matrix row 0 must contain at least one number');
  }

  const cols = firstRow.length;

  if (rows.length > maxDim) {
    throw new WorkflowError(
      'invalid-matrix',
      `matrix has ${rows.length} rows, the maximum is ${maxDim}`,
    );
  }
  if (cols > maxDim) {
    throw new WorkflowError(
      'invalid-matrix',
      `matrix has ${cols} columns, the maximum is ${maxDim}`,
    );
  }

  const matrix: Matrix = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!Array.isArray(row)) {
      throw new WorkflowError('invalid-matrix', `matrix row ${i} must be an array of numbers`);
    }
    if (row.length !== cols) {
      throw new WorkflowError(
        'invalid-matrix',
        `row ${i} has length ${row.length}, expected ${cols}`,
      );
    }
    for (let j = 0; j < row.length; j += 1) {
      if (typeof row[j] !== 'number' || !Number.isFinite(row[j])) {
        throw new WorkflowError(
          'invalid-matrix',
          `value at row ${i}, column ${j} is not a finite number`,
        );
      }
    }
    matrix.push(row as number[]);
  }

  return { matrix };
}
