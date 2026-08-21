// ============================================================================
// ContextHealthDetailModal - 上下文健康明细弹窗
// 复用现成的 ContextHealthPanel（不新造面板组件），handlers 走共享
// useContextHealthActions。两个打开入口：ContextUsagePill 弹层的「查看明细」
// 按钮、context 深链（OPEN_CONTEXT_HEALTH_EVENT）。
// ============================================================================

import React from 'react';
import { Modal } from './primitives/Modal';
import { ContextHealthPanel } from './ContextHealthPanel';
import { useI18n } from '../hooks/useI18n';
import { useAppStore } from '../stores/appStore';
import { useContextHealthActions } from '../hooks/useContextHealthActions';

interface ContextHealthDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ContextHealthDetailModal: React.FC<ContextHealthDetailModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { t } = useI18n();
  const ch = t.taskStatusPanels.contextHealth;
  const contextHealth = useAppStore((s) => s.contextHealth);
  const { handleNavigate, handleUnload, handleCompact, isCompacting } = useContextHealthActions();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={ch.detailModalTitle}
      size="lg"
      portal
    >
      {contextHealth ? (
        <ContextHealthPanel
          health={contextHealth}
          collapsed={false}
          onNavigate={handleNavigate}
          onUnload={handleUnload}
          onCompact={handleCompact}
          isCompacting={isCompacting}
        />
      ) : (
        <div className="py-6 text-sm text-zinc-500">
          <p>{ch.emptyStateTitle}</p>
          <p className="mt-2 text-xs text-zinc-600">
            {ch.emptyStateHint}
          </p>
        </div>
      )}
    </Modal>
  );
};

export default ContextHealthDetailModal;
