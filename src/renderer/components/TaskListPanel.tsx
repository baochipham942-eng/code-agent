// ============================================================================
// TaskListPanel - 本地多任务面板
// Wave 5: 显示运行中和排队中的会话任务
// ============================================================================

import React, { useEffect } from 'react';
import { X, PlayCircle, Pause, XCircle, RefreshCw, Clock, Zap } from 'lucide-react';
import { useTaskStore, getStatusLabel, getStatusColor, type SessionStatus } from '../stores/taskStore';
import { useSessionStore } from '../stores/sessionStore';

interface TaskListPanelProps {
  onClose: () => void;
}

interface TaskItemProps {
  sessionId: string;
  title: string;
  status: SessionStatus;
  queuePosition?: number;
  startTime?: number;
  error?: string;
  onInterrupt: () => void;
  onCancel: () => void;
  onClick: () => void;
  isActive: boolean;
}

const TaskItem: React.FC<TaskItemProps> = ({
  sessionId,
  title,
  status,
  queuePosition,
  startTime,
  error,
  onInterrupt,
  onCancel,
  onClick,
  isActive,
}) => {
  const statusColor = getStatusColor(status);
  const statusLabel = getStatusLabel(status);

  // 计算运行时间
  const runningTime = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
  const formatTime = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  return (
    <div
      className={`
        px-3 py-2 border-b border-zinc-800 cursor-pointer
        hover:bg-zinc-800/50 transition-colors
        ${isActive ? 'bg-zinc-800/70 border-l-2 border-l-blue-500' : ''}
      `}
      onClick={onClick}
    >
      {/* 标题行 */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm text-zinc-200 truncate flex-1">{title}</span>
        <div className="flex items-center gap-1 ml-2">
          {/* 状态指示器 */}
          {status === 'running' && (
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          )}
          {status === 'queued' && (
            <span className="w-2 h-2 rounded-full bg-yellow-500" />
          )}
          {status === 'cancelling' && (
            <span className="w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
          )}
          {status === 'error' && (
            <span className="w-2 h-2 rounded-full bg-red-500" />
          )}
        </div>
      </div>

      {/* 状态信息 */}
      <div className="flex items-center justify-between text-xs">
        <span className={statusColor}>{statusLabel}</span>
        <div className="flex items-center gap-2">
          {status === 'queued' && queuePosition !== undefined && (
            <span className="text-zinc-500">#{queuePosition}</span>
          )}
          {status === 'running' && startTime && (
            <span className="text-zinc-500 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatTime(runningTime)}
            </span>
          )}
          {error && (
            <span className="text-red-400 truncate max-w-[100px]" title={error}>
              {error}
            </span>
          )}
        </div>
      </div>

      {/* 操作按钮 */}
      {(status === 'running' || status === 'queued') && (
        <div className="flex items-center gap-1 mt-2" onClick={(e) => e.stopPropagation()}>
          {status === 'running' && (
            <button
              onClick={onInterrupt}
              className="p-1 text-zinc-400 hover:text-yellow-400 hover:bg-zinc-700/50 rounded transition-colors"
              title="中断（等待当前工具完成）"
            >
              <Pause className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={onCancel}
            className="p-1 text-zinc-400 hover:text-red-400 hover:bg-zinc-700/50 rounded transition-colors"
            title="取消"
          >
            <XCircle className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};

export const TaskListPanel: React.FC<TaskListPanelProps> = ({ onClose }) => {
  const {
    sessionStates,
    stats,
    initialized,
    refreshStates,
    refreshStats,
    interruptTask,
    cancelTask,
  } = useTaskStore();

  const { sessions, currentSessionId, switchSession } = useSessionStore();

  // 初始化时刷新状态
  useEffect(() => {
    if (!initialized) {
      refreshStates();
      refreshStats();
    }

    // 定期刷新（每 5 秒）
    const interval = setInterval(() => {
      refreshStates();
      refreshStats();
    }, 5000);

    return () => clearInterval(interval);
  }, [initialized, refreshStates, refreshStats]);

  // 获取活跃任务（运行中或排队中）
  const activeTasks = Object.entries(sessionStates)
    .filter(([_, state]) => state.status === 'running' || state.status === 'queued')
    .map(([sessionId, state]) => {
      const session = sessions.find((s) => s.id === sessionId);
      return {
        sessionId,
        title: session?.title || '未知会话',
        ...state,
      };
    })
    // 运行中的排前面，然后按队列位置排序
    .sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (a.status !== 'running' && b.status === 'running') return 1;
      return (a.queuePosition || 0) - (b.queuePosition || 0);
    });

  const handleRefresh = () => {
    refreshStates();
    refreshStats();
  };

  return (
    <div className="w-72 border-l border-zinc-800 bg-zinc-900 flex flex-col">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-200 flex items-center gap-2">
          <Zap className="w-4 h-4 text-yellow-500" />
          运行中的任务
        </h3>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRefresh}
            className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 rounded transition-colors"
            title="刷新"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 统计信息 */}
      <div className="px-3 py-2 border-b border-zinc-800 bg-zinc-800/30">
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span>并发: {stats.running}/{stats.maxConcurrent}</span>
          <span>队列: {stats.queued}</span>
          <span>可用: {stats.available}</span>
        </div>
      </div>

      {/* 任务列表 */}
      <div className="flex-1 overflow-y-auto">
        {activeTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-500 text-sm">
            <PlayCircle className="w-8 h-8 mb-2 opacity-50" />
            <p>没有运行中的任务</p>
            <p className="text-xs mt-1">发送消息后任务将显示在这里</p>
          </div>
        ) : (
          activeTasks.map((task) => (
            <TaskItem
              key={task.sessionId}
              sessionId={task.sessionId}
              title={task.title}
              status={task.status}
              queuePosition={task.queuePosition}
              startTime={task.startTime}
              error={task.error}
              onInterrupt={() => interruptTask(task.sessionId)}
              onCancel={() => cancelTask(task.sessionId)}
              onClick={() => switchSession(task.sessionId)}
              isActive={task.sessionId === currentSessionId}
            />
          ))
        )}
      </div>

      {/* 底部说明 */}
      <div className="px-3 py-2 border-t border-zinc-800 text-xs text-zinc-500">
        最多同时运行 {stats.maxConcurrent} 个任务
      </div>
    </div>
  );
};
