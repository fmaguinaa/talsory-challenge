import { readFileSync } from 'node:fs';

/** Fully validated runtime configuration. */
export interface AuthConfigRuntime {
  readonly port: number;
  readonly host: string;
  readonly issuer: string;
  readonly audience: string;
  readonly ttlSeconds: number;
  readonly clockToleranceSeconds: number;
  readonly serviceApiKeys: readonly string[];
  readonly logLevel: string;
  readonly loginRateLimitWindowMs: number;
  readonly loginRateLimitMax: number;
  readonly maxBodyBytes: number;
  readonly shutdownGraceMs: number;
  readonly jwtPrivateKeyPem: string;
  readonly jwtPublicKeyPem: string;
  readonly jwtKid: string;
  readonly users: ReadonlyArray<{ username: string; passwordHash: string; scopes: string[] }>;
  readonly defaultScopes: readonly string[];
  readonly argon2: { memoryCost: number; timeCost: number; parallelism: number };
}

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
 * Normalizes a PEM that arrived through the environment.
 *
 * Secrets are frequently mounted from files or injected by a secret manager,
 * both of which produce a literal `\n` two-character sequence rather than a
 * newline. `importPKCS8` would then reject the key with a message that does not
 * mention the real cause, so the escapes are turned into real newlines here.
 */
function normalizePem(raw: string, label: string): string {
  const pem = raw.replace(/\\n/g, '\n').trim();
  if (pem.length === 0) {
    throw new Error(`${label} is empty`);
  }
  if (!pem.includes('-----BEGIN')) {
    throw new Error(`${label} does not look like a PEM block (no -----BEGIN marker)`);
  }
  return pem;
}

/**
 * Parses the seeded user list.
 *
 * Two shapes are accepted: `AUTH_USERS`, a JSON array of
 * `[{username, passwordHash, scopes?}]`, and the single-user
 * `DEMO_USERNAME` / `DEMO_PASSWORD_HASH` pair. The pair exists because typing
 * a JSON array into a `.env` file is unpleasant; the array exists because one
 * demo user is not enough to show that logins are actually scoped.
 */
