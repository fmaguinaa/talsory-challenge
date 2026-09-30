import type { LabeledMatrix, StatsResult } from '../domain/types';
import { computeStats, validateStatsRequest, type StatsLimits } from './computeStats';

/**
 * Reasons an authorization check can refuse a request.
 *
 * They are separate cases because the HTTP layer must translate them into
 * different status codes: an invalid token is a 401 the client can fix by
 * logging in again, whereas an unreachable authority is a 503 the client can
 * only retry. Merging them would tell a user to re-authenticate while the real
 * problem is a dependency being down.
 */
export type TokenValidationResult = 'active' | 'inactive' | 'unavailable';

/**
 * Port through which the use case asks whether a bearer token is valid.
 *
 * Declared in the application layer and implemented by an adapter that speaks
 * HTTP to auth-service. Depending on the port rather than the client keeps the
 * dependency pointing inward and lets tests substitute a stub.
 */
export interface TokenValidator {
  /**
   * Reports the status of the token.
   *
   * Implementations must return `'unavailable'` rather than `'inactive'` when
   * the authority cannot be reached: failing closed with a definite "no" would
   * be a lie, and failing open would be a security hole.
   */
  validate(token: string): Promise<TokenValidationResult>;
}

/**
 * Raised when the caller presented no usable bearer token.
 *
 * A 401 at the HTTP layer. Distinct from an unavailable authority, which is a
 * 503.
 */
export class UnauthorizedError extends Error {
  constructor(message = 'A valid bearer token is required.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Raised when the authorization authority could not be consulted.
 *
 * A 503 at the HTTP layer, with `Retry-After`. The request is refused: with no
 * way to check the token, letting it through would mean authorizing on trust.
 */
export class AuthUnavailableError extends Error {
  constructor(message = 'The authentication service could not be reached.') {
    super(message);
    this.name = 'AuthUnavailableError';
  }
}

/** Everything the use case needs, injected so tests can substitute any part. */
export interface ComputeStatsDeps {
  /** Authorizes the caller. */
  readonly validator: TokenValidator;
  /** Bounds applied to the payload. */
  readonly limits: StatsLimits;
  /** Absolute tolerance for the diagonal predicate (ADR-004). */
  readonly epsilon: number;
}

/**
 * The single application entry point of the service.
 *
 * The order of operations is deliberate: authorize first, validate second.
 * An unauthenticated caller learns nothing about the shape rules, and no CPU
 * is spent on requests that would be refused anyway.
 */
export class ComputeStatsUseCase {
  private readonly validator: TokenValidator;
  private readonly limits: StatsLimits;
  private readonly epsilon: number;

  constructor(deps: ComputeStatsDeps) {
    this.validator = deps.validator;
    this.limits = deps.limits;
    this.epsilon = deps.epsilon;
  }

  /**
   * Authorizes the caller, validates the payload and computes the statistics.
   *
   * @param token the raw bearer token presented by the caller
   * @param body the untrusted request body
   * @throws UnauthorizedError when the token is missing or rejected
   * @throws AuthUnavailableError when the authority cannot be consulted
   * @throws ValidationError or PayloadTooLargeError for a bad payload
   */
  async execute(token: string, body: unknown): Promise<StatsResult> {
    await this.authorize(token);

    const matrices: LabeledMatrix[] = validateStatsRequest(body, this.limits);
    return computeStats(matrices, this.epsilon);
  }

  /**
   * Authorizes the caller, translating the port's three-way answer into the two
   * error kinds the transport layer understands.
   *
   * An adapter that throws instead of returning an answer is treated as
   * `'unavailable'`. That is a second line of defence behind the port contract,
   * but it is the line that matters: a rejected promise here must not surface
   * as a 500, because a 500 tells the client the service is broken while the
   * real situation is that we could not reach the authority and therefore
   * cannot vouch for the token.
   */
  private async authorize(token: string): Promise<void> {
    if (token.trim().length === 0) {
      throw new UnauthorizedError();
    }

    let outcome: TokenValidationResult;
    try {
      outcome = await this.validator.validate(token);
    } catch {
      throw new AuthUnavailableError();
    }

    switch (outcome) {
      case 'active':
        return;
      case 'inactive':
        throw new UnauthorizedError();
      case 'unavailable':
        throw new AuthUnavailableError();
      default: {
        // An adapter returning something outside the union is a bug in that
        // adapter. Fail closed rather than guess.
        const exhaustive: never = outcome;
        throw new AuthUnavailableError(`Unexpected validation outcome: ${String(exhaustive)}`);
      }
    }
  }
}
