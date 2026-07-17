import React from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';
import type { ModelStrategyRecommendation } from './modelStrategyRecommendation';
import { useI18n } from '../../../../hooks/useI18n';

export interface ModelStrategyRecommendationStripProps {
  recommendation: ModelStrategyRecommendation;
  onApply: () => void;
  onDismiss: () => void;
}

export const ModelStrategyRecommendationStrip: React.FC<ModelStrategyRecommendationStripProps> = ({
  recommendation,
  onApply,
  onDismiss,
}) => {
  const { t } = useI18n();
  return (
  <div
    className={`mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
      recommendation.tone === 'warning'
        ? 'border-amber-500/20 bg-amber-500/10 text-amber-200'
        : 'border-sky-500/20 bg-sky-500/10 text-sky-200'
    }`}
    data-testid="model-strategy-recommendation"
  >
    {recommendation.tone === 'warning'
      ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      : <Sparkles className="h-3.5 w-3.5 shrink-0" />}
    <div className="min-w-0 flex-1">
      <div className="font-medium">{recommendation.title}</div>
      <div className="mt-0.5 truncate text-[11px] opacity-80" title={recommendation.body}>
        {recommendation.body}
      </div>
      {recommendation.strategyFactors?.length ? (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          {recommendation.strategyFactors.map((factor) => (
            <span
              key={`${factor.label}:${factor.value}`}
              className="text-[10px] leading-none opacity-70"
            >
              {factor.label}: {factor.value}
            </span>
          ))}
        </div>
      ) : null}
    </div>
    {recommendation.primaryAction && (
      <button
        type="button"
        onClick={onApply}
        className="shrink-0 rounded border border-sky-400/30 bg-sky-400/10 px-2 py-1 text-[11px] font-medium text-sky-100 transition hover:bg-sky-400/20"
      >
        {recommendation.primaryLabel ?? t.modelStrategy.primaryLabelSwitch}
      </button>
    )}
    <button
      type="button"
      onClick={onDismiss}
      className="shrink-0 rounded px-2 py-1 text-[11px] text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-200"
    >
      {t.modelStrategy.strip.dismiss}
    </button>
  </div>
  );
};

