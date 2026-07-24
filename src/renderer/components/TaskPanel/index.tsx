// ============================================================================
// TaskPanel - Right-side panel
// ----------------------------------------------------------------------------
// 主视图：Task-first 状态栏
// ============================================================================

import React from 'react';
import type { AgentTreeSnapshot } from '@shared/contract/agentTree';
import { TaskMonitor } from './TaskMonitor';
import { AgentTreeView } from '../features/agentTree/AgentTreeView';

export interface TaskPanelProps {
  agentTreeSnapshot?: AgentTreeSnapshot | null;
}

export const TaskPanel: React.FC<TaskPanelProps> = ({ agentTreeSnapshot }) => {
  return (
    <div className="w-full h-full bg-zinc-900 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <AgentTreeView snapshot={agentTreeSnapshot} />
        <TaskMonitor />
      </div>
    </div>
  );
};

export default TaskPanel;
