// ============================================================================
// Telemetry IPC Handlers - 遥测系统 IPC 处理器
// ============================================================================

import { ipcMain, BrowserWindow } from '../platform';
import { TELEMETRY_CHANNELS } from '../../shared/ipc/channels';
import { getTelemetryStorage } from '../telemetry/telemetryStorage';
// extractStructuredReplay loaded dynamically — excluded from production bundle
import { getTelemetryCollector } from '../telemetry/telemetryCollector';
import { getTelemetryUploaderService } from '../telemetry/telemetryUploaderService';
import { createLogger } from '../services/infra/logger';
import type { TelemetryFeedbackSubmitRequest, TelemetryFeedbackSubmitResult, TelemetryHealth, TelemetrySessionListOptions } from '../../shared/contract/telemetry';
import { assertAdminAccess, isCurrentUserAdmin } from './adminGuard';

const logger = createLogger('TelemetryIPC');

/**
 * 注册遥测相关的 IPC handlers
 */
export function registerTelemetryHandlers(getMainWindow: () => BrowserWindow | null): void {
  const storage = getTelemetryStorage();

  // 获取会话详情
  ipcMain.handle(TELEMETRY_CHANNELS.GET_SESSION, async (_event, sessionId: string) => {
    assertAdminAccess('Telemetry');
    return storage.getSession(sessionId);
  });

  // 获取会话列表
  ipcMain.handle(TELEMETRY_CHANNELS.LIST_SESSIONS, async (_event, payload?: TelemetrySessionListOptions) => {
    assertAdminAccess('Telemetry');
    return storage.listSessions(payload ?? {});
  });

  // 获取轮次列表（默认只返回主代理轮次）
  ipcMain.handle(TELEMETRY_CHANNELS.GET_TURNS, async (_event, sessionId: string) => {
    assertAdminAccess('Telemetry');
    return storage.getTurnsBySession(sessionId, 'main');
  });

  // 获取轮次详情
  ipcMain.handle(TELEMETRY_CHANNELS.GET_TURN_DETAIL, async (_event, turnId: string) => {
    assertAdminAccess('Telemetry');
    return storage.getTurnDetail(turnId);
  });

  // 获取工具统计
  ipcMain.handle(TELEMETRY_CHANNELS.GET_TOOL_STATS, async (_event, sessionId: string) => {
    assertAdminAccess('Telemetry');
    return storage.getToolUsageStats(sessionId);
  });

  // 获取 Computer Surface 可靠性聚合
  ipcMain.handle(TELEMETRY_CHANNELS.GET_COMPUTER_SURFACE_SUMMARY, async (_event, sessionId: string) => {
    assertAdminAccess('Telemetry');
    return storage.getComputerSurfaceReliabilitySummary(sessionId);
  });

  // 获取意图分布
  ipcMain.handle(TELEMETRY_CHANNELS.GET_INTENT_DIST, async (_event, sessionId: string) => {
    assertAdminAccess('Telemetry');
    return storage.getIntentDistribution(sessionId);
  });

  // 获取会话所有事件（用于时间线视图）
  ipcMain.handle(TELEMETRY_CHANNELS.GET_EVENTS, async (_event, sessionId: string) => {
    assertAdminAccess('Telemetry');
    return storage.getEventsBySession(sessionId);
  });

  // 获取系统提示词（按 hash）
  ipcMain.handle(TELEMETRY_CHANNELS.GET_SYSTEM_PROMPT, async (_event, hash: string) => {
    assertAdminAccess('Telemetry');
    try {
      const { getSystemPromptCache } = await import('../telemetry/systemPromptCache');
      return getSystemPromptCache().get(hash);
    } catch {
      return null;
    }
  });

  // 获取结构化回放数据
  ipcMain.handle(TELEMETRY_CHANNELS.GET_STRUCTURED_REPLAY, async (_event, sessionId: string) => {
    assertAdminAccess('Telemetry');
    if (process.env.EVAL_DISABLED === 'true') return null;
    const { extractStructuredReplay } = await import('../evaluation/replayService');
    return extractStructuredReplay(sessionId);
  });

  // 删除会话遥测数据
  ipcMain.handle(TELEMETRY_CHANNELS.DELETE_SESSION, async (_event, sessionId: string) => {
    assertAdminAccess('Telemetry');
    storage.deleteSession(sessionId);
    return { success: true };
  });

  // 用户显式质量反馈：普通登录用户可写；读取仍只走 admin-only 云端/本地查询。
  ipcMain.handle(TELEMETRY_CHANNELS.SUBMIT_FEEDBACK, async (_event, payload: TelemetryFeedbackSubmitRequest): Promise<TelemetryFeedbackSubmitResult> => {
    const feedback = storage.recordFeedback(payload);
    if (!feedback) {
      return { success: false, error: 'Invalid telemetry feedback payload' };
    }
    void getTelemetryUploaderService().upload();
    return { success: true, feedbackId: feedback.id };
  });

  // 健康摘要：是否启用 + session 数 + 存储占用 + 最近事件时间
  ipcMain.handle(TELEMETRY_CHANNELS.HEALTH, async (): Promise<TelemetryHealth> => {
    assertAdminAccess('Telemetry');
    return {
      enabled: storage.dbAvailable,
      sessionCount: storage.getSessionCount(),
      storageBytes: storage.getStorageBytes(),
      lastEventAt: storage.getLastEventAt()
    };
  });

  // 订阅实时事件推送
  const collector = getTelemetryCollector();
  collector.addEventListener((event) => {
    if (!isCurrentUserAdmin()) return;
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(TELEMETRY_CHANNELS.EVENT, event);
    }
  });

  logger.info('Telemetry IPC handlers registered');
}
