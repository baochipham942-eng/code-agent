// ============================================================================
// Desktop IPC Handlers - 原生桌面活动查询
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '@shared/ipc';
import type { DesktopSearchQuery, DesktopTimelineQuery } from '@shared/types';
import { getNativeDesktopService } from '../services/nativeDesktopService';
import { startDesktopVisionAnalyzer } from '../services/desktopVisionAnalyzer';
import { startDesktopAudioCapture, stopDesktopAudioCapture } from '../services/desktopAudioCapture';
import { createLogger } from '../services/infra/logger';

// 会议应用列表 — 检测到前台是这些 app 时自动启动音频采集
const MEETING_APPS = new Set([
  'zoom.us', 'Zoom', 'zoom',
  '飞书', 'Lark', 'Feishu',
  '钉钉', 'DingTalk',
  '腾讯会议', 'Tencent Meeting', 'WeMeet',
  '企业微信', 'WeChat Work', 'WeCom',
  'Microsoft Teams', 'Teams',
  'Slack',
  'Google Meet',
  'Webex', 'Cisco Webex Meetings',
  'Discord',
  'FaceTime',
]);
let meetingAudioActive = false;
let meetingCheckTimer: ReturnType<typeof setInterval> | null = null;

const logger = createLogger('DesktopIPC');

export function registerDesktopHandlers(ipcMain: IpcMain): void {
  const service = getNativeDesktopService();

  ipcMain.handle(IPC_DOMAINS.DESKTOP, async (_event, request: IPCRequest) => {
    try {
      switch (request.action) {
        case 'getStatus':
          return { success: true, data: service.getStatus() } satisfies IPCResponse<unknown>;

        case 'getCurrentContext':
          return { success: true, data: service.getCurrentContext() } satisfies IPCResponse<unknown>;

        case 'listRecent': {
          const payload = request.payload as { limit?: number } | undefined;
          return { success: true, data: service.listRecent(payload?.limit || 10) } satisfies IPCResponse<unknown>;
        }

        case 'getTimeline': {
          const payload = (request.payload || {}) as DesktopTimelineQuery;
          return { success: true, data: service.getTimeline(payload) } satisfies IPCResponse<unknown>;
        }

        case 'search': {
          const payload = request.payload as DesktopSearchQuery;
          return { success: true, data: service.search(payload) } satisfies IPCResponse<unknown>;
        }

        case 'getStats': {
          const payload = (request.payload || {}) as DesktopTimelineQuery;
          return { success: true, data: service.getStats(payload) } satisfies IPCResponse<unknown>;
        }

        case 'getAudioSegments': {
          const payload = request.payload as { from: number; to: number };
          return { success: true, data: service.listAudioSegments(payload.from, payload.to) } satisfies IPCResponse<unknown>;
        }

        default:
          return {
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `Unknown action: ${request.action}` },
          } satisfies IPCResponse<unknown>;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Desktop IPC error', { action: request.action, error: message });
      return {
        success: false,
        error: { code: 'DESKTOP_ERROR', message },
      } satisfies IPCResponse<unknown>;
    }
  });

  // 启动后台视觉分析器（自动分析有截图但无 analyzeText 的事件）
  startDesktopVisionAnalyzer();

  // 会议 app 检测 — 只在检测到会议应用时启动音频采集
  meetingCheckTimer = setInterval(() => {
    try {
      const ctx = service.getCurrentContext();
      const appName = ctx?.appName || '';
      const isMeeting = MEETING_APPS.has(appName);

      if (isMeeting && !meetingAudioActive) {
        logger.info('[音频采集] 检测到会议应用，启动音频采集', { app: appName });
        meetingAudioActive = true;
        startDesktopAudioCapture().catch((err) => {
          logger.warn('[音频采集] 启动失败', { error: err instanceof Error ? err.message : String(err) });
          meetingAudioActive = false;
        });
      } else if (!isMeeting && meetingAudioActive) {
        logger.info('[音频采集] 会议应用已退出，停止音频采集', { app: appName });
        stopDesktopAudioCapture();
        meetingAudioActive = false;
      }
    } catch {
      // 忽略检查错误
    }
  }, 10_000); // 每 10 秒检查一次前台 app

  logger.info('Desktop handlers registered');
}
