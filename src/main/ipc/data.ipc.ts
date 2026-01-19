// ============================================================================
// Data Management IPC Handlers - data/cache:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { app } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';

/**
 * 注册 Data/Cache 相关 IPC handlers
 */
export function registerDataHandlers(ipcMain: IpcMain): void {
  // Cache handlers
  ipcMain.handle(IPC_CHANNELS.CACHE_GET_STATS, async () => {
    const { getToolCache } = await import('../services/infra/ToolCache');
    const cache = getToolCache();
    return cache.getStats();
  });

  ipcMain.handle(IPC_CHANNELS.CACHE_CLEAR, async () => {
    const { getToolCache } = await import('../services/infra/ToolCache');
    const cache = getToolCache();
    cache.clear();
  });

  ipcMain.handle(IPC_CHANNELS.CACHE_CLEAN_EXPIRED, async () => {
    const { getToolCache } = await import('../services/infra/ToolCache');
    const cache = getToolCache();
    return cache.cleanExpired();
  });

  // Data management handlers
  ipcMain.handle(IPC_CHANNELS.DATA_GET_STATS, async () => {
    const { getDatabase } = await import('../services/core/DatabaseService');
    const { getToolCache } = await import('../services/infra/ToolCache');
    const fs = await import('fs');
    const path = await import('path');

    const db = getDatabase();
    const cache = getToolCache();
    const dbStats = db.getStats();
    const cacheStats = cache.getStats();

    const dbCacheCount = db.getToolCacheCount();
    const localCacheStats = db.getLocalCacheStats();

    const userDataPath = app.getPath('userData');
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
        dbCacheCount +
        localCacheStats.sessionCount +
        localCacheStats.messageCount,
    };
  });

  ipcMain.handle(IPC_CHANNELS.DATA_CLEAR_TOOL_CACHE, async () => {
    const { getToolCache } = await import('../services/infra/ToolCache');
    const { getDatabase } = await import('../services/core/DatabaseService');
    const { getSessionManager } = await import('../services/infra/SessionManager');

    const cache = getToolCache();
    const db = getDatabase();
    const sessionManager = getSessionManager();

    // Level 0: Clear memory cache
    const cacheStats = cache.getStats();
    const clearedMemory = cacheStats.totalEntries;
    cache.clear();

    // Clear SessionManager memory cache
    sessionManager.clearCache();

    // Level 1: Clear database tool execution cache
    const clearedToolCache = db.clearToolCache();

    // Level 1: Clear local session and message cache
    const clearedMessages = db.clearAllMessages();
    const clearedSessions = db.clearAllSessions();

    const totalCleared =
      clearedMemory + clearedToolCache + clearedMessages + clearedSessions;
    console.log(
      `[DataClear] Cleared: memory=${clearedMemory}, toolCache=${clearedToolCache}, messages=${clearedMessages}, sessions=${clearedSessions}`
    );

    return totalCleared;
  });
}
