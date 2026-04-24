// ============================================================================
// Desktop IPC Handlers - 原生桌面活动查询
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '@shared/ipc';
import type { DesktopSearchQuery, DesktopTimelineQuery } from '@shared/contract';
import { getNativeDesktopService } from '../services/desktop/nativeDesktopService';
import { getComputerSurface } from '../services/desktop/computerSurface';
import { startDesktopVisionAnalyzer } from '../services/desktop/desktopVisionAnalyzer';
import { startDesktopAudioCapture, stopDesktopAudioCapture, getAudioCaptureStatus } from '../services/desktop/desktopAudioCapture';
import { browserService } from '../services/infra/browserService';
import { createLogger } from '../services/infra/logger';

// 音频采集完全走手动触发（录制按钮），不再自动检测会议 app。
// 自动检测会让 ScreenCaptureKit 在用户未知情时拉起，macOS 统一标注为"屏幕共享"，体验错位。
let manualAudioActive = false;

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

        case 'getManagedBrowserSession':
          return { success: true, data: browserService.getSessionState() } satisfies IPCResponse<unknown>;

        case 'ensureManagedBrowserSession': {
          const payload = request.payload as { url?: string; mode?: 'headless' | 'visible' } | undefined;
          return {
            success: true,
            data: await browserService.ensureSession(payload?.url || 'about:blank', { mode: payload?.mode }),
          } satisfies IPCResponse<unknown>;
        }

        case 'closeManagedBrowserSession':
          await browserService.close();
          return { success: true, data: browserService.getSessionState() } satisfies IPCResponse<unknown>;

        case 'getComputerSurfaceState':
          return { success: true, data: getComputerSurface().getState() } satisfies IPCResponse<unknown>;

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

        case 'startAudioCapture': {
          if (manualAudioActive) {
            return { success: true, data: getAudioCaptureStatus() } satisfies IPCResponse<unknown>;
          }
          manualAudioActive = true;
          const payload = request.payload as { fifoPath?: string; mode?: 'microphone' | 'system-audio' } | undefined;
          const fifoPath = payload?.fifoPath;
          const mode = payload?.mode || 'microphone';
          await startDesktopAudioCapture(fifoPath, mode);
          const audioSt = getAudioCaptureStatus();
          if (!audioSt.capturing) {
            // 启动失败 — 回退标志位，返回错误原因
            manualAudioActive = false;
            const reason = !audioSt.soxAvailable
              ? 'sox 未安装，请运行: brew install sox'
              : audioSt.asrEngine === 'none'
                ? '未找到 ASR 引擎（whisper-cpp 或 qwen3-asr）'
                : 'VAD 初始化失败';
            return {
              success: false,
              error: { code: 'AUDIO_START_FAILED', message: `录音启动失败：${reason}` },
              data: audioSt,
            } satisfies IPCResponse<unknown>;
          }
          return { success: true, data: audioSt } satisfies IPCResponse<unknown>;
        }

        case 'stopAudioCapture': {
          manualAudioActive = false;
          stopDesktopAudioCapture();
          return { success: true, data: getAudioCaptureStatus() } satisfies IPCResponse<unknown>;
        }

        case 'getAudioCaptureStatus': {
          return { success: true, data: getAudioCaptureStatus() } satisfies IPCResponse<unknown>;
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

  logger.info('Desktop handlers registered');
}
