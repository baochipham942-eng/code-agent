import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// data.ipc.ts 派发特征测试补齐（RQ-183 续作·DATA 刀迁表前钉住现状）：
// 既有 data.ipc.test.ts 4 条只覆盖快照权限与 clearToolCache / getStats；这里补三个缓存 action、
// clearSnapshots 的天数换算与两表合计、setSnapshotRetention 的合法值钳制、权限门只拦快照三件套
// （未知 action 不过门）、未知 action 的 INVALID_ACTION 契约与抛错 INTERNAL_ERROR 兜底。
// 迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  currentUser: null as null | { id: string; email: string; isAdmin?: boolean },
  sessionVerified: false,
  db: {
    clearSnapshots: vi.fn((..._a: unknown[]) => 2),
    clearCompactionSnapshots: vi.fn((..._a: unknown[]) => 3),
    setPreference: vi.fn(),
  },
  toolCache: {
    getStats: vi.fn(() => ({ totalEntries: 4, hits: 9 })),
    clear: vi.fn(),
    cleanExpired: vi.fn(() => 6),
  },
}));

vi.mock('../../../src/host/services/auth', () => ({
  getAuthService: () => ({
    getCurrentUser: () => h.currentUser,
    hasVerifiedSession: () => h.sessionVerified,
  }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({ getDatabase: () => h.db }));
vi.mock('../../../src/host/services/infra/toolCache', () => ({ getToolCache: () => h.toolCache }));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({ getSessionManager: () => ({ clearCache: vi.fn() }) }));
vi.mock('../../../src/host/platform', () => ({ app: { getPath: vi.fn(() => '/tmp/code-agent-test') } }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { registerDataHandlers } from '../../../src/host/ipc/data.ipc';

type DomainHandler = (_: unknown, request: IPCRequest) => Promise<IPCResponse>;

function call(action: string, payload?: unknown): Promise<IPCResponse> {
  const handlers = new Map<string, DomainHandler>();
  registerDataHandlers({ handle: (ch: string, fn: DomainHandler) => handlers.set(ch, fn) } as never);
  const fn = handlers.get(IPC_DOMAINS.DATA);
  if (!fn) throw new Error('DATA handler not registered');
  return fn({}, { action, payload } as IPCRequest);
}

const admin = () => {
  h.currentUser = { id: 'admin-1', email: 'admin@example.com', isAdmin: true };
  h.sessionVerified = true;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.currentUser = null;
  h.sessionVerified = false;
  h.db.clearSnapshots.mockReturnValue(2);
  h.db.clearCompactionSnapshots.mockReturnValue(3);
  h.toolCache.getStats.mockReturnValue({ totalEntries: 4, hits: 9 });
  h.toolCache.cleanExpired.mockReturnValue(6);
});

describe('data.ipc dispatch 特征', () => {
  it('缓存三件套不过权限门：cacheGetStats 透传、cacheClear 返回 null、cacheCleanExpired 返回清理数', async () => {
    expect(await call('cacheGetStats')).toEqual({ success: true, data: { totalEntries: 4, hits: 9 } });
    expect(await call('cacheClear')).toEqual({ success: true, data: null });
    expect(h.toolCache.clear).toHaveBeenCalledTimes(1);
    expect(await call('cacheCleanExpired')).toEqual({ success: true, data: 6 });
  });

  it('clearSnapshots（管理员）：天数换算毫秒传两表并合计；0 天或缺 payload → olderThanMs undefined', async () => {
    admin();
    expect(await call('clearSnapshots', { olderThanDays: 2, sessionId: 's1' })).toEqual({ success: true, data: 5 });
    expect(h.db.clearSnapshots).toHaveBeenLastCalledWith({ olderThanMs: 2 * 24 * 60 * 60 * 1000, sessionId: 's1' });
    expect(h.db.clearCompactionSnapshots).toHaveBeenLastCalledWith({ olderThanMs: 2 * 24 * 60 * 60 * 1000, sessionId: 's1' });
    await call('clearSnapshots', { olderThanDays: 0 });
    expect(h.db.clearSnapshots).toHaveBeenLastCalledWith({ olderThanMs: undefined, sessionId: undefined });
    await call('clearSnapshots');
    expect(h.db.clearCompactionSnapshots).toHaveBeenLastCalledWith({ olderThanMs: undefined, sessionId: undefined });
  });

  it('setSnapshotRetention（管理员）：只收 1/7/30/-1，其余钳到 1，缺 payload 按 1', async () => {
    admin();
    expect(await call('setSnapshotRetention', { days: 7 })).toEqual({ success: true, data: null });
    expect(h.db.setPreference).toHaveBeenLastCalledWith('debugSnapshotRetentionDays', 7);
    await call('setSnapshotRetention', { days: -1 });
    expect(h.db.setPreference).toHaveBeenLastCalledWith('debugSnapshotRetentionDays', -1);
    await call('setSnapshotRetention', { days: 5 });
    expect(h.db.setPreference).toHaveBeenLastCalledWith('debugSnapshotRetentionDays', 1);
    await call('setSnapshotRetention');
    expect(h.db.setPreference).toHaveBeenLastCalledWith('debugSnapshotRetentionDays', 1);
  });

  it('非管理员调快照写操作 → FORBIDDEN 且不碰数据库', async () => {
    expect(await call('setSnapshotRetention', { days: 7 })).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    expect(await call('clearSnapshots', { olderThanDays: 1 })).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    expect(h.db.setPreference).not.toHaveBeenCalled();
    expect(h.db.clearSnapshots).not.toHaveBeenCalled();
  });

  it('未知 action 不过权限门：非管理员也直接 INVALID_ACTION + Unknown action 文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
  });

  it('抛 Error → INTERNAL_ERROR + message；非 Error → String(error)', async () => {
    h.toolCache.cleanExpired.mockImplementationOnce(() => {
      throw new Error('cache locked');
    });
    expect(await call('cacheCleanExpired')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'cache locked' } });
    h.toolCache.getStats.mockImplementationOnce(() => {
      throw 'boom';
    });
    expect(await call('cacheGetStats')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } });
  });
});
