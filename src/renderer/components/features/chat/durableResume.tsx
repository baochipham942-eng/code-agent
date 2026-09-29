import React, { useCallback, useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../services/ipcService';
import { useSessionStore } from '../../../stores/sessionStore';
import { toast } from '../../../hooks/useToast';
import { useI18n } from '../../../hooks/useI18n';
import { ConfirmDialog } from '../../composites/ConfirmDialog';

/** 投影可能滞后于运行态：本轮已在跑时，「继续」必须让位给「停止」。 */
function shouldShowDurableContinue(
  resume: { mode: string; canContinue: boolean } | undefined,
  turnActive: boolean,
): boolean {
  return resume?.mode === 'continue' && resume.canContinue && !turnActive;
}

/** The durable resume notice is the single recovery action for these modes. */
export function suppressLegacyInterruptionDecision<T>(
  decision: T | null | undefined,
  durableResumeMode: string | undefined,
): T | null {
  if (!decision || durableResumeMode === 'continue' || durableResumeMode === 'auto-resuming' || durableResumeMode === 'queued') {
    return null;
  }
  return decision;
}

/**
 * 投影只在会话列表刷新时更新；运行态翻转时主动刷新一次，
 * 且运行中以 taskStore 为准，续跑期间主按钮必须是「停止」。
 */
export function useDurableContinueVisible(
  resume: { mode: string; canContinue: boolean } | undefined,
  turnActive: boolean,
): boolean {
  const hasResume = Boolean(resume);
  useEffect(() => {
    if (hasResume) void useSessionStore.getState().loadSessions({ silent: true });
  }, [turnActive, hasResume]);
  return shouldShowDurableContinue(resume, turnActive);
}

export function useDurableResumeContinuation(sessionId?: string | null): () => Promise<void> {
  return useCallback(async () => {
    if (!sessionId) return;
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.AGENT, 'continue', { sessionId });
      void useSessionStore.getState().loadSessions({ silent: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [sessionId]);
}

/**
 * guard_halt 停靠的 run（外部系统写入结果未知）点「继续」前必须先过模态二次确认：
 * 取消不续跑，确认才调 continue（ADR-075 修订 2026-09-29 ②）。其它停靠原因直接续跑。
 */
export function useGuardedDurableContinue(
  interruptCause: string | undefined,
  onContinue: () => Promise<void>,
): { onContinue: () => void; confirmDialog: React.ReactNode } {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const guarded = interruptCause === 'guard_halt';
  return {
    onContinue: () => (guarded ? setConfirming(true) : void onContinue()),
    confirmDialog: guarded ? (
      <ConfirmDialog
        isOpen={confirming}
        variant="warning"
        title={t.chat.durableGuardContinueTitle}
        message={t.chat.durableGuardContinueMessage}
        confirmText={t.chat.continueInterrupted}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void onContinue();
        }}
      />
    ) : null,
  };
}

export const DurableResumeNotice: React.FC<{ text: string }> = ({ text }) => (
  <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 px-4 text-xs text-zinc-400" data-testid="durable-resume-notice">
    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" aria-hidden="true" />
    <span>{text}</span>
  </div>
);
