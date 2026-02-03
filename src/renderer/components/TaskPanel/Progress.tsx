// ============================================================================
// Progress - Task progress indicator (Linear-style collapsible design)
// ============================================================================
// 显示两种进度：
// 1. todos - 来自 todo_write 工具的任务列表
// 2. taskProgress - 实时任务状态（当没有 todos 时显示）
// ============================================================================

import React, { useState, useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { Check, ChevronDown, ChevronRight, ListChecks, Loader2 } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import type { TaskProgressData, AgentEvent } from '@shared/types';

// Phase 到中文的映射
const PHASE_LABELS: Record<string, string> = {
  thinking: '分析中',
  generating: '生成中',
  tool_pending: '准备执行',
  tool_running: '执行中',
  completed: '已完成',
  failed: '失败',
};

export const Progress: React.FC = () => {
  const { todos } = useSessionStore();
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(true);
  const [taskProgress, setTaskProgress] = useState<TaskProgressData | null>(null);

  // 订阅 IPC 事件获取实时进度
  useEffect(() => {
    const handleAgentEvent = (event: AgentEvent) => {
      if (event.type === 'task_progress' && event.data) {
        setTaskProgress(event.data as TaskProgressData);
      } else if (event.type === 'task_complete') {
        setTaskProgress(null);
      }
    };

    // 订阅事件
    const unsubscribe = window.electronAPI?.on?.('agent:event', handleAgentEvent);

    return () => {
      unsubscribe?.();
    };
  }, []);

  const completedCount = todos.filter((item) => item.status === 'completed').length;
  const totalCount = todos.length;

  // Initial collapsed items count
  const INITIAL_VISIBLE = 4;
  const [showAll, setShowAll] = useState(false);
  const visibleTodos = showAll ? todos : todos.slice(0, INITIAL_VISIBLE);
  const hiddenCount = todos.length - INITIAL_VISIBLE;

  // 是否有实时进度要显示（只有当没有 todos 且有 taskProgress 时才显示）
  const showRealtimeProgress = totalCount === 0 && taskProgress && taskProgress.phase !== 'completed';

  return (
    <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl p-3 border border-white/[0.04]">
      {/* Header - always visible */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center w-full"
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <ListChecks className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
            {t.taskPanel.progress}
          </span>
          {totalCount > 0 && (
            <span className="text-xs text-zinc-500">{completedCount}/{totalCount}</span>
          )}
        </div>
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        )}
      </button>

      {/* Task list - collapsible */}
      {isExpanded && totalCount > 0 && (
        <div className="space-y-1 mt-3">
          {visibleTodos.map((todo, index) => (
            <div
              key={index}
              className="flex items-center gap-3 py-1.5"
            >
              {/* Status indicator */}
              {todo.status === 'completed' ? (
                <div className="w-5 h-5 rounded-full bg-primary-500 flex items-center justify-center flex-shrink-0">
                  <Check className="w-3 h-3 text-white" />
                </div>
              ) : todo.status === 'in_progress' ? (
                <div className="w-5 h-5 rounded-full bg-primary-500 flex items-center justify-center flex-shrink-0 animate-pulse">
                  <span className="text-xs font-medium text-white">
                    {todos.findIndex(t => t === todo) + 1}
                  </span>
                </div>
              ) : (
                <div className="w-5 h-5 rounded-full bg-zinc-700 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-medium text-zinc-400">
                    {todos.findIndex(t => t === todo) + 1}
                  </span>
                </div>
              )}

              {/* Task text */}
              <span
                className={`text-sm truncate ${
                  todo.status === 'completed'
                    ? 'text-zinc-500'
                    : todo.status === 'in_progress'
                    ? 'text-zinc-200'
                    : 'text-zinc-400'
                }`}
              >
                {todo.status === 'in_progress' ? todo.activeForm : todo.content}
              </span>
            </div>
          ))}

          {/* Show more button */}
          {hiddenCount > 0 && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="text-xs text-zinc-500 hover:text-zinc-400 py-1"
            >
              Show {hiddenCount} more
            </button>
          )}
        </div>
      )}

      {/* Realtime progress - when no todos */}
      {isExpanded && showRealtimeProgress && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-3 py-1.5">
            <Loader2 className="w-4 h-4 text-primary-500 animate-spin flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="text-sm text-zinc-200">
                {taskProgress.step || PHASE_LABELS[taskProgress.phase] || taskProgress.phase}
              </span>
              {taskProgress.tool && (
                <span className="text-xs text-zinc-500 ml-2">
                  {taskProgress.tool}
                  {taskProgress.toolTotal && taskProgress.toolTotal > 1 && (
                    <span className="ml-1">
                      ({taskProgress.toolIndex || 1}/{taskProgress.toolTotal})
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
          {/* Progress bar */}
          {taskProgress.progress !== undefined && taskProgress.progress > 0 && (
            <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary-500 transition-all duration-300"
                style={{ width: `${taskProgress.progress}%` }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
