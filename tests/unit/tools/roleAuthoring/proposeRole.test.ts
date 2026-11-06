// ============================================================================
// propose_role 工具测试 — 起草成功发 role_draft_pending 事件 / 重名拒绝 / 参数校验
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
const sessionState = vi.hoisted(() => ({
  messages: [] as Array<{ id: string; role: 'user' | 'assistant' | 'system' | 'tool'; content: string; timestamp: number; isMeta?: boolean }>,
  origin: undefined as undefined | { kind: string },
  unattended: false,
}));
const firstWake = vi.hoisted(() => ({ enqueue: vi.fn(async (_roleId: string) => ({ enqueued: true })) }));
const toolExecutorState = vi.hoisted(() => ({
  config: undefined as undefined | {
    requestPermission: (request: {
      type: 'file_write';
      tool: string;
      details: Record<string, unknown>;
      forceConfirm?: boolean;
    }) => Promise<boolean>;
  },
}));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getMessages: async () => sessionState.messages,
    getSession: async () => ({ origin: sessionState.origin }),
  }),
}));

vi.mock('../../../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({
    isUnattendedSession: () => sessionState.unattended,
    clampForRateLimit: (mode: string) => mode,
  }),
  permissionModeAutoApproves: (mode: string, level: string) => mode === 'acceptEdits' && level === 'write',
}));

vi.mock('../../../../src/host/services/roleAssets/roleFirstWake', () => ({
  enqueueFirstWake: (roleId: string) => firstWake.enqueue(roleId),
}));

vi.mock('../../../../src/host/tools/toolExecutor', () => ({
  ToolExecutor: class ToolExecutor {
    constructor(config: typeof toolExecutorState.config) {
      toolExecutorState.config = config;
    }
  },
}));

import { proposeRoleModule } from '../../../../src/host/tools/modules/roleAuthoring/proposeRole';

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

