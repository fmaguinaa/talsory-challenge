import type { HttpService } from '@nestjs/axios';
import { AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios';

import { WorkflowError, type WorkflowErrorKind } from '../matrix/application/AnalyzeWorkflow';

/** Connection settings shared by every downstream call. */
export interface DownstreamOptions {
  /** Base URL of the downstream service. */
  readonly baseUrl: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Extra attempts for idempotent failures. Zero disables retrying. */
  readonly retries: number;
  /** Delay before the first retry, doubled on each subsequent one. */
  readonly retryBackoffMs: number;
}

/**
 * A failure from a downstream call, already classified.
 *
 * Classification happens once, here, so that no caller has to know that axios
 * calls a timeout `ECONNABORTED` while a refused connection is `ECONNREFUSED`.
 */
export class DownstreamError extends Error {
  constructor(
    readonly kind: WorkflowErrorKind,
    /** The problem+json detail from the downstream service, when it sent one. */
    readonly problemDetail: string | undefined,
    /** The downstream HTTP status, when there was a response. */
    readonly status: number | undefined,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DownstreamError';
  }
}

/**
 * Applies the settings every downstream call shares: the base URL, the
 * timeout, and a bounded retry policy.
 *
 * Retries are deliberately narrow. Only network errors and 5xx responses are
 * retried, because those are the cases where the request provably did not take
 * effect: a 4xx means the service understood the request and refused it, and
 * repeating it would only multiply the load during an incident. The backoff
 * doubles each attempt so a struggling dependency is not hammered.
 *
 * @returns a request configuration to spread into one axios call
 */
export function buildRequestConfig(options: DownstreamOptions): AxiosRequestConfig {
  return {
    baseURL: options.baseUrl,
    timeout: options.timeoutMs,
  };
}

/** How long to wait before the given attempt (0-based). */
export function backoffFor(attempt: number, baseMs: number): number {
  return baseMs * 2 ** attempt;
}

/**
 * Classifies an axios failure into a {@link DownstreamError}.
 *
 * The mapping encodes the policy the orchestrator promises its callers:
 *
 * - 401 from a downstream means the *caller's* token was rejected there, so
 *   the client is told to authenticate again.
 * - 503 from auth-service is surfaced distinctly, because "we could not check
 *   your token" must never be reported as "your token is bad".
 * - 4xx validation failures keep the downstream's own wording, so the user sees
 *   "row 2 has length 2, expected 3" rather than a generic message.
 * - Everything else is a downstream failure or a timeout.
 */
export function classifyAxiosError(error: unknown, serviceName: string): DownstreamError {
  if (!(error instanceof AxiosError)) {
    return new DownstreamError(
      'downstream-failure',
      undefined,
      undefined,
      `The ${serviceName} service could not be reached.`,
      { cause: error },
    );
  }

  const { response, code } = error;

  if (response) {
    const problem = extractProblemDetail(response.data);

    if (response.status === 401 || response.status === 403) {
      return new DownstreamError(
        'unauthorized',
        problem,
        401,
        'A valid bearer token is required.',
        { cause: error },
      );
    }

    // A downstream reporting 503 means it could not reach one of its own
    // dependencies. Passing that through keeps the diagnosis accurate rather
    // than flattening everything into 502.
    if (response.status === 503) {
      return new DownstreamError(
        'auth-unavailable',
        problem,
        503,
        `The ${serviceName} service could not reach the authentication service.`,
        { cause: error },
      );
    }

    if (response.status === 422 || response.status === 400) {
      return new DownstreamError(
        'invalid-matrix',
        problem ?? 'The matrix was rejected by the downstream service.',
        response.status,
        problem ?? 'The matrix was rejected by the downstream service.',
        { cause: error },
      );
    }

    if (response.status === 504 || code === 'ECONNABORTED') {
      return new DownstreamError(
        'downstream-timeout',
        problem,
        response.status,
        `The ${serviceName} service did not respond in time.`,
        { cause: error },
      );
    }

    return new DownstreamError(
      'downstream-failure',
      problem,
      response.status,
      `The ${serviceName} service returned an error.`,
      { cause: error },
    );
  }

  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    return new DownstreamError(
      'downstream-timeout',
      undefined,
      undefined,
      `The ${serviceName} service did not respond in time.`,
      { cause: error },
    );
  }

  // No response at all: DNS failure, refused connection, TLS problem. The
  // internal message is deliberately dropped; a client has no use for "connect
  // ECONNREFUSED 10.0.0.4:4000".
  return new DownstreamError(
    'downstream-failure',
    undefined,
    undefined,
    `The ${serviceName} service could not be reached.`,
    { cause: error },
  );
}

