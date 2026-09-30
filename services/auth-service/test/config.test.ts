import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config';

/** A valid argon2id hash; the value is never verified by these tests. */
const VALID_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$I21dT5EBIS8A9v++fVtfNQ$nDvtuKu5rg7UByvhF105L9i+Q+8lIKZ7XTL3nDi5CDE';

/** A minimal but structurally valid PEM pair. */
const FAKE_PRIVATE_PEM = '-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----';
const FAKE_PUBLIC_PEM = '-----BEGIN PUBLIC KEY-----\nQUJD\n-----END PUBLIC KEY-----';

/** Every environment variable the loader reads, so tests can restore them. */
const TOUCHED = [
  'ARGON2_MEMORY_COST_KIB',
  'ARGON2_PARALLELISM',
  'ARGON2_TIME_COST',
  'AUTH_HOST',
  'AUTH_MAX_BODY_BYTES',
  'AUTH_PORT',
  'AUTH_USERS',
  'DEFAULT_SCOPES',
  'DEMO_PASSWORD_HASH',
  'DEMO_USERNAME',
  'JWT_AUDIENCE',
  'JWT_CLOCK_TOLERANCE_SECONDS',
  'JWT_ISSUER',
  'JWT_KID',
  'JWT_PRIVATE_KEY_FILE',
  'JWT_PRIVATE_KEY_PEM',
  'JWT_PUBLIC_KEY_FILE',
  'JWT_PUBLIC_KEY_PEM',
  'JWT_TTL_SECONDS',
  'LOG_LEVEL',
  'LOGIN_RATE_LIMIT_MAX',
  'LOGIN_RATE_LIMIT_WINDOW_MS',
  'SERVICE_API_KEYS',
  'SHUTDOWN_GRACE_SECONDS',
] as const;

