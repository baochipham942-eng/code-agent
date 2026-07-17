// ============================================================================
// SuggestionBar - 智能提示建议栏 + 恢复面板
// ============================================================================

import React, { useState } from 'react';
import { useI18n } from '../../../../hooks/useI18n';
import { formatRelativeTime } from '../../../../utils/i18nTime';

interface Suggestion {
  id: string;
  text: string;
  source: string;
  category?: 'plan_step' | 'desktop_task' | 'workspace_signal';
  timestampMs?: number;
  priority?: 'high' | 'medium' | 'low';
}

interface SuggestionBarProps {
  suggestions: Suggestion[];
  onSelect: (text: string) => void;
}

const CATEGORY_ORDER = ['plan_step', 'desktop_task', 'workspace_signal'] as const;

function hasRecoveryCategories(suggestions: Suggestion[]): boolean {
  return suggestions.some((s) => s.category);
}

const RecoveryPanel: React.FC<SuggestionBarProps> = ({ suggestions, onSelect }) => {
  const { t } = useI18n();
  const categoryLabels: Record<string, string> = {
    plan_step: t.suggestionBar.categoryPlanStep,
    desktop_task: t.suggestionBar.categoryDesktopTask,
    workspace_signal: t.suggestionBar.categoryWorkspaceSignal,
  };
  const [expanded, setExpanded] = useState(true);

  const grouped = new Map<string, Suggestion[]>();
  const uncategorized: Suggestion[] = [];

  for (const s of suggestions) {
    if (s.category) {
      const list = grouped.get(s.category) || [];
      list.push(s);
      grouped.set(s.category, list);
    } else {
      uncategorized.push(s);
    }
  }

  return (
    <div className="mx-3 my-2 rounded-lg border border-zinc-700/50 bg-zinc-800/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full px-3 py-2 text-xs text-zinc-400 hover:text-zinc-300 transition-colors"
      >
        <span className="font-medium">{t.suggestionBar.continueLastWork}</span>
        <span className="text-[10px]">{expanded ? t.suggestionBar.collapse : t.suggestionBar.expand}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-2 space-y-2">
          {CATEGORY_ORDER.map((cat) => {
            const items = grouped.get(cat);
            if (!items?.length) return null;
            return (
              <div key={cat}>
                <div className="text-[10px] text-zinc-500 mb-1 uppercase tracking-wider">
                  {categoryLabels[cat] || cat}
                </div>
                <div className="space-y-1">
                  {items.map((s) => {
                    const time = s.timestampMs ? formatRelativeTime(t, s.timestampMs) : null;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => onSelect(s.text)}
                        className="flex items-center gap-2 w-full text-left px-2 py-1.5 text-xs rounded-md bg-zinc-700/30 text-zinc-300 hover:bg-zinc-700/60 hover:text-zinc-200 transition-colors group"
                      >
                        <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${s.priority === 'high' ? 'bg-blue-400' : 'bg-zinc-500'}`} />
                        <span className="truncate flex-1">{s.text}</span>
                        {time && (
                          <span className="shrink-0 text-[10px] text-zinc-500 group-hover:text-zinc-400">
                            {time}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {uncategorized.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {uncategorized.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSelect(s.text)}
                  className="px-3 py-1.5 text-xs bg-zinc-700/60 text-zinc-400 rounded-full hover:bg-zinc-700 hover:text-zinc-300 transition-colors truncate max-w-[200px] border border-zinc-800"
                >
                  {s.text}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const SuggestionBar: React.FC<SuggestionBarProps> = ({ suggestions, onSelect }) => {
  if (suggestions.length === 0) return null;

  if (hasRecoveryCategories(suggestions)) {
    return <RecoveryPanel suggestions={suggestions} onSelect={onSelect} />;
  }

  return (
    <div className="flex flex-wrap gap-2 px-3 py-2">
      {suggestions.map(s => (
        <button
          key={s.id}
          type="button"
          onClick={() => onSelect(s.text)}
          className="px-3 py-1.5 text-xs bg-zinc-700/60 text-zinc-400 rounded-full hover:bg-zinc-700 hover:text-zinc-400 transition-colors truncate max-w-[200px] border border-zinc-800"
        >
          {s.text}
        </button>
      ))}
    </div>
  );
};
