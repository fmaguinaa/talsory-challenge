import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AuthUnavailableError,
  ComputeStatsUseCase,
  UnauthorizedError,
  type TokenValidationResult,
  type TokenValidator,
} from '../src/application/ComputeStatsUseCase';
import type { StatsLimits } from '../src/application/computeStats';
import { HttpTokenValidator } from '../src/adapters/authclient/HttpTokenValidator';
import { buildApp } from '../src/adapters/http/router';
import { HttpProblem } from '../src/adapters/http/problem';
import { PROBLEM_MEDIA_TYPE, type ProblemDetail } from '../src/adapters/http/problem';
import { REQUEST_ID_HEADER, extractBearerToken } from '../src/adapters/http/requestContext';

/** Limits shared by the tests in this file. */
const LIMITS: StatsLimits = {
  maxMatrices: 4,
  maxTotalElements: 40,
  maxMatrixDim: 6,
};

/** A logger that discards everything, keeping test output readable. */
const logger = pino({ level: 'silent' });

/**
 * A TokenValidator whose answer the test controls.
 *
 * Using this rather than a stub HTTP server for the authorization path keeps
 * the endpoint tests focused on the endpoint; the HTTP validator itself is
 * exercised separately in `authClient.test.ts` against a real server.
 */
class StubValidator implements TokenValidator {
  constructor(private outcome: TokenValidationResult = 'active') {}
  calls = 0;
  seenTokens: string[] = [];

  validate(token: string): Promise<TokenValidationResult> {
    this.calls += 1;
    this.seenTokens.push(token);
    return Promise.resolve(this.outcome);
  }
}

/**
 * A validator that exercises the use case's error handling directly, including
 * the unreachable-authority path.
 */
class ThrowingValidator implements TokenValidator {
  constructor(private readonly error: Error) {}
  validate(): Promise<TokenValidationResult> {
    return Promise.reject(this.error);
  }
}

/** Builds the Express app around a given validator. */
function appWith(validator: TokenValidator, maxBodyBytes = 64 * 1024) {
  const useCase = new ComputeStatsUseCase({ validator, limits: LIMITS, epsilon: 1e-9 });
  return buildApp({ useCase, logger, maxBodyBytes, limits: LIMITS });
}

/** Sends a request and returns the status, parsed problem (if any) and body. */
async function post(
  app: ReturnType<typeof appWith>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; problem: ProblemDetail | undefined; body: Record<string, unknown> }> {
  const req = request(app).post('/api/v1/stats').set('Content-Type', 'application/json');
  for (const [key, value] of Object.entries(headers)) req.set(key, value);
  const response = await req.send(JSON.stringify(body));

  const isProblem = (response.headers['content-type'] ?? '').toString().includes(PROBLEM_MEDIA_TYPE);
  return {
    status: response.status,
    problem: isProblem ? (response.body as ProblemDetail) : undefined,
    body: response.body as Record<string, unknown>,
  };
}

