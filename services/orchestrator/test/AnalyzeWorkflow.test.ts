import { describe, expect, it } from 'vitest';

import {
  AnalyzeWorkflow,
  WorkflowError,
  validateMatrixInput,
  type AuthClient,
  type QrClient,
  type StatsClient,
} from '../src/matrix/application/AnalyzeWorkflow';
import type { LabeledMatrix, Matrix, QrFactorization, StatsResult } from '../src/matrix/domain/types';

/** Limits used throughout. */
const LIMITS = { maxMatrixDim: 100 };

/**
 * The 3x3 example from the challenge. Its QR factorization is well known, which
 * is what makes it a useful fixture: an error anywhere in the pipeline shows up
 * as a visibly wrong answer rather than a subtly wrong one.
 */
const KNOWN_MATRIX: Matrix = [
  [12, -51, 4],
  [6, 167, -68],
  [-4, 24, -41],
];

/** The expected full QR factorization of {@link KNOWN_MATRIX}. */
const KNOWN_QR: QrFactorization = {
  q: [
    [-6 / 7, 69 / 175, -58 / 175],
    [-3 / 7, 158 / 175, 6 / 175],
    [-2 / 7, -6 / 35, -33 / 35],
  ],
  r: [
    [-14, -21, 14],
    [0, -175, 70],
    [0, 0, -35],
  ],
};

/**
 * A stats result consistent with {@link KNOWN_QR}.
 *
 * The values are fixed rather than derived: this stub stands in for stats-api,
 * and re-deriving them here would only re-test that arithmetic.
 */
function statsFor(): StatsResult {
  return {
    global: { max: 1, min: -175, average: 0, sum: 0, anyDiagonal: false },
    perMatrix: [
      { id: 'Q', max: 1, min: -1, average: 0, sum: 0, isDiagonal: false },
      { id: 'R', max: 70, min: -175, average: 0, sum: 0, isDiagonal: false },
    ],
  };
}

/**
 * A recording stub for each port.
 *
 * Every stub records what it was called with, which is how the tests assert on
 * the workflow's behaviour rather than only on its result: which token was
 * forwarded, which request id travelled, and in what order the ports were
 * called.
 */
class StubAuth implements AuthClient {
  calls: Array<{ method: string; token: string; requestId: string }> = [];
  validateError: Error | undefined;
  loginResponse = { accessToken: 'token-abc', tokenType: 'Bearer' as const, expiresIn: 900 };

  validate(token: string, requestId: string): Promise<void> {
    this.calls.push({ method: 'validate', token, requestId });
    // An async port may reject; a synchronous throw is equivalent to the caller
    // and keeps the stub free of an unnecessary async wrapper.
    return this.validateError ? Promise.reject(this.validateError) : Promise.resolve();
  }

  login(username: string, _password: string, requestId: string): Promise<{
    accessToken: string;
    tokenType: 'Bearer';
    expiresIn: number;
  }> {
    this.calls.push({ method: 'login', token: username, requestId });
    return Promise.resolve(this.loginResponse);
  }
}

class StubQr implements QrClient {
  calls: Array<{ matrix: Matrix; token: string; requestId: string }> = [];
  error: Error | undefined;

  factorize(matrix: Matrix, token: string, requestId: string): Promise<QrFactorization> {
    this.calls.push({ matrix, token, requestId });
    return this.error ? Promise.reject(this.error) : Promise.resolve(KNOWN_QR);
  }
}

class StubStats implements StatsClient {
  calls: Array<{ matrices: readonly LabeledMatrix[]; token: string; requestId: string }> = [];
  error: Error | undefined;

  compute(
    matrices: readonly LabeledMatrix[],
    token: string,
    requestId: string,
  ): Promise<StatsResult> {
    this.calls.push({ matrices, token, requestId });
    return this.error ? Promise.reject(this.error) : Promise.resolve(statsFor());
  }
}

/** Builds a workflow over fresh stubs. */
function build(overrides: { limits?: { maxMatrixDim: number } } = {}) {
  const auth = new StubAuth();
  const qr = new StubQr();
  const stats = new StubStats();
  const workflow = new AnalyzeWorkflow({
    auth,
    qr,
    stats,
    limits: overrides.limits ?? LIMITS,
  });
  return { workflow, auth, qr, stats };
}

