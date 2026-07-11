import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureSupabaseInitialized: vi.fn(),
  isSupabaseInitialized: vi.fn(),
  getSupabase: vi.fn(),
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(),
      getSession: vi.fn(),
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
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
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../../src/host/platform', () => ({
  shell: {
    openExternal: vi.fn(),
  },
}));

vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  ensureSupabaseInitialized: (settings?: unknown) => mocks.ensureSupabaseInitialized(settings),
  getSupabase: () => mocks.getSupabase(),
  isSupabaseInitialized: () => mocks.isSupabaseInitialized(),
}));

vi.mock('../../../../src/host/services/core', () => ({
  getConfigService: () => ({
    getSettings: () => ({}),
  }),
  getSecureStorage: () => mocks.storage,
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => mocks.logger,
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
    mocks.supabase.auth.signOut.mockResolvedValue({ error: null });
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats cached users as unverified and clears them on sign out without Supabase', async () => {
    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
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

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
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
    expect(mocks.logger.debug).toHaveBeenCalledWith(
      ' Profile fetch failed; preserving in-memory profile',
    );
    expect(mocks.logger.warn).not.toHaveBeenCalledWith(
      ' Failed to fetch profile, using basic user:',
      expect.anything(),
    );
  });

  it('keeps startup session validation timeout quiet when a cached user remains available', async () => {
    vi.useFakeTimers();
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.supabase.auth.getSession.mockReturnValue(new Promise(() => {}));

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await vi.advanceTimersByTimeAsync(5000);

    expect(authService.getSessionTrustState()).toBe('cached');
    expect(mocks.logger.debug).toHaveBeenCalledWith(
      ' Background session validation deferred; keeping cached user',
    );
    expect(mocks.logger.warn).not.toHaveBeenCalledWith(
      ' Background session validation failed:',
      expect.anything(),
    );
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

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
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

  it('logs sign-in auth failures without credentials', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.supabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid login credentials' },
    });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    const result = await authService.signInWithEmail('user@example.com', 'secret-password');

    expect(result).toEqual({
      success: false,
      error: 'Invalid login credentials',
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith('Email sign-in failed', {
      error: 'Invalid login credentials',
    });
    const logged = JSON.stringify(mocks.logger.warn.mock.calls);
    expect(logged).not.toContain('user@example.com');
    expect(logged).not.toContain('secret-password');
  });

  it('曾登录但 session 失效 → 标记 sessionExpired 并清用户（2c/ADR-030，非默默清零）', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    // beforeEach 已设缓存 admin 用户；getSession 返回 null = session 失效/过期
    mocks.supabase.auth.getSession.mockResolvedValue({ data: { session: null } });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0)); // 等后台验证跑完

    expect(authService.getCurrentUser()).toBeNull();
    await expect(authService.getStatus()).resolves.toMatchObject({
      isAuthenticated: false,
      sessionExpired: true,
    });
  });

  it('从未登录（无缓存用户）+ session 失效 → 不标记 sessionExpired（不打扰）', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.storage.get.mockReturnValue(undefined); // 无缓存用户
    mocks.supabase.auth.getSession.mockResolvedValue({ data: { session: null } });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(authService.getStatus()).resolves.toMatchObject({
      isAuthenticated: false,
      sessionExpired: false,
    });
  });

  // 回归（dogfood 实测发现）：真实 supabase 启动时以 INITIAL_SESSION + 空 session 触发
  // onAuthStateChange，这才是"默默清零"的主路径。旧 mock 从不触发回调，漏掉了它。
  it('onAuthStateChange: INITIAL_SESSION 空 session + 缓存身份 → sessionExpired（2c 主路径）', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.supabase.auth.getSession.mockReturnValue(new Promise(() => {})); // 挂起后台验证，隔离回调路径
    let cb: ((event: string, session: unknown) => Promise<void>) | undefined;
    mocks.supabase.auth.onAuthStateChange.mockImplementation((fn: typeof cb) => {
      cb = fn;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    expect(cb).toBeDefined();
    await cb!('INITIAL_SESSION', null);

    expect(authService.getCurrentUser()).toBeNull();
    await expect(authService.getStatus()).resolves.toMatchObject({ sessionExpired: true });
  });

  it('onAuthStateChange: SIGNED_OUT（非本机主动退出）→ sessionExpired', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.supabase.auth.getSession.mockReturnValue(new Promise(() => {}));
    let cb: ((event: string, session: unknown) => Promise<void>) | undefined;
    mocks.supabase.auth.onAuthStateChange.mockImplementation((fn: typeof cb) => {
      cb = fn;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await cb!('SIGNED_OUT', null);

    await expect(authService.getStatus()).resolves.toMatchObject({ sessionExpired: true });
  });

  it('本机主动退出使用 local scope，SIGNED_OUT 回调不标记 sessionExpired', async () => {
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.supabase.auth.getSession.mockReturnValue(new Promise(() => {}));
    let cb: ((event: string, session: unknown) => Promise<void>) | undefined;
    mocks.supabase.auth.onAuthStateChange.mockImplementation((fn: typeof cb) => {
      cb = fn;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    mocks.supabase.auth.signOut.mockImplementation(async () => {
      await cb!('SIGNED_OUT', null);
      return { error: null };
    });

    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const authService = getAuthService();

    await authService.initialize();
    await authService.signOut();

    expect(mocks.supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    await expect(authService.getStatus()).resolves.toMatchObject({ sessionExpired: false });
    expect(mocks.logger.info).toHaveBeenCalledWith(' Explicit sign-out requested');
    expect(mocks.logger.info).toHaveBeenCalledWith(' Explicit sign-out confirmed by auth state change');
  });
});
