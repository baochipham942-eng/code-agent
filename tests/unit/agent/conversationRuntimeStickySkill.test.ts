// ============================================================================
// conversationRuntimeStickySkill 测试 — 严格技能粘滞恢复的退出条件
// 真实故障（2026-07-21）：建角色草稿晾着时，无关请求也被锁在 5 个工具里。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '../../../src/shared/contract';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/host/mcp/logCollector.js', () => ({
  logCollector: { agent: vi.fn() },
}));

const resolveSkillInvocationMock = vi.fn();
vi.mock('../../../src/host/services/skills/skillInvocationResolver', () => ({
  resolveSkillInvocation: (...args: unknown[]) => resolveSkillInvocationMock(...args),
}));

const listRoleDraftsMock = vi.fn();
vi.mock('../../../src/host/services/roleAssets/roleDraftQueue', () => ({
  listRoleDrafts: (...args: unknown[]) => listRoleDraftsMock(...args),
}));

import { resolveStickyStrictSkillInvocation } from '../../../src/host/agent/runtime/conversationRuntimeStickySkill';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';

const SESSION_ID = 'session-1';

function userMsg(content: string, extra?: Partial<Message>): Message {
  return { id: `m${Math.random()}`, role: 'user', content, timestamp: 0, ...extra };
}

function assistantMsg(content: string, toolNames: string[] = []): Message {
  return {
    id: `m${Math.random()}`,
    role: 'assistant',
    content,
    timestamp: 0,
    ...(toolNames.length > 0
      ? { toolCalls: toolNames.map((name, i) => ({ id: `c${i}`, name, arguments: {} })) }
      : {}),
  };
}

function mkCtx(messages: Message[], sessionId = SESSION_ID): RuntimeContext {
  return { messages, sessionId, workingDirectory: '/tmp/wd' } as unknown as RuntimeContext;
}

const createRoleInvocation = {
  skill: { name: 'create-role', strictToolset: true },
  matchKind: 'slash',
  matchedText: '/create-role',
};

beforeEach(() => {
  resolveSkillInvocationMock.mockReset();
  resolveSkillInvocationMock.mockImplementation(async (text: string) =>
    text.trim().startsWith('/create-role') ? createRoleInvocation : null,
  );
  listRoleDraftsMock.mockReset();
  listRoleDraftsMock.mockResolvedValue([]);
});

describe('resolveStickyStrictSkillInvocation 退出条件', () => {
  it('本会话有 pending 草稿 → 恢复严格边界（等确认阶段）', async () => {
    listRoleDraftsMock.mockResolvedValue([{ sessionId: SESSION_ID, status: 'pending' }]);
    const ctx = mkCtx([
      userMsg('/create-role 股票复盘助手'),
      assistantMsg('草稿好了', ['propose_role']),
      userMsg('a'), userMsg('b'), userMsg('c'), userMsg('d'), // 已超访谈窗口，靠草稿维持
    ]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '帮我整理今天的股票复盘报告');
    expect(result).toBe(createRoleInvocation);
  });

  it('草稿已确认/放弃（队列空）且种子滚出访谈窗口 → 不再恢复', async () => {
    const ctx = mkCtx([
      userMsg('/create-role 股票复盘助手'),
      assistantMsg('草稿好了', ['propose_role']),
      userMsg('改一下描述'), userMsg('好了'), userMsg('谢谢'),
    ]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '帮我整理今天的股票复盘报告');
    expect(result).toBeNull();
  });

  it('种子之后出现过 exit_role_flow 调用 → 即使草稿还在也不恢复', async () => {
    listRoleDraftsMock.mockResolvedValue([{ sessionId: SESSION_ID, status: 'pending' }]);
    const ctx = mkCtx([
      userMsg('/create-role 股票复盘助手'),
      assistantMsg('草稿好了', ['propose_role']),
      userMsg('帮我干点别的'),
      assistantMsg('好，先退出流程', ['exit_role_flow']),
    ]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '继续刚才的活');
    expect(result).toBeNull();
  });

  it('访谈阶段（无草稿、种子在窗口内）→ 恢复', async () => {
    const ctx = mkCtx([
      userMsg('/create-role'),
      assistantMsg('这个角色主要干什么？'),
      userMsg('帮我盯竞品'),
    ]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '再加个日报能力');
    expect(result).toBe(createRoleInvocation);
  });

  it('无草稿且种子滚出窗口（放弃访谈）→ 不恢复', async () => {
    const ctx = mkCtx([
      userMsg('/create-role'),
      userMsg('算了先不建'), userMsg('聊点别的'), userMsg('今天天气如何'),
    ]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '帮我写个周报');
    expect(result).toBeNull();
  });

  it('草稿属于其他会话 → 视同无草稿，按访谈窗口判定', async () => {
    listRoleDraftsMock.mockResolvedValue([{ sessionId: 'other-session', status: 'pending' }]);
    const ctx = mkCtx([
      userMsg('/create-role'),
      userMsg('a'), userMsg('b'), userMsg('c'),
    ]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '帮我写个周报');
    expect(result).toBeNull();
  });

  it('当前轮是斜杠命令 → 不粘滞（保持原行为）', async () => {
    listRoleDraftsMock.mockResolvedValue([{ sessionId: SESSION_ID, status: 'pending' }]);
    const ctx = mkCtx([userMsg('/create-role')]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '/help');
    expect(result).toBeNull();
  });

  it('rewound 的种子消息不算数', async () => {
    const ctx = mkCtx([
      userMsg('/create-role', { visibility: 'rewound' } as Partial<Message>),
      userMsg('随便聊聊'),
    ]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '帮我写个周报');
    expect(result).toBeNull();
  });

  it('listRoleDrafts 读盘失败 → 按无草稿处理，窗口外不恢复（不因 IO 错误锁死会话）', async () => {
    listRoleDraftsMock.mockRejectedValue(new Error('disk error'));
    const ctx = mkCtx([
      userMsg('/create-role'),
      userMsg('a'), userMsg('b'), userMsg('c'),
    ]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '帮我写个周报');
    expect(result).toBeNull();
  });
});