function parseUsers(): AuthConfigRuntime['users'] {
  const authUsers = process.env.AUTH_USERS;
  if (authUsers !== undefined && authUsers !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(authUsers);
    } catch (error) {
      throw new Error(
        `AUTH_USERS must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('AUTH_USERS must be a non-empty JSON array');
    }

    return parsed.map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(`AUTH_USERS[${index}] must be an object`);
      }
      const { username, passwordHash, scopes } = entry as {
        username?: unknown;
        passwordHash?: unknown;
        scopes?: unknown;
      };
      if (typeof username !== 'string' || username.length === 0) {
        throw new Error(`AUTH_USERS[${index}].username must be a non-empty string`);
      }
      if (typeof passwordHash !== 'string' || passwordHash.length === 0) {
        throw new Error(`AUTH_USERS[${index}].passwordHash must be a non-empty string`);
      }
      if (!passwordHash.startsWith('$argon2')) {
        throw new Error(
          `AUTH_USERS[${index}].passwordHash must be an argon2id hash; generate one with scripts/gen-dev-keys.sh`,
        );
      }
      if (
        scopes !== undefined &&
        (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string'))
      ) {
        throw new Error(`AUTH_USERS[${index}].scopes must be an array of strings when present`);
      }
      return {
        username,
        passwordHash,
        scopes: (scopes as string[] | undefined) ?? [],
      };
    });
  }

  const demoUsername = process.env.DEMO_USERNAME;
  const demoHash = process.env.DEMO_PASSWORD_HASH;
  if (demoUsername && demoHash) {
    if (!demoHash.startsWith('$argon2')) {
      throw new Error('DEMO_PASSWORD_HASH must be an argon2id hash');
    }
    return [{ username: demoUsername, passwordHash: demoHash, scopes: [] }];
  }

  throw new Error(
    'no users configured: set AUTH_USERS, or both DEMO_USERNAME and DEMO_PASSWORD_HASH (run ./scripts/gen-dev-keys.sh)',
  );
}

/**
 * Builds the configuration from `process.env` and the filesystem.
 *
 * Private and public keys are looked for in three places, in order: the
 * `JWT_*_KEY_PEM` environment variables, then `JWT_PRIVATE_KEY_FILE` and
 * `JWT_PUBLIC_KEY_FILE`. Both are needed because no deployment platform hands a
 * multi-line secret to an environment variable comfortably; a mounted file is
 * usually the sane option, and supporting both avoids forcing one onto anyone.
 *
 * @throws Error describing the first problem found
 */
export function loadConfig(): AuthConfigRuntime {
  const logLevel = env('LOG_LEVEL', 'info');
  if (!LOG_LEVELS.includes(logLevel as (typeof LOG_LEVELS)[number])) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}; got ${JSON.stringify(logLevel)}`);
  }

  const privateKeyPem = resolveKey('JWT_PRIVATE_KEY_PEM', 'JWT_PRIVATE_KEY_FILE');
  const publicKeyPem = resolveKey('JWT_PUBLIC_KEY_PEM', 'JWT_PUBLIC_KEY_FILE');

  const serviceApiKeys = env('SERVICE_API_KEYS', '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  if (serviceApiKeys.length === 0) {
    throw new Error(
      'SERVICE_API_KEYS is required: it is the credential backends present when introspecting a token',
    );
  }

  return {
    port: envInt('AUTH_PORT', 4000, 1, 65535),
    host: env('AUTH_HOST', '0.0.0.0'),
    issuer: env('JWT_ISSUER', 'https://interseguro.local/auth'),
    audience: env('JWT_AUDIENCE', 'interseguro-api'),
    ttlSeconds: envInt('JWT_TTL_SECONDS', 900, 30, 86_400),
    clockToleranceSeconds: envInt('JWT_CLOCK_TOLERANCE_SECONDS', 5, 0, 300),
    serviceApiKeys,
    logLevel,
    loginRateLimitWindowMs: envInt('LOGIN_RATE_LIMIT_WINDOW_MS', 60_000, 1000, 3_600_000),
    loginRateLimitMax: envInt('LOGIN_RATE_LIMIT_MAX', 20, 1, 10_000),
    maxBodyBytes: envInt('AUTH_MAX_BODY_BYTES', 16 * 1024, 256, 1024 * 1024),
    shutdownGraceMs: envInt('SHUTDOWN_GRACE_SECONDS', 10, 1, 300) * 1000,
    jwtPrivateKeyPem: normalizePem(privateKeyPem, 'JWT_PRIVATE_KEY_PEM'),
    jwtPublicKeyPem: normalizePem(publicKeyPem, 'JWT_PUBLIC_KEY_PEM'),
    jwtKid: env('JWT_KID', 'dev-key-1'),
    users: parseUsers(),
    defaultScopes: env('DEFAULT_SCOPES', 'api:read').split(' ').filter((scope) => scope.length > 0),
    argon2: {
      // OWASP's baseline for argon2id: 19 MiB, two passes, one lane.
      memoryCost: envInt('ARGON2_MEMORY_COST_KIB', 19_456, 1024, 1_048_576),
      // argon2 rejects a time cost below 2, so the floor is 2 rather than 1.
      timeCost: envInt('ARGON2_TIME_COST', 2, 2, 16),
      parallelism: envInt('ARGON2_PARALLELISM', 1, 1, 16),
    },
  };
}

/** Reads key material from the environment or from a mounted file. */
function resolveKey(envKey: string, fileKey: string): string {
  const inline = process.env[envKey];
  if (inline !== undefined && inline !== '') return inline;

  const path = process.env[fileKey];
  if (path !== undefined && path !== '') {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      throw new Error(
        `${fileKey} points at ${path}, which could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  throw new Error(`${envKey} (or ${fileKey}) is required`);
}
