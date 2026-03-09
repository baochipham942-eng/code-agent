// ============================================================================
// CloudTaskPanel - 云端任务面板
// 显示和管理云端执行的任务
// ============================================================================

import React from 'react';
import { X } from 'lucide-react';
import { CloudTaskList } from './CloudTaskList';
import { useCloudTasks } from '../hooks/useCloudTasks';

interface CloudTaskPanelProps {
  onClose: () => void;
}

export const CloudTaskPanel: React.FC<CloudTaskPanelProps> = ({ onClose }) => {
  const {
    tasks,
    isLoading,
    startTask,
    pauseTask,
    cancelTask,
    retryTask,
    deleteTask,
    refresh,
  } = useCloudTasks();

  return (
    <div className="w-80 border-l border-border-default bg-deep flex flex-col">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-default">
        <h3 className="text-sm font-medium text-text-primary">云端任务</h3>
        <button
          onClick={onClose}
          className="p-1 text-text-secondary hover:text-text-primary hover:bg-hover rounded transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 任务列表 */}
      <div className="flex-1 overflow-hidden">
        <CloudTaskList
          tasks={tasks}
          isLoading={isLoading}
          onStartTask={startTask}
          onPauseTask={pauseTask}
          onCancelTask={cancelTask}
          onRetryTask={retryTask}
          onDeleteTask={deleteTask}
          onRefresh={refresh}
        />
      </div>
    </div>
  );
};
