import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import AnalyzeScreen from '../AnalyzeScreen';
import { AuthProvider } from '../../../auth/AuthProvider';
import { resetApiUrlCache } from '../../../../config/runtimeConfig';
import type { TokenStore } from '../../../auth/services/tokenStore';

/**
 * Analyze screen tests: the authentication wiring.
 *
 * The client takes the token as an explicit argument, so a screen that forgets
 * to pass it produces a request with no `Authorization` header and the
 * orchestrator answers 401. Nothing else in the suite would notice, because the
 * client behaves exactly as specified when given a token -- so the guarantee
 * worth protecting is that the session token reaches the request.
 */

/** A store that already holds a token, standing in for a completed login. */
function storeWith(token: string | null): TokenStore {
  return {
    get: jest.fn().mockResolvedValue(token),
    set: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
  };
}

/**
 * Renders the screen and waits for the provider to finish restoring the session.
 *
 * The wait matters: the provider starts with no token and reads the store in an
 * effect, so a screen pressed before that resolves would send the request it has
 * a header for.
 */
async function renderScreen(store: TokenStore) {
  const view = render(
    <AuthProvider store={store}>
      <AnalyzeScreen />
    </AuthProvider>,
  );
  await waitFor(() => expect(store.get).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

/** The init of the last API request, ignoring the config lookup. */
function lastApiCall(fetchMock: jest.Mock): [string, RequestInit] {
  const calls = fetchMock.mock.calls.filter((call: unknown[]) => !String(call[0]).endsWith('/config.json'));
  const last = calls[calls.length - 1] as [string, RequestInit] | undefined;
  if (!last) throw new Error('no API call was made');
  return last;
}

/** Installs a fetch double that always answers 200. */
function mockFetch(): jest.Mock {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      requestId: 'req-1',
      input: { rows: 3, cols: 3 },
      qr: { q: [[1]], r: [[1]] },
      stats: {
        global: { max: 1, min: 1, average: 1, sum: 1, anyDiagonal: false },
        perMatrix: [],
      },
    }),
  })) as unknown as jest.Mock;
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** Presses "Load example" and then "Analyze". */
function analyzeExample(): void {
  fireEvent.press(screen.getByText('Load example'));
  fireEvent.press(screen.getByText('Analyze'));
}

beforeEach(() => {
  resetApiUrlCache();
  process.env.EXPO_PUBLIC_API_URL = 'http://api.test:3000';
  resetApiUrlCache();
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_API_URL;
  jest.restoreAllMocks();
});

describe('AnalyzeScreen', () => {
  it('authorises the analyze request with the session token', async () => {
    const fetchMock = mockFetch();
    await renderScreen(storeWith('token-abc'));

    analyzeExample();

    await waitFor(() => expect(screen.getByText('Result')).toBeTruthy());
    // Without this header the orchestrator answers 401 and the user is bounced
    // back to the login screen with no explanation.
    expect(lastApiCall(fetchMock)[1].headers).toMatchObject({ Authorization: 'Bearer token-abc' });
  });

  it('signs the user out when the token is rejected', async () => {
    const store = storeWith('stale-token');
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).endsWith('/config.json')) {
        return { ok: false, status: 404, headers: new Headers() };
      }
      return {
        ok: false,
        status: 401,
        headers: new Headers(),
        text: async () => JSON.stringify({ detail: 'A valid bearer token is required.' }),
      };
    }) as unknown as typeof fetch;

    await renderScreen(store);
    analyzeExample();

    await waitFor(() => expect(store.clear).toHaveBeenCalled());
  });

  it('does not send a request while signed out', async () => {
    const fetchMock = mockFetch();
    await renderScreen(storeWith(null));

    analyzeExample();

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter((call: unknown[]) => !String(call[0]).endsWith('/config.json')),
      ).toHaveLength(0),
    );
  });
});