/**
 * Runtime configuration.
 *
 * The API URL is resolved at runtime rather than baked in at build time. That
 * matters for the Docker deployment: the same web image is promoted from
 * staging to production, and the URL it should call is decided by an environment
 * variable when the container starts.
 *
 * Resolution order:
 *
 * 1. `EXPO_PUBLIC_API_URL` - inlined by Expo at build time from `.env`. It wins
 *    when present because a build that names its API should not also make a
 *    network call to discover it; that call would add a cold-start round trip
 *    and a failure mode for no benefit.
 * 2. `/config.json` - served by the container's nginx, generated at startup.
 *    This is what makes the web image environment-agnostic: the container build
 *    sets no `EXPO_PUBLIC_API_URL`, so the image can be promoted between
 *    environments and still find the right orchestrator.
 * 3. A platform default, so a fresh checkout still runs.
 */

/** The shape of the file the container writes at startup. */
export interface RuntimeConfig {
  /** Base URL of the orchestrator, e.g. `http://localhost:3000`. */
  readonly apiUrl: string;
}

/** Fallback used when nothing else is configured. */
const DEFAULT_API_URL = 'http://localhost:3000';

/**
 * The compile-time value, present only when EXPO_PUBLIC_API_URL was set.
 *
 * Read lazily rather than captured at module load. Expo's Babel transform
 * replaces `process.env.EXPO_PUBLIC_*` with a literal wherever it appears,
 * including inside a function, so the production behaviour is identical; and
 * reading it lazily is what lets a test change it between cases.
 */
function buildTimeUrl(): string | undefined {
  const value = process.env.EXPO_PUBLIC_API_URL;
  return value === undefined || value === '' ? undefined : value;
}

/** How long to wait for /config.json before giving up and using the default. */
const CONFIG_FETCH_TIMEOUT_MS = 3000;

/**
 * Cached promise.
 *
 * The config is read on the first render and then reused: fetching it per render
 * would mean a network round trip per keystroke.
 */
let cached: Promise<string> | undefined;

/**
 * Reads a value out of a JSON document, tolerating its absence.
 */
function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

/**
 * Fetches the runtime configuration document.
 *
 * A failure is not fatal: the app falls back to the build-time value or the
 * default. Refusing to start because a config file is missing would be worse
 * than starting against the documented default.
 */
async function loadRuntimeConfig(): Promise<string | undefined> {
  if (typeof fetch !== 'function') return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch('/config.json', {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    return readString(await response.json(), 'apiUrl');
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves the orchestrator base URL, without a trailing slash.
 *
 * The trailing slash is stripped here rather than at every call site, because
 * `${base}/api/v1/...` with a double slash produces a 404 on some proxies and a
 * redirect on others.
 */
export async function resolveApiUrl(): Promise<string> {
  if (!cached) {
    cached = (async () => {
      const chosen = buildTimeUrl() ?? (await loadRuntimeConfig()) ?? DEFAULT_API_URL;
      return chosen.replace(/\/+$/, '');
    })();
  }
  return cached;
}

/**
 * Resets the cached value.
 *
 * Exposed for the tests, and for a future "change environment" screen: without
 * it there is no way to re-resolve once the module has been loaded.
 */
export function resetApiUrlCache(): void {
  cached = undefined;
}