describe('POST /api/v1/stats', () => {
  let validator: StubValidator;
  let app: ReturnType<typeof appWith>;

  beforeEach(() => {
    validator = new StubValidator();
    app = appWith(validator);
  });

  it('returns 200 with global and per-matrix statistics', async () => {
    const { status, body } = await post(
      app,
      { matrices: [{ id: 'Q', data: [[1, 2]] }, { id: 'R', data: [[3, 4]] }] },
      { Authorization: 'Bearer token' },
    );

    expect(status).toBe(200);
    expect(body.global).toEqual({
      max: 4,
      min: 1,
      average: 2.5,
      sum: 10,
      anyDiagonal: false,
    });
    expect(body.perMatrix).toHaveLength(2);
  });

  it('does not leak the internal count field', async () => {
    // contracts/stats-api.yaml is the published contract, and `count` is not in
    // it. The orchestrator forwards this response verbatim, so an extra field
    // would be a contract drift.
    const { body } = await post(
      app,
      { matrices: [{ id: 'Q', data: [[1, 2]] }] },
      { Authorization: 'Bearer token' },
    );

    expect(body.global).not.toHaveProperty('count');
    const perMatrix = body.perMatrix as Array<Record<string, unknown>>;
    expect(perMatrix[0]).not.toHaveProperty('count');
  });

  it('flags a diagonal matrix and sets anyDiagonal', async () => {
    const { body } = await post(
      app,
      {
        matrices: [
          { id: 'Q', data: [[1, 0], [0, 2]] },
          { id: 'R', data: [[0, 3], [4, 0]] },
        ],
      },
      { Authorization: 'Bearer token' },
    );

    const perMatrix = body.perMatrix as Array<Record<string, unknown>>;
    expect(perMatrix[0]?.isDiagonal).toBe(true);
    expect(perMatrix[1]?.isDiagonal).toBe(false);
    expect((body.global as Record<string, unknown>).anyDiagonal).toBe(true);
  });

  it('forwards the bearer token to the validator verbatim', async () => {
    await post(app, { matrices: [{ id: 'Q', data: [[1]] }] }, { Authorization: 'Bearer abc.def' });
    expect(validator.seenTokens).toEqual(['abc.def']);
  });

  it('accepts a lowercase bearer scheme, as RFC 7235 requires', async () => {
    const { status } = await post(
      app,
      { matrices: [{ id: 'Q', data: [[1]] }] },
      { Authorization: 'bearer abc.def' },
    );
    expect(status).toBe(200);
  });

  describe('401 Unauthorized', () => {
    it('rejects a request with no Authorization header', async () => {
      const { status, problem } = await post(app, { matrices: [{ id: 'Q', data: [[1]] }] });

      expect(status).toBe(401);
      expect(problem?.title).toBe('Unauthorized');
      expect(problem?.type).toContain('unauthorized');
      expect(problem?.requestId).toBeTruthy();
      expect(validator.calls).toBe(0);
    });

    it('rejects a non-Bearer scheme', async () => {
      const { status } = await post(
        app,
        { matrices: [{ id: 'Q', data: [[1]] }] },
        { Authorization: 'Basic dXNlcjpwYXNz' },
      );
      expect(status).toBe(401);
      expect(validator.calls).toBe(0);
    });

    it('rejects an inactive token with a problem document', async () => {
      const inactive = appWith(new StubValidator('inactive'));
      const { status, problem } = await post(
        inactive,
        { matrices: [{ id: 'Q', data: [[1]] }] },
        { Authorization: 'Bearer revoked' },
      );

      expect(status).toBe(401);
      expect(problem?.detail).toContain('valid bearer token');
    });

    it('sets WWW-Authenticate on a 401', async () => {
      // RFC 6750 requires the challenge header so a client knows how to
      // authenticate rather than guessing.
      const response = await request(app)
        .post('/api/v1/stats')
        .send({ matrices: [{ id: 'Q', data: [[1]] }] });

      expect(response.status).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer realm="stats-api"');
    });
  });

  describe('503 Service Unavailable', () => {
    it('fails closed when the authority reports itself unavailable', async () => {
      const down = appWith(new StubValidator('unavailable'));
      const { status, problem } = await post(
        down,
        { matrices: [{ id: 'Q', data: [[1]] }] },
        { Authorization: 'Bearer token' },
      );

      expect(status).toBe(503);
      expect(problem?.type).toContain('service-unavailable');
    });

    it('fails closed when the validator throws', async () => {
      const throwing = appWith(new ThrowingValidator(new Error('connection refused')));
      const { status } = await post(
        throwing,
        { matrices: [{ id: 'Q', data: [[1]] }] },
        { Authorization: 'Bearer token' },
      );
      expect(status).toBe(503);
    });

    it('treats an unexpected validator outcome as unavailability, not as success', async () => {
      // An adapter returning a value outside the union is a bug; the only safe
      // response to a bug in authorization is to refuse the request.
      const broken = appWith({
        validate: () => Promise.resolve('maybe' as TokenValidationResult),
      });
      const { status } = await post(
        broken,
        { matrices: [{ id: 'Q', data: [[1]] }] },
        { Authorization: 'Bearer token' },
      );
      expect(status).toBe(503);
    });

    it('sets Retry-After on a 503', async () => {
      const down = appWith(new StubValidator('unavailable'));
      const response = await request(down)
        .post('/api/v1/stats')
        .set('Authorization', 'Bearer token')
        .send({ matrices: [{ id: 'Q', data: [[1]] }] });

      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBe('5');
    });
  });

  describe('422 Unprocessable Entity', () => {
    it.each([
      ['a ragged matrix', { matrices: [{ id: 'Q', data: [[1, 2, 3], [4, 5]] }] }, 'row 1 has length 2, expected 3'],
      ['no matrices', { matrices: [] }, 'at least one matrix'],
      ['a missing matrices field', {}, 'field "matrices" is required'],
      ['an empty matrix', { matrices: [{ id: 'Q', data: [] }] }, 'at least one row'],
      ['a null cell', { matrices: [{ id: 'Q', data: [[1, null]] }] }, 'not a finite number'],
      ['a missing id', { matrices: [{ data: [[1]] }] }, 'id must be a non-empty string'],
    ])('rejects %s with a precise reason', async (_label, payload, expectedReason) => {
      const { status, problem } = await post(app, payload, { Authorization: 'Bearer token' });

      expect(status).toBe(422);
      expect(problem?.detail).toContain(expectedReason);
      expect(problem?.requestId).toBeTruthy();
    });
  });

  describe('413 Payload Too Large', () => {
    it('rejects a matrix with too many rows', async () => {
      const data = Array.from({ length: 7 }, () => [1]);
      const { status, problem } = await post(
        app,
        { matrices: [{ id: 'Q', data }] },
        { Authorization: 'Bearer token' },
      );

      expect(status).toBe(413);
      expect(problem?.detail).toContain('7 rows');
    });

    it('rejects too many matrices', async () => {
      const matrices = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, data: [[1]] }));
      const { status } = await post(app, { matrices }, { Authorization: 'Bearer token' });
      expect(status).toBe(413);
    });

    it('rejects a body larger than the configured byte limit', async () => {
      // The payload below is about 51 bytes, so a 30 byte limit makes the 413
      // observable without sending a body of megabytes.
      const tiny = appWith(validator, 30);
      const { status, problem } = await post(
        tiny,
        { matrices: [{ id: 'Q', data: [[1, 2, 3], [4, 5, 6]] }] },
        { Authorization: 'Bearer token' },
      );

      expect(status).toBe(413);
      expect(problem?.type).toContain('payload-too-large');
    });
  });

  it('rejects a value too large for a float64', async () => {
    // The body is sent as raw text because `1e999` cannot survive being held in
    // a JavaScript number: it would already be Infinity before serialization.
    // On the server, JSON.parse happily produces Infinity, which is exactly the
    // case the finiteness guard exists for.
    const response = await request(app)
      .post('/api/v1/stats')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer token')
      .send('{"matrices":[{"id":"Q","data":[[1e999]]}]}');

    expect(response.status).toBe(422);
    expect((response.body as ProblemDetail).detail).toContain('not a finite number');
  });

  it('returns 400 for a body that is not JSON', async () => {
    const response = await request(app)
      .post('/api/v1/stats')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer token')
      .send('{"matrices":');

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain(PROBLEM_MEDIA_TYPE);
    expect((response.body as ProblemDetail).type).toContain('malformed-request');
  });

  it('never returns a stack trace or an internal message', async () => {
    const { problem, body } = await post(
      app,
      { matrices: [{ id: 'Q', data: [[1, 2], [3]] }] },
      { Authorization: 'Bearer token' },
    );
    const serialized = JSON.stringify({ problem, body });

    expect(serialized).not.toContain('at Object.');
    expect(serialized).not.toContain('.ts:');
    expect(serialized).not.toContain('node_modules');
  });
});

