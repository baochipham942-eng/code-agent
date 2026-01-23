// ============================================================================
// useMemoryLearning Hook - Phase 3 学习事件监听
// 监听 AI 学习事件，显示 toast 通知，处理低置信度确认
// ============================================================================

import { useEffect, useCallback, useState } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { MemoryLearnedEvent, MemoryConfirmRequest } from '@shared/types/memory';
import { useUIStore } from '../stores/uiStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('useMemoryLearning');

/**
 * 待确认的记忆请求
 */
export interface PendingMemoryConfirm {
  id: string;
  content: string;
  category: string;
  type: string;
  confidence: number;
  timestamp: number;
}

/**
 * 分类标签映射
 */
const CATEGORY_LABELS: Record<string, string> = {
  about_me: '关于我',
  preference: '偏好',
  frequent_info: '常用信息',
  learned: '经验',
};

/**
 * 学习类型标签映射
 */
const TYPE_LABELS: Record<string, string> = {
  code_style: '代码风格',
  pattern: '模式',
  preference: '偏好',
  error_solution: '错误解决方案',
  project_rule: '项目规则',
  memory_store: '记忆存储',
};

/**
 * Memory Learning Hook
 * 监听 AI 学习事件，显示 toast，处理确认请求
 */
export function useMemoryLearning() {
  const showToast = useUIStore((state) => state.showToast);
  const [pendingConfirms, setPendingConfirms] = useState<PendingMemoryConfirm[]>([]);

  /**
   * 处理学习完成事件
   */
  const handleMemoryLearned = useCallback(
    (event: MemoryLearnedEvent) => {
      logger.info('Memory learned event received', { id: event.id, category: event.category });

      const contentPreview = event.content.length > 50
        ? event.content.slice(0, 50) + '...'
        : event.content;

      // 显示 toast 通知
      showToast(
        'info',
        `我记住了: ${contentPreview}`,
        5000 // 5 秒后自动消失
      );

      logger.debug('Toast shown for memory learned');
    },
    [showToast]
  );

  /**
   * 处理确认请求事件
   */
  const handleConfirmRequest = useCallback(
    (request: MemoryConfirmRequest) => {
      logger.info('Memory confirm request received', { id: request.id, category: request.category });

      setPendingConfirms((prev) => [
        ...prev,
        {
          id: request.id,
          content: request.content,
          category: request.category,
          type: request.type,
          confidence: request.confidence,
          timestamp: request.timestamp,
        },
      ]);
    },
    []
  );

  /**
   * 响应确认请求
   */
  const respondToConfirm = useCallback(async (id: string, confirmed: boolean) => {
    logger.info('Responding to memory confirm', { id, confirmed });

    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.MEMORY_CONFIRM_RESPONSE, { id, confirmed });

      // 从待确认列表中移除
      setPendingConfirms((prev) => prev.filter((p) => p.id !== id));

      // 显示反馈
      if (confirmed) {
        showToast('success', '已确认并保存', 3000);
      } else {
        showToast('info', '已跳过', 3000);
      }
    } catch (error) {
      logger.error('Failed to respond to confirm', error);
      showToast('error', '响应失败', 3000);
    }
  }, [showToast]);

  /**
   * 确认保存
   */
  const confirmMemory = useCallback(
    (id: string) => respondToConfirm(id, true),
    [respondToConfirm]
  );

  /**
   * 拒绝保存
   */
  const declineMemory = useCallback(
    (id: string) => respondToConfirm(id, false),
    [respondToConfirm]
  );

  /**
   * 设置事件监听器
   */
  useEffect(() => {
    if (!window.electronAPI) {
      logger.warn('electronAPI not available');
      return;
    }

    // 监听学习完成事件
    const unsubscribeLearned = window.electronAPI.on(
      IPC_CHANNELS.MEMORY_LEARNED,
      handleMemoryLearned
    );

    // 监听确认请求事件
    const unsubscribeConfirm = window.electronAPI.on(
      IPC_CHANNELS.MEMORY_CONFIRM_REQUEST,
      handleConfirmRequest
    );

    logger.info('Memory learning listeners registered');

    return () => {
      unsubscribeLearned();
      unsubscribeConfirm();
      logger.info('Memory learning listeners unregistered');
    };
  }, [handleMemoryLearned, handleConfirmRequest]);

  return {
    pendingConfirms,
    confirmMemory,
    declineMemory,
  };
}

/**
 * 获取分类标签
 */
export function getCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] || category;
}

/**
 * 获取类型标签
 */
export function getTypeLabel(type: string): string {
  return TYPE_LABELS[type] || type;
}
