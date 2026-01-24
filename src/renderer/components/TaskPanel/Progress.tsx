// ============================================================================
// Progress - Task progress indicator (Linear-style collapsible design)
// ============================================================================

import React, { useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';

export const Progress: React.FC = () => {
  const { todos } = useSessionStore();
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(true);

  const completedCount = todos.filter((item) => item.status === 'completed').length;
  const totalCount = todos.length;

  // Initial collapsed items count
  const INITIAL_VISIBLE = 4;
  const [showAll, setShowAll] = useState(false);
  const visibleTodos = showAll ? todos : todos.slice(0, INITIAL_VISIBLE);
  const hiddenCount = todos.length - INITIAL_VISIBLE;

  return (
    <div className="bg-zinc-800/30 rounded-lg">
      {/* Header - always visible */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-3 hover:bg-zinc-700/20 rounded-lg transition-colors"
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-zinc-500" />
          ) : (
            <ChevronRight className="w-4 h-4 text-zinc-500" />
          )}
          <span className="text-sm font-medium text-zinc-300">{t.taskPanel.progress}</span>
        </div>
        {totalCount > 0 && (
          <span className="text-xs text-zinc-500">{completedCount}/{totalCount}</span>
        )}
      </button>

      {/* Task list - collapsible */}
      {isExpanded && totalCount > 0 && (
        <div className="px-3 pb-3 space-y-1">
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
              className="text-xs text-zinc-500 hover:text-zinc-400 pl-8 py-1"
            >
              Show {hiddenCount} more
            </button>
          )}
        </div>
      )}
    </div>
  );
};
