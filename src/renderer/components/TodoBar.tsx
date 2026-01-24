// ============================================================================
// TodoBar - Compact todo progress bar above chat input
// Linear-style: minimal, expandable, clean
// ============================================================================

import React, { useState, useRef, useEffect } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { CheckCircle2, Circle, Loader2, ChevronUp, ChevronDown } from 'lucide-react';
import type { TodoItem } from '@shared/types';

export const TodoBar: React.FC = () => {
  const { todos } = useSessionStore();
  const [isExpanded, setIsExpanded] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close panel when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setIsExpanded(false);
      }
    };

    if (isExpanded) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isExpanded]);

  // Don't render if no todos
  if (todos.length === 0) return null;

  const completedCount = todos.filter(t => t.status === 'completed').length;
  const inProgressCount = todos.filter(t => t.status === 'in_progress').length;
  const totalCount = todos.length;

  return (
    <div className="relative" ref={panelRef}>
      {/* Expanded Panel - grows upward */}
      {isExpanded && (
        <div className="absolute bottom-full left-0 right-0 mb-2 bg-zinc-800/95 backdrop-blur-sm border border-zinc-700/50 rounded-lg shadow-xl max-h-[40vh] overflow-y-auto animate-slideDown">
          <div className="p-3 space-y-1.5">
            {todos.map((todo, index) => (
              <TodoItemRow key={index} todo={todo} />
            ))}
          </div>
        </div>
      )}

      {/* Compact Bar */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-4 py-2 bg-zinc-800/50 hover:bg-zinc-800/70 border-t border-zinc-700/30 transition-colors group"
      >
        {/* Left: Progress dots visualization */}
        <div className="flex items-center gap-3">
          <ProgressDots todos={todos} />
          <span className="text-xs text-zinc-400">
            <span className="text-zinc-200 font-medium">{completedCount}</span>
            <span className="text-zinc-500">/{totalCount}</span>
            {' '}完成
            {inProgressCount > 0 && (
              <span className="ml-2 text-amber-400">
                {inProgressCount} 进行中
              </span>
            )}
          </span>
        </div>

        {/* Right: Expand/collapse icon */}
        <div className="flex items-center gap-1 text-zinc-500 group-hover:text-zinc-300 transition-colors">
          <span className="text-xs">详情</span>
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronUp className="w-3.5 h-3.5" />
          )}
        </div>
      </button>
    </div>
  );
};

// Progress dots visualization: ●─●─○─○
const ProgressDots: React.FC<{ todos: TodoItem[] }> = ({ todos }) => {
  // Show max 7 dots, then summarize
  const maxDots = 7;
  const showDots = todos.slice(0, maxDots);
  const hasMore = todos.length > maxDots;

  return (
    <div className="flex items-center gap-0.5">
      {showDots.map((todo, index) => (
        <React.Fragment key={index}>
          <TodoDot status={todo.status} />
          {index < showDots.length - 1 && (
            <div className="w-1.5 h-px bg-zinc-600" />
          )}
        </React.Fragment>
      ))}
      {hasMore && (
        <>
          <div className="w-1.5 h-px bg-zinc-600" />
          <span className="text-xs text-zinc-500 ml-0.5">+{todos.length - maxDots}</span>
        </>
      )}
    </div>
  );
};

// Individual dot for todo status
const TodoDot: React.FC<{ status: TodoItem['status'] }> = ({ status }) => {
  switch (status) {
    case 'completed':
      return <div className="w-2 h-2 rounded-full bg-emerald-400" />;
    case 'in_progress':
      return (
        <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
      );
    default:
      return <div className="w-2 h-2 rounded-full bg-zinc-600 border border-zinc-500" />;
  }
};

// Individual todo item row in expanded panel
const TodoItemRow: React.FC<{ todo: TodoItem }> = ({ todo }) => {
  const getStatusIcon = () => {
    switch (todo.status) {
      case 'completed':
        return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
      case 'in_progress':
        return <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />;
      default:
        return <Circle className="w-4 h-4 text-zinc-500" />;
    }
  };

  return (
    <div className={`flex items-start gap-2.5 py-1.5 px-2 rounded-md transition-colors ${
      todo.status === 'in_progress' ? 'bg-amber-500/10' : ''
    }`}>
      <div className="mt-0.5 shrink-0">
        {getStatusIcon()}
      </div>
      <span className={`text-sm leading-relaxed ${
        todo.status === 'completed'
          ? 'text-zinc-500 line-through'
          : todo.status === 'in_progress'
          ? 'text-zinc-200'
          : 'text-zinc-400'
      }`}>
        {todo.content}
      </span>
    </div>
  );
};
