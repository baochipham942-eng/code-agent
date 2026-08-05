import { useEffect, useRef, useState } from 'react';
import type {
  SurfaceLiveFrameV1,
  SurfaceLiveStreamStateV1,
} from '@shared/contract/surfaceExecution';
import { isSurfaceLiveFrameV1 } from '@shared/contract/surfaceExecution';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import {
  startSurfaceLiveStream,
  stopSurfaceLiveStream,
  persistSurfaceTerminalFrame,
} from '../services/surfaceExecutionClient';
import { useSurfaceExecutionStore } from '../stores/surfaceExecutionStore';
import { surfaceExecutionScopeKeyV1 } from '../utils/surfaceExecutionProjection';
import type { SurfaceExecutionScopeV1 } from '../utils/surfaceExecutionProjection';
import { createLogger } from '../utils/logger';

const logger = createLogger('SurfaceLiveFrames');

export interface SurfaceLiveFrameStreamInput {
  conversationId: string | null;
  surfaceSessionId: string | null;
  /** browser tab 是否真的呈现在用户眼前（右栏展开 且 当前视图就是 browser） */
  visible: boolean;
  /** surface 会话是否在跑（终态会话不该继续烧帧） */
  sessionRunning: boolean;
  /** R4：帧采集物理宽（stage CSS × dpr 封顶）；缺省用 host 默认 */
  maxWidth?: number | null;
  maxHeight?: number | null;
}

export interface SurfaceLiveFrameStreamState {
  frame: SurfaceLiveFrameV1 | null;
  streaming: boolean;
  /** host 拒绝开流的原因；null 表示没请求过或开成了 */
  unavailableReason: SurfaceLiveStreamStateV1['reason'] | null;
}

/**
 * 节流护栏（B1-R·R1 工单硬性要求）：只有「tab 可见 且 会话 running 且 归属齐全」
 * 三条同时成立才开流。任何一条掉了都要 stop——后台无人看时持续截帧烧 CPU 是明确红线。
 *
 * 抽成纯函数是为了能单独喂坏输入验门（去掉任一条件测试必须变红）。
 */
export function shouldStreamSurfaceFrames(input: SurfaceLiveFrameStreamInput): boolean {
  return Boolean(input.conversationId)
    && Boolean(input.surfaceSessionId)
    && input.visible
    && input.sessionRunning;
}

/** 帧写 store 的节流间隔：不要每帧都打 zustand set（裁定：1 秒一次足够留影用） */
const FRAME_STORE_WRITE_THROTTLE_MS = 1000;

/**
 * 帧留存只认 scope 键（conversation/run/agent/surface 四元组）。hook 入参只有
 * conversationId + surfaceSessionId，run/agent 从既有 sessionsByScope 投影里反查——
 * 终态会话仍留在投影里（只是不再被活跃选择器返回），所以终态瞬间也查得到。
 */
function resolveFrameScope(
  conversationId: string,
  surfaceSessionId: string,
): SurfaceExecutionScopeV1 | null {
  const { sessionsByScope } = useSurfaceExecutionStore.getState();
  for (const session of Object.values(sessionsByScope)) {
    if (
      session.scope.conversationId === conversationId
      && session.scope.surfaceSessionId === surfaceSessionId
    ) {
      return session.scope;
    }
  }
  return null;
}

/**
 * 体积策略（与 host 侧 1MB 硬上限配套）：捕获端已是 CDP screencast JPEG q55、≤1024×640，
 * 单帧通常几十 KB。落盘前 decoded bytes 估过 384KB 就用 canvas 降采样（长边 ≤800、
 * quality 0.55）再发；canvas 不可用（如 jsdom）退回原帧，host 硬上限兜底拒收。
 */
const TERMINAL_FRAME_SOFT_LIMIT_BYTES = 384 * 1024;
const TERMINAL_FRAME_DOWNSCALE_MAX_EDGE = 800;
const TERMINAL_FRAME_DOWNSCALE_QUALITY = 0.55;
const JPEG_DATA_URL_PREFIX = 'data:image/jpeg;base64,';

/** base64 长度估 decoded bytes（差几个 padding 字节无所谓，只是阈值判断） */
function estimateDecodedBytes(dataUrl: string): number {
  const base64 = dataUrl.startsWith(JPEG_DATA_URL_PREFIX)
    ? dataUrl.slice(JPEG_DATA_URL_PREFIX.length)
    : dataUrl;
  return Math.floor((base64.length * 3) / 4);
}

async function downscaleTerminalFrameForPersist(dataUrl: string): Promise<string> {
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('frame decode failed'));
      el.src = dataUrl;
    });
    const longEdge = Math.max(image.naturalWidth, image.naturalHeight);
    if (longEdge === 0) return dataUrl;
    const scale = Math.min(1, TERMINAL_FRAME_DOWNSCALE_MAX_EDGE / longEdge);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', TERMINAL_FRAME_DOWNSCALE_QUALITY);
  } catch {
    return dataUrl;
  }
}

/**
 * 帧跟会话一起落盘：与 frameByScope 移交同源，fire-and-forget 调 host 持久化。
 * 拒收/失败只记日志——内存里的留影渲染不依赖这一步成败。
 */
