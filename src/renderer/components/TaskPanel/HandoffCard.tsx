// ============================================================================
// HandoffCard - Compact continuation proposals
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Play, X } from 'lucide-react';
import type { HandoffProposal } from '@shared/contract/handoff';
import { useSessionStore } from '../../stores/sessionStore';
import { useHandoffStore } from '../../stores/handoffStore';
import { useMessageActionStore } from '../../stores/messageActionStore';
import { Card } from './Card';

export function HandoffCard() {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const messageCount = useSessionStore((state) => state.messages.length);
  const items = useHandoffStore((state) => state.items);
  const load = useHandoffStore((state) => state.load);
  const updateStatus = useHandoffStore((state) => state.updateStatus);
  const sendPrompt = useMessageActionStore((state) => state.sendPrompt);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!currentSessionId) return;
    void load({ sessionId: currentSessionId, status: 'pending', limit: 6 });
  }, [currentSessionId, messageCount, load]);

  const visibleItems = useMemo(
    () => items.filter((item) => !currentSessionId || item.sessionId === currentSessionId).slice(0, 3),
    [currentSessionId, items],
  );

  const continueProposal = useCallback(async (item: HandoffProposal) => {
    if (busyId) return;
    setBusyId(item.id);
    try {
      await sendPrompt(item.prompt);
      await updateStatus(item.id, 'accepted');
    } finally {
      setBusyId(null);
    }
  }, [busyId, sendPrompt, updateStatus]);

  const dismissProposal = useCallback(async (item: HandoffProposal) => {
    if (busyId) return;
    setBusyId(item.id);
    try {
      await updateStatus(item.id, 'dismissed');
    } finally {
      setBusyId(null);
    }
  }, [busyId, updateStatus]);

  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <Card
      title="Handoff"
      storageKey="handoff"
      count={String(visibleItems.length)}
      defaultExpanded
    >
      <div className="space-y-1.5">
        {visibleItems.map((item) => (
          <div
            key={item.id}
            className="rounded-md border border-white/[0.05] bg-black/10 px-2.5 py-2"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-medium text-zinc-300" title={item.title}>
                  {item.title}
                </div>
                {item.reason && (
                  <div className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-zinc-600" title={item.reason}>
                    {item.reason}
                  </div>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                <button
                  type="button"
                  className="rounded p-1 text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-40"
                  onClick={() => void continueProposal(item)}
                  disabled={Boolean(busyId)}
                  aria-label={`继续 ${item.title}`}
                  title="继续"
                >
                  <Play className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="rounded p-1 text-zinc-600 transition hover:bg-white/[0.06] hover:text-zinc-300 disabled:opacity-40"
                  onClick={() => void dismissProposal(item)}
                  disabled={Boolean(busyId)}
                  aria-label={`忽略 ${item.title}`}
                  title="忽略"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
