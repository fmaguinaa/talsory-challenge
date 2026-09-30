import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Token storage.
 *
 * The rule this file encodes: a bearer token must never sit in `localStorage`.
 * On the web that store is readable by any script on the origin, which turns
 * any XSS into a full account takeover; `localStorage` also survives the tab
 * closing. On native, `expo-secure-store` puts the token in the platform keychain
 * or keystore, where it is encrypted at rest and excluded from backups.
 *
 * On web there is no keychain, so the token is kept in memory for the lifetime
 * of the tab. The trade is deliberate (ADR-007): a reload loses the session and
 * the user logs in again, which is far better than persisting a credential in a
 * place any injected script can read. `sessionStorage` is the one concession,
 * and only where the platform provides it - it is still same-origin readable,
 * but it is at least cleared when the tab closes.
 */

/** Where a token is kept while the app is running. */
export interface TokenStore {
  /** Reads the stored token, or null when there is none. */
  get(): Promise<string | null>;
  /** Persists a token. */
  set(token: string): Promise<void>;
  /** Removes the stored token. */
  clear(): Promise<void>;
}

/**
 * Keychain-backed store for iOS and Android.
 *
 * SecureStore options matter: `keychainAccessible: WHEN_UNLOCKED` means the
 * token is unreadable while the device is locked, and requiring the device to be
 * unlocked for biometric auth stops the app reading it on someone else's lap
 * before the owner has authenticated.
 */
class SecureTokenStore implements TokenStore {
  private static readonly KEY = 'interseguro.accessToken';

  async get(): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(SecureTokenStore.KEY);
    } catch {
      // A corrupt or inaccessible keychain entry must not crash the app; the
      // worst case is one extra login.
      return null;
    }
  }

  async set(token: string): Promise<void> {
    await SecureStore.setItemAsync(SecureTokenStore.KEY, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED,
    });
  }

  async clear(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(SecureTokenStore.KEY);
    } catch {
      // Deleting a token that is not there is not an error worth surfacing.
    }
  }
}

/**
 * In-memory store for web.
 *
 * `sessionStorage` is used when it exists, because surviving a page reload
 * within the same tab is a real usability win and the exposure is no worse than
 * an in-memory variable. `localStorage` is never touched.
 */
class WebTokenStore implements TokenStore {
  private memory: string | null = null;

  /** Whether the tab-scoped store is usable. */
  private get session(): Storage | undefined {
    try {
      return typeof globalThis.sessionStorage === 'undefined' ? undefined : globalThis.sessionStorage;
    } catch {
      // Safari in private mode throws on access rather than returning null.
      return undefined;
    }
  }

  async get(): Promise<string | null> {
    const stored = this.session?.getItem('interseguro.accessToken');
    return stored ?? this.memory;
  }

  async set(token: string): Promise<void> {
    this.memory = token;
    try {
      this.session?.setItem('interseguro.accessToken', token);
    } catch {
      // A full or blocked storage must not prevent the user from staying logged
      // in for this session; the in-memory copy above already covers it.
    }
  }

  async clear(): Promise<void> {
    this.memory = null;
    try {
      this.session?.removeItem('interseguro.accessToken');
    } catch {
      // Nothing to do: the in-memory copy is already cleared.
    }
  }
}

/**
 * Returns the store appropriate to the platform.
 *
 * Exported as a function rather than a constant so the tests can exercise both
 * implementations regardless of the platform they run under.
 */
export function createTokenStore(): TokenStore {
  return Platform.OS === 'web' ? new WebTokenStore() : new SecureTokenStore();
}
