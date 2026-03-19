// ============================================================================
// TaskPanel - Right-side task panel (QoderWork-style TaskMonitor)
// ============================================================================

import React from 'react';
import { TaskMonitor } from './TaskMonitor';
import { useI18n } from '../../hooks/useI18n';

export const TaskPanel: React.FC = () => {
  const { t } = useI18n();

  return (
    <div className="w-full h-full border-l border-white/[0.06] bg-zinc-900 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
        <span className="text-sm font-medium text-zinc-400">{t.taskPanel.title}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <TaskMonitor />
      </div>
    </div>
  );
};

export default TaskPanel;
