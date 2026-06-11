// ============================================================================
// adminService.setUserSharedRelay：授予/撤销「团队共享 key」的 capability 计算
// 重点锁：授予补齐基础功能不留残缺；撤销只去 shared_relay 不误删其它能力。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state: {
  existing: { capabilities: string[]; plan?: string } | null;
  upsertArg: { capabilities: string[]; status: string; plan: string } | null;
  rpcCalls: Array<{ name: string; args: unknown }>;
} = {
  existing: null,
  upsertArg: null,
  rpcCalls: [],
};

vi.mock('../../../../src/main/services/infra/supabaseService', () => ({
  isSupabaseInitialized: () => true,
  getSupabase: () => ({
    rpc: vi.fn(async (name: string, args?: unknown) => {
      state.rpcCalls.push({ name, args });
      return { data: [], error: null };
    }),
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        // setUserSharedRelay: .select().eq().maybeSingle()
        eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: state.existing, error: null })) })),
        // fetchSharedRelayUserIds: await .select() 直接拿结果（thenable）
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      })),
      upsert: vi.fn(async (arg: { capabilities: string[]; status: string; plan: string }) => {
        state.upsertArg = arg;
        return { error: null };
      }),
    })),
  }),
}));

import { getAdminService } from '../../../../src/main/services/admin/adminService';

describe('adminService.setUserSharedRelay', () => {
  beforeEach(() => {
    state.existing = null;
    state.upsertArg = null;
    state.rpcCalls = [];
  });

  it('授予新用户（无 entitlement 行）：写入基础功能 + shared_relay，status active', async () => {
    state.existing = null;
    await getAdminService().setUserSharedRelay({ userId: 'u1', enabled: true });
    const caps = state.upsertArg!.capabilities;
    expect(caps).toContain('shared_relay');
    expect(caps).toEqual(expect.arrayContaining([
      'cloud_agent', 'memory', 'computer_use', 'experimental_tools', 'mcp_cloud', 'mcp_server',
    ]));
    expect(state.upsertArg!.status).toBe('active');
  });

  it('撤销：去掉 shared_relay 但保留其它能力（不让同事丢功能）', async () => {
    state.existing = { capabilities: ['cloud_agent', 'memory', 'shared_relay'], plan: 'team' };
    await getAdminService().setUserSharedRelay({ userId: 'u1', enabled: false });
    const caps = state.upsertArg!.capabilities;
    expect(caps).not.toContain('shared_relay');
    expect(caps).toContain('cloud_agent');
    expect(caps).toContain('memory');
  });

  it('对已有能力的用户授予：保留原能力并并入（不重复）', async () => {
    state.existing = { capabilities: ['cloud_agent'], plan: 'team' };
    await getAdminService().setUserSharedRelay({ userId: 'u1', enabled: true });
    const caps = state.upsertArg!.capabilities;
    expect(caps.filter((c) => c === 'cloud_agent')).toHaveLength(1);
    expect(caps).toContain('shared_relay');
  });

  it('管理员角色开关走 SECURITY DEFINER RPC，不直接写 profiles', async () => {
    await getAdminService().setUserAdmin({ userId: 'u1', enabled: true });

    expect(state.rpcCalls).toContainEqual({
      name: 'admin_set_user_admin',
      args: { p_user_id: 'u1', p_is_admin: true },
    });
  });
});
