// ADR-027 slice5：有界自主信封审批条（DOM 浮层）。展示 agent 目标 + rationale，
// 人可调生成数量 / 预算上限，看预估 ¥，Grant/Decline。Grant 即付费预授权（红线①）——
// 之后 AI 在信封内自主出图、不再逐张问，总花费不超上限。
import React, { useEffect, useMemo, useState } from 'react';
import { Sparkles, Check, X } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import type { AutonomyEnvelopeRequest, AutonomyGrant } from '@shared/contract';
import { formatCny } from '@shared/media/imageCost';
import { clampVariants, defaultAutonomyGrant } from '@shared/contract/designAutonomy';
import { MAX_AUTONOMY_VARIANTS } from '@shared/constants';
import { useDesignStore } from './designStore';
import { resolveProposedImageModel } from './designProposedImageGen';
import { resolveAutonomyImageCostCny, type CustomImageModelPrice } from './autonomyProposalRouting';
import { listCustomImageModels } from './designFiles';

export const CanvasAutonomyReviewBar: React.FC<{
  request: AutonomyEnvelopeRequest;
  /** perImageCny=审批面板算出的真实单价快照，建立信封时存入供预算闸兜底（R2-MED-1）。 */
  onGrant: (granted: AutonomyGrant, perImageCny: number) => void | Promise<void>;
  onDecline: (feedback?: string) => void | Promise<void>;
}> = ({ request, onGrant, onDecline }) => {
  const { t } = useI18n();
  const s = t.design;
  const formImageModel = useDesignStore((st) => st.imageModel);
  const [busy, setBusy] = useState(false);
  const [showDecline, setShowDecline] = useState(false);
  const [feedback, setFeedback] = useState('');

  // HIGH-1：拉自定义模型价（含 costCnyPerImage），让审批面板预估==实际出图账单（不再对自定义模型假低 0.14）。
  const [customModels, setCustomModels] = useState<CustomImageModelPrice[]>([]);
  useEffect(() => {
    let alive = true;
    void listCustomImageModels().then((ms) => { if (alive) setCustomModels(ms); }).catch(() => void 0);
    return () => { alive = false; };
  }, []);

  // 单张预估 ¥（与实际出图同源计价，预估==落地）。
  const perImage = useMemo(
    () => resolveAutonomyImageCostCny(resolveProposedImageModel(undefined, formImageModel), customModels),
    [formImageModel, customModels],
  );
  const derived = useMemo(() => defaultAutonomyGrant(), []);

  // 生成数量：agent 提议值或默认，夹紧 [1, MAX]。
  const [variants, setVariants] = useState<number>(clampVariants(request.proposed.maxVariants ?? derived.maxVariants));
  // 预算上限：agent 提议值或派生默认（随生成数量给个合理建议，但人可覆盖）。
  const [maxCny, setMaxCny] = useState<number>(
    typeof request.proposed.maxCny === 'number' && request.proposed.maxCny > 0 ? request.proposed.maxCny : derived.maxCny,
  );

  const estCost = perImage * variants;

  const handleGrant = async (): Promise<void> => {
    setBusy(true);
    try {
      await onGrant({ maxVariants: variants, maxCny }, perImage); // 快照单价（与面板预估同源）进信封
    } finally {
      setBusy(false);
    }
  };
  const handleDecline = async (): Promise<void> => {
    setBusy(true);
    try {
      await onDecline(feedback.trim() || undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 w-[28rem] max-w-[92vw] rounded-xl border border-amber-300/60 bg-white/95 shadow-xl backdrop-blur dark:border-amber-500/40 dark:bg-neutral-900/95">
      <div className="flex items-center gap-2 px-4 pt-3 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
        <Sparkles className="h-4 w-4 text-amber-500" />
        {s.autonomyTitle}
      </div>
      <div className="px-4 pt-1 text-sm text-neutral-600 dark:text-neutral-300">{request.goal}</div>
      {request.rationale && (
        <div className="px-4 pt-1 text-xs text-neutral-400 dark:text-neutral-500">{request.rationale}</div>
      )}

      <div className="flex items-center gap-4 px-4 pt-3">
        <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
          {s.autonomyVariantsLabel}
          <input
            type="number"
            min={1}
            max={MAX_AUTONOMY_VARIANTS}
            value={variants}
            onChange={(e) => setVariants(clampVariants(Number(e.target.value)))}
            className="w-16 rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-800"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
          {s.autonomyBudgetLabel}
          <input
            type="number"
            min={0}
            step={0.1}
            value={maxCny}
            onChange={(e) => { const v = Number(e.target.value); setMaxCny(Number.isFinite(v) && v > 0 ? v : derived.maxCny); }}
            className="w-20 rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-800"
          />
        </label>
        <span className="ml-auto text-xs text-amber-600 dark:text-amber-400">
          {s.autonomyEstCost.replace('{amount}', formatCny(estCost))}
        </span>
      </div>

      <div className="px-4 pt-2 text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">{s.autonomyHint}</div>

      {showDecline && (
        <div className="px-4 pt-2">
          <input
            type="text"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={s.autonomyDeclinePlaceholder}
            className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-800"
          />
        </div>
      )}

      <div className="flex items-center justify-end gap-2 px-4 py-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => (showDecline ? void handleDecline() : setShowDecline(true))}
          className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
        >
          <X className="h-3.5 w-3.5" />
          {s.autonomyDecline}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleGrant()}
          className="flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" />
          {s.autonomyGrant}
        </button>
      </div>
    </div>
  );
};
