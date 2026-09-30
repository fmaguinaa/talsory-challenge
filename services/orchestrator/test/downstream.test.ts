import { describe, expect, it } from 'vitest';

import {
  backoffFor,
  buildRequestConfig,
  classifyAxiosError,
  downstreamHeaders,
  extractProblemDetail,
  isHttpFailure,
  isRetryable,
  toWorkflowError,
  type DownstreamOptions,
} from '../src/common/downstream';
import { extractBearerToken } from '../src/common/requestContext';

/** Connection settings shared by the tests. */
const OPTIONS: DownstreamOptions = {
  baseUrl: 'http://service:4000',
  timeoutMs: 3000,
  retries: 1,
  retryBackoffMs: 100,
};

/**
 * Builds an error shaped like the ones axios produces.
 *
 * Constructing it by hand rather than calling axios is deliberate: the whole
 * point of the classification is that it must not depend on a class identity,
 * so the tests must not supply one either.
 */
function httpFailure(overrides: {
  status?: number;
  data?: unknown;
  code?: string;
}): unknown {
  const failure: Record<string, unknown> = { isAxiosError: true };
  if (overrides.status !== undefined) {
    failure.response = { status: overrides.status, data: overrides.data ?? {} };
  }
  if (overrides.code !== undefined) failure.code = overrides.code;
  return failure;
}

describe('isHttpFailure', () => {
  it('recognises an axios error', () => {
    expect(isHttpFailure(httpFailure({ status: 500 }))).toBe(true);
  });

  it.each([
    ['a plain Error', new Error('boom')],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'boom'],
    ['an object without the marker', { response: { status: 500 } }],
    ['an object with the marker set to something else', { isAxiosError: 'yes' }],
  ])('does not recognise %s', (_label, value) => {
    // Guessing wrong here means reporting a downstream error as something the
    // client can act on, so the check must be strict.
    expect(isHttpFailure(value)).toBe(false);
  });
});

describe('classifyAxiosError', () => {
  it('maps a 401 to unauthorized', () => {
    // The distinction that matters most: the client must be told to log in
    // again rather than to retry.
    expect(classifyAxiosError(httpFailure({ status: 401 }), 'QR').kind).toBe('unauthorized');
  });

  it('maps a 403 to unauthorized', () => {
    expect(classifyAxiosError(httpFailure({ status: 403 }), 'QR').kind).toBe('unauthorized');
  });

  it('maps a 503 to auth-unavailable rather than to a generic failure', () => {
    // A downstream reporting 503 has lost its own dependency. Flattening that
    // into 502 would hide which one.
    expect(classifyAxiosError(httpFailure({ status: 503 }), 'QR').kind).toBe('auth-unavailable');
  });

  it.each([
    [400, 'invalid-matrix'],
    [422, 'invalid-matrix'],
  ])('maps a %i to invalid-matrix', (status, kind) => {
    expect(classifyAxiosError(httpFailure({ status }), 'QR').kind).toBe(kind);
  });

  it('maps a 500 to downstream-failure', () => {
    expect(classifyAxiosError(httpFailure({ status: 500 }), 'QR').kind).toBe('downstream-failure');
  });

  it('maps a 504 to downstream-timeout', () => {
    expect(classifyAxiosError(httpFailure({ status: 504 }), 'QR').kind).toBe('downstream-timeout');
  });

  it.each([
    ['a DNS failure', 'ENOTFOUND'],
    ['a refused connection', 'ECONNREFUSED'],
    ['a reset connection', 'ECONNRESET'],
  ])('maps %s with no response to downstream-failure', (_label, code) => {
    expect(classifyAxiosError(httpFailure({ code }), 'QR').kind).toBe('downstream-failure');
  });

  it.each([
    ['a connect timeout', 'ECONNABORTED'],
    ['a read timeout', 'ETIMEDOUT'],
  ])('maps %s to downstream-timeout', (_label, code) => {
    // A timeout is told apart from a refusal on purpose: 504 means "try again
    // later", 502 means "something is broken".
    expect(classifyAxiosError(httpFailure({ code }), 'QR').kind).toBe('downstream-timeout');
  });

  it('never leaks the internal transport message to the caller', () => {
    const classified = classifyAxiosError(httpFailure({ code: 'ECONNREFUSED' }), 'QR');
    // A client has no use for "connect ECONNREFUSED 10.0.0.4:4000".
    expect(classified.message).not.toContain('ECONNREFUSED');
    expect(classified.message).toBe('The QR service could not be reached.');
  });

  it('maps a non-HTTP failure to downstream-failure', () => {
    expect(classifyAxiosError(new Error('boom'), 'QR').kind).toBe('downstream-failure');
  });

  it('keeps the downstream problem detail when there is one', () => {
    // The whole reason for preserving the reason: the user reads
    // "row 2 has length 2, expected 3", not "bad gateway".
    const classified = classifyAxiosError(
      httpFailure({
        status: 422,
        data: { detail: 'row 2 has length 2, expected 3' },
      }),
      'QR',
    );

    expect(classified.problemDetail).toBe('row 2 has length 2, expected 3');
  });
});

