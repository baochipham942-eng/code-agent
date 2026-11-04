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

interface AuthStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function storageFromCreateClient(): AuthStorage {
  const options = mocks.createClient.mock.calls[0]?.[2] as { auth: { storage: AuthStorage } } | undefined;
  if (!options) throw new Error('initSupabase did not pass a storage adapter');
  return options.auth.storage;
}

describe('Supabase auth storage Keychain lifetime', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createClient.mockReset();
    mocks.createClient.mockReturnValue({});
    for (const fn of Object.values(mocks.storage)) fn.mockReset();
  });

  it('clears the Keychain copy when supabase-js removes the session key', async () => {
    const { initSupabase } = await import('../../../../src/host/services/infra/supabaseService');
    initSupabase('https://example.supabase.co', 'anon-key');
    const storage = storageFromCreateClient();
    const sessionKey = 'sb-example-auth-token';

    await storage.setItem(sessionKey, 'rotated-session');
    await storage.removeItem(sessionKey);

    expect(mocks.storage.removeItem).toHaveBeenCalledWith(sessionKey);
    expect(mocks.storage.saveSessionToKeychain).toHaveBeenCalledWith('rotated-session');
    expect(mocks.storage.clearSessionFromKeychain).toHaveBeenCalledOnce();
  });

  it('does not clear the Keychain copy when removeItem is not a session key', async () => {
    const { initSupabase } = await import('../../../../src/host/services/infra/supabaseService');
    initSupabase('https://example.supabase.co', 'anon-key');
    const storage = storageFromCreateClient();

    await storage.removeItem('sb-example-auth-token-code-verifier');
    await storage.removeItem('sb-example-auth-token-user');
    await storage.removeItem('auth.user');

    expect(mocks.storage.removeItem).toHaveBeenCalledTimes(3);
    expect(mocks.storage.clearSessionFromKeychain).not.toHaveBeenCalled();
  });

  it('after N refresh failures getItem returns null and Keychain reads stay bounded', async () => {
    const { initSupabase } = await import('../../../../src/host/services/infra/supabaseService');
    initSupabase('https://example.supabase.co', 'anon-key');
    const storage = storageFromCreateClient();
    const sessionKey = 'sb-example-auth-token';
    const attempts = 20;
    let keychain: string | null = JSON.stringify({
      access_token: 'dead-access',
      refresh_token: 'dead-refresh',
      expires_at: 1,
    });
    const local = new Map<string, string>();
    let keychainReads = 0;
    let refreshRequests = 0;
    let signedOutEvents = 0;

    mocks.storage.getItem.mockImplementation(async (key: string) => local.get(key) ?? null);
    mocks.storage.setItem.mockImplementation(async (key: string, value: string) => {
      local.set(key, value);
    });
    mocks.storage.removeItem.mockImplementation(async (key: string) => {
      local.delete(key);
    });
    mocks.storage.getSessionFromKeychain.mockImplementation(async () => {
      keychainReads += 1;
      return keychain;
    });
    mocks.storage.saveSessionToKeychain.mockImplementation(async (value: string) => {
      keychain = value;
    });
    mocks.storage.clearSessionFromKeychain.mockImplementation(async () => {
      keychain = null;
    });

    await storage.setItem(sessionKey, keychain);

    // 模拟 auth-js：读到 session 就刷新；不可重试失败则 _removeSession（removeItem + SIGNED_OUT）。
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const raw = await storage.getItem(sessionKey);
      if (!raw) break;
      refreshRequests += 1;
      await storage.removeItem(sessionKey);
      await storage.removeItem(`${sessionKey}-code-verifier`);
      await storage.removeItem(`${sessionKey}-user`);
      signedOutEvents += 1;
    }

    await expect(storage.getItem(sessionKey)).resolves.toBeNull();
    expect(refreshRequests).toBeGreaterThan(0);
    expect(refreshRequests).toBeLessThanOrEqual(2);
    expect(refreshRequests).toBeLessThan(attempts);
    expect(signedOutEvents).toBeLessThanOrEqual(2);
    expect(signedOutEvents).toBeLessThan(attempts);
    expect(keychainReads).toBeLessThanOrEqual(4);
    expect(keychainReads).toBeLessThan(attempts);
  });
});
