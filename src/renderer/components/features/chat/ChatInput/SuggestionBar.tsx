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
          className="px-3 py-1.5 text-xs bg-elevated/60 text-text-secondary rounded-full hover:bg-hover hover:text-text-secondary transition-colors truncate max-w-[200px] border border-border-subtle"
        >
          {s.text}
        </button>
      ))}
    </div>
  );
};
