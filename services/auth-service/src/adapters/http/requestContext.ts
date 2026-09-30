import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Header carrying the correlation id across all services. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Header carrying the shared credential a backend presents to introspect. */
export const SERVICE_KEY_HEADER = 'X-Service-Key';

/**
 * Returns whether an inbound correlation id is safe to reuse verbatim.
 *
 * The value ends up in logs and in response bodies. Allowing arbitrary bytes
 * through would let a caller inject newlines and forge log entries, so the
 * character set is restricted to what a UUID or a trace id actually needs.
 */
function isSafeRequestId(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  return /^[A-Za-z0-9._-]+$/.test(value);
}

/**
 * Middleware guaranteeing every request has a correlation id.
 *
 * An inbound id is honoured so a trace started by the orchestrator survives
 * across all four services; otherwise one is minted here. The id is stored on
 * `res.locals` for the error handler and echoed on the response.
 */
export function requestIdMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const inbound = (req.get(REQUEST_ID_HEADER) ?? '').trim();
    const requestId = isSafeRequestId(inbound) ? inbound : randomUUID();

    res.locals.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  };
}

/**
 * Extracts the bearer token from the Authorization header.
 *
 * Returns `''` when the header is absent or does not use the Bearer scheme.
 * A malformed header is deliberately not passed through: forwarding the raw
 * string would turn a clear "missing credentials" into a confusing
 * introspection failure inside auth-service.
 */
export function extractBearerToken(header: string | undefined): string {
  if (!header) return '';
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
}
