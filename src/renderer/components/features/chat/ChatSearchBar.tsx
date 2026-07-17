// ============================================================================
// ChatSearchBar - In-session + Cross-session message search (Cmd/Ctrl+F)
// ============================================================================

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Search, X, ChevronUp, ChevronDown, ExternalLink } from 'lucide-react';
import type { TraceProjection } from '@shared/contract/trace';
import type { CrossSessionSearchResultItem, CrossSessionSearchResults } from '@shared/ipc/types';
import { IPC_CHANNELS } from '@shared/ipc/legacy-channels';
import { ipcService } from '../../../services/ipcService';
import { useSessionStore } from '../../../stores/sessionStore';
import { useSessionUIStore } from '../../../stores/sessionUIStore';
import { createPendingSearchJumpFromCrossSessionResult } from '../../../utils/sessionSearchJump';
import { useI18n } from '../../../hooks/useI18n';
import type { Translations } from '../../../i18n';
import { formatRelativeTime } from '../../../utils/i18nTime';

export interface SearchMatch {
  turnIndex: number;
  nodeIndex: number;
  /** character offset within node content */
  offset: number;
}

type SearchTab = 'current' | 'cross';

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
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<SearchTab>('current');

  // Current session search state
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  // Cross-session search state
  const [crossResults, setCrossResults] = useState<CrossSessionSearchResults | null>(null);
  const [crossLoading, setCrossLoading] = useState(false);
  const crossDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const switchSession = useSessionStore((s) => s.switchSession);
  const setPendingSearchJump = useSessionUIStore((s) => s.setPendingSearchJump);

  // Focus input when opened
  useEffect(() => {
    if (visible) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
      setTab('current');
      setMatches([]);
      setActiveIndex(0);
      setCrossResults(null);
      setCrossLoading(false);
      onMatchesChange([], 0);
    }
  }, [visible, onMatchesChange]);

  // Current session search
  useEffect(() => {
    if (tab !== 'current') return;

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
  }, [query, projection.turns, onMatchesChange, tab]);

  // Cross-session search (debounced)
  useEffect(() => {
    if (tab !== 'cross') return;

    // Clear current-session highlights when switching to cross tab
    onMatchesChange([], 0);

    if (!query.trim()) {
      setCrossResults(null);
      setCrossLoading(false);
      return;
    }

    setCrossLoading(true);
    clearTimeout(crossDebounceRef.current);
    crossDebounceRef.current = setTimeout(async () => {
      try {
        const results = await ipcService.invoke(
          IPC_CHANNELS.SESSION_SEARCH,
          { query, options: { limit: 30 } }
        );
        setCrossResults(results);
      } catch {
        setCrossResults(null);
      } finally {
        setCrossLoading(false);
      }
    }, 300);

    return () => clearTimeout(crossDebounceRef.current);
  }, [query, tab, onMatchesChange]);

  const goToMatch = useCallback((idx: number) => {
    if (matches.length === 0) return;
    const wrapped = ((idx % matches.length) + matches.length) % matches.length;
    setActiveIndex(wrapped);
    onActiveMatchChange(wrapped);
  }, [matches.length, onActiveMatchChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter' && tab === 'current') {
      e.preventDefault();
      if (e.shiftKey) {
        goToMatch(activeIndex - 1);
      } else {
        goToMatch(activeIndex + 1);
      }
    }
  }, [onClose, goToMatch, activeIndex, tab]);

  const handleTabChange = useCallback((newTab: SearchTab) => {
    setTab(newTab);
    if (newTab === 'cross') {
      // Clear in-session highlights
      setMatches([]);
      setActiveIndex(0);
      onMatchesChange([], 0);
    } else {
      // Clear cross-session results
      setCrossResults(null);
      setCrossLoading(false);
    }
  }, [onMatchesChange]);

  const handleJumpToSession = useCallback(async (item: CrossSessionSearchResultItem) => {
    setPendingSearchJump(createPendingSearchJumpFromCrossSessionResult(item, query));
    await switchSession(item.sessionId);
    onClose();
  }, [query, setPendingSearchJump, switchSession, onClose]);

  if (!visible) return null;

  return (
    <div className="bg-zinc-900 border-b border-zinc-800 animate-fade-in">
      {/* Search input + tabs */}
      <div className="flex items-center gap-2 px-4 py-2">
        <Search className="w-4 h-4 text-zinc-500 flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={tab === 'current' ? t.chatSearch.placeholderCurrent : t.chatSearch.placeholderCross}
          className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-hidden"
        />

        {/* Tab switcher */}
        <div className="flex items-center gap-0.5 bg-zinc-800 rounded px-0.5 py-0.5 flex-shrink-0">
          <button
            onClick={() => handleTabChange('current')}
            className={`px-2 py-0.5 text-xs rounded transition-colors ${
              tab === 'current'
                ? 'bg-zinc-700 text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-400'
            }`}
          >
            {t.chatSearch.tabCurrent}
          </button>
          <button
            onClick={() => handleTabChange('cross')}
            className={`px-2 py-0.5 text-xs rounded transition-colors ${
              tab === 'cross'
                ? 'bg-zinc-700 text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-400'
            }`}
          >
            {t.chatSearch.tabCross}
          </button>
        </div>

        {/* Current session: match count + nav */}
        {tab === 'current' && query && (
          <>
            <span className="text-xs text-zinc-500 tabular-nums flex-shrink-0">
              {matches.length > 0 ? `${activeIndex + 1}/${matches.length}` : t.chatSearch.zeroResults}
            </span>
            <button
              onClick={() => goToMatch(activeIndex - 1)}
              disabled={matches.length === 0}
              className="p-1 rounded hover:bg-zinc-800 text-zinc-500 disabled:opacity-30 transition-colors"
              title={t.chatSearch.prevMatch}
            >
              <ChevronUp className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => goToMatch(activeIndex + 1)}
              disabled={matches.length === 0}
              className="p-1 rounded hover:bg-zinc-800 text-zinc-500 disabled:opacity-30 transition-colors"
              title={t.chatSearch.nextMatch}
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </>
        )}

        {/* Cross session: summary */}
        {tab === 'cross' && query && !crossLoading && crossResults && (
          <span className="text-xs text-zinc-500 tabular-nums flex-shrink-0">
            {t.chatSearch.crossSummary
              .replace('{matches}', String(crossResults.totalMatches))
              .replace('{sessions}', String(crossResults.sessionsWithMatches))}
            {crossResults.searchTime > 0 && ` (${crossResults.searchTime}ms)`}
          </span>
        )}
        {tab === 'cross' && crossLoading && (
          <span className="text-xs text-zinc-500 flex-shrink-0">{t.chatSearch.searching}</span>
        )}

        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-zinc-800 text-zinc-500 transition-colors"
          title={t.chatSearch.close}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Cross-session results list */}
      {tab === 'cross' && crossResults && crossResults.results.length > 0 && (
        <div className="max-h-64 overflow-y-auto border-t border-zinc-800">
          {crossResults.results.map((item, i) => (
            <CrossSessionResultRow
              key={`${item.sessionId}-${item.timestamp}-${i}`}
              item={item}
              onJump={handleJumpToSession}
              t={t}
            />
          ))}
        </div>
      )}
      {tab === 'cross' && crossResults?.results.length === 0 && query.trim() && !crossLoading && (
        <div className="px-4 py-3 text-xs text-zinc-600 border-t border-zinc-800">
          {t.chatSearch.noMatches}
        </div>
      )}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Cross-session result row
