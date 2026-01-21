// ============================================================================
// MemoryLearningProvider - Phase 3 学习通知和确认管理
// 在 App 级别监听学习事件，管理确认弹窗队列
// ============================================================================

import React from 'react';
import { useMemoryLearning } from '../../../hooks/useMemoryLearning';
import { MemoryConfirmModal } from './MemoryConfirmModal';

/**
 * Memory Learning Provider
 * 在 App 级别提供学习通知和确认功能
 */
export const MemoryLearningProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { pendingConfirms, confirmMemory, declineMemory } = useMemoryLearning();

  // 只显示第一个待确认请求（队列处理）
  const currentRequest = pendingConfirms.length > 0 ? pendingConfirms[0] : null;

  return (
    <>
      {children}

      {/* 确认弹窗 - 只显示第一个 */}
      {currentRequest && (
        <MemoryConfirmModal
          request={currentRequest}
          onConfirm={() => confirmMemory(currentRequest.id)}
          onDecline={() => declineMemory(currentRequest.id)}
        />
      )}
    </>
  );
};

export default MemoryLearningProvider;
