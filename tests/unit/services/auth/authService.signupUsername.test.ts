import { beforeEach, describe, expect, it, vi } from 'vitest';

// N-SIGNUP-USERNAME：profiles.username 带 UNIQUE，且由 handle_new_user() 触发器
// 按邮箱前缀去重生成。客户端如果再按邮箱前缀写一遍，就会把触发器的去重结果覆盖成
// 裸前缀，同前缀的第二个用户注册直接撞 UNIQUE 失败。这里钉死「客户端不写 username」。

const mocks = vi.hoisted(() => {
  const upsert = vi.fn((_payload: Record<string, unknown>) => Promise.resolve({ data: null, error: null }));
  const insert = vi.fn((_payload: Record<string, unknown>) => Promise.resolve({ data: null, error: null }));
  const signUp = vi.fn();
  const inviteCode = {
    code: 'TESTCODE',
    is_active: true,
    use_count: 0,
    max_uses: 100,
    expires_at: null,
  };

  const from = vi.fn((table: string) => {
    if (table === 'invite_codes') {
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ single: () => Promise.resolve({ data: inviteCode, error: null }) }) }),
        }),
      };
    }
    // profiles
    return {
      upsert,
      insert,
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
    };
  });

  return {
    upsert,
    insert,
    signUp,
    from,
    supabase: { from, auth: { signUp, onAuthStateChange: vi.fn() }, rpc: vi.fn(() => Promise.resolve({})) },
  };
});

vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  getSupabase: () => mocks.supabase,
  isSupabaseInitialized: () => true,
  ensureSupabaseInitialized: vi.fn(),
}));

vi.mock('../../../../src/host/services/core', () => ({
  getConfigService: () => ({ getSettings: () => ({}) }),
  getSecureStorage: () => ({ set: vi.fn(), get: vi.fn(() => null), delete: vi.fn() }),
}));

vi.mock('../../../../src/host/platform', () => ({ shell: { openExternal: vi.fn() } }));

import { getAuthService } from '../../../../src/host/services/auth/authService';

describe('注册时不由客户端写 username（N-SIGNUP-USERNAME）', () => {
  beforeEach(() => {
    mocks.upsert.mockClear();
    mocks.insert.mockClear();
  });

  it('邮箱注册写 profiles 时不带 username', async () => {
    mocks.signUp.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'linchen@b.com' } },
      error: null,
    });

    const result = await getAuthService().signUpWithEmail('linchen@b.com', 'pw123456', 'TESTCODE');

    expect(result.success).toBe(true);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const payload = mocks.upsert.mock.calls[0][0];
    expect(payload.id).toBe('user-1');
    expect(payload).not.toHaveProperty('username');
  });

  it('OAuth 首登补建 profile 时也不带 username', async () => {
    const service = getAuthService() as unknown as {
      handleOAuthCallback: (code: string) => Promise<unknown>;
    };
    mocks.supabase.auth = {
      ...mocks.supabase.auth,
      exchangeCodeForSession: vi.fn(() =>
        Promise.resolve({ data: { user: { id: 'user-2', email: 'linchen@c.com', app_metadata: {}, user_metadata: {} } }, error: null }),
      ),
    } as typeof mocks.supabase.auth;

    await service.handleOAuthCallback('code-2');

    expect(mocks.insert).toHaveBeenCalledTimes(1);
    const payload = mocks.insert.mock.calls[0][0];
    expect(payload.id).toBe('user-2');
    expect(payload).not.toHaveProperty('username');
  });
});
