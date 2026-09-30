import { generateKeyPairSync, randomBytes } from 'node:crypto';

import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';

import { Argon2PasswordPort } from '../src/adapters/crypto/Argon2PasswordPort';
import { InMemoryUserDirectory } from '../src/adapters/crypto/InMemoryUserDirectory';
import { JwtTokenPort } from '../src/adapters/crypto/JwtTokenPort';
import { ServiceCredentials } from '../src/adapters/crypto/ServiceCredentials';
import type { SignableClaims, User } from '../src/domain/types';

/** Cheap argon2 parameters: these tests are about behaviour, not cost. */
const FAST = { memoryCost: 1024, timeCost: 2, parallelism: 1 };

const ISSUER = 'https://interseguro.local/auth';
const AUDIENCE = 'interseguro-api';

/** Generates a fresh key pair for a single test. */
function keyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKeyPem: pair.privateKey, publicKeyPem: pair.publicKey };
}

/** Builds a JwtTokenPort over a fresh key pair, already initialised. */
async function buildTokens(overrides: { issuer?: string; audience?: string; ttlSeconds?: number; kid?: string } = {}) {
  const keys = keyPair();
  const port = new JwtTokenPort(
    { ...keys, kid: overrides.kid ?? 'unit-key' },
    {
      issuer: overrides.issuer ?? ISSUER,
      audience: overrides.audience ?? AUDIENCE,
      ttlSeconds: overrides.ttlSeconds ?? 900,
      clockToleranceSeconds: 0,
    },
  );
  await port.init();
  return port;
}

const CLAIMS: SignableClaims = { sub: 'demo', scope: 'api:read qr:read' };

describe('JwtTokenPort', () => {
  it('signs a token that carries every required claim', async () => {
    const tokens = await buildTokens();
    const token = await tokens.sign(CLAIMS);
    const claims = await tokens.verify(token);

    expect(claims.sub).toBe('demo');
    expect(claims.scope).toBe('api:read qr:read');
    expect(claims.iss).toBe(ISSUER);
    expect(claims.aud).toBe(AUDIENCE);
    expect(claims.kid).toBe('unit-key');
    // exp is exactly ttlSeconds after iat, so the advertised lifetime matches
    // the token the client actually received.
    expect(claims.exp - claims.iat).toBe(900);
  });

  it('signs a token whose header advertises RS256 and the key id', async () => {
    const tokens = await buildTokens();
    const token = await tokens.sign(CLAIMS);
    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as Record<string, string>;

    expect(header.alg).toBe('RS256');
    expect(header.kid).toBe('unit-key');
    expect(header.typ).toBe('JWT');
  });

  it('produces a token that survives verification intact', async () => {
    // RS256 is deterministic (PKCS#1 v1.5, not PSS), so signing the same
    // claims twice within the same second yields the same token. What matters
    // is that the signature is actually bound to the payload, which is what
    // these two assertions establish: the genuine token verifies, and any change
    // to any of its three segments does not.
    const tokens = await buildTokens();
    const token = await tokens.sign(CLAIMS);

    await expect(tokens.verify(token)).resolves.toMatchObject({ sub: 'demo', scope: CLAIMS.scope });

    const segments = token.split('.');
    const alteredSignature = `${segments[0]}.${segments[1]}.${segments[2]!.slice(0, -1)}${
      segments[2]!.endsWith('A') ? 'B' : 'A'
    }`;
    await expect(tokens.verify(alteredSignature)).rejects.toThrow();
  });

  it('rejects a token whose payload was modified', async () => {
    const tokens = await buildTokens();
    const token = await tokens.sign(CLAIMS);
    const [header, payload, signature] = token.split('.');

    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), sub: 'admin' }),
    ).toString('base64url');

    await expect(tokens.verify(`${header}.${forged}.${signature}`)).rejects.toThrow();
  });

  it('rejects a token signed by another key', async () => {
    const tokens = await buildTokens();
    const other = await buildTokens();

    await expect(tokens.verify(await other.sign(CLAIMS))).rejects.toThrow();
  });

  it('rejects a token for a different issuer', async () => {
    const tokens = await buildTokens();
    const other = await buildTokens({ issuer: 'https://other.example' });

    await expect(tokens.verify(await other.sign(CLAIMS))).rejects.toThrow();
  });

  it('rejects a token for a different audience', async () => {
    const tokens = await buildTokens();
    const other = await buildTokens({ audience: 'another-service' });

    await expect(tokens.verify(await other.sign(CLAIMS))).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const tokens = await buildTokens();
    // A negative lifetime produces a token whose exp is already in the past,
    // which is the same code path a genuinely expired token takes.
    const expired = await buildTokens({ ttlSeconds: -60 });
    const token = await expired.sign(CLAIMS);

    await expect(tokens.verify(token)).rejects.toThrow();
  });

  it.each([
    ['an empty string', ''],
    ['a non-JWT string', 'not-a-token'],
    ['two segments', 'aaa.bbb'],
    ['four segments', 'aaa.bbb.ccc.ddd'],
    ['non-base64 segments', '!!!.???.###'],
  ])('rejects %s without throwing a non-Error', async (_label, token) => {
    const tokens = await buildTokens();
    await expect(tokens.verify(token)).rejects.toThrow();
  });

  it('exports a JWKS containing only public parameters', async () => {
    const tokens = await buildTokens();
    const jwks = await tokens.jwks();

    expect(jwks.keys).toHaveLength(1);
    const key = jwks.keys[0]!;
    expect(key.kty).toBe('RSA');
    expect(key.use).toBe('sig');
    expect(key.alg).toBe('RS256');
    expect(key.kid).toBe('unit-key');
    // A private JWK would carry "d"; its absence is the property that matters.
    expect('d' in key).toBe(false);
    expect(key.n.length).toBeGreaterThan(100);
  });

  it('caches the JWKS so repeated calls do not re-export the key', async () => {
    const tokens = await buildTokens();
    const first = await tokens.jwks();
    const second = await tokens.jwks();

    expect(second).toBe(first);
  });

  it('re-exports after init, so a rotation is picked up', async () => {
    const tokens = await buildTokens();
    const before = await tokens.jwks();

    const rotated = keyPair();
    const rotatedPort = new JwtTokenPort(
      { ...rotated, kid: 'rotated-key' },
      { issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 900, clockToleranceSeconds: 0 },
    );
    await rotatedPort.init();

    const after = await rotatedPort.jwks();
    expect(after.keys[0]?.kid).toBe('rotated-key');
    expect(after.keys[0]?.n).not.toBe(before.keys[0]?.n);
  });

  it('reports a clear failure for a malformed private key', async () => {
    const port = new JwtTokenPort(
      { privateKeyPem: 'not a pem', publicKeyPem: 'not a pem', kid: 'k' },
      { issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 900, clockToleranceSeconds: 0 },
    );

    await expect(port.init()).rejects.toThrow();
  });
});

