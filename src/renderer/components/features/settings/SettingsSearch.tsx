// ============================================================================
// SettingsSearch - Search box + results for settings navigation
// ============================================================================

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Search, X } from 'lucide-react';
import { searchSettings, type SettingsTab, type SettingsEntry } from '../../../utils/settingsIndex';

interface SettingsSearchProps {
  onNavigate: (tab: SettingsTab) => void;
}

export const SettingsSearch: React.FC<SettingsSearchProps> = ({ onNavigate }) => {
  const [query, setQuery] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => searchSettings(query), [query]);

  // Deduplicate results by tab — show one entry per tab with all matching labels
  const groupedResults = useMemo(() => {
    const tabMap = new Map<SettingsTab, SettingsEntry[]>();
    for (const entry of results) {
      const existing = tabMap.get(entry.tab);
      if (existing) {
        existing.push(entry);
      } else {
        tabMap.set(entry.tab, [entry]);
      }
    }
    return Array.from(tabMap.entries()).map(([tab, entries]) => ({
      tab,
      tabLabel: entries[0].tabLabel,
      labels: entries.map((e) => e.label),
    }));
  }, [results]);

  const showResults = isFocused && query.trim().length > 0;

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsFocused(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (tab: SettingsTab) => {
    onNavigate(tab);
    setQuery('');
    setIsFocused(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setIsFocused(true)}
          placeholder="搜索设置..."
          className="w-full pl-8 pr-7 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 transition-colors"
        />
        {query && (
          <button
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-400"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Results dropdown */}
      {showResults && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl overflow-hidden z-50 max-h-64 overflow-y-auto">
          {groupedResults.length === 0 ? (
            <div className="px-3 py-2 text-xs text-zinc-500">
              未找到匹配的设置项
            </div>
          ) : (
            groupedResults.map(({ tab, tabLabel, labels }) => (
              <button
                key={tab}
                onClick={() => handleSelect(tab)}
                className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-zinc-700 transition-colors"
              >
                <span className="text-xs font-medium text-zinc-400 bg-zinc-700 px-1.5 py-0.5 rounded shrink-0">
                  {tabLabel}
                </span>
                <span className="text-sm text-zinc-300 truncate">
                  {labels.join(' / ')}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};
