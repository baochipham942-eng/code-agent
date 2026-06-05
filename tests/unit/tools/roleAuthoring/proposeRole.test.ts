// ============================================================================
// propose_role 工具测试 — 起草成功发 role_draft_pending 事件 / 重名拒绝 / 参数校验
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../../src/main/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

vi.mock('../../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { proposeRoleModule } from '../../../../src/main/tools/modules/roleAuthoring/proposeRole';

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1',
    workingDir: mockConfigDir.dir,
    abortSignal: { aborted: false } as AbortSignal,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emit: vi.fn(),
    ...overrides,
  };
}

const allow = vi.fn(async () => ({ allow: true }));

describe('propose_role tool', () => {
  beforeEach(async () => {
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'propose-role-'));
  });
  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  it('起草成功：入队 + 发 role_draft_pending 事件 + 返回 ok', async () => {
    const handler = proposeRoleModule.createHandler();
    const ctx = makeCtx();
    const result = await handler.execute(
      {
        roleId: '竞品分析师',
        description: '盯竞品动态',
        category: 'research',
        tools: ['WebSearch', 'WebFetch'],
        systemPrompt: '你是竞品分析师，负责跟踪竞品动态。',
      },
      ctx as never,
      allow as never,
    );
    expect(result.ok).toBe(true);
    expect(ctx.emit).toHaveBeenCalledTimes(1);
    const event = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.type).toBe('role_draft_pending');
    expect(event.data.drafts[0].roleId).toBe('竞品分析师');
    expect(event.data.drafts[0].tools).toEqual(['WebSearch', 'WebFetch']);
  });

  it('缺 systemPrompt → INVALID_ARGS，不发事件', async () => {
    const handler = proposeRoleModule.createHandler();
    const ctx = makeCtx();
    const result = await handler.execute(
      { roleId: 'x', systemPrompt: '   ' },
      ctx as never,
      allow as never,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_ARGS');
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  it('重名 → DRAFT_REJECTED，把原因回给模型', async () => {
    // 预置同名持久化角色
    await fs.mkdir(path.join(mockConfigDir.dir, 'roles', '研究员'), { recursive: true });
    const handler = proposeRoleModule.createHandler();
    const ctx = makeCtx();
    const result = await handler.execute(
      { roleId: '研究员', description: 'd', systemPrompt: 'p' },
      ctx as never,
      allow as never,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('DRAFT_REJECTED');
    expect(result.error).toMatch(/已存在同名角色/);
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  it('权限被拒 → PERMISSION_DENIED', async () => {
    const handler = proposeRoleModule.createHandler();
    const ctx = makeCtx();
    const deny = vi.fn(async () => ({ allow: false, reason: 'nope' }));
    const result = await handler.execute(
      { roleId: 'x', systemPrompt: 'p' },
      ctx as never,
      deny as never,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PERMISSION_DENIED');
  });
});
