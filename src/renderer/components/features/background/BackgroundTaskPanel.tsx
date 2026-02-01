// ============================================================================
// Background Task Panel - 后台任务浮动面板
// ============================================================================

import React from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { Play, CheckCircle, XCircle, Loader2, X } from 'lucide-react';
import type { BackgroundTaskInfo } from '@shared/types/sessionState';

/**
 * 格式化持续时间
 */
function formatDuration(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours}小时${minutes % 60}分钟`;
}

/**
 * 单个后台任务项
 */
const BackgroundTaskItem: React.FC<{
  task: BackgroundTaskInfo;
  onForeground: () => void;
}> = ({ task, onForeground }) => {
  const statusIcon = {
    running: <Loader2 className="w-4 h-4 animate-spin text-blue-400" />,
    completed: <CheckCircle className="w-4 h-4 text-green-400" />,
    failed: <XCircle className="w-4 h-4 text-red-400" />,
  }[task.status];

  return (
    <button
      onClick={onForeground}
      className="w-full flex items-center gap-3 p-3 bg-zinc-800/80 hover:bg-zinc-700/80 rounded-lg transition-colors text-left"
    >
      {statusIcon}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-zinc-100 truncate">
          {task.title}
        </div>
        <div className="text-xs text-zinc-400">
          {task.status === 'running' && formatDuration(task.startedAt)}
          {task.status === 'completed' && (task.completionMessage || '已完成')}
          {task.status === 'failed' && (task.completionMessage || '执行失败')}
        </div>
        {task.progress !== undefined && task.status === 'running' && (
          <div className="mt-1 h-1 bg-zinc-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${task.progress}%` }}
            />
          </div>
        )}
      </div>
      <Play className="w-4 h-4 text-zinc-500" />
    </button>
  );
};

/**
 * 后台任务浮动面板
 * 显示在右下角，展示所有后台运行的任务
 */
export const BackgroundTaskPanel: React.FC = () => {
  const { backgroundTasks, moveToForeground } = useSessionStore();
  const [isMinimized, setIsMinimized] = React.useState(false);

  // 没有后台任务时不显示
  if (backgroundTasks.length === 0) {
    return null;
  }

  // 最小化时只显示数量
  if (isMinimized) {
    return (
      <button
        onClick={() => setIsMinimized(false)}
        className="fixed bottom-4 right-4 flex items-center gap-2 px-3 py-2 bg-zinc-800/90 hover:bg-zinc-700/90 backdrop-blur-sm border border-zinc-700 rounded-full shadow-lg transition-colors z-50"
      >
        <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
        <span className="text-sm text-zinc-100">
          {backgroundTasks.length} 个后台任务
        </span>
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 w-80 bg-zinc-900/95 backdrop-blur-sm border border-zinc-700 rounded-xl shadow-2xl z-50">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
        <h3 className="text-sm font-medium text-zinc-100">后台任务</h3>
        <button
          onClick={() => setIsMinimized(true)}
          className="p-1 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 rounded transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Task List */}
      <div className="p-2 space-y-2 max-h-80 overflow-y-auto">
        {backgroundTasks.map((task) => (
          <BackgroundTaskItem
            key={task.sessionId}
            task={task}
            onForeground={() => moveToForeground(task.sessionId)}
          />
        ))}
      </div>

      {/* Footer hint */}
      <div className="px-4 py-2 border-t border-zinc-700">
        <p className="text-xs text-zinc-500">点击任务切换到前台</p>
      </div>
    </div>
  );
};

export default BackgroundTaskPanel;
