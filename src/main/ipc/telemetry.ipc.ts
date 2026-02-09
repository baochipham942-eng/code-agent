// ============================================================================
// Telemetry IPC Handlers - 遥测系统 IPC 处理器
// ============================================================================

import { ipcMain, BrowserWindow } from 'electron';
import { TELEMETRY_CHANNELS } from '../../shared/ipc/channels';
import { getTelemetryStorage } from '../telemetry/telemetryStorage';
import { getTelemetryCollector } from '../telemetry/telemetryCollector';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('TelemetryIPC');

/**
 * 注册遥测相关的 IPC handlers
 */
export function registerTelemetryHandlers(
  getMainWindow: () => BrowserWindow | null
): void {
  const storage = getTelemetryStorage();

  // 获取会话详情
  ipcMain.handle(
    TELEMETRY_CHANNELS.GET_SESSION,
    async (_event, sessionId: string) => {
      return storage.getSession(sessionId);
    }
  );

  // 获取会话列表
  ipcMain.handle(
    TELEMETRY_CHANNELS.LIST_SESSIONS,
    async (_event, payload?: { limit?: number; offset?: number }) => {
      return storage.listSessions(payload?.limit, payload?.offset);
    }
  );

  // 获取轮次列表（默认只返回主代理轮次）
  ipcMain.handle(
    TELEMETRY_CHANNELS.GET_TURNS,
    async (_event, sessionId: string) => {
      return storage.getTurnsBySession(sessionId, 'main');
    }
  );

  // 获取轮次详情
  ipcMain.handle(
    TELEMETRY_CHANNELS.GET_TURN_DETAIL,
    async (_event, turnId: string) => {
      return storage.getTurnDetail(turnId);
    }
  );

  // 获取工具统计
  ipcMain.handle(
    TELEMETRY_CHANNELS.GET_TOOL_STATS,
    async (_event, sessionId: string) => {
      return storage.getToolUsageStats(sessionId);
    }
  );

  // 获取意图分布
  ipcMain.handle(
    TELEMETRY_CHANNELS.GET_INTENT_DIST,
    async (_event, sessionId: string) => {
      return storage.getIntentDistribution(sessionId);
    }
  );

  // 获取会话所有事件（用于时间线视图）
  ipcMain.handle(
    TELEMETRY_CHANNELS.GET_EVENTS,
    async (_event, sessionId: string) => {
      return storage.getEventsBySession(sessionId);
    }
  );

  // 获取系统提示词（按 hash）
  ipcMain.handle(
    TELEMETRY_CHANNELS.GET_SYSTEM_PROMPT,
    async (_event, hash: string) => {
      try {
        const { getSystemPromptCache } = await import('../telemetry/systemPromptCache');
        return getSystemPromptCache().get(hash);
      } catch {
        return null;
      }
    }
  );

  // 删除会话遥测数据
  ipcMain.handle(
    TELEMETRY_CHANNELS.DELETE_SESSION,
    async (_event, sessionId: string) => {
      storage.deleteSession(sessionId);
      return { success: true };
    }
  );

  // 订阅实时事件推送
  const collector = getTelemetryCollector();
  collector.addEventListener((event) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(TELEMETRY_CHANNELS.EVENT, event);
    }
  });

  logger.info('Telemetry IPC handlers registered');
}
