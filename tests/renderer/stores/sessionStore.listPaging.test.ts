// ============================================================================
// 侧栏会话列表分页（2026-08-07 工单：历史会话够不到）验收。
// 核心判据：排在第 51 条之后的老会话，纯靠「加载更多」翻页能定位到——
// 不许用刷新排序时间把它顶上来（那正是原 bug 被掩盖的方式）。
// 覆盖：offset 递进 / 到底边界 / 翻页中途新建会话去重 / 归档独立分页 / 静默刷新保持窗口。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_LIST_PAGE_SIZE } from '../../../src/shared/constants';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSessionUIStore } from '../../../src/renderer/stores/sessionUIStore';

const mockDomainInvoke = vi.fn();

interface FakeSessionRow {
  id: string;
  title: string;
  updatedAt: number;
  isArchived?: boolean;
}

function makeRow(id: string, updatedAt: number, isArchived = false): FakeSessionRow {
  return { id, title: id, updatedAt, isArchived };
}

/** 模拟 host：按 updated_at DESC + limit/offset 分页，archivedOnly 时只取归档。 */
function fakeList(payload: { includeArchived?: boolean; archivedOnly?: boolean; limit?: number; offset?: number }, rows: FakeSessionRow[]) {
  const { includeArchived = false, archivedOnly = false, limit = SESSION_LIST_PAGE_SIZE, offset = 0 } = payload ?? {};
  let pool = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
  if (archivedOnly) {
    pool = pool.filter((row) => row.isArchived);
  } else if (!includeArchived) {
    pool = pool.filter((row) => !row.isArchived);
  }
  return pool.slice(offset, offset + limit);
}

function sessionIds(): string[] {
  return useSessionStore.getState().sessions.map((s) => s.id);
}

/** 造 N 行假会话，s-1 最新、s-N 最老（updatedAt 递减，顺序即 DB 的 DESC 序）。 */
function seedRows(count: number): FakeSessionRow[] {
  return Array.from({ length: count }, (_, i) => makeRow(`s-${i + 1}`, 1_000_000 - i * 1000));
}

