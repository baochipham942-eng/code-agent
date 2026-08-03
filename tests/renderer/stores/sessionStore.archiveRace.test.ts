// ============================================================================
// 归档连点无响应（2026-08-01 真机截图）定因与修复验收。
// 根因：host 每次归档都广播 SESSION_LIST_UPDATED，而 invokeDomain 的 in-flight
// dedupe 把第二次广播触发的 loadSessions 并进第一次的在途 list 请求——拿到归档
// 前的陈旧快照写回 store，把刚归档的行复活，观感就是「点了没反应」。
// 修复：archiveSession 乐观移除（失败回滚）+ loadSessions 落地前比对本地变更
// 版本号，陈旧快照丢弃重取。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { useSessionUIStore } from '../../../src/renderer/stores/sessionUIStore';

const mockDomainInvoke = vi.fn();

function makeSession(id: string): SessionWithMeta {
  return { id, title: id, createdAt: 0, updatedAt: 0, messageCount: 0, turnCount: 0 } as unknown as SessionWithMeta;
}

function sessionIds(): string[] {
  return useSessionStore.getState().sessions.map((s) => s.id);
}

describe('归档连点：乐观移除 + 陈旧快照丢弃重取', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
      electronAPI: { invoke: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn() },
    };
    useSessionUIStore.setState({ filter: 'active' });
    useSessionStore.setState({
      sessions: [makeSession('s1'), makeSession('s2'), makeSession('s3')],
      currentSessionId: null,
      error: null,
    });
  });

  it('在途 list 期间连点两次归档：两次都生效，陈旧快照不把行写回来', async () => {
    let listCall = 0;
    let resolveFirstList: (value: unknown) => void = () => {};
    mockDomainInvoke.mockImplementation((_domain: string, action: string) => {
      if (action === 'list') {
        listCall += 1;
        if (listCall === 1) {
          // 归档①的广播触发的 list，挂住模拟在途
          return new Promise((resolve) => {
            resolveFirstList = resolve;
          });
        }
        // 重取：返回两条都归档后的新鲜列表
        return Promise.resolve({ success: true, data: [makeSession('s3')] });
      }
      if (action === 'archive') return Promise.resolve({ success: true, data: {} });
      return Promise.resolve({ success: true, data: [] });
    });

    // 归档①的 SESSION_LIST_UPDATED 广播 → loadSessions A 进入在途
    const refreshA = useSessionStore.getState().loadSessions({ silent: true });
    await Promise.resolve();

    // 用户快速连点两条归档——无全局锁，两次点击都必须发出 IPC
    const archive1 = useSessionStore.getState().archiveSession('s1');
    const archive2 = useSessionStore.getState().archiveSession('s2');

    // 乐观移除：两行立即消失，不等 IPC
    expect(sessionIds()).toEqual(['s3']);

    // A 拿到的是归档前的陈旧快照（dedupe 把归档②的广播并进了 A）
    resolveFirstList({ success: true, data: [makeSession('s1'), makeSession('s2'), makeSession('s3')] });
    await Promise.all([refreshA, archive1, archive2]);

    // 陈旧快照被丢弃并重取，最终列表不得复活已归档的行
    expect(sessionIds()).toEqual(['s3']);
    expect(listCall).toBeGreaterThanOrEqual(2);
    const archiveCalls = mockDomainInvoke.mock.calls.filter(([, action]) => action === 'archive');
    expect(archiveCalls).toHaveLength(2);
  });

  it('归档 IPC 失败：回滚乐观移除，行恢复', async () => {
    mockDomainInvoke.mockImplementation((_domain: string, action: string) => {
      if (action === 'archive') return Promise.resolve({ success: false, error: { message: 'db locked' } });
      return Promise.resolve({ success: true, data: [] });
    });

    await useSessionStore.getState().archiveSession('s1');

    expect(sessionIds()).toEqual(['s1', 's2', 's3']);
    expect(useSessionStore.getState().error).toBe('db locked');
  });
});