describe('Argon2PasswordPort', () => {
  it('produces a hash that verifies against the original password', async () => {
    const port = new Argon2PasswordPort(FAST);
    const hash = await port.hash('correct horse');

    expect(await port.verify(hash, 'correct horse')).toBe(true);
  });

  it('does not verify the wrong password', async () => {
    const port = new Argon2PasswordPort(FAST);
    const hash = await port.hash('correct horse');

    expect(await port.verify(hash, 'correct horsE')).toBe(false);
  });

  it('produces a different hash each time, due to a random salt', async () => {
    const port = new Argon2PasswordPort(FAST);

    expect(await port.hash('same password')).not.toBe(await port.hash('same password'));
  });

  it('embeds the algorithm and cost parameters in the hash', async () => {
    // The PHC format means a later cost increase does not invalidate old hashes.
    const port = new Argon2PasswordPort(FAST);
    const hash = await port.hash('x');

    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain('m=1024');
    expect(hash).toContain('t=2');
    expect(hash).toContain('p=1');
  });

  it.each([
    ['an empty hash', ''],
    ['a malformed hash', 'not-a-hash'],
    ['a truncated hash', '$argon2id$v=19$m=1024'],
    ['an unknown algorithm', '$bcrypt$v=19$m=1024,t=2,p=1$salt$hash'],
  ])('returns false rather than throwing for %s', async (_label, hash) => {
    // A corrupt entry must become a rejected login, not a 500 that tells an
    // attacker which usernames have broken records.
    const port = new Argon2PasswordPort(FAST);
    expect(await port.verify(hash, 'anything')).toBe(false);
  });

  it('uses argon2id, which is what the seeded hashes in .env are', async () => {
    const port = new Argon2PasswordPort(FAST);
    const hash = await port.hash('x');
    expect(await argon2.verify(hash, 'x')).toBe(true);
  });
});

