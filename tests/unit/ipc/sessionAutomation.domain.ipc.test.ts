import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// sessionAutomation.ipc.ts 派发特征测试（RQ-183 续作·SESSION_AUTOMATION 刀迁表前钉住 switch 形态；派发层原本零测试）：派发层 7 个 action（计数以切块断言为准）。
// - listBySession / getSessionSummary / markReviewed：缺字符串参数 → 抛「缺少 …」→ SESSION_AUTOMATION_ERROR；有参数时按原形委派
// - summarizeSessions：sessionIds 只保留字符串元素，非数组 → []
// - getSessionSummary 回 summarizeSessions([id])[id]；listPendingReview / listParkedApprovals / countPendingReview 原样回传
// - 未知 action → UNKNOWN_ACTION + `Unknown session automation action: <action>`
// - 抛错 → 记 ('Session automation IPC error:', error) + SESSION_AUTOMATION_ERROR；Error 取 message、非 Error 为 'Unknown error'
// 迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request: IPCRequest) => Promise<IPCResponse>>(),
  logError: vi.fn(),
  svc: {
    listBySessionIds: vi.fn((_ids: string[]): unknown => [{ id: 'a1' }]),
    summarizeSessions: vi.fn((ids: string[]): Record<string, unknown> => Object.fromEntries(ids.map((id) => [id, { total: 2, id }]))),
    listPendingReview: vi.fn((): unknown => [{ id: 'p1' }]),
    listParkedApprovals: vi.fn((): unknown => [{ id: 'k1' }]),
    countPendingReview: vi.fn((): unknown => 3),
    markReviewed: vi.fn((_id: string): unknown => ({ reviewed: true })),
  },
}));

vi.mock('../../../src/host/platform', () => ({
  ipcHost: { handle: (ch: string, fn: (event: unknown, request: IPCRequest) => Promise<IPCResponse>) => h.handlers.set(ch, fn) },
}));
vi.mock('../../../src/host/services/sessionAutomation', () => ({ getSessionAutomationService: () => h.svc }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.logError, debug: vi.fn() }),
}));

import { registerSessionAutomationHandlers } from '../../../src/host/ipc/sessionAutomation.ipc';

const call = (action: string, payload?: unknown) =>
  h.handlers.get(IPC_DOMAINS.SESSION_AUTOMATION)!(null, { action, payload } as IPCRequest);
const err = (message: string) => ({ success: false, error: { code: 'SESSION_AUTOMATION_ERROR', message } });

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  registerSessionAutomationHandlers();
});

describe('sessionAutomation.ipc dispatch 特征：带参 action', () => {
  it('listBySession：缺 sessionId 抛错落 SESSION_AUTOMATION_ERROR 并记日志；有参按 [id] 委派', async () => {
    expect(await call('listBySession', { sessionId: 7 })).toEqual(err('缺少 sessionId'));
    expect(h.logError).toHaveBeenCalledWith('Session automation IPC error:', expect.any(Error));
    expect(h.svc.listBySessionIds).not.toHaveBeenCalled();
    expect(await call('listBySession', { sessionId: 's1' })).toEqual({ success: true, data: [{ id: 'a1' }] });
    expect(h.svc.listBySessionIds).toHaveBeenCalledWith(['s1']);
  });

  it('summarizeSessions 只保留字符串 id，非数组为 []', async () => {
    expect(await call('summarizeSessions', { sessionIds: ['s1', 2, 's2'] })).toEqual({ success: true, data: { s1: { total: 2, id: 's1' }, s2: { total: 2, id: 's2' } } });
    expect(h.svc.summarizeSessions).toHaveBeenLastCalledWith(['s1', 's2']);
    await call('summarizeSessions', { sessionIds: 's1' });
    expect(h.svc.summarizeSessions).toHaveBeenLastCalledWith([]);
  });

  it('getSessionSummary 取 summarizeSessions([id])[id]；markReviewed 缺参报错 / 有参委派', async () => {
    expect(await call('getSessionSummary', {})).toEqual(err('缺少 sessionId'));
    expect(await call('getSessionSummary', { sessionId: 's9' })).toEqual({ success: true, data: { total: 2, id: 's9' } });
    expect(await call('markReviewed')).toEqual(err('缺少 automationId'));
    expect(await call('markReviewed', { automationId: 'au1' })).toEqual({ success: true, data: { reviewed: true } });
    expect(h.svc.markReviewed).toHaveBeenCalledWith('au1');
  });
});

describe('sessionAutomation.ipc dispatch 特征：只读与兜底', () => {
  it('listPendingReview / listParkedApprovals / countPendingReview 原样回传', async () => {
    expect(await call('listPendingReview')).toEqual({ success: true, data: [{ id: 'p1' }] });
    expect(await call('listParkedApprovals')).toEqual({ success: true, data: [{ id: 'k1' }] });
    expect(await call('countPendingReview')).toEqual({ success: true, data: 3 });
  });

  it('未知 action → UNKNOWN_ACTION + 完整文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown session automation action: bogus' } });
  });

  it('服务抛 Error → message；抛非 Error → Unknown error', async () => {
    h.svc.countPendingReview.mockImplementationOnce(() => { throw new Error('db locked'); });
    expect(await call('countPendingReview')).toEqual(err('db locked'));
    h.svc.listPendingReview.mockImplementationOnce(() => { throw 'raw'; });
    expect(await call('listPendingReview')).toEqual(err('Unknown error'));
  });
});
