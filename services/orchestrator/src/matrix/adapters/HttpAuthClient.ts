import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG_TOKEN, type OrchestratorConfig } from '../../config/config';

import {
  DownstreamError,
  buildRequestConfig,
  classifyAxiosError,
  downstreamHeaders,
} from '../../common/downstream';
import { WorkflowError, type AuthClient } from '../application/AnalyzeWorkflow';
import type { LoginResponse } from '../domain/types';

/** Injection token for the auth client, so tests can supply a double. */
export const AUTH_CLIENT = Symbol('AUTH_CLIENT');

/**
 * HTTP adapter for auth-service.
 *
 * Two responsibilities, deliberately kept in one class because they share the
 * same connection settings and the same failure classification: proxying login,
 * and validating tokens on behalf of the guard.
 */
@Injectable()
export class HttpAuthClient implements AuthClient {
  private readonly logger = new Logger(HttpAuthClient.name);

  // Every constructor parameter carries an explicit @Inject token. Nest can
  // infer types from the emitted design:paramtypes metadata, but esbuild (used
  // by tsx and vitest) does not emit it, so an inferred dependency silently
  // fails to resolve under test. Explicit tokens work under both compilers.
  constructor(
    @Inject(HttpService) private readonly http: HttpService,
    @Inject(CONFIG_TOKEN) private readonly config: OrchestratorConfig,
  ) {}

  /**
   * Exchanges credentials for a token.
   *
   * The response is proxied essentially verbatim: the orchestrator is a BFF, and
   * re-deriving the token type or the lifetime here would mean two places to
   * keep in sync for no benefit.
   *
   * @throws WorkflowError with kind `unauthorized` when the credentials are
   *   refused, or `downstream-failure`/`downstream-timeout` otherwise
   */
  async login(username: string, password: string, requestId: string): Promise<LoginResponse> {
    const options = this.config.authService;
    const config = buildRequestConfig(options);

    try {
      // The raw axios instance is used rather than HttpService.post, which
      // returns an Observable: the adapters are the only place that would need
      // rxjs, and keeping it out of them means one less thing to await
      // incorrectly in the workflow above.
      const response = await this.http.axiosRef.post<LoginResponse>(
        '/auth/login',
        { username, password },
        {
          ...config,
          // Login must never be retried: the body carries a password, and a
          // replayed login gives a rate limiter a second chance, not a fix.
          headers: { 'X-Request-Id': requestId, 'Content-Type': 'application/json' },
        },
      );

      const body = response.data;
      if (
        typeof body?.accessToken !== 'string' ||
        typeof body?.expiresIn !== 'number' ||
        body?.tokenType !== 'Bearer'
      ) {
        // A malformed answer from the authority is a deployment fault, not a
        // user error. It is reported as unavailability so the client retries
        // rather than showing the user a broken session.
        throw new DownstreamError(
          'auth-unavailable',
          undefined,
          response.status,
          'The authentication service returned an unexpected response.',
        );
      }

      return {
        accessToken: body.accessToken,
        tokenType: 'Bearer',
        expiresIn: body.expiresIn,
      };
    } catch (error) {
      // Already classified, so it is translated rather than re-inspected.
      const classified =
        error instanceof DownstreamError
          ? error
          : classifyAxiosError(error, 'authentication');

      if (classified.kind === 'unauthorized') {
        // Normalise the wording. auth-service already sends a generic message,
        // and passing it through keeps the two services consistent.
        throw new WorkflowError('unauthorized', 'Invalid username or password.');
      }
      throw new WorkflowError(
        classified.kind === 'downstream-timeout' ? 'downstream-timeout' : 'auth-unavailable',
        classified.message,
        { cause: classified },
      );
    }
  }

  /**
   * Validates a token against auth-service.
   *
   * @throws WorkflowError `unauthorized` when the token is rejected, or
   *   `auth-unavailable` when the authority cannot be consulted
   */
  async validate(token: string, requestId: string): Promise<void> {
    const options = this.config.authService;
    const config = buildRequestConfig(options);

    try {
      const response = await this.http.axiosRef.post<{ active: boolean }>(
        '/auth/validate',
        undefined,
        {
          ...config,
          headers: {
            ...downstreamHeaders(token, requestId),
            'X-Service-Key': options.serviceKey,
          },
        },
      );

      if (response.data?.active !== true) {
        throw new WorkflowError('unauthorized', 'A valid bearer token is required.');
      }
    } catch (error) {
      if (error instanceof WorkflowError) {
        throw error;
      }
      // Already classified, so it is translated rather than re-inspected.
      const classified =
        error instanceof DownstreamError
          ? error
          : classifyAxiosError(error, 'authentication');

      if (classified.kind === 'unauthorized') {
        // 401 here means auth-service rejected *our* service key, which is a
        // deployment fault. Reporting it as "your token is bad" would send every
        // client into a pointless re-login loop.
        this.logger.error('auth-service rejected the service credential');
        throw new WorkflowError(
          'auth-unavailable',
          'The authentication service rejected the orchestrator credential.',
          { cause: classified },
        );
      }

      throw new WorkflowError('auth-unavailable', classified.message, { cause: classified });
    }
  }
}