describe('correlation id', () => {
  let validator: StubValidator;

  beforeEach(() => {
    validator = new StubValidator();
  });

  it('echoes an inbound request id', async () => {
    const app = appWith(validator);
    const response = await request(app)
      .post('/api/v1/stats')
      .set(REQUEST_ID_HEADER, 'trace-from-orchestrator')
      .set('Authorization', 'Bearer token')
      .send({ matrices: [{ id: 'Q', data: [[1]] }] });

    // Express lower-cases response header names, hence the lowercase lookup.
    expect(response.headers[REQUEST_ID_HEADER.toLowerCase()]).toBe('trace-from-orchestrator');
  });

  it('mints one when the request has none', async () => {
    const app = appWith(validator);
    const response = await request(app)
      .post('/api/v1/stats')
      .set('Authorization', 'Bearer token')
      .send({ matrices: [{ id: 'Q', data: [[1]] }] });

    expect(response.headers[REQUEST_ID_HEADER.toLowerCase()]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('replaces a hostile inbound id', async () => {
    // A newline in the header would let a caller forge log entries.
    const app = appWith(validator);
    const response = await request(app)
      .post('/api/v1/stats')
      .set(REQUEST_ID_HEADER, 'abc def;injected')
      .set('Authorization', 'Bearer token')
      .send({ matrices: [{ id: 'Q', data: [[1]] }] });

    expect(response.headers[REQUEST_ID_HEADER.toLowerCase()]).not.toBe('abc def;injected');
  });

  it('includes the request id in an error body', async () => {
    const app = appWith(validator);
    const { problem } = await post(app, { matrices: [] }, { Authorization: 'Bearer token' });
    expect(problem?.requestId).toBeTruthy();
  });
});

describe('health endpoints', () => {
  let app: ReturnType<typeof appWith>;

  beforeEach(() => {
    app = appWith(new StubValidator());
  });

  it.each(['/health/live', '/health/ready'])('serves %s without a token', async (path) => {
    const response = await request(app).get(path);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('does not consult the authority for readiness', async () => {
    // If readiness depended on auth-service, a slow authority would cause this
    // container to be pulled out of rotation and restarted: a degradation would
    // become an outage.
    const validator = new StubValidator();
    const app = appWith(validator);
    await request(app).get('/health/ready');
    expect(validator.calls).toBe(0);
  });
});

describe('unexpected failures', () => {
  /**
   * A use case that rejects with something the endpoint does not recognise,
   * standing in for a genuine bug (a typo, a null dereference) in business
   * logic. The contract is that the client gets a bare 500 with no internals,
   * and that the request does not hang.
   */
  function appWithExplodingUseCase(error: unknown) {
    const exploding = {
      execute: () => Promise.reject(error),
    } as unknown as InstanceType<typeof ComputeStatsUseCase>;
    return buildApp({ useCase: exploding, logger, maxBodyBytes: 64 * 1024, limits: LIMITS });
  }

  it('answers a generic 500 for an unrecognised failure', async () => {
    const app = appWithExplodingUseCase(new TypeError('cannot read property of undefined'));
    const { status, problem, body } = await post(
      app,
      { matrices: [{ id: 'Q', data: [[1]] }] },
      { Authorization: 'Bearer token' },
    );

    expect(status).toBe(500);
    expect(problem?.title).toBe('Internal server error');
    expect(problem?.detail).toBe('The service failed to handle the request.');

    // Nothing about the failure may reach the client.
    const serialized = JSON.stringify({ problem, body });
    expect(serialized).not.toContain('cannot read property');
    expect(serialized).not.toContain('TypeError');
  });

  it('honours an HttpProblem raised by the endpoint', async () => {
    // HttpProblem is how a route states an outcome it has already decided on,
    // so the error handler must pass it through with its status intact.
    const app = appWithExplodingUseCase(
      new HttpProblem(429, 'rate-limited', 'Too many requests', 'Slow down.'),
    );
    const { status, problem } = await post(
      app,
      { matrices: [{ id: 'Q', data: [[1]] }] },
      { Authorization: 'Bearer token' },
    );

    expect(status).toBe(429);
    expect(problem?.title).toBe('Too many requests');
    expect(problem?.detail).toBe('Slow down.');
  });

  it('sends a request id with a 500 so the failure can be traced', async () => {
    const app = appWithExplodingUseCase(new Error('boom'));
    const { problem } = await post(
      app,
      { matrices: [{ id: 'Q', data: [[1]] }] },
      { Authorization: 'Bearer token' },
    );
    expect(problem?.requestId).toBeTruthy();
  });
});

describe('unknown routes', () => {
  it('returns a 404 problem document', async () => {
    const app = appWith(new StubValidator());
    const response = await request(app).get('/nope');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain(PROBLEM_MEDIA_TYPE);
    expect((response.body as ProblemDetail).title).toBe('Not found');
  });
});

describe('extractBearerToken', () => {
  it.each([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['BEARER abc', 'abc'],
    ['Bearer   abc  ', 'abc'],
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['Basic abc', ''],
    ['Bearer', ''],
    ['Bearer ', ''],
    ['', ''],
    [undefined, ''],
  ])('parses %s', (header, expected) => {
    expect(extractBearerToken(header)).toBe(expected);
  });
});

/**
 * Integration tests for the HTTP introspection adapter, run against a real
 * server so the fetch path, the timeout and the cache are exercised end to end.
 */
describe('HttpTokenValidator against a real server', () => {
  let server: Server;
  let baseUrl: string;
  let mode: 'active' | 'inactive' | 'serverError' | 'unauthorized' | 'malformed' = 'active';
  let calls = 0;
  let lastServiceKey: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      calls += 1;
      lastServiceKey = req.headers['x-service-key'] as string | undefined;
      res.setHeader('Content-Type', 'application/json');

      switch (mode) {
        case 'inactive':
          res.end(JSON.stringify({ active: false }));
          return;
        case 'serverError':
          res.statusCode = 500;
          res.end('{"error":"boom"}');
          return;
        case 'unauthorized':
          res.statusCode = 401;
          res.end('{"error":"unknown service"}');
          return;
        case 'malformed':
          res.end('<html>not json</html>');
          return;
        default:
          res.end(JSON.stringify({ active: true, sub: 'demo', exp: Math.floor(Date.now() / 1000) + 3600 }));
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  afterEach(() => {
    mode = 'active';
    calls = 0;
  });

  /** Builds a validator with caching disabled unless a TTL is given. */
  const validatorWith = (cacheTtlSeconds = 0, timeoutMs = 500) =>
    new HttpTokenValidator({ baseUrl, serviceKey: 'service-key', timeoutMs, cacheTtlSeconds });

  it('reports an active token as active', async () => {
    expect(await validatorWith().validate('token')).toBe('active');
  });

  it('sends the service credential', async () => {
    await validatorWith().validate('token');
    expect(lastServiceKey).toBe('service-key');
  });

  it('reports an inactive token as inactive', async () => {
    mode = 'inactive';
    expect(await validatorWith().validate('token')).toBe('inactive');
  });

  it.each([
    ['a 500 from the authority', 'serverError'],
    ['a 401 from the authority', 'unauthorized'],
    ['a malformed body', 'malformed'],
  ] as const)('reports %s as unavailable', async (_label, failureMode) => {
    mode = failureMode;
    // Never 'active': a broken authority must not produce a pass.
    expect(await validatorWith().validate('token')).toBe('unavailable');
  });

  it('reports an unreachable authority as unavailable', async () => {
    // Port 1 on loopback refuses connections immediately.
    const unreachable = new HttpTokenValidator({
      baseUrl: 'http://127.0.0.1:1',
      serviceKey: 'k',
      timeoutMs: 300,
      cacheTtlSeconds: 0,
    });
    expect(await unreachable.validate('token')).toBe('unavailable');
  });

  it('reports a timeout as unavailable', async () => {
    const slow = createServer(() => {
      // Never responds: only the client's own abort ends the request.
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const port = (slow.address() as AddressInfo).port;

    try {
      const validator = new HttpTokenValidator({
        baseUrl: `http://127.0.0.1:${port}`,
        serviceKey: 'k',
        timeoutMs: 150,
        cacheTtlSeconds: 0,
      });
      expect(await validator.validate('token')).toBe('unavailable');
    } finally {
      await new Promise<void>((resolve) => {
        slow.closeAllConnections?.();
        slow.close(() => resolve());
      });
    }
  });

  it('reports an empty token as inactive without calling the authority', async () => {
    expect(await validatorWith().validate('   ')).toBe('inactive');
    expect(calls).toBe(0);
  });

  it('caches a positive answer', async () => {
    const validator = validatorWith(60);
    await validator.validate('token');
    await validator.validate('token');
    await validator.validate('token');
    expect(calls).toBe(1);
  });

  it('keys the cache per token', async () => {
    const validator = validatorWith(60);
    await validator.validate('a');
    await validator.validate('b');
    await validator.validate('a');
    expect(calls).toBe(2);
  });

  it('never caches a negative answer', async () => {
    mode = 'inactive';
    const validator = validatorWith(60);
    await validator.validate('token');
    await validator.validate('token');
    expect(calls).toBe(2);
  });

  it('does not cache when the TTL is zero', async () => {
    const validator = validatorWith(0);
    await validator.validate('token');
    await validator.validate('token');
    expect(calls).toBe(2);
  });

  it('expires a cache entry once the TTL elapses', async () => {
    const validator = validatorWith(1);
    await validator.validate('token');
    await validator.validate('token');
    expect(calls).toBe(1);
    // The entry lives for a full second; waiting for it to lapse keeps the
    // test honest about the actual TTL rather than a stubbed clock.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await validator.validate('token');
    expect(calls).toBe(2);
  });

  it('does not let an entry outlive the token it describes', async () => {
    // The authority reports a token that expires in half a second, while the
    // cache TTL is an hour.
    const shortLived = createServer((_req, res) => {
      calls += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ active: true, exp: Math.floor(Date.now() / 1000) }));
    });
    await new Promise<void>((resolve) => shortLived.listen(0, '127.0.0.1', resolve));
    const port = (shortLived.address() as AddressInfo).port;

    try {
      const validator = new HttpTokenValidator({
        baseUrl: `http://127.0.0.1:${port}`,
        serviceKey: 'k',
        timeoutMs: 500,
        cacheTtlSeconds: 3600,
      });
      await validator.validate('token');
      // The exp is already in the past when the answer is cached, so nothing is
      // stored and the next call must reach the authority.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await validator.validate('token');
      expect(calls).toBe(2);
    } finally {
      await new Promise<void>((resolve) => {
        shortLived.closeAllConnections?.();
        shortLived.close(() => resolve());
      });
    }
  });
});

describe('use case error contract', () => {
  it('exposes the two authorization failures as distinct classes', () => {
    // The HTTP layer maps these to 401 and 503 respectively; collapsing them
    // would break that mapping.
    expect(new UnauthorizedError()).toBeInstanceOf(Error);
    expect(new AuthUnavailableError()).toBeInstanceOf(Error);
    expect(new UnauthorizedError()).not.toBeInstanceOf(AuthUnavailableError);
  });
});
