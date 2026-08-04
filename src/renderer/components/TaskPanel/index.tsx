// ============================================================================
// TaskPanel - Right-side panel
// ----------------------------------------------------------------------------
// 主视图：概览四模块（任务 / Todo / 上下文 / 产物）
// ============================================================================

import React from 'react';
import { TaskWorkspaceOverview } from './TaskWorkspaceOverview';

export const TaskPanel: React.FC = () => {
  return (
    <div className="w-full h-full bg-zinc-900 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4">
        <TaskWorkspaceOverview />
      </div>
    </div>
  );
};

export default TaskPanel;
