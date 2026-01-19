// ============================================================================
// Data Management IPC Handlers - data/cache:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { app } from 'electron';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

async function handleCacheGetStats(): Promise<unknown> {
  const { getToolCache } = await import('../services/infra/ToolCache');
  return getToolCache().getStats();
}

async function handleCacheClear(): Promise<void> {
  const { getToolCache } = await import('../services/infra/ToolCache');
  getToolCache().clear();
}

async function handleCacheCleanExpired(): Promise<number> {
  const { getToolCache } = await import('../services/infra/ToolCache');
  return getToolCache().cleanExpired();
}

async function handleDataGetStats(): Promise<unknown> {
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
}

async function handleDataClearToolCache(): Promise<number> {
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
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Data/Cache 相关 IPC handlers
 */
export function registerDataHandlers(ipcMain: IpcMain): void {
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.DATA, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'cacheGetStats':
          data = await handleCacheGetStats();
          break;
        case 'cacheClear':
          await handleCacheClear();
          data = null;
          break;
        case 'cacheCleanExpired':
          data = await handleCacheCleanExpired();
          break;
        case 'getStats':
          data = await handleDataGetStats();
          break;
        case 'clearToolCache':
          data = await handleDataClearToolCache();
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }

      return { success: true, data };
    } catch (error) {
      return { success: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  });

  // ========== Legacy Handlers (Deprecated) ==========

  /** @deprecated Use IPC_DOMAINS.DATA with action: 'cacheGetStats' */
  ipcMain.handle(IPC_CHANNELS.CACHE_GET_STATS, async () => handleCacheGetStats());

  /** @deprecated Use IPC_DOMAINS.DATA with action: 'cacheClear' */
  ipcMain.handle(IPC_CHANNELS.CACHE_CLEAR, async () => handleCacheClear());

  /** @deprecated Use IPC_DOMAINS.DATA with action: 'cacheCleanExpired' */
  ipcMain.handle(IPC_CHANNELS.CACHE_CLEAN_EXPIRED, async () => handleCacheCleanExpired());

  /** @deprecated Use IPC_DOMAINS.DATA with action: 'getStats' */
  ipcMain.handle(IPC_CHANNELS.DATA_GET_STATS, async () => handleDataGetStats());

  /** @deprecated Use IPC_DOMAINS.DATA with action: 'clearToolCache' */
  ipcMain.handle(IPC_CHANNELS.DATA_CLEAR_TOOL_CACHE, async () => handleDataClearToolCache());
}
