import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  storage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    getSessionFromKeychain: vi.fn(),
    saveSessionToKeychain: vi.fn(),
    clearSessionFromKeychain: vi.fn(),
  },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

vi.mock('../../../../src/host/services/core', () => ({
  getSecureStorage: () => mocks.storage,
}));

describe('Supabase auth storage Keychain retention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockReturnValue({});
  });

  it('keeps Keychain session when supabase-js removes an expired refresh session', async () => {
    const { initSupabase } = await import('../../../../src/host/services/infra/supabaseService');
    initSupabase('https://example.supabase.co', 'anon-key');

    const options = mocks.createClient.mock.calls[0]?.[2] as {
      auth: {
        storage: {
          setItem(key: string, value: string): Promise<void>;
          removeItem(key: string): Promise<void>;
        };
      };
    };
    const sessionKey = 'sb-example-auth-token';

    await options.auth.storage.setItem(sessionKey, 'rotated-session');
    await options.auth.storage.removeItem(sessionKey);

    expect(mocks.storage.removeItem).toHaveBeenCalledWith(sessionKey);
    expect(mocks.storage.saveSessionToKeychain).toHaveBeenCalledWith('rotated-session');
    expect(mocks.storage.clearSessionFromKeychain).not.toHaveBeenCalled();
  });
});