describe('validateMatrixInput', () => {
  it('accepts a rectangular matrix and returns it typed', () => {
    const result = validateMatrixInput(KNOWN_MATRIX, 100);
    expect(result.matrix).toEqual(KNOWN_MATRIX);
  });

  it('accepts a single element', () => {
    expect(validateMatrixInput([[5]], 100).matrix).toEqual([[5]]);
  });

  it('accepts a 1 x n row', () => {
    expect(validateMatrixInput([[1, 2, 3]], 100).matrix).toEqual([[1, 2, 3]]);
  });

  it('accepts a negative and fractional mix', () => {
    expect(validateMatrixInput([[-1.5, 0], [0, 2.25]], 100).matrix).toEqual([
      [-1.5, 0],
      [0, 2.25],
    ]);
  });

  it.each([
    ['a missing matrix', undefined, /must be a non-empty array/],
    ['an empty matrix', [], /must be a non-empty array/],
    ['a non-array body', 'nope', /must be a non-empty array/],
    ['a null body', null, /must be a non-empty array/],
    ['a matrix whose first row is not an array', [1, 2], /row 0 must be an array/],
    ['a matrix with an empty first row', [[]], /at least one number/],
    [
      'a ragged matrix',
      [[1, 2, 3], [4, 5]],
      /row 1 has length 2, expected 3/,
    ],
    [
      'a non-array later row',
      [[1, 2], 3],
      /row 1 must be an array of numbers/,
    ],
    [
      'a string cell',
      [[1, 'two']],
      /row 0, column 1 is not a finite number/,
    ],
    [
      'a null cell',
      [[1, null]],
      /row 0, column 1 is not a finite number/,
    ],
    [
      'a boolean cell',
      [[true]],
      /row 0, column 0 is not a finite number/,
    ],
  ])('rejects %s', (_label, input, expected) => {
    expect(() => validateMatrixInput(input, 100)).toThrow(WorkflowError);
    try {
      validateMatrixInput(input, 100);
      expect.unreachable('expected a WorkflowError');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);
      expect((error as WorkflowError).kind).toBe('invalid-matrix');
      expect((error as WorkflowError).detail).toMatch(expected);
    }
  });

  it('rejects a value too large for a float64', () => {
    // JSON.parse produces Infinity for this, so the guard is reachable through
    // a syntactically valid body.
    expect(() => validateMatrixInput([[Number.POSITIVE_INFINITY]], 100)).toThrow(
      /not a finite number/,
    );
  });

  it('rejects a matrix with too many rows', () => {
    const matrix = Array.from({ length: 5 }, () => [1]);
    expect(() => validateMatrixInput(matrix, 4)).toThrow(/5 rows, the maximum is 4/);
  });

  it('rejects a matrix with too many columns', () => {
    expect(() => validateMatrixInput([[1, 2, 3, 4, 5]], 4)).toThrow(/5 columns, the maximum is 4/);
  });

  it('accepts a matrix exactly at the limit', () => {
    expect(validateMatrixInput([[1, 2, 3, 4]], 4).matrix).toEqual([[1, 2, 3, 4]]);
  });
});

