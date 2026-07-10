import { useEffect, useRef } from 'react';
import ipcService from '../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import { invokeNativeCommandAction } from '../services/nativeCommandFacade';
import type { AgentPointerEvent } from '@shared/contract';
import { isAgentPointerEvent } from '../stores/agentPointerStore';

function extractAgentPointerEvent(data: unknown): AgentPointerEvent | undefined {
  const meta = (
    data as
      | { metadata?: { agentPointerEvent?: unknown; browserComputerProof?: { agentPointerEvent?: unknown } } }
      | undefined
  )?.metadata;
  if (isAgentPointerEvent(meta?.agentPointerEvent)) {
    return meta.agentPointerEvent;
  }
  if (isAgentPointerEvent(meta?.browserComputerProof?.agentPointerEvent)) {
    return meta.browserComputerProof.agentPointerEvent;
  }
  return undefined;
}

const RUN_END_EVENTS = new Set<string>(['agent_complete', 'agent_cancelled', 'stream_end', 'error']);
/** agent 动作后光晕保持亮实的时长，之后降为 idle（暗虚，用户驱动或空闲） */
const ACTIVE_HOLD_MS = 2200;

/**
 * Agent Halo — CUA 原生驱动真实指针时，全屏透明 overlay 光晕弹簧跟随系统指针
 * （单指针共驾聚光灯，borrow 自 Codex 桌面端）。
 *
 * - 显示：看到 nativeCursor.status === 'native' 的 computer 指针事件（CUA start_session
 *   成功后才会出现，天然被 CODE_AGENT_ENABLE_CUA 门控）。
 * - 亮暗：computer 指针事件在飞 → active；ACTIVE_HOLD_MS 无新事件 → idle（用户驱动/空闲）。
 * - 隐藏：run 结束（agent_complete/cancelled/stream_end/error）。
 *   ponytail: end_session 不单独识别（需解析工具名），run 结束兜底足够，会话中途 end 最多晚 hide 一轮。
 * - Tauri 不可用（web 模式）→ 全程静默 no-op。
 *
 * 在 App 顶层挂载一次（与 useComputerUsePip 并列）。
 */
export function useAgentHalo(): void {
  const shownRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;

    const clearIdleTimer = () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };

    const hide = () => {
      clearIdleTimer();
      if (!shownRef.current) return;
      shownRef.current = false;
      void invokeNativeCommandAction('hideAgentHalo').catch(() => {});
    };

    const markActive = async (nativeConfirmed: boolean) => {
      try {
        if (!shownRef.current) {
          if (!nativeConfirmed) return;
          shownRef.current = true;
          await invokeNativeCommandAction('showAgentHalo');
        }
        if (disposed) return;
        await invokeNativeCommandAction('setAgentHaloMode', { mode: 'active' });
        clearIdleTimer();
        idleTimerRef.current = window.setTimeout(() => {
          idleTimerRef.current = null;
          if (shownRef.current) {
            void invokeNativeCommandAction('setAgentHaloMode', { mode: 'idle' }).catch(() => {});
          }
        }, ACTIVE_HOLD_MS);
      } catch {
        // Tauri 不可用 → 忽略，不影响主流程
      }
    };

    const unsubscribe = ipcService.on(IPC_CHANNELS.AGENT_EVENT, (event) => {
      if (disposed) return;
      if (event.type === 'tool_call_end') {
        const pointer = extractAgentPointerEvent(event.data);
        if (pointer?.surface === 'computer') {
          void markActive(pointer.nativeCursor?.status === 'native');
        }
        return;
      }
      if (RUN_END_EVENTS.has(event.type)) {
        hide();
      }
    });

    return () => {
      disposed = true;
      unsubscribe?.();
      hide();
    };
  }, []);
}
