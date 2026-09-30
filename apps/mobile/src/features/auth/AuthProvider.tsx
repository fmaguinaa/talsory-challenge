import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { ApiError, login as loginRequest, type LoginResponse } from '../matrix/services/apiClient';
import { createTokenStore, type TokenStore } from './services/tokenStore';

/**
 * Session state.
 *
 * React Context rather than a state library: there is one piece of shared state,
 * it lives for the whole session, and a reducer would be more code than the
 * three transitions it models. The store is injected so tests can substitute an
 * in-memory implementation without touching the keychain.
 */

/** What the login screen and the rest of the app need to know. */
export interface AuthState {
  /** Whether a usable token is held. */
  readonly isAuthenticated: boolean;
  /** Whether the stored token is still being read at startup. */
  readonly isRestoring: boolean;
  /** Seconds until the current token expires, when known. */
  readonly expiresInSeconds: number | null;
  /** Signs in, throwing ApiError on bad credentials or an unreachable API. */
  readonly login: (username: string, password: string) => Promise<void>;
  /** Signs out and clears the stored token. */
  readonly logout: () => Promise<void>;
}

/** Props of the provider, as used by the app root. */
export interface AuthProviderProps {
  readonly children: React.ReactNode;
  /** Overrides the platform token store. Tests pass a plain object. */
  readonly store?: TokenStore;
  /** Injected clock, so expiry tests do not depend on real time. */
  readonly now?: () => number;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

/**
 * Holds the session for the whole app.
 */
export function AuthProvider({
  children,
  store,
  now = () => Date.now(),
}: AuthProviderProps): React.ReactElement {
  const tokenStore = useMemo(() => store ?? createTokenStore(), [store]);

  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  // Until the stored token has been read, the app cannot know whether to show
  // the login screen. Rendering either one first would flash the wrong UI.
  const [isRestoring, setIsRestoring] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const stored = await tokenStore.get();
      if (cancelled) return;
      setToken(stored);
      setIsRestoring(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [tokenStore]);

  const login = useCallback(
    async (username: string, password: string): Promise<void> => {
      const response: LoginResponse = await loginRequest(username, password);
      await tokenStore.set(response.accessToken);
      setToken(response.accessToken);
      setExpiresAt(now() + response.expiresIn * 1000);
    },
    [tokenStore, now],
  );

  const logout = useCallback(async (): Promise<void> => {
    await tokenStore.clear();
    setToken(null);
    setExpiresAt(null);
  }, [tokenStore]);

  const value = useMemo<AuthState>(() => {
    const secondsLeft = expiresAt === null ? null : Math.max(0, Math.round((expiresAt - now()) / 1000));
    return {
      isAuthenticated: token !== null,
      isRestoring,
      expiresInSeconds: secondsLeft,
      login,
      logout,
    };
  }, [token, expiresAt, isRestoring, login, logout, now]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Reads the session.
 *
 * Throws outside a provider, because that is a wiring mistake rather than a
 * runtime condition a screen should have to handle.
 */
export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside an AuthProvider');
  }
  return context;
}

/** Re-exported so screens can render a precise failure without importing twice. */
export { ApiError };
