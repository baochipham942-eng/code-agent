// ============================================================================
// useToolProgress - Shared hook for IPC tool progress event subscription
// ============================================================================
// Extracted from Progress.tsx and TaskMonitor.tsx to eliminate duplication.
// Manages toolProgress and toolTimeout state via agent:event IPC subscription.
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import type { ToolProgressData, ToolTimeoutData, AgentEvent } from '@shared/contract';
import ipcService from '../../services/ipcService';

interface UseToolProgressResult {
  toolProgress: ToolProgressData | null;
  toolTimeout: ToolTimeoutData | null;
}

/**
 * Subscribe to IPC agent events for tool progress and timeout tracking.
 * Resets state when currentSessionId changes, and filters events by session.
 */
export function useToolProgress(currentSessionId: string | null): UseToolProgressResult {
  const [toolProgress, setToolProgress] = useState<ToolProgressData | null>(null);
  const [toolTimeout, setToolTimeout] = useState<ToolTimeoutData | null>(null);

  const handleAgentEvent = useCallback((event: AgentEvent & { sessionId?: string }) => {
    if (event.sessionId && currentSessionId && event.sessionId !== currentSessionId) {
      return;
    }

    switch (event.type) {
      case 'tool_progress':
        if (event.data) {
          setToolProgress(event.data as ToolProgressData);
        }
        break;
      case 'tool_timeout':
        if (event.data) {
          setToolTimeout(event.data as ToolTimeoutData);
        }
        break;
      case 'tool_call_end':
        if (event.data) {
          const toolCallId = (event.data as { toolCallId?: string }).toolCallId;
          setToolProgress((prev) => prev?.toolCallId === toolCallId ? null : prev);
          setToolTimeout((prev) => prev?.toolCallId === toolCallId ? null : prev);
        }
        break;
      case 'agent_complete':
      case 'agent_cancelled':
        setToolProgress(null);
        setToolTimeout(null);
        break;
    }
  }, [currentSessionId]);

  // Reset on session change
  useEffect(() => {
    setToolProgress(null);
    setToolTimeout(null);
  }, [currentSessionId]);

  // Subscribe to IPC events
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): 'agent:event' 不在 IpcChannel 联合里（实际是 BrowserWindow 转发的 webContents 事件名），应在 IPC 通道注册表里加上 agent:event 或换 ipcService.subscribe 兜底入口
    const unsubscribe = ipcService.on('agent:event' as any, handleAgentEvent);
    return () => {
      unsubscribe?.();
    };
  }, [handleAgentEvent]);

  return { toolProgress, toolTimeout };
}
