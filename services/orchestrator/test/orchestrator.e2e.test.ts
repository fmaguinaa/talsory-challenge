import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { ProblemDetailsFilter } from '../src/common/ProblemDetailsFilter';
import { requestIdMiddleware } from '../src/common/requestContext';
import { PROBLEM_MEDIA_TYPE, type ProblemDetail } from '../src/common/problem';
import { CONFIG_TOKEN, type OrchestratorConfig } from '../src/config/config';

/**
 * The 3x3 example from the challenge, with its exact full QR factorization.
 *
 * These constants are the backbone of the assertions: the whole pipeline is
 * verified against a factorization that is known analytically, so a mistake
 * anywhere shows up as a visibly wrong answer rather than a plausibly wrong one.
 */
const KNOWN_MATRIX = [
  [12, -51, 4],
  [6, 167, -68],
  [-4, 24, -41],
];

const KNOWN_Q = [
  [-6 / 7, 69 / 175, -58 / 175],
  [-3 / 7, 158 / 175, 6 / 175],
  [-2 / 7, -6 / 35, -33 / 35],
];

const KNOWN_R = [
  [-14, -21, 14],
  [0, -175, 70],
  [0, 0, -35],
];

const VALID_TOKEN = 'header.payload.signature';
const SERVICE_KEY = 'e2e-service-key';

/**
 * Optional canned answer for the fake stats service.
 *
 * Used to prove that the orchestrator relays a downstream field verbatim. Left
 * undefined, the fake computes real statistics from the matrices it receives.
 */
let statsOverride: Record<string, unknown> | undefined;

/** One request as a downstream service saw it. */
interface RecordedRequest {
  path: string;
  authorization: string | undefined;
  serviceKey: string | undefined;
  requestId: string | undefined;
  body: unknown;
}

/** A fake downstream service. */
interface Fake {
  server: Server;
  url: string;
  requests: RecordedRequest[];
}

/** Bounds shared by every downstream the tests configure. */
const DOWNSTREAM = { serviceKey: SERVICE_KEY, timeoutMs: 400, retries: 0, retryBackoffMs: 1 };

/**
 * A configuration that satisfies the loader without reading the environment.
 *
 * The tests override the URLs to point at fakes (or at a closed port, to
 * exercise a failure), which is why the whole object is spelled out here rather
 * than derived from `loadConfig`.
 */
function baseConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    nodeEnv: 'test',
    corsOrigins: ['http://localhost:8080'],
    maxMatrixDim: 100,
    maxBodyBytes: 1024 * 1024,
    throttleTtlMs: 60_000,
    throttleLimit: 1_000_000,
    shutdownGraceMs: 1_000,
    logLevel: 'silent',
    authService: { ...DOWNSTREAM, baseUrl: 'http://unused' },
    qrApi: { ...DOWNSTREAM, baseUrl: 'http://unused' },
    statsApi: { ...DOWNSTREAM, baseUrl: 'http://unused' },
    ...overrides,
  };
}

/** Flattens a nested numeric matrix. */
function flatten(matrix: number[][]): number[] {
  return matrix.flat();
}

/**
 * Starts a fake downstream that answers exactly like the real service.
 *
 * The tests run over real HTTP rather than against stubs so the adapters, the
 * axios configuration, the error classification and the exception filter are all
 * exercised for real. A stub at the client boundary would test the workflow
 * again and prove nothing about the wiring.
 */
