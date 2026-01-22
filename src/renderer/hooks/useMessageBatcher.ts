// ============================================================================
// useMessageBatcher - Message Batch Processing Hook
// ============================================================================
// 用于减少流式输出时的重渲染频率，提升性能

import { useRef, useCallback, useEffect, useState } from 'react';
import type { ToolCall } from '@shared/types';

// ============================================================================
// Types
// ============================================================================

export interface MessageBatcherConfig {
  /** 批处理间隔 (ms)，默认 50ms */
  batchInterval: number;
  /** 最大批处理数量，默认 10 */
  maxBatchSize: number;
}

export type MessageUpdate = {
  type: 'append' | 'replace' | 'complete';
  messageId: string;
  content?: string;
  toolCalls?: ToolCall[];
};

export interface MessageBatcherReturn {
  /** 添加待处理的消息更新 */
  queueUpdate: (update: MessageUpdate) => void;
  /** 强制刷新所有待处理更新 */
  flush: () => void;
  /** 待处理更新数量 */
  pendingCount: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: MessageBatcherConfig = {
  batchInterval: 50,
  maxBatchSize: 10,
};

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * 消息批处理 Hook
 *
 * 用于减少流式输出时的重渲染频率，将多次消息更新合并为单次批量更新。
 *
 * @param onBatchUpdate - 批量更新回调，接收合并后的更新数组
 * @param config - 批处理配置
 *
 * @example
 * ```tsx
 * const { queueUpdate, flush, pendingCount } = useMessageBatcher(
 *   (updates) => {
 *     // 处理批量更新
 *     updates.forEach(update => {
 *       if (update.type === 'append') {
 *         appendToMessage(update.messageId, update.content);
 *       }
 *     });
 *   },
 *   { batchInterval: 50, maxBatchSize: 10 }
 * );
 *
 * // 在流式接收时调用
 * queueUpdate({ type: 'append', messageId: 'msg-1', content: 'Hello' });
 * ```
 */
export function useMessageBatcher(
  onBatchUpdate: (updates: MessageUpdate[]) => void,
  config: Partial<MessageBatcherConfig> = {}
): MessageBatcherReturn {
  const mergedConfig: MessageBatcherConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  // 待处理消息队列
  const queueRef = useRef<MessageUpdate[]>([]);
  // 定时器 ID
  const timerRef = useRef<number | null>(null);
  // 回调引用（避免闭包问题）
  const onBatchUpdateRef = useRef(onBatchUpdate);
  // 待处理数量状态（用于外部监控）
  const [pendingCount, setPendingCount] = useState(0);

  // 保持回调引用最新
  useEffect(() => {
    onBatchUpdateRef.current = onBatchUpdate;
  }, [onBatchUpdate]);

  /**
   * 执行批量更新
   * 合并相同 messageId 的更新，减少重复处理
   */
  const processBatch = useCallback(() => {
    if (queueRef.current.length === 0) {
      return;
    }

    // 取出当前队列中的所有更新
    const updates = queueRef.current;
    queueRef.current = [];

    // 合并相同 messageId 的 append 类型更新
    const mergedUpdates = mergeUpdates(updates);

    // 更新待处理数量
    setPendingCount(0);

    // 执行回调
    onBatchUpdateRef.current(mergedUpdates);

    // 清除定时器
    if (timerRef.current !== null) {
      cancelAnimationFrame(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * 调度批量更新
   * 使用 requestAnimationFrame 确保在下一帧执行
   */
  const scheduleBatch = useCallback(() => {
    if (timerRef.current !== null) {
      return; // 已有调度中的更新
    }

    timerRef.current = requestAnimationFrame(() => {
      // 使用 setTimeout 实现配置的批处理间隔
      setTimeout(() => {
        processBatch();
      }, mergedConfig.batchInterval);
    });
  }, [processBatch, mergedConfig.batchInterval]);

  /**
   * 添加待处理的消息更新
   */
  const queueUpdate = useCallback(
    (update: MessageUpdate) => {
      queueRef.current.push(update);
      const currentCount = queueRef.current.length;
      setPendingCount(currentCount);

      // 如果达到最大批处理数量，立即处理
      if (currentCount >= mergedConfig.maxBatchSize) {
        processBatch();
      } else {
        scheduleBatch();
      }
    },
    [processBatch, scheduleBatch, mergedConfig.maxBatchSize]
  );

  /**
   * 强制刷新所有待处理更新
   */
  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      cancelAnimationFrame(timerRef.current);
      timerRef.current = null;
    }
    processBatch();
  }, [processBatch]);

  // 组件卸载时自动 flush
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        cancelAnimationFrame(timerRef.current);
      }
      // 确保所有待处理更新被处理
      if (queueRef.current.length > 0) {
        onBatchUpdateRef.current(mergeUpdates(queueRef.current));
        queueRef.current = [];
      }
    };
  }, []);

  return {
    queueUpdate,
    flush,
    pendingCount,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 合并相同 messageId 的更新
 * - append 类型：合并 content，合并 toolCalls
 * - replace 类型：保留最后一个
 * - complete 类型：保留最后一个
 */
function mergeUpdates(updates: MessageUpdate[]): MessageUpdate[] {
  const updateMap = new Map<string, MessageUpdate>();

  for (const update of updates) {
    const key = `${update.messageId}:${update.type}`;
    const existing = updateMap.get(key);

    if (!existing) {
      // 首次遇到此 messageId + type 组合
      updateMap.set(key, { ...update });
    } else if (update.type === 'append') {
      // 合并 append 类型的更新
      existing.content = (existing.content || '') + (update.content || '');
      if (update.toolCalls) {
        existing.toolCalls = [...(existing.toolCalls || []), ...update.toolCalls];
      }
    } else {
      // replace 和 complete 类型保留最后一个
      updateMap.set(key, { ...update });
    }
  }

  return Array.from(updateMap.values());
}

export default useMessageBatcher;
