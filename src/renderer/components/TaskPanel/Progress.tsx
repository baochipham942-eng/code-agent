// ============================================================================
// Progress - Task progress indicator (Linear-style collapsible design)
// ============================================================================
// 显示三种进度：
// 1. todos - 来自会话待办或持久化计划
// 2. taskProgress - 实时任务状态（当没有 todos 时显示）
// 3. toolElapsed - 工具执行耗时 + 超时警告
// ============================================================================

import React, { useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { Check, ChevronDown, ChevronRight, ListChecks, Loader2, Clock, AlertTriangle } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useStatusRailModel } from '../../hooks/useStatusRailModel';
import { formatElapsed } from './taskPanelUtils';
import { useToolProgress } from './useToolProgress';

export const Progress: React.FC = () => {
  const { currentSessionId } = useSessionStore();
  const sessionTaskProgress = useAppStore((state) => state.sessionTaskProgress);
  const { t } = useI18n();
  const todoModel = useStatusRailModel().todos;
  const todos = todoModel.items;

  const phaseLabels: Record<string, string> = {
    thinking: t.taskPanel.phaseThinking,
    generating: t.taskPanel.phaseGenerating,
    tool_pending: t.taskPanel.phaseToolPending,
    tool_running: t.taskPanel.phaseToolRunning,
    completed: t.taskPanel.phaseCompleted,
    failed: t.taskPanel.phaseFailed,
  };

  const [isExpanded, setIsExpanded] = useState(true);
  const { toolProgress, toolTimeout } = useToolProgress(currentSessionId);
  const taskProgress = currentSessionId ? sessionTaskProgress[currentSessionId] ?? null : null;

  const completedCount = todoModel.completed;
  const totalCount = todoModel.total;

  // Initial collapsed items count
  const INITIAL_VISIBLE = 4;
  const [showAll, setShowAll] = useState(false);
  const visibleTodos = showAll ? todos : todos.slice(0, INITIAL_VISIBLE);
  const hiddenCount = todos.length - INITIAL_VISIBLE;

  // 是否有实时进度要显示（只有当没有 todos 且有 taskProgress 时才显示）
  const showRealtimeProgress = totalCount === 0 && taskProgress && taskProgress.phase !== 'completed';

  // 是否有工具执行耗时要显示
  const showToolElapsed = toolProgress && toolProgress.elapsedMs >= 5000;

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
                <div className="w-5 h-5 rounded-full bg-primary-500 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-medium text-white">
                    {todos.findIndex(item => item === todo) + 1}
                  </span>
                </div>
              ) : (
                <div className="w-5 h-5 rounded-full bg-zinc-600 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-medium text-zinc-400">
                    {todos.findIndex(item => item === todo) + 1}
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
              {t.taskPanel.showMore.replace('{count}', String(hiddenCount))}
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
                {taskProgress.step || phaseLabels[taskProgress.phase] || taskProgress.phase}
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
            {/* Tool elapsed time badge */}
            {showToolElapsed && (
              <span className={`flex items-center gap-1 text-xs shrink-0 ${
                toolTimeout ? 'text-amber-400' : 'text-zinc-500'
              }`}>
                <Clock className="w-3 h-3" />
                {formatElapsed(toolProgress!.elapsedMs)}
              </span>
            )}
          </div>
          {/* Progress bar */}
          {taskProgress.progress !== undefined && taskProgress.progress > 0 && (
            <div className="h-1 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary-500 transition-all duration-300"
                style={{ width: `${taskProgress.progress}%` }}
              />
            </div>
          )}
          {/* Timeout warning */}
          {toolTimeout && (
            <div className="flex items-center gap-2 text-xs text-amber-400/80 py-1">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>
                {toolTimeout.toolName} {formatElapsed(toolTimeout.elapsedMs)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Standalone tool elapsed indicator (when task progress has no tool info but tool is running) */}
      {isExpanded && !showRealtimeProgress && showToolElapsed && (
        <div className="mt-3">
          <div className="flex items-center gap-3 py-1.5">
            <Loader2 className="w-4 h-4 text-primary-500 animate-spin flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="text-sm text-zinc-200">
                {toolProgress!.toolName}
              </span>
            </div>
            <span className={`flex items-center gap-1 text-xs shrink-0 ${
              toolTimeout ? 'text-amber-400' : 'text-zinc-500'
            }`}>
              <Clock className="w-3 h-3" />
              {formatElapsed(toolProgress!.elapsedMs)}
            </span>
          </div>
          {toolTimeout && (
            <div className="flex items-center gap-2 text-xs text-amber-400/80 py-1">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>
                {toolTimeout.toolName} {formatElapsed(toolTimeout.elapsedMs)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 无任务计划时保持空态，避免把工具调用伪装成待办 */}
      {isExpanded && totalCount === 0 && !showRealtimeProgress && !showToolElapsed && (
        <div className="text-xs text-zinc-600 mt-3 py-2">{t.taskPanel.noProgress}</div>
      )}
    </div>
  );
};
