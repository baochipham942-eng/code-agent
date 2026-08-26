// ============================================================================
// TaskPanel - Right-side panel
// ----------------------------------------------------------------------------
// 只承载「任务」内容。日志与专家已提升到 Workbench 一级页签，内容分别继续
// 复用 SessionInspector / SessionAgentsPanel，不再在这里套二级页签。
// ============================================================================

import React from 'react';
import { TaskWorkspaceOverview } from './TaskWorkspaceOverview';

export const TaskPanel: React.FC<{ overviewContent?: React.ReactNode }> = ({ overviewContent }) => {
  return (
    <div className="w-full h-full bg-zinc-900 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4">
        {overviewContent ?? <TaskWorkspaceOverview />}
      </div>
    </div>
  );
};
