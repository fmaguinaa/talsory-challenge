import {
  SignJWT,
  exportJWK,
  importPKCS8,
  importSPKI,
  jwtVerify,
  type JWK,
  type KeyLike,
} from 'jose';

import type {
  JsonWebKeySet,
  SignableClaims,
  TokenClaims,
  TokenPort,
} from '../../domain/types';

/** The only algorithm this service signs or accepts. */
const ALGORITHM = 'RS256';

/**
 * Key material for signing and verifying.
 *
 * Both keys are loaded once at startup rather than per request: importing an
 * RSA key is expensive relative to a verification, and re-reading a PEM from
 * the environment on every call would also make a rotation restart the process.
 */
export interface KeyMaterial {
  /** The private key in PKCS#8 PEM form, used for signing. */
  readonly privateKeyPem: string;
  /** The public key in SPKI PEM form, published as JWKS. */
  readonly publicKeyPem: string;
  /** Identifier of this key, written as `kid` in every token. */
  readonly kid: string;
}

/**
 * Configuration of JWT verification.
 */
export interface JwtConfig {
  /** Required `iss` claim. */
  readonly issuer: string;
  /** Required `aud` claim. */
  readonly audience: string;
  /** Lifetime applied when signing, in seconds. */
  readonly ttlSeconds: number;
  /**
   * Allowed clock skew, in seconds.
   *
   * Tokens are issued by one container and verified by another, so a small
   * amount of drift is inevitable. Zero would reject a token that was minted
   * microseconds before the verifier's clock ticked over.
   */
  readonly clockToleranceSeconds: number;
}

/**
 * `jose`-backed implementation of the {@link TokenPort}.
 *
 * The algorithm allowlist is the important detail here. A verifier that trusts
 * the token's own `alg` header can be walked down to HMAC and handed a token
 * signed with the public key as the secret, which verifies. Pinning the
 * expected algorithm in the verifier's options removes that entire class of
 * attack, and `none` is never accepted because `algorithms` names RS256 alone.
 */
export class JwtTokenPort implements TokenPort {
  private privateKey!: KeyLike;
  private publicKey!: KeyLike;
  private jwkCache: JsonWebKeySet | undefined;

  constructor(
    private readonly keys: KeyMaterial,
    private readonly config: JwtConfig,
  ) {}

  /**
   * Imports both keys.
   *
   * Called once from the composition root so that a malformed PEM is a startup
   * failure with a clear message, rather than a 500 on the first login.
   */
  async init(): Promise<void> {
    this.privateKey = await importPKCS8(this.keys.privateKeyPem, ALGORITHM);
    this.publicKey = await importSPKI(this.keys.publicKeyPem, ALGORITHM);
    this.jwkCache = undefined;
  }

  /**
   * Signs a token.
   *
   * The header carries the `kid`, which is what lets a consumer holding a
   * JWKS pick the right key after a rotation without trying each one.
   */
  async sign(claims: SignableClaims): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    return new SignJWT({ scope: claims.scope })
      .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT', kid: this.keys.kid })
      .setSubject(claims.sub)
      .setIssuer(this.config.issuer)
      .setAudience(this.config.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + this.config.ttlSeconds)
      .sign(this.privateKey);
  }

  /**
   * Verifies a token and returns its claims.
   *
   * @throws Error when the signature, issuer, audience, expiry or algorithm
   *   does not check out; the message is never shown to a client
   */
  async verify(token: string): Promise<TokenClaims> {
    const { payload, protectedHeader } = await jwtVerify(token, this.publicKey, {
      algorithms: [ALGORITHM],
      issuer: this.config.issuer,
      audience: this.config.audience,
      clockTolerance: this.config.clockToleranceSeconds,
    });

    // A token without these claims is structurally unusable, and treating it as
    // valid would let a consumer see `sub: undefined` and believe it verified.
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.iss !== 'string' ||
      typeof payload.aud !== 'string' ||
      typeof payload.exp !== 'number' ||
      typeof payload.iat !== 'number' ||
      typeof payload.scope !== 'string'
    ) {
      throw new Error('token is missing one or more required claims');
    }

    return {
      sub: payload.sub,
      iss: payload.iss,
      aud: payload.aud,
      scope: payload.scope,
      iat: payload.iat,
      exp: payload.exp,
      kid: protectedHeader.kid ?? '',
    };
  }

  /**
   * Returns the public key set.
   *
   * The result is cached because exporting a public key to JWK form involves a
   * modular exponentiation, and this endpoint is public and may be polled often
   * by consumers refreshing their cache.
   */
  async jwks(): Promise<JsonWebKeySet> {
    if (this.jwkCache) return this.jwkCache;

    const jwk: JWK = await exportJWK(this.publicKey);
    this.jwkCache = {
      keys: [
        {
          kty: jwk.kty ?? 'RSA',
          kid: this.keys.kid,
          use: 'sig',
          alg: ALGORITHM,
          n: jwk.n ?? '',
          e: jwk.e ?? '',
        },
      ],
    };
    return this.jwkCache;
  }
}
