// ============================================================================
// TaskStatusBar - 多任务状态栏组件
// 显示当前运行中和排队中的任务状态
// ============================================================================

import React, { useEffect, useState, useMemo } from 'react';
import { Activity, Clock, Loader2, ChevronRight, Layers, GitBranch } from 'lucide-react';
import { useTaskStore, type SessionState } from '../../../stores/taskStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useAppStore } from '../../../stores/appStore';
import { useSwarmStore } from '../../../stores/swarmStore';

// ============================================================================
// Types
// ============================================================================

export interface TaskStatusBarProps {
  className?: string;
}

interface ActiveTask {
  sessionId: string;
  title: string;
  status: SessionState['status'];
  startTime?: number;
  queuePosition?: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 格式化运行时长
 */
function formatDuration(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours}h ${remainingMins}m`;
}

/**
 * 截断标题
 */
function truncateTitle(title: string, maxLength: number = 20): string {
  if (title.length <= maxLength) return title;
  return title.slice(0, maxLength - 3) + '...';
}

// ============================================================================
// TaskStatusBar Component
// ============================================================================

export const TaskStatusBar: React.FC<TaskStatusBarProps> = ({ className = '' }) => {
  const { sessionStates, stats, refreshStates, refreshStats, initialized } = useTaskStore();
  const { sessions, currentSessionId, switchSession } = useSessionStore();
  const {
    setShowTaskPanel,
    setTaskPanelTab,
    setShowAgentTeamPanel,
    selectedSwarmAgentId,
  } = useAppStore();
  const {
    executionPhase,
    statistics: swarmStats,
    isRunning,
    launchRequests,
    planReviews,
    agents,
  } = useSwarmStore();
  const selectedSwarmAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedSwarmAgentId) ?? null,
    [agents, selectedSwarmAgentId],
  );

  // 用于更新运行时间的定时器
  const [, setTick] = useState(0);

  // 初始化时刷新状态
  useEffect(() => {
    if (!initialized) {
      refreshStates();
      refreshStats();
    }
  }, [initialized, refreshStates, refreshStats]);

  // 定期更新显示（每秒更新运行时间）
  useEffect(() => {
    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // 获取活跃任务
  const activeTasks = useMemo<ActiveTask[]>(() => {
    return Object.entries(sessionStates)
      .filter(([_, state]) => state.status === 'running' || state.status === 'queued')
      .map(([sessionId, state]) => {
        const session = sessions.find((s) => s.id === sessionId);
        return {
          sessionId,
          title: session?.title || '未知会话',
          status: state.status,
          startTime: state.startTime,
          queuePosition: state.queuePosition,
        };
      })
      // 运行中的排前面，然后按队列位置排序
      .sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (a.status !== 'running' && b.status === 'running') return 1;
        return (a.queuePosition || 0) - (b.queuePosition || 0);
      });
  }, [sessionStates, sessions]);

  const runningCount = stats.running;
  const queuedCount = stats.queued;
  const pendingSwarmLaunches = launchRequests.filter((request) => request.status === 'pending').length;
  const pendingSwarmReviews = planReviews.filter((review) => review.status === 'pending').length;
  const hasSwarmActivity =
    isRunning || swarmStats.total > 0 || pendingSwarmLaunches > 0 || pendingSwarmReviews > 0;

  // 没有活跃任务时隐藏组件
  if (runningCount === 0 && queuedCount === 0 && !hasSwarmActivity) {
    return null;
  }

  const handleTaskClick = (sessionId: string) => {
    if (sessionId !== currentSessionId) {
      switchSession(sessionId);
    }
  };

  const openOrchestrationPanel = () => {
    setShowTaskPanel(true);
    setTaskPanelTab('orchestration');
  };

  const openSelectedSwarmAgent = () => {
    if (selectedSwarmAgent) {
      setShowAgentTeamPanel(true);
      return;
    }
    openOrchestrationPanel();
  };

  const swarmLabel = (() => {
    if (selectedSwarmAgent) return `选中 ${selectedSwarmAgent.name}`;
    if (pendingSwarmLaunches > 0) return `待启动 ${pendingSwarmLaunches}`;
    if (pendingSwarmReviews > 0) return `审批 ${pendingSwarmReviews}`;
    if (executionPhase === 'executing') return `${swarmStats.running}/${swarmStats.total} 执行`;
    if (executionPhase === 'completed') return `${swarmStats.completed}/${swarmStats.total} 完成`;
    if (executionPhase === 'failed') return `${swarmStats.failed} 失败`;
    return `${swarmStats.total} agents`;
  })();

  return (
    <div
      className={`
        flex items-center gap-3 px-3 py-1.5
        bg-zinc-800 border border-zinc-700 rounded-lg
        text-sm transition-all duration-300
        ${className}
      `}
    >
      {/* 统计概览 */}
      <div className="flex items-center gap-2 text-zinc-400 shrink-0">
        <Activity className="w-4 h-4 text-emerald-400" />
        <span className="text-zinc-400 font-medium">
          {runningCount}/{stats.maxConcurrent}
        </span>
        {queuedCount > 0 && (
          <>
            <span className="text-zinc-600">|</span>
            <Layers className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-amber-400">{queuedCount}</span>
          </>
        )}
      </div>

      {/* 分隔线 */}
      <div className="w-px h-4 bg-zinc-700" />

      {/* 活跃任务列表 */}
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-thin scrollbar-thumb-hover scrollbar-track-transparent">
        {activeTasks.map((task) => (
          <button
            key={task.sessionId}
            onClick={() => handleTaskClick(task.sessionId)}
            className={`
              flex items-center gap-1.5 px-2 py-0.5 rounded
              transition-all duration-200 shrink-0
              ${
                task.sessionId === currentSessionId
                  ? 'bg-primary-500/20 text-primary-400 border border-primary-500/30'
                  : 'hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200'
              }
            `}
            title={`${task.title}${task.startTime ? ` - ${formatDuration(task.startTime)}` : ''}`}
          >
            {/* 状态指示器 */}
            {task.status === 'running' ? (
              <Loader2 className="w-3 h-3 text-emerald-400 animate-spin" />
            ) : (
              <Clock className="w-3 h-3 text-amber-400" />
            )}

            {/* 会话名称 */}
            <span className="text-xs">{truncateTitle(task.title)}</span>

            {/* 运行时长或队列位置 */}
            {task.status === 'running' && task.startTime && (
              <span className="text-2xs text-zinc-500 ml-0.5">
                {formatDuration(task.startTime)}
              </span>
            )}
            {task.status === 'queued' && task.queuePosition !== undefined && (
              <span className="text-2xs text-amber-500 ml-0.5">#{task.queuePosition}</span>
            )}

            {/* 切换指示 */}
            {task.sessionId !== currentSessionId && (
              <ChevronRight className="w-3 h-3 text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity" />
            )}
          </button>
        ))}
      </div>

      {hasSwarmActivity && (
        <>
          <div className="w-px h-4 bg-zinc-700" />
          <button
            onClick={openSelectedSwarmAgent}
            className="flex items-center gap-1.5 rounded-md border border-primary-500/20 bg-primary-500/10 px-2 py-1 text-xs text-primary-300 transition-colors hover:bg-primary-500/15"
            title={selectedSwarmAgent ? `打开 ${selectedSwarmAgent.name}` : '打开多 Agent 编排视图'}
          >
            <GitBranch className="w-3 h-3" />
            <span>Swarm</span>
            <span className="text-primary-200/90">{swarmLabel}</span>
          </button>
        </>
      )}

      {/* 进度条（可选：显示总体进度） */}
      {runningCount > 0 && (
        <div className="w-16 h-1 bg-zinc-700 rounded-full overflow-hidden shrink-0 ml-auto">
          <div
            className="h-full bg-gradient-to-r from-emerald-500 to-primary-500 rounded-full transition-all duration-300"
            style={{
              width: `${(runningCount / stats.maxConcurrent) * 100}%`,
            }}
          />
        </div>
      )}
    </div>
  );
};

export default TaskStatusBar;
