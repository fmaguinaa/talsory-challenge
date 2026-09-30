import type { Response } from 'express';

/** Media type mandated by RFC 9457. */
export const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/** URI prefix under which every problem type lives. */
const TYPE_BASE = 'https://interseguro.local/problems/';

/** Machine-readable problem categories, matching the other services. */
export const ProblemCategory = {
  InvalidMatrix: 'invalid-matrix',
  MalformedRequest: 'malformed-request',
  Unauthorized: 'unauthorized',
  PayloadTooLarge: 'payload-too-large',
  ServiceUnavailable: 'service-unavailable',
  RateLimited: 'rate-limited',
  BadGateway: 'bad-gateway',
  GatewayTimeout: 'gateway-timeout',
  Internal: 'internal-error',
} as const;

/** One of the problem categories. */
export type ProblemCategoryValue = (typeof ProblemCategory)[keyof typeof ProblemCategory];

/** An RFC 9457 problem document plus the correlation id. */
export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  requestId: string;
}

/**
 * Sends a problem document.
 *
 * Every error leaving this service goes through here, so this is the only place
 * that decides what a failure looks like. The contract is that the body never
 * contains a stack trace, an internal host name or a credential.
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
  res.setHeader('Content-Type', PROBLEM_MEDIA_TYPE);
  res.status(status).send(JSON.stringify(body));
}