async function startFake(): Promise<Fake> {
  const requests: RecordedRequest[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }

      requests.push({
        path: req.url ?? '',
        authorization: req.headers.authorization,
        serviceKey: req.headers['x-service-key'] as string | undefined,
        requestId: req.headers['x-request-id'] as string | undefined,
        body,
      });

      res.setHeader('Content-Type', 'application/json');
      const url = req.url ?? '';

      if (url.startsWith('/auth/validate')) {
        res.end(
          JSON.stringify({
            // Only the canonical token is active, so a test can send a wrong one.
            active: req.headers.authorization === `Bearer ${VALID_TOKEN}`,
            sub: 'demo',
            scope: 'api:read',
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 900,
          }),
        );
        return;
      }

      if (url.startsWith('/auth/login')) {
        const credentials = body as { username?: string; password?: string } | undefined;
        if (credentials?.username !== 'demo' || credentials?.password !== 'demo-password') {
          res.statusCode = 401;
          res.end(problem('unauthorized', 'Invalid username or password.', url));
          return;
        }
        res.end(JSON.stringify({ accessToken: VALID_TOKEN, tokenType: 'Bearer', expiresIn: 900 }));
        return;
      }

      if (url.startsWith('/api/v1/qr/factorize')) {
        res.end(JSON.stringify({ q: KNOWN_Q, r: KNOWN_R }));
        return;
      }

      if (url.startsWith('/api/v1/stats')) {
        res.end(JSON.stringify(statsOverride ?? computeStats(body)));
        return;
      }

      res.statusCode = 404;
      res.end('{"error":"not found"}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return { server, url: `http://127.0.0.1:${port}`, requests };
}

/** Builds an RFC 9457 problem document, as the real services would. */
function problem(category: string, detail: string, instance: string): string {
  return JSON.stringify({
    type: `https://interseguro.local/problems/${category}`,
    title: category,
    status: 401,
    detail,
    instance,
    requestId: 'downstream',
  });
}

/**
 * Mirrors what stats-api computes, so the orchestrator's assembled response can
 * be asserted against real statistics rather than fixed numbers.
 */
function computeStats(body: unknown): unknown {
  const payload = body as { matrices?: Array<{ id: string; data: number[][] }> };
  const entries = payload.matrices ?? [];

  const perMatrix = entries.map((entry) => {
    const values = flatten(entry.data);
    const isSquare = entry.data.length > 0 && entry.data.every((row) => row.length === entry.data[0]!.length);
    return {
      id: entry.id,
      max: Math.max(...values),
      min: Math.min(...values),
      average: values.reduce((a, b) => a + b, 0) / values.length,
      sum: values.reduce((a, b) => a + b, 0),
      isDiagonal:
        isSquare &&
        entry.data.every((row, i) => row.every((v, j) => i === j || Math.abs(v) <= 1e-9)),
    };
  });

  const all = entries.flatMap((entry) => flatten(entry.data));
  return {
    global: {
      max: Math.max(...all),
      min: Math.min(...all),
      average: all.reduce((a, b) => a + b, 0) / all.length,
      sum: all.reduce((a, b) => a + b, 0),
      anyDiagonal: perMatrix.some((entry) => entry.isDiagonal),
    },
    perMatrix,
  };
}

/** Closes a fake, dropping sockets it still holds. */
async function stopFake(fake: Fake): Promise<void> {
  fake.server.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    fake.server.close(() => resolve());
  });
}

