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
} from '../services/surfaceExecutionClient';
import { useSurfaceExecutionStore } from '../stores/surfaceExecutionStore';
import { surfaceExecutionScopeKeyV1 } from '../utils/surfaceExecutionProjection';
import type { SurfaceExecutionScopeV1 } from '../utils/surfaceExecutionProjection';

export interface SurfaceLiveFrameStreamInput {
  conversationId: string | null;
  surfaceSessionId: string | null;
  /** browser tab 是否真的呈现在用户眼前（右栏展开 且 当前视图就是 browser） */
  visible: boolean;
  /** surface 会话是否在跑（终态会话不该继续烧帧） */
  sessionRunning: boolean;
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
 * 停流 ≠ 抹掉现场：把内存里最后一帧移交 frameByScope 并标 'stale'，dataUrl 留给
 * BrowserAgentWindow 渲染终态留影；没帧可移交时保留 scope 上既有的 dataUrl。
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
}

export function useSurfaceLiveFrames(
  input: SurfaceLiveFrameStreamInput,
): SurfaceLiveFrameStreamState {
  const { conversationId, surfaceSessionId } = input;
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
    const request = { version: 1 as const, conversationId, surfaceSessionId };

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
      void stopSurfaceLiveStream(request).catch(() => undefined);
      // 终态留影移交必须在 cleanup 做：终态时入参的 surfaceSessionId 已变 null，
      // 停流分支反查不到旧 scope；cleanup 闭包里的 request 还是旧的归属。
      const scope = resolveFrameScope(request.conversationId, request.surfaceSessionId);
      if (scope) handoffFrameToStore(scope, lastFrameRef.current);
      lastFrameRef.current = null;
    };
  }, [conversationId, shouldStream, surfaceSessionId]);

  return { frame, streaming, unavailableReason };
}
