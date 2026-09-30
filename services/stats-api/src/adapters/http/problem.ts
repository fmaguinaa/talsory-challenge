import type { Request, Response } from 'express';
import type { Logger } from 'pino';

/**
 * Media type mandated by RFC 9457 for problem documents.
 */
export const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/** URI prefix under which every problem type lives. */
const TYPE_BASE = 'https://interseguro.local/problems/';

/**
 * Machine-readable categories. These strings are part of the API contract: a
 * client may switch on them, so changing one is a breaking change.
 */
export const ProblemCategory = {
  InvalidMatrix: 'invalid-matrix',
  MalformedRequest: 'malformed-request',
  Unauthorized: 'unauthorized',
  PayloadTooLarge: 'payload-too-large',
  ServiceUnavailable: 'service-unavailable',
  Internal: 'internal-error',
} as const;

/** One of the problem categories. */
export type ProblemCategoryValue = (typeof ProblemCategory)[keyof typeof ProblemCategory];

/** An RFC 9457 problem document plus the correlation id. */
export interface ProblemDetail {
  /** URI identifying the problem category. */
  type: string;
  /** Short, human-readable summary of the category. */
  title: string;
  /** HTTP status, duplicated in the body so a body-only client still sees it. */
  status: number;
  /** What specifically went wrong. Never contains internals or stack traces. */
  detail: string;
  /** Path of the request that produced the error. */
  instance: string;
  /** Correlation id, present in the service logs. */
  requestId: string;
}

/**
 * Sends a problem document as the response.
 *
 * @param res the Express response
 * @param status the HTTP status to send
 * @param category the machine-readable category
 * @param title a short summary
 * @param detail the specific explanation, safe to show a user
 * @param requestId the correlation id
 * @param headers extra response headers, e.g. `Retry-After`
 */
export function sendProblem(
  res: Response,
  status: number,
  category: ProblemCategoryValue,
  title: string,
  detail: string,
  requestId: string,
  headers: Record<string, string> = {},
): void {
  const body: ProblemDetail = {
    type: `${TYPE_BASE}${category}`,
    title,
    status,
    detail,
    instance: res.req.originalUrl,
    requestId,
  };

  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  // res.type() would append a charset and Express would still label the body
  // application/json, so the header is set verbatim.
  res.setHeader('Content-Type', PROBLEM_MEDIA_TYPE);
  res.status(status).send(JSON.stringify(body));
}

/** Options accepted by the error handler middleware. */
export interface ErrorHandlerOptions {
  /** Logger receiving internal diagnostics. */
  readonly logger: Logger;
}

/**
 * Builds the central Express error handler.
 *
 * Every error that reaches the client passes through here, so this is the only
 * place that decides what a failure looks like. The contract is that an error
 * response never contains a stack trace, an internal host name or a secret:
 * anything unrecognised becomes a flat 500 with the detail logged, not sent.
 */
export function buildErrorHandler({ logger }: ErrorHandlerOptions) {
  // Express identifies an error handler by its four-parameter signature; `next`
  // is required by the framework and unused by this implementation.
  return (error: unknown, req: Request, res: Response, next: (err?: unknown) => void): void => {
    void next;
    const requestId = res.locals.requestId as string | undefined ?? '';

    // A body-parser failure is the most common error by far, and its shape is
    // stable, so it is translated here rather than in each route.
    if (isBodyParserError(error)) {
      sendProblem(
        res,
        error.status ?? 400,
        error.status === 413 ? ProblemCategory.PayloadTooLarge : ProblemCategory.MalformedRequest,
        error.status === 413 ? 'Payload too large' : 'Malformed request body',
        error.status === 413
          ? 'The request body exceeds the maximum accepted size.'
          : 'The request body could not be parsed as JSON.',
        requestId,
      );
      return;
    }

    if (isHttpProblem(error)) {
      sendProblem(res, error.status, error.category, error.title, error.detail, requestId, error.headers);
      return;
    }

    // Anything else is a bug. The detail goes to the log with the correlation
    // id; the client gets a generic message and nothing more.
    logger.error(
      { err: error, requestId, path: req.originalUrl },
      'unhandled error while serving the request',
    );
    sendProblem(
      res,
      500,
      ProblemCategory.Internal,
      'Internal server error',
      'The service failed to handle the request.',
      requestId,
    );
  };
}

/**
 * An application-level error that already knows how it should be rendered.
 *
 * Routes throw these so that the mapping from cause to status code stays with
 * the code that understands the cause, instead of a switch statement in the
 * error handler that has to know about every error type in the system.
 */
export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly category: ProblemCategoryValue,
    readonly title: string,
    readonly detail: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(detail);
    this.name = 'HttpProblem';
  }
}

/** Narrows an unknown error to an {@link HttpProblem}. */
function isHttpProblem(error: unknown): error is HttpProblem {
  return error instanceof HttpProblem;
}

/** The subset of body-parser errors this service cares about. */
interface BodyParserError {
  status?: number;
  type?: string;
}

/** Narrows an unknown error to a body-parser failure. */
function isBodyParserError(error: unknown): error is BodyParserError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as BodyParserError;
  if (candidate.type !== 'entity.parse.failed' && candidate.type !== 'entity.too.large') {
    return false;
  }
  return typeof candidate.status === 'number';
}
