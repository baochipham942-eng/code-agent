// ============================================================================
// Progress - Task progress indicator
// ============================================================================

import React from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { Loader2 } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';

export const Progress: React.FC = () => {
  const { todos } = useSessionStore();
  const { t } = useI18n();

  const completedCount = todos.filter((item) => item.status === 'completed').length;
  const inProgressCount = todos.filter((item) => item.status === 'in_progress').length;
  const totalCount = todos.length;

  return (
    <div className="bg-zinc-800/30 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">{t.taskPanel.progress}</span>
        <span className="text-xs text-zinc-500">{completedCount}/{totalCount}</span>
      </div>

      {/* Progress bar with dots */}
      {totalCount > 0 ? (
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
      ) : (
        <div className="h-1.5 bg-zinc-700 rounded-full mb-3" />
      )}

      {/* Current task */}
      {inProgressCount > 0 && (
        <div className="flex items-center gap-2 text-sm text-zinc-300">
          <Loader2 className="w-3.5 h-3.5 text-primary-400 animate-spin" />
          <span className="truncate">
            {todos.find((todo) => todo.status === 'in_progress')?.activeForm || t.taskPanel.working}
          </span>
        </div>
      )}
    </div>
  );
};
