import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// sync.ipc.ts 派发特征测试（RQ-183 续作·SYNC+DEVICE 刀迁表前钉住现状；两个域派发层原本零测试）：
// SYNC 5 action（start/stop/resolveConflict → null、forceFull 只取 success/error）、DEVICE 3 action
// （register 未登录 → Not authenticated、remove → null），两域未知 action INVALID_ACTION 'Unknown action:'
// 与抛错 INTERNAL_ERROR（Error → message、非 Error → String(error)）。迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  currentUser: { id: 'user-1' } as null | { id: string },
  sync: {
    getStatus: vi.fn(() => ({ isSyncing: false, lastSyncAt: 1 })),
    startAutoSync: vi.fn(async () => {}),
    stopAutoSync: vi.fn(),
    forceFullSync: vi.fn(async () => ({ success: false, error: 'offline', pulled: 3 })),
    resolveConflict: vi.fn(async (..._a: unknown[]) => {}),
    registerDevice: vi.fn(async (..._a: unknown[]) => ({ id: 'dev-1' })),
    listDevices: vi.fn(async () => [{ id: 'dev-1' }]),
    removeDevice: vi.fn(async (..._a: unknown[]) => {}),
  },
}));

vi.mock('../../../src/host/services', () => ({
  getSyncService: () => h.sync,
  getAuthService: () => ({ getCurrentUser: () => h.currentUser }),
}));

import { registerSyncHandlers } from '../../../src/host/ipc/sync.ipc';

type Handler = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let handlers: Map<string, Handler>;
const call = (domain: string, action: string, payload?: unknown) => handlers.get(domain)!(null, { action, payload } as IPCRequest);

beforeEach(() => {
  vi.clearAllMocks();
  h.currentUser = { id: 'user-1' };
  handlers = new Map();
  registerSyncHandlers({ handle: (ch: string, fn: Handler) => handlers.set(ch, fn) } as never);
});

describe('sync 域 dispatch 特征', () => {
  it('getStatus 透传；start / stop 返回 null', async () => {
    expect(await call(IPC_DOMAINS.SYNC, 'getStatus')).toEqual({ success: true, data: { isSyncing: false, lastSyncAt: 1 } });
    expect(await call(IPC_DOMAINS.SYNC, 'start')).toEqual({ success: true, data: null });
    expect(h.sync.startAutoSync).toHaveBeenCalledTimes(1);
    expect(await call(IPC_DOMAINS.SYNC, 'stop')).toEqual({ success: true, data: null });
    expect(h.sync.stopAutoSync).toHaveBeenCalledTimes(1);
  });

  it('forceFull 只取 success / error；resolveConflict 透传参数并返回 null', async () => {
    expect(await call(IPC_DOMAINS.SYNC, 'forceFull')).toEqual({ success: true, data: { success: false, error: 'offline' } });
    expect(await call(IPC_DOMAINS.SYNC, 'resolveConflict', { conflictId: 'c1', resolution: 'remote' })).toEqual({ success: true, data: null });
    expect(h.sync.resolveConflict).toHaveBeenCalledWith('c1', 'remote');
  });

  it('未知 action → INVALID_ACTION；抛 Error → INTERNAL_ERROR + message；非 Error → String(error)', async () => {
    expect(await call(IPC_DOMAINS.SYNC, 'bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
    h.sync.getStatus.mockImplementationOnce(() => {
      throw new Error('sync db down');
    });
    expect(await call(IPC_DOMAINS.SYNC, 'getStatus')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'sync db down' } });
    h.sync.stopAutoSync.mockImplementationOnce(() => {
      throw 'boom';
    });
    expect(await call(IPC_DOMAINS.SYNC, 'stop')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } });
  });
});

describe('device 域 dispatch 特征', () => {
  it('register 用当前用户 id；未登录 → INTERNAL_ERROR Not authenticated', async () => {
    expect(await call(IPC_DOMAINS.DEVICE, 'register')).toEqual({ success: true, data: { id: 'dev-1' } });
    expect(h.sync.registerDevice).toHaveBeenCalledWith('user-1');
    h.currentUser = null;
    expect(await call(IPC_DOMAINS.DEVICE, 'register')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Not authenticated' } });
  });

  it('list 透传；remove 透传 deviceId 并返回 null', async () => {
    expect(await call(IPC_DOMAINS.DEVICE, 'list')).toEqual({ success: true, data: [{ id: 'dev-1' }] });
    expect(await call(IPC_DOMAINS.DEVICE, 'remove', { deviceId: 'dev-9' })).toEqual({ success: true, data: null });
    expect(h.sync.removeDevice).toHaveBeenCalledWith('dev-9');
  });

  it('未知 action → INVALID_ACTION + Unknown action 文案', async () => {
    expect(await call(IPC_DOMAINS.DEVICE, 'bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
  });
});