describe('AnalyzeWorkflow.execute', () => {
  it('returns the shape, the factorization and the statistics', async () => {
    const { workflow } = build();

    const result = await workflow.execute(KNOWN_MATRIX, 'token-abc', 'req-1');

    expect(result.input).toEqual({ rows: 3, cols: 3 });
    expect(result.qr).toEqual(KNOWN_QR);
    expect(result.stats.global.anyDiagonal).toBe(false);
    expect(result.stats.perMatrix).toHaveLength(2);
  });

  it('sends Q and R to the statistics service, labelled', async () => {
    // The labels are what let the response say which factor is diagonal; sending
    // anonymous matrices would lose that entirely.
    const { workflow, stats } = build();

    await workflow.execute(KNOWN_MATRIX, 'token-abc', 'req-1');

    expect(stats.calls).toHaveLength(1);
    const [call] = stats.calls;
    expect(call?.matrices.map((entry) => entry.id)).toEqual(['Q', 'R']);
    expect(call?.matrices[0]?.data).toEqual(KNOWN_QR.q);
    expect(call?.matrices[1]?.data).toEqual(KNOWN_QR.r);
  });

  it('propagates the caller token to every downstream port', async () => {
    // Zero trust: qr-api and stats-api each validate the token themselves, so
    // the original must travel, not a service-scoped one.
    const { workflow, auth, qr, stats } = build();

    await workflow.execute(KNOWN_MATRIX, 'caller-token', 'req-1');

    expect(auth.calls[0]?.token).toBe('caller-token');
    expect(qr.calls[0]?.token).toBe('caller-token');
    expect(stats.calls[0]?.token).toBe('caller-token');
  });

  it('propagates the request id to every downstream port', async () => {
    const { workflow, auth, qr, stats } = build();

    await workflow.execute(KNOWN_MATRIX, 'token', 'req-42');

    expect(auth.calls[0]?.requestId).toBe('req-42');
    expect(qr.calls[0]?.requestId).toBe('req-42');
    expect(stats.calls[0]?.requestId).toBe('req-42');
  });

  it('runs the ports in order: validate, factorize, statistics', async () => {
    const { workflow, auth, qr, stats } = build();

    await workflow.execute(KNOWN_MATRIX, 'token', 'req-1');

    expect(auth.calls).toHaveLength(1);
    expect(qr.calls).toHaveLength(1);
    expect(stats.calls).toHaveLength(1);
  });

  it('reports the shape of a non-square matrix correctly', async () => {
    const { workflow } = build();

    const result = await workflow.execute([[1, 2, 3], [4, 5, 6]], 'token', 'req-1');

    expect(result.input).toEqual({ rows: 2, cols: 3 });
  });

  describe('failures', () => {
    it('refuses an empty token without calling the authority', async () => {
      // No network call for a request that could never have been authorized.
      const { workflow, auth } = build();

      await expect(workflow.execute(KNOWN_MATRIX, '   ', 'req-1')).rejects.toThrow(WorkflowError);
      expect(auth.calls).toHaveLength(0);
    });

    it('reports a rejected token as unauthorized', async () => {
      const { workflow, auth, qr } = build();
      auth.validateError = new WorkflowError('unauthorized', 'A valid bearer token is required.');

      await expect(workflow.execute(KNOWN_MATRIX, 'token', 'req-1')).rejects.toMatchObject({
        kind: 'unauthorized',
      });
      // The workflow must stop: nothing downstream should run.
      expect(qr.calls).toHaveLength(0);
    });

    it('fails closed when the authority is unavailable', async () => {
      // "The token is bad" and "I could not check the token" must stay
      // distinguishable: only the first should send a client back to the login
      // screen, and a conflated answer creates an endless re-login loop against
      // a service that is simply down.
      const { workflow, auth, qr } = build();
      auth.validateError = new WorkflowError(
        'auth-unavailable',
        'The authentication service could not be reached.',
      );

      await expect(workflow.execute(KNOWN_MATRIX, 'token', 'req-1')).rejects.toMatchObject({
        kind: 'auth-unavailable',
      });
      expect(qr.calls).toHaveLength(0);
    });

    it('validates the matrix before authorizing', async () => {
      // Local validation is free, so it runs first: an oversized or malformed
      // matrix is refused without a network round trip.
      const { workflow, auth } = build();

      await expect(workflow.execute([], 'token', 'req-1')).rejects.toMatchObject({
        kind: 'invalid-matrix',
      });
      expect(auth.calls).toHaveLength(0);
    });

    it('propagates a QR failure without calling the statistics service', async () => {
      const { workflow, qr, stats } = build();
      qr.error = new WorkflowError('downstream-timeout', 'The QR service did not respond in time.');

      await expect(workflow.execute(KNOWN_MATRIX, 'token', 'req-1')).rejects.toMatchObject({
        kind: 'downstream-timeout',
      });
      expect(stats.calls).toHaveLength(0);
    });

    it('propagates a statistics failure', async () => {
      const { workflow, stats } = build();
      stats.error = new WorkflowError('downstream-failure', 'The statistics service returned an error.');

      await expect(workflow.execute(KNOWN_MATRIX, 'token', 'req-1')).rejects.toMatchObject({
        kind: 'downstream-failure',
      });
    });

    it('surfaces the downstream reason in the detail', async () => {
      // The whole point of preserving a precise reason is that the user reads
      // it: "row 2 has length 2, expected 3" beats "bad gateway".
      const { workflow, qr } = build();
      qr.error = new WorkflowError('invalid-matrix', 'row 2 has length 2, expected 3');

      await expect(workflow.execute(KNOWN_MATRIX, 'token', 'req-1')).rejects.toThrow(
        'row 2 has length 2, expected 3',
      );
    });
  });

  it('does not mutate the matrix it is given', async () => {
    const { workflow } = build();
    const input = structuredClone(KNOWN_MATRIX);

    await workflow.execute(input, 'token', 'req-1');

    expect(input).toEqual(KNOWN_MATRIX);
  });

  it('exposes login on the same port the workflow uses', async () => {
    // The auth port covers login as well as validate, because the orchestrator
    // proxies login and both go to the same service with the same connection
    // settings.
    const { auth } = build();
    const result = await auth.login('demo', 'secret', 'req-1');

    expect(result.accessToken).toBe('token-abc');
    expect(auth.calls[0]).toEqual({ method: 'login', token: 'demo', requestId: 'req-1' });
  });
});

describe('WorkflowError', () => {
  it('carries a kind, a detail and an optional cause', () => {
    const cause = new Error('ECONNREFUSED');
    const error = new WorkflowError('downstream-failure', 'unreachable', { cause });

    expect(error.kind).toBe('downstream-failure');
    expect(error.detail).toBe('unreachable');
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('unreachable');
    expect(error.name).toBe('WorkflowError');
  });
});
