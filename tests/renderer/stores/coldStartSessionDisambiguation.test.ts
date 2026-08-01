// ============================================================================
// 冷启动空会话伪装欢迎页（2026-08-01 事故）
//
// 冷启动会自动恢复 updated_at 最新的历史会话。该会话若投影为空，界面上与真新会话
// 像素级不可区分，用户以为自己新开了一条，首条消息却接进昨晚那条。
//
// 本单测钉两件事：
//   ① 恢复行为**不变**（三态：有内容 / 空历史会话 / 无历史）——修复只做消歧，不改习惯；
//   ② 欢迎页只对真·新会话出现，恢复到历史会话时首屏必须写明是哪条。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isBlankNewSession } from '../../../src/renderer/stores/sessionStore';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

function session(overrides: Partial<SessionWithMeta>): SessionWithMeta {
  return {
    id: 'session-1',
    title: '新对话',
    modelConfig: { provider: 'openai', model: 'gpt-5.4' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
    ...overrides,
  } as SessionWithMeta;
}

describe('isBlankNewSession：欢迎页只对真·新会话诚实', () => {
  it('刚建出来、零消息、默认标题 → 是真新会话', () => {
    expect(isBlankNewSession(session({}))).toBe(true);
  });

  it('零消息但带着旧标题 → 不是（事故里的 a94592bc 正是这个形状）', () => {
    expect(isBlankNewSession(session({ title: '你好' }))).toBe(false);
  });

  it('已经有消息 / 有轮次 → 不是', () => {
    expect(isBlankNewSession(session({ messageCount: 2 }))).toBe(false);
    expect(isBlankNewSession(session({ turnCount: 1 }))).toBe(false);
  });

  it('归档会话 → 不是', () => {
    expect(isBlankNewSession(session({ isArchived: true }))).toBe(false);
    expect(isBlankNewSession(session({ status: 'archived' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 冷启动三态：恢复行为本身不许被这次消歧改掉
// ---------------------------------------------------------------------------

type StoredSession = SessionWithMeta;

async function coldStart(stored: StoredSession[]) {
  vi.resetModules();
  const invoke = vi.fn(async (_domain: string, action: string, payload?: Record<string, unknown>) => {
    if (action === 'list') {
      return { success: true, data: stored };
    }
    if (action === 'load') {
      const found = stored.find((item) => item.id === payload?.sessionId);
      return { success: true, data: found ? { ...found, messages: [], todos: [] } : null };
    }
    if (action === 'create') {
      return {
        success: true,
        data: session({ id: 'created-1', title: String(payload?.title ?? '新对话'), createdAt: 99, updatedAt: 99 }),
      };
    }
    return { success: true, data: [] };
  });
  (globalThis as Record<string, unknown>).window = { domainAPI: { invoke } };

  const mod = await import('../../../src/renderer/stores/sessionStore');
  await mod.initializeSessionStore();
  return { invoke, currentSessionId: mod.useSessionStore.getState().currentSessionId };
}

describe('冷启动三态（恢复习惯保持不变）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('列表首位是有内容的历史会话 → 恢复它', async () => {
    const target = session({ id: 'has-content', title: '昨天的活', messageCount: 6, turnCount: 3, updatedAt: 200 });
    const { invoke, currentSessionId } = await coldStart([target, session({ id: 'older', updatedAt: 100 })]);

    expect(currentSessionId).toBe('has-content');
    expect(invoke).not.toHaveBeenCalledWith(expect.anything(), 'create', expect.anything());
  });

  it('列表首位是空投影的历史会话 → 照样恢复它（不偷偷新建），由首屏负责消歧', async () => {
    const emptyHistorical = session({ id: 'empty-历史', title: '你好', messageCount: 0, turnCount: 0, updatedAt: 300 });
    const { invoke, currentSessionId } = await coldStart([emptyHistorical]);

    expect(currentSessionId).toBe('empty-历史');
    expect(invoke).not.toHaveBeenCalledWith(expect.anything(), 'create', expect.anything());
    // 恢复的是历史会话 → 首屏不许走欢迎页
    expect(isBlankNewSession(emptyHistorical)).toBe(false);
  });

  it('完全没有历史会话 → 建一条真新会话', async () => {
    const { invoke, currentSessionId } = await coldStart([]);

    expect(invoke).toHaveBeenCalledWith(expect.anything(), 'create', expect.objectContaining({ title: '新对话' }));
    expect(currentSessionId).toBe('created-1');
  });
});
