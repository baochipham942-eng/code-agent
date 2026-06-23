// ADR-026 D2-A/三刀：画布提议审批条（DOM 浮层）。展示 agent 提议 + rationale，逐 op 勾选取舍，
// 应用 / 拒绝（可带意见）。ghost 虚影（蓝=改/红=淘汰）由 CanvasProposalGhostLayer 画在画布上。
import React, { useEffect, useMemo, useState } from 'react';
import { Sparkles, Check, X, Trash2, Coins } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import type { CanvasOpProposal, CanvasProposalOp } from '@shared/contract';
import { isGenerateOp } from '@shared/contract';
import { formatCny } from '@shared/media/imageCost';
import { useDesignStore } from './designStore';
import { resolveProposedImageModel, estimateProposedImageCostCny } from './designProposedImageGen';

interface OpLabels {
  move: string; connect: string; shape: string; rename: string; discard: string; generate: string;
}

/** 估算单个生成 op 的成本（¥）——与实际出图共用 resolveProposedImageModel，预估与落地 model 一致。 */
function genOpCostCny(op: Extract<CanvasProposalOp, { kind: 'generateImage' }>, formImageModel: string): number {
  return estimateProposedImageCostCny(resolveProposedImageModel(op.model, formImageModel));
}

function describeOp(op: CanvasProposalOp, L: OpLabels, formImageModel: string, paidBadge: string): { text: string; danger: boolean; paid: boolean } {
  switch (op.kind) {
    case 'moveNode': return { text: `${L.move} · ${op.nodeId}`, danger: false, paid: false };
    case 'addConnector': return { text: `${L.connect} ${op.fromNodeId} → ${op.toNodeId}${op.label ? ` "${op.label}"` : ''}`, danger: false, paid: false };
    case 'addShape': return { text: `${L.shape} · ${op.shape.kind}`, danger: false, paid: false };
    case 'renameNode': return { text: `${L.rename} "${op.label}"`, danger: false, paid: false };
    case 'discardNode': return { text: `${L.discard} · ${op.nodeId}`, danger: true, paid: false };
    case 'generateImage': return { text: `${L.generate} · "${op.prompt.slice(0, 40)}" · ${paidBadge} ${formatCny(genOpCostCny(op, formImageModel))}`, danger: false, paid: true };
  }
}

export const CanvasProposalReviewBar: React.FC<{
  proposal: CanvasOpProposal;
  onApply: (selectedOps: CanvasProposalOp[]) => void | Promise<void>;
  onReject: (feedback?: string) => void | Promise<void>;
}> = ({ proposal, onApply, onReject }) => {
  const { t } = useI18n();
  const s = t.design;
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  // per-op 取舍：默认全选（下标集）。
  const [selected, setSelected] = useState<Set<number>>(() => new Set(proposal.ops.map((_, i) => i)));
  // 新提议替换当前（条不卸载、props 变）时重置勾选为全选，否则沿用旧提议的选择致错配（H2）。
  useEffect(() => {
    setSelected(new Set(proposal.ops.map((_, i) => i)));
  }, [proposal.requestId, proposal.ops]);

  const formImageModel = useDesignStore((st) => st.imageModel);
  // L 进 useMemo（审计 LOW）：否则每次渲染（如输入框每次按键）重建对象，rows 的 useMemo 依赖被打穿全量重算。
  const L: OpLabels = useMemo(() => ({
    move: s.proposalOpMove, connect: s.proposalOpConnect, shape: s.proposalOpShape,
    rename: s.proposalOpRename, discard: s.proposalOpDiscard, generate: s.proposalOpGenerate,
  }), [s.proposalOpMove, s.proposalOpConnect, s.proposalOpShape, s.proposalOpRename, s.proposalOpDiscard, s.proposalOpGenerate]);
  const rows = useMemo(() => proposal.ops.map((op) => describeOp(op, L, formImageModel, s.proposalPaidBadge)), [proposal.ops, L, formImageModel, s.proposalPaidBadge]);
  const selectedOps = useMemo(() => proposal.ops.filter((_, i) => selected.has(i)), [proposal.ops, selected]);
  // 付费闸：仅统计「当前勾选」的生成 op 预估合计 ¥ + 张数（取消勾选实时减少，红线①付费前置审批的可见账）。
  const genCost = useMemo(() => {
    let amount = 0;
    let count = 0;
    proposal.ops.forEach((op, i) => {
      if (selected.has(i) && isGenerateOp(op)) { amount += genOpCostCny(op, formImageModel); count += 1; }
    });
    return { amount, count };
  }, [proposal.ops, selected, formImageModel]);

  const toggle = (i: number): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  // async-aware：等待 handler 完成再复位 busy（出错也复位，不把按钮永久锁死）。
  const guard = (fn: () => void | Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  return (
    <div
      data-testid="canvas-proposal-bar"
      className="pointer-events-auto absolute bottom-4 left-1/2 z-30 w-[min(640px,92%)] -translate-x-1/2 rounded-xl border border-blue-500/30 bg-zinc-900/95 p-3 shadow-xl backdrop-blur"
    >
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">{s.proposalTitle}</span>
            <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[11px] text-blue-300">
              {s.proposalSelectedCount.replace('{n}', String(selected.size)).replace('{total}', String(proposal.ops.length))}
            </span>
          </div>
          {proposal.rationale ? <p className="mt-1 text-xs leading-relaxed text-zinc-400">{proposal.rationale}</p> : null}
          {/* 逐 op 勾选 */}
          <ul className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto">
            {rows.map((row, i) => (
              <li key={i}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-white/[0.04]">
                  <input
                    type="checkbox"
                    data-testid={`proposal-op-${i}`}
                    checked={selected.has(i)}
                    onChange={() => toggle(i)}
                    disabled={busy}
                    className="h-3.5 w-3.5 accent-blue-500"
                  />
                  {row.danger ? <Trash2 className="h-3 w-3 shrink-0 text-red-400" /> : null}
                  {row.paid ? <Coins className="h-3 w-3 shrink-0 text-amber-400" /> : null}
                  <span className={`truncate ${row.danger ? 'text-red-300' : row.paid ? 'text-amber-200' : 'text-zinc-300'}`}>{row.text}</span>
                </label>
              </li>
            ))}
          </ul>
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
      {genCost.count > 0 ? (
        <div
          data-testid="proposal-cost-gate"
          className="mt-2 flex items-center gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/[0.08] px-2 py-1.5 text-xs text-amber-200"
        >
          <Coins className="h-3.5 w-3.5 shrink-0" />
          <span>{s.proposalEstCost.replace('{amount}', formatCny(genCost.amount)).replace('{n}', String(genCost.count))}</span>
        </div>
      ) : null}
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
          onClick={guard(() => onApply(selectedOps))}
          disabled={busy || selected.size === 0}
          title={selected.size === 0 ? s.proposalNothingSelected : undefined}
          className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" />
          {s.proposalApply}
        </button>
      </div>
    </div>
  );
};
