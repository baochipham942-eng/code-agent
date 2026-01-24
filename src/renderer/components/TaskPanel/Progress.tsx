// ============================================================================
// Progress - Task progress indicator
// ============================================================================

import React from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { CheckCircle2, Circle, Loader2 } from 'lucide-react';

export const Progress: React.FC = () => {
  const { todos } = useSessionStore();

  if (todos.length === 0) {
    return null;
  }

  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length;
  const totalCount = todos.length;
  const progress = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  return (
    <div className="bg-zinc-800/30 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">Progress</span>
        <span className="text-xs text-zinc-500">{completedCount}/{totalCount}</span>
      </div>

      {/* Progress bar with dots */}
      <div className="flex items-center gap-1 mb-3">
        {todos.map((todo, index) => (
          <div
            key={index}
            className={`flex-1 h-1.5 rounded-full transition-colors ${
              todo.status === 'completed'
                ? 'bg-primary-500'
                : todo.status === 'in_progress'
                ? 'bg-primary-500/50 animate-pulse'
                : 'bg-zinc-700'
            }`}
          />
        ))}
      </div>

      {/* Current task */}
      {inProgressCount > 0 && (
        <div className="flex items-center gap-2 text-sm text-zinc-300">
          <Loader2 className="w-3.5 h-3.5 text-primary-400 animate-spin" />
          <span className="truncate">
            {todos.find((t) => t.status === 'in_progress')?.activeForm || 'Working...'}
          </span>
        </div>
      )}
    </div>
  );
};
