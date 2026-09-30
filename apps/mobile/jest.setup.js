/* eslint-env jest */

// expo-router reads the filesystem for its route manifest, which is not what
// these tests are exercising. Mocking it keeps the suite focused on the logic
// under test rather than on the router's bundler assumptions.
jest.mock('expo-router', () => ({
  __esModule: true,
  Redirect: () => null,
  Stack: () => null,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSegments: () => [],
}));

// SecureStore talks to a native module that does not exist under jest. The web
// token store is the subject of its own tests, so a no-op here is enough.
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED: 'whenUnlocked',
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));
