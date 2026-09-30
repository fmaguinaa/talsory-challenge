/**
 * Domain types and the port the use case depends on.
 *
 * Nothing in `src/domain` imports a framework, touches the filesystem or reads
 * the environment. That is what keeps the authentication rules testable without
 * generating keys or running a server.
 */

/** A user known to the service. */
export interface User {
  /** Stable subject claim (`sub`) written into the token. */
  readonly username: string;
  /** The argon2id hash of the password, in PHC string format. */
  readonly passwordHash: string;
  /** Space-separated scopes granted to the user. */
  readonly scopes: readonly string[];
}

/** Credentials submitted to the login endpoint. */
export interface Credentials {
  readonly username: string;
  readonly password: string;
}

/** The token handed back on a successful login. */
export interface IssuedToken {
  /** Compact-serialized JWT. */
  readonly accessToken: string;
  /** Lifetime in seconds, so the client knows when to refresh. */
  readonly expiresIn: number;
}

/** The claims this service puts into a token. */
export interface TokenClaims {
  /** Subject: the username. */
  readonly sub: string;
  /** Issuer, so a token from another environment is rejected here. */
  readonly iss: string;
  /** Audience, so a token minted for another service is rejected here. */
  readonly aud: string;
  /** Space-separated scopes. */
  readonly scope: string;
  /** Issued-at, seconds since the epoch. */
  readonly iat: number;
  /** Expiry, seconds since the epoch. */
  readonly exp: number;
  /** Key id, so a consumer can pick the right verification key. */
  readonly kid: string;
}

/** The outcome of introspecting a token. */
export type IntrospectionOutcome =
  | { readonly active: true; readonly claims: TokenClaims }
  | { readonly active: false };

/**
 * Port for signing and verifying tokens.
 *
 * Implemented by the `jose` adapter. The application layer depends on this
 * interface rather than on a library, so the crypto choice can change without
 * touching the authentication rules, and so tests can issue tokens without
 * generating a key pair.
 */
export interface TokenPort {
  /**
   * Signs a token with the private key.
   *
   * @param claims the claims to embed, without `iat`/`exp`/`kid`
   * @returns the compact-serialized JWT
   */
  sign(claims: SignableClaims): Promise<string>;

  /**
   * Verifies a token and returns its claims.
   *
   * Implementations must reject on: a bad signature, an expired token, a wrong
   * issuer or audience, an unknown `kid`, and any algorithm other than the one
   * configured. They must never accept a token they did not verify.
   */
  verify(token: string): Promise<TokenClaims>;

  /** Returns the public keys as a JWKS, for consumers that verify locally. */
  jwks(): Promise<JsonWebKeySet>;
}

/** The subset of claims a caller supplies when signing. */
export interface SignableClaims {
  readonly sub: string;
  readonly scope: string;
}

/** A JSON Web Key Set, as served at `/.well-known/jwks.json`. */
export interface JsonWebKeySet {
  readonly keys: readonly JsonWebKey[];
}

/** A single JSON Web Key. */
export interface JsonWebKey {
  readonly kty: string;
  readonly kid: string;
  readonly use: string;
  readonly alg: string;
  readonly n: string;
  readonly e: string;
}

/**
 * Port for verifying passwords.
 *
 * Implemented by the argon2 adapter.
 */
export interface PasswordPort {
  /**
   * Reports whether the password matches the hash.
   *
   * Implementations must perform the comparison in constant time and must not
   * short-circuit on the first differing byte.
   */
  verify(hash: string, password: string): Promise<boolean>;

  /** Hashes a password, for seeding users from plaintext at startup. */
  hash(password: string): Promise<string>;
}

/**
 * Port for looking users up.
 *
 * Deliberately in-memory: ADR-006 records why there is no database. A real
 * deployment would swap this adapter for one that queries a directory, without
 * the use case changing.
 */
export interface UserDirectory {
  /**
   * Returns the user with the given username, or `undefined`.
   *
   * The contract explicitly allows returning `undefined`: the caller must not be
   * able to distinguish "no such user" from "wrong password", so the use case
   * handles both identically.
   */
  findByUsername(username: string): Promise<User | undefined>;
}

/** Raised when the credentials are not valid. */
export class InvalidCredentialsError extends Error {
  /**
   * The message is intentionally the same for an unknown user and a wrong
   * password. Distinguishing them would let an attacker enumerate valid
   * usernames, so the wording carries no information about which case it was.
   */
  constructor() {
    super('Invalid username or password.');
    this.name = 'InvalidCredentialsError';
  }
}

/** Raised when the introspection request itself is not acceptable. */
export class ServiceAuthenticationError extends Error {
  constructor(message = 'A valid service credential is required.') {
    super(message);
    this.name = 'ServiceAuthenticationError';
  }
}

/** Raised when the login body is structurally wrong. */
export class ValidationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ValidationError';
  }
}
