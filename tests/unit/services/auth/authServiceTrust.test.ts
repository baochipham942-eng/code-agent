import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureSupabaseInitialized: vi.fn(),
  isSupabaseInitialized: vi.fn(),
  getSupabase: vi.fn(),
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(),
      getSession: vi.fn(),
      signInWithPassword: vi.fn(),
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
  ensureSupabaseInitialized: (settings?: unknown) => mocks.ensureSupabaseInitialized(settings),
  getSupabase: () => mocks.getSupabase(),
  isSupabaseInitialized: () => mocks.isSupabaseInitialized(),
}));

vi.mock('../../../../src/main/services/core', () => ({
  getConfigService: () => ({
    getSettings: () => ({}),
  }),
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
    mocks.ensureSupabaseInitialized.mockImplementation(() => {
      throw new Error('init failed');
    });
    mocks.getSupabase.mockReturnValue(mocks.supabase);
    mocks.supabase.auth.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
    mocks.supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    mocks.supabase.auth.signInWithPassword.mockResolvedValue({ data: { user: null }, error: null });
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
      sessionTrustState: 'cached',
      authBackendAvailable: false,
      hasCachedAdminClaim: true,
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
      sessionTrustState: 'verified',
      authBackendAvailable: true,
      hasCachedAdminClaim: false,
      user: {
        id: 'admin-1',
        isAdmin: true,
      },
    });
  });

  it('initializes Supabase lazily when signing in after startup missed it', async () => {
    const profileQuery = {
      select: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: 'user-2',
          username: 'user',
          nickname: null,
          avatar_url: null,
          is_admin: false,
        },
      }),
    };
    mocks.storage.get.mockReturnValue(undefined);
    mocks.ensureSupabaseInitialized.mockImplementation(() => {
      mocks.isSupabaseInitialized.mockReturnValue(true);
      return mocks.supabase;
    });
    mocks.supabase.from.mockReturnValue(profileQuery);
    mocks.supabase.auth.signInWithPassword.mockResolvedValue({
      data: {
        user: {
          id: 'user-2',
          email: 'user@example.com',
        },
      },
      error: null,
    });

    const { getAuthService } = await import('../../../../src/main/services/auth/authService');
    const authService = getAuthService();

    const result = await authService.signInWithEmail('user@example.com', 'password');

    expect(mocks.ensureSupabaseInitialized).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: true,
      user: {
        id: 'user-2',
        email: 'user@example.com',
      },
    });
    expect(authService.getSessionTrustState()).toBe('verified');
  });
});
