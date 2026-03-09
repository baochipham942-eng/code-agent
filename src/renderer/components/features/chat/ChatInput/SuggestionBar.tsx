// ============================================================================
// SuggestionBar - 智能提示建议栏
// ============================================================================

import React from 'react';

interface Suggestion {
  id: string;
  text: string;
  source: string;
}

interface SuggestionBarProps {
  suggestions: Suggestion[];
  onSelect: (text: string) => void;
}

export const SuggestionBar: React.FC<SuggestionBarProps> = ({ suggestions, onSelect }) => {
  if (suggestions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 py-2">
      {suggestions.map(s => (
        <button
          key={s.id}
          onClick={() => onSelect(s.text)}
          className="px-3 py-1.5 text-xs bg-zinc-700/60 text-zinc-400 rounded-full hover:bg-zinc-700 hover:text-zinc-400 transition-colors truncate max-w-[200px] border border-zinc-800"
        >
          {s.text}
        </button>
      ))}
    </div>
  );
};
