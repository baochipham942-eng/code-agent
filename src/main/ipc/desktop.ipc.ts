// ============================================================================
// Desktop IPC Handlers - 原生桌面活动查询
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '@shared/ipc';
import type {
  DesktopSearchQuery,
  DesktopTimelineQuery,
  ManagedBrowserMode,
  ManagedBrowserProviderPreference,
} from '@shared/contract';
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
          const payload = request.payload as {
            url?: string;
            mode?: ManagedBrowserMode;
            provider?: ManagedBrowserProviderPreference;
          } | undefined;
          return {
            success: true,
            data: await browserService.ensureSession(payload?.url || 'about:blank', {
              mode: payload?.mode,
              provider: payload?.provider,
            }),
          } satisfies IPCResponse<unknown>;
        }

        case 'getManagedBrowserRecoverySnapshot': {
          const payload = request.payload as { includeAccessibility?: boolean; tabId?: string } | undefined;
          const [domSnapshot, accessibilitySnapshot] = await Promise.all([
            browserService.getDomSnapshot(payload?.tabId),
            payload?.includeAccessibility === false
              ? Promise.resolve(null)
              : browserService.getAccessibilitySnapshot(payload?.tabId),
          ]);
          return {
            success: true,
            data: summarizeManagedBrowserRecoverySnapshotData({
              session: browserService.getSessionState(),
              domSnapshot,
              accessibilitySnapshot,
            }),
          } satisfies IPCResponse<unknown>;
        }

        case 'observeComputerSurface': {
          const payload = request.payload as { targetApp?: string; includeScreenshot?: boolean } | undefined;
          const computerSurface = getComputerSurface();
          const snapshot = await computerSurface.observe({
            targetApp: payload?.targetApp,
            includeScreenshot: payload?.includeScreenshot === true,
          });
          return {
            success: true,
            data: {
              snapshot,
              state: computerSurface.getState({
                targetApp: snapshot.appName || payload?.targetApp || undefined,
              }),
            },
          } satisfies IPCResponse<unknown>;
        }

        case 'listComputerSurfaceElements': {
          const payload = request.payload as {
            targetApp?: string;
            limit?: number;
            maxDepth?: number;
          } | undefined;
          const computerSurface = getComputerSurface();
          const result = await computerSurface.listBackgroundElements({
            action: 'get_ax_elements',
            targetApp: payload?.targetApp,
            limit: payload?.limit,
            maxDepth: payload?.maxDepth,
          });
          const state = computerSurface.getState({
            targetApp: payload?.targetApp,
            blockedReason: result.success ? null : result.error || null,
            mode: 'background_ax',
          });
          if (!result.success) {
            return {
              success: false,
              error: {
                code: 'COMPUTER_SURFACE_LIST_ELEMENTS_FAILED',
                message: result.error || 'Failed to list Computer Surface elements',
              },
              data: {
                state,
                output: result.output,
                metadata: result.metadata,
              },
            } satisfies IPCResponse<unknown>;
          }
          return {
            success: true,
            data: {
              state,
              output: result.output,
              metadata: result.metadata,
            },
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

export function summarizeManagedBrowserRecoverySnapshotData(input: {
  session: unknown;
  domSnapshot: unknown;
  accessibilitySnapshot: unknown;
}): Record<string, unknown> {
  return {
    session: summarizeManagedBrowserSession(input.session),
    domSnapshot: summarizeDomSnapshot(input.domSnapshot),
    accessibilitySnapshot: summarizeAccessibilitySnapshot(input.accessibilitySnapshot),
  };
}

function summarizeManagedBrowserSession(value: unknown): Record<string, unknown> {
  const session = asRecord(value);
  const activeTab = asRecord(session?.activeTab);
  const activeTabUrl = typeof activeTab?.url === 'string'
    ? summarizeBrowserUrl(activeTab.url)
    : null;
  return {
    running: Boolean(session?.running),
    tabCount: typeof session?.tabCount === 'number' ? session.tabCount : undefined,
    mode: typeof session?.mode === 'string' ? session.mode : undefined,
    provider: typeof session?.provider === 'string' ? session.provider : undefined,
    requestedProvider: typeof session?.requestedProvider === 'string' ? session.requestedProvider : undefined,
    activeTab: activeTab
      ? {
          title: typeof activeTab.title === 'string'
            ? summarizeBrowserTitle(activeTab.title, activeTabUrl?.allowTitle ?? true)
            : undefined,
          url: activeTabUrl?.value,
        }
      : null,
  };
}

function summarizeBrowserTitle(value: string, allowTitle: boolean): string {
  if (!value) {
    return value;
  }
  return allowTitle ? value : '[redacted title]';
}

function summarizeBrowserUrl(value: string): { value: string; allowTitle: boolean } {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return { value: `${url.origin}${url.pathname}`, allowTitle: true };
    }
    if (url.protocol === 'about:' && url.pathname === 'blank') {
      return { value: 'about:blank', allowTitle: true };
    }
    if (url.protocol === 'blob:') {
      return {
        value: url.origin !== 'null' ? `blob:${url.origin}/[redacted]` : 'blob:[redacted]',
        allowTitle: false,
      };
    }
    return { value: `${url.protocol}[redacted]`, allowTitle: false };
  } catch {
    return { value: '[invalid URL]', allowTitle: false };
  }
}

function summarizeDomSnapshot(value: unknown): Record<string, unknown> {
  const dom = asRecord(value);
  const headingCount = Array.isArray(dom?.headings) ? dom.headings.length : 0;
  const interactiveCount = Array.isArray(dom?.interactiveElements)
    ? dom.interactiveElements.length
    : Array.isArray(dom?.interactive)
      ? dom.interactive.length
      : 0;
  return {
    headingCount,
    interactiveCount,
  };
}

function summarizeAccessibilitySnapshot(value: unknown): Record<string, unknown> {
  const snapshot = asRecord(value);
  return {
    available: Boolean(value) && !(snapshot && typeof snapshot.fallback === 'string'),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
