import {
  InvalidCredentialsError,
  ServiceAuthenticationError,
  ValidationError,
  type Credentials,
  type IntrospectionOutcome,
  type JsonWebKeySet,
  type IssuedToken,
  type PasswordPort,
  type TokenPort,
  type UserDirectory,
} from '../domain/types';

/** Configuration of the authentication rules. */
export interface AuthConfig {
  /** Issuer claim written into, and required on, every token. */
  readonly issuer: string;
  /** Audience claim written into, and required on, every token. */
  readonly audience: string;
  /** Token lifetime in seconds. */
  readonly ttlSeconds: number;
  /** Scopes granted to every user, appended to their own. */
  readonly defaultScopes: readonly string[];
}

/** Bounds on the credential fields, mirroring contracts/auth-service.yaml. */
const MAX_USERNAME_LENGTH = 128;
const MAX_PASSWORD_LENGTH = 256;

/**
 * Validates a login body.
 *
 * Bounds are enforced here rather than only in the OpenAPI schema because the
 * body is `unknown` until it is parsed, and an unbounded username would be
 * hashed and compared before anything noticed it was absurdly long.
 */
export function parseCredentials(body: unknown): Credentials {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('request body must be a JSON object');
  }

  const { username, password } = body as { username?: unknown; password?: unknown };

  if (typeof username !== 'string' || username.length === 0) {
    throw new ValidationError('field "username" is required and must be a non-empty string');
  }
  if (username.length > MAX_USERNAME_LENGTH) {
    throw new ValidationError(`field "username" must be at most ${MAX_USERNAME_LENGTH} characters`);
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new ValidationError('field "password" is required and must be a non-empty string');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new ValidationError(`field "password" must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }

  return { username, password };
}

/**
 * Authentication rules.
 *
 * This class is the whole of auth-service's business logic. It has no I/O of
 * its own: it asks the injected ports to do the work, which is what allows the
 * security properties below to be tested without a server or a key pair.
 */
export class AuthService {
  private readonly config: AuthConfig;

  constructor(
    private readonly users: UserDirectory,
    private readonly passwords: PasswordPort,
    private readonly tokens: TokenPort,
    config: AuthConfig,
  ) {
    this.config = config;
  }

  /**
   * Exchanges credentials for a token.
   *
   * User enumeration is prevented by two measures working together:
   *
   * 1. An unknown username still triggers a password verification, against a
   *    dummy hash, so the response time does not reveal whether the user
   *    exists. Skipping it would turn the endpoint into an oracle.
   * 2. Both cases raise the same {@link InvalidCredentialsError} with the same
   *    message, so the response body does not reveal it either.
   *
   * @throws InvalidCredentialsError for an unknown user or a wrong password
   */
  async login(body: unknown): Promise<IssuedToken> {
    const { username, password } = parseCredentials(body);

    const user = await this.users.findByUsername(username);

    if (!user) {
      // Hash a throwaway password so the timing of the two paths matches.
      await this.passwords.verify(DUMMY_HASH, password);
      throw new InvalidCredentialsError();
    }

    const passwordMatches = await this.passwords.verify(user.passwordHash, password);
    if (!passwordMatches) {
      throw new InvalidCredentialsError();
    }

    const scopes = [...user.scopes, ...this.config.defaultScopes];
    const accessToken = await this.tokens.sign({ sub: user.username, scope: scopes.join(' ') });

    return { accessToken, expiresIn: this.config.ttlSeconds };
  }

  /**
   * Introspects a token for another service.
   *
   * @param token the raw token, already extracted from the request
   * @returns the claims when the token is valid, `{ active: false }` otherwise
   * @throws ServiceAuthenticationError when the caller's service key is missing
   *   or wrong, which is a 401 about the *caller*, not about the token
   */
  async introspect(token: string): Promise<IntrospectionOutcome> {
    if (token.trim().length === 0) {
      return { active: false };
    }

    try {
      const claims = await this.tokens.verify(token);
      return { active: true, claims };
    } catch {
      // Every verification failure is reported the same way, as "not active".
      // Distinguishing "expired" from "bad signature" from "wrong audience"
      // would tell an attacker which part of a forged token to fix.
      return { active: false };
    }
  }

  /**
   * Checks the shared credential a backend presents when introspecting.
   *
   * The comparison is delegated to {@link ServiceCredentialPort} so that the
   * constant-time property lives in one place, next to the code that knows why
   * it is needed.
   */
  authorizeService(presented: string | undefined, port: ServiceCredentialPort): void {
    if (typeof presented !== 'string' || presented.length === 0) {
      throw new ServiceAuthenticationError();
    }
    if (!port.matches(presented)) {
      throw new ServiceAuthenticationError();
    }
  }

  /** Returns the public keys, for consumers that verify tokens locally. */
  async jwks(): Promise<JsonWebKeySet> {
    return this.tokens.jwks();
  }
}

/**
 * Port for checking a service credential.
 *
 * Split out from the rest so the constant-time comparison is a named,
 * separately testable concern rather than an inline `===`.
 */
export interface ServiceCredentialPort {
  /** Reports whether the presented credential is one of the configured keys. */
  matches(presented: string): boolean;
}

/**
 * A syntactically valid argon2id hash of a value nobody knows.
 *
 * It exists so that logging in with an unknown username performs a real
 * verification and takes roughly the same time as a real one. The plaintext
 * behind it is irrelevant; only its shape and cost parameters matter.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$I21dT5EBIS8A9v++fVtfNQ$nDvtuKu5rg7UByvhF105L9i+Q+8lIKZ7XTL3nDi5CDE';