// ----------------------------------------------------------------------------

const CrossSessionResultRow: React.FC<{
  item: CrossSessionSearchResultItem;
  onJump: (item: CrossSessionSearchResultItem) => void;
  t: Translations;
}> = ({ item, onJump, t }) => {
  const timeStr = formatRelativeTime(t, item.timestamp);
  const roleLabel = item.role === 'user' ? t.chatSearch.roleUser : item.role === 'assistant' ? t.chatSearch.roleAssistant : t.chatSearch.roleSystem;
  const turnLabel = typeof item.turnNumber === 'number' && item.turnNumber > 0
    ? t.chatSearch.turnNumber.replace('{n}', String(item.turnNumber))
    : null;

  // Strip markdown bold markers from snippet for display
  const cleanSnippet = item.snippet.replace(/\*\*/g, '');

  return (
    <button
      onClick={() => onJump(item)}
      className="w-full text-left px-4 py-2.5 hover:bg-zinc-800/60 transition-colors group border-b border-zinc-800/50 last:border-b-0"
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-medium text-zinc-300 truncate flex-1">
          {item.sessionTitle || item.sessionId.slice(0, 8)}
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
          item.role === 'user' ? 'bg-blue-900/40 text-blue-400' : 'bg-emerald-900/40 text-emerald-400'
        }`}>
          {roleLabel}
        </span>
        {turnLabel && (
          <span className="text-[10px] text-zinc-600">{turnLabel}</span>
        )}
        <span className="text-[10px] text-zinc-600">{timeStr}</span>
        <ExternalLink className="w-3 h-3 text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
      </div>
      <p className="text-xs text-zinc-500 line-clamp-2 leading-relaxed">
        {cleanSnippet}
      </p>
    </button>
  );
};

