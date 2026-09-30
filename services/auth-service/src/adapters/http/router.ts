import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { Logger } from 'pino';

import type { ServiceCredentials } from '../crypto/ServiceCredentials';
import type { AuthService } from '../../application/AuthService';
import {
  InvalidCredentialsError,
  ServiceAuthenticationError,
  ValidationError,
} from '../../domain/types';
import { buildErrorHandler, HttpProblem, ProblemCategory, sendProblem } from './problem';
import { REQUEST_ID_HEADER, SERVICE_KEY_HEADER, requestIdMiddleware } from './requestContext';

/** Everything the routers need, injected so tests can build them in isolation. */
export interface AuthRouterDeps {
  /** The application service holding the authentication rules. */
  readonly authService: AuthService;
  /** Constant-time comparison of service credentials. */
  readonly serviceCredentials: ServiceCredentials;
  /** Logger for request lines. */
  readonly logger: Logger;
}

/**
 * Reads the correlation id for the current request.
 *
 * The error handler runs for failures raised anywhere in the chain, including
 * before the request-id middleware would have run in an exotic setup, so the
 * lookup is defensive rather than assumed.
 */
function correlationId(res: Response): string {
  return (res.locals.requestId as string | undefined) ?? '';
}

/**
 * Builds the public login router.
 *
 * The rate limiter is per source IP and is the only brute-force defence: an
 * online attack against argon2 is bounded by how fast the endpoint will verify,
 * so the limiter's job is to make the verification rate unaffordable rather than
 * to make guessing impossible.
 */
export function buildAuthRouter({ authService, logger }: AuthRouterDeps, limits: RateLimits): Router {
  const router = Router();

  const loginLimiter = rateLimit({
    windowMs: limits.windowMs,
    limit: limits.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Trusting X-Forwarded-For unconditionally would let a caller spoof the
    // address the limiter keys on and bypass it entirely. The proxy count is
    // configurable so the deployment can state how many hops are in front of it.
    validate: { trustProxy: false, xForwardedForHeader: false },
    handler: (_req: Request, res: Response) => {
      sendProblem(
        res,
        429,
        ProblemCategory.RateLimited,
        'Too many requests',
        'Too many login attempts. Try again later.',
        correlationId(res),
        { 'Retry-After': String(Math.ceil(limits.windowMs / 1000)) },
      );
    },
  });

  router.post('/auth/login', loginLimiter, (req: Request, res: Response, next: NextFunction) => {
    const requestId = correlationId(res);
    const startedAt = process.hrtime.bigint();

    void (async () => {
      try {
        const token = await authService.login(req.body);

        // The response is cached explicitly. A shared cache must never replay
        // one user's token to another, and telling intermediaries not to is one
        // line here versus an incident later.
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.status(200).json({
          accessToken: token.accessToken,
          tokenType: 'Bearer',
          expiresIn: token.expiresIn,
        });
      } catch (error) {
        if (error instanceof InvalidCredentialsError) {
          // One message for an unknown user and for a wrong password. Anything
          // more specific would be a user-enumeration oracle.
          sendProblem(
            res,
            401,
            ProblemCategory.Unauthorized,
            'Unauthorized',
            'Invalid username or password.',
            requestId,
          );
          return;
        }
        if (error instanceof ValidationError) {
          sendProblem(res, 400, ProblemCategory.MalformedRequest, 'Invalid request', error.message, requestId);
          return;
        }
        // Anything else goes to the central handler, which logs it and answers
        // without internals. Re-throwing here would escape the promise chain.
        next(error);
      } finally {
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        // The username and password are deliberately absent from this line:
        // logging credentials is the easiest way to leak them.
        logger.info(
          { requestId, path: req.originalUrl, status: res.statusCode, durationMs: Math.round(elapsedMs) },
          'login attempt completed',
        );
      }
    })();
  });

  return router;
}

/** Rate-limit settings for the login endpoint. */
export interface RateLimits {
  readonly windowMs: number;
  readonly max: number;
}

/**
 * Builds the introspection router.
 *
 * Every route here is service-to-service and is protected by a shared
 * credential. Without it, anyone who obtained a token could ask this endpoint
 * about it, and the endpoint is the only thing that can say whether a token is
 * still valid.
 */
