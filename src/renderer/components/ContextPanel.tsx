// ============================================================================
// ContextPanel - 右侧 Context Tab 容器
// 挂载 ContextHealthPanel 并提供面板级 padding/scroll；
// navigate/unload/compact handlers 走共享 hook useContextHealthActions
// （与 ContextUsagePill 的明细 modal 同一份逻辑）。
// ============================================================================

import React from 'react';
import { useI18n } from '../hooks/useI18n';
import { useAppStore } from '../stores/appStore';
import { useContextHealthActions } from '../hooks/useContextHealthActions';
import { ContextHealthPanel } from './ContextHealthPanel';

export const ContextPanel: React.FC = () => {
  const { t } = useI18n();
  const ch = t.taskStatusPanels.contextHealth;
  const contextHealth = useAppStore((s) => s.contextHealth);
  const { handleNavigate, handleUnload, handleCompact, isCompacting } = useContextHealthActions();

  return (
    <div className="h-full overflow-y-auto bg-zinc-950">
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
        <div className="p-6 text-sm text-zinc-500">
          <p>{ch.emptyStateTitle}</p>
          <p className="mt-2 text-xs text-zinc-600">
            {ch.emptyStateHint}
          </p>
        </div>
      )}
    </div>
  );
};
