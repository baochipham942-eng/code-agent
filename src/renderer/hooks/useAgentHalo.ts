import { useEffect, useRef } from 'react';
import ipcService from '../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import { invokeNativeCommandAction } from '../services/nativeCommandFacade';
import type { AgentPointerEvent, AgentPointerNativeCursorCapability } from '@shared/contract';
import { parseAgentPointerNativeCursorCapability } from '@shared/utils/agentPointer';
import { isAgentPointerEvent } from '../stores/agentPointerStore';
import { isTerminalAgentError } from './agent/effects/useSessionLifecycleEffects';

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
 * - 显示：cua-driver ToolResult 首次确认原生系统 overlay 后，由该 session 持有。
 * - 亮暗：owner session 的 cua-driver 动作在飞 → active；ACTIVE_HOLD_MS 无新事件 → idle。
 * - 隐藏：owner 的 end_session 或 run 终态；warning error 不算终态。
 * - Tauri 不可用（web 模式）→ 全程静默 no-op。
 *
 * 在 App 顶层挂载一次（与 useComputerUsePip 并列）。
 */
export function useAgentHalo(): void {
  const lifecycleRef = useRef<{
    ownerSessionId: string | null;
    phase: 'hidden' | 'showing' | 'shown';
    generation: number;
  }>({ ownerSessionId: null, phase: 'hidden', generation: 0 });
  const idleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;

    const clearIdleTimer = () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };

    const hide = (sessionId: string | null, force = false) => {
      const lifecycle = lifecycleRef.current;
      if (!force && (!sessionId || lifecycle.ownerSessionId !== sessionId)) return;
      clearIdleTimer();
      if (lifecycle.phase === 'hidden') return;
      lifecycle.generation += 1;
      lifecycle.ownerSessionId = null;
      lifecycle.phase = 'hidden';
      void invokeNativeCommandAction('hideAgentHalo').catch(() => {});
    };

    const scheduleIdle = (sessionId: string, generation: number) => {
      if (disposed) return;
      const lifecycle = lifecycleRef.current;
      if (
        lifecycle.phase !== 'shown'
        || lifecycle.ownerSessionId !== sessionId
        || lifecycle.generation !== generation
      ) {
        return;
      }
      clearIdleTimer();
      idleTimerRef.current = window.setTimeout(() => {
        idleTimerRef.current = null;
        const current = lifecycleRef.current;
        if (
          !disposed
          && current.phase === 'shown'
          && current.ownerSessionId === sessionId
          && current.generation === generation
        ) {
          void invokeNativeCommandAction('setAgentHaloMode', { mode: 'idle' }).catch(() => {});
        }
      }, ACTIVE_HOLD_MS);
    };

    const setActive = async (sessionId: string, generation: number) => {
      clearIdleTimer();
      try {
        await invokeNativeCommandAction('setAgentHaloMode', { mode: 'active' });
        scheduleIdle(sessionId, generation);
      } catch {
        // Tauri 不可用 → 忽略，不影响主流程
      }
    };

    const claimAndShow = async (sessionId: string) => {
      const lifecycle = lifecycleRef.current;
      lifecycle.ownerSessionId = sessionId;
      lifecycle.phase = 'showing';
      const generation = ++lifecycle.generation;

      try {
        await invokeNativeCommandAction('showAgentHalo');
      } catch {
        const current = lifecycleRef.current;
        if (
          current.phase === 'showing'
          && current.ownerSessionId === sessionId
          && current.generation === generation
        ) {
          current.generation += 1;
          current.ownerSessionId = null;
          current.phase = 'hidden';
          clearIdleTimer();
        }
        return;
      }

      const current = lifecycleRef.current;
      if (
        disposed
        || current.phase !== 'showing'
        || current.ownerSessionId !== sessionId
        || current.generation !== generation
      ) {
        if (disposed || current.phase === 'hidden') {
          void invokeNativeCommandAction('hideAgentHalo').catch(() => {});
        }
        return;
      }

      current.phase = 'shown';
      await setActive(sessionId, generation);
    };

    const markActive = (
      sessionId: string,
      capability: AgentPointerNativeCursorCapability,
    ) => {
      const lifecycle = lifecycleRef.current;
      if (lifecycle.phase === 'hidden') {
        if (
          capability.enabled !== true
          || capability.status !== 'native'
          || capability.provider !== 'cua-driver'
          || capability.supportsSystemOverlay !== true
        ) {
          return;
        }
        void claimAndShow(sessionId);
        return;
      }
      if (lifecycle.ownerSessionId !== sessionId || lifecycle.phase === 'showing') return;
      if (capability.status !== 'native' && capability.status !== 'fallback') return;

      const generation = ++lifecycle.generation;
      void setActive(sessionId, generation);
    };

    const unsubscribe = ipcService.on(IPC_CHANNELS.AGENT_EVENT, (event) => {
      if (disposed) return;
      if (event.type === 'tool_call_end') {
        const data = event.data as { metadata?: Record<string, unknown> };
        const metadata = data.metadata;
        const pointer = extractAgentPointerEvent(event.data);
        const directCapability = parseAgentPointerNativeCursorCapability(
          metadata?.agentPointerNativeCursor,
        );
        const legacyCapability = pointer?.surface === 'computer'
          ? parseAgentPointerNativeCursorCapability(pointer.nativeCursor)
          : null;
        const capability = directCapability || legacyCapability;
        const sessionId = typeof event.sessionId === 'string' && event.sessionId.trim()
          ? event.sessionId
          : null;
        const isCuaDriver = metadata?.serverName === 'cua-driver'
          || legacyCapability?.provider === 'cua-driver';

        if (!sessionId || !isCuaDriver) return;
        if (metadata?.toolName === 'end_session') {
          hide(sessionId);
          return;
        }
        if (capability) markActive(sessionId, capability);
        return;
      }
      if (
        RUN_END_EVENTS.has(event.type)
        && (event.type !== 'error' || isTerminalAgentError(event.data))
      ) {
        hide(typeof event.sessionId === 'string' ? event.sessionId : null);
      }
    });

    return () => {
      disposed = true;
      unsubscribe?.();
      hide(lifecycleRef.current.ownerSessionId, true);
    };
  }, []);
}
