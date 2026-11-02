// ============================================================================
// roleFlowStallExit 测试 — 建/改角色严格流程的停摆出口（FB-327）
// 复现形状：create-role 激活的轮回以纯文本收尾，既没有 propose_role 草稿、也没有
// 留给用户的问句 → 会话静默空闲。出口必须把这一轮变成用户可见的「继续/放弃」说明。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '../../../src/shared/contract';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const listRoleDraftsMock = vi.fn();
vi.mock('../../../src/host/services/roleAssets/roleDraftQueue', () => ({
  listRoleDrafts: (...args: unknown[]) => listRoleDraftsMock(...args),
}));

const { settleRoleFlowStallOnTextBreak } = await import('../../../src/host/agent/runtime/roleFlowStallExit');

const SESSION_ID = 'session-1';

const createRoleBoundary = { skillName: 'create-role', allowedTools: ['propose_role', 'exit_role_flow', 'list_experts', 'ask_user_question', 'read_file', 'glob', 'grep'], strict: true as const };
const editRoleBoundary = { skillName: 'edit-role', allowedTools: ['propose_role', 'exit_role_flow', 'list_experts', 'read_file', 'ask_user_question', 'glob', 'grep'], strict: true as const };

function mkCtx() {
  return { sessionId: SESSION_ID, onEvent: vi.fn() };
}

function mkAssembly() {
  const persisted: Message[] = [];
  return {
    persisted,
    addAndPersistMessage: vi.fn(async (message: Message) => { persisted.push(message); }),
    generateId: () => `msg-${persisted.length + 1}`,
  };
}

beforeEach(() => {
  listRoleDraftsMock.mockReset();
  listRoleDraftsMock.mockResolvedValue([]);
});

// 判定谓词不对外导出（knip 生产口径），经 settle 的返回值（是否落了停摆说明）观察。
async function shouldSurfaceRoleFlowStall(
  boundary: Parameters<typeof settleRoleFlowStallOnTextBreak>[0]['boundary'],
  finalText: string,
  hasPendingDraft: boolean,
): Promise<boolean> {
  listRoleDraftsMock.mockResolvedValue(hasPendingDraft ? [{ sessionId: SESSION_ID }] : []);
  return settleRoleFlowStallOnTextBreak({ ctx: mkCtx(), assembly: mkAssembly(), boundary, finalText });
}

describe('停摆判定（经 settle 观察）', () => {
  it('create-role strict 边界 + 无草稿 + 收尾无问句 → 判停摆', async () => {
    expect(await shouldSurfaceRoleFlowStall(createRoleBoundary, '草稿好了，回复「确认」我就创建。', false)).toBe(true);
  });

  it('本会话已有 pending 草稿 → 不判停摆（确认卡在场，空闲是等确认）', async () => {
    expect(await shouldSurfaceRoleFlowStall(createRoleBoundary, '草稿好了。', true)).toBe(false);
  });

  it('收尾文本带问句（中/英）→ 不判停摆（合法访谈收尾）', async () => {
    expect(await shouldSurfaceRoleFlowStall(createRoleBoundary, '想招个干什么的专家？', false)).toBe(false);
    expect(await shouldSurfaceRoleFlowStall(createRoleBoundary, 'what kind of expert? tell me', false)).toBe(false);
  });

  it('edit-role 同样受停摆出口保护', async () => {
    expect(await shouldSurfaceRoleFlowStall(editRoleBoundary, '已经按你的意思改好了。', false)).toBe(true);
  });

  it('非建/改角色的 strict 边界（dream/distill）不触发', async () => {
    expect(await shouldSurfaceRoleFlowStall({ skillName: 'dream', allowedTools: ['Read'], strict: true }, '没有输出', false)).toBe(false);
  });

  it('非 strict 软边界 / 无边界不触发', async () => {
    expect(await shouldSurfaceRoleFlowStall({ skillName: 'create-role', allowedTools: ['propose_role'] }, '念完收工', false)).toBe(false);
    expect(await shouldSurfaceRoleFlowStall(undefined, '念完收工', false)).toBe(false);
  });
});

describe('settleRoleFlowStallOnTextBreak 落卡', () => {
  it('停摆成立：持久化并广播 role:system 消息，metadata 带登记键 roleFlowStalled', async () => {
    const ctx = mkCtx();
    const assembly = mkAssembly();
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx, assembly, boundary: createRoleBoundary,
      finalText: '我把「竞品动态研究员」的草稿拟好了，内容没问题的话回复「确认」。',
    });
    expect(fired).toBe(true);
    expect(assembly.addAndPersistMessage).toHaveBeenCalledTimes(1);
    const message = assembly.persisted[0];
    expect(message.role).toBe('system');
    expect(message.metadata?.roleFlowStalled).toEqual({ skillName: 'create-role' });
    // 用户视角的三要素：说清没有草稿、说清没创建任何东西、给继续/放弃路径
    expect(message.content).toContain('没有生成草稿');
    expect(message.content).toContain('还没有任何角色被创建或修改');
    expect(message.content).toContain('/create-role');
    expect(ctx.onEvent).toHaveBeenCalledWith({ type: 'message', data: message });
  });

  it('edit-role 停摆：文案指向 /edit-role', async () => {
    const assembly = mkAssembly();
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx: mkCtx(), assembly, boundary: editRoleBoundary, finalText: '改好了，等你确认。',
    });
    expect(fired).toBe(true);
    expect(assembly.persisted[0].content).toContain('/edit-role');
    expect(assembly.persisted[0].metadata?.roleFlowStalled).toEqual({ skillName: 'edit-role' });
  });

  it('草稿属于其他会话 → 视同无草稿，照常判停摆', async () => {
    listRoleDraftsMock.mockResolvedValue([{ sessionId: 'other-session' }]);
    const assembly = mkAssembly();
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx: mkCtx(), assembly, boundary: createRoleBoundary, finalText: '好了。',
    });
    expect(fired).toBe(true);
  });

  it('本会话已有 pending 草稿 → 不落卡不发事件', async () => {
    listRoleDraftsMock.mockResolvedValue([{ sessionId: SESSION_ID }]);
    const ctx = mkCtx();
    const assembly = mkAssembly();
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx, assembly, boundary: createRoleBoundary, finalText: '草稿好了。',
    });
    expect(fired).toBe(false);
    expect(assembly.addAndPersistMessage).not.toHaveBeenCalled();
    expect(ctx.onEvent).not.toHaveBeenCalled();
  });

  it('listRoleDrafts 读盘失败 → 按无草稿处理，出口不因 IO 错误哑掉（fail-visible）', async () => {
    listRoleDraftsMock.mockRejectedValue(new Error('disk error'));
    const assembly = mkAssembly();
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx: mkCtx(), assembly, boundary: createRoleBoundary, finalText: '好了。',
    });
    expect(fired).toBe(true);
    expect(assembly.persisted.length).toBe(1);
  });

  it('落库失败 → 不抛红（出口不把正常收尾变失败），返回 false', async () => {
    const ctx = mkCtx();
    const assembly = mkAssembly();
    assembly.addAndPersistMessage.mockRejectedValue(new Error('db down'));
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx, assembly, boundary: createRoleBoundary, finalText: '好了。',
    });
    expect(fired).toBe(false);
    expect(ctx.onEvent).not.toHaveBeenCalled();
  });
});
