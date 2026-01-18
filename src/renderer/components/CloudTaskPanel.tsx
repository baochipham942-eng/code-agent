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
    <div className="w-80 border-l border-zinc-800 bg-zinc-900 flex flex-col">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-200">云端任务</h3>
        <button
          onClick={onClose}
          className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 rounded transition-colors"
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