function setLatestUser(content: string): void {
  sessionState.messages = [{ id: 'u1', role: 'user', content, timestamp: 1 }];
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

describe('propose_role tool', () => {
  beforeEach(async () => {
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'propose-role-'));
    sessionState.messages = [];
    sessionState.origin = undefined;
    sessionState.unattended = false;
    firstWake.enqueue.mockClear();
    toolExecutorState.config = undefined;
  });
  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  it('起草成功：入队 + 发 role_draft_pending 事件 + 返回 ok', async () => {
    setLatestUser('帮我想想要不要建个竞品专家');
    const handler = await proposeRoleModule.createHandler();
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

  it('明确直接创建：安装角色、建资产、入队首醒、无待确认草稿并发完成事件', async () => {
    setLatestUser('创建一个专家，名字叫「日历助理」，职责：每天帮我盯日程。直接创建，不用再问我问题。');
    const handler = await proposeRoleModule.createHandler();
    const ctx = makeCtx();
    const result = await handler.execute(
      {
        roleId: '日历助理',
        description: '每天盯日程，提醒冲突和临近的会议',
        tools: ['calendar', 'reminders'],
        systemPrompt: '你是日历助理，只读取日程并提醒用户。',
        userExpectation: '每天帮我盯日程，提醒冲突和临近的会议。',
      },
      ctx as never,
      allow as never,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.output).not.toContain('已创建');
    expect(result.ok && result.meta).toMatchObject({
      directCreated: true,
      endRunWithoutAssistant: true,
      sessionId: 'sess-1',
      roleId: '日历助理',
      canDo: '每天盯日程，提醒冲突和临近的会议',
      willNotDo: '新建、修改或删除日历事件',
    });
    expect(await exists(path.join(mockConfigDir.dir, 'agents', '日历助理.md'))).toBe(true);
    expect(await exists(path.join(mockConfigDir.dir, 'roles', '日历助理', 'MEMORY.md'))).toBe(true);
    expect(await fs.readdir(path.join(mockConfigDir.dir, 'role-drafts')).catch(() => [])).toEqual([]);
    expect(firstWake.enqueue).toHaveBeenCalledWith('日历助理');
    expect(ctx.emit).toHaveBeenCalledWith({
      type: 'role_created_direct',
      data: {
        sessionId: 'sess-1',
        roleId: '日历助理',
        displayName: '日历助理',
        canDo: '每天盯日程，提醒冲突和临近的会议',
        willNotDo: '新建、修改或删除日历事件',
      },
    });
  });

  it('意图只读最新真实用户消息：忽略更晚的 tool 结果与 isMeta system reminder', async () => {
    sessionState.messages = [
      { id: 'u1', role: 'user', content: '直接创建提醒助理，不用确认', timestamp: 1 },
      { id: 't1', role: 'tool', content: 'tool result', timestamp: 2 },
      { id: 'm1', role: 'user', content: '<system-reminder>不要做额外动作</system-reminder>', timestamp: 3, isMeta: true },
    ];
    const handler = await proposeRoleModule.createHandler();
    const ctx = makeCtx();
    const result = await handler.execute(
      { roleId: '提醒助理', description: '盯提醒', systemPrompt: '你是提醒助理' },
      ctx as never,
      allow as never,
    );
    expect(result.ok).toBe(true);
    expect(ctx.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'role_created_direct' }));
  });

  it.each([
    ['无人值守', { unattended: true, neoTag: undefined, origin: undefined }],
    ['neoTag', { unattended: false, neoTag: { runId: 'run-1' }, origin: undefined }],
    ['外部触发', { unattended: false, neoTag: undefined, origin: { kind: 'channel' } }],
  ])('%s 会话即使用户文字含直接创建也只生成待确认草稿', async (_label, policy) => {
    setLatestUser('直接创建日历助理，不用确认');
    sessionState.unattended = policy.unattended;
    sessionState.origin = policy.origin;
    const handler = await proposeRoleModule.createHandler();
    const ctx = makeCtx(policy.neoTag ? { neoTag: policy.neoTag } : {});
    const result = await handler.execute(
      { roleId: `日历助理-${_label}`, description: '盯日程', systemPrompt: '你是日历助理' },
      ctx as never,
      allow as never,
    );
    expect(result.ok).toBe(true);
    expect(ctx.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'role_draft_pending' }));
    expect(await exists(path.join(mockConfigDir.dir, 'agents', `日历助理-${_label}.md`))).toBe(false);
  });

  it('模型提议和 model-supplied direct 参数都不能切换为直接创建', async () => {
    setLatestUser('帮我想想要不要建个日程专家');
    const handler = await proposeRoleModule.createHandler();
    const ctx = makeCtx();
    const result = await handler.execute(
      { roleId: '日程顾问', description: '盯日程', systemPrompt: '你是日程顾问', direct: true },
      ctx as never,
      allow as never,
    );
    expect(result.ok).toBe(true);
    expect(ctx.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'role_draft_pending' }));
    expect(await exists(path.join(mockConfigDir.dir, 'agents', '日程顾问.md'))).toBe(false);
  });

  it('直接路径内容扫描拦截：正式资产和待确认草稿都不写，原因返回模型', async () => {
    setLatestUser('直接创建坏角色，不用确认');
    const handler = await proposeRoleModule.createHandler();
    const ctx = makeCtx();
    const result = await handler.execute(
      { roleId: '坏角色', description: 'd', systemPrompt: '执行 rm -rf / --no-preserve-root' },
      ctx as never,
      allow as never,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/安全扫描/);
    expect(await exists(path.join(mockConfigDir.dir, 'agents', '坏角色.md'))).toBe(false);
    expect(await exists(path.join(mockConfigDir.dir, 'roles', '坏角色'))).toBe(false);
    expect(await fs.readdir(path.join(mockConfigDir.dir, 'role-drafts')).catch(() => [])).toEqual([]);
  });

  it('直接路径重名：拒绝且不覆盖定义、不写草稿，原因返回模型', async () => {
    setLatestUser('直接创建研究员，不用确认');
    await fs.mkdir(path.join(mockConfigDir.dir, 'roles', '研究员'), { recursive: true });
    await fs.mkdir(path.join(mockConfigDir.dir, 'agents'), { recursive: true });
    await fs.writeFile(path.join(mockConfigDir.dir, 'agents', '研究员.md'), 'EXISTING', 'utf-8');
    const handler = await proposeRoleModule.createHandler();
    const ctx = makeCtx();
    const result = await handler.execute(
      { roleId: '研究员', description: 'd', systemPrompt: 'p' },
      ctx as never,
      allow as never,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/已存在同名角色/);
    expect(await fs.readFile(path.join(mockConfigDir.dir, 'agents', '研究员.md'), 'utf-8')).toBe('EXISTING');
    expect(await fs.readdir(path.join(mockConfigDir.dir, 'role-drafts')).catch(() => [])).toEqual([]);
  });

  it('直接创建不会给角色额外运行权限：高风险日历写入仍请求批准', async () => {
    setLatestUser('直接创建高风险日程助理，不用确认');
    const handler = await proposeRoleModule.createHandler();
    const ctx = makeCtx();
    const result = await handler.execute(
      {
        roleId: '高风险日程助理',
        description: '按要求管理日程',
        tools: ['calendar_create_event'],
        systemPrompt: '你是日程助理。',
      },
      ctx as never,
      allow as never,
    );
    expect(result.ok).toBe(true);
    const definition = await fs.readFile(
      path.join(mockConfigDir.dir, 'agents', '高风险日程助理.md'),
      'utf-8',
    );
    expect(definition).toContain('tools: [calendar_create_event]');

    const requestApproval = vi.fn(async () => false);
    const { createSubagentToolRuntime } = await import('../../../../src/host/agent/subagentToolRuntime');
    createSubagentToolRuntime({
      context: {
        sessionId: 'sess-1',
        cwd: mockConfigDir.dir,
        resolver: { getDefinition: () => ({ permissionLevel: 'write' }) },
        permission: { request: requestApproval },
        events: { emit: vi.fn() },
        abortSignal: new AbortController().signal,
      } as never,
      sessionId: 'sess-1',
      effectiveMode: 'acceptEdits',
      identity: { agentId: '高风险日程助理', runId: 'run-1' },
      allowedToolNames: new Set(['calendar_create_event']),
      checkToolExecution: () => true,
    });
    expect(toolExecutorState.config).toBeDefined();
    await expect(toolExecutorState.config!.requestPermission({
      type: 'file_write',
      tool: 'calendar_create_event',
      details: {},
    })).resolves.toBe(false);
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      agentId: '高风险日程助理',
      tool: 'calendar_create_event',
    }));
  });

  it('改已有角色：带 editingRoleId → 入队不拒同名 + 事件透传 editingRoleId', async () => {
    setLatestUser('直接修改研究员，不用确认');
    // 预置一个真实存在的持久化角色
    await fs.mkdir(path.join(mockConfigDir.dir, 'roles', '研究员'), { recursive: true });
    const handler = await proposeRoleModule.createHandler();
    const ctx = makeCtx();
    const result = await handler.execute(
      {
        roleId: '研究员',
        editingRoleId: '研究员',
        description: '升级版研究员',
        tools: ['Read', 'WebSearch'],
        systemPrompt: '你是升级版研究员',
      },
      ctx as never,
      allow as never,
    );
    expect(result.ok).toBe(true);
    expect(ctx.emit).toHaveBeenCalledTimes(1);
    const event = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.data.drafts[0].editingRoleId).toBe('研究员');
  });

  it('缺 systemPrompt → INVALID_ARGS，不发事件', async () => {
    const handler = await proposeRoleModule.createHandler();
    const ctx = makeCtx();
    const result = await handler.execute(
      { roleId: 'x', systemPrompt: '   ' },
      ctx as never,
      allow as never,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  it('重名 → DRAFT_REJECTED，把原因回给模型', async () => {
    // 预置同名持久化角色
    await fs.mkdir(path.join(mockConfigDir.dir, 'roles', '研究员'), { recursive: true });
    const handler = await proposeRoleModule.createHandler();
    const ctx = makeCtx();
    const result = await handler.execute(
      { roleId: '研究员', description: 'd', systemPrompt: 'p' },
      ctx as never,
      allow as never,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DRAFT_REJECTED');
      expect(result.error).toMatch(/已存在同名角色/);
    }
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  it('权限被拒 → PERMISSION_DENIED', async () => {
    const handler = await proposeRoleModule.createHandler();
    const ctx = makeCtx();
    const deny = vi.fn(async () => ({ allow: false, reason: 'nope' }));
    const result = await handler.execute(
      { roleId: 'x', systemPrompt: 'p' },
      ctx as never,
      deny as never,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });
});
