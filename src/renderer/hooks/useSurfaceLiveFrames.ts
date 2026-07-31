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

  useEffect(() => {
    if (!shouldStream || !conversationId || !surfaceSessionId) {
      activeSessionRef.current = null;
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
    };
  }, [conversationId, shouldStream, surfaceSessionId]);

  return { frame, streaming, unavailableReason };
}