/**
 * Pulls the human-readable detail out of an RFC 9457 problem document.
 *
 * Returns undefined for anything that is not a problem document, which is the
 * signal to fall back to a generic message rather than echo an HTML error page
 * or a stack trace back to the client.
 */
export function extractProblemDetail(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;

  const candidate = data as { detail?: unknown; message?: unknown };
  if (typeof candidate.detail === 'string' && candidate.detail.length > 0) {
    return candidate.detail;
  }
  if (typeof candidate.message === 'string' && candidate.message.length > 0) {
    return candidate.message;
  }
  return undefined;
}

/**
 * Performs an idempotent call with bounded retries and exponential backoff.
 *
 * @param http the axios service to call
 * @param config request configuration from {@link buildRequestConfig}
 * @param execute the actual request, so the retry loop wraps the call
 * @param options retry policy
 * @param serviceName used in error messages
 * @throws DownstreamError when every attempt fails
 */
export async function callWithRetry<T>(
  http: HttpService,
  config: AxiosRequestConfig,
  execute: (instance: AxiosInstance) => Promise<T>,
  options: DownstreamOptions,
  serviceName: string,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      return await execute(http.axiosRef);
    } catch (error) {
      lastError = error;

      if (!isRetryable(error) || attempt === options.retries) {
        throw classifyAxiosError(error, serviceName);
      }

      await sleep(backoffFor(attempt, options.retryBackoffMs));
    }
  }

  // Unreachable: the loop either returns or throws. The throw is here so the
  // function is total rather than relying on the loop shape to satisfy the
  // compiler.
  throw classifyAxiosError(lastError, serviceName);
}

/**
 * Converts a downstream failure into a {@link WorkflowError}.
 *
 * An already-classified {@link DownstreamError} is passed straight through.
 * That distinction matters: `callWithRetry` classifies before throwing, so
 * re-classifying a `DownstreamError` here would treat it as an opaque non-axios
 * error and flatten a precise timeout into a generic failure.
 */
export function toWorkflowError(error: unknown, serviceName: string): WorkflowError {
  if (error instanceof DownstreamError) {
    return new WorkflowError(error.kind, error.problemDetail ?? error.message, { cause: error });
  }
  const classified = classifyAxiosError(error, serviceName);
  return new WorkflowError(classified.kind, classified.problemDetail ?? classified.message, {
    cause: classified,
  });
}

/**
 * Reports whether a failure is worth retrying.
 *
 * Only "the service did not answer or could not answer" qualifies. A 4xx means
 * the service understood the request and refused it, and retrying it would
 * neither help nor heal.
 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof AxiosError)) return false;
  if (error.response) {
    const status = error.response.status;
    return status >= 500 && status !== 501;
  }
  // No response at all: a transport failure. Timeouts are included, because a
  // request that timed out provably had no effect on the service, so replaying
  // it cannot duplicate anything.
  return true;
}

/** Waits for the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Builds the headers every downstream request carries.
 *
 * @param token the caller's bearer token, forwarded verbatim so each service
 *   authorizes independently (ADR-005)
 * @param requestId the correlation id
 */
export function downstreamHeaders(
  token: string,
  requestId: string,
): Record<string, string> {
  return {
    // The original token travels downstream rather than a service-scoped one:
    // every service must be able to reject a caller's revoked token without
    // asking the orchestrator whether it is still valid.
    Authorization: `Bearer ${token}`,
    'X-Request-Id': requestId,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}
