import { resolveApiUrl } from '../../../config/runtimeConfig';

/**
 * Typed client for the orchestrator.
 *
 * The app talks to exactly one backend (ADR-002), and this file is the only
 * place that knows it. The types below mirror `contracts/orchestrator.yaml`;
 * nothing else in the app constructs a URL or interprets an error body.
 */

/** A rectangular matrix of finite numbers. */
export type Matrix = number[][];

/** Statistics over one matrix. */
export interface MatrixStats {
  id: string;
  max: number;
  min: number;
  average: number;
  sum: number;
  isDiagonal: boolean;
}

/** Statistics across every matrix. */
export interface GlobalStats {
  max: number;
  min: number;
  average: number;
  sum: number;
  anyDiagonal: boolean;
}

/** The aggregated response of the analysis endpoint. */
export interface AnalyzeResponse {
  requestId: string;
  input: { rows: number; cols: number };
  qr: { q: Matrix; r: Matrix };
  stats: { global: GlobalStats; perMatrix: MatrixStats[] };
}

/** The token response of the login endpoint. */
export interface LoginResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

/**
 * Why a request failed, in terms the UI can act on.
 *
 * The distinction the UI cares about most is `unauthenticated`: the token is
 * gone or expired, and the only correct response is to log in again. Everything
 * else is transient or user-fixable, and each carries a message written for a
 * human rather than a status code.
 */
export type ApiErrorKind =
  | 'unauthenticated'
  | 'invalid-matrix'
  | 'rate-limited'
  | 'service-unavailable'
  | 'network'
  | 'unexpected';

/** A failure, already translated for display. */
export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    /** The server's own explanation, when it sent one. */
    readonly detail?: string,
    /** The correlation id, shown in the UI so a report can be traced. */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Whether the user must log in again. */
  get requiresLogin(): boolean {
    return this.kind === 'unauthenticated';
  }
}

/** Options accepted by every call. */
export interface CallOptions {
  /** Bearer token; omitted for login. */
  token?: string;
  /** Aborts the request when it is no longer needed. */
  signal?: AbortSignal;
}

/** How long a request may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 20000;

/**
 * Performs a JSON request against the orchestrator.
 *
 * Every failure path -- transport, timeout, HTTP status, unparseable body --
 * funnels into an {@link ApiError}, so a caller never has to catch something
 * that is not one of those.
 */
async function request<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  options: CallOptions = {},
): Promise<T> {
  const baseUrl = await resolveApiUrl();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // A caller-driven abort must also cancel the timeout, otherwise a request the
  // user navigated away from would keep a timer alive.
  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
  } catch {
    // A DNS failure, a refused connection, a CORS rejection and a timeout all
    // land here. None of them is the user's fault, so the message says so
    // rather than blaming the input -- and the original error is dropped,
    // because "TypeError: Network request failed" helps nobody reading a phone.
    const aborted = controller.signal.aborted;
    throw new ApiError(
      'network',
      aborted
        ? 'The request timed out. Check that the API is reachable and try again.'
        : 'Could not reach the API. Check your connection and try again.',
      undefined,
      undefined,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }

  const requestId = response.headers.get('X-Request-Id') ?? undefined;

  // 401 is the one status that changes what the app does next: the session is
  // over, so the caller logs out and returns to the login screen.
  if (response.status === 401) {
    throw new ApiError(
      'unauthenticated',
      'Your session has expired. Please sign in again.',
      await readDetail(response),
      requestId,
    );
  }

  if (response.status === 429) {
    throw new ApiError(
      'rate-limited',
      'Too many requests. Please wait a moment and try again.',
      await readDetail(response),
      requestId,
    );
  }

  if (response.status === 422 || response.status === 400) {
    // The server explains precisely what is wrong with the matrix, and that
    // explanation is far more useful than a generic "invalid input".
    throw new ApiError(
      'invalid-matrix',
      'The matrix was rejected.',
      await readDetail(response),
      requestId,
    );
  }

  if (response.status === 503) {
    throw new ApiError(
      'service-unavailable',
      'The service is temporarily unavailable. Please try again shortly.',
      await readDetail(response),
      requestId,
    );
  }

  if (!response.ok) {
    throw new ApiError(
      'unexpected',
      `The request failed with status ${response.status}.`,
      await readDetail(response),
      requestId,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(
      'unexpected',
      'The server sent a response the app could not read.',
      undefined,
      requestId,
    );
  }
}

/**
 * Extracts the `detail` field from an RFC 9457 problem document.
 *
 * Returns undefined for anything that is not one, so a proxy's HTML error page
 * is never shown to a user as if it were the server's explanation.
 */
async function readDetail(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (text.length === 0) return undefined;

    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;

    const detail = (parsed as { detail?: unknown }).detail;
    return typeof detail === 'string' && detail.length > 0 ? detail : undefined;
  } catch {
    return undefined;
  }
}

/** Exchanges credentials for a token. */
export async function login(
  username: string,
  password: string,
  options: CallOptions = {},
): Promise<LoginResponse> {
  return request<LoginResponse>(
    '/auth/login',
    { method: 'POST', body: { username, password } },
    options,
  );
}

/** Factorizes a matrix and returns its statistics. */
export async function analyze(
  matrix: Matrix,
  options: CallOptions = {},
): Promise<AnalyzeResponse> {
  return request<AnalyzeResponse>(
    '/api/v1/matrix/analyze',
    { method: 'POST', body: { matrix } },
    options,
  );
}

/** Reads the service's readiness. */
export async function health(options: CallOptions = {}): Promise<{ status: string }> {
  return request<{ status: string }>('/health/ready', { method: 'GET' }, options);
}
