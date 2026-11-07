import React, { useCallback, useEffect, useState } from 'react';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
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

export const DurableResumeNotice: React.FC<{ text: string; actions?: React.ReactNode }> = ({ text, actions }) => (
  <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 px-4 text-xs text-zinc-400" data-testid="durable-resume-notice">
    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" aria-hidden="true" />
    <span>{text}</span>
    {actions}
  </div>
);

/**
 * 停靠待「继续」的 run 的「放弃」入口（N-STOP-ABANDON-ENTRY）：模态二次确认后走
 * 真实取消链路（agent:cancel → web /api/cancel 的 terminalRecoveredWaitingRun）终态化。
 * selector 带 durableResume.runId，web 路由据此终止停靠的那个 run；桌面
 * appService.cancel 按 sessionId 落到同一 registry 方法。取消（模态的取消）不动 run。
 */
export function useAbandonParkedRun(
  sessionId: string | null | undefined,
  runId: string | null | undefined,
): { onAbandon: () => void; confirmDialog: React.ReactNode } {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const abandon = useCallback(async () => {
    if (!sessionId || !runId) return;
    try {
      await ipcService.invoke(IPC_CHANNELS.AGENT_CANCEL, { sessionId, runId });
      // run 已终态化，但会话行 updatedAt 不动；不乐观清投影的话，
      // loadSessions 的防陈旧快照守卫（preserveParkedContinueOnRefresh）会把
      // 「可继续」投影原样复活，停靠行只能靠整页重载才消失（真跑 Rework r1 撞出）。
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) => (
          session.id === sessionId && session.durableResume
            ? { ...session, durableResume: undefined }
            : session
        )),
      }));
      void useSessionStore.getState().loadSessions({ silent: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [sessionId, runId]);
  return {
    onAbandon: () => setConfirming(true),
    confirmDialog: (
      <ConfirmDialog
        isOpen={confirming}
        variant="danger"
        title={t.chat.durableAbandonTitle}
        message={t.chat.durableAbandonMessage}
        confirmText={t.chat.durableAbandon}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void abandon();
        }}
      />
    ),
  };
}