describe('isRetryable', () => {
  it('retries a 5xx, because the request provably had no effect', () => {
    expect(isRetryable(httpFailure({ status: 500 }))).toBe(true);
    expect(isRetryable(httpFailure({ status: 503 }))).toBe(true);
  });

  it('does not retry a 4xx', () => {
    // The service understood the request and refused it; repeating it would
    // only multiply load during an incident.
    for (const status of [400, 401, 403, 404, 422, 429]) {
      expect(isRetryable(httpFailure({ status }))).toBe(false);
    }
  });

  it('retries a transport failure, including a timeout', () => {
    expect(isRetryable(httpFailure({ code: 'ECONNREFUSED' }))).toBe(true);
    expect(isRetryable(httpFailure({ code: 'ECONNABORTED' }))).toBe(true);
  });

  it('does not retry something that is not an HTTP failure', () => {
    expect(isRetryable(new Error('boom'))).toBe(false);
  });
});

describe('toWorkflowError', () => {
  it('passes an already-classified failure through unchanged', () => {
    // callWithRetry classifies before throwing. Re-classifying a DownstreamError
    // would treat it as an opaque error and flatten a precise timeout into a
    // generic failure -- a mistake that actually shipped and was caught here.
    const classified = classifyAxiosError(httpFailure({ code: 'ECONNABORTED' }), 'QR');
    const workflowError = toWorkflowError(classified, 'QR');

    expect(workflowError.kind).toBe('downstream-timeout');
  });

  it('classifies a raw failure', () => {
    expect(toWorkflowError(httpFailure({ status: 401 }), 'QR').kind).toBe('unauthorized');
  });

  it('prefers the downstream detail over the generic message', () => {
    const workflowError = toWorkflowError(
      httpFailure({ status: 422, data: { detail: 'row 1 has length 2, expected 3' } }),
      'QR',
    );

    expect(workflowError.detail).toBe('row 1 has length 2, expected 3');
  });

  it('falls back to the generic message when the downstream sent no detail', () => {
    const workflowError = toWorkflowError(httpFailure({ status: 500 }), 'QR');
    expect(workflowError.detail).toBe('The QR service returned an error.');
  });
});

describe('extractProblemDetail', () => {
  it('reads the RFC 9457 detail field', () => {
    expect(extractProblemDetail({ detail: 'boom' })).toBe('boom');
  });

  it('falls back to a message field', () => {
    expect(extractProblemDetail({ message: 'boom' })).toBe('boom');
  });

  it.each([
    ['a string', 'boom'],
    ['null', null],
    ['an empty document', {}],
    ['a non-string detail', { detail: 42 }],
    ['an HTML error page', '<html>nope</html>'],
  ])('returns undefined for %s', (_label, value) => {
    // Anything else must fall back to a generic message rather than echo an
    // HTML error page back to the client.
    expect(extractProblemDetail(value)).toBeUndefined();
  });
});

describe('downstreamHeaders', () => {
  it('forwards the bearer token verbatim', () => {
    // Each service authorizes independently, so the caller's own token travels
    // rather than a service-scoped credential.
    expect(downstreamHeaders('caller-token', 'req-1')).toMatchObject({
      Authorization: 'Bearer caller-token',
      'X-Request-Id': 'req-1',
    });
  });
});

describe('buildRequestConfig', () => {
  it('applies the base URL and timeout', () => {
    expect(buildRequestConfig(OPTIONS)).toMatchObject({
      baseURL: 'http://service:4000',
      timeout: 3000,
    });
  });

  it('does not carry credentials of its own', () => {
    // Headers are supplied per call, because the token differs per request.
    expect(buildRequestConfig(OPTIONS).headers).toBeUndefined();
  });
});

describe('backoffFor', () => {
  it('doubles on each attempt', () => {
    // Exponential backoff: a struggling dependency must not be hammered.
    expect(backoffFor(0, 100)).toBe(100);
    expect(backoffFor(1, 100)).toBe(200);
    expect(backoffFor(2, 100)).toBe(400);
    expect(backoffFor(3, 100)).toBe(800);
  });
});

describe('extractBearerToken', () => {
  it.each([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['BEARER abc', 'abc'],
    ['Bearer   abc  ', 'abc'],
    ['Bearer a.b.c', 'a.b.c'],
    ['Basic abc', ''],
    ['Bearer', ''],
    ['Bearer ', ''],
    ['', ''],
    [undefined, ''],
  ])('parses %s', (header, expected) => {
    expect(extractBearerToken(header)).toBe(expected);
  });
});
