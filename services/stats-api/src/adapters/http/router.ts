import express, { type Express, type NextFunction, type Request, type Response, Router } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';

import {
  AuthUnavailableError,
  UnauthorizedError,
  type ComputeStatsUseCase,
} from '../../application/ComputeStatsUseCase';
import { PayloadTooLargeError, ValidationError } from '../../application/computeStats';
import type { StatsLimits } from '../../application/computeStats';
import { buildErrorHandler, HttpProblem, ProblemCategory, sendProblem } from './problem';
import { extractBearerToken, requestIdMiddleware } from './requestContext';

/**
 * Shape returned to the client.
 *
 * The internal `count` field is dropped here rather than in the domain: the
 * domain has no opinion about the wire format, and this is the only place that
 * knows contracts/stats-api.yaml is what clients see.
 */
interface StatsResponseBody {
  global: {
    max: number;
    min: number;
    average: number;
    sum: number;
    anyDiagonal: boolean;
  };
  perMatrix: Array<{
    id: string;
    max: number;
    min: number;
    average: number;
    sum: number;
    isDiagonal: boolean;
  }>;
}

/** Everything the router needs, injected so tests can build it in isolation. */
export interface StatsRouterDeps {
  /** The application use case. */
  readonly useCase: ComputeStatsUseCase;
  /** Logger for request lines. */
  readonly logger: Logger;
}

/**
 * Builds the statistics router.
 *
 * The route is deliberately thin: extract the token, hand the body to the use
 * case, translate the outcome. All rules live in the application layer, which
 * is why this file has no numbers in it.
 */
export function buildStatsRouter({ useCase, logger }: StatsRouterDeps): Router {
  const router = Router();

  router.post('/api/v1/stats', (req: Request, res: Response, next: NextFunction) => {
    const requestId = res.locals.requestId as string | undefined ?? '';
    const startedAt = process.hrtime.bigint();

    void (async () => {
      try {
        const result = await useCase.execute(extractBearerToken(req.get('authorization')), req.body);

        const body: StatsResponseBody = {
          global: {
            max: result.global.max,
            min: result.global.min,
            average: result.global.average,
            sum: result.global.sum,
            anyDiagonal: result.global.anyDiagonal,
          },
          perMatrix: result.perMatrix.map((entry) => ({
            id: entry.id,
            max: entry.max,
            min: entry.min,
            average: entry.average,
            sum: entry.sum,
            isDiagonal: entry.isDiagonal,
          })),
        };

        res.status(200).json(body);
      } catch (error) {
        sendTranslatedError(res, error, requestId, next);
      } finally {
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        logger.info(
          {
            requestId,
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            durationMs: Math.round(elapsedMs * 100) / 100,
          },
          'request completed',
        );
      }
    })();
  });

  return router;
}

/**
 * Maps a use case failure onto its HTTP representation.
 *
 * Keeping this next to the route, rather than in the global error handler, means
 * the translation table for this endpoint is readable in one place. Anything
 * that is not recognised is handed to `next`, which routes it to the global
 * error handler: that handler logs the detail and answers with a generic
 * message. Rethrowing here instead would escape the promise chain and become an
 * unhandled rejection, leaving the request hanging until the client timed out.
 */
function sendTranslatedError(
  res: Response,
  error: unknown,
  requestId: string,
  next: NextFunction,
): void {
  if (error instanceof UnauthorizedError) {
    sendProblem(
      res,
      401,
      ProblemCategory.Unauthorized,
      'Unauthorized',
      error.message,
      requestId,
      // RFC 6750: tell the client how to authenticate.
      { 'WWW-Authenticate': 'Bearer realm="stats-api"' },
    );
    return;
  }

  if (error instanceof AuthUnavailableError) {
    sendProblem(
      res,
      503,
      ProblemCategory.ServiceUnavailable,
      'Service unavailable',
      error.message,
      requestId,
      // Retry-After keeps a well-behaved client from hammering a dependency
      // that is already in trouble.
      { 'Retry-After': '5' },
    );
    return;
  }

  if (error instanceof PayloadTooLargeError) {
    sendProblem(res, 413, ProblemCategory.PayloadTooLarge, 'Payload too large', error.reason, requestId);
    return;
  }

  if (error instanceof ValidationError) {
    sendProblem(res, 422, ProblemCategory.InvalidMatrix, 'Invalid matrix', error.reason, requestId);
    return;
  }

  if (error instanceof HttpProblem) {
    sendProblem(res, error.status, error.category, error.title, error.detail, requestId, error.headers);
    return;
  }

  // Unknown: the global handler logs the detail and answers generically.
  next(error);
}

/**
 * Builds the health router.
 *
 * Both probes are public and dependency-free by design. Liveness answers "is
 * this process able to serve?" and readiness answers "should traffic be sent
 * here?"; neither may consult auth-service, because that would let a slow
 * authority restart a perfectly healthy service and turn a degradation into an
 * outage. The service holds no local state, so being able to answer these
 * questions at all is the readiness condition.
 */
export function buildHealthRouter(): Router {
  const router = Router();
  const ok = (_req: Request, res: Response): void => {
    res.status(200).json({ status: 'ok' });
  };
  router.get('/health/live', ok);
  router.get('/health/ready', ok);
  return router;
}

/** Options for {@link buildApp}. */
export interface BuildAppOptions extends StatsRouterDeps {
  /** Largest request body accepted, in bytes. */
  readonly maxBodyBytes: number;
  /** Bounds applied by the use case, restated here for documentation. */
  readonly limits: StatsLimits;
}

/**
 * Assembles the Express application.
 *
 * Middleware order is deliberate, outermost first:
 *
 * - `helmet` sets security headers on every response, including errors.
 * - the request id middleware guarantees `res.locals.requestId` exists for
 *   every later stage, including the error handler.
 * - the body parser enforces the size limit and is the only component that
 *   reads the request body.
 * - the routers, then the error handler as the outermost safety net.
 */
export function buildApp(options: BuildAppOptions): Express {
  const app = express();

  // Advertising the framework is free reconnaissance, so it is turned off.
  app.disable('x-powered-by');

  // helmet sets security headers on every response, including error responses,
  // which is why it runs before anything that might short-circuit the chain.
  app.use(helmet());

  // Guarantees res.locals.requestId exists for every later stage, including the
  // error handler, which would otherwise have to cope with an empty id.
  app.use(requestIdMiddleware());

  // The only component that reads the body. `limit` is what turns an oversized
  // payload into a 413 instead of an out-of-memory crash.
  app.use(express.json({ limit: options.maxBodyBytes, strict: true }));

  app.use(buildHealthRouter());
  app.use(buildStatsRouter(options));

  // Catch-all for unmatched routes. Registered before the error handler because
  // the error handler's four-parameter signature makes Express treat it as an
  // error handler, not as ordinary middleware.
  app.use((_req: Request, res: Response) => {
    sendProblem(
      res,
      404,
      ProblemCategory.MalformedRequest,
      'Not found',
      'No route matches this method and path.',
      (res.locals.requestId as string | undefined) ?? '',
    );
  });

  app.use(buildErrorHandler({ logger: options.logger }));

  return app;
}