async function persistTerminalFrameToDisk(
  scope: SurfaceExecutionScopeV1,
  dataUrl: string,
): Promise<void> {
  const outgoing = estimateDecodedBytes(dataUrl) > TERMINAL_FRAME_SOFT_LIMIT_BYTES
    ? await downscaleTerminalFrameForPersist(dataUrl)
    : dataUrl;
  try {
    const result = await persistSurfaceTerminalFrame({
      version: 1,
      conversationId: scope.conversationId,
      surfaceSessionId: scope.surfaceSessionId,
      dataUrl: outgoing,
    });
    if (!result.ok) {
      logger.warn('Terminal frame persist rejected by host', { reason: result.reason });
    }
  } catch (error) {
    logger.warn('Terminal frame persist failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 停流 ≠ 抹掉现场：把内存里最后一帧移交 frameByScope 并标 'stale'，dataUrl 留给
 * BrowserAgentWindow 渲染终态留影；没帧可移交时保留 scope 上既有的 dataUrl。
 * 有帧可移交时同时落盘（随会话持久化，刷新/重启后由 BrowserAgentWindow 读回）。
 */
function handoffFrameToStore(
  scope: SurfaceExecutionScopeV1,
  lastFrame: SurfaceLiveFrameV1 | null,
): void {
  const store = useSurfaceExecutionStore.getState();
  const existing = store.frameByScope[surfaceExecutionScopeKeyV1(scope)];
  const dataUrl = lastFrame?.dataUrl ?? existing?.dataUrl;
  if (!dataUrl && !existing) return;
  store.setFrameState(scope, {
    status: 'stale',
    ...(dataUrl ? { dataUrl } : {}),
    updatedAt: Date.now(),
  });
  if (dataUrl) void persistTerminalFrameToDisk(scope, dataUrl);
}

export function useSurfaceLiveFrames(
  input: SurfaceLiveFrameStreamInput,
): SurfaceLiveFrameStreamState {
  const { conversationId, surfaceSessionId, maxWidth, maxHeight } = input;
  const shouldStream = shouldStreamSurfaceFrames(input);
  const [frame, setFrame] = useState<SurfaceLiveFrameV1 | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState<
    SurfaceLiveStreamStateV1['reason'] | null
  >(null);
  // 帧到达频率高于 React 渲染节奏时，用 ref 挡住过期会话的帧（切会话瞬间的漏网帧）。
  const activeSessionRef = useRef<string | null>(null);
  // 最后一帧的内存持有：终态停流瞬间 setFrame(null) 会抹掉 state，这里留一份供移交 store。
  const lastFrameRef = useRef<SurfaceLiveFrameV1 | null>(null);
  const lastStoreWriteAtRef = useRef(0);
  // 捕获尺寸：非法/空时不传，host 用默认；变化时 effect 重跑 → stop + start 换分辨率。
  const captureMaxWidth = typeof maxWidth === 'number' && Number.isFinite(maxWidth) && maxWidth > 0
    ? Math.round(maxWidth)
    : undefined;
  const captureMaxHeight = typeof maxHeight === 'number' && Number.isFinite(maxHeight) && maxHeight > 0
    ? Math.round(maxHeight)
    : undefined;

  useEffect(() => {
    if (!shouldStream || !conversationId || !surfaceSessionId) {
      activeSessionRef.current = null;
      lastFrameRef.current = null;
      setStreaming(false);
      setFrame(null);
      return undefined;
    }

    activeSessionRef.current = surfaceSessionId;
    let cancelled = false;
    const request = {
      version: 1 as const,
      conversationId,
      surfaceSessionId,
      ...(captureMaxWidth !== undefined ? { maxWidth: captureMaxWidth } : {}),
      ...(captureMaxHeight !== undefined ? { maxHeight: captureMaxHeight } : {}),
    };

    const unsubscribe = ipcService.on(
      IPC_CHANNELS.SURFACE_LIVE_FRAME,
      (incoming: SurfaceLiveFrameV1) => {
        if (!isSurfaceLiveFrameV1(incoming)) return;
        if (incoming.surfaceSessionId !== activeSessionRef.current) return;
        if (incoming.conversationId !== conversationId) return;
        setFrame(incoming);
        lastFrameRef.current = incoming;
        // 终态留影：帧同步移交 frameByScope，节流 1 秒一次（zustand set 不宜每帧打）。
        const now = Date.now();
        if (now - lastStoreWriteAtRef.current >= FRAME_STORE_WRITE_THROTTLE_MS) {
          lastStoreWriteAtRef.current = now;
          const scope = resolveFrameScope(conversationId, surfaceSessionId);
          if (scope) {
            useSurfaceExecutionStore.getState().setFrameState(scope, {
              status: 'ready',
              dataUrl: incoming.dataUrl,
              updatedAt: now,
            });
          }
        }
      },
    );

    void startSurfaceLiveStream(request)
      .then((state) => {
        if (cancelled) return;
        setStreaming(state.streaming);
        setUnavailableReason(state.streaming ? null : state.reason ?? 'unsupported');
      })
      .catch(() => {
        if (!cancelled) {
          setStreaming(false);
          setUnavailableReason('unsupported');
        }
      });

    return () => {
      cancelled = true;
      activeSessionRef.current = null;
      unsubscribe?.();
      // 终态留影移交必须在 cleanup 做：终态时入参的 surfaceSessionId 已变 null，
      // 停流分支反查不到旧 scope；cleanup 闭包里的 request 还是旧的归属。
      const scope = resolveFrameScope(request.conversationId, request.surfaceSessionId);
      if (scope) handoffFrameToStore(scope, lastFrameRef.current);
      // 移交和落盘请求先发，再让 host 停流；复用 #895 的唯一终态接缝，不另造采集路径。
      void stopSurfaceLiveStream(request).catch(() => undefined);
      lastFrameRef.current = null;
    };
  }, [captureMaxHeight, captureMaxWidth, conversationId, shouldStream, surfaceSessionId]);

  return { frame, streaming, unavailableReason };
}
