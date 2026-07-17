import React from 'react';
import {
  formatSidebarMessageSearchHitMeta,
  type SidebarMessageSearchHit,
} from '../../../utils/sidebarMessageSearch';
import { useI18n } from '../../../hooks/useI18n';
import type { Translations } from '../../../i18n';

function getRoleLabel(role: SidebarMessageSearchHit['role'], t: Translations): string {
  if (role === 'user') return t.chatSearch.roleUser;
  if (role === 'assistant') return t.chatSearch.roleAssistant;
  return t.chatSearch.roleSystem;
}

interface SidebarMessageHitListProps {
  sessionId: string;
  hits: SidebarMessageSearchHit[];
  onSelectHit: (
    event: React.MouseEvent<HTMLButtonElement>,
    sessionId: string,
    hit: SidebarMessageSearchHit,
  ) => void | Promise<void>;
}

export const SidebarMessageHitList: React.FC<SidebarMessageHitListProps> = ({
  sessionId,
  hits,
  onSelectHit,
}) => {
  const { t } = useI18n();
  const additionalHits = hits.slice(1, 4);
  if (additionalHits.length === 0) {
    return null;
  }

  return (
    <div className="mt-1.5 space-y-1">
      {additionalHits.map((hit) => (
        <button
          key={`${sessionId}:${hit.messageId ?? hit.messageIndex ?? hit.timestamp}:${hit.matchOffset ?? 0}`}
          type="button"
          onClick={(event) => { void onSelectHit(event, sessionId, hit); }}
          className="flex w-full min-w-0 items-center gap-1.5 rounded-md border border-zinc-800/80 bg-zinc-950/40 px-2 py-1 text-left text-[10px] text-zinc-500 transition-colors hover:border-cyan-500/30 hover:bg-cyan-500/10 hover:text-cyan-200"
          title={hit.snippet}
        >
          <span className="shrink-0 text-zinc-600">
            {getRoleLabel(hit.role, t)}
          </span>
          <span className="shrink-0 text-zinc-600">
            {formatSidebarMessageSearchHitMeta(hit)}
          </span>
          <span className="truncate">{hit.snippet}</span>
          {hit.matchCount > 1 && (
            <span className="shrink-0 text-zinc-600">{hit.matchCount}x</span>
          )}
        </button>
      ))}
    </div>
  );
};

export default SidebarMessageHitList;