describe('loadConfig', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = {};
    for (const key of TOUCHED) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
    // The minimum viable configuration: keys, service credentials, one user.
    process.env.JWT_PRIVATE_KEY_PEM = FAKE_PRIVATE_PEM;
    process.env.JWT_PUBLIC_KEY_PEM = FAKE_PUBLIC_PEM;
    process.env.SERVICE_API_KEYS = 'service-key';
    process.env.DEMO_USERNAME = 'demo';
    process.env.DEMO_PASSWORD_HASH = VALID_HASH;
  });

  afterEach(() => {
    for (const key of TOUCHED) {
      if (snapshot[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = snapshot[key] ?? '';
      }
    }
  });

  it('applies security-sensible defaults', () => {
    const config = loadConfig();

    expect(config.port).toBe(4000);
    expect(config.host).toBe('0.0.0.0');
    // 15 minutes: long enough to be usable, short enough that a leaked token
    // has a small window.
    expect(config.ttlSeconds).toBe(900);
    expect(config.issuer).toBe('https://interseguro.local/auth');
    expect(config.audience).toBe('interseguro-api');
    expect(config.defaultScopes).toEqual(['api:read']);
    expect(config.jwtKid).toBe('dev-key-1');
    expect(config.clockToleranceSeconds).toBe(5);
    // The OWASP baseline for argon2id.
    expect(config.argon2).toEqual({ memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  });

  it('reads every override from the environment', () => {
    process.env.AUTH_PORT = '5555';
    process.env.AUTH_HOST = '127.0.0.1';
    process.env.JWT_ISSUER = 'https://example.test/auth';
    process.env.JWT_AUDIENCE = 'other-audience';
    process.env.JWT_TTL_SECONDS = '3600';
    process.env.JWT_KID = 'key-2024';
    process.env.JWT_CLOCK_TOLERANCE_SECONDS = '30';
    process.env.DEFAULT_SCOPES = 'api:read api:write';
    process.env.SERVICE_API_KEYS = 'key-a, key-b ,key-c';
    process.env.ARGON2_MEMORY_COST_KIB = '65536';
    process.env.ARGON2_TIME_COST = '3';
    process.env.ARGON2_PARALLELISM = '2';

    const config = loadConfig();

    expect(config.port).toBe(5555);
    expect(config.host).toBe('127.0.0.1');
    expect(config.issuer).toBe('https://example.test/auth');
    expect(config.audience).toBe('other-audience');
    expect(config.ttlSeconds).toBe(3600);
    expect(config.jwtKid).toBe('key-2024');
    expect(config.clockToleranceSeconds).toBe(30);
    expect(config.defaultScopes).toEqual(['api:read', 'api:write']);
    // Surrounding whitespace in a comma-separated list is a plausible typo and
    // would otherwise produce a key that can never match.
    expect(config.serviceApiKeys).toEqual(['key-a', 'key-b', 'key-c']);
    expect(config.argon2).toEqual({ memoryCost: 65_536, timeCost: 3, parallelism: 2 });
  });

  describe('key material', () => {
    it('converts escaped newlines from the environment into real ones', () => {
      // A secret manager or a YAML block usually yields the two-character
      // sequence \n rather than a newline; without this conversion the key
      // would fail to import with a message that does not mention the cause.
      process.env.JWT_PRIVATE_KEY_PEM =
        '-----BEGIN PRIVATE KEY-----\\nQUJD\\n-----END PRIVATE KEY-----';
      process.env.JWT_PUBLIC_KEY_PEM =
        '-----BEGIN PUBLIC KEY-----\\nQUJD\\n-----END PUBLIC KEY-----';

      const config = loadConfig();

      expect(config.jwtPrivateKeyPem).toContain('\n');
      expect(config.jwtPrivateKeyPem).not.toContain('\\n');
      expect(config.jwtPublicKeyPem).toContain('\n');
    });

    it('requires both keys', () => {
      delete process.env.JWT_PRIVATE_KEY_PEM;
      expect(() => loadConfig()).toThrow(/JWT_PRIVATE_KEY_PEM/);

      process.env.JWT_PRIVATE_KEY_PEM = FAKE_PRIVATE_PEM;
      delete process.env.JWT_PUBLIC_KEY_PEM;
      expect(() => loadConfig()).toThrow(/JWT_PUBLIC_KEY_PEM/);
    });

    it('rejects a value that is not PEM at all', () => {
      process.env.JWT_PRIVATE_KEY_PEM = 'just some text';
      expect(() => loadConfig()).toThrow(/does not look like a PEM block/);
    });

    it('rejects an empty value', () => {
      process.env.JWT_PRIVATE_KEY_PEM = '   ';
      expect(() => loadConfig()).toThrow(/is empty/);
    });

    it('reads keys from a mounted file when the variable is absent', () => {
      const directory = mkdtempSync(join(tmpdir(), 'auth-keys-'));
      const privatePath = join(directory, 'private.pem');
      const publicPath = join(directory, 'public.pem');
      writeFileSync(privatePath, FAKE_PRIVATE_PEM);
      writeFileSync(publicPath, FAKE_PUBLIC_PEM);

      delete process.env.JWT_PRIVATE_KEY_PEM;
      delete process.env.JWT_PUBLIC_KEY_PEM;
      process.env.JWT_PRIVATE_KEY_FILE = privatePath;
      process.env.JWT_PUBLIC_KEY_FILE = publicPath;

      const loaded = loadConfig();

      expect(loaded.jwtPrivateKeyPem).toBe(FAKE_PRIVATE_PEM);
      expect(loaded.jwtPublicKeyPem).toBe(FAKE_PUBLIC_PEM);
    });

    it('reports the path it could not read', () => {
      delete process.env.JWT_PRIVATE_KEY_PEM;
      process.env.JWT_PRIVATE_KEY_FILE = '/nonexistent/private.pem';

      expect(() => loadConfig()).toThrow(/could not be read/);
    });

    it('prefers the inline variable over the file', () => {
      // An explicit variable must win, so a stale file path cannot silently
      // override a freshly rotated key.
      process.env.JWT_PRIVATE_KEY_PEM = FAKE_PRIVATE_PEM;
      process.env.JWT_PRIVATE_KEY_FILE = '/nonexistent/private.pem';

      expect(loadConfig().jwtPrivateKeyPem).toBe(FAKE_PRIVATE_PEM);
    });
  });

  describe('service credentials', () => {
    it('requires at least one key', () => {
      delete process.env.SERVICE_API_KEYS;
      expect(() => loadConfig()).toThrow(/SERVICE_API_KEYS is required/);
    });

    it('rejects a list of only separators and spaces', () => {
      // Otherwise the check would be silently disabled and anyone could
      // introspect tokens.
      process.env.SERVICE_API_KEYS = ' , , ';
      expect(() => loadConfig()).toThrow(/SERVICE_API_KEYS is required/);
    });
  });

  describe('users', () => {
    it('accepts the single-user DEMO_USERNAME form', () => {
      const config = loadConfig();
      expect(config.users).toEqual([{ username: 'demo', passwordHash: VALID_HASH, scopes: [] }]);
    });

    it('accepts the AUTH_USERS array form', () => {
      delete process.env.DEMO_USERNAME;
      delete process.env.DEMO_PASSWORD_HASH;
      process.env.AUTH_USERS = JSON.stringify([
        { username: 'alice', passwordHash: VALID_HASH, scopes: ['qr:read'] },
        { username: 'bob', passwordHash: VALID_HASH },
      ]);

      const config = loadConfig();

      expect(config.users).toHaveLength(2);
      expect(config.users[0]).toEqual({ username: 'alice', passwordHash: VALID_HASH, scopes: ['qr:read'] });
      expect(config.users[1]?.scopes).toEqual([]);
    });

    it('prefers AUTH_USERS over the demo pair', () => {
      process.env.AUTH_USERS = JSON.stringify([{ username: 'alice', passwordHash: VALID_HASH }]);
      expect(loadConfig().users[0]?.username).toBe('alice');
    });

    it.each([
      [
        'no users at all',
        { DEMO_USERNAME: undefined, DEMO_PASSWORD_HASH: undefined, AUTH_USERS: undefined },
        /no users configured/,
      ],
      ['only a username', { DEMO_PASSWORD_HASH: undefined }, /no users configured/],
      ['only a hash', { DEMO_USERNAME: undefined }, /no users configured/],
      ['a malformed AUTH_USERS', { AUTH_USERS: '{not json' }, /must be valid JSON/],
      ['an empty AUTH_USERS array', { AUTH_USERS: '[]' }, /non-empty JSON array/],
      [
        'a user without a username',
        { AUTH_USERS: JSON.stringify([{ passwordHash: VALID_HASH }]) },
        /username must be a non-empty string/,
      ],
      [
        'a user without a hash',
        { AUTH_USERS: JSON.stringify([{ username: 'alice' }]) },
        /passwordHash must be a non-empty string/,
      ],
      [
        'a plaintext password instead of a hash',
        { AUTH_USERS: JSON.stringify([{ username: 'alice', passwordHash: 'hunter2' }]) },
        /must be an argon2id hash/,
      ],
      [
        'a bcrypt hash',
        {
          AUTH_USERS: JSON.stringify([
            { username: 'alice', passwordHash: '$2b$10$abcdefghijklmnopqrstuv' },
          ]),
        },
        /must be an argon2id hash/,
      ],
      [
        'non-string scopes',
        { AUTH_USERS: JSON.stringify([{ username: 'a', passwordHash: VALID_HASH, scopes: [1] }]) },
        /scopes must be an array of strings/,
      ],
      [
        'a non-object entry',
        { AUTH_USERS: JSON.stringify(['alice']) },
        /must be an object/,
      ],
    ])('rejects %s', (_label, env, expected) => {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      expect(() => loadConfig()).toThrow(expected);
    });
  });

  describe('numeric bounds', () => {
    it.each([
      ['a non-integer port', { AUTH_PORT: 'x' }, /AUTH_PORT must be an integer/],
      ['a port below range', { AUTH_PORT: '0' }, /AUTH_PORT must be between/],
      ['a port above range', { AUTH_PORT: '70000' }, /AUTH_PORT must be between/],
      [
        'a token lifetime below the floor',
        { JWT_TTL_SECONDS: '5' },
        /JWT_TTL_SECONDS must be between/,
      ],
      [
        'a token lifetime above the ceiling',
        { JWT_TTL_SECONDS: '999999' },
        /JWT_TTL_SECONDS must be between/,
      ],
      ['an unknown log level', { LOG_LEVEL: 'chatty' }, /LOG_LEVEL must be one of/],
      [
        'argon2 memory below the floor',
        { ARGON2_MEMORY_COST_KIB: '1' },
        /ARGON2_MEMORY_COST_KIB must be between/,
      ],
      ['an argon2 time cost of 1', { ARGON2_TIME_COST: '1' }, /ARGON2_TIME_COST must be between/],
      ['a rate limit of zero', { LOGIN_RATE_LIMIT_MAX: '0' }, /LOGIN_RATE_LIMIT_MAX/],
      ['an unusable body limit', { AUTH_MAX_BODY_BYTES: '10' }, /AUTH_MAX_BODY_BYTES/],
    ])('rejects %s', (_label, env, expected) => {
      Object.assign(process.env, env);
      expect(() => loadConfig()).toThrow(expected);
    });

    it('rejects a clock tolerance above the ceiling', () => {
      process.env.JWT_CLOCK_TOLERANCE_SECONDS = '1000';
      expect(() => loadConfig()).toThrow(/JWT_CLOCK_TOLERANCE_SECONDS/);
    });

    it('accepts a clock tolerance of exactly zero', () => {
      // Zero means strict comparison, which is a legitimate strict deployment.
      process.env.JWT_CLOCK_TOLERANCE_SECONDS = '0';
      expect(loadConfig().clockToleranceSeconds).toBe(0);
    });
  });
});
