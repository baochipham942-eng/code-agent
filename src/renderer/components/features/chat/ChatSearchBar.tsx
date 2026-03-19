// ============================================================================
// ChatSearchBar - In-session message search (Cmd/Ctrl+F)
// ============================================================================

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';
import type { TraceProjection } from '@shared/types/trace';

export interface SearchMatch {
  turnIndex: number;
  nodeIndex: number;
  /** character offset within node content */
  offset: number;
}

interface ChatSearchBarProps {
  visible: boolean;
  projection: TraceProjection;
  onClose: () => void;
  onMatchesChange: (matches: SearchMatch[], activeIndex: number) => void;
  onActiveMatchChange: (activeIndex: number) => void;
}

export const ChatSearchBar: React.FC<ChatSearchBarProps> = ({
  visible,
  projection,
  onClose,
  onMatchesChange,
  onActiveMatchChange,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  // Focus input when opened
  useEffect(() => {
    if (visible) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
      setMatches([]);
      setActiveIndex(0);
      onMatchesChange([], 0);
    }
  }, [visible, onMatchesChange]);

  // Search through turns when query changes
  useEffect(() => {
    if (!query.trim()) {
      setMatches([]);
      setActiveIndex(0);
      onMatchesChange([], 0);
      return;
    }

    const lowerQuery = query.toLowerCase();
    const newMatches: SearchMatch[] = [];

    projection.turns.forEach((turn, turnIndex) => {
      turn.nodes.forEach((node, nodeIndex) => {
        const content = node.content.toLowerCase();
        let offset = 0;
        while (offset < content.length) {
          const idx = content.indexOf(lowerQuery, offset);
          if (idx === -1) break;
          newMatches.push({ turnIndex, nodeIndex, offset: idx });
          offset = idx + lowerQuery.length;
        }
      });
    });

    setMatches(newMatches);
    setActiveIndex(0);
    onMatchesChange(newMatches, 0);
  }, [query, projection.turns, onMatchesChange]);

  const goToMatch = useCallback((idx: number) => {
    if (matches.length === 0) return;
    const wrapped = ((idx % matches.length) + matches.length) % matches.length;
    setActiveIndex(wrapped);
    onActiveMatchChange(wrapped);
  }, [matches.length, onActiveMatchChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        goToMatch(activeIndex - 1);
      } else {
        goToMatch(activeIndex + 1);
      }
    }
  }, [onClose, goToMatch, activeIndex]);

  if (!visible) return null;

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-zinc-900 border-b border-zinc-800 animate-fade-in">
      <Search className="w-4 h-4 text-zinc-500 flex-shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="搜索消息..."
        className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-none"
      />
      {query && (
        <span className="text-xs text-zinc-500 tabular-nums flex-shrink-0">
          {matches.length > 0 ? `${activeIndex + 1}/${matches.length}` : '0 结果'}
        </span>
      )}
      <button
        onClick={() => goToMatch(activeIndex - 1)}
        disabled={matches.length === 0}
        className="p-1 rounded hover:bg-zinc-800 text-zinc-500 disabled:opacity-30 transition-colors"
        title="上一个 (Shift+Enter)"
      >
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={() => goToMatch(activeIndex + 1)}
        disabled={matches.length === 0}
        className="p-1 rounded hover:bg-zinc-800 text-zinc-500 disabled:opacity-30 transition-colors"
        title="下一个 (Enter)"
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={onClose}
        className="p-1 rounded hover:bg-zinc-800 text-zinc-500 transition-colors"
        title="关闭 (Esc)"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
