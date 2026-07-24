import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, MessageSquareText, Search } from 'lucide-react';
import type { SessionWithMeta } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import { formatRelativeTime } from '../../../utils/i18nTime';
import { getDisplaySessionTitle } from '../../../utils/sessionPresentation';
import type {
  SidebarMessageSearchHitGroup,
  SidebarSearchScope,
} from '../../../utils/sidebarMessageSearch';
import { Input, Modal } from '../../primitives';

interface SidebarSearchDialogProps {
  isOpen: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  sessions: SessionWithMeta[];
  currentSessionId: string | null;
  messageSearchHitsBySessionId: Record<string, SidebarMessageSearchHitGroup>;
  messageSearchLoading: boolean;
  effectiveSearchScope: SidebarSearchScope;
  setSearchScope: (scope: SidebarSearchScope) => void;
  canSearchCurrentProject: boolean;
  onSelectSession: (sessionId: string) => void | Promise<void>;
}

export const SidebarSearchDialog: React.FC<SidebarSearchDialogProps> = ({
  isOpen,
  query,
  onQueryChange,
  onClose,
  sessions,
  currentSessionId,
  messageSearchHitsBySessionId,
  messageSearchLoading,
  effectiveSearchScope,
  setSearchScope,
  canSearchCurrentProject,
  onSelectSession,
}) => {
  const { t } = useI18n();
  const sb = t.sidebar;
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const sessionIdsKey = useMemo(() => sessions.map((session) => session.id).join('\n'), [sessions]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, effectiveSearchScope, sessionIdsKey]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((current) => Math.min(current + 1, Math.max(0, sessions.length - 1)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (event.key === 'Enter') {
      const selected = sessions[selectedIndex];
      if (selected) {
        event.preventDefault();
        void onSelectSession(selected.id);
      }
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={sb.searchDialogTitle}
      size="lg"
      className="min-h-[28rem]"
    >
      <div onKeyDown={handleKeyDown}>
        <Input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={sb.searchPlaceholder}
          aria-label={sb.searchInputAria}
          leftIcon={<Search />}
          className="bg-zinc-800"
        />

        <div className="mt-3 flex items-center gap-2">
          {canSearchCurrentProject && (
            <button /* ds-allow:button: 会话搜索范围是紧凑的 aria-pressed 分段控件，Button primitive 无对应选中态 */
              type="button"
              aria-pressed={effectiveSearchScope === 'current-project'}
              onClick={() => setSearchScope('current-project')}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                effectiveSearchScope === 'current-project'
                  ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200'
                  : 'border-zinc-700 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
              }`}
            >
              {sb.scopeCurrentProject}
            </button>
          )}
          <button /* ds-allow:button: 会话搜索范围是紧凑的 aria-pressed 分段控件，Button primitive 无对应选中态 */
            type="button"
            aria-pressed={effectiveSearchScope === 'all'}
            onClick={() => setSearchScope('all')}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
              effectiveSearchScope === 'all'
                ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200'
                : 'border-zinc-700 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
            }`}
          >
            {sb.scopeAll}
          </button>
          {messageSearchLoading && query.trim() && (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-zinc-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {sb.searchingMessagesShort}
            </span>
          )}
        </div>

        <div className="mt-3 border-t border-zinc-800 pt-2">
          {!query.trim() && sessions.length > 0 && (
            <p className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-600">
              {sb.recentSessions}
            </p>
          )}
          {sessions.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-2 text-center">
              <Search className="h-6 w-6 text-zinc-600" />
              <p className="text-sm text-zinc-500">
                {messageSearchLoading ? sb.searchingMessageContent : sb.noMatchedSessions}
              </p>
            </div>
          ) : (
            <div role="listbox" aria-label={sb.searchResultsAria} className="max-h-80 overflow-y-auto">
              {sessions.map((session, index) => {
                const hitGroup = messageSearchHitsBySessionId[session.id];
                const selected = index === selectedIndex;
                return (
                  <button /* ds-allow:button: 搜索结果是两行信息+命中计数的可选列表行，Button primitive 的动作按钮布局不适配 */
                    key={session.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onMouseMove={() => setSelectedIndex(index)}
                    onClick={() => void onSelectSession(session.id)}
                    className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${
                      selected ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/70'
                    }`}
                  >
                    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-cyan-500/10">
                      <MessageSquareText className="h-4 w-4 text-cyan-400/90" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {getDisplaySessionTitle(session.title)}
                        {session.id === currentSessionId && (
                          <span className="ml-2 text-[11px] text-cyan-400">{sb.currentSession}</span>
                        )}
                      </span>
                      <span className="block truncate text-[11px] text-zinc-500">
                        {hitGroup
                          ? sb.messageHits.replace('{count}', String(hitGroup.totalHitCount))
                          : formatRelativeTime(t, session.updatedAt)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};