describe('侧栏会话列表分页', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
      electronAPI: { invoke: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn() },
    };
    useSessionUIStore.setState({ filter: 'active' });
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
      error: null,
      isLoading: false,
      hasOlderSessions: false,
      isLoadingOlderSessions: false,
    });
  });

  it('核心判据：排在第 51 条之后的老会话，纯靠翻页能定位（offset 递进 + 到底边界）', async () => {
    const rows = seedRows(120); // s-120 排第 120 位，远在旧版 50 条上限之外
    mockDomainInvoke.mockImplementation((_domain: string, action: string, payload?: { limit?: number; offset?: number }) => {
      if (action === 'list') return Promise.resolve({ success: true, data: fakeList(payload ?? {}, rows) });
      return Promise.resolve({ success: true, data: [] });
    });

    // 首屏：第一页 50 条，最老的 s-120 不在内
    await useSessionStore.getState().loadSessions();
    expect(sessionIds()).toHaveLength(SESSION_LIST_PAGE_SIZE);
    expect(sessionIds()).not.toContain('s-120');
    expect(useSessionStore.getState().hasOlderSessions).toBe(true);

    // 翻第二页：offset 必须递进
    await useSessionStore.getState().loadOlderSessions();
    expect(sessionIds()).toHaveLength(100);
    expect(sessionIds()).not.toContain('s-120');
    expect(useSessionStore.getState().hasOlderSessions).toBe(true);

    // 翻第三页：拿到 20 条（不足一页）→ 到底；s-120 此刻纯靠翻页出现
    await useSessionStore.getState().loadOlderSessions();
    expect(sessionIds()).toHaveLength(120);
    expect(sessionIds()).toContain('s-120');
    expect(useSessionStore.getState().hasOlderSessions).toBe(false);

    // offset 递进核对：三次 list 的 offset 依次为 0 / 50 / 100
    const listCalls = mockDomainInvoke.mock.calls.filter(([, action]) => action === 'list');
    expect(listCalls.map(([, , payload]) => (payload as { offset?: number }).offset)).toEqual([0, 50, 100]);
    expect(listCalls.map(([, , payload]) => (payload as { limit?: number }).limit)).toEqual([50, 50, 50]);

    // 到底后再翻：不再发请求
    await useSessionStore.getState().loadOlderSessions();
    const listCallsAfter = mockDomainInvoke.mock.calls.filter(([, action]) => action === 'list');
    expect(listCallsAfter).toHaveLength(3);
  });

  it('翻页中途新建会话：offset 窗口重复扫到的行按 id 去重，列表不错乱', async () => {
    const rows = seedRows(70);
    mockDomainInvoke.mockImplementation((_domain: string, action: string, payload?: { limit?: number; offset?: number }) => {
      if (action === 'list') return Promise.resolve({ success: true, data: fakeList(payload ?? {}, rows) });
      return Promise.resolve({ success: true, data: [] });
    });

    await useSessionStore.getState().loadSessions();
    expect(sessionIds()).toHaveLength(50);

    // 用户在翻页中途建了新会话：它顶到最前，后面所有行整体后挤一位
    rows.unshift(makeRow('s-new', 2_000_000));

    await useSessionStore.getState().loadOlderSessions();

    // offset=50 的窗口会重复扫到上一页末尾的 s-50——去重后不得出现重复 id
    const ids = sessionIds();
    expect(new Set(ids).size).toBe(ids.length);
    // s-51..s-70 全部补齐，s-50 只出现一次
    expect(ids).toContain('s-70');
    expect(ids.filter((id) => id === 's-50')).toHaveLength(1);
    expect(ids).toHaveLength(70);
    // 新会话不由追加路径混入（它应由 SESSION_LIST_UPDATED 广播触发的静默刷新带上）
    expect(ids).not.toContain('s-new');
    // 剩余 1 行（s-new）不在 active 分页窗口覆盖范围内 → 本窗口已到底
    expect(useSessionStore.getState().hasOlderSessions).toBe(false);
  });

  it('静默刷新保持已加载窗口：翻到 100 条后按 100 条重取，不收回第一页', async () => {
    const rows = seedRows(120);
    mockDomainInvoke.mockImplementation((_domain: string, action: string, payload?: { limit?: number; offset?: number }) => {
      if (action === 'list') return Promise.resolve({ success: true, data: fakeList(payload ?? {}, rows) });
      return Promise.resolve({ success: true, data: [] });
    });

    await useSessionStore.getState().loadSessions();
    await useSessionStore.getState().loadOlderSessions();
    expect(sessionIds()).toHaveLength(100);

    // 云端同步广播触发的静默刷新：必须按已加载窗口（100）重取，而不是重置回 50
    await useSessionStore.getState().loadSessions({ silent: true });
    expect(sessionIds()).toHaveLength(100);
    expect(useSessionStore.getState().hasOlderSessions).toBe(true);

    const listCalls = mockDomainInvoke.mock.calls.filter(([, action]) => action === 'list');
    const lastPayload = listCalls[listCalls.length - 1][2] as { offset?: number; limit?: number };
    expect(lastPayload).toMatchObject({ offset: 0, limit: 100 });
  });

  it('归档过滤器走 archivedOnly 独立分页：只取归档会话，offset 同样递进', async () => {
    // 60 归档 + 60 活跃交错（按时间倒序归档并不聚集，混合分页下会被摊薄）
    const rows = Array.from({ length: 120 }, (_, i) =>
      makeRow(`${i % 2 === 0 ? 'archived' : 'active'}-${Math.floor(i / 2) + 1}`, 1_000_000 - i * 1000, i % 2 === 0),
    );
    mockDomainInvoke.mockImplementation((_domain: string, action: string, payload?: { limit?: number; offset?: number }) => {
      if (action === 'list') return Promise.resolve({ success: true, data: fakeList(payload ?? {}, rows) });
      return Promise.resolve({ success: true, data: [] });
    });

    useSessionUIStore.setState({ filter: 'archived' });
    await useSessionStore.getState().loadSessions();

    const listCalls = mockDomainInvoke.mock.calls.filter(([, action]) => action === 'list');
    expect(listCalls[0][2]).toMatchObject({ archivedOnly: true, offset: 0, limit: 50 });

    // 拿到的全是归档会话（isArchived 由 fake 行透传）
    const state = useSessionStore.getState();
    expect(state.sessions).toHaveLength(50);
    expect(state.sessions.every((s) => s.isArchived)).toBe(true);
    expect(state.hasOlderSessions).toBe(true);

    await useSessionStore.getState().loadOlderSessions();
    expect(sessionIds()).toHaveLength(60);
    expect(useSessionStore.getState().hasOlderSessions).toBe(false);
  });

  it('未归档过滤器：includeArchived=false，归档会话不混入分页窗口', async () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => makeRow(`active-${i + 1}`, 1_000_000 - i * 1000)),
      ...Array.from({ length: 10 }, (_, i) => makeRow(`archived-${i + 1}`, 500_000 - i * 1000, true)),
    ];
    mockDomainInvoke.mockImplementation((_domain: string, action: string, payload?: { limit?: number; offset?: number }) => {
      if (action === 'list') return Promise.resolve({ success: true, data: fakeList(payload ?? {}, rows) });
      return Promise.resolve({ success: true, data: [] });
    });

    useSessionUIStore.setState({ filter: 'active' });
    await useSessionStore.getState().loadSessions();
    const listCalls = mockDomainInvoke.mock.calls.filter(([, action]) => action === 'list');
    expect(listCalls[0][2]).toMatchObject({ includeArchived: false, offset: 0, limit: 50 });
    expect(sessionIds().every((id) => id.startsWith('active-'))).toBe(true);

    // 第二页拿到剩余 10 条活跃会话后到底，归档会话始终不出现
    await useSessionStore.getState().loadOlderSessions();
    expect(sessionIds()).toHaveLength(60);
    expect(sessionIds().some((id) => id.startsWith('archived-'))).toBe(false);
    expect(useSessionStore.getState().hasOlderSessions).toBe(false);
  });
});
