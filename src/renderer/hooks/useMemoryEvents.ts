// ============================================================================
// useMemoryEvents Hook - Gen5+ Memory 事件监听
// ============================================================================

import { useEffect, useCallback } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AgentEvent, MemoryLearnedData } from '@shared/types';
import { createLogger } from '../utils/logger';

const logger = createLogger('useMemoryEvents');

export interface MemoryEventCallbacks {
  /** 当 Memory 系统学习完成时调用 */
  onMemoryLearned?: (data: MemoryLearnedData) => void;
}

/**
 * 监听 Memory 相关的 Agent 事件
 *
 * @example
 * ```tsx
 * useMemoryEvents({
 *   onMemoryLearned: (data) => {
 *     console.log(`学习了 ${data.knowledgeExtracted} 条知识`);
 *   },
 * });
 * ```
 */
export function useMemoryEvents(callbacks: MemoryEventCallbacks = {}): void {
  const { onMemoryLearned } = callbacks;

  const handleAgentEvent = useCallback(
    (event: AgentEvent) => {
      if (event.type === 'memory_learned' && onMemoryLearned) {
        const data = event.data;
        logger.info('Memory learned event received', {
          sessionId: data.sessionId,
          knowledgeExtracted: data.knowledgeExtracted,
          codeStylesLearned: data.codeStylesLearned,
          toolPreferencesUpdated: data.toolPreferencesUpdated,
        });
        onMemoryLearned(data);
      }
    },
    [onMemoryLearned]
  );

  useEffect(() => {
    const unsubscribe = window.electronAPI?.on(
      IPC_CHANNELS.AGENT_EVENT,
      handleAgentEvent
    );

    return () => {
      unsubscribe?.();
    };
  }, [handleAgentEvent]);
}

export default useMemoryEvents;
