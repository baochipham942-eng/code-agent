import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// notification.ipc.ts 派发特征测试（RQ-183 续作·NOTIFICATION 刀迁表前钉住 switch 形态；派发层原本零测试）：派发层 2 个 action（计数以切块断言为准）。
// - getRecent 委派 notificationService.getRecentNotifications 并原样回传
// - reportClientDelivery 以 { report: payload } 记 info 日志并回 { success: true, data: null }
// - 未知 action → UNKNOWN_ACTION + `Unknown notification action: <action>` 完整文案
// - 抛错 → 以 ('Notification IPC error:', error) 记 error 日志 + NOTIFICATION_ERROR；Error 取 message、非 Error 为 'Unknown error'
// 迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request: IPCRequest) => Promise<IPCResponse>>(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  getRecent: vi.fn((): unknown => [{ id: 'n1', title: 'done' }]),
}));

vi.mock('../../../src/host/platform', () => ({
  ipcHost: { handle: (ch: string, fn: (event: unknown, request: IPCRequest) => Promise<IPCResponse>) => h.handlers.set(ch, fn) },
}));
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { getRecentNotifications: () => h.getRecent() },
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: h.logInfo, warn: vi.fn(), error: h.logError, debug: vi.fn() }),
}));

import { registerNotificationHandlers } from '../../../src/host/ipc/notification.ipc';

const call = (action: string, payload?: unknown) =>
  h.handlers.get(IPC_DOMAINS.NOTIFICATION)!(null, { action, payload } as IPCRequest);

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  registerNotificationHandlers();
});

describe('notification.ipc dispatch 特征', () => {
  it('getRecent 委派并原样回传', async () => {
    expect(await call('getRecent')).toEqual({ success: true, data: [{ id: 'n1', title: 'done' }] });
    expect(h.getRecent).toHaveBeenCalledTimes(1);
  });

  it('reportClientDelivery 记 info 日志并回 data: null', async () => {
    const report = { delivered: false, reason: 'permission-denied' };
    expect(await call('reportClientDelivery', report)).toEqual({ success: true, data: null });
    expect(h.logInfo).toHaveBeenCalledWith('Client OS notification delivery', { report });
  });

  it('未知 action → UNKNOWN_ACTION + 完整文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown notification action: bogus' } });
  });

  it('抛 Error → NOTIFICATION_ERROR + message 并记 error 日志；抛非 Error → Unknown error', async () => {
    const err = new Error('buffer gone');
    h.getRecent.mockImplementationOnce(() => { throw err; });
    expect(await call('getRecent')).toEqual({ success: false, error: { code: 'NOTIFICATION_ERROR', message: 'buffer gone' } });
    expect(h.logError).toHaveBeenCalledWith('Notification IPC error:', err);
    h.getRecent.mockImplementationOnce(() => { throw 'raw'; });
    expect(await call('getRecent')).toEqual({ success: false, error: { code: 'NOTIFICATION_ERROR', message: 'Unknown error' } });
  });
});