describe('Orchestrator (e2e)', () => {
  let auth: Fake;
  let qr: Fake;
  let stats: Fake;
  /** Applications created by a test, closed in afterEach. */
  const extraApps: INestApplication[] = [];

  /**
   * Builds a fully wired application against the given configuration.
   *
   * It reproduces the global pipes, filters and correlation middleware that
   * main.ts installs, so the tests exercise the same pipeline as production
   * rather than a reduced one.
   */
  async function buildApp(config: OrchestratorConfig): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CONFIG_TOKEN)
      .useValue(config)
      .compile();

    const app = moduleRef.createNestApplication({ logger: false });

    // The real middleware, not a copy: a hand-rolled duplicate would let the
    // correlation behaviour drift between the tests and production unnoticed.
    app.use(requestIdMiddleware);
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.useGlobalFilters(new ProblemDetailsFilter());

    await app.init();
    return app;
  }

  /** The configuration pointing every service at its fake. */
  function wiredConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
    return baseConfig({
      authService: { ...DOWNSTREAM, baseUrl: auth.url },
      qrApi: { ...DOWNSTREAM, baseUrl: qr.url },
      statsApi: { ...DOWNSTREAM, baseUrl: stats.url },
      ...overrides,
    });
  }

  /** Builds an app for a failure path and schedules it for cleanup. */
  async function extraApp(config: OrchestratorConfig): Promise<INestApplication> {
    const app = await buildApp(config);
    extraApps.push(app);
    return app;
  }

  beforeAll(async () => {
    auth = await startFake();
    qr = await startFake();
    stats = await startFake();
  });

  afterAll(async () => {
    await stopFake(auth);
    await stopFake(qr);
    await stopFake(stats);
  });

  beforeEach(() => {
    statsOverride = undefined;
    auth.requests.length = 0;
    qr.requests.length = 0;
    stats.requests.length = 0;
  });

  afterEach(async () => {
    await Promise.all(extraApps.splice(0).map((app) => app.close()));
  });

  describe('POST /auth/login', () => {
    it('proxies a successful login', async () => {
      const app = await extraApp(wiredConfig());

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'demo', password: 'demo-password' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        accessToken: VALID_TOKEN,
        tokenType: 'Bearer',
        expiresIn: 900,
      });
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('forwards the credentials to auth-service', async () => {
      const app = await extraApp(wiredConfig());

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'demo', password: 'demo-password' });

      const forwarded = auth.requests.find((entry) => entry.path === '/auth/login');
      expect(forwarded?.body).toEqual({ username: 'demo', password: 'demo-password' });
    });

    it('maps bad credentials to 401 with a generic message', async () => {
      const app = await extraApp(wiredConfig());

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'demo', password: 'wrong' });

      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toContain(PROBLEM_MEDIA_TYPE);
      expect((response.body as ProblemDetail).detail).toBe('Invalid username or password.');
    });

    it.each([
      ['a missing username', { password: 'x' }],
      ['an empty username', { username: '', password: 'x' }],
      ['an over-long username', { username: 'x'.repeat(200), password: 'x' }],
      ['a missing password', { username: 'demo' }],
      ['an empty password', { username: 'demo', password: '' }],
      ['a non-string username', { username: 42, password: 'x' }],
    ])('rejects %s with 400 before any network call', async (_label, body) => {
      const app = await extraApp(wiredConfig());
      const before = auth.requests.length;

      const response = await request(app.getHttpServer()).post('/auth/login').send(body);

      expect(response.status).toBe(400);
      expect(response.headers['content-type']).toContain(PROBLEM_MEDIA_TYPE);
      // Validation happens here, so the round trip is never paid.
      expect(auth.requests.length).toBe(before);
    });

    it('maps an unreachable auth-service to 503, not to 401', async () => {
      const app = await extraApp(
        wiredConfig({
          // Port 1 on loopback refuses connections: a genuine outage.
          authService: { ...DOWNSTREAM, baseUrl: 'http://127.0.0.1:1', timeoutMs: 200 },
        }),
      );

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'demo', password: 'demo-password' });

      expect(response.status).toBe(503);
      expect((response.body as ProblemDetail).type).toContain('service-unavailable');
    });
  });

  describe('POST /api/v1/matrix/analyze', () => {
    it('returns the aggregated response', async () => {
      const app = await extraApp(wiredConfig());

      const response = await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ matrix: KNOWN_MATRIX });

      expect(response.status).toBe(200);
      expect(response.body.requestId).toBeTruthy();
      expect(response.body.input).toEqual({ rows: 3, cols: 3 });
      expect(response.body.qr.q).toEqual(KNOWN_Q);
      expect(response.body.qr.r).toEqual(KNOWN_R);
      const stats = response.body.stats as { perMatrix: Array<{ id: string }> };
      expect(stats.perMatrix.map((entry) => entry.id)).toEqual(['Q', 'R']);
    });

    it('returns statistics consistent with the factorization', async () => {
      const app = await extraApp(wiredConfig());

      const response = await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ matrix: KNOWN_MATRIX });

      const allQ = flatten(KNOWN_Q);
      const allR = flatten(KNOWN_R);
      const all = [...allQ, ...allR];

      const stats = response.body.stats as {
        global: { max: number; min: number; average: number; sum: number };
        perMatrix: Array<{ id: string; min: number; max: number }>;
      };

      expect(stats.global.max).toBeCloseTo(Math.max(...all), 10);
      expect(stats.global.min).toBeCloseTo(Math.min(...all), 10);
      expect(stats.global.sum).toBeCloseTo(all.reduce((a, b) => a + b, 0), 10);
      expect(stats.global.average).toBeCloseTo(all.reduce((a, b) => a + b, 0) / all.length, 10);

      expect(stats.perMatrix[0]?.max).toBeCloseTo(Math.max(...allQ), 10);
      expect(stats.perMatrix[1]?.min).toBeCloseTo(Math.min(...allR), 10);
    });

    it('reports R as not diagonal and the global flag accordingly', async () => {
      const app = await extraApp(wiredConfig());

      const response = await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ matrix: KNOWN_MATRIX });

      const stats = response.body.stats as {
        global: { anyDiagonal: boolean };
        perMatrix: Array<{ id: string; isDiagonal: boolean }>;
      };
      expect(stats.perMatrix[0]?.isDiagonal).toBe(false);
      expect(stats.perMatrix[1]?.isDiagonal).toBe(false);
      expect(stats.global.anyDiagonal).toBe(false);
    });

    it('forwards anyDiagonal from the statistics service', async () => {
      // The question here is whether the orchestrator relays the downstream's
      // answer faithfully, so the seam is the stats payload rather than the
      // matrix: the fake factorization is fixed and cannot become diagonal.
      statsOverride = {
        global: { max: 1, min: -175, average: 0, sum: 0, anyDiagonal: true },
        perMatrix: [
          { id: 'Q', max: 1, min: -1, average: 0, sum: 0, isDiagonal: true },
          { id: 'R', max: 70, min: -175, average: 0, sum: 0, isDiagonal: false },
        ],
      };

      const app = await extraApp(wiredConfig());

      const response = await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ matrix: KNOWN_MATRIX });

      const stats = response.body.stats as {
        global: { anyDiagonal: boolean };
        perMatrix: Array<{ id: string; isDiagonal: boolean }>;
      };
      expect(stats.global.anyDiagonal).toBe(true);
      expect(stats.perMatrix[0]?.isDiagonal).toBe(true);
      expect(stats.perMatrix[1]?.isDiagonal).toBe(false);
    });

    it('forwards the caller token to qr-api and stats-api', async () => {
      // Zero trust: each service validates the token itself, so the original
      // must travel rather than a service-scoped credential.
      const app = await extraApp(wiredConfig());

      await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ matrix: KNOWN_MATRIX });

      expect(qr.requests.find((e) => e.path === '/api/v1/qr/factorize')?.authorization).toBe(
        `Bearer ${VALID_TOKEN}`,
      );
      expect(stats.requests.find((e) => e.path === '/api/v1/stats')?.authorization).toBe(
        `Bearer ${VALID_TOKEN}`,
      );
    });

    it('sends Q and R, labelled, to the statistics service', async () => {
      const app = await extraApp(wiredConfig());

      await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ matrix: KNOWN_MATRIX });

      const call = stats.requests.find((e) => e.path === '/api/v1/stats');
      const payload = call?.body as { matrices: Array<{ id: string; data: number[][] }> };
      expect(payload.matrices.map((entry) => entry.id)).toEqual(['Q', 'R']);
      expect(payload.matrices[0]?.data).toEqual(KNOWN_Q);
      expect(payload.matrices[1]?.data).toEqual(KNOWN_R);
    });

    it('sends the service credential when validating the token', async () => {
      const app = await extraApp(wiredConfig());

      await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ matrix: KNOWN_MATRIX });

      expect(auth.requests.find((e) => e.path === '/auth/validate')?.serviceKey).toBe(SERVICE_KEY);
    });

    it('propagates the correlation id to every service', async () => {
      const app = await extraApp(wiredConfig());

      const response = await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .set('X-Request-Id', 'trace-e2e-1')
        .send({ matrix: KNOWN_MATRIX });

      expect(response.headers['x-request-id']).toBe('trace-e2e-1');
      expect(response.body.requestId).toBe('trace-e2e-1');
      expect(auth.requests[0]?.requestId).toBe('trace-e2e-1');
      expect(qr.requests[0]?.requestId).toBe('trace-e2e-1');
      expect(stats.requests[0]?.requestId).toBe('trace-e2e-1');
    });

    it('mints a correlation id when the request has none', async () => {
      const app = await extraApp(wiredConfig());

      const response = await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ matrix: KNOWN_MATRIX });

      expect(response.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('replaces a hostile correlation id', async () => {
      const app = await extraApp(wiredConfig());

      const response = await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        // A newline would let a caller forge log entries.
        .set('X-Request-Id', 'abc def;injected')
        .send({ matrix: KNOWN_MATRIX });

      expect(response.headers['x-request-id']).not.toBe('abc def;injected');
    });

    it.each([
      ['no Authorization header', undefined],
      ['an empty Authorization header', ''],
      ['a non-Bearer scheme', 'Basic dXNlcjpwYXNz'],
      ['a Bearer header with no token', 'Bearer'],
    ])('returns 401 for %s', async (_label, authorization) => {
      const app = await extraApp(wiredConfig());

      const builder = request(app.getHttpServer()).post('/api/v1/matrix/analyze');
      if (authorization !== undefined) builder.set('Authorization', authorization);

      const response = await builder.send({ matrix: KNOWN_MATRIX });

      expect(response.status).toBe(401);
      expect(response.headers['www-authenticate']).toContain('Bearer');
      expect((response.body as ProblemDetail).type).toContain('unauthorized');
    });

    it('returns 401 for a token the authority rejects', async () => {
      const app = await extraApp(wiredConfig());

      const response = await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        // The fake authority only considers the canonical token active.
        .set('Authorization', 'Bearer tampered.jwt.value')
        .send({ matrix: KNOWN_MATRIX });

      expect(response.status).toBe(401);
      expect((response.body as ProblemDetail).detail).toContain('valid bearer token');
    });

    it('returns 503 when the authority cannot validate the token, and says so distinctly', async () => {
      // The distinction is the whole point: a client must not be told to log in
      // again when the real problem is that auth-service is down.
      const app = await extraApp(
        wiredConfig({
          authService: { ...DOWNSTREAM, baseUrl: 'http://127.0.0.1:1', timeoutMs: 200 },
        }),
      );

      const response = await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ matrix: KNOWN_MATRIX });

      expect(response.status).toBe(503);
      expect((response.body as ProblemDetail).type).toContain('service-unavailable');
      expect(response.headers['retry-after']).toBe('5');
      // Nothing downstream should have run.
      expect(qr.requests).toHaveLength(0);
    });

    it.each([
      ['an empty matrix', [], /non-empty array/],
      ['an empty first row', [[]], /at least one number/],
      ['a ragged matrix', [[1, 2, 3], [4, 5]], /row 1 has length 2, expected 3/],
      ['a null cell', [[1, null]], /not a finite number/],
      ['a non-array first row', [1, 2], /row 0 must be an array/],
      ['a string cell', [[1, 'two']], /not a finite number/],
    ])('returns 422 with a precise reason for %s', async (_label, matrix, expected) => {
      const app = await extraApp(wiredConfig());
      const qrBefore = qr.requests.length;

      const response = await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ matrix });

      expect(response.status).toBe(422);
      expect((response.body as ProblemDetail).type).toContain('invalid-matrix');
      expect((response.body as ProblemDetail).detail).toMatch(expected);
      // Local validation is free; a rejected matrix costs no downstream call.
      expect(qr.requests.length).toBe(qrBefore);
    });

    it('refuses a matrix over the configured dimension limit', async () => {
      const app = await extraApp(wiredConfig({ maxMatrixDim: 2 }));

      const response = await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ matrix: [[1], [2], [3]] });

      expect(response.status).toBe(422);
      expect((response.body as ProblemDetail).detail).toContain('the maximum is 2');
    });

    it('returns 502 when qr-api is unreachable', async () => {
      const app = await extraApp(
        wiredConfig({
          qrApi: { ...DOWNSTREAM, baseUrl: 'http://127.0.0.1:1', timeoutMs: 200 },
        }),
      );

      const response = await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ matrix: KNOWN_MATRIX });

      expect(response.status).toBe(502);
      expect((response.body as ProblemDetail).type).toContain('bad-gateway');
      // A QR failure must stop the workflow before the statistics call.
      expect(stats.requests).toHaveLength(0);
    });

    it('returns 502 when stats-api is unreachable', async () => {
      const app = await extraApp(
        wiredConfig({
          statsApi: { ...DOWNSTREAM, baseUrl: 'http://127.0.0.1:1', timeoutMs: 200 },
        }),
      );

      const response = await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ matrix: KNOWN_MATRIX });

      expect(response.status).toBe(502);
    });

    it('returns 504 when a downstream does not answer in time', async () => {
      const slow = createServer(() => {
        // Never responds: only the client's own timeout can end this request.
      });
      await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
      const port = (slow.address() as AddressInfo).port;

      const app = await extraApp(
        wiredConfig({
          qrApi: { ...DOWNSTREAM, baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 150 },
        }),
      );

      try {
        const response = await request(app.getHttpServer())
          .post('/api/v1/matrix/analyze')
          .set('Authorization', `Bearer ${VALID_TOKEN}`)
          .send({ matrix: KNOWN_MATRIX });

        expect(response.status).toBe(504);
        expect((response.body as ProblemDetail).type).toContain('gateway-timeout');
      } finally {
        slow.closeAllConnections?.();
        await new Promise<void>((resolve) => slow.close(() => resolve()));
      }
    });

    it.each([
      ['a missing matrix field', {}],
      ['a non-array matrix field', { matrix: 'not a matrix' }],
      ['a null matrix field', { matrix: null }],
    ])('returns 400 for %s, which is a malformed envelope', async (_label, payload) => {
      const app = await extraApp(wiredConfig());

      const response = await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send(payload);

      // 400 rather than 422: the request did not describe a matrix at all,
      // which is a different mistake from describing one badly.
      expect(response.status).toBe(400);
      expect((response.body as ProblemDetail).type).toContain('malformed-request');
    });

    it('returns 400 for a body that is not JSON', async () => {
      const app = await extraApp(wiredConfig());

      const response = await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .set('Content-Type', 'application/json')
        .send('{"matrix":');

      expect(response.status).toBe(400);
      expect(response.headers['content-type']).toContain(PROBLEM_MEDIA_TYPE);
    });

    it('never leaks an internal address, an error code or a stack trace', async () => {
      const app = await extraApp(
        wiredConfig({
          qrApi: { ...DOWNSTREAM, baseUrl: 'http://127.0.0.1:1', timeoutMs: 200 },
        }),
      );

      const response = await request(app.getHttpServer())
        .post('/api/v1/matrix/analyze')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ matrix: KNOWN_MATRIX });

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('127.0.0.1:1');
      expect(serialized).not.toContain('ECONNREFUSED');
      expect(serialized).not.toContain('at Object.');
      expect(serialized).not.toContain('node_modules');
    });
  });

  describe('health endpoints', () => {
    it.each(['/health/live', '/health/ready'])('serves %s without a token', async (path) => {
      const app = await extraApp(wiredConfig());

      const response = await request(app.getHttpServer()).get(path);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });
  });

  describe('routing', () => {
    it('returns 404 for an unknown path', async () => {
      const app = await extraApp(wiredConfig());
      const response = await request(app.getHttpServer()).get('/nope');
      expect(response.status).toBe(404);
    });
  });
});
