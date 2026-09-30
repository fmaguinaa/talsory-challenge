import {
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  type ArgumentsHost,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { WorkflowError, type WorkflowErrorKind } from '../matrix/application/AnalyzeWorkflow';
import { ProblemCategory, type ProblemCategoryValue, sendProblem } from './problem';

/** How each workflow failure is rendered. */
interface Mapping {
  readonly status: number;
  readonly category: ProblemCategoryValue;
  readonly title: string;
  readonly headers: Record<string, string>;
}

/**
 * The translation table from a workflow failure to an HTTP response.
 *
 * It lives in one place on purpose. The orchestrator's whole job at the edge is
 * to be predictable about what a client sees, and a mapping spread across a
 * guard, a controller and a filter is a mapping that will drift.
 */
const WORKFLOW_MAPPING: Record<WorkflowErrorKind, Mapping> = {
  'invalid-matrix': {
    status: 422,
    category: ProblemCategory.InvalidMatrix,
    title: 'Invalid matrix',
    headers: {},
  },
  unauthorized: {
    status: 401,
    category: ProblemCategory.Unauthorized,
    title: 'Unauthorized',
    // RFC 6750: tell the client how to authenticate.
    headers: { 'WWW-Authenticate': 'Bearer realm="orchestrator"' },
  },
  'auth-unavailable': {
    status: 503,
    category: ProblemCategory.ServiceUnavailable,
    title: 'Service unavailable',
    // Retry-After keeps a well-behaved client from hammering a dependency that
    // is already in trouble.
    headers: { 'Retry-After': '5' },
  },
  'downstream-failure': {
    status: 502,
    category: ProblemCategory.BadGateway,
    title: 'Bad gateway',
    headers: {},
  },
  'downstream-timeout': {
    status: 504,
    category: ProblemCategory.GatewayTimeout,
    title: 'Gateway timeout',
    headers: {},
  },
};

/** What Nest's `HttpException` already knows about a request error. */
interface HttpExceptionMapping {
  readonly status: number;
  readonly category: ProblemCategoryValue;
  readonly title: string;
}

/**
 * Maps Nest's built-in exceptions, which are what `ValidationPipe` and the
 * throttler raise.
 */
function mapHttpException(status: number): HttpExceptionMapping {
  switch (status) {
    case 400:
      return { status, category: ProblemCategory.MalformedRequest, title: 'Malformed request' };
    case 401:
    case 403:
      return { status, category: ProblemCategory.Unauthorized, title: 'Unauthorized' };
    case 413:
      return { status, category: ProblemCategory.PayloadTooLarge, title: 'Payload too large' };
    case 422:
      return { status, category: ProblemCategory.InvalidMatrix, title: 'Invalid matrix' };
    case 429:
      return { status, category: ProblemCategory.RateLimited, title: 'Too many requests' };
    case 503:
      return { status, category: ProblemCategory.ServiceUnavailable, title: 'Service unavailable' };
    case 504:
      return { status, category: ProblemCategory.GatewayTimeout, title: 'Gateway timeout' };
    default:
      return { status, category: ProblemCategory.Internal, title: 'Internal server error' };
  }
}

/**
 * The global exception filter.
 *
 * Every error that reaches a client passes through here, whatever raised it. The
 * invariant it enforces is that no error body ever contains a stack trace, an
 * internal host name or a credential: anything unrecognised is logged in full
 * and answered with a generic 500.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const requestId = (res.locals.requestId as string | undefined) ?? '';

    if (exception instanceof WorkflowError) {
      const mapping = WORKFLOW_MAPPING[exception.kind];
      // 5xx and 5xx-mapping failures are logged; a 4xx is the caller's problem
      // and logging every bad matrix would drown the real incidents.
      if (mapping.status >= 500) {
        this.logger.error(
          { requestId, kind: exception.kind, path: req.originalUrl, err: exception.cause ?? exception },
          'workflow failed',
        );
      }
      sendProblem(
        res,
        mapping.status,
        mapping.category,
        mapping.title,
        exception.detail,
        requestId,
        mapping.headers,
      );
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const mapping = mapHttpException(status);

      // ValidationPipe produces a list of constraint violations; flattening it
      // into the detail is what makes a 422 actionable for a client.
      const detail = extractHttpExceptionDetail(exception) ?? 'The request could not be processed.';
      sendProblem(res, status, mapping.category, mapping.title, detail, requestId);
      return;
    }

    // Anything else is a bug. The detail goes to the log with the correlation
    // id; the client gets a generic message and nothing more.
    this.logger.error(
      { requestId, path: req.originalUrl, err: exception },
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
  }
}

/**
 * Pulls a usable detail out of an `HttpException`.
 *
 * Nest's validation errors nest their messages in an array of constraint
 * failures; the response body of a validation error is the only place a client
 * can learn which field was wrong.
 */
function extractHttpExceptionDetail(exception: HttpException): string | undefined {
  const response = exception.getResponse();

  if (typeof response === 'string') return response;

  if (typeof response === 'object' && response !== null) {
    const payload = response as { detail?: unknown; message?: unknown };
    if (typeof payload.detail === 'string') return payload.detail;
    if (Array.isArray(payload.message)) {
      return (payload.message as unknown[]).map((entry) => String(entry)).join('; ');
    }
    if (typeof payload.message === 'string') return payload.message;
  }

  return undefined;
}
