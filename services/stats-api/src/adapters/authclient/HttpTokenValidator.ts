import { createHash } from 'node:crypto';
import type { TokenValidationResult, TokenValidator } from '../../application/ComputeStatsUseCase';

/** Upper bound on how much of an introspection response is read. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Upper bound on cached entries, so a token flood cannot grow the heap. */
const MAX_CACHE_ENTRIES = 4096;

/** Configuration of the introspection client. */
export interface ValidatorConfig {
  /** Base URL of auth-service, without a trailing slash. */
  readonly baseUrl: string;
  /** Shared credential sent as `X-Service-Key`. */
  readonly serviceKey: string;
  /** Timeout for a single introspection call, in milliseconds. */
  readonly timeoutMs: number;
  /** Lifetime of a cached positive answer, in seconds. Zero disables caching. */
  readonly cacheTtlSeconds: number;
}

/** One memoized introspection answer. */
interface CacheEntry {
  /** When the entry stops being usable. */
  readonly expiresAt: number;
}

/** Shape of the auth-service `/auth/validate` response. */
interface IntrospectionResponse {
  active?: unknown;
  exp?: unknown;
}

/**
 * HTTP adapter for the `TokenValidator` port.
 *
 * Design notes (ADR-005):
 *
 * - Fail closed. Every transport error, timeout, non-200 status or malformed
 *   body maps to `'unavailable'`, never to `'active'`.
 * - Only positive answers are cached. A cached negative would keep rejecting a
 *   token after it was legitimately re-issued.
 * - The cache is keyed by the SHA-256 digest of the token, so a heap dump of
 *   this process cannot reveal bearer tokens, and by the token's own `exp`, so
 *   an entry can never outlive the token it describes.
 * - The cache is per instance, which bounds revocation latency by the TTL
 *   rather than making it instantaneous. That trade buys one fewer network hop
 *   on every authenticated request.
 */
export class HttpTokenValidator implements TokenValidator {
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly entries = new Map<string, CacheEntry>();

  /**
   * @param config connection settings and limits
   * @param fetchImpl the fetch implementation, injectable so tests can drive
   *   the adapter without a live auth-service
   */
  constructor(
    config: ValidatorConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.serviceKey = config.serviceKey;
    this.timeoutMs = config.timeoutMs;
    this.cacheTtlMs = config.cacheTtlSeconds * 1000;
  }

  /**
   * Reports whether the token is currently active.
   *
   * @param token the raw bearer token
   */
  async validate(token: string): Promise<TokenValidationResult> {
    if (token.trim().length === 0) return 'inactive';

    const cacheKey = this.cacheKey(token);
    if (this.readCache(cacheKey)) return 'active';

    const controller = new AbortController();
    // The timer is what makes a hung dependency observable. Without it, fetch
    // would wait indefinitely and the request would never get an answer.
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/auth/validate`, {
        method: 'POST',
        headers: {
          // The token under inspection. Without this header the authority sees
          // no credential, answers `{ active: false }`, and every valid token is
          // reported as invalid -- a failure that looks like an authentication
          // bug and is not one.
          authorization: `Bearer ${token}`,
          // The service credential authorises the introspection *call*; it is a
          // different secret from the token being inspected.
          'x-service-key': this.serviceKey,
          accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch {
      // DNS failures, refused connections and aborts all land here, and from
      // this service's point of view they are the same event: we cannot vouch
      // for the token.
      return 'unavailable';
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401 || response.status === 403) {
      // auth-service rejected *us*. That is a deployment misconfiguration, not
      // a bad user token, and reporting 'inactive' would send the client into
      // an endless re-login loop.
      return 'unavailable';
    }
    if (!response.ok) return 'unavailable';

    let body: IntrospectionResponse;
    try {
      const text = await this.readBounded(response);
      body = JSON.parse(text) as IntrospectionResponse;
    } catch {
      return 'unavailable';
    }

    if (body.active !== true) return 'inactive';

    this.writeCache(cacheKey, body.exp);
    return 'active';
  }

  /**
   * Reads at most {@link MAX_RESPONSE_BYTES} from the response.
   *
   * A peer that answers with an unbounded body would otherwise be able to
   * exhaust this process's memory, and the payload we expect is a few claims.
   */
  private async readBounded(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return await response.text();

    const decoder = new TextDecoder();
    let text = '';
    let received = 0;

    while (true) {
      // The DOM/stream lib types are not part of the ES2023 lib target, so the
      // reader result is described locally rather than imported.
      const { done, value } = (await reader.read()) as { done?: boolean; value?: Uint8Array };
      if (value === undefined) break;
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('introspection response exceeded the maximum accepted size');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  }

  /**
   * Builds the cache key for a token.
   *
   * The digest, not the token, is the key: the map is a long-lived structure
   * that must never hold a usable credential, and a SHA-256 prefix is short
   * enough to be cheap and long enough that a collision is not a concern.
   */
  private cacheKey(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Returns whether a live entry exists for the key, evicting it otherwise. */
  private readCache(key: string): boolean {
    if (this.cacheTtlMs <= 0) return false;

    const entry = this.entries.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      // Evicted lazily rather than by a sweeper: the entry is tiny, and a
      // background timer would be more machinery than the problem deserves.
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Memoizes a positive answer.
   *
   * The lifetime is the smaller of the configured TTL and the token's remaining
   * life, so the cache can never make an expired token look active.
   */
  private writeCache(key: string, exp: unknown): void {
    if (this.cacheTtlMs <= 0) return;

    const now = Date.now();
    let expiresAt = now + this.cacheTtlMs;

    if (typeof exp === 'number' && Number.isFinite(exp)) {
      const tokenExpiry = exp * 1000;
      if (tokenExpiry < expiresAt) expiresAt = tokenExpiry;
    }

    // A token that is already expired, or an empty window, is not worth
    // caching: the entry would churn the map without ever being read.
    if (expiresAt <= now) return;

    if (this.entries.size >= MAX_CACHE_ENTRIES) {
      // Dropping the whole map at the ceiling is crude but predictable, and it
      // happens at most once per MAX_CACHE_ENTRIES distinct tokens.
      this.entries.clear();
    }
    this.entries.set(key, { expiresAt });
  }
}
