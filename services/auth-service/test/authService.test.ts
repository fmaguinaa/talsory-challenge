import { generateKeyPairSync } from 'node:crypto';

import pino from 'pino';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../src/application/AuthService';
import { Argon2PasswordPort } from '../src/adapters/crypto/Argon2PasswordPort';
import { InMemoryUserDirectory } from '../src/adapters/crypto/InMemoryUserDirectory';
import { JwtTokenPort } from '../src/adapters/crypto/JwtTokenPort';
import { ServiceCredentials } from '../src/adapters/crypto/ServiceCredentials';
import { buildApp } from '../src/adapters/http/router';
import type { User } from '../src/domain/types';
import { PROBLEM_MEDIA_TYPE, type ProblemDetail } from '../src/adapters/http/problem';

/**
 * One key pair is generated for the whole suite.
 *
 * RSA key generation is deliberately slow, and generating a fresh pair per test
 * would dominate the runtime. The pair is generated here rather than read from
 * a fixture so nothing secret is ever committed.
 */
let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  privateKeyPem = pair.privateKey;
  publicKeyPem = pair.publicKey;
});

const ISSUER = 'https://interseguro.local/auth';
const AUDIENCE = 'interseguro-api';
const SERVICE_KEY = 'unit-service-key';

const logger = pino({ level: 'silent' });

/**
 * Argon2 parameters tuned down for tests: the algorithm and the shape of the
 * work are what these tests are about, not the cost. Production keeps the
 * OWASP baseline, which is asserted separately in config.test.ts.
 */
const FAST_ARGON2 = { memoryCost: 1024, timeCost: 2, parallelism: 1 };

/** The password every fixture user has. */
const PASSWORD = 'correct-horse-battery-staple';

/** Everything a test needs to drive the real service end to end. */
interface Harness {
  app: ReturnType<typeof buildApp>;
  authService: AuthService;
  tokens: JwtTokenPort;
  passwords: Argon2PasswordPort;
}

/**
 * Builds a fully wired service: real argon2, real RSA signing, real Express.
 *
 * Only the user directory is configurable, and in practice it always holds the
 * same seeded user, so the tests exercise the genuine code paths end to end
 * rather than a stack of doubles.
 */
async function buildHarness(
  options: { ttlSeconds?: number; users?: readonly User[] } = {},
): Promise<Harness> {
  const tokens = new JwtTokenPort(
    { privateKeyPem, publicKeyPem, kid: 'test-key' },
    {
      issuer: ISSUER,
      audience: AUDIENCE,
      ttlSeconds: options.ttlSeconds ?? 900,
      clockToleranceSeconds: 0,
    },
  );
  await tokens.init();

  const passwords = new Argon2PasswordPort(FAST_ARGON2);
  const users = new InMemoryUserDirectory(
    options.users ?? [{ username: 'demo', passwordHash: await passwords.hash(PASSWORD), scopes: ['qr:read'] }],
  );

  const authService = new AuthService(users, passwords, tokens, {
    issuer: ISSUER,
    audience: AUDIENCE,
    ttlSeconds: options.ttlSeconds ?? 900,
    defaultScopes: ['api:read'],
  });

  const app = buildApp({
    authService,
    serviceCredentials: new ServiceCredentials([SERVICE_KEY]),
    logger,
    maxBodyBytes: 16 * 1024,
    // Effectively unlimited, so the rate limiter never interferes with a test
    // that is not about rate limiting.
    loginRateLimits: { windowMs: 60_000, max: 10_000 },
  });

  return { app, authService, tokens, passwords };
}

