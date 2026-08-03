import type {
  SurfaceLiveFrameV1,
  SurfaceLiveStreamRequestV1,
  SurfaceLiveStreamStateV1,
} from '../../../shared/contract/surfaceExecution';
import { IPC_CHANNELS } from '../../../shared/ipc';
import { broadcastToRenderer } from '../../platform/windowBridge';
import { createLogger } from '../infra/logger';
import {
  DEFAULT_PAGE_SCREENCAST_OPTIONS,
  clampScreencastBounds,
  startPageScreencast,
  type PageScreencastHandle,
} from '../infra/browser/pageScreencast';
import {
  getManagedBrowserProviderAdapter,
  type ManagedBrowserProviderAdapter,
} from './ManagedBrowserProviderAdapter';
import {
  getSurfaceExecutionRuntime,
  type SurfaceExecutionRuntime,
} from './SurfaceExecutionRuntime';

// B1-R·R1：把 agent 正在操作的托管浏览器页面实时画面推给 renderer。
//
// 安全边界与 SurfaceFrameRegistry 一致：只对「请求方声明的 conversationId 与 surface
// 会话记录的 conversationId 相符」的会话开流，拿不到归属就直接不开——帧里可能有
// 用户登录态页面，串会话等于泄漏。
//
// 节流护栏（工单硬性要求）：本服务不自己判断该不该开流，只认 renderer 的显式
// start/stop。renderer 侧在「browser tab 可见 且 会话 running」时才 start，切走即
// stop。后台无人看时零帧、零 CPU。
//
// 同时只维持一条流：右栏一次只显示一个浏览器现场，多开没有消费者。

/** 让流自己有个上限——renderer 崩了/漏发 stop 时不至于永久烧 CPU。 */
const MAX_STREAM_MS = 30 * 60_000;

// 本文件此前**零日志语句**，2026-08-02 排查里「日志里没有」差点被当成「没发生」——
// 舞台画面没了到底是流被停掉还是从没开起来，无从分辨。只在终态（停流）与异常
// （拒开）打，正常帧一条不打，避免噪音。
const logger = createLogger('SurfaceLiveStream');

type LiveStreamStopReason = 'client_stop' | 'replaced' | 'watchdog_expiry';

interface ActiveStream {
  conversationId: string;
  surfaceSessionId: string;
  handle: PageScreencastHandle;
  expiryTimer: NodeJS.Timeout;
}

export class SurfaceLiveStreamService {
  private active: ActiveStream | null = null;

  constructor(
    private readonly runtime: SurfaceExecutionRuntime = getSurfaceExecutionRuntime(),
    private readonly adapter: ManagedBrowserProviderAdapter = getManagedBrowserProviderAdapter(),
    private readonly publish: (frame: SurfaceLiveFrameV1) => void = (frame) => {
      broadcastToRenderer(IPC_CHANNELS.SURFACE_LIVE_FRAME, frame);
    },
  ) {}

  async start(request: SurfaceLiveStreamRequestV1): Promise<SurfaceLiveStreamStateV1> {
    if (this.active?.surfaceSessionId === request.surfaceSessionId) {
      return { version: 1, surfaceSessionId: request.surfaceSessionId, streaming: true };
    }
    await this.stopActive('replaced');

    const session = this.runtime.sessions.get(request.surfaceSessionId);
    if (session?.conversationId !== request.conversationId || session.surface !== 'browser') {
      return this.refused(request.surfaceSessionId, 'unsupported');
    }

    const binding = this.adapter.findBindingBySurfaceSessionId(request.surfaceSessionId);
    if (!binding?.browserService.isRunning()) {
      return this.refused(request.surfaceSessionId, 'not_running');
    }
    const page = binding.browserService.getActiveTab()?.page;
    if (!page) {
      return this.refused(request.surfaceSessionId, 'no_active_page');
    }

    const bounds = clampScreencastBounds(request.maxWidth, request.maxHeight);
    let handle: PageScreencastHandle;
    try {
      handle = await startPageScreencast(
        page,
        { ...DEFAULT_PAGE_SCREENCAST_OPTIONS, ...bounds },
        (frame) => {
          // 开流后会话被别的对话接管 / 已停：立刻掐掉，不让帧漏给新归属。
          if (this.active?.surfaceSessionId !== request.surfaceSessionId) return;
          this.publish({
            version: 1,
            conversationId: request.conversationId,
            surfaceSessionId: request.surfaceSessionId,
            mimeType: 'image/jpeg',
            dataUrl: `data:image/jpeg;base64,${frame.base64}`,
            width: frame.width,
            height: frame.height,
            capturedAtMs: frame.capturedAtMs,
          });
        },
      );
    } catch {
      return this.refused(request.surfaceSessionId, 'unsupported');
    }

    const expiryTimer = setTimeout(() => {
      void this.stopActive('watchdog_expiry');
    }, MAX_STREAM_MS);
    expiryTimer.unref?.();
    this.active = {
      conversationId: request.conversationId,
      surfaceSessionId: request.surfaceSessionId,
      handle,
      expiryTimer,
    };
    return { version: 1, surfaceSessionId: request.surfaceSessionId, streaming: true };
  }

  async stop(surfaceSessionId: string): Promise<SurfaceLiveStreamStateV1> {
    if (this.active?.surfaceSessionId === surfaceSessionId) {
      await this.stopActive('client_stop');
    }
    return { version: 1, surfaceSessionId, streaming: false };
  }

  isStreaming(surfaceSessionId: string): boolean {
    return this.active?.surfaceSessionId === surfaceSessionId;
  }

  private async stopActive(reason: LiveStreamStopReason): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = null;
    clearTimeout(active.expiryTimer);
    const session = this.runtime.sessions.get(active.surfaceSessionId);
    logger.info('Surface live stream stopped', {
      conversationId: active.conversationId,
      surfaceSessionId: active.surfaceSessionId,
      runId: session?.runId,
      agentId: session?.agentId,
      sessionState: session?.state,
      reason,
    });
    await active.handle.stop().catch((error) => {
      logger.warn('Surface live stream teardown failed', {
        conversationId: active.conversationId,
        surfaceSessionId: active.surfaceSessionId,
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private refused(
    surfaceSessionId: string,
    reason: NonNullable<SurfaceLiveStreamStateV1['reason']>,
  ): SurfaceLiveStreamStateV1 {
    const session = this.runtime.sessions.get(surfaceSessionId);
    logger.warn('Surface live stream refused', {
      surfaceSessionId,
      runId: session?.runId,
      agentId: session?.agentId,
      sessionState: session?.state,
      reason,
    });
    return { version: 1, surfaceSessionId, streaming: false, reason };
  }
}

let surfaceLiveStreamService: SurfaceLiveStreamService | null = null;

export function getSurfaceLiveStreamService(): SurfaceLiveStreamService {
  surfaceLiveStreamService ??= new SurfaceLiveStreamService();
  return surfaceLiveStreamService;
}
