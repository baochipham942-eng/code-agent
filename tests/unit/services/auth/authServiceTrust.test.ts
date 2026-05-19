import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isSupabaseInitialized: vi.fn(),
  getSupabase: vi.fn(),
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(),
      getSession: vi.fn(),
    },
    from: vi.fn(),
  },
  storage: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clearSessionFromKeychain: vi.fn(),
    clearAuthData: vi.fn(),
  },
}));

vi.mock('../../../../src/main/platform', () => ({
  shell: {
    openExternal: vi.fn(),
  },
}));

vi.mock('../../../../src/main/services/infra/supabaseService', () => ({
  getSupabase: () => mocks.getSupabase(),
  isSupabaseInitialized: () => mocks.isSupabaseInitialized(),
}));

vi.mock('../../../../src/main/services/core', () => ({
  getSecureStorage: () => mocks.storage,
}));

vi.mock('../../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('authService session trust', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.isSupabaseInitialized.mockReturnValue(false);
    mocks.getSupabase.mockReturnValue(mocks.supabase);
    mocks.supabase.auth.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
    mocks.supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    mocks.supabase.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null }),
        }),
      }),
    });
    mocks.storage.clearSessionFromKeychain.mockResolvedValue(undefined);
    mocks.storage.get.mockReturnValue(JSON.stringify({
      id: 'admin-1',
      email: 'admin@example.com',
      isAdmin: true,
    }));
  });

  it('treats cached users as unverified and clears them on sign out without Supabase', async () => {
    const { getAuthService } = await import('../../../../src/main/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();

    expect(authService.getCurrentUser()).toMatchObject({
      id: 'admin-1',
      isAdmin: true,
    });
    await expect(authService.getStatus()).resolves.toMatchObject({
      isAuthenticated: true,
      user: {
        id: 'admin-1',
        isAdmin: false,
      },
    });
    expect(authService.getSessionTrustState()).toBe('cached');
    expect(authService.hasVerifiedSession()).toBe(false);

    await authService.signOut();

    expect(mocks.storage.clearSessionFromKeychain).toHaveBeenCalledOnce();
    expect(mocks.storage.clearAuthData).toHaveBeenCalledOnce();
    expect(authService.getCurrentUser()).toBeNull();
    expect(authService.getSessionTrustState()).toBe('none');
  });

  it('keeps cached admin profile after the session is verified when profile fetch fails', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.supabase.auth.getSession.mockResolvedValue({
      data: {
        session: {
          user: {
            id: 'admin-1',
            email: 'admin@example.com',
          },
        },
      },
    });
    mocks.supabase.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockRejectedValue(new Error('profile timeout')),
        }),
      }),
    });

    const { getAuthService } = await import('../../../../src/main/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(authService.getSessionTrustState()).toBe('verified');
    await expect(authService.getStatus()).resolves.toMatchObject({
      isAuthenticated: true,
      user: {
        id: 'admin-1',
        isAdmin: true,
      },
    });
  });
});