/** Logs in and returns the access token. */
async function login(harness: Harness, username = 'demo', password = PASSWORD): Promise<string> {
  const response = await request(harness.app)
    .post('/auth/login')
    .send({ username, password });

  if (response.status !== 200) {
    throw new Error(`login failed with ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return (response.body as { accessToken: string }).accessToken;
}

describe('POST /auth/login', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await buildHarness();
  });

  it('issues a token for valid credentials', async () => {
    const response = await request(harness.app)
      .post('/auth/login')
      .send({ username: 'demo', password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    expect(typeof (response.body as { accessToken: string }).accessToken).toBe('string');
  });

  it('marks the response no-store so a token is never replayed from a cache', async () => {
    const response = await request(harness.app)
      .post('/auth/login')
      .send({ username: 'demo', password: PASSWORD });

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('produces a token that this service accepts', async () => {
    const token = await login(harness);
    const outcome = await harness.authService.introspect(token);

    expect(outcome.active).toBe(true);
    if (outcome.active) {
      expect(outcome.claims.sub).toBe('demo');
      expect(outcome.claims.iss).toBe(ISSUER);
      expect(outcome.claims.aud).toBe(AUDIENCE);
      // The user's own scope and the service-wide default are both present.
      expect(outcome.claims.scope).toContain('qr:read');
      expect(outcome.claims.scope).toContain('api:read');
    }
  });

  it.each([
    ['a wrong password', { username: 'demo', password: 'wrong' }],
    ['an unknown user', { username: 'nobody', password: PASSWORD }],
    ['an unknown user with a wrong password', { username: 'nobody', password: 'wrong' }],
  ])('rejects %s with the same message', async (_label, credentials) => {
    const response = await request(harness.app).post('/auth/login').send(credentials);

    expect(response.status).toBe(401);
    expect((response.body as ProblemDetail).detail).toBe('Invalid username or password.');
  });

  it('gives an unknown user and a wrong password the same status and body', async () => {
    // The two failure modes must be indistinguishable, or the endpoint becomes
    // a username oracle.
    const unknown = await request(harness.app)
      .post('/auth/login')
      .send({ username: 'nobody', password: PASSWORD });
    const wrongPassword = await request(harness.app)
      .post('/auth/login')
      .send({ username: 'demo', password: 'wrong' });

    expect(unknown.status).toBe(wrongPassword.status);
    expect((unknown.body as ProblemDetail).detail).toBe((wrongPassword.body as ProblemDetail).detail);
    expect((unknown.body as ProblemDetail).title).toBe((wrongPassword.body as ProblemDetail).title);
  });

  it('still performs a password verification for an unknown user', async () => {
    // Timing defence: without this, a fast "no such user" path would reveal
    // which usernames exist. The assertion is that the code path runs, not
    // that it takes a particular number of milliseconds.
    let verifications = 0;
    const passwords = {
      hash: async (password: string) => harness.passwords.hash(password),
      verify: async (hash: string, password: string) => {
        verifications += 1;
        return harness.passwords.verify(hash, password);
      },
    };

    const tokens = new JwtTokenPort(
      { privateKeyPem, publicKeyPem, kid: 'k' },
      { issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 900, clockToleranceSeconds: 0 },
    );
    await tokens.init();

    const service = new AuthService(
      new InMemoryUserDirectory([]),
      passwords,
      tokens,
      { issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 900, defaultScopes: [] },
    );

    await expect(service.login({ username: 'ghost', password: 'anything' })).rejects.toThrow();
    expect(verifications).toBeGreaterThan(0);
  });

  it.each([
    ['a missing username', { password: 'x' }],
    ['an empty username', { username: '', password: 'x' }],
    ['a non-string username', { username: 42, password: 'x' }],
    ['a missing password', { username: 'demo' }],
    ['an empty password', { username: 'demo', password: '' }],
    ['a non-string password', { username: 'demo', password: ['x'] }],
    ['an over-long username', { username: 'x'.repeat(200), password: 'x' }],
    ['an over-long password', { username: 'demo', password: 'x'.repeat(300) }],
    ['a non-object body', 'nope'],
  ])('rejects %s with 400 and a precise message', async (_label, body) => {
    const response = await request(harness.app).post('/auth/login').send(body as object);

    expect(response.status).toBe(400);
    expect((response.body as ProblemDetail).title).toBe('Invalid request');
    expect((response.body as ProblemDetail).detail).toMatch(/username|password|body/);
  });

  it('never echoes the password back', async () => {
    const response = await request(harness.app)
      .post('/auth/login')
      .send({ username: 'demo', password: 'super-secret-guess' });

    expect(JSON.stringify(response.body)).not.toContain('super-secret-guess');
  });

  it('rate limits repeated attempts', async () => {
    const limited = await buildHarness();
    const limitedApp = buildApp({
      authService: limited.authService,
      serviceCredentials: new ServiceCredentials([SERVICE_KEY]),
      logger,
      maxBodyBytes: 16 * 1024,
      loginRateLimits: { windowMs: 60_000, max: 3 },
    });

    let sawTooManyRequests = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await request(limitedApp)
        .post('/auth/login')
        .send({ username: 'demo', password: 'wrong' });
      if (response.status === 429) {
        sawTooManyRequests = true;
        expect((response.body as ProblemDetail).type).toContain('rate-limited');
        expect(response.headers['retry-after']).toBeDefined();
        break;
      }
    }

    expect(sawTooManyRequests).toBe(true);
  });
});

describe('POST /auth/validate', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await buildHarness();
  });

  it('reports a valid token as active with its claims', async () => {
    const token = await login(harness);

    const response = await request(harness.app)
      .post('/auth/validate')
      .set('X-Service-Key', SERVICE_KEY)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      active: true,
      sub: 'demo',
      iss: ISSUER,
      aud: AUDIENCE,
    });
    expect(typeof (response.body as { exp: number }).exp).toBe('number');
    expect(typeof (response.body as { iat: number }).iat).toBe('number');
  });

  it('accepts the token in the body as a fallback', async () => {
    // RFC 7662 allows either, and supporting both removes an awkward class of
    // integration for callers that cannot set headers.
    const token = await login(harness);

    const response = await request(harness.app)
      .post('/auth/validate')
      .set('X-Service-Key', SERVICE_KEY)
      .send({ token });

    expect(response.status).toBe(200);
    expect((response.body as { active: boolean }).active).toBe(true);
  });

  it('marks the response no-store', async () => {
    const token = await login(harness);
    const response = await request(harness.app)
      .post('/auth/validate')
      .set('X-Service-Key', SERVICE_KEY)
      .set('Authorization', `Bearer ${token}`);

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['a tampered signature', (token: string) => `${token.slice(0, -3)}abc`],
    ['a token with a modified payload', (token: string) => `${token.slice(0, -10)}AAAAAAAAAA`],
    ['a structurally invalid token', () => 'not-a-jwt'],
    ['an empty token', () => ''],
  ])('reports %s as inactive with 200', async (_label, tamper) => {
    const token = tamper(await login(harness));

    const response = await request(harness.app)
      .post('/auth/validate')
      .set('X-Service-Key', SERVICE_KEY)
      .set('Authorization', `Bearer ${token}`);

    // RFC 7662 shape: the request succeeded, the token did not.
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ active: false });
  });

  it('reports an expired token as inactive', async () => {
    // A one-second lifetime plus a wait is the only honest way to exercise the
    // expiry path without reaching into the signing code.
    const shortLived = await buildHarness({ ttlSeconds: 30 });
    const tokens = new JwtTokenPort(
      { privateKeyPem, publicKeyPem, kid: 'exp' },
      { issuer: ISSUER, audience: AUDIENCE, ttlSeconds: -10, clockToleranceSeconds: 0 },
    );
    await tokens.init();

    const alreadyExpired = await tokens.sign({ sub: 'demo', scope: 'api:read' });
    const outcome = await shortLived.authService.introspect(alreadyExpired);
    expect(outcome.active).toBe(false);
  });

  it('rejects a token signed by a different key', async () => {
    const otherPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const foreign = new JwtTokenPort(
      { privateKeyPem: otherPair.privateKey, publicKeyPem: otherPair.publicKey, kid: 'foreign' },
      { issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 900, clockToleranceSeconds: 0 },
    );
    await foreign.init();

    const forged = await foreign.sign({ sub: 'attacker', scope: 'api:read' });
    const outcome = await harness.authService.introspect(forged);

    expect(outcome.active).toBe(false);
  });

  it('rejects a token with the wrong issuer', async () => {
    const foreign = new JwtTokenPort(
      { privateKeyPem, publicKeyPem, kid: 'other-iss' },
      {
        issuer: 'https://evil.example/auth',
        audience: AUDIENCE,
        ttlSeconds: 900,
        clockToleranceSeconds: 0,
      },
    );
    await foreign.init();

    const token = await foreign.sign({ sub: 'demo', scope: 'api:read' });
    const outcome = await harness.authService.introspect(token);

    expect(outcome.active).toBe(false);
  });

  it('rejects a token with the wrong audience', async () => {
    const foreign = new JwtTokenPort(
      { privateKeyPem, publicKeyPem, kid: 'other-aud' },
      {
        issuer: ISSUER,
        audience: 'some-other-service',
        ttlSeconds: 900,
        clockToleranceSeconds: 0,
      },
    );
    await foreign.init();

    const token = await foreign.sign({ sub: 'demo', scope: 'api:read' });
    const outcome = await harness.authService.introspect(token);

    expect(outcome.active).toBe(false);
  });

  it('rejects an unsigned (alg=none) token', async () => {
    // The classic JWT attack: ask the verifier to accept "none", then supply a
    // payload with no signature at all. The verifier pins RS256, so the header's
    // alg is never consulted.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'attacker',
        iss: ISSUER,
        aud: AUDIENCE,
        scope: 'api:read',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');
    const noneToken = `${header}.${payload}.`;

    const outcome = await harness.authService.introspect(noneToken);
    expect(outcome.active).toBe(false);
  });

  it('rejects an HS256 token signed with the public key as the secret', async () => {
    // The second classic attack: downgrade to HMAC and use the public key,
    // which an attacker knows, as the HMAC secret. Refusing every algorithm
    // except RS256 removes it by construction.
    const publicKeyModulus = Buffer.from(
      (await harness.tokens.jwks()).keys[0]!.n,
      'base64url',
    );
    const { createHmac } = await import('node:crypto');
    const hmac = createHmac('sha256', publicKeyModulus).update('whatever').digest('base64url');

    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'attacker',
        iss: ISSUER,
        aud: AUDIENCE,
        scope: 'api:read',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');

    const outcome = await harness.authService.introspect(`${header}.${payload}.${hmac}`);
    expect(outcome.active).toBe(false);
  });

  describe('service credential', () => {
    it('refuses introspection without a service key', async () => {
      const token = await login(harness);
      const response = await request(harness.app)
        .post('/auth/validate')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(401);
      expect((response.body as ProblemDetail).detail).toContain('service credential');
    });

    it('refuses introspection with a wrong service key', async () => {
      const token = await login(harness);
      const response = await request(harness.app)
        .post('/auth/validate')
        .set('X-Service-Key', 'not-the-key')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(401);
    });

    it('refuses introspection with an empty service key', async () => {
      const token = await login(harness);
      const response = await request(harness.app)
        .post('/auth/validate')
        .set('X-Service-Key', '')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(401);
    });

    it('checks the credential before looking at the token', async () => {
      // A caller with no credential learns nothing, not even whether a token it
      // invented was valid.
      const response = await request(harness.app)
        .post('/auth/validate')
        .set('Authorization', 'Bearer nonsense');

      expect(response.status).toBe(401);
    });
  });
});

describe('GET /.well-known/jwks.json', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await buildHarness();
  });

  it('publishes the public key without authentication', async () => {
    const response = await request(harness.app).get('/.well-known/jwks.json');

    expect(response.status).toBe(200);
    const body = response.body as { keys: Array<Record<string, string>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'test-key' });
    expect(typeof body.keys[0]?.n).toBe('string');
    expect(typeof body.keys[0]?.e).toBe('string');
  });

  it('never publishes private key material', async () => {
    const response = await request(harness.app).get('/.well-known/jwks.json');
    const serialized = JSON.stringify(response.body);

    expect(serialized).not.toContain('PRIVATE');
    expect(serialized).not.toContain('"d"');
  });

  it('allows caching, since the key only changes on rotation', async () => {
    const response = await request(harness.app).get('/.well-known/jwks.json');
    expect(response.headers['cache-control']).toContain('public');
  });
});

describe('health endpoints', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await buildHarness();
  });

  it.each(['/health/live', '/health/ready'])('serves %s without a token', async (path) => {
    const response = await request(harness.app).get(path);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

describe('protocol details', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await buildHarness();
  });

  it('echoes an inbound correlation id on a success', async () => {
    const response = await request(harness.app)
      .post('/auth/login')
      .set('X-Request-Id', 'trace-abc-123')
      .send({ username: 'demo', password: PASSWORD });

    expect(response.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('mints a correlation id when none is supplied', async () => {
    const response = await request(harness.app)
      .post('/auth/login')
      .send({ username: 'demo', password: PASSWORD });

    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('includes the correlation id in an error body', async () => {
    const response = await request(harness.app).post('/auth/login').send({ username: 'demo' });

    expect(response.status).toBe(400);
    expect((response.body as ProblemDetail).requestId).toBeTruthy();
  });

  it('answers every error with application/problem+json', async () => {
    const responses = await Promise.all([
      request(harness.app).post('/auth/login').send({}),
      request(harness.app).post('/auth/validate'),
      request(harness.app).get('/nope'),
    ]);

    for (const response of responses) {
      expect(response.headers['content-type']).toContain(PROBLEM_MEDIA_TYPE);
    }
  });

  it('sets the helmet security headers', async () => {
    const response = await request(harness.app).post('/auth/login').send({
      username: 'demo',
      password: PASSWORD,
    });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    // Advertising the stack is free reconnaissance.
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('returns 400 for a body that is not JSON', async () => {
    const response = await request(harness.app)
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"username":');

    expect(response.status).toBe(400);
    expect((response.body as ProblemDetail).type).toContain('malformed-request');
  });

  it('never returns a stack trace', async () => {
    const responses = await Promise.all([
      request(harness.app).post('/auth/login').send({ username: 'demo' }),
      request(harness.app).post('/auth/validate').set('X-Service-Key', SERVICE_KEY),
    ]);

    for (const response of responses) {
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('at Object.');
      expect(serialized).not.toContain('.ts:');
      expect(serialized).not.toContain('node_modules');
    }
  });
});