export function buildServiceRouter({ authService, serviceCredentials }: AuthRouterDeps): Router {
  const router = Router();

  const requireServiceKey: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    try {
      authService.authorizeService(req.get(SERVICE_KEY_HEADER), serviceCredentials);
      next();
    } catch (error) {
      if (error instanceof ServiceAuthenticationError) {
        sendProblem(
          res,
          401,
          ProblemCategory.Unauthorized,
          'Unauthorized',
          error.message,
          correlationId(res),
        );
        return;
      }
      next(error);
    }
  };

  router.post('/auth/validate', requireServiceKey, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const token = resolveToken(req);
        const outcome = await authService.introspect(token);

        // A 200 with active:false is the RFC 7662 shape: the request was fine,
        // the token was not. Collapsing that into a 401 would force every
        // backend to treat an expired token as a transport failure.
        res.setHeader('Cache-Control', 'no-store');

        // The claims are flattened into the response rather than nested under a
        // "claims" key. RFC 7662 puts them at the top level, and the backends
        // that consume this endpoint are written against contracts/auth-service.yaml.
        if (outcome.active) {
          res.status(200).json({
            active: true,
            sub: outcome.claims.sub,
            scope: outcome.claims.scope,
            iss: outcome.claims.iss,
            aud: outcome.claims.aud,
            exp: outcome.claims.exp,
            iat: outcome.claims.iat,
          });
          return;
        }
        res.status(200).json({ active: false });
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}

/**
 * Extracts the token to introspect.
 *
 * The Authorization header is preferred; the body is a documented fallback for
 * callers that cannot set headers. Both are accepted because RFC 7662 allows
 * either, and supporting both removes a class of awkward integration.
 */
function resolveToken(req: Request): string {
  const header = req.get('authorization');
  if (header) {
    const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
    if (match?.[1]) return match[1].trim();
  }

  const body = req.body as { token?: unknown } | undefined;
  if (typeof body?.token === 'string' && body.token.trim().length > 0) {
    return body.token.trim();
  }
  return '';
}

/**
 * Builds the public JWKS router.
 *
 * Deliberately unauthenticated: the whole point of publishing the keys is to let
 * a consumer verify tokens without asking this service.
 */
export function buildJwksRouter({ authService }: AuthRouterDeps): Router {
  const router = Router();
  router.get('/.well-known/jwks.json', (_req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        // Public keys, but caching is allowed and encouraged: the key changes
        // only on a rotation, and consumers poll this endpoint.
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.status(200).json(await authService.jwks());
      } catch (error) {
        next(error);
      }
    })();
  });
  return router;
}

/**
 * Builds the health router.
 *
 * Both probes are dependency-free. A slow or absent auth-service cannot make
 * this service report itself unhealthy, because the moment the orchestrator
 * starts pulling this container out of rotation is the moment nobody can log in
 * at all.
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
export interface BuildAppOptions extends AuthRouterDeps {
  /** Largest request body accepted, in bytes. */
  readonly maxBodyBytes: number;
  /** Rate-limit settings for the login endpoint. */
  readonly loginRateLimits: RateLimits;
}

/**
 * Assembles the Express application.
 *
 * Middleware order is deliberate: helmet first so even error responses carry
 * its security headers, then the correlation id so every later stage can log
 * and report it, then the body parser so the size limit is enforced before
 * anything allocates a large buffer.
 */
export function buildApp(options: BuildAppOptions): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(requestIdMiddleware());
  app.use(express.json({ limit: options.maxBodyBytes, strict: true }));

  app.use(buildJwksRouter(options));
  app.use(buildAuthRouter(options, options.loginRateLimits));
  app.use(buildServiceRouter(options));
  app.use(buildHealthRouter());

  app.use((_req: Request, res: Response) => {
    sendProblem(
      res,
      404,
      ProblemCategory.MalformedRequest,
      'Not found',
      'No route matches this method and path.',
      correlationId(res),
    );
  });

  app.use(buildErrorHandler({ logger: options.logger }));

  return app;
}

export { HttpProblem, REQUEST_ID_HEADER };
