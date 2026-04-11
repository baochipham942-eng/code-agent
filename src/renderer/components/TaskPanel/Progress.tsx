// ============================================================================
// Progress - Task progress indicator (Linear-style collapsible design)
// ============================================================================
// 显示三种进度：
// 1. todos - 来自 todo_write 工具的任务列表
// 2. taskProgress - 实时任务状态（当没有 todos 时显示）
// 3. toolElapsed - 工具执行耗时 + 超时警告
// ============================================================================

import React, { useState, useMemo } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { Check, ChevronDown, ChevronRight, ListChecks, Loader2, Clock, AlertTriangle } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { classifyTool, PHASE_ICONS, formatElapsed, type PhaseType } from './taskPanelUtils';
import { useToolProgress } from './useToolProgress';

export const Progress: React.FC = () => {
  const { todos, currentSessionId, messages } = useSessionStore();
  const sessionTaskProgress = useAppStore((state) => state.sessionTaskProgress);
  const { t } = useI18n();

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

  // 从工具调用历史推导工作阶段（当无显式 todos 时）
  const toolPhases = useMemo(() => {
    if (totalCount > 0) return []; // 有显式 todos 时不需要

    const phases: Array<{ type: PhaseType; count: number; status: 'completed' | 'in_progress' }> = [];

    // 只扫描最近 30 条消息
    for (const msg of messages.slice(-30)) {
      if (!msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        const phase = classifyTool(tc.name);
        if (!phase) continue;

        const last = phases[phases.length - 1];
        if (last?.type === phase) {
          last.count++;
        } else {
          // 新阶段开始，之前的阶段标记为已完成
          if (phases.length > 0) {
            phases[phases.length - 1].status = 'completed';
          }
          phases.push({ type: phase, count: 1, status: 'in_progress' });
        }
      }
    }

    return phases;
  }, [messages, totalCount]);

  const phaseLabel = (type: PhaseType): string => {
    const map: Record<PhaseType, string> = {
      read: t.taskPanel.phaseRead,
      edit: t.taskPanel.phaseEdit,
      execute: t.taskPanel.phaseExecute,
      search: t.taskPanel.phaseSearch,
      mcp: t.taskPanel.phaseMcp,
    };
    return map[type];
  };

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

      {/* 无显式 todos 时：显示工具阶段进度 */}
      {isExpanded && totalCount === 0 && !showRealtimeProgress && !showToolElapsed && (
        toolPhases.length > 0 ? (
          <div className="space-y-1 mt-3">
            {toolPhases.map((phase, index) => {
              const PhaseIcon = PHASE_ICONS[phase.type];
              return (
                <div key={`${phase.type}-${index}`} className="flex items-center gap-3 py-1.5">
                  {phase.status === 'completed' ? (
                    <div className="w-5 h-5 rounded-full bg-primary-500 flex items-center justify-center flex-shrink-0">
                      <Check className="w-3 h-3 text-white" />
                    </div>
                  ) : (
                    <div className="w-5 h-5 rounded-full bg-primary-500/20 flex items-center justify-center flex-shrink-0 animate-pulse">
                      <PhaseIcon className="w-3 h-3 text-primary-400" />
                    </div>
                  )}
                  <span className={`text-sm flex-1 ${
                    phase.status === 'completed' ? 'text-zinc-500' : 'text-zinc-200'
                  }`}>
                    {phaseLabel(phase.type)}
                  </span>
                  <span className="text-xs text-zinc-600">
                    {t.taskPanel.phaseOps.replace('{count}', String(phase.count))}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-zinc-600 mt-3 py-2">{t.taskPanel.noProgress}</div>
        )
      )}
    </div>
  );
};
