// ============================================================================
// Progress - Task progress indicator (Linear-style collapsible design)
// ============================================================================
// 显示三种进度：
// 1. todos - 来自 todo_write 工具的任务列表
// 2. taskProgress - 实时任务状态（当没有 todos 时显示）
// 3. toolElapsed - 工具执行耗时 + 超时警告
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { Check, ChevronDown, ChevronRight, ListChecks, Loader2, Clock, AlertTriangle } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import type { TaskProgressData, ToolProgressData, ToolTimeoutData, AgentEvent } from '@shared/types';

// Phase 到中文的映射
const PHASE_LABELS: Record<string, string> = {
  thinking: '分析中',
  generating: '生成中',
  tool_pending: '准备执行',
  tool_running: '执行中',
  completed: '已完成',
  failed: '失败',
};

/**
 * 格式化毫秒为可读时长
 */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

export const Progress: React.FC = () => {
  const { todos } = useSessionStore();
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(true);
  const [taskProgress, setTaskProgress] = useState<TaskProgressData | null>(null);
  const [toolProgress, setToolProgress] = useState<ToolProgressData | null>(null);
  const [toolTimeout, setToolTimeout] = useState<ToolTimeoutData | null>(null);

  // 订阅 IPC 事件获取实时进度
  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case 'task_progress':
        if (event.data) {
          setTaskProgress(event.data as TaskProgressData);
        }
        break;
      case 'task_complete':
        setTaskProgress(null);
        break;
      case 'tool_progress':
        if (event.data) {
          setToolProgress(event.data as ToolProgressData);
        }
        break;
      case 'tool_timeout':
        if (event.data) {
          setToolTimeout(event.data as ToolTimeoutData);
        }
        break;
      case 'tool_call_end':
        // 工具完成时清除该工具的进度和超时状态
        if (event.data) {
          const toolCallId = (event.data as { toolCallId?: string }).toolCallId;
          setToolProgress((prev) => prev?.toolCallId === toolCallId ? null : prev);
          setToolTimeout((prev) => prev?.toolCallId === toolCallId ? null : prev);
        }
        break;
      case 'agent_complete':
        // Agent 完成时清除所有状态（包括任务进度）
        setTaskProgress(null);
        setToolProgress(null);
        setToolTimeout(null);
        break;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.on?.('agent:event', handleAgentEvent);
    return () => {
      unsubscribe?.();
    };
  }, [handleAgentEvent]);

  const completedCount = todos.filter((item) => item.status === 'completed').length;
  const totalCount = todos.length;

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
          <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">
            {t.taskPanel.progress}
          </span>
          {totalCount > 0 && (
            <span className="text-xs text-text-tertiary">{completedCount}/{totalCount}</span>
          )}
        </div>
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
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
                <div className="w-5 h-5 rounded-full bg-active flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-medium text-text-secondary">
                    {todos.findIndex(t => t === todo) + 1}
                  </span>
                </div>
              )}

              {/* Task text */}
              <span
                className={`text-sm truncate ${
                  todo.status === 'completed'
                    ? 'text-text-tertiary'
                    : todo.status === 'in_progress'
                    ? 'text-text-primary'
                    : 'text-text-secondary'
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
              className="text-xs text-text-tertiary hover:text-text-secondary py-1"
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
              <span className="text-sm text-text-primary">
                {taskProgress.step || PHASE_LABELS[taskProgress.phase] || taskProgress.phase}
              </span>
              {taskProgress.tool && (
                <span className="text-xs text-text-tertiary ml-2">
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
                toolTimeout ? 'text-amber-400' : 'text-text-tertiary'
              }`}>
                <Clock className="w-3 h-3" />
                {formatElapsed(toolProgress!.elapsedMs)}
              </span>
            )}
          </div>
          {/* Progress bar */}
          {taskProgress.progress !== undefined && taskProgress.progress > 0 && (
            <div className="h-1 bg-elevated rounded-full overflow-hidden">
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
              <span className="text-sm text-text-primary">
                {toolProgress!.toolName}
              </span>
            </div>
            <span className={`flex items-center gap-1 text-xs shrink-0 ${
              toolTimeout ? 'text-amber-400' : 'text-text-tertiary'
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
    </div>
  );
};
