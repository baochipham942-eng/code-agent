import React, { useCallback, useEffect, useRef, useState } from 'react';
import { History, Loader2, X as XIcon } from 'lucide-react';

import type { ConversationReplay } from '@shared/contract/conversationBranch';
import type { TurnRedoResult } from '@shared/contract/turnCheckout';
import { IPC_DOMAINS } from '@shared/ipc';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import ipcService, { DomainInvokeError } from '../../../services/ipcService';

interface ActiveConversationRewindBannerProps {
  sessionId: string | null;
  refreshToken?: number;
  disabled?: boolean;
  onRestored: (result: TurnRedoResult) => void;
}

function latestOpenRewindId(replay: ConversationReplay): string | null {
  return replay.openRewindIds[replay.openRewindIds.length - 1] ?? null;
}

const SUCCESS_DISMISS_MS = 2400;

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
  const [phase, setPhase] = useState<'open' | 'done'>('open');
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 取活跃 rewind id + 锚点提示词摘录。新语义下锚点保持可见且是投影里最后一条
  // 用户消息（rewind 只藏锚点之后的消息），所以一次 includeRewound:false 调用就够：
  // openRewindIds 给横幅，最后一条可见 user 消息给「回到哪条」的原文摘录。
  const readActiveRewind = useCallback(async (expectedSessionId: string): Promise<{ rewindId: string | null; excerpt: string | null }> => {
    let replay: ConversationReplay;
    try {
      replay = await ipcService.invokeDomain<ConversationReplay>(
        IPC_DOMAINS.SESSION,
        'replayConversationBranch',
        {
          sessionId: expectedSessionId,
          options: { includeRewound: false },
        },
      );
    } catch (error) {
      // 从没写过消息的会话还没有不可变分支（分支是首条消息落库时懒建的），宿主会抛
      // BRANCH_NOT_FOUND。对「这个会话有没有未完成的 rewind」这个问题，答案就是「没有」——
      // 这是预期状态，不是故障，不该刷 console。其它错误照旧上抛给调用方告警。
      if (error instanceof DomainInvokeError && error.code === 'BRANCH_NOT_FOUND') {
        return { rewindId: null, excerpt: null };
      }
      throw error;
    }
    const rewindId = latestOpenRewindId(replay);
    if (!rewindId) return { rewindId: null, excerpt: null };

    const anchor = [...replay.messages].reverse().find((entry) => entry.message.role === 'user');
    const raw = anchor?.message.content?.replace(/\s+/g, ' ').trim() ?? '';
    const excerpt = raw.length > 24 ? `${raw.slice(0, 24)}…` : raw || null;
    return { rewindId, excerpt };
  }, []);

  const clearBanner = useCallback(() => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    setActiveRewindId(null);
    setAnchorExcerpt(null);
    setPhase('open');
  }, []);

  useEffect(() => () => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
  }, []);

  useEffect(() => {
    let disposed = false;
    setActiveRewindId(null);
    setAnchorExcerpt(null);
    setIsRestoring(false);
    setPhase('open');
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
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
      const result = await ipcService.invokeDomain<TurnRedoResult>(
        IPC_DOMAINS.SESSION,
        'turnRedo',
        {
          sessionId: expectedSessionId,
          rewindId: expectedRewindId,
        },
      );
      if (currentSessionIdRef.current !== expectedSessionId) return;
      onRestored(result);
      setPhase('done');
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = setTimeout(() => {
        if (currentSessionIdRef.current === expectedSessionId) clearBanner();
      }, SUCCESS_DISMISS_MS);
    } catch (error) {
      if (currentSessionIdRef.current === expectedSessionId) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (currentSessionIdRef.current === expectedSessionId) {
        setIsRestoring(false);
      }
    }
  }, [activeRewindId, clearBanner, disabled, isRestoring, onRestored, sessionId]);

  if (!activeRewindId) return null;

  return (
    <div
      role="status"
      data-testid="active-conversation-rewind"
      data-rewind-id={activeRewindId}
      data-rewind-phase={phase}
      className="chat-col-pad mt-2"
    >
      <div className={`mx-auto flex w-full max-w-3xl items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
        phase === 'done'
          ? 'border-emerald-800/50 bg-emerald-950/20 text-zinc-300'
          : 'border-badge-warning/60 bg-amber-950/30 text-zinc-300'
      }`}>
        <History className={`h-3.5 w-3.5 shrink-0 ${phase === 'done' ? 'text-badge-success' : 'text-badge-warning'}`} />
        <span className="min-w-0 flex-1 truncate">
          {phase === 'done'
            ? t.chat.rewindUndoDone
            : anchorExcerpt
              ? t.chat.rewindSuccessWithPrompt.replace('{prompt}', anchorExcerpt)
              : t.chat.rewindSuccess}
        </span>
        {phase === 'open' && (
          <button /* ds-allow:button: 横幅右端的紧凑内联恢复动作，Button primitive 的标准尺寸/形状不适配横幅布局 */
            type="button"
            onClick={() => void handleRestore()}
            disabled={disabled || isRestoring}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-badge-warning/70 px-2 py-1 text-badge-warning hover:border-badge-warning hover:text-badge-warning disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRestoring && <Loader2 className="h-3 w-3 animate-spin" />}
            {t.chat.turnRedoAction}
          </button>
        )}
        <button /* ds-allow:button: 横幅关闭是紧凑图标，Button primitive 的标准尺寸不适配 */
          type="button"
          onClick={clearBanner}
          aria-label={t.chat.rewindDismiss}
          data-testid="active-conversation-rewind-dismiss"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-white/[0.08] hover:text-zinc-300"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};
