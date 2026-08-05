// ============================================================================
// LaunchRequestCard —— swarm 启动审批卡（消息流内联，TraceNodeRenderer
// swarm_launch_request 节点）
//
// 施工单二 B：pending 态改为轻量 inline 问答（一次问完「批准 N 个成员启动？」
// + 任务摘要一句 + 批准/拒绝），复用 DecisionCard / UserQuestionCard 视觉骨架。
// 重型 stats+任务清单决策区退役；approved/rejected 保留紧凑历史卡（C4）。
// approve/reject 仍走 SWARM_APPROVE_LAUNCH / SWARM_REJECT_LAUNCH IPC。
// ============================================================================

import React, { useState } from 'react';
import { GitBranch } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { SwarmLaunchRequest } from '@shared/contract/swarm';
import ipcService from '../../../services/ipcService';
import { useSwarmStore } from '../../../stores/swarmStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import { DecisionCard, type DecisionOption } from '../../DecisionCard';

export const LaunchRequestCard: React.FC<{ request: SwarmLaunchRequest }> = ({ request }) => {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const s = t.decisionCard.swarm;

  const handleApprove = async () => {
    if (submitting !== null) return;
    const selectedSessionIdAtSubmit = useSessionStore.getState().currentSessionId;
    const activeRunIdAtSubmit = useSwarmStore.getState().activeRunId;
    setSubmitting('approve');
    setError(null);
    try {
      const success = await ipcService.invoke(IPC_CHANNELS.SWARM_APPROVE_LAUNCH, {
        sessionId: request.sessionId,
        runId: request.runId,
        requestId: request.id,
      });
      if (!success) {
        setError(s.approveFailed);
      } else {
        const currentSessionId = useSessionStore.getState().currentSessionId;
        const swarmState = useSwarmStore.getState();
        if (
          selectedSessionIdAtSubmit === request.sessionId
          && currentSessionId === request.sessionId
          && swarmState.activeSessionId === request.sessionId
          && swarmState.activeRunId === activeRunIdAtSubmit
        ) {
          swarmState.activateScope(request.sessionId, request.runId);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : s.approveFailedGeneric);
    } finally {
      setSubmitting(null);
    }
  };

  const handleReject = async (reason?: string) => {
    if (submitting !== null) return;
    const feedback = (reason?.trim() || s.defaultRejectReason);
    setSubmitting('reject');
    setError(null);
    try {
      const success = await ipcService.invoke(IPC_CHANNELS.SWARM_REJECT_LAUNCH, {
        sessionId: request.sessionId,
        runId: request.runId,
        requestId: request.id,
        feedback,
      });
      if (!success) {
        setError(s.rejectFailed);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : s.rejectFailedGeneric);
    } finally {
      setSubmitting(null);
    }
  };

  // approved / rejected = 消息流里的紧凑历史记录（C4：resolved 后节点不消失）
  if (request.status !== 'pending') {
    const badgeClass =
      request.status === 'approved'
        ? 'bg-emerald-500/15 text-badge-success'
        : 'bg-red-500/15 text-badge-danger';
    return (
      <div
        data-testid="swarm-launch-history"
        className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3"
      >
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-badge-accent" />
          <div className="text-sm text-zinc-100 font-medium">
            {request.status === 'approved'
              ? s.historyApproved.replace('{count}', String(request.agentCount))
              : s.historyRejected}
          </div>
          <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] ${badgeClass}`}>
            {request.status === 'approved' ? s.badgeApproved : s.badgeRejected}
          </span>
        </div>

        <div className="mt-2 text-xs leading-5 text-zinc-400">{request.summary}</div>

        {request.feedback && (
          <div className="mt-2 rounded bg-zinc-900/80 px-2 py-1.5 text-xs text-zinc-400">
            {request.feedback}
          </div>
        )}
      </div>
    );
  }

  const options: DecisionOption[] = [
    { id: 'approve', label: s.optionApprove, description: s.optionApproveDesc },
    { id: 'reject', label: s.optionReject, description: s.optionRejectDesc },
  ];

  return (
    <DecisionCard
      testId="swarm-launch-card"
      className="w-full animate-slideUp"
      tone="neutral"
      icon={<GitBranch className="w-4 h-4" />}
      title={s.title}
      question={s.question.replace('{count}', String(request.agentCount))}
      details={
        <div className="text-xs leading-5 text-zinc-400 line-clamp-2">
          {request.summary}
        </div>
      }
      options={options}
      selectedId={selected}
      onSelect={setSelected}
      onConfirm={() => {
        if (selected === 'approve') void handleApprove();
        else if (selected === 'reject') void handleReject();
      }}
      onCancel={() => void handleReject()}
      confirmLabel={t.decisionCard.confirm}
      cancelLabel={s.cancel}
      submitting={submitting !== null}
      footerExtra={error ? <div className="mt-2 text-xs text-badge-danger">{error}</div> : null}
    />
  );
};

export default LaunchRequestCard;
