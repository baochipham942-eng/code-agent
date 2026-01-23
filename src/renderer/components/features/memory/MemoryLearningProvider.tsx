// ============================================================================
// MemoryLearningProvider - 记忆学习通知 Provider
// 包装应用以提供记忆学习通知功能
// ============================================================================

import React from 'react';
import { useMemoryLearning } from '../../../hooks/useMemoryLearning';
import { MemoryConfirmModal } from './MemoryConfirmModal';

interface MemoryLearningProviderProps {
  children: React.ReactNode;
}

export const MemoryLearningProvider: React.FC<MemoryLearningProviderProps> = ({
  children,
}) => {
  const { pendingConfirms, confirmMemory, declineMemory } = useMemoryLearning();

  // 只显示第一个待确认的记忆
  const currentPending = pendingConfirms[0] || null;

  return (
    <>
      {children}
      <MemoryConfirmModal
        pending={currentPending}
        onConfirm={confirmMemory}
        onDecline={declineMemory}
      />
    </>
  );
};
