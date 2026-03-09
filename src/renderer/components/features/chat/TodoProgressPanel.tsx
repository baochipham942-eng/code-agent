// ============================================================================
// TodoProgressPanel - Claude Code 风格任务进度面板
// 替代 TodoBar，在聊天区顶部显示 ✔/◼/◻ 文字清单 + 活动标题 + 计时
// ============================================================================

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { TodoItem } from '@shared/types';
import { UI } from '@shared/constants';

// ============================================================================
// Types
// ============================================================================

export interface TodoProgressPanelProps {
  todos: TodoItem[];
  isProcessing: boolean;
  className?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/** 格式化耗时（秒→分秒时） */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours}h ${remainingMins}m`;
}

/** 获取 todo 状态图标 */
function getStatusIcon(status: TodoItem['status']): { char: string; colorClass: string } {
  switch (status) {
    case 'completed':
      return { char: '✔', colorClass: 'text-emerald-400' };
    case 'in_progress':
      return { char: '◼', colorClass: 'text-amber-400' };
    default:
      return { char: '◻', colorClass: 'text-text-tertiary' };
  }
}

// ============================================================================
// TodoProgressPanel Component
// ============================================================================

export const TodoProgressPanel: React.FC<TodoProgressPanelProps> = ({
  todos,
  isProcessing,
  className = '',
}) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isFadingOut, setIsFadingOut] = useState(false);
  const [isVisible, setIsVisible] = useState(true);

  // 每个 todo 进入 in_progress 的时间戳
  const startTimesRef = useRef<Map<number, number>>(new Map());
  // 每个 todo 完成时的耗时
  const completedDurationsRef = useRef<Map<number, number>>(new Map());
  // 整个面板的开始时间
  const panelStartRef = useRef<number>(Date.now());
  // 上一次 todos 快照
  const prevTodosRef = useRef<TodoItem[]>([]);

  // 每秒 tick
  const [, setTick] = useState(0);

  // 追踪 todo 状态变化
  useEffect(() => {
    const prevTodos = prevTodosRef.current;
    const now = Date.now();

    todos.forEach((todo, index) => {
      const prev = prevTodos[index];

      // 新进入 in_progress
      if (todo.status === 'in_progress' && (!prev || prev.status !== 'in_progress')) {
        startTimesRef.current.set(index, now);
      }

      // 刚完成：记录耗时
      if (todo.status === 'completed' && prev && prev.status === 'in_progress') {
        const startTime = startTimesRef.current.get(index);
        if (startTime) {
          completedDurationsRef.current.set(index, now - startTime);
        }
      }
    });

    prevTodosRef.current = [...todos];
  }, [todos]);

  // 面板初始化时重置计时
  useEffect(() => {
    panelStartRef.current = Date.now();
    startTimesRef.current.clear();
    completedDurationsRef.current.clear();
    setIsFadingOut(false);
    setIsVisible(true);
  }, [todos.length === 0]); // 当 todos 从无到有时重置

  // 每秒更新计时
  useEffect(() => {
    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, UI.TODO_PANEL_TICK_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  // 全部完成后淡出
  const allCompleted = todos.length > 0 && todos.every((t) => t.status === 'completed');

  useEffect(() => {
    if (allCompleted && !isProcessing) {
      const timer = setTimeout(() => {
        setIsFadingOut(true);
        // 动画结束后隐藏
        setTimeout(() => setIsVisible(false), 300);
      }, UI.TODO_PANEL_FADE_DELAY);
      return () => clearTimeout(timer);
    } else {
      setIsFadingOut(false);
      setIsVisible(true);
    }
  }, [allCompleted, isProcessing]);

  // 获取当前 in_progress 的 todo
  const activeTodo = todos.find((t) => t.status === 'in_progress');
  const activeIndex = todos.findIndex((t) => t.status === 'in_progress');

  // 总耗时
  const totalElapsed = Date.now() - panelStartRef.current;

  // 获取某个 todo 的耗时文本
  const getTodoDuration = useCallback((index: number, status: TodoItem['status']): string | null => {
    if (status === 'completed') {
      const duration = completedDurationsRef.current.get(index);
      return duration ? formatDuration(duration) : null;
    }
    if (status === 'in_progress') {
      const startTime = startTimesRef.current.get(index);
      return startTime ? formatDuration(Date.now() - startTime) : null;
    }
    return null;
  }, []);

  if (!isVisible || todos.length === 0) return null;

  const completedCount = todos.filter((t) => t.status === 'completed').length;

  return (
    <div
      className={`
        bg-elevated/60 border border-border-default rounded-lg
        transition-all duration-300
        ${isFadingOut ? 'opacity-0 translate-y-[-4px]' : 'opacity-100 animate-slide-down'}
        ${className}
      `}
    >
      {/* 标题行 */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-active/20 rounded-lg transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {/* ✢ 旋转图标 */}
          {!allCompleted && (
            <span className="text-primary-400 animate-spin-slow text-sm shrink-0">✢</span>
          )}
          {allCompleted && (
            <span className="text-emerald-400 text-sm shrink-0">✔</span>
          )}

          {/* 活动描述 */}
          <span className="text-sm text-text-secondary truncate">
            {allCompleted
              ? `全部完成 (${completedCount}/${todos.length})`
              : activeTodo?.activeForm
                ? `${activeTodo.activeForm}…`
                : `进行中 (${completedCount}/${todos.length})`
            }
          </span>

          {/* 总耗时 */}
          <span className="text-xs text-text-tertiary shrink-0">
            ({formatDuration(totalElapsed)})
          </span>
        </div>

        {/* 折叠/展开 */}
        <div className="text-text-tertiary shrink-0 ml-2">
          {isExpanded ? (
            <ChevronUp className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
        </div>
      </button>

      {/* 任务列表 */}
      {isExpanded && (
        <div className="px-3 pb-2 space-y-0.5">
          {/* 树形连接线 */}
          <div className="ml-1 border-l border-border-default/60 pl-3">
            {todos.map((todo, index) => {
              const { char, colorClass } = getStatusIcon(todo.status);
              const duration = getTodoDuration(index, todo.status);
              const isActive = todo.status === 'in_progress';

              return (
                <div
                  key={index}
                  className={`
                    flex items-center gap-2 py-0.5 text-sm font-mono
                    ${isActive ? 'animate-pulse' : ''}
                  `}
                >
                  {/* 状态图标 */}
                  <span className={`${colorClass} shrink-0 text-xs`}>{char}</span>

                  {/* 内容 */}
                  <span
                    className={`truncate ${
                      todo.status === 'completed'
                        ? 'text-text-tertiary'
                        : isActive
                          ? 'text-text-primary'
                          : 'text-text-secondary'
                    }`}
                  >
                    {isActive && todo.activeForm
                      ? `${todo.content} (${todo.activeForm}…)`
                      : todo.content
                    }
                  </span>

                  {/* 耗时 */}
                  {duration && (
                    <span className="text-xs text-text-disabled shrink-0 ml-auto">
                      {duration}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default TodoProgressPanel;
