import { timingSafeEqual } from 'node:crypto';

import type { ServiceCredentialPort } from '../../application/AuthService';

/**
 * Constant-time comparison of a presented credential against a configured set.
 *
 * A plain `===` on a shared secret leaks its length and the position of the
 * first differing byte through timing. With enough measurements an attacker
 * recovers the secret one character at a time, which is why every comparison
 * here goes through `timingSafeEqual`.
 *
 * The subtlety is that `timingSafeEqual` throws when the two buffers have
 * different lengths, and it returns early in that case, so length would leak
 * again. The presented value is therefore padded to the length of the longest
 * configured key before comparison: a mismatch in length becomes a mismatch in
 * content, which is handled in constant time.
 */
export class ServiceCredentials implements ServiceCredentialPort {
  private readonly keys: readonly string[];

  /**
   * @param keys the accepted credentials
   * @throws Error when the set is empty, which would silently disable the
   *   check and let anyone introspect tokens
   */
  constructor(keys: readonly string[]) {
    // A whitespace-only entry is rejected here as well as in the environment
    // parser: the class must not accept a blank credential even if a future
    // caller forgets to trim, because a blank key means no key.
    const usable = keys.filter((key) => key.trim().length > 0);
    if (usable.length === 0) {
      throw new Error('SERVICE_API_KEYS must contain at least one non-empty key');
    }
    this.keys = Object.freeze([...usable]);
  }

  /**
   * Reports whether the presented value is one of the configured keys.
   *
   * Every key is compared, even after a match, so the time taken does not
   * depend on which key matched or on its position in the list.
   */
  matches(presented: string): boolean {
    const presentedBytes = Buffer.from(presented, 'utf8');
    let matched = false;

    for (const key of this.keys) {
      const keyBytes = Buffer.from(key, 'utf8');
      // Both sides are padded to a common length so the comparison below is
      // always over equal-sized buffers.
      const width = Math.max(keyBytes.length, presentedBytes.length);
      const paddedKey = Buffer.alloc(width);
      const paddedPresented = Buffer.alloc(width);
      keyBytes.copy(paddedKey);
      presentedBytes.copy(paddedPresented);

      if (timingSafeEqual(paddedKey, paddedPresented)) {
        matched = true;
      }
    }

    return matched;
  }
}
