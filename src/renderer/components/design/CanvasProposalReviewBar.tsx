// ADR-026 D2-A：画布提议审批条（DOM 浮层）。展示 agent 的提议摘要 + rationale，
// 提供 应用 / 拒绝（可带意见）。ghost 虚影由 CanvasProposalGhostLayer 画在画布上。
import React, { useState } from 'react';
import { Sparkles, Check, X } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import type { CanvasOpProposal } from '@shared/contract';

function opSummary(ops: CanvasOpProposal['ops'], labels: { move: string; connect: string; shape: string; rename: string }): string {
  const c = { moveNode: 0, addConnector: 0, addShape: 0, renameNode: 0 };
  for (const op of ops) c[op.kind]++;
  const parts: string[] = [];
  if (c.moveNode) parts.push(`${labels.move}×${c.moveNode}`);
  if (c.addConnector) parts.push(`${labels.connect}×${c.addConnector}`);
  if (c.addShape) parts.push(`${labels.shape}×${c.addShape}`);
  if (c.renameNode) parts.push(`${labels.rename}×${c.renameNode}`);
  return parts.join(' · ');
}

export const CanvasProposalReviewBar: React.FC<{
  proposal: CanvasOpProposal;
  onApply: () => void | Promise<void>;
  onReject: (feedback?: string) => void | Promise<void>;
}> = ({ proposal, onApply, onReject }) => {
  const { t } = useI18n();
  const s = t.design;
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);

  const summary = opSummary(proposal.ops, {
    move: s.proposalOpMove,
    connect: s.proposalOpConnect,
    shape: s.proposalOpShape,
    rename: s.proposalOpRename,
  });

  // async-aware：等待 handler 完成再复位 busy（出错也复位，不把按钮永久锁死）。
  // 组件常在 handler 内 clear() 后卸载——卸载后 setBusy 是 no-op，无副作用。
  const guard = (fn: () => void | Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="canvas-proposal-bar"
      className="pointer-events-auto absolute bottom-4 left-1/2 z-30 w-[min(620px,92%)] -translate-x-1/2 rounded-xl border border-blue-500/30 bg-zinc-900/95 p-3 shadow-xl backdrop-blur"
    >
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">{s.proposalTitle}</span>
            <span className="truncate rounded-full bg-blue-500/15 px-2 py-0.5 text-[11px] text-blue-300">{summary}</span>
          </div>
          {proposal.rationale ? <p className="mt-1 text-xs leading-relaxed text-zinc-400">{proposal.rationale}</p> : null}
          <p className="mt-1 text-[11px] leading-snug text-zinc-500">{s.proposalHint}</p>
          <input
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={s.proposalFeedbackPlaceholder}
            disabled={busy}
            className="mt-2 w-full rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-blue-500/40 focus:outline-none"
          />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="proposal-reject"
          onClick={guard(() => onReject(feedback))}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.06] disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
          {feedback.trim() ? s.proposalRejectWithFeedback : s.proposalReject}
        </button>
        <button
          type="button"
          data-testid="proposal-apply"
          onClick={guard(onApply)}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" />
          {s.proposalApply}
        </button>
      </div>
    </div>
  );
};
