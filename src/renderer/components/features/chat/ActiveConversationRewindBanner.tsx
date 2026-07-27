import React, { useCallback, useEffect, useRef, useState } from 'react';
import { History, Loader2 } from 'lucide-react';

import type { ConversationReplay } from '@shared/contract/conversationBranch';
import type { RestoreConversationRewindResult } from '@shared/contract/sessionRewind';
import { IPC_DOMAINS } from '@shared/ipc';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import ipcService from '../../../services/ipcService';

interface ActiveConversationRewindBannerProps {
  sessionId: string | null;
  refreshToken?: number;
  disabled?: boolean;
  onRestored: (result: RestoreConversationRewindResult) => void;
}

function latestOpenRewindId(replay: ConversationReplay): string | null {
  return replay.openRewindIds[replay.openRewindIds.length - 1] ?? null;
}

export const ActiveConversationRewindBanner: React.FC<ActiveConversationRewindBannerProps> = ({
  sessionId,
  refreshToken = 0,
  disabled = false,
  onRestored,
}) => {
  const { t } = useI18n();
  const currentSessionIdRef = useRef(sessionId);
  currentSessionIdRef.current = sessionId;
  const [activeRewindId, setActiveRewindId] = useState<string | null>(null);
  const [anchorExcerpt, setAnchorExcerpt] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);

  // 取活跃 rewind id + 锚点提示词摘录（被软隐藏的最早一条就是回退锚点本身，
  // 横幅要把「回到哪条」说人话，不能只写「这条提示词」对着空气）
  const readActiveRewind = useCallback(async (expectedSessionId: string): Promise<{ rewindId: string | null; excerpt: string | null }> => {
    const replay = await ipcService.invokeDomain<ConversationReplay>(
      IPC_DOMAINS.SESSION,
      'replayConversationBranch',
      {
        sessionId: expectedSessionId,
        options: { includeRewound: true },
      },
    );
    const rewindId = latestOpenRewindId(replay);
    if (!rewindId) return { rewindId: null, excerpt: null };
    const anchor = replay.messages.find((entry) => entry.message.hiddenByRewindId === rewindId);
    const raw = anchor?.message.content?.replace(/\s+/g, ' ').trim() ?? '';
    const excerpt = raw.length > 24 ? `${raw.slice(0, 24)}…` : raw || null;
    return { rewindId, excerpt };
  }, []);

  useEffect(() => {
    let disposed = false;
    setActiveRewindId(null);
    setAnchorExcerpt(null);
    setIsRestoring(false);
    if (!sessionId) return () => {
      disposed = true;
    };

    void readActiveRewind(sessionId).then(({ rewindId, excerpt }) => {
      if (disposed) return;
      setActiveRewindId(rewindId);
      setAnchorExcerpt(excerpt);
    }).catch((error) => {
      if (!disposed) {
        console.warn('Failed to read active conversation rewind:', error);
        setActiveRewindId(null);
        setAnchorExcerpt(null);
      }
    });

    return () => {
      disposed = true;
    };
  }, [readActiveRewind, refreshToken, sessionId]);

  const handleRestore = useCallback(async () => {
    if (!sessionId || !activeRewindId || disabled || isRestoring) return;
    const expectedSessionId = sessionId;
    const expectedRewindId = activeRewindId;
    setIsRestoring(true);
    try {
      const result = await ipcService.invokeDomain<RestoreConversationRewindResult>(
        IPC_DOMAINS.SESSION,
        'restoreConversationRewind',
        {
          sessionId: expectedSessionId,
          rewindId: expectedRewindId,
        },
      );
      if (currentSessionIdRef.current !== expectedSessionId) return;
      onRestored(result);
      setActiveRewindId(null);
      setAnchorExcerpt(null);
      try {
        const next = await readActiveRewind(expectedSessionId);
        if (currentSessionIdRef.current === expectedSessionId) {
          setActiveRewindId(next.rewindId);
          setAnchorExcerpt(next.excerpt);
        }
      } catch (error) {
        console.warn('Failed to refresh active conversation rewind:', error);
      }
    } catch (error) {
      if (currentSessionIdRef.current === expectedSessionId) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (currentSessionIdRef.current === expectedSessionId) {
        setIsRestoring(false);
      }
    }
  }, [activeRewindId, disabled, isRestoring, onRestored, readActiveRewind, sessionId]);

  if (!activeRewindId) return null;

  return (
    <div
      role="status"
      data-testid="active-conversation-rewind"
      data-rewind-id={activeRewindId}
      className="mx-4 mt-2 flex items-center gap-2 rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-zinc-300"
    >
      <History className="h-3.5 w-3.5 shrink-0 text-amber-300" />
      <span className="min-w-0 flex-1 truncate">
        {anchorExcerpt
          ? t.chat.rewindSuccessWithPrompt.replace('{prompt}', anchorExcerpt)
          : t.chat.rewindSuccess}
      </span>
      <button /* ds-allow:button: 横幅右端的紧凑内联恢复动作，Button primitive 的标准尺寸/形状不适配横幅布局 */
        type="button"
        onClick={() => void handleRestore()}
        disabled={disabled || isRestoring}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-700/70 px-2 py-1 text-amber-200 hover:border-amber-500 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isRestoring && <Loader2 className="h-3 w-3 animate-spin" />}
        {t.chat.rewindRestoreAction}
      </button>
    </div>
  );
};
