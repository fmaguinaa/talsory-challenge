import argon2 from 'argon2';

import type { PasswordPort } from '../../domain/types';

/** Cost parameters for hashing and verifying. */
export interface Argon2Config {
  /** Memory cost in KiB. 19 MiB is the OWASP baseline for argon2id. */
  readonly memoryCost: number;
  /** Number of passes. */
  readonly timeCost: number;
  /** Degree of parallelism. */
  readonly parallelism: number;
}

/**
 * argon2id implementation of the {@link PasswordPort}.
 *
 * argon2id is chosen over bcrypt and scrypt for two reasons: it is the winner
 * of the Password Hashing Competition and is therefore the best studied against
 * both GPUs and memory-hard attacks, and it is memory-hard, which is what stops
 * an attacker from trading cheap bandwidth for parallel guesses.
 *
 * The verify path uses `argon2.verify`, which runs the KDF and compares in
 * constant time. No branch on the first mismatching byte appears anywhere in
 * this file, which is the property that makes a timing attack on a stolen hash
 * impractical.
 */
export class Argon2PasswordPort implements PasswordPort {
  constructor(private readonly config: Argon2Config) {}

  /**
   * Hashes a password with argon2id.
   *
   * @returns the hash in PHC string format, which embeds the algorithm and the
   *   cost parameters, so a later cost increase does not invalidate old hashes
   */
  async hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: this.config.memoryCost,
      timeCost: this.config.timeCost,
      parallelism: this.config.parallelism,
    });
  }

  /**
   * Reports whether the password matches the hash.
   *
   * Returns `false` rather than throwing for a malformed hash: a corrupt entry
   * in the user store must not become a 500 that tells an attacker which
   * usernames have broken records.
   */
  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
}
