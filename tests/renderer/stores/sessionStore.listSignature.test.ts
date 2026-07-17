import { describe, expect, it } from 'vitest';
import { sessionsSignature } from '../../../src/renderer/utils/sessionListSignature';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

function session(overrides: Partial<SessionWithMeta>): SessionWithMeta {
  return {
    id: 'session-1',
    title: 'Session',
    modelConfig: { provider: 'openai' as any, model: 'gpt-5.4' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
    workbenchSnapshot: { summary: '纯对话', labels: [], recentToolNames: [] },
    ...overrides,
  } as SessionWithMeta;
}

/**
 * sessionsSignature 是"会话历史刷新闪烁"修复的核心：云端同步广播后若签名不变，
 * loadSessions 保留旧数组引用、跳过 setState，避免侧栏整树重渲染。
 */
describe('sessionsSignature', () => {
  it('produces an identical signature when nothing relevant changed', () => {
    const a = [session({ id: 'a', updatedAt: 100 }), session({ id: 'b', updatedAt: 200 })];
    const b = [session({ id: 'a', updatedAt: 100 }), session({ id: 'b', updatedAt: 200 })];
    expect(sessionsSignature(a)).toBe(sessionsSignature(b));
  });

  it('changes when updatedAt changes', () => {
    const before = [session({ id: 'a', updatedAt: 100 })];
    const after = [session({ id: 'a', updatedAt: 101 })];
    expect(sessionsSignature(before)).not.toBe(sessionsSignature(after));
  });

  it('changes when status / title / archived / count fields change', () => {
    const base = [session({ id: 'a', updatedAt: 100, status: 'running', title: 'T', messageCount: 1, turnCount: 1 })];
    expect(sessionsSignature(base)).not.toBe(
      sessionsSignature([session({ id: 'a', updatedAt: 100, status: 'error', title: 'T', messageCount: 1, turnCount: 1 })]),
    );
    expect(sessionsSignature(base)).not.toBe(
      sessionsSignature([session({ id: 'a', updatedAt: 100, status: 'running', title: 'T2', messageCount: 1, turnCount: 1 })]),
    );
    expect(sessionsSignature(base)).not.toBe(
      sessionsSignature([session({ id: 'a', updatedAt: 100, status: 'running', title: 'T', messageCount: 1, turnCount: 1, isArchived: true })]),
    );
  });

  it('changes when durable waiting input appears or clears', () => {
    const waiting = [session({ id: 'a', updatedAt: 100, status: 'running', durableWaitingInput: true })];
    const cleared = [session({ id: 'a', updatedAt: 100, status: 'running' })];

    expect(sessionsSignature(waiting)).not.toBe(sessionsSignature(cleared));
  });

  it('changes when a session is added or removed', () => {
    const one = [session({ id: 'a', updatedAt: 100 })];
    const two = [session({ id: 'a', updatedAt: 100 }), session({ id: 'b', updatedAt: 100 })];
    expect(sessionsSignature(one)).not.toBe(sessionsSignature(two));
  });
});
