import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Header carrying the correlation id across all services. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Reports whether an inbound correlation id is safe to reuse.
 *
 * The value reaches logs and response bodies, so allowing arbitrary bytes would
 * let a caller inject newlines and forge log entries. The character set is
 * restricted to what a UUID or a trace id actually needs.
 */
function isSafeRequestId(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  return /^[A-Za-z0-9._-]+$/.test(value);
}

/**
 * Ensures every request carries a correlation id.
 *
 * An inbound id is honoured so a trace started upstream survives into qr-api
 * and stats-api; otherwise one is minted here. It is stored on `res.locals` so
 * both the controller and the exception filter can reach it.
 */
export const requestIdMiddleware: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const inbound = (req.get(REQUEST_ID_HEADER) ?? '').trim();
  const requestId = isSafeRequestId(inbound) ? inbound : randomUUID();

  res.locals.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
};

/**
 * Extracts the bearer token from the Authorization header.
 *
 * Returns `''` when the header is absent or not a Bearer credential. A
 * malformed header is not passed through: forwarding the raw string would turn
 * a clear "missing credentials" into a confusing downstream failure.
 */
export function extractBearerToken(header: string | undefined): string {
  if (!header) return '';
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
}
