import { ApiError, analyze, login } from '../apiClient';
import { resetApiUrlCache } from '../../../../config/runtimeConfig';

/**
 * API client tests.
 *
 * The focus is error mapping. The client is the app's only view of the
 * backend's HTTP semantics, and every status code the orchestrator can return
 * has to become the right {@link ApiError} kind -- because the kind is what
 * decides whether the user sees an error, waits, or is sent back to login.
 */

/** Builds a Response with a JSON body and the given status. */
function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Builds a Response whose body is not JSON at all. */
function textResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
    text: async () => body,
  } as unknown as Response;
}

/** Installs a fetch double and returns it. */
function mockFetch(implementation: (url: string, init?: RequestInit) => Promise<Response>): jest.Mock {
  const fetchMock = jest.fn(implementation) as unknown as jest.Mock;
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** The API call made by the client, ignoring any config lookup. */
function apiCall(fetchMock: jest.Mock): { url: string; init?: RequestInit } {
  const calls = fetchMock.mock.calls.filter(
    (call: unknown[]) => !String(call[0]).endsWith('/config.json'),
  );
  const last = calls[calls.length - 1] as [string, RequestInit] | undefined;
  if (!last) throw new Error('no API call was made');
  return { url: last[0], init: last[1] };
}

/** The body of the API request. */
function lastBody(fetchMock: jest.Mock): unknown {
  return JSON.parse(String(apiCall(fetchMock).init?.body ?? 'null'));
}

/** The headers of the API request. */
function lastHeaders(fetchMock: jest.Mock): Record<string, string> {
  return (apiCall(fetchMock).init?.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  // The API URL is cached in a module-level promise, so it has to be reset
  // between tests or the first one's stub leaks into the rest.
  resetApiUrlCache();
  process.env.EXPO_PUBLIC_API_URL = 'http://api.test:3000';
  resetApiUrlCache();
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_API_URL;
  jest.restoreAllMocks();
});

describe('login', () => {
  it('posts the credentials and returns the token response', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse(200, { accessToken: 'token-abc', tokenType: 'Bearer', expiresIn: 900 }),
    );

    const result = await login('demo', 'demo-password');

    expect(result).toEqual({ accessToken: 'token-abc', tokenType: 'Bearer', expiresIn: 900 });
    expect(lastBody(fetchMock)).toEqual({ username: 'demo', password: 'demo-password' });
  });

  it('targets the login path on the orchestrator', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse(200, { accessToken: 't', tokenType: 'Bearer', expiresIn: 900 }),
    );

    await login('demo', 'pw');

    expect(apiCall(fetchMock).url).toBe('http://api.test:3000/auth/login');
  });

  it('sends no Authorization header, because there is no token yet', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse(200, { accessToken: 't', tokenType: 'Bearer', expiresIn: 900 }),
    );

    await login('demo', 'pw');

    expect(lastHeaders(fetchMock).Authorization).toBeUndefined();
  });

  it('maps bad credentials to unauthenticated', async () => {
    // 401 means "log in again", which is exactly what a wrong password needs.
    mockFetch(async () =>
      jsonResponse(401, { detail: 'Invalid username or password.' }, { 'X-Request-Id': 'req-1' }),
    );

    await expect(login('demo', 'wrong')).rejects.toMatchObject({
      kind: 'unauthenticated',
      detail: 'Invalid username or password.',
      requestId: 'req-1',
    });
  });

  it('marks a 401 as requiring a new login', async () => {
    mockFetch(async () => jsonResponse(401, { detail: 'nope' }));

    const error = await login('demo', 'wrong').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).requiresLogin).toBe(true);
  });
});

