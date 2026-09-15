// ============================================================================
// Data Management IPC Handlers - data/cache:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import { DataSchemas, type DataDomainRequest } from '../../shared/ipc/schemas/data';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { createLogger } from '../services/infra/logger';
import { getAdminAccessIpcError } from './adminGuard';
import { getUserConfigDir } from '../config/configPaths';

const logger = createLogger('DataIPC');

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

async function handleCacheGetStats(): Promise<unknown> {
  const { getToolCache } = await import('../services/infra/toolCache');
  return getToolCache().getStats();
}

async function handleCacheClear(): Promise<void> {
  const { getToolCache } = await import('../services/infra/toolCache');
  getToolCache().clear();
}

async function handleCacheCleanExpired(): Promise<number> {
  const { getToolCache } = await import('../services/infra/toolCache');
  return getToolCache().cleanExpired();
}

async function handleDataGetStats(): Promise<unknown> {
  const { getDatabase } = await import('../services/core/databaseService');
  const { getToolCache } = await import('../services/infra/toolCache');
  const fs = await import('fs');
  const path = await import('path');

  const db = getDatabase();
  const cache = getToolCache();
  const dbStats = db.getStats();
  const cacheStats = cache.getStats();

  const dbCacheCount = db.getToolCacheCount();

  const userDataPath = getUserConfigDir();
  const dbPath = path.join(userDataPath, 'code-agent.db');
  let databaseSize = 0;
  try {
    const stat = fs.statSync(dbPath);
    databaseSize = stat.size;
  } catch {
    // Database file may not exist
  }

  return {
    ...dbStats,
    databaseSize,
    cacheEntries:
      cacheStats.totalEntries +
      dbCacheCount,
  };
}

async function handleDataGetSnapshotStats(): Promise<{
  snapshotCount: number;
  sessionCount: number;
  totalBytes: number;
  retentionDays: number;
  turnSnapshots: { snapshotCount: number; sessionCount: number; totalBytes: number };
  compactionSnapshots: { snapshotCount: number; sessionCount: number; totalBytes: number };
}> {
  const { getDatabase } = await import('../services/core/databaseService');
  const db = getDatabase();
  const turnStats = db.getSnapshotStats();
  const compactStats = db.getCompactionStats();
  const retentionDays = db.getPreference<number>('debugSnapshotRetentionDays', 1) ?? 1;
  return {
    snapshotCount: turnStats.snapshotCount + compactStats.snapshotCount,
    sessionCount: Math.max(turnStats.sessionCount, compactStats.sessionCount),
    totalBytes: turnStats.totalBytes + compactStats.totalBytes,
    retentionDays,
    turnSnapshots: turnStats,
    compactionSnapshots: compactStats,
  };
}

async function handleDataClearSnapshots(req: { olderThanDays?: number; sessionId?: string }): Promise<number> {
  const { getDatabase } = await import('../services/core/databaseService');
  const db = getDatabase();
  const olderThanMs = req.olderThanDays && req.olderThanDays > 0
    ? req.olderThanDays * 24 * 60 * 60 * 1000
    : undefined;
  const turnCleared = db.clearSnapshots({ olderThanMs, sessionId: req.sessionId });
  const compactCleared = db.clearCompactionSnapshots({ olderThanMs, sessionId: req.sessionId });
  const total = turnCleared + compactCleared;
  logger.info('Debug snapshots cleared', {
    turnCleared,
    compactCleared,
    olderThanDays: req.olderThanDays,
    sessionId: req.sessionId,
  });
  return total;
}

async function handleDataSetSnapshotRetention(req: { days: number }): Promise<void> {
  const { getDatabase } = await import('../services/core/databaseService');
  const db = getDatabase();
  // 合法值: 1, 7, 30, -1 (永久)
  const valid = [1, 7, 30, -1];
  const days = valid.includes(req.days) ? req.days : 1;
  db.setPreference('debugSnapshotRetentionDays', days);
}

function requiresAdmin(action: string): boolean {
  return action === 'getSnapshotStats'
    || action === 'clearSnapshots'
    || action === 'setSnapshotRetention';
}

async function handleDataClearToolCache(): Promise<number> {
  const { getToolCache } = await import('../services/infra/toolCache');
  const { getDatabase } = await import('../services/core/databaseService');
  const { getSessionManager } = await import('../services/infra/sessionManager');

  const cache = getToolCache();
  const db = getDatabase();
  const sessionManager = getSessionManager();

  // Level 0: Clear memory cache
  const cacheStats = cache.getStats();
  const clearedMemory = cacheStats.totalEntries;
  cache.clear();

  // Clear SessionManager memory cache
  sessionManager.clearCache();

  // Level 1: Clear database tool execution cache. Sessions and messages are
  // retained; this action is user-facing runtime cache cleanup.
  const clearedToolCache = db.clearToolCache();

  const totalCleared =
    clearedMemory + clearedToolCache;
  logger.info('Runtime cache cleared', { memory: clearedMemory, toolCache: clearedToolCache });

  return totalCleared;
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * data 域单源路由表（RQ-183 续作·DATA 刀）：原 domain switch 逐 case 平移（handler 返回 data，装配器包
 * { success: true, data }）；guard 只拦快照三件套（requiresAdmin），未知 action 不过门，与原 switch 顺序一致；
 * 未知 action → INVALID_ACTION `Unknown action: <action>`、抛错 → INTERNAL_ERROR（Error 取 message、非 Error 取 String(error)），均为装配器缺省。
 */
const dataRoutes = defineDomainRoutes<DataDomainRequest, void>(
  DataSchemas.REQUEST,
  {
    cacheGetStats: () => handleCacheGetStats(),
    cacheClear: async () => {
      await handleCacheClear();
      return null;
    },
    cacheCleanExpired: () => handleCacheCleanExpired(),
    getStats: () => handleDataGetStats(),
    clearToolCache: () => handleDataClearToolCache(),
    getSnapshotStats: () => handleDataGetSnapshotStats(),
    clearSnapshots: (_ctx, payload) =>
      handleDataClearSnapshots((payload as { olderThanDays?: number; sessionId?: string }) ?? {}),
    setSnapshotRetention: async (_ctx, payload) => {
      await handleDataSetSnapshotRetention((payload as { days: number }) ?? { days: 1 });
      return null;
    },
  },
  {
    guard: (action) => (requiresAdmin(String(action)) ? getAdminAccessIpcError('Debug snapshots') : null),
  },
);

/**
 * 注册 Data/Cache 相关 IPC handlers
 */
export function registerDataHandlers(ipcMain: IpcMain): void {
  installDomainRoutes(ipcMain, dataRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerMemoryHandlers.routes 先例）
registerDataHandlers.routes = dataRoutes;
