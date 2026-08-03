// ============================================================================
// WorkflowLaunchCard —— dynamic-workflow 启动审批卡（P3b）
// ============================================================================
// workflow 跑前展示静态预览（phases / 扇出量 / 动写）+ 4 维度成本（费用/网络/上下文泄露/
// 后台占用），等用户 approve/reject。挂在消息流底部，仅有 pending 审批请求时显示。
// 决策经 IPC 回传 main 的 WorkflowLaunchApprovalGate（approve/reject → resolve workflow 工具）。
//
// 2026-07-29 拍板：视觉骨架统一迁移到 DecisionCard（与 AskUserQuestion 提问卡
// 同形）——「批准启动 / 拒绝」变成选项行，底部 ghost 取消 + primary 确认
// （选中后才可点）。数据流/IPC 不变。
// ============================================================================

import React, { useState } from 'react';
import { GitBranch, Cpu, Globe, Shield, Clock, AlertTriangle } from 'lucide-react';
import { useWorkflowStore } from '../../../stores/workflowStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../../../services/ipcService';
import { useI18n } from '../../../hooks/useI18n';
import { DecisionCard, type DecisionOption } from '../../DecisionCard';

function DimensionRow({ icon, label, text, warn }: { icon: React.ReactNode; label: string; text: string; warn?: boolean }) {
  return (
    <div className="flex items-start gap-2 py-1">
      <div className={`pt-0.5 ${warn ? 'text-badge-warning' : 'text-zinc-500'}`}>{icon}</div>
      <div className="min-w-0 flex-1">
        <span className="text-zinc-400">{label}</span>
        <span className={`ml-2 ${warn ? 'text-badge-warning' : 'text-zinc-300'}`}>{text}</span>
      </div>
    </div>
  );
}

export function WorkflowLaunchCard() {
  const { t } = useI18n();
  // 会话隔离（Codex R1 HIGH#1）：只显示当前会话的审批请求，避免在别的会话视图里误批/误拒。
  const currentSessionId = useSessionStore((s) => s.currentSessionId ?? undefined);
  const request = useWorkflowStore((s) => s.pendingLaunchRequest(currentSessionId));
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  // DecisionCard 选项行选中态：'approve' | 'reject'
  const [selected, setSelected] = useState<string | null>(null);

  const w = t.decisionCard.workflow;

  const handleApprove = async () => {
    if (busy || !request) return;
    setBusy(true);
    try {
      await ipcService.invoke(IPC_CHANNELS.WORKFLOW_APPROVE_LAUNCH, {
        requestId: request.id,
        feedback: feedback.trim() || undefined,
        sessionId: currentSessionId, // 主进程据此做会话授权校验（Codex R2 HIGH#1）
      });
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (busy || !request) return;
    const reason = feedback.trim() || w.defaultRejectReason;
    setBusy(true);
    try {
      await ipcService.invoke(IPC_CHANNELS.WORKFLOW_REJECT_LAUNCH, {
        requestId: request.id,
        feedback: reason,
        sessionId: currentSessionId,
      });
    } finally {
      setBusy(false);
    }
  };

  if (!request) return null;

  const options: DecisionOption[] = [
    { id: 'approve', label: w.optionApprove, description: w.optionApproveDesc },
    { id: 'reject', label: w.optionReject, description: w.optionRejectDesc },
  ];

  return (
    <DecisionCard
      testId="workflow-launch-card"
      className="w-full shrink-0 px-4 animate-slideUp"
      tone="neutral"
      icon={<GitBranch className="w-4 h-4" />}
      title={w.title}
      question={
        request.goal
          ? w.questionWithGoal.replace('{goal}', request.goal)
          : w.question
      }
      details={
        <div className="text-xs">
          {/* 静态预览：phases + 扇出量 */}
          <div className="space-y-1.5">
            {request.phases.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-zinc-500">{w.phases}</span>
                {request.phases.map((p) => (
                  <span key={p} className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">{p}</span>
                ))}
              </div>
            )}
            <div className="text-zinc-500">
              {w.estimatedCalls.replace('{count}', String(request.estimatedAgentCalls))}
              {request.fanoutSites > 0 && <> · {w.fanoutSites.replace('{count}', String(request.fanoutSites))}</>}
            </div>
          </div>

          {/* 4 维度 */}
          <div className="mt-2 border-t border-zinc-800 pt-1">
            <DimensionRow icon={<Cpu size={12} />} label={w.dimensionCost} text={request.dimensions.cost} warn={!request.budgetTokens} />
            <DimensionRow icon={<Globe size={12} />} label={w.dimensionNetwork} text={request.dimensions.network} />
            <DimensionRow icon={<Shield size={12} />} label={w.dimensionContext} text={request.dimensions.contextLeak} />
            <DimensionRow icon={<Clock size={12} />} label={w.dimensionBackground} text={request.dimensions.background} warn={request.writeHint} />
          </div>

          {request.writeHint && (
            <div className="mt-1 flex items-center gap-2 border-t border-zinc-800 pt-2 text-badge-warning">
              <AlertTriangle size={12} className="shrink-0" />
              <span>{w.writeHintWarning}</span>
            </div>
          )}
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
      cancelLabel={w.optionReject}
      submitting={busy}
      footerExtra={
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder={w.feedbackPlaceholder}
          rows={2}
          className="w-full resize-none rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-hidden focus:border-zinc-500"
        />
      }
    />
  );
}