describe('analyze', () => {
  it('posts the matrix and returns the aggregated response', async () => {
    const payload = {
      requestId: 'req-1',
      input: { rows: 3, cols: 3 },
      qr: { q: [[1]], r: [[1]] },
      stats: {
        global: { max: 1, min: 1, average: 1, sum: 1, anyDiagonal: false },
        perMatrix: [{ id: 'Q', max: 1, min: 1, average: 1, sum: 1, isDiagonal: false }],
      },
    };
    const fetchMock = mockFetch(async () => jsonResponse(200, payload));

    const result = await analyze([[1]], { token: 'token-abc' });

    expect(result).toEqual(payload);
    expect(lastBody(fetchMock)).toEqual({ matrix: [[1]] });
  });

  it('forwards the bearer token', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, {}));

    await analyze([[1]], { token: 'token-abc' });

    expect(lastHeaders(fetchMock).Authorization).toBe('Bearer token-abc');
  });

  it.each([
    [400, 'invalid-matrix'],
    [422, 'invalid-matrix'],
    [429, 'rate-limited'],
    [503, 'service-unavailable'],
    [500, 'unexpected'],
    [418, 'unexpected'],
  ])('maps a %i to %s', async (status, kind) => {
    mockFetch(async () => jsonResponse(status, { detail: 'server says so' }));

    await expect(analyze([[1]], { token: 't' })).rejects.toMatchObject({ kind });
  });

  it('preserves the server detail on a 422', async () => {
    // The whole point of the problem+json contract: the user reads
    // "row 2 has length 2, expected 3", not "invalid matrix".
    mockFetch(async () =>
      jsonResponse(422, { detail: 'row 2 has length 2, expected 3' }, { 'X-Request-Id': 'req-9' }),
    );

    await expect(analyze([[1]], { token: 't' })).rejects.toMatchObject({
      kind: 'invalid-matrix',
      detail: 'row 2 has length 2, expected 3',
      requestId: 'req-9',
    });
  });

  it('does not require a new login for any status other than 401', async () => {
    mockFetch(async () => jsonResponse(503, { detail: 'unavailable' }));

    await expect(analyze([[1]], { token: 't' })).rejects.toMatchObject({
      requiresLogin: false,
    });
  });

  it('maps a transport failure to network', async () => {
    // No response at all: DNS, refused connection, CORS. None of them is the
    // user's fault and none of them is a bad token.
    mockFetch(async () => {
      throw new TypeError('Network request failed');
    });

    await expect(analyze([[1]], { token: 't' })).rejects.toMatchObject({ kind: 'network' });
  });

  it('maps a non-JSON success body to unexpected', async () => {
    // A proxy's HTML page must never be parsed as a result.
    mockFetch(async () => textResponse(200, '<html>maintenance</html>'));

    await expect(analyze([[1]], { token: 't' })).rejects.toMatchObject({ kind: 'unexpected' });
  });

  it('ignores a non-problem error body when reading the detail', async () => {
    mockFetch(async () => textResponse(500, '<html>oops</html>'));

    await expect(analyze([[1]], { token: 't' })).rejects.toMatchObject({
      kind: 'unexpected',
      detail: undefined,
    });
  });

  it('surfaces the correlation id for an error report', async () => {
    mockFetch(async () => jsonResponse(500, { detail: 'boom' }, { 'X-Request-Id': 'trace-77' }));

    await expect(analyze([[1]], { token: 't' })).rejects.toMatchObject({ requestId: 'trace-77' });
  });

  it('aborts when the caller signals', async () => {
    const controller = new AbortController();
    mockFetch(async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    await expect(analyze([[1]], { token: 't', signal: controller.signal })).rejects.toMatchObject({
      kind: 'network',
    });
  });
});

describe('ApiError', () => {
  it('carries the kind, the detail and the request id', () => {
    const error = new ApiError('invalid-matrix', 'message', 'detail', 'req-1');

    expect(error.kind).toBe('invalid-matrix');
    expect(error.message).toBe('message');
    expect(error.detail).toBe('detail');
    expect(error.requestId).toBe('req-1');
    expect(error.name).toBe('ApiError');
  });

  it('reports whether a new login is required', () => {
    expect(new ApiError('unauthenticated', 'm').requiresLogin).toBe(true);
    expect(new ApiError('network', 'm').requiresLogin).toBe(false);
    expect(new ApiError('rate-limited', 'm').requiresLogin).toBe(false);
  });
});
