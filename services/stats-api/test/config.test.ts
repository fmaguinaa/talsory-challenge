import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config';

/**
 * Configuration is read from `process.env`, so every test snapshots the keys it
 * touches and restores them afterwards. Without that, tests would leak settings
 * into each other and the suite would depend on execution order.
 */
const TOUCHED = [
  'AUTH_SERVICE_KEY',
  'AUTH_SERVICE_URL',
  'AUTH_CACHE_TTL_SECONDS',
  'AUTH_VALIDATE_TIMEOUT_MS',
  'DIAGONAL_EPSILON',
  'LOG_LEVEL',
  'MAX_MATRIX_DIM',
  'MAX_MATRICES',
  'MAX_TOTAL_ELEMENTS',
  'SHUTDOWN_GRACE_SECONDS',
  'STATS_HOST',
  'STATS_MAX_BODY_BYTES',
  'STATS_PORT',
] as const;

describe('loadConfig', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = {};
    for (const key of TOUCHED) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
    process.env.AUTH_SERVICE_KEY = 'test-service-key';
  });

  afterEach(() => {
    for (const key of TOUCHED) {
      if (snapshot[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = snapshot[key];
      }
    }
  });

  it('applies defaults so local development needs only the service key', () => {
    const config = loadConfig();

    expect(config.port).toBe(4001);
    expect(config.host).toBe('0.0.0.0');
    expect(config.diagonalEpsilon).toBe(1e-9);
    expect(config.maxBodyBytes).toBe(1024 * 1024);
    expect(config.maxMatrices).toBe(16);
    expect(config.maxTotalElements).toBe(20_000);
    expect(config.maxMatrixDim).toBe(100);
    expect(config.authServiceUrl).toBe('http://auth-service:4000');
    expect(config.authCacheTtlSeconds).toBe(30);
    expect(config.authValidateTimeoutMs).toBe(1500);
    expect(config.logLevel).toBe('info');
    expect(config.shutdownGraceMs).toBe(10_000);
  });

  it('reads every override from the environment', () => {
    process.env.STATS_PORT = '5555';
    process.env.STATS_HOST = '127.0.0.1';
    process.env.DIAGONAL_EPSILON = '1e-6';
    process.env.STATS_MAX_BODY_BYTES = '2048';
    process.env.MAX_MATRICES = '4';
    process.env.MAX_TOTAL_ELEMENTS = '100';
    process.env.MAX_MATRIX_DIM = '25';
    process.env.AUTH_SERVICE_URL = 'http://auth:4000//';
    process.env.AUTH_CACHE_TTL_SECONDS = '5';
    process.env.AUTH_VALIDATE_TIMEOUT_MS = '250';
    process.env.LOG_LEVEL = 'debug';
    process.env.SHUTDOWN_GRACE_SECONDS = '30';

    const config = loadConfig();

    expect(config.port).toBe(5555);
    expect(config.host).toBe('127.0.0.1');
    expect(config.diagonalEpsilon).toBe(1e-6);
    expect(config.maxBodyBytes).toBe(2048);
    expect(config.maxMatrices).toBe(4);
    expect(config.maxTotalElements).toBe(100);
    expect(config.maxMatrixDim).toBe(25);
    // The trailing slashes are stripped so the adapter can append a path.
    expect(config.authServiceUrl).toBe('http://auth:4000');
    expect(config.authCacheTtlSeconds).toBe(5);
    expect(config.authValidateTimeoutMs).toBe(250);
    expect(config.logLevel).toBe('debug');
    expect(config.shutdownGraceMs).toBe(30_000);
  });

  describe('fails fast on invalid configuration', () => {
    it('requires the service credential', () => {
      delete process.env.AUTH_SERVICE_KEY;
      expect(() => loadConfig()).toThrow(/AUTH_SERVICE_KEY is required/);
    });

    it.each([
      ['a non-integer port', { STATS_PORT: 'http' }, /STATS_PORT must be an integer/],
      ['a port below the range', { STATS_PORT: '0' }, /STATS_PORT must be between/],
      ['a port above the range', { STATS_PORT: '70000' }, /STATS_PORT must be between/],
      ['a matrix limit of zero', { MAX_MATRIX_DIM: '0' }, /MAX_MATRIX_DIM must be between/],
      ['a negative total element limit', { MAX_TOTAL_ELEMENTS: '-5' }, /MAX_TOTAL_ELEMENTS/],
      ['an unusable body limit', { STATS_MAX_BODY_BYTES: '5' }, /STATS_MAX_BODY_BYTES/],
      ['a non-numeric epsilon', { DIAGONAL_EPSILON: 'tight' }, /DIAGONAL_EPSILON must be a number/],
      ['a negative epsilon', { DIAGONAL_EPSILON: '-1' }, /DIAGONAL_EPSILON must be between/],
      ['an unknown log level', { LOG_LEVEL: 'chatty' }, /LOG_LEVEL must be one of/],
      ['a negative cache TTL', { AUTH_CACHE_TTL_SECONDS: '-1' }, /AUTH_CACHE_TTL_SECONDS/],
      ['an unusable auth timeout', { AUTH_VALIDATE_TIMEOUT_MS: '1' }, /AUTH_VALIDATE_TIMEOUT_MS/],
    ])('rejects %s', (_label, env, expected) => {
      Object.assign(process.env, env);
      expect(() => loadConfig()).toThrow(expected);
    });

    it('names the offending variable so the operator can fix it', () => {
      process.env.MAX_MATRIX_DIM = 'lots';
      try {
        loadConfig();
        expect.unreachable('expected a configuration error');
      } catch (error) {
        expect((error as Error).message).toContain('MAX_MATRIX_DIM');
      }
    });
  });

  it('accepts an epsilon of exactly zero for a strict comparison', () => {
    process.env.DIAGONAL_EPSILON = '0';
    expect(loadConfig().diagonalEpsilon).toBe(0);
  });
});
