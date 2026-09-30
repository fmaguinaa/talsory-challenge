/**
 * Configuration loading and validation.
 *
 * Everything is read from the environment and validated once, at startup. A
 * service that boots with a nonsensical limit fails much later and much less
 * clearly, so the trade is obvious: fail fast with a message naming the
 * variable.
 */

/** Fully validated runtime configuration. */
export interface Config {
  /** Port the HTTP server listens on. */
  readonly port: number;
  /** Host interface the server binds to. */
  readonly host: string;
  /** Absolute tolerance for the diagonal predicate (ADR-004). */
  readonly diagonalEpsilon: number;
  /** Largest request body accepted, in bytes. */
  readonly maxBodyBytes: number;
  /** Largest number of matrices per request. */
  readonly maxMatrices: number;
  /** Largest total number of elements across all matrices. */
  readonly maxTotalElements: number;
  /** Largest row or column count of a single matrix. */
  readonly maxMatrixDim: number;
  /** Base URL of auth-service. */
  readonly authServiceUrl: string;
  /** Shared credential presented to auth-service. */
  readonly authServiceKey: string;
  /** Lifetime of a cached "token is active" answer, in seconds. */
  readonly authCacheTtlSeconds: number;
  /** Timeout for a single introspection call, in milliseconds. */
  readonly authValidateTimeoutMs: number;
  /** Pino log level. */
  readonly logLevel: string;
  /** How long a graceful shutdown may take, in milliseconds. */
  readonly shutdownGraceMs: number;
}

/** Reads an environment variable, falling back when unset or empty. */
function env(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

/**
 * Parses an integer environment variable and enforces an inclusive range.
 *
 * Out-of-range values are rejected rather than clamped: silently clamping would
 * hide a typo until requests start failing at runtime.
 */
function envInt(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer, got ${JSON.stringify(raw)}`);
  }
  if (value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

/**
 * Parses a floating-point environment variable and enforces a positive range.
 */
function envFloat(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${key} must be a number, got ${JSON.stringify(raw)}`);
  }
  if (value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

/** Valid log levels, matching pino. */
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * Builds the configuration from `process.env`.
 *
 * @throws Error describing the first invalid value found
 */
export function loadConfig(): Config {
  const logLevel = env('LOG_LEVEL', 'info');
  if (!LOG_LEVELS.includes(logLevel as (typeof LOG_LEVELS)[number])) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}; got ${JSON.stringify(logLevel)}`);
  }

  const authServiceKey = process.env.AUTH_SERVICE_KEY ?? '';
  if (authServiceKey.length === 0) {
    throw new Error(
      'AUTH_SERVICE_KEY is required: it is the credential stats-api presents to auth-service when introspecting a token',
    );
  }

  return {
    port: envInt('STATS_PORT', 4001, 1, 65535),
    host: env('STATS_HOST', '0.0.0.0'),
    diagonalEpsilon: envFloat('DIAGONAL_EPSILON', 1e-9, 0, 1),
    maxBodyBytes: envInt('STATS_MAX_BODY_BYTES', 1024 * 1024, 1024, 1024 * 1024 * 1024),
    maxMatrices: envInt('MAX_MATRICES', 16, 1, 1000),
    maxTotalElements: envInt('MAX_TOTAL_ELEMENTS', 20000, 1, 10_000_000),
    maxMatrixDim: envInt('MAX_MATRIX_DIM', 100, 1, 10000),
    authServiceUrl: env('AUTH_SERVICE_URL', 'http://auth-service:4000').replace(/\/+$/, ''),
    authServiceKey,
    authCacheTtlSeconds: envInt('AUTH_CACHE_TTL_SECONDS', 30, 0, 3600),
    authValidateTimeoutMs: envInt('AUTH_VALIDATE_TIMEOUT_MS', 1500, 50, 60_000),
    logLevel,
    shutdownGraceMs: envInt('SHUTDOWN_GRACE_SECONDS', 10, 1, 300) * 1000,
  };
}
