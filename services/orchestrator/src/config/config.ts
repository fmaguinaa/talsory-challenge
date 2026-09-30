import type { DownstreamOptions } from '../common/downstream';

/** Settings shared by every downstream call shape. */
export interface DownstreamSettings extends DownstreamOptions {
  /** Credential presented to auth-service when introspecting a token. */
  readonly serviceKey: string;
}

/** Fully validated runtime configuration. */
export interface OrchestratorConfig {
  readonly port: number;
  readonly host: string;
  readonly nodeEnv: string;
  readonly corsOrigins: readonly string[];
  readonly maxMatrixDim: number;
  readonly maxBodyBytes: number;
  readonly throttleTtlMs: number;
  readonly throttleLimit: number;
  readonly shutdownGraceMs: number;
  readonly logLevel: string;
  readonly authService: DownstreamSettings;
  readonly qrApi: DownstreamSettings;
  readonly statsApi: DownstreamSettings;
}

/** Injection token for the configuration. */
export const CONFIG_TOKEN = Symbol('ORCHESTRATOR_CONFIG');

/** Valid pino log levels. */
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Reads an environment variable with a fallback when unset or empty. */
function env(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

/** Parses an integer environment variable within an inclusive range. */
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
 * Parses the CORS allow-list.
 *
 * The list is explicit rather than a wildcard. The orchestrator is the only
 * public backend, so its CORS policy is the whole system's policy: a wildcard
 * would let any site issue authenticated requests with a token it somehow
 * obtained.
 */
function parseCorsOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** Validates a URL-shaped setting early, so a typo is a startup failure. */
function envUrl(key: string, fallback: string): string {
  const raw = env(key, fallback);
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`unsupported protocol ${url.protocol}`);
    }
  } catch (error) {
    throw new Error(
      `${key} must be an http(s) URL, got ${JSON.stringify(raw)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Builds the configuration from `process.env`.
 *
 * Every value is validated here so that a bad setting is a startup failure with
 * a message naming the variable, rather than a confusing error under load.
 *
 * @throws Error describing the first invalid value found
 */
export function loadConfig(): OrchestratorConfig {
  const logLevel = env('LOG_LEVEL', 'info');
  if (!LOG_LEVELS.includes(logLevel as (typeof LOG_LEVELS)[number])) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}; got ${JSON.stringify(logLevel)}`);
  }

  const authServiceKey = process.env.AUTH_SERVICE_KEY ?? '';
  if (authServiceKey.length === 0) {
    throw new Error(
      'AUTH_SERVICE_KEY is required: it is the credential the orchestrator presents when validating a token',
    );
  }

  const serviceKey = authServiceKey;
  const timeoutMs = envInt('DOWNSTREAM_TIMEOUT_MS', 3000, 100, 60_000);
  const retries = envInt('DOWNSTREAM_RETRIES', 1, 0, 5);
  const retryBackoffMs = envInt('DOWNSTREAM_RETRY_BACKOFF_MS', 100, 1, 5000);

  return {
    port: envInt('PORT', 3000, 1, 65535),
    host: env('HOST', '0.0.0.0'),
    nodeEnv: env('NODE_ENV', 'development'),
    corsOrigins: parseCorsOrigins(env('CORS_ORIGINS', 'http://localhost:8080')),
    // The same limit qr-api enforces, so the orchestrator refuses an oversized
    // matrix before spending a network round trip on it.
    maxMatrixDim: envInt('MAX_MATRIX_DIM', 100, 1, 10_000),
    maxBodyBytes: envInt('MAX_BODY_BYTES', 1024 * 1024, 1024, 1024 * 1024 * 1024),
    throttleTtlMs: envInt('THROTTLE_TTL_MS', 60_000, 1000, 3_600_000),
    throttleLimit: envInt('THROTTLE_LIMIT', 120, 1, 100_000),
    shutdownGraceMs: envInt('SHUTDOWN_GRACE_SECONDS', 10, 1, 300) * 1000,
    logLevel,
    authService: {
      baseUrl: envUrl('AUTH_SERVICE_URL', 'http://auth-service:4000'),
      serviceKey,
      timeoutMs: envInt('AUTH_VALIDATE_TIMEOUT_MS', 1500, 50, 60_000),
      // Token validation is safe to retry: it has no side effects.
      retries,
      retryBackoffMs,
    },
    qrApi: {
      baseUrl: envUrl('QR_API_URL', 'http://qr-api:8081'),
      serviceKey,
      timeoutMs,
      retries,
      retryBackoffMs,
    },
    statsApi: {
      baseUrl: envUrl('STATS_API_URL', 'http://stats-api:4001'),
      serviceKey,
      timeoutMs,
      retries,
      retryBackoffMs,
    },
  };
}