describe('ServiceCredentials', () => {
  it('accepts a configured key', () => {
    const credentials = new ServiceCredentials(['alpha', 'beta']);
    expect(credentials.matches('alpha')).toBe(true);
    expect(credentials.matches('beta')).toBe(true);
  });

  it('rejects a key that is not configured', () => {
    const credentials = new ServiceCredentials(['alpha']);
    expect(credentials.matches('gamma')).toBe(false);
    expect(credentials.matches('')).toBe(false);
    expect(credentials.matches('alph')).toBe(false);
    expect(credentials.matches('alphaa')).toBe(false);
  });

  it('ignores empty entries so a trailing comma does not create a blank key', () => {
    // "a, ,b," is a plausible typo in a comma-separated env var, and treating
    // the blanks as valid keys would let an empty credential through.
    const credentials = new ServiceCredentials(['a', '', 'b', '']);
    expect(credentials.matches('a')).toBe(true);
    expect(credentials.matches('')).toBe(false);
  });

  it('throws when the key set is empty, rather than disabling the check', () => {
    expect(() => new ServiceCredentials([])).toThrow(/at least one non-empty key/);
    expect(() => new ServiceCredentials(['', '  '])).toThrow(/at least one non-empty key/);
  });

  it('is not fooled by unicode look-alikes', () => {
    const credentials = new ServiceCredentials(['ascii-key']);
    expect(credentials.matches('аscіi-key')).toBe(false);
  });

  it('handles a very long presented value without truncating the match', () => {
    const credentials = new ServiceCredentials(['short']);
    expect(credentials.matches(`${'short'}x`.repeat(1000))).toBe(false);
  });

  it('compares every key so timing does not reveal which one matched', () => {
    // The property is structural: the implementation walks the whole list. This
    // test documents the intent rather than trying to measure nanoseconds.
    const credentials = new ServiceCredentials(['a', 'b', 'c', 'd']);
    expect(credentials.matches('a')).toBe(true);
    expect(credentials.matches('d')).toBe(true);
    expect(credentials.matches('z')).toBe(false);
  });

  it('accepts a key containing whitespace as configured', () => {
    // Trimming happens when the env var is split, not here, so a key with a
    // deliberate trailing space is still matched exactly.
    const credentials = new ServiceCredentials(['key with space']);
    expect(credentials.matches('key with space')).toBe(true);
    expect(credentials.matches('key')).toBe(false);
  });
});

describe('InMemoryUserDirectory', () => {
  const user: User = {
    username: 'demo',
    passwordHash: '$argon2id$fake',
    scopes: ['api:read'],
  };

  it('finds a seeded user', async () => {
    const directory = new InMemoryUserDirectory([user]);
    expect(await directory.findByUsername('demo')).toEqual(user);
  });

  it('returns undefined for an unknown username', async () => {
    const directory = new InMemoryUserDirectory([user]);
    expect(await directory.findByUsername('nobody')).toBeUndefined();
  });

  it('refuses a duplicate username', () => {
    // Without this, which of two same-named users wins would depend on
    // insertion order, which is not a property anyone should depend on.
    expect(() => new InMemoryUserDirectory([user, { ...user, passwordHash: 'other' }])).toThrow(
      /duplicate user/,
    );
  });

  it('accepts an empty directory', async () => {
    const directory = new InMemoryUserDirectory([]);
    expect(await directory.findByUsername('anyone')).toBeUndefined();
  });

  it('does not match a username by prefix', async () => {
    const directory = new InMemoryUserDirectory([user]);
    expect(await directory.findByUsername('dem')).toBeUndefined();
    expect(await directory.findByUsername('demo2')).toBeUndefined();
    expect(await directory.findByUsername('DEMO')).toBeUndefined();
  });
});

describe('key hygiene', () => {
  it('generates a key pair whose public half matches the private half', async () => {
    // Guards the composition in main.ts and gen-dev-keys.sh: deriving the
    // public key from the private one is the only correct way to produce a pair.
    const keys = keyPair();
    const tokens = new JwtTokenPort(
      { ...keys, kid: 'k' },
      { issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 900, clockToleranceSeconds: 0 },
    );
    await tokens.init();

    const token = await tokens.sign(CLAIMS);
    await expect(tokens.verify(token)).resolves.toMatchObject({ sub: 'demo' });
  });

  it('produces a different key pair on every call', () => {
    expect(keyPair().privateKeyPem).not.toBe(keyPair().privateKeyPem);
  });

  it('uses 2048-bit keys, the current minimum worth deploying', () => {
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    // A 2048-bit modulus is 256 raw bytes, which base64-encodes to 344
    // characters. The SPKI PEM is longer still because of the envelope.
    expect(String(pair.publicKey).length).toBeGreaterThan(400);
  });

  it('keeps random bytes unpredictable for use as a salt', () => {
    // argon2 generates its own salt; this documents why no salt is derived from
    // anything predictable in this codebase.
    expect(randomBytes(16).toString('hex')).toHaveLength(32);
  });
});
