// ============================================================================
// TaskPanel - Right-side panel
// ----------------------------------------------------------------------------
// 主视图：Task-first 状态栏
// ============================================================================

import React from 'react';
import { TaskMonitor } from './TaskMonitor';

export const TaskPanel: React.FC = () => {
  return (
    <div className="w-full h-full bg-zinc-900 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <TaskMonitor />
      </div>
    </div>
  );
};

export default TaskPanel;
